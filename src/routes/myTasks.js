const express = require('express');
const router = express.Router();
const { Op } = require('sequelize');
const db = require('../models');
const { Task, Project, Client, User } = db;
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');

router.use(auth, tenancy);

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function applyTaskFilters(where, query) {
  const { status, assigneeId, projectId, type, due, reviewerId, createdBy } = query;

  if (status && status !== 'all' && status !== 'open') {
    where.status = status;
  } else if (status === 'open' || (!status && query.defaultOpen)) {
    where.status = { [Op.notIn]: ['done', 'approved'] };
  }
  // status === 'all' → no status constraint

  if (assigneeId === 'unassigned') where.assigneeId = null;
  else if (assigneeId) where.assigneeId = assigneeId;

  // "Assigned by" — who created the task. On /mine?scope=assigned_by_me the ownership
  // clause already pins createdBy to the caller, so this filter is only ever applied
  // where it can narrow further (All Tasks, and My Tasks "who put this on me").
  if (createdBy) where.createdBy = createdBy;

  if (reviewerId) where.reviewerId = reviewerId;
  if (projectId) where.projectId = projectId;
  if (type) where.type = type;

  const today = dateOnly(startOfToday());
  const weekEnd = new Date(startOfToday());
  weekEnd.setDate(weekEnd.getDate() + 7);
  const weekEndStr = dateOnly(weekEnd);

  if (due === 'overdue') {
    where.dueAt = { [Op.lt]: today };
    // Overdue only applies to unfinished work unless a specific status was requested
    if (!status || status === 'open' || status === 'all') {
      where.status = { [Op.notIn]: ['done', 'approved'] };
    }
  } else if (due === 'today') {
    where.dueAt = today;
  } else if (due === 'week') {
    where.dueAt = { [Op.between]: [today, weekEndStr] };
  } else if (due === 'none') {
    where.dueAt = null;
  } else if (due === 'upcoming') {
    where.dueAt = { [Op.gt]: today };
  }

  return where;
}

function taskOrder(sort) {
  if (sort === 'newest') return [['createdAt', 'DESC']];
  if (sort === 'oldest') return [['createdAt', 'ASC']];
  if (sort === 'due_desc') return [['dueAt', 'DESC'], ['createdAt', 'DESC']];
  if (sort === 'title') return [['title', 'ASC']];
  // default: due soon first (nulls last via ASC on MySQL puts nulls first — acceptable)
  return [['dueAt', 'ASC'], ['createdAt', 'DESC']];
}

