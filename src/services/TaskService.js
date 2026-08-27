const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { TASK_STATUS } = require('../config/constants');
const NotificationService = require('./NotificationService');
const EmailService = require('./EmailService');
const { computeReminderAt } = require('../utils/taskDates');

/** Deep-link payload for Header → `/tasks/:projectId/:taskId` (projectId + taskId). */
function taskNotifyRef(projectId, taskId) {
  return { refTable: 'project_tasks', refId: `${projectId}:${taskId}` };
}

// TODO/IN_PROGRESS/REJECTED can also go straight to DONE — ad-hoc tasks (type
// 'issue') don't need the submit->review pipeline, they're a single owner marking
// their own work complete. The submit/review chain stays available for tasks that
// do use it (a reviewerId is set).
//
// ACCEPTED sits between TODO and everything else for tasks handed to someone
// other than their creator — see the acceptance gate in #transition. Self-assigned
// tasks skip it entirely (no one to hand acceptance to), so TODO also keeps its
// direct paths for them.
const VALID_TRANSITIONS = {
  [TASK_STATUS.TODO]: [TASK_STATUS.ACCEPTED, TASK_STATUS.IN_PROGRESS, TASK_STATUS.SUBMITTED, TASK_STATUS.DONE],
  [TASK_STATUS.ACCEPTED]: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.SUBMITTED, TASK_STATUS.DONE],
  [TASK_STATUS.IN_PROGRESS]: [TASK_STATUS.SUBMITTED, TASK_STATUS.DONE],
  // Content submit lands on "submitted"; strategist approve/reject can go straight
  // from there (or via in_review). Done→approved heals older content tasks that
  // were closed on submit before approval existed as a task status.
  [TASK_STATUS.SUBMITTED]: [TASK_STATUS.IN_REVIEW, TASK_STATUS.APPROVED, TASK_STATUS.REJECTED],
  [TASK_STATUS.IN_REVIEW]: [TASK_STATUS.APPROVED, TASK_STATUS.REJECTED, TASK_STATUS.DONE],
  // After reject, assignee can reopen (in_progress) or resubmit straight to review.
  [TASK_STATUS.REJECTED]: [TASK_STATUS.IN_PROGRESS, TASK_STATUS.SUBMITTED, TASK_STATUS.DONE],
  [TASK_STATUS.APPROVED]: [TASK_STATUS.DONE],
  [TASK_STATUS.DONE]: [TASK_STATUS.APPROVED],
};

// Content-review task types where the assignee is expected to hand back an
// actual file/link — submitting or approving one of these with an empty
// Deliverable panel is always a mistake, not a legitimate state (unlike an
// "issue" or ad-hoc task, which can be finished with nothing to attach).
// Blog copy (submitBlogDeliverable) already enforces this itself before it
// ever reaches this generic pipeline; this closes the same gap for the
// designer's blog_image task and plain content tasks, which go through the
// Task Detail page's own Submit/Approve buttons instead.
const DELIVERABLE_TASK_TYPES = new Set(['blog_post', 'blog_image', 'content']);

class TaskService {
  async listForProject(projectId, orgId, stageKey, type) {
    const where = { projectId };
    if (type) {
      where.type = type;
    } else if (stageKey) {
      // Current-stage workflow tasks + all ad-hoc issues (so "Add Task" items
      // stay visible inside the project even after the stage advances).
      where[Op.or] = [
        { stageKey },
        { type: 'issue' },
      ];
    }
    return db.Task.findAll({
      where,
      include: [
        { model: db.User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'reviewer', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'creator', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'pendingAssignee', attributes: ['id', 'name', 'avatarUrl'] },
      ],
      order: type ? [['createdAt', 'DESC']] : [['createdAt', 'ASC']],
    });
  }

