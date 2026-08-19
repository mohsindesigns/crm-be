const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { LEAD_STATUS } = require('../config/constants');
const { activeWhere } = require('./SoftDeleteService');
const NotificationService = require('./NotificationService');
const LeadFormService = require('./LeadFormService');
const CaptchaService = require('./CaptchaService');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits with optional leading +, spaces/dashes/dots/parens as separators —
// permissive on formatting (no country-specific shape assumed) but rejects
// obvious junk like "abc" or a single digit.
const PHONE_RE = /^\+?[\d\s().-]{7,20}$/;

const VALID_STATUSES = Object.values(LEAD_STATUS);

function notFound(message = 'Lead not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// In-memory, per-process — deliberately not a dependency (no express-rate-limit
// in this app) and deliberately not shared storage. Good enough for the single
// Node process this app currently runs as; would need a shared store (Redis)
// behind a multi-instance/PM2-cluster deployment. Purely a brake on obvious
// spam floods, not a security boundary.
const submitAttempts = new Map(); // ip -> timestamps[]
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;

function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const attempts = (submitAttempts.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (attempts.length >= RATE_LIMIT_MAX) {
    throw Object.assign(new Error('Too many submissions — please try again in a minute.'), { status: 429 });
  }
  attempts.push(now);
  submitAttempts.set(key, attempts);
  // Cheap cleanup so this map doesn't grow unbounded over a long-running process.
  if (submitAttempts.size > 5000) {
    for (const [k, v] of submitAttempts) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) submitAttempts.delete(k);
    }
  }
}

/** Validates submitted answers against the form's field definitions and builds
 *  the fieldData object + the pulled-out fullName/email/phone. */
function buildFieldData(fields, answers) {
  const fieldData = {};
  let fullName = null;
  let email = null;
  let phone = null;

  for (const field of fields) {
    // Hidden fields never render on the public form, so a visitor can never
    // answer them — skip validation entirely rather than blocking every
    // submission on a required field nobody could see.
    if (field.hidden) continue;
    const raw = answers?.[field.key];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (field.required && (value === undefined || value === null || value === '')) {
      throw badRequest(`"${field.label}" is required.`);
    }
    if (field.type === 'select' && value && !field.options?.includes(value)) {
      throw badRequest(`"${value}" is not a valid option for "${field.label}".`);
    }
    if (field.type === 'email' && value && !EMAIL_RE.test(value)) {
      throw badRequest(`"${field.label}" must be a valid email address.`);
    }
    if (field.type === 'phone' && value && !PHONE_RE.test(value)) {
      throw badRequest(`"${field.label}" must be a valid phone number.`);
    }
    if (value !== undefined && value !== null && value !== '') {
      fieldData[field.key] = value;
      if (field.type === 'email' && !email) email = String(value);
      if (field.type === 'phone' && !phone) phone = String(value);
      if (field.type === 'text' && !fullName && (field.key === 'name' || field.key.includes('name'))) {
        fullName = String(value);
      }
    }
  }
  // Fallback: no field looked like a name — use the first text answer we have.
  if (!fullName) {
    const firstText = fields.find((f) => f.type === 'text' && fieldData[f.key]);
    if (firstText) fullName = String(fieldData[firstText.key]);
  }
  return { fieldData, fullName, email, phone };
}

/** Public submission entry point — called from the unauthenticated embed route.
 *  Token is the only scope; never trusts a client-supplied orgId. */
async function submitPublic(token, body, req) {
  // Honeypot: the embed page renders a field named `_hp` that's hidden via CSS
  // and real users never see or fill. A bot that fills every input trips it —
  // respond with the normal success shape so it doesn't learn to skip the trap.
  if (body?._hp) {
    return { success: true, message: 'Thanks — we\'ll be in touch shortly.' };
  }

  checkRateLimit(req?.ip);
  CaptchaService.verify(body?.captchaToken, body?.captchaAnswer);

  const form = await db.LeadForm.findOne({ where: { publicToken: token, status: 'active', isActive: true } });
  if (!form) throw notFound('This form is no longer available.');

  const { fieldData, fullName, email, phone } = buildFieldData(form.fields, body?.answers || {});

  const lead = await db.sequelize.transaction(async (t) => {
    const row = await db.Lead.create({
      id: uuidv4(),
      orgId: form.orgId,
      formId: form.id,
      source: 'form',
      projectId: form.projectId,
      campaign: form.campaign,
      sourceClientId: form.clientId,
      fieldData,
      fullName,
      email,
      phone,
      status: LEAD_STATUS.NEW,
      ip: req?.ip || null,
      referrer: req?.get?.('referer') || null,
    }, { transaction: t });

    await db.LeadEvent.create({
      leadId: row.id,
      fromStatus: null,
      toStatus: LEAD_STATUS.NEW,
      actorUserId: null,
      note: 'Submitted via embedded form.',
    }, { transaction: t });

    return row;
  });

  // Fire-and-forget — never let a notification failure fail the submission the
  // visitor is waiting on.
  if (form.createdBy) {
    NotificationService.notify(form.createdBy, form.orgId, {
      type: 'lead_received',
      title: `New lead: ${form.name}`,
      body: fullName ? `${fullName}${email ? ` · ${email}` : ''}` : 'A new lead just came in.',
      refTable: 'leads',
      refId: lead.id,
    }).catch(() => {});
  }

  return {
    success: true,
    message: form.successMessage || 'Thanks — we\'ll be in touch shortly.',
    redirectUrl: form.redirectUrl || null,
  };
}