function taskIncludes() {
  return [
    { model: User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
    { model: User, as: 'reviewer', attributes: ['id', 'name', 'avatarUrl'] },
    { model: User, as: 'creator', attributes: ['id', 'name'] },
    { model: User, as: 'pendingAssignee', attributes: ['id', 'name', 'avatarUrl'] },
    {
      model: Project,
      as: 'project',
      attributes: ['id', 'name', 'status', 'serviceTypeKey', 'currentStageKey'],
      include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
    },
  ];
}

// Project picker source for Add Manual Task. PM/Admin can target any project;
// everyone else gets only projects they already touch (assignment or assignee task).
router.get('/assignable-projects', rbac('projects.act'), async (req, res, next) => {
  try {
    const isAdmin = req.user?.role?.key === 'super_admin' || req.user?.role?.key === 'admin';
    const canManageProjects = !!req.user?.role?.permissions?.['projects.manage'];

    let where = { orgId: req.orgId };
    if (!isAdmin && !canManageProjects) {
      const [myAssignments, myTasks] = await Promise.all([
        db.ProjectAssignment.findAll({ where: { userId: req.user.id }, attributes: ['projectId'] }),
        db.Task.findAll({ where: { assigneeId: req.user.id }, attributes: ['projectId'] }),
      ]);
      const ids = new Set([
        ...myAssignments.map((a) => a.projectId),
        ...myTasks.map((t) => t.projectId),
      ]);
      where = { ...where, id: { [Op.in]: [...ids] } };
    }

    const projects = await Project.findAll({
      where,
      attributes: ['id', 'name'],
      order: [['createdAt', 'DESC']],
      limit: 500,
    });
    res.json(projects);
  } catch (e) { next(e); }
});

/**
 * Attach each task's project stage trail — the pipeline the task sits in, which
 * stages are already done, and when each was entered:
 *
 *   Brief ✓ Aug 5 5:42 PM  ›  Logo Drafts ✓ Aug 5 5:43 PM  ›  Client Review ◷
 *
 * Batched deliberately. The task list runs to hundreds of rows across a few
 * dozen projects, so resolving this per row would be hundreds of duplicate
 * template + event queries; instead the distinct projects are loaded once and
 * the result shared by every task pointing at them.
 *
 * Mutates the plain JSON rows, so callers must serialise before calling.
 */
async function attachStageTrails(rows) {
  const projectIds = [...new Set(rows.map((t) => t.projectId).filter(Boolean))];
  if (!projectIds.length) return rows;

  const projects = await Project.findAll({
    where: { id: projectIds },
    attributes: ['id', 'workflowTemplateId', 'currentStageKey', 'status'],
  });

  const templateIds = [...new Set(projects.map((p) => p.workflowTemplateId).filter(Boolean))];
  const stages = templateIds.length
    ? await db.Stage.findAll({
      where: { templateId: templateIds },
      attributes: ['templateId', 'key', 'name', 'orderIndex'],
      order: [['orderIndex', 'ASC']],
    })
    : [];

  const stagesByTemplate = new Map();
  for (const s of stages) {
    const list = stagesByTemplate.get(s.templateId) || [];
    list.push(s);
    stagesByTemplate.set(s.templateId, list);
  }

  // Only the stage-transition events, newest first — a rewind means a stage can
  // be entered more than once and the latest entry is the one to show.
  const events = await db.ProjectEvent.findAll({
    where: { projectId: projectIds, toStageKey: { [Op.ne]: null } },
    attributes: ['projectId', 'toStageKey', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  const enteredAt = new Map(); // `${projectId}:${stageKey}` -> ISO
  for (const e of events) {
    const key = `${e.projectId}:${e.toStageKey}`;
    if (!enteredAt.has(key)) enteredAt.set(key, e.createdAt);
  }

  const trailByProject = new Map();
  for (const p of projects) {
    const list = stagesByTemplate.get(p.workflowTemplateId) || [];
    const currentIdx = list.findIndex((s) => s.key === p.currentStageKey);
    trailByProject.set(p.id, list.map((s, idx) => ({
      key: s.key,
      name: s.name,
      // A completed project has no "in progress" stage — its final stage is done.
      done: idx < currentIdx || (idx === currentIdx && p.status === 'completed'),
      current: idx === currentIdx && p.status !== 'completed',
      enteredAt: enteredAt.get(`${p.id}:${s.key}`) || null,
    })));
  }

  for (const t of rows) {
    t.stageTrail = trailByProject.get(t.projectId) || [];
  }
  return rows;
}

// GET /api/tasks — org-wide task list for admins/managers
router.get('/', rbac('projects.manage'), async (req, res, next) => {
  try {
    const where = applyTaskFilters({ orgId: req.orgId }, {
      ...req.query,
      defaultOpen: !req.query.status,
    });

    const tasks = await Task.findAll({
      where,
      include: taskIncludes(),
      order: taskOrder(req.query.sort),
    });

    let result = tasks;
    if (req.query.search) {
      const q = String(req.query.search).toLowerCase();
      result = tasks.filter((t) =>
        t.title?.toLowerCase().includes(q)
        || t.project?.name?.toLowerCase().includes(q)
        || t.project?.client?.name?.toLowerCase().includes(q)
        || t.assignee?.name?.toLowerCase().includes(q)
      );
    }

    res.json(await attachStageTrails(result.map((t) => t.toJSON())));
  } catch (e) { next(e); }
});

// GET /api/tasks/mine
//   default            — assigned to me or under my review
//   ?scope=assigned_by_me — tasks I created/assigned (proof + tracking for employees)
router.get('/mine', async (req, res, next) => {
  try {
    const status = req.query.status;
    const scope = String(req.query.scope || '').trim();
    // Older content work was closed as "done" on submit; when content was later
    // approved the Task row never flipped to "approved". Heal those before listing.
    if (status === 'approved') {
      try {
        const SeoService = require('../services/SeoService');
        await SeoService.syncApprovedContentTasks(req.orgId, req.user.id);
        await SeoService.syncApprovedBlogTasks(req.orgId, req.user.id);
      } catch (err) {
        console.error('[myTasks] syncApproved*Tasks failed:', err.message);
      }
    }

    const ownership = scope === 'assigned_by_me'
      ? { createdBy: req.user.id }
      : {
        [Op.or]: [
          { assigneeId: req.user.id },
          { reviewerId: req.user.id },
        ],
      };

    const where = applyTaskFilters({
      orgId: req.orgId,
      ...ownership,
    }, {
      ...req.query,
      // The "assigned by me" scope IS a createdBy pin. Letting a client-supplied
      // createdBy through here would overwrite that pin and widen the view to
      // another user's created tasks.
      createdBy: scope === 'assigned_by_me' ? undefined : req.query.createdBy,
      // Default "All open" when no status selected
      defaultOpen: !req.query.status,
    });

    // "Assigned by me" is a tracking/proof view — always include tasks even when the
    // project was later completed/cancelled. Same for an explicit status chip (To do,
    // Submitted, …): matching tasks must not disappear just because the project closed.
    // Default "All open" on My Tasks still hides completed/cancelled projects.
    const includeClosedProjects =
      scope === 'assigned_by_me'
      || ['done', 'approved', 'all'].includes(status)
      || !!(status && status !== 'open');

    const tasks = await Task.findAll({
      where,
      include: [{
        model: Project,
        as: 'project',
        attributes: ['id', 'name', 'status', 'serviceTypeKey', 'currentStageKey', 'isRecurring'],
        // Open My Tasks: hide one-off completed projects, but keep retainer
        // (isRecurring) work visible — weekly blogs / monthly SEO reviews continue
        // after the workflow terminal stage marks the project completed.
        ...(includeClosedProjects
          ? {}
          : {
            where: {
              [Op.and]: [
                { status: { [Op.ne]: 'cancelled' } },
                {
                  [Op.or]: [
                    { status: { [Op.ne]: 'completed' } },
                    { isRecurring: true },
                  ],
                },
              ],
            },
          }),
        required: true,
        include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
      },
      { model: User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
      { model: User, as: 'reviewer', attributes: ['id', 'name', 'avatarUrl'] },
      { model: User, as: 'creator', attributes: ['id', 'name'] },
      { model: User, as: 'pendingAssignee', attributes: ['id', 'name', 'avatarUrl'] },
      ],
      order: taskOrder(req.query.sort || 'due_asc'),
    });

    let result = tasks;
    if (req.query.search) {
      const q = String(req.query.search).toLowerCase();
      result = tasks.filter((t) =>
        t.title?.toLowerCase().includes(q)
        || t.project?.name?.toLowerCase().includes(q)
        || t.project?.client?.name?.toLowerCase().includes(q)
        || t.assignee?.name?.toLowerCase().includes(q)
        || t.creator?.name?.toLowerCase().includes(q)
      );
    }

    res.json(await attachStageTrails(result.map((t) => (t.toJSON ? t.toJSON() : t))));
  } catch (e) { next(e); }
});

module.exports = router;
