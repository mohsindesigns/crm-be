const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { normalizeFields, validateAnswers, EMAIL_RE } = require('../utils/formFields');
const { activeWhere } = require('./SoftDeleteService');
const EmailService = require('./EmailService');
const NotificationService = require('./NotificationService');
const CaptchaService = require('./CaptchaService');

// Drives the "email the client a requirements form from a project" flow end to
// end: compose + send, the public token page the client fills in, and the
// reply landing back on the project.
//
// The client is NOT authenticated at any point — the token in the URL is the
// only credential, exactly like routes/publicLeadForms.js and
// routes/publicDocuments.js. Every function below that a public route reaches
// (getPublicByToken / submitPublic) must therefore scope itself by token alone
// and never echo an internal id back out.

function notFound(message = 'Request not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 });
}

function publicUrl(token) {
  const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/request/${token}`;
}

/** Same in-memory brake the public lead-form route uses (see LeadService) —
 *  per-process, not a security boundary, just a spam floor. */
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
  if (submitAttempts.size > 5000) {
    for (const [k, v] of submitAttempts) {
      if (!v.some((t) => now - t < RATE_LIMIT_WINDOW_MS)) submitAttempts.delete(k);
    }
  }
}

function normalizeCc(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(/[,;]/);
  const cleaned = list.map((e) => String(e).trim()).filter(Boolean);
  for (const email of cleaned) {
    if (!EMAIL_RE.test(email)) throw badRequest(`"${email}" is not a valid email address.`);
  }
  return [...new Set(cleaned)].slice(0, 10);
}

/** Recipient candidates for the compose screen: every active contact on the
 *  project's client that actually has an email address to send to. */
async function recipientOptions(projectId, orgId) {
  const project = await db.Project.findOne({ where: { id: projectId, orgId } });
  if (!project) throw notFound('Project not found.');
  const contacts = await db.Contact.findAll({
    where: {
      clientId: project.clientId,
      isActive: true,
      email: { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: '' }] },
    },
    attributes: ['id', 'name', 'email', 'role'],
    order: [['name', 'ASC']],
  });
  return contacts.map((c) => c.toJSON());
}

/**
 * Composes and sends one requirements form to a client contact.
 *
 * `fields` is snapshotted onto the row here — a later edit to the template it
 * came from must never change a form already sitting in a client's inbox.
 */
async function send(projectId, orgId, data, userId) {
  const project = await db.Project.findOne({
    where: { id: projectId, orgId },
    include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
  });
  if (!project) throw notFound('Project not found.');

  let template = null;
  if (data.templateId) {
    template = await db.RequirementFormTemplate.findOne({ where: { id: data.templateId, orgId } });
    if (!template) throw badRequest('Requirement form template not found.');
  }

  // Per-send edits win over the template; the template is only a starting point.
  const fields = normalizeFields(data.fields || template?.fields);

  // Recipient: either an existing contact on this client, or a typed-in address.
  let contact = null;
  if (data.contactId) {
    contact = await db.Contact.findOne({ where: { id: data.contactId, clientId: project.clientId } });
    if (!contact) throw badRequest('That contact does not belong to this project\'s client.');
    if (!contact.email) throw badRequest(`${contact.name} has no email address on file.`);
  }
  const recipientEmail = String(contact?.email || data.recipientEmail || '').trim();
  if (!recipientEmail) throw badRequest('Choose a contact or enter an email address to send to.');
  if (!EMAIL_RE.test(recipientEmail)) throw badRequest('Enter a valid email address.');

  const subject = String(data.subject || template?.defaultSubject || `Project requirements — ${project.name}`).trim();
  if (!subject) throw badRequest('The email needs a subject.');

  // The org's own contact address is always CC'd, on top of whatever staff
  // typed — so there's always an internal copy of what was asked for. Not
  // staff-removable: it's appended after normalizeCc, not merged into the
  // editable input. Guarded with EMAIL_RE (rather than normalizeCc, which
  // throws) so a malformed org contact address never blocks a send.
  const branding = await db.WhiteLabelConfig.findOne({ where: { orgId } });
  const orgCc = branding?.contactEmail && EMAIL_RE.test(String(branding.contactEmail).trim())
    ? String(branding.contactEmail).trim()
    : null;
  const ccEmails = [...new Set([...normalizeCc(data.ccEmails), ...(orgCc ? [orgCc] : [])])]
    .filter((e) => e.toLowerCase() !== recipientEmail.toLowerCase())
    .slice(0, 10);
  const publicToken = crypto.randomBytes(24).toString('base64url');

  const request = await db.ClientRequest.create({
    id: uuidv4(),
    orgId,
    projectId: project.id,
    clientId: project.clientId,
    templateId: template?.id || null,
    contactId: contact?.id || null,
    recipientEmail,
    recipientName: contact?.name || data.recipientName || null,
    ccEmails: ccEmails.length ? ccEmails : null,
    subject,
    message: data.message || template?.defaultMessage || null,
    fields,
    successMessage: data.successMessage || template?.successMessage || null,
    publicToken,
    status: 'sent',
    dueAt: data.dueAt || null,
    sentBy: userId,
    sentAt: new Date(),
  });

  // The email is the whole point of this action, so unlike most side effects in
  // this codebase it is awaited rather than fire-and-forget: if SMTP rejects
  // it, the caller needs to know the client never got the link.
  // EmailService.sendMail swallows send failures and returns null, so a null
  // result is the failure signal.
  const sent = await EmailService.sendClientRequestForm({
    to: recipientEmail,
    cc: ccEmails,
    recipientName: request.recipientName,
    brandName: branding?.brandName || 'Your agency',
    logoUrl: branding?.logoUrl || null,
    projectName: project.name,
    subject,
    message: request.message,
    formUrl: publicUrl(publicToken),
    dueAt: request.dueAt,
    fieldCount: fields.length,
  });

  // Keep the row either way — the link is live and can be resent or copied
  // manually — but be honest to the caller about whether the email went out.
  return {
    request: await findById(request.id, orgId),
    emailSent: !!sent,
    formUrl: publicUrl(publicToken),
  };
}

async function listForProject(projectId, orgId, query = {}) {
  const requests = await db.ClientRequest.findAll({
    where: { projectId, orgId, ...activeWhere(db.ClientRequest, query) },
    include: [
      { model: db.User, as: 'sender', attributes: ['id', 'name'] },
      { model: db.Contact, as: 'contact', attributes: ['id', 'name', 'email'] },
      { model: db.RequirementFormTemplate, as: 'template', attributes: ['id', 'name'] },
    ],
    order: [['createdAt', 'DESC']],
  });
  return requests.map((r) => ({ ...r.toJSON(), formUrl: publicUrl(r.publicToken) }));
}

async function findById(id, orgId) {
  const request = await db.ClientRequest.findOne({
    where: { id, orgId },
    include: [
      { model: db.User, as: 'sender', attributes: ['id', 'name'] },
      { model: db.Contact, as: 'contact', attributes: ['id', 'name', 'email'] },
      { model: db.RequirementFormTemplate, as: 'template', attributes: ['id', 'name'] },
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
    ],
  });
  if (!request) throw notFound();
  return { ...request.toJSON(), formUrl: publicUrl(request.publicToken) };
}

/** Withdraws an unanswered request — the public link stops resolving. An
 *  already-answered request can't be cancelled: the reply is real history. */
async function cancel(id, orgId) {
  const request = await db.ClientRequest.findOne({ where: { id, orgId } });
  if (!request) throw notFound();
  if (request.status === 'responded') throw conflict('This request has already been answered.');
  await request.update({ status: 'cancelled' });
  return findById(id, orgId);
}

/** Re-sends the same link (manual nudge). Also used by the reminder scheduler,
 *  which passes `automated: true` so the email says so. */
async function remind(id, orgId, { automated = false } = {}) {
  const request = await db.ClientRequest.findOne({
    where: { id, orgId },
    include: [{ model: db.Project, as: 'project', attributes: ['id', 'name'] }],
  });
  if (!request) throw notFound();
  if (request.status !== 'sent') throw conflict('Only a request still awaiting a reply can be resent.');

  const branding = await db.WhiteLabelConfig.findOne({ where: { orgId } });
  const sent = await EmailService.sendClientRequestReminder({
    to: request.recipientEmail,
    cc: request.ccEmails || [],
    recipientName: request.recipientName,
    brandName: branding?.brandName || 'Your agency',
    logoUrl: branding?.logoUrl || null,
    projectName: request.project?.name || 'your project',
    subject: request.subject,
    formUrl: publicUrl(request.publicToken),
    dueAt: request.dueAt,
    automated,
  });
  if (!sent) return { request: await findById(id, orgId), emailSent: false };

  await request.update({
    remindersSent: (request.remindersSent || 0) + 1,
    lastReminderAt: new Date(),
  });
  return { request: await findById(id, orgId), emailSent: true };
}

// ---------------------------------------------------------------------------
// Public (token-only) surface — everything below is reachable by anyone
// holding the link. Never widen these response shapes with internal ids.
// ---------------------------------------------------------------------------

async function loadByToken(token) {
  const request = await db.ClientRequest.findOne({
    where: { publicToken: token, isActive: true },
    include: [
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
      { model: db.Org, as: 'org', include: [{ model: db.WhiteLabelConfig, as: 'brand' }] },
    ],
  });
  if (!request) throw notFound('This form is no longer available.');
  if (request.status === 'cancelled') throw notFound('This form is no longer available.');
  return request;
}

async function getPublicByToken(token) {
  const request = await loadByToken(token);

  // First open flips viewedAt — lets staff tell "never opened it" apart from
  // "opened it and hasn't replied". Fire-and-forget: a write failure must not
  // stop the client seeing their form.
  if (!request.viewedAt && request.status === 'sent') {
    request.update({ viewedAt: new Date() }).catch(() => {});
  }

  const brandName = request.org?.brand?.brandName || request.org?.name || 'Your agency';
  return {
    projectName: request.project?.name || null,
    recipientName: request.recipientName,
    subject: request.subject,
    message: request.message,
    dueAt: request.dueAt,
    // Already answered: the page renders a read-only "we've got this" state
    // instead of the form, so a second click on the emailed link isn't a dead
    // end for the client.
    alreadyResponded: request.status === 'responded',
    respondedAt: request.respondedAt,
    fields: (request.fields || []).filter((f) => !f.hidden),
    branding: {
      brandName,
      logoUrl: request.org?.brand?.logoUrl || null,
    },
    // Same shape crm-fe's LeadFormRenderer takes (see lib/leadFormTheme.ts), so
    // the client-facing page reuses that component instead of growing a second
    // form renderer that would drift from it.
    theme: {
      headline: request.subject,
      description: request.message || '',
      buttonText: 'Submit requirements',
      primaryColor: request.org?.brand?.primaryColor || '#0B1D5E',
      backgroundColor: '#FFFFFF',
      showLogo: true,
      showName: true,
      showHeadline: true,
      borderRadius: 'rounded',
    },
  };
}

/** The client's reply. This is what flips the project tab to "Responded". */
async function submitPublic(token, body, req) {
  // Honeypot — see LeadService#submitPublic for why this returns success.
  if (body?._hp) {
    return { success: true, message: 'Thanks — we\'ve received your requirements.' };
  }

  checkRateLimit(req?.ip);
  CaptchaService.verify(body?.captchaToken, body?.captchaAnswer);

  const request = await loadByToken(token);
  if (request.status === 'responded') {
    throw conflict('This form has already been submitted. Get in touch if you need to change your answers.');
  }

  const responseData = validateAnswers(request.fields || [], body?.answers || {});

  await request.update({
    status: 'responded',
    responseData,
    respondedAt: new Date(),
    responseIp: req?.ip || null,
  });

  // Tell the sender their reply landed. Fire-and-forget — never let a
  // notification failure fail the submission the client is waiting on.
  if (request.sentBy) {
    NotificationService.notify(request.sentBy, request.orgId, {
      type: 'client_request_responded',
      title: `Client replied: ${request.subject}`,
      body: `${request.recipientName || request.recipientEmail} submitted the requirements form for ${request.project?.name || 'a project'}.`,
      refTable: 'client_requests',
      refId: request.id,
    }).catch(() => {});
  }

  return {
    success: true,
    message: request.successMessage
      || 'Thanks — we\'ve received your requirements and the team will be in touch shortly.',
  };
}

module.exports = {
  send,
  listForProject,
  findById,
  cancel,
  remind,
  recipientOptions,
  getPublicByToken,
  submitPublic,
  publicUrl,
};
