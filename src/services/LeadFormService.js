const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { LEAD_FORM_FIELD_TYPES } = require('../config/constants');
const { activeWhere, setActive } = require('./SoftDeleteService');

function notFound(message = 'Lead form not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/** Validates and normalizes the field list a form is built from. Never trusts
 *  client-supplied `key`s blindly — they become the storage keys on every
 *  submission this form ever receives, so duplicates/blank keys are rejected
 *  up front rather than corrupting fieldData later. */
function normalizeFields(rawFields) {
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    throw badRequest('A form needs at least one field.');
  }
  const seenKeys = new Set();
  return rawFields.map((f, i) => {
    const label = String(f?.label || '').trim();
    if (!label) throw badRequest(`Field ${i + 1} needs a label.`);
    const type = String(f?.type || 'text').trim();
    if (!LEAD_FORM_FIELD_TYPES.includes(type)) {
      throw badRequest(`Field "${label}" has an unsupported type "${type}".`);
    }
    const key = String(f?.key || label)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || `field_${i + 1}`;
    if (seenKeys.has(key)) throw badRequest(`Duplicate field key "${key}" — give each field a unique label.`);
    seenKeys.add(key);
    const options = type === 'select'
      ? (Array.isArray(f?.options) ? f.options.map(String).filter(Boolean) : [])
      : undefined;
    if (type === 'select' && (!options || options.length === 0)) {
      throw badRequest(`Field "${label}" is a dropdown but has no options.`);
    }
    return { key, label, type, required: !!f?.required, ...(options ? { options } : {}) };
  });
}

const BORDER_RADIUS_VALUES = ['sharp', 'rounded', 'pill'];
const HEX_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

/** Whitelists/validates the appearance overrides a form can carry. The
 *  builder always sends the complete theme object on every save (not a
 *  partial patch), so this can simply replace what's stored rather than
 *  merge — an omitted/blank field just means "no override, fall back at
 *  render time" (see effectiveTheme). */
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
  if (src.showBranding !== undefined) t.showBranding = !!src.showBranding;
  if (src.borderRadius) {
    const v = String(src.borderRadius);
    if (!BORDER_RADIUS_VALUES.includes(v)) throw badRequest('Invalid border radius option.');
    t.borderRadius = v;
  }
  return t;
}

/** Fills in every theme key with either the form's own override or a
 *  fallback (org brand color, then a hardcoded default) — the public embed
 *  page and the builder's preview both render off this, never off raw
 *  `form.theme` directly, so neither has to duplicate the fallback chain. */
function effectiveTheme(form) {
  const t = form.theme || {};
  return {
    headline: t.headline || form.name,
    description: t.description || '',
    buttonText: t.buttonText || 'Submit',
    primaryColor: t.primaryColor || form.org?.brand?.primaryColor || '#0B1D5E',
    backgroundColor: t.backgroundColor || '#FFFFFF',
    showBranding: t.showBranding !== undefined ? t.showBranding : true,
    borderRadius: BORDER_RADIUS_VALUES.includes(t.borderRadius) ? t.borderRadius : 'rounded',
  };
}

/**
 * @param {object} actor - exactly one of userId (staff) or contactId (portal
 *   client) is set. clientId is forced (not client-supplied) whenever this
 *   is a portal call — see routes/portalLeadForms.js — so a portal contact
 *   can never create a form scoped to a different client than their own.
 */
async function create(orgId, data, actor = {}) {
  const { userId = null, contactId = null, clientId = null } = actor;
  const fields = normalizeFields(data.fields);
  // Project scoping only makes sense for agency-built forms — a portal call
  // never sends projectId (see routes/portalLeadForms.js), so this simply
  // doesn't run for those.
  if (data.projectId) {
    const project = await db.Project.findOne({ where: { id: data.projectId, orgId } });
    if (!project) throw badRequest('Project not found.');
  }
  return db.LeadForm.create({
    id: uuidv4(),
    orgId,
    projectId: data.projectId || null,
    campaign: data.campaign || null,
    clientId,
    name: String(data.name || '').trim() || 'Untitled form',
    fields,
    publicToken: crypto.randomBytes(24).toString('base64url'),
    successMessage: data.successMessage || 'Thanks — we\'ll be in touch shortly.',
    redirectUrl: data.redirectUrl || null,
    theme: normalizeTheme(data.theme),
    createdBy: userId,
    createdByContactId: contactId,
  });
}

