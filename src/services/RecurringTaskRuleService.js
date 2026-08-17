const { v4: uuidv4 } = require('uuid');
const db = require('../models');

const FREQUENCIES = ['monthly', 'weekly', 'biweekly'];

async function assertProjectAccess(projectId, orgId) {
  const project = await db.Project.findOne({ where: { id: projectId, orgId } });
  if (!project) throw Object.assign(new Error('Project not found'), { status: 404 });
  return project;
}

/** Admin / PM / Project Strategist may schedule retainer automation — not every projects.act user. */
async function assertCanSchedule(projectId, orgId, user) {
  const roleKey = user?.role?.key;
  if (roleKey === 'super_admin' || roleKey === 'admin') return;
  if (user?.role?.permissions?.['projects.manage']) return;

  const assignment = await db.ProjectAssignment.findOne({
    where: {
      projectId,
      userId: user.id,
      roleSlot: { [db.Sequelize.Op.in]: ['project_manager', 'project_strategist'] },
    },
  });
  if (!assignment) {
    throw Object.assign(
      new Error('Only an admin, project manager, or project strategist can schedule recurring tasks.'),
      { status: 403 },
    );
  }
}

function validateFrequencyFields(data) {
  if (!FREQUENCIES.includes(data.frequency)) {
    throw Object.assign(new Error('frequency must be "monthly", "weekly", or "biweekly"'), { status: 400 });
  }
  if (data.frequency === 'monthly') {
    const generateDay = parseInt(data.generateDayOfMonth, 10) || 1;
    if (generateDay < 1 || generateDay > 28) {
      throw Object.assign(new Error('generateDayOfMonth must be between 1 and 28 for monthly rules'), { status: 400 });
    }
  }
  if (data.frequency === 'weekly' || data.frequency === 'biweekly') {
    const weekday = parseInt(data.weekday, 10);
    if (Number.isNaN(weekday) || weekday < 0 || weekday > 6) {
      throw Object.assign(new Error('weekday must be 0 (Sunday) through 6 (Saturday) for weekly/biweekly rules'), { status: 400 });
    }
  }
}

function frequencyFieldsForCreate(data) {
  const frequency = data.frequency;
  const isMonthly = frequency === 'monthly';
  const isWeekBased = frequency === 'weekly' || frequency === 'biweekly';
  const generateDay = isMonthly ? (parseInt(data.generateDayOfMonth, 10) || 1) : null;
  return {
    frequency,
    generateDayOfMonth: generateDay,
    // Kept for API compat; due dates are next-cycle in the scheduler.
    dueDayOfMonth: isMonthly ? (parseInt(data.dueDayOfMonth, 10) || generateDay) : null,
    weekday: isWeekBased ? parseInt(data.weekday, 10) : null,
    dueOffsetHours: null,
  };
}

async function list(projectId, orgId) {
  await assertProjectAccess(projectId, orgId);
  return db.RecurringTaskRule.findAll({ where: { projectId }, order: [['createdAt', 'ASC']] });
}

async function create(projectId, orgId, data, user) {
  await assertProjectAccess(projectId, orgId);
  await assertCanSchedule(projectId, orgId, user);
  validateFrequencyFields(data);
  if (!data.roleSlot) {
    throw Object.assign(new Error('roleSlot is required'), { status: 400 });
  }
  if (!String(data.title || '').trim()) {
    throw Object.assign(new Error('title is required'), { status: 400 });
  }

  // Blog writer schedules always produce reviewable blog_post tasks.
  let taskType = data.taskType || 'custom';
  if (data.roleSlot === 'blog_writer' || taskType === 'blog_post') {
    taskType = 'blog_post';
  }

  return db.RecurringTaskRule.create({
    id: uuidv4(),
    orgId,
    projectId,
    stageKey: data.stageKey || null,
    taskType,
    title: String(data.title).trim(),
    roleSlot: data.roleSlot,
    ...frequencyFieldsForCreate(data),
    startDate: data.startDate || new Date().toISOString().split('T')[0],
    isActive: true,
    createdBy: user.id,
  });
}

