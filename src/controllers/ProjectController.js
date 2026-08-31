const { body } = require('express-validator');
const ProjectService = require('../services/ProjectService');
const { performAction, rewindStage } = require('../workflow/engine');
const { autoCreateStageTasks, applyForwardAdvanceSideEffects, autoAdvancePastHiddenStages } = require('../workflow/autoAdvance');
const validate = require('../middleware/validate');
const db = require('../models');
const EmailService = require('../services/EmailService');
const NotificationService = require('../services/NotificationService');
const RecurringTaskRuleService = require('../services/RecurringTaskRuleService');

class ProjectController {
  createValidators() {
    return [
      body('name').optional({ checkFalsy: true }).trim(),
      body('clientId').isUUID(),
      body('serviceTypeKey').trim().notEmpty(),
      body('workflowTemplateId').isUUID(),
    ];
  }

  async list(req, res, next) {
    try {
      res.json(await ProjectService.list(req.orgId, req.query, req.user));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      res.json(await ProjectService.findById(req.params.id, req.orgId, req.user));
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const project = await ProjectService.create(req.orgId, req.body, req.user.id);
      // Kick off tasks for the first stage so the stage owner sees work immediately
      const firstStage = project.template?.stages?.[0];
      if (firstStage) await autoCreateStageTasks(project, firstStage, req.orgId);
      // A hidden first stage with nothing gating it (e.g. single_action, no
      // tasks) should skip through immediately rather than sitting there with
      // no task-completion event to ever trigger it.
      const advanced = await autoAdvancePastHiddenStages(project, req.orgId).catch((err) => {
        console.error('[ProjectController] Auto-advance on project creation failed:', err.message);
        return null;
      });
      const response = advanced ? await ProjectService.findById(project.id, req.orgId, req.user) : project;
      res.status(201).json(response);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      res.json(await ProjectService.update(req.params.id, req.orgId, req.body));
    } catch (err) { next(err); }
  }

  async setAssignment(req, res, next) {
    try {
      const roleSlot = req.body.roleSlot;
      if (!roleSlot) {
        return res.status(400).json({ message: 'roleSlot is required.' });
      }

      // Full team management, or blog_writer only for people who can schedule blogs.
      const roleKey = req.user?.role?.key;
      const canManageTeam = roleKey === 'super_admin' || roleKey === 'admin'
        || !!req.user?.role?.permissions?.['projects.manage'];
      if (!canManageTeam) {
        if (roleSlot !== 'blog_writer') {
          return res.status(403).json({ message: 'You do not have permission to update this assignment.' });
        }
        await RecurringTaskRuleService.assertCanSchedule(req.params.id, req.orgId, req.user);
      }

      const assignment = await ProjectService.setAssignment(req.params.id, req.orgId, roleSlot, req.body.userId);

      // Re-assign any open auto-created tasks for this role slot to the new user (fire-and-forget)
      if (req.body.userId) {
        const { Op } = require('sequelize');
        // A different person now owns these tasks — they haven't accepted them yet,
        // so drop status/acceptedAt back to todo (see TaskService#transition's
        // acceptance gate). Excluding rows already on this assignee leaves anyone
        // who was already accepted/in-progress on this exact user untouched.
        const reassign = {
          assigneeId: req.body.userId,
          status: 'todo',
          acceptedAt: null,
        };

        db.Project.findByPk(req.params.id).then(async (p) => {
          if (!p) return;
          const stages = await db.Stage.findAll({
            where: { templateId: p.workflowTemplateId, ownerRoleSlot: req.body.roleSlot },
            attributes: ['key'],
          });
          const stageKeys = stages.map((s) => s.key);
          if (stageKeys.length === 0) return;
          await db.Task.update(
            reassign,
            {
              where: {
                projectId: req.params.id,
                stageKey: { [Op.in]: stageKeys },
                autoCreated: true,
                status: { [Op.notIn]: ['done', 'approved'] },
                // Skip rows already on this exact user; include unassigned rows.
                assigneeId: { [Op.or]: [null, { [Op.ne]: req.body.userId }] },
              },
            }
          );
        }).catch(() => {});

        // Same idea for recurring-rule tasks (SEO monthly review, GMB/blog weekly
        // posts, etc.) — these aren't tied to a workflow stage, so match by ruleId
        // instead of stageKey.
        db.RecurringTaskRule.findAll({
          where: { projectId: req.params.id, roleSlot: req.body.roleSlot },
          attributes: ['id'],
        }).then(async (rules) => {
          const ruleIds = rules.map((r) => r.id);
          if (ruleIds.length === 0) return;
          await db.Task.update(
            reassign,
            {
              where: {
                ruleId: { [Op.in]: ruleIds },
                status: { [Op.notIn]: ['done', 'approved'] },
                // Skip rows already on this exact user; include unassigned rows.
                assigneeId: { [Op.or]: [null, { [Op.ne]: req.body.userId }] },
              },
            }
          );
        }).catch(() => {});
      }

      // Notify assigned user — email + in-app (fire-and-forget)
      if (req.body.userId) {
        db.User.findByPk(req.body.userId).then((assignedUser) => {
          if (!assignedUser) return;
          db.Project.findByPk(req.params.id).then((p) => {
            if (!p) return;
            if (assignedUser.email) {
              EmailService.sendProjectAssigned(assignedUser.email, assignedUser.name, p.name, req.body.roleSlot);
            }
            NotificationService.notify(assignedUser.id, req.orgId, {
              type: 'assignment',
              title: `You've been assigned: ${p.name}`,
              body: `You are now the ${req.body.roleSlot} on this project.`,
              refTable: 'projects',
              refId: p.id,
            });
          });
        }).catch(() => {});
      }
      res.json(assignment);
    } catch (err) { next(err); }
  }