/** @param {string|null} [scopeClientId] - forced by portal callers to their
 *  own client (via Lead.sourceClientId); staff callers omit it. */
async function list(orgId, query = {}, scopeClientId = null) {
  const where = { orgId, ...activeWhere(db.Lead, query) };
  if (scopeClientId) where.sourceClientId = scopeClientId;
  if (query.status) where.status = query.status;
  if (query.projectId) where.projectId = query.projectId;
  if (query.campaign) where.campaign = query.campaign;
  if (query.formId) where.formId = query.formId;
  if (query.assignedToUserId) where.assignedToUserId = query.assignedToUserId;
  if (query.source) where.source = query.source;
  if (query.dateFrom || query.dateTo) {
    where.createdAt = {};
    if (query.dateFrom) where.createdAt[Op.gte] = new Date(`${String(query.dateFrom).slice(0, 10)}T00:00:00`);
    if (query.dateTo) where.createdAt[Op.lte] = new Date(`${String(query.dateTo).slice(0, 10)}T23:59:59.999`);
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where[Op.or] = [
      { fullName: { [Op.like]: like } },
      { email: { [Op.like]: like } },
      { phone: { [Op.like]: like } },
    ];
  }
  return db.Lead.findAll({
    where,
    include: [
      { model: db.LeadForm, as: 'form', attributes: ['id', 'name'] },
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
      { model: db.User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
    ],
    order: [['createdAt', 'DESC']],
  });
}

async function findById(id, orgId, scopeClientId = null) {
  const where = { id, orgId };
  if (scopeClientId) where.sourceClientId = scopeClientId;
  const lead = await db.Lead.findOne({
    where,
    include: [
      { model: db.LeadForm, as: 'form', attributes: ['id', 'name', 'fields'] },
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
      { model: db.User, as: 'assignee', attributes: ['id', 'name', 'avatarUrl'] },
      {
        model: db.LeadEvent, as: 'events',
        include: [{ model: db.User, as: 'actor', attributes: ['id', 'name', 'avatarUrl'] }],
        separate: true,
        order: [['createdAt', 'ASC']],
      },
    ],
  });
  if (!lead) throw notFound();
  return lead;
}

async function updateStatus(id, orgId, status, actorUser, note) {
  if (!VALID_STATUSES.includes(status)) throw badRequest('Invalid lead status.');
  const lead = await db.Lead.findOne({ where: { id, orgId } });
  if (!lead) throw notFound();
  if (lead.status === status) return lead;

  await db.sequelize.transaction(async (t) => {
    await db.LeadEvent.create({
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: status,
      actorUserId: actorUser.id,
      note: note || null,
    }, { transaction: t });
    await lead.update({ status }, { transaction: t });
  });
  return lead;
}

async function assign(id, orgId, userId, actorUser) {
  const lead = await db.Lead.findOne({ where: { id, orgId } });
  if (!lead) throw notFound();
  if (userId) {
    const user = await db.User.findOne({ where: { id: userId, orgId } });
    if (!user) throw badRequest('User not found.');
  }
  await lead.update({ assignedToUserId: userId || null });
  if (userId && userId !== actorUser.id) {
    NotificationService.notify(userId, orgId, {
      type: 'lead_assigned',
      title: `Lead assigned: ${lead.fullName || lead.email || 'New lead'}`,
      body: `${actorUser.name} assigned you a lead.`,
      refTable: 'leads',
      refId: lead.id,
    }).catch(() => {});
  }
  return lead;
}

/** Explicit, manual conversion — marking a lead Qualified does not by itself
 *  create a Client. Kept as its own step so a mis-click on the status dropdown
 *  never silently creates junk client records. */
async function convertToClient(id, orgId, actorUser, overrides = {}) {
  const lead = await db.Lead.findOne({ where: { id, orgId } });
  if (!lead) throw notFound();
  if (lead.convertedClientId) throw badRequest('This lead has already been converted.');

  const name = String(overrides.name || lead.fullName || lead.email || 'New Client').trim();

  const client = await db.sequelize.transaction(async (t) => {
    const newClient = await db.Client.create({
      id: uuidv4(),
      orgId,
      name,
      status: 'active',
      notes: `Converted from lead (${lead.source}${lead.campaign ? `, campaign: ${lead.campaign}` : ''}).`,
    }, { transaction: t });

    if (lead.email || lead.phone) {
      await db.Contact.create({
        id: uuidv4(),
        clientId: newClient.id,
        name,
        email: lead.email || null,
        phone: lead.phone || null,
        useForInvoice: true,
        isActive: true,
      }, { transaction: t });
    }

    await db.LeadEvent.create({
      leadId: lead.id,
      fromStatus: lead.status,
      toStatus: LEAD_STATUS.CONVERTED,
      actorUserId: actorUser.id,
      note: `Converted to client "${name}".`,
    }, { transaction: t });

    await lead.update({ status: LEAD_STATUS.CONVERTED, convertedClientId: newClient.id }, { transaction: t });

    return newClient;
  });

  return { lead, client };
}

module.exports = { submitPublic, list, findById, updateStatus, assign, convertToClient };