  async getById(taskId, orgId, projectId) {
    const task = await db.Task.findOne({
      where: { id: taskId, orgId, projectId },
      include: [
        { model: db.User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'reviewer', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'creator', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.User, as: 'pendingAssignee', attributes: ['id', 'name', 'avatarUrl'] },
        {
          model: db.Project,
          as: 'project',
          attributes: ['id', 'name', 'currentStageKey'],
          include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
        },
        {
          model: db.TaskEvent,
          as: 'events',
          include: [
            { model: db.User, as: 'actor', attributes: ['id', 'name', 'avatarUrl'] },
            { model: db.Artifact, as: 'attachments', where: { isActive: true }, required: false },
          ],
          separate: true,
          order: [['createdAt', 'ASC'], ['id', 'ASC']],
        },
      ],
    });
    if (!task) {
      const err = new Error('Task not found.');
      err.status = 404;
      throw err;
    }
    return task;
  }

  async create(orgId, projectId, data, createdBy) {
    const project = await db.Project.findOne({ where: { id: projectId, orgId } });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }

    const remarks = data.remarks != null ? String(data.remarks).trim() || null : null;
    // Manual reminder dates are ignored — always auto 24h before due date.
    const reminderAt = computeReminderAt(data.dueAt);

    // Assigner (User A) becomes the reviewer when they hand work to someone else
    // (User B). Self-assigned / unassigned tasks skip the review pipeline.
    let reviewerId = data.reviewerId || null;
    if (!reviewerId && data.assigneeId && data.assigneeId !== createdBy) {
      reviewerId = createdBy;
    }

    // Technical audit: the chosen assignee is parked in pendingAssigneeId and
    // the task goes out unassigned until an admin approves it (approveAudit),
    // instead of notifying the assignee immediately.
    const requiresTechnicalAudit = !!data.requiresTechnicalAudit;

    const task = await db.Task.create({
      id: uuidv4(),
      orgId,
      projectId,
      stageKey: data.stageKey || project.currentStageKey,
      type: data.type,
      title: data.title,
      assigneeId: requiresTechnicalAudit ? null : data.assigneeId,
      pendingAssigneeId: requiresTechnicalAudit ? (data.assigneeId || null) : null,
      requiresTechnicalAudit,
      auditStatus: requiresTechnicalAudit ? 'pending' : null,
      reviewerId,
      dueAt: data.dueAt || null,
      remarks,
      reminderAt,
      pageName: data.pageName,
      createdBy,
      // New tasks always start as todo — status advances via transitions.
      status: TASK_STATUS.TODO,
    });

    if (requiresTechnicalAudit) {
      this._notifyAdminsForAudit(task, project, orgId).catch(() => {});
    } else if (task.assigneeId) {
      // Notify the assignee — email + in-app, fire-and-forget (mirrors the
      // project-assignment notification pattern in ProjectController#setAssignment).
      db.User.findByPk(task.assigneeId).then((assignee) => {
        if (!assignee) return;
        if (assignee.email) {
          EmailService.sendTaskAssigned(assignee.email, assignee.name, task.title, project.name, task.dueAt);
        }
        const parts = [`You've been assigned a task on ${project.name}.`, 'Status: To do.'];
        if (task.dueAt) parts.push(`Due ${task.dueAt}.`);
        if (task.reminderAt) parts.push(`Auto reminder on ${task.reminderAt} (24h before due).`);
        if (remarks) parts.push(`Remarks: ${remarks.length > 120 ? `${remarks.slice(0, 120)}…` : remarks}`);
        NotificationService.notify(assignee.id, orgId, {
          type: 'task_assigned',
          title: `New task assigned: "${task.title}"`,
          body: parts.join(' '),
          ...taskNotifyRef(project.id, task.id),
        });
      }).catch(() => {});
    }