  async getTimeline(req, res, next) {
    try {
      res.json(await ProjectService.getTimeline(req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async action(req, res, next) {
    try {
      const project = await db.Project.findOne({ where: { id: req.params.id, orgId: req.orgId } });
      if (!project) return res.status(404).json({ message: 'Project not found.' });

      const result = await performAction({
        user: req.user,
        project,
        action: req.body.action,
        reasonCategory: req.body.reasonCategory,
        note: req.body.note,
      });

      // A backward move (rejection) = toStage has a lower orderIndex than fromStage.
      const isBackward = result.toStage.orderIndex < result.fromStage.orderIndex;

      if (!isBackward) {
        await applyForwardAdvanceSideEffects(project, result.fromStage, result.toStage, req.orgId);
        // If this landed on another hidden work stage that's already satisfied
        // (or chains through several), keep going — the response should reflect
        // wherever the project actually ended up, not a stale mid-chain stage.
        // `result.fromStage` stays as this request's own fromStage on purpose:
        // that's what actually changed because of this manual action.
        const chained = await autoAdvancePastHiddenStages(project, req.orgId).catch((err) => {
          console.error('[ProjectController] Auto-advance after stage action failed:', err.message);
          return null;
        });
        if (chained) result.toStage = chained.toStage;
      } else {
        // Backward move (rejection): re-open the tasks in the stage we're returning to
        // so the assignee sees them in My Tasks again.
        await db.Task.update(
          { status: 'todo', completedAt: null },
          {
            where: {
              projectId: project.id,
              stageKey: result.toStage.key,
              autoCreated: true,
              status: 'done',
            },
          }
        );
      }

      // Notify the new stage owner — fire-and-forget
      db.ProjectAssignment.findOne({
        where: { projectId: project.id, roleSlot: result.toStage.ownerRoleSlot },
        include: [{ model: db.User, as: 'user' }],
      }).then((a) => {
        if (!a?.user) return;
        if (!isBackward && a.user.email) {
          EmailService.sendStageAdvance(a.user.email, a.user.name, project.name, result.fromStage.name, result.toStage.name);
        }
        NotificationService.notify(a.user.id, req.orgId, {
          type: isBackward ? 'stage_rejected' : 'stage_advance',
          title: isBackward
            ? `Revisions requested: ${project.name}`
            : `Action required: ${project.name}`,
          body: isBackward
            ? `Your "${result.fromStage.name}" work was not approved. Please revise and resubmit.${req.body.note ? ` Note: "${req.body.note}"` : ''}`
            : `Project has moved to "${result.toStage.name}" — it's now waiting on you.${req.body.note ? ` Note from ${result.fromStage.name}: "${req.body.note}"` : ''}`,
          refTable: 'projects',
          refId: project.id,
        });
      }).catch(() => {});

      res.json(result);
    } catch (err) { next(err); }
  }

  async rewind(req, res, next) {
    try {
      const project = await db.Project.findOne({ where: { id: req.params.id, orgId: req.orgId } });
      if (!project) return res.status(404).json({ message: 'Project not found.' });

      const result = await rewindStage({
        user: req.user,
        project,
        targetStageKey: req.body.targetStageKey,
        note: req.body.note,
      });
      res.json(result);
    } catch (err) { next(err); }
  }

  async cancel(req, res, next) {
    try {
      const project = await ProjectService.cancel(req.params.id, req.orgId, req.user.id, req.body.note);
      res.json(project);
    } catch (err) { next(err); }
  }

  async setStatus(req, res, next) {
    try {
      const project = await ProjectService.setStatus(req.params.id, req.orgId, req.user.id, req.body.status, req.body.note);
      res.json(project);
    } catch (err) { next(err); }
  }
}

module.exports = new ProjectController();
