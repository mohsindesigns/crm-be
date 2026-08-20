const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { normalizeFields } = require('../utils/formFields');
const { activeWhere, setActive } = require('./SoftDeleteService');

// CRUD for the reusable requirement-form templates staff pick from when
// emailing a client (see models/RequirementFormTemplate.js). Nothing here is
// public — templates never leave the org.

function notFound(message = 'Requirement form not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

async function create(orgId, data, userId = null) {
  const name = String(data?.name || '').trim();
  if (!name) throw badRequest('Give the form a name.');
  return db.RequirementFormTemplate.create({
    id: uuidv4(),
    orgId,
    name,
    description: data.description || null,
    fields: normalizeFields(data.fields),
    defaultSubject: data.defaultSubject || null,
    defaultMessage: data.defaultMessage || null,
    successMessage: data.successMessage || null,
    createdBy: userId,
  });
}

async function list(orgId, query = {}) {
  const templates = await db.RequirementFormTemplate.findAll({
    where: { orgId, ...activeWhere(db.RequirementFormTemplate, query) },
    include: [{ model: db.User, as: 'creator', attributes: ['id', 'name'] }],
    order: [['createdAt', 'DESC']],
  });
  // How many requests each template has been used for — the one signal that
  // tells staff which templates are actually in use. One grouped query, not N+1.
  const counts = await db.ClientRequest.findAll({
    where: { orgId, templateId: templates.map((t) => t.id) },
    attributes: ['templateId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['templateId'],
    raw: true,
  });
  const byTemplate = new Map(counts.map((c) => [c.templateId, Number(c.count)]));
  return templates.map((t) => {
    const json = t.toJSON();
    json.timesSent = byTemplate.get(t.id) || 0;
    return json;
  });
}

async function findById(id, orgId) {
  const template = await db.RequirementFormTemplate.findOne({ where: { id, orgId } });
  if (!template) throw notFound();
  return template;
}

async function update(id, orgId, data) {
  const template = await db.RequirementFormTemplate.findOne({ where: { id, orgId } });
  if (!template) throw notFound();
  const patch = {};
  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw badRequest('Give the form a name.');
    patch.name = name;
  }
  if (data.description !== undefined) patch.description = data.description || null;
  if (data.fields !== undefined) patch.fields = normalizeFields(data.fields);
  if (data.defaultSubject !== undefined) patch.defaultSubject = data.defaultSubject || null;
  if (data.defaultMessage !== undefined) patch.defaultMessage = data.defaultMessage || null;
  if (data.successMessage !== undefined) patch.successMessage = data.successMessage || null;
  await template.update(patch);
  return template;
}

/** Soft delete only — see services/SoftDeleteService.js. Requests already sent
 *  from this template keep working: they carry their own field snapshot. */
async function setTemplateActive(id, orgId, active) {
  return setActive(db.RequirementFormTemplate, { id, orgId }, active, 'Requirement form not found.');
}

module.exports = { create, list, findById, update, setTemplateActive };