    return this.getById(task.id, orgId, projectId);
  }

  // Fire-and-forget: mirrors PublicDocumentService#_notifyAdmins.
  async _notifyAdminsForAudit(task, project, orgId) {
    const admins = await db.User.findAll({
      where: { orgId },
      include: [{ model: db.Role, as: 'role' }],
    });
    const recipients = admins.filter((u) => ['super_admin', 'admin'].includes(u.role?.key));
    await Promise.all(recipients.map((u) => NotificationService.notify(u.id, orgId, {
      type: 'task_audit_pending',
      title: `Technical audit needed: "${task.title}"`,
      body: `A task on ${project.name} needs technical-audit approval before it can be assigned.`,
      ...taskNotifyRef(project.id, task.id),
    })));
  }

  // True once at least one active, non-review-note deliverable is attached —
  // matches the frontend's own `deliverableFiles` filter on the Task Detail
  // page (kind: 'brief' is reference material from the assigner, kind:
  // 'review_note' is a rejection-note attachment; neither counts as the work).
  async _hasDeliverable(taskId) {
    const count = await db.Artifact.count({
      where: {
        taskId,
        isActive: true,
        [Op.or]: [{ kind: null }, { kind: { [Op.notIn]: ['brief', 'review_note'] } }],
      },
    });
    return count > 0;
  }

  async approveAudit(taskId, orgId, actor) {
    const task = await db.Task.findOne({
      where: { id: taskId, orgId },
      include: [{ model: db.Project, as: 'project', attributes: ['id', 'name'] }],
    });
    if (!task) {
      const err = new Error('Task not found.');
      err.status = 404;
      throw err;
    }
    if (!task.requiresTechnicalAudit || task.auditStatus !== 'pending') {
      const err = new Error('This task is not awaiting technical audit approval.');
      err.status = 400;
      throw err;
    }

    const assigneeId = task.pendingAssigneeId;
    await db.sequelize.transaction(async (t) => {
      await db.TaskEvent.create({
        id: uuidv4(),
        taskId: task.id,
        fromStatus: task.status,
        toStatus: task.status,
        actorUserId: actor.id,
        reasonCategory: 'technical_audit_approved',
      }, { transaction: t });
      await task.update({ auditStatus: 'approved', assigneeId, pendingAssigneeId: null }, { transaction: t });
    });

    if (assigneeId) {
      db.User.findByPk(assigneeId).then((assignee) => {
        if (!assignee) return;
        if (assignee.email) {
          EmailService.sendTaskAssigned(assignee.email, assignee.name, task.title, task.project?.name, task.dueAt);
        }
        NotificationService.notify(assignee.id, orgId, {
          type: 'task_assigned',
          title: `New task assigned: "${task.title}"`,
          body: `You've been assigned a task on ${task.project?.name}. Status: To do.`,
          ...taskNotifyRef(task.projectId, task.id),
        });
      }).catch(() => {});
    }

    return this.getById(task.id, orgId, task.projectId);
  }

  async rejectAudit(taskId, orgId, actor, note) {
    const task = await db.Task.findOne({ where: { id: taskId, orgId } });
    if (!task) {
      const err = new Error('Task not found.');
      err.status = 404;
      throw err;
    }
    if (!task.requiresTechnicalAudit || task.auditStatus !== 'pending') {
      const err = new Error('This task is not awaiting technical audit approval.');
      err.status = 400;
      throw err;
    }

    await db.sequelize.transaction(async (t) => {
      await db.TaskEvent.create({
        id: uuidv4(),
        taskId: task.id,
        fromStatus: task.status,
        toStatus: task.status,
        actorUserId: actor.id,
        reasonCategory: 'technical_audit_rejected',
        note: note || null,
      }, { transaction: t });
      await task.update({ auditStatus: 'rejected' }, { transaction: t });
    });

    if (task.createdBy) {
      NotificationService.notify(task.createdBy, orgId, {
        type: 'task_update',
        title: `Technical audit rejected: "${task.title}"`,
        body: note ? `Reviewer note: ${note}` : 'The technical audit for this task was rejected.',
        ...taskNotifyRef(task.projectId, task.id),
      });
    }

    return this.getById(task.id, orgId, task.projectId);
  }

  async transition(taskId, orgId, newStatus, actor, reasonCategory, note, attachmentIds) {
    const task = await db.Task.findOne({
      where: { id: taskId, orgId },
      include: [
        { model: db.User, as: 'assignee', attributes: ['id', 'name'] },
        { model: db.User, as: 'reviewer', attributes: ['id', 'name'] },
      ],
    });
    if (!task) {
      const err = new Error('Task not found.');
      err.status = 404;
      throw err;
    }

    const allowed = VALID_TRANSITIONS[task.status] || [];
    if (!allowed.includes(newStatus)) {
      const err = new Error(`Cannot transition from "${task.status}" to "${newStatus}".`);
      err.status = 400;
      throw err;
    }

    const isAdmin = ['super_admin', 'admin'].includes(actor?.role?.key)
      || !!actor?.role?.permissions?.['projects.manage'];
    // Heal older tasks created before assigner was auto-set as reviewer.
    if (!task.reviewerId && task.createdBy && task.assigneeId && task.createdBy !== task.assigneeId) {
      await task.update({ reviewerId: task.createdBy });
    }
    const effectiveReviewerId = task.reviewerId || task.createdBy || null;
    const usesReviewPipeline = !!(effectiveReviewerId && task.assigneeId && effectiveReviewerId !== task.assigneeId);

    // A task handed to someone other than its creator carries an acceptance step,
    // tracked as its own status + timestamp for the activity timeline. Self-assigned/
    // unassigned tasks have no one to accept from, so they never need it. Only the
    // assignee (or an admin standing in for them) may record the explicit accept —
    // the UI gates its Submit/Complete actions on it — but the check stays advisory
    // at this layer rather than a hard block, since several server-side integrations
    // (blog/content submission, resubmission after a rejection) drive a task's status
    // directly from the assignee's own action without ever hitting this endpoint
    // first; that first action stamps acceptedAt itself, just as the explicit
    // Accept click would.
    const needsAcceptance = !!(task.assigneeId && task.assigneeId !== task.createdBy);
    if (newStatus === TASK_STATUS.ACCEPTED && !isAdmin && task.assigneeId !== actor.id) {
      const err = new Error('Only the assignee can accept this task.');
      err.status = 403;
      throw err;
    }

    // Submit: assignee (or admin). Approve/reject: reviewer / assigner / admin.
    if (newStatus === TASK_STATUS.SUBMITTED && usesReviewPipeline) {
      if (!isAdmin && task.assigneeId !== actor.id) {
        const err = new Error('Only the assignee can submit this task for review.');
        err.status = 403;
        throw err;
      }
    }
    if ([TASK_STATUS.SUBMITTED, TASK_STATUS.APPROVED].includes(newStatus) && DELIVERABLE_TASK_TYPES.has(task.type)) {
      if (!(await this._hasDeliverable(task.id))) {
        const err = new Error('Attach a file or link in the Deliverable panel first — there is nothing uploaded yet.');
        err.status = 400;
        throw err;
      }
    }
    // Assigned tasks with a separate reviewer must go submit → approve, not skip
    // straight to done (self-assigned / no-reviewer tasks still can).
    if (newStatus === TASK_STATUS.DONE && usesReviewPipeline && !isAdmin) {
      const err = new Error('Submit this task for review first — it has a separate reviewer.');
      err.status = 400;
      throw err;
    }

    if ([TASK_STATUS.APPROVED, TASK_STATUS.REJECTED].includes(newStatus) && usesReviewPipeline) {
      if (!isAdmin && effectiveReviewerId !== actor.id) {
        // Strategist/PM on the project may also review (content/blog parity).
        const assignment = await db.ProjectAssignment.findOne({
          where: {
            projectId: task.projectId,
            userId: actor.id,
            roleSlot: { [db.Sequelize.Op.in]: ['project_strategist', 'project_manager'] },
          },
        });
        if (!assignment) {
          const err = new Error('Only the assigner/reviewer can approve or request changes on this task.');
          err.status = 403;
          throw err;
        }
      }
      if (task.assigneeId === actor.id && !isAdmin) {
        const err = new Error('You cannot approve or reject your own submission.');
        err.status = 400;
        throw err;
      }
    }

    await db.sequelize.transaction(async (t) => {
      const event = await db.TaskEvent.create({
        id: uuidv4(),
        taskId: task.id,
        fromStatus: task.status,
        toStatus: newStatus,
        actorUserId: actor.id,
        reasonCategory,
        note,
      }, { transaction: t });

      // Voice message / file attachments dropped on this specific transition (e.g.
      // a "Send back for changes" note) — the assignee/reviewer uploads them first
      // via /media/upload, then hands the resulting Artifact ids in here. Scoped to
      // this task so a stray/foreign id can't get linked in.
      if (Array.isArray(attachmentIds) && attachmentIds.length) {
        await db.Artifact.update(
          { taskEventId: event.id },
          { where: { id: attachmentIds, taskId: task.id }, transaction: t },
        );
      }

      const update = { status: newStatus };
      if (newStatus === TASK_STATUS.DONE || newStatus === TASK_STATUS.APPROVED) {
        update.completedAt = new Date();
      }
      if (newStatus === TASK_STATUS.ACCEPTED || (needsAcceptance && !task.acceptedAt && task.assigneeId === actor.id)) {
        update.acceptedAt = new Date();
      }
      await task.update(update, { transaction: t });
    });

    // Fire-and-forget in-app notifications
    if (newStatus === TASK_STATUS.SUBMITTED || newStatus === TASK_STATUS.IN_REVIEW) {
      const notifyReviewers = async () => {
        const ids = new Set();
        if (task.reviewerId) ids.add(task.reviewerId);
        else if (task.createdBy) ids.add(task.createdBy);
        if (!ids.size || task.type === 'blog_post' || task.type === 'content') {
          const slots = await db.ProjectAssignment.findAll({
            where: {
              projectId: task.projectId,
              roleSlot: { [db.Sequelize.Op.in]: ['project_strategist', 'project_manager'] },
            },
            attributes: ['userId'],
          });
          for (const a of slots) if (a.userId) ids.add(a.userId);
        }
        for (const userId of ids) {
          if (userId === actor.id) continue;
          NotificationService.notify(userId, orgId, {
            type: 'task_submitted',
            title: `Task ready for review: "${task.title}"`,
            body: task.type === 'blog_post'
              ? 'A blog post was submitted and is waiting for your review.'
              : `${task.assignee?.name || 'Assignee'} submitted work and is waiting for your review.`,
            ...taskNotifyRef(task.projectId, task.id),
          });
        }
      };
      notifyReviewers().catch(() => {});
    } else if (newStatus === TASK_STATUS.ACCEPTED && task.createdBy && task.createdBy !== actor.id) {
      NotificationService.notify(task.createdBy, orgId, {
        type: 'task_update',
        title: `Task accepted: "${task.title}"`,
        body: `${task.assignee?.name || 'The assignee'} accepted the task and can now begin work.`,
        ...taskNotifyRef(task.projectId, task.id),
      });
    } else if ([TASK_STATUS.APPROVED, TASK_STATUS.REJECTED].includes(newStatus) && task.assigneeId) {
      NotificationService.notify(task.assigneeId, orgId, {
        type: 'task_update',
        title: newStatus === TASK_STATUS.APPROVED
          ? `Task approved: "${task.title}"`
          : `Changes requested: "${task.title}"`,
        body: note
          ? `Reviewer note: ${note}`
          : (newStatus === TASK_STATUS.APPROVED
            ? 'Your task was approved.'
            : 'Your task was sent back — please revise and resubmit.'),
        ...taskNotifyRef(task.projectId, task.id),
      });
    }

    return task.reload();
  }
}

module.exports = new TaskService();
