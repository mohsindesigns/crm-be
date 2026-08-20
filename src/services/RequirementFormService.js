const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
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

// Appearance customization — same shape/validation as LeadFormService's
// normalizeTheme/effectiveTheme (crm-fe's LeadFormRenderer renders both off
// this one LeadFormTheme type), duplicated rather than imported because the
// two fallback chains differ (LeadForm carries a legacy showBranding flag
// this domain has no history of) and duplicating one small validator is
// cheaper than coupling two otherwise-independent services.
const BORDER_RADIUS_VALUES = ['sharp', 'rounded', 'pill'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/** Whitelists/validates the appearance overrides a template or a per-send
 *  edit can carry. Always sent as the complete theme object, never a partial
 *  patch — an omitted/blank field means "no override, fall back at render
 *  time" (see effectiveTheme). */
function normalizeTheme(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const t = {};
  const headline = String(src.headline || '').trim();
  if (headline) t.headline = headline.slice(0, 255);
  const description = String(src.description || '').trim();
  if (description) t.description = description.slice(0, 1000);
  const buttonText = String(src.buttonText || '').trim();
  if (buttonText) t.buttonText = buttonText.slice(0, 60);
  if (src.primaryColor) {
    const v = String(src.primaryColor).trim();
    if (!HEX_COLOR_RE.test(v)) throw badRequest('Primary color must be a hex value like #0B1D5E.');
    t.primaryColor = v;
  }
  if (src.backgroundColor) {
    const v = String(src.backgroundColor).trim();
    if (!HEX_COLOR_RE.test(v)) throw badRequest('Background color must be a hex value like #FFFFFF.');
    t.backgroundColor = v;
  }
  if (src.showLogo !== undefined) t.showLogo = !!src.showLogo;
  if (src.showName !== undefined) t.showName = !!src.showName;
  if (src.showHeadline !== undefined) t.showHeadline = !!src.showHeadline;
  if (src.borderRadius) {
    const v = String(src.borderRadius).trim();
    if (!BORDER_RADIUS_VALUES.includes(v)) throw badRequest('Invalid border radius option.');
    t.borderRadius = v;
  }
  return t;
}

/** Fills in every theme key with either the override or a fallback. Callers
 *  pass their own fallback headline/button text/org color so the public
 *  request page and the compose-modal preview never duplicate this chain. */
function effectiveTheme(themeOverride, {
  fallbackHeadline, fallbackDescription, fallbackButtonText = 'Submit requirements', orgPrimaryColor,
} = {}) {
  const t = themeOverride || {};
  return {
    headline: t.headline || fallbackHeadline || '',
    description: t.description || fallbackDescription || '',
    buttonText: t.buttonText || fallbackButtonText,
    primaryColor: t.primaryColor || orgPrimaryColor || '#0B1D5E',
    backgroundColor: t.backgroundColor || '#FFFFFF',
    showLogo: t.showLogo !== undefined ? t.showLogo : true,
    showName: t.showName !== undefined ? t.showName : true,
    showHeadline: t.showHeadline !== undefined ? t.showHeadline : true,
    borderRadius: BORDER_RADIUS_VALUES.includes(t.borderRadius) ? t.borderRadius : 'rounded',
  };
}

/** At most one active template per (orgId, serviceTypeKey) can be the default
 *  offered for that service — setting a new one silently un-defaults whatever
 *  held that slot before, same "picking a new one replaces the old" UX as a
 *  radio button rather than a checkbox. */
async function clearOtherDefaults(orgId, serviceTypeKey, exceptId = null) {
  if (!serviceTypeKey) return;
  await db.RequirementFormTemplate.update(
    { serviceTypeKey: null },
    { where: { orgId, serviceTypeKey, ...(exceptId ? { id: { [Op.ne]: exceptId } } : {}) } },
  );
}

async function create(orgId, data, userId = null) {
  const name = String(data?.name || '').trim();
  if (!name) throw badRequest('Give the form a name.');
  const serviceTypeKey = data.serviceTypeKey || null;
  if (serviceTypeKey) await clearOtherDefaults(orgId, serviceTypeKey);
  return db.RequirementFormTemplate.create({
    id: uuidv4(),
    orgId,
    name,
    description: data.description || null,
    fields: normalizeFields(data.fields),
    theme: normalizeTheme(data.theme),
    defaultSubject: data.defaultSubject || null,
    defaultMessage: data.defaultMessage || null,
    successMessage: data.successMessage || null,
    serviceTypeKey,
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
  if (data.theme !== undefined) patch.theme = normalizeTheme(data.theme);
  if (data.defaultSubject !== undefined) patch.defaultSubject = data.defaultSubject || null;
  if (data.defaultMessage !== undefined) patch.defaultMessage = data.defaultMessage || null;
  if (data.successMessage !== undefined) patch.successMessage = data.successMessage || null;
  if (data.serviceTypeKey !== undefined) {
    patch.serviceTypeKey = data.serviceTypeKey || null;
    if (patch.serviceTypeKey) await clearOtherDefaults(orgId, patch.serviceTypeKey, id);
  }
  await template.update(patch);
  return template;
}

/** Soft delete only — see services/SoftDeleteService.js. Requests already sent
 *  from this template keep working: they carry their own field snapshot. */
async function setTemplateActive(id, orgId, active) {
  return setActive(db.RequirementFormTemplate, { id, orgId }, active, 'Requirement form not found.');
}

module.exports = { create, list, findById, update, setTemplateActive, normalizeTheme, effectiveTheme };