/** @param {string|null} [scopeClientId] - forced by portal callers to their
 *  own client; staff callers omit it and see every form in the org. */
async function list(orgId, query = {}, scopeClientId = null) {
  const where = { orgId, ...activeWhere(db.LeadForm, query) };
  if (scopeClientId) where.clientId = scopeClientId;
  if (query.projectId) where.projectId = query.projectId;
  if (query.campaign) where.campaign = query.campaign;
  if (query.status) where.status = query.status;
  const forms = await db.LeadForm.findAll({
    where,
    include: [
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
      { model: db.Client, as: 'client', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  });
  // Lead counts per form, one query rather than N+1 — the list view shows this
  // as a quick "how much has this form actually brought in" signal.
  const counts = await db.Lead.findAll({
    where: { orgId, formId: forms.map((f) => f.id) },
    attributes: ['formId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'count']],
    group: ['formId'],
    raw: true,
  });
  const countByForm = new Map(counts.map((c) => [c.formId, Number(c.count)]));
  return forms.map((f) => {
    const json = f.toJSON();
    json.leadCount = countByForm.get(f.id) || 0;
    return json;
  });
}

async function findById(id, orgId, scopeClientId = null) {
  const where = { id, orgId };
  if (scopeClientId) where.clientId = scopeClientId;
  const form = await db.LeadForm.findOne({
    where,
    include: [
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
      { model: db.Client, as: 'client', attributes: ['id', 'name'] },
    ],
  });
  if (!form) throw notFound();
  return form;
}

async function update(id, orgId, data, scopeClientId = null) {
  const where = { id, orgId };
  if (scopeClientId) where.clientId = scopeClientId;
  const form = await db.LeadForm.findOne({ where });
  if (!form) throw notFound();
  const patch = {};
  if (data.name !== undefined) patch.name = String(data.name).trim() || form.name;
  if (data.campaign !== undefined) patch.campaign = data.campaign || null;
  if (data.projectId !== undefined) patch.projectId = data.projectId || null;
  if (data.fields !== undefined) patch.fields = normalizeFields(data.fields);
  if (data.status !== undefined) {
    if (!['active', 'paused'].includes(data.status)) throw badRequest('Invalid status.');
    patch.status = data.status;
  }
  if (data.successMessage !== undefined) patch.successMessage = data.successMessage || null;
  if (data.redirectUrl !== undefined) patch.redirectUrl = data.redirectUrl || null;
  if (data.theme !== undefined) patch.theme = normalizeTheme(data.theme);
  await form.update(patch);
  return form;
}

async function setFormActive(id, orgId, active, scopeClientId = null) {
  const where = { id, orgId };
  if (scopeClientId) where.clientId = scopeClientId;
  return setActive(db.LeadForm, where, active, 'Lead form not found.');
}

// Public-facing shape only — never leak orgId/createdBy/internal ids to the
// embed page, which is reachable by anyone holding the link.
async function getPublicByToken(token) {
  const form = await db.LeadForm.findOne({
    where: { publicToken: token, status: 'active', isActive: true },
    include: [{ model: db.Org, as: 'org', include: [{ model: db.WhiteLabelConfig, as: 'brand' }] }],
  });
  if (!form) throw notFound('This form is no longer available.');
  return {
    id: form.id,
    name: form.name,
    fields: form.fields,
    branding: {
      brandName: form.org?.brand?.brandName || form.org?.name || 'Contact us',
      logoUrl: form.org?.brand?.logoUrl || null,
    },
    theme: effectiveTheme(form),
  };
}

module.exports = { create, list, findById, update, setFormActive, getPublicByToken, normalizeFields, normalizeTheme, effectiveTheme };