async function update(id, projectId, orgId, data, user) {
  await assertProjectAccess(projectId, orgId);
  await assertCanSchedule(projectId, orgId, user);
  const rule = await db.RecurringTaskRule.findOne({ where: { id, projectId } });
  if (!rule) throw Object.assign(new Error('Recurring task rule not found'), { status: 404 });

  const updates = {};
  if (data.title !== undefined) updates.title = data.title;
  if (data.roleSlot !== undefined) {
    updates.roleSlot = data.roleSlot;
    if (data.roleSlot === 'blog_writer') updates.taskType = 'blog_post';
  }
  if (data.taskType !== undefined && data.roleSlot !== 'blog_writer') updates.taskType = data.taskType;
  if (data.isActive !== undefined) updates.isActive = !!data.isActive;
  if (
    data.frequency !== undefined
    || data.dueDayOfMonth !== undefined
    || data.generateDayOfMonth !== undefined
    || data.weekday !== undefined
    || data.dueOffsetHours !== undefined
    || data.startDate !== undefined
  ) {
    const merged = { ...rule.toJSON(), ...data };
    validateFrequencyFields(merged);
    Object.assign(updates, frequencyFieldsForCreate(merged));
    if (data.startDate !== undefined) updates.startDate = data.startDate;
  }
  await rule.update(updates);
  return rule;
}

// Deactivates rather than destroys — see services/SoftDeleteService.js. The rule
// already carries an isActive flag (the scheduler skips inactive rules), and the
// tasks it generated point back at it via Task.ruleId, so the row has to survive.
async function remove(id, projectId, orgId, user) {
  await assertProjectAccess(projectId, orgId);
  await assertCanSchedule(projectId, orgId, user);
  const rule = await db.RecurringTaskRule.findOne({ where: { id, projectId } });
  if (!rule) throw Object.assign(new Error('Recurring task rule not found'), { status: 404 });
  await rule.update({ isActive: false });
  return rule;
}

// Called from ProjectController when a recurring SEO project reaches its terminal
// stage (client_delivery). SEO's two recurring obligations are well-known and
// don't need a human to configure them — they're provisioned automatically,
// idempotently (findOrCreate keyed on projectId+taskType), and just sit unassigned
// until someone is put in the 'project_manager' / 'project_strategist' role slot on
// the project (see ProjectController#setAssignment's automation-role reassignment).
async function autoProvisionSeoRules(project, orgId) {
  const today = new Date().toISOString().split('T')[0];
  await db.RecurringTaskRule.findOrCreate({
    where: { projectId: project.id, taskType: 'seo_monthly_review' },
    defaults: {
      id: uuidv4(),
      orgId,
      projectId: project.id,
      taskType: 'seo_monthly_review',
      title: 'Monthly SEO Review',
      roleSlot: 'project_manager',
      frequency: 'monthly',
      generateDayOfMonth: 1,
      dueDayOfMonth: 1,
      startDate: today,
      isActive: true,
    },
  });
  await db.RecurringTaskRule.findOrCreate({
    where: { projectId: project.id, taskType: 'seo_ranking_update' },
    defaults: {
      id: uuidv4(),
      orgId,
      projectId: project.id,
      taskType: 'seo_ranking_update',
      title: 'Update Keyword Rankings',
      roleSlot: 'project_strategist',
      frequency: 'monthly',
      generateDayOfMonth: 1,
      dueDayOfMonth: 1,
      startDate: today,
      isActive: true,
    },
  });
}

// Fired on every forward stage advance. Only SEO gets the two rules auto-created
// with no human input (item 1 & 2 of the spec) — every other recurring service
// (GMB, blog, etc.) is left for the project team to configure explicitly via the
// Automation panel (item 3), since frequency/due-date/assignee vary per project.
async function handleTerminalStageReached(project, stage, orgId) {
  if (!stage.isTerminal || !project.isRecurring) return;
  if (project.serviceTypeKey === 'seo') {
    await autoProvisionSeoRules(project, orgId);
  }
}

module.exports = {
  list, create, update, remove,
  assertCanSchedule,
  autoProvisionSeoRules, handleTerminalStageReached,
};
