const db = require('../models');

async function getSlaStatus(orgId) {
  const projects = await db.Project.findAll({
    where: { orgId, status: 'active' },
    attributes: ['id', 'name', 'currentStageKey', 'workflowTemplateId'],
    include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
  });

  if (!projects.length) return [];

  const templateIds = [...new Set(projects.map((p) => p.workflowTemplateId))];
  const policies = await db.SlaPolicy.findAll({ where: { orgId, templateId: templateIds } });
  if (!policies.length) return [];

  const policyMap = {};
  for (const pol of policies) policyMap[`${pol.templateId}:${pol.stageKey}`] = pol;

  const relevantProjects = projects.filter(
    (p) => policyMap[`${p.workflowTemplateId}:${p.currentStageKey}`],
  );
  if (!relevantProjects.length) return [];

  // Fetch all events ordered DESC — first seen per (project, stage) key is the latest entry
  const allEvents = await db.ProjectEvent.findAll({
    where: { projectId: relevantProjects.map((p) => p.id) },
    attributes: ['projectId', 'toStageKey', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  const entryMap = {};
  for (const ev of allEvents) {
    const key = `${ev.projectId}:${ev.toStageKey}`;
    if (!entryMap[key]) entryMap[key] = ev.createdAt;
  }

  const now = Date.now();
  const result = [];
  for (const project of relevantProjects) {
    const policy = policyMap[`${project.workflowTemplateId}:${project.currentStageKey}`];
    const enteredAt = entryMap[`${project.id}:${project.currentStageKey}`];
    if (!enteredAt) continue;

    const hoursElapsed = (now - enteredAt) / 3600000;
    const hoursRemaining = policy.targetHours - hoursElapsed;

    let slaStatus = 'ok';
    if (hoursElapsed >= policy.targetHours) slaStatus = 'breached';
    else if (policy.warnAt && hoursRemaining <= policy.warnAt) slaStatus = 'warning';

    result.push({
      projectId: project.id,
      projectName: project.name,
      clientName: project.client?.name,
      currentStageKey: project.currentStageKey,
      slaStatus,
      hoursElapsed: Math.round(hoursElapsed * 10) / 10,
      targetHours: policy.targetHours,
      hoursRemaining: Math.round(hoursRemaining * 10) / 10,
    });
  }

  return result
    .filter((r) => r.slaStatus !== 'ok')
    .sort((a, b) => b.hoursElapsed - a.hoursElapsed);
}

async function getSlaPolicies(orgId, { includeInactive = false } = {}) {
  return db.SlaPolicy.findAll({
    where: { orgId, ...(includeInactive ? {} : { isActive: true }) },
    include: [{ model: db.WorkflowTemplate, as: 'template', attributes: ['id', 'name'] }],
    order: [['createdAt', 'ASC']],
  });
}

async function upsertSlaPolicy(orgId, data) {
  const { templateId, stageKey, targetHours, warnAt, escalateToRoleSlot } = data;
  let policy = await db.SlaPolicy.findOne({ where: { orgId, templateId, stageKey } });
  if (policy) {
    // The (org, template, stage) row is unique, so re-adding a policy that was
    // previously deactivated has to revive that row rather than insert a second one.
    await policy.update({
      targetHours,
      warnAt: warnAt ?? null,
      escalateToRoleSlot: escalateToRoleSlot ?? null,
      isActive: true,
    });
  } else {
    policy = await db.SlaPolicy.create({
      orgId,
      templateId,
      stageKey,
      targetHours,
      warnAt: warnAt ?? null,
      escalateToRoleSlot: escalateToRoleSlot ?? null,
    });
  }
  return policy;
}

// Deactivates rather than destroys — see services/SoftDeleteService.js.
async function deleteSlaPolicy(id, orgId, active = false) {
  const policy = await db.SlaPolicy.findOne({ where: { id, orgId } });
  if (!policy) throw Object.assign(new Error('SLA policy not found.'), { status: 404 });
  await policy.update({ isActive: active });
  return policy;
}

module.exports = { getSlaStatus, getSlaPolicies, upsertSlaPolicy, deleteSlaPolicy };
