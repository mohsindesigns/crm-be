const { Op, fn, col } = require('sequelize');
const db = require('../models');

const {
  User, Role, Task, Project, Backlink, Keyword, ContentSubmission,
} = db;

// Mirrors the workflow engine's own treatment of task completion (see
// workflow/engine.js's ADVANCE_RULE comment) — 'done' and 'approved' are the
// two terminal states a task can end in, depending on whether it went through
// a review pipeline.
const TASK_DONE_STATUSES = ['done', 'approved'];

// Defaults the range to "today" (local server time) when no from/to is given,
// and widens a from-only range to that single day rather than an open-ended
// range — matches how a date-picker with one date filled in reads to a user.
function resolveRange(fromStr, toStr) {
  const now = new Date();
  const from = fromStr
    ? new Date(`${fromStr}T00:00:00`)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = toStr
    ? new Date(`${toStr}T23:59:59.999`)
    : (fromStr
      ? new Date(`${fromStr}T23:59:59.999`)
      : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999));
  return { from, to };
}

async function getOrgProjectIds(orgId) {
  const rows = await Project.findAll({ where: { orgId }, attributes: ['id'], raw: true });
  return rows.map((r) => r.id);
}

// Groups `model` rows by `userField` within `where`, returning { [userId]: count }.
async function countByUser(model, userField, where, userIds) {
  if (!userIds.length) return {};
  const rows = await model.findAll({
    where: { ...where, [userField]: { [Op.in]: userIds } },
    attributes: [userField, [fn('COUNT', col(model.primaryKeyAttribute)), 'count']],
    group: [userField],
    raw: true,
  });
  const map = {};
  for (const row of rows) map[row[userField]] = Number(row.count);
  return map;
}

async function getMembersOverview(orgId, { from: fromStr, to: toStr, search, roleId } = {}) {
  const { from, to } = resolveRange(fromStr, toStr);

  const userWhere = { orgId, isActive: true };
  if (roleId) userWhere.roleId = roleId;
  if (search) userWhere[Op.or] = [
    { name: { [Op.like]: `%${search}%` } },
    { email: { [Op.like]: `%${search}%` } },
  ];

  const users = await User.findAll({
    where: userWhere,
    include: [{ model: Role, as: 'role', attributes: ['id', 'name', 'key', 'color'] }],
    attributes: ['id', 'name', 'email', 'avatarUrl'],
    order: [['name', 'ASC']],
  });
  if (!users.length) return { from: from.toISOString(), to: to.toISOString(), members: [] };

  const userIds = users.map((u) => u.id);
  const projectIds = await getOrgProjectIds(orgId);

  const [tasksCompleted, tasksOpen, backlinksAdded, contentSubmitted, keywordsAssigned] = await Promise.all([
    countByUser(Task, 'assigneeId', {
      orgId, status: { [Op.in]: TASK_DONE_STATUSES }, completedAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(Task, 'assigneeId', {
      orgId, status: { [Op.notIn]: TASK_DONE_STATUSES },
    }, userIds),
    countByUser(Backlink, 'assignedWriterId', {
      isActive: true, projectId: { [Op.in]: projectIds }, createdAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(ContentSubmission, 'submittedBy', {
      projectId: { [Op.in]: projectIds }, createdAt: { [Op.between]: [from, to] },
    }, userIds),
    countByUser(Keyword, 'assignedWriterId', {
      projectId: { [Op.in]: projectIds }, status: 'active',
    }, userIds),
  ]);

  const members = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role ? { id: u.role.id, name: u.role.name, key: u.role.key, color: u.role.color } : null,
    tasksCompleted: tasksCompleted[u.id] || 0,
    tasksOpen: tasksOpen[u.id] || 0,
    backlinksAdded: backlinksAdded[u.id] || 0,
    contentSubmitted: contentSubmitted[u.id] || 0,
    keywordsAssigned: keywordsAssigned[u.id] || 0,
  }));

  return { from: from.toISOString(), to: to.toISOString(), members };
}

async function getMemberDetail(orgId, userId, { from: fromStr, to: toStr } = {}) {
  const { from, to } = resolveRange(fromStr, toStr);

  const user = await User.findOne({
    where: { id: userId, orgId },
    include: [{ model: Role, as: 'role', attributes: ['id', 'name', 'key', 'color'] }],
    attributes: ['id', 'name', 'email', 'avatarUrl', 'isActive'],
  });
  if (!user) return null;

  const projectIds = await getOrgProjectIds(orgId);
  const projectInclude = [{ model: Project, as: 'project', attributes: ['id', 'name'] }];

  const [
    tasksCompletedRows, tasksOpenCount, backlinkRows, contentRows, keywordRows,
  ] = await Promise.all([
    Task.findAll({
      where: {
        orgId, assigneeId: userId, status: { [Op.in]: TASK_DONE_STATUSES },
        completedAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'title', 'type', 'status', 'stageKey', 'completedAt', 'projectId'],
      order: [['completedAt', 'DESC']],
      limit: 200,
    }),
    Task.count({ where: { orgId, assigneeId: userId, status: { [Op.notIn]: TASK_DONE_STATUSES } } }),
    Backlink.findAll({
      where: {
        isActive: true, projectId: { [Op.in]: projectIds }, assignedWriterId: userId,
        createdAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'sourceUrl', 'domain', 'status', 'linkType', 'date', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
    ContentSubmission.findAll({
      where: {
        projectId: { [Op.in]: projectIds }, submittedBy: userId,
        createdAt: { [Op.between]: [from, to] },
      },
      include: projectInclude,
      attributes: ['id', 'pageName', 'wordCount', 'status', 'revisionNumber', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
    Keyword.findAll({
      where: { projectId: { [Op.in]: projectIds }, assignedWriterId: userId, status: 'active' },
      include: projectInclude,
      attributes: ['id', 'primaryKeyword', 'pageName', 'status', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 200,
    }),
  ]);

  const wordCount = contentRows.reduce((sum, c) => sum + (c.wordCount || 0), 0);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    user: {
      id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl, isActive: user.isActive,
      role: user.role ? { id: user.role.id, name: user.role.name, key: user.role.key, color: user.role.color } : null,
    },
    summary: {
      tasksCompleted: tasksCompletedRows.length,
      tasksOpen: tasksOpenCount,
      backlinksAdded: backlinkRows.length,
      contentSubmitted: contentRows.length,
      wordCount,
      keywordsAssigned: keywordRows.length,
    },
    tasks: tasksCompletedRows,
    backlinks: backlinkRows,
    content: contentRows,
    keywords: keywordRows,
  };
}

module.exports = { getMembersOverview, getMemberDetail };
