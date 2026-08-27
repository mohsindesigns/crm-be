const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { normalizeFields, validateAnswers, EMAIL_RE } = require('../utils/formFields');
const { activeWhere } = require('./SoftDeleteService');
const EmailService = require('./EmailService');
const NotificationService = require('./NotificationService');
const CaptchaService = require('./CaptchaService');
const MediaService = require('./MediaService');
const { normalizeTheme, effectiveTheme } = require('./RequirementFormService');

// Drives the "email the client a requirements form from a project" flow end to
// end: compose, admin approval, the send, the public token page the client
// fills in, and the reply landing back on the project.
//
// APPROVAL GATE — nothing composed here reaches a client unreviewed. #send
// always writes the row as `pending_approval` and #dispatch is the only place
// the client email is ever sent; #approve is the only caller of it other than
// the auto-approve shortcut inside #send. So a request that never passed an
// admin has no sentAt, and its public link does not resolve (#loadByToken).
// The one shortcut: an admin/super_admin composing their own request is
// approved by themselves in the same call, otherwise a single-admin org would
// have to approve every one of its own sends twice.
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

/** Who may release a pending request to the client. Deliberately the same two
 *  system roles middleware/adminOnly gates on — the route chains that
 *  middleware too; this is the service-side belt to its braces, so the rule
 *  still holds for any non-HTTP caller. */
const APPROVER_ROLE_KEYS = ['super_admin', 'admin'];

function isApprover(user) {
  return APPROVER_ROLE_KEYS.includes(user?.role?.key);
}

/** Tells every admin in the org that something is waiting on them. Mirrors
 *  PublicDocumentService#_notifyAdmins — fire-and-forget, and a notification
 *  failure must never fail the compose the sender is waiting on.
 *
 *  refTable/refId point at the PROJECT, not at the client_requests row: the
 *  frontend's notification-link map (crm-fe Header.tsx) resolves a notification
 *  to a page, and the requirements tab lives at /projects/:id?tab=client-requests
 *  — there is no standalone page for one request to link to. */
async function notifyApprovers(request, { title, body }) {
  try {
    const users = await db.User.findAll({
      where: { orgId: request.orgId, isActive: true },
      include: [{ model: db.Role, as: 'role' }],
    });
    const recipients = users.filter((u) => isApprover(u) && u.id !== request.sentBy);
    await Promise.all(recipients.map((u) => NotificationService.notify(u.id, request.orgId, {
      type: 'client_request_approval',
      title,
      body,
      refTable: 'projects',
      refId: request.projectId,
    })));
  } catch (err) {
    console.error('[ClientRequestService] Failed to notify approvers:', err.message);
  }
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
 * Composes one requirements form for a client contact and submits it for
 * approval. Takes the whole `user` (not just an id) because whether the send
 * needs a second pair of eyes depends on the composer's role.
 *
 * `fields` is snapshotted onto the row here — a later edit to the template it
 * came from must never change a form already sitting in a client's inbox.
 */
async function send(projectId, orgId, data, user) {
  const userId = user?.id;
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
  const theme = normalizeTheme(data.theme !== undefined ? data.theme : template?.theme);

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

  // The email body is required, not optional as it was before the approval
  // gate: an approver reviewing this is reviewing the words the client will
  // read, and "no message" leaves them nothing to approve.
  const message = String(data.message || template?.defaultMessage || '').trim();
  if (!message) throw badRequest('Write the message the client will see in the email.');

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

  // Always born pending, never `sent` — see the APPROVAL GATE note at the top.
  // sentAt stays null until an approver actually releases it.
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
    message,
    fields,
    theme,
    successMessage: data.successMessage || template?.successMessage || null,
    publicToken,
    status: 'pending_approval',
    dueAt: data.dueAt || null,
    sentBy: userId,
    sentAt: null,
  });

  // An admin composing their own request approves it in the same breath —
  // otherwise a one-admin org would rubber-stamp every one of its own sends.
  if (isApprover(user)) {
    const { emailSent } = await release(request, project, branding, userId);
    return {
      request: await findById(request.id, orgId),
      status: 'sent',
      emailSent,
      formUrl: publicUrl(publicToken),
    };
  }

  notifyApprovers(request, {
    title: `Approval needed: ${subject}`,
    body: `${user?.name || 'A team member'} wants to email ${request.recipientName || recipientEmail} a requirements form for ${project.name}. Nothing has been sent yet.`,
  }).catch(() => {});

  return {
    request: await findById(request.id, orgId),
    status: 'pending_approval',
    emailSent: false,
    formUrl: publicUrl(publicToken),
  };
}

/**
 * The one place the client actually gets emailed. Flips the row to `sent` and
 * stamps the approval trail, then mails the link.
 *
 * The status flip is committed BEFORE the email is attempted and is not rolled
 * back if SMTP fails: the link is live either way and staff can resend or copy
 * it (#remind, formUrl), whereas leaving the row pending after an approver has
 * already approved it would invite a second approval and a duplicate email.
 * `emailSent` is how the caller reports which of the two happened.
 */
async function release(request, project, branding, approverId) {
  await request.update({
    status: 'sent',
    sentAt: new Date(),
    approvedBy: approverId,
    approvedAt: new Date(),
    rejectionReason: null,
  });

  // Awaited rather than fire-and-forget (unlike most side effects here): if
  // SMTP rejects it, the caller needs to know the client never got the link.
  // EmailService.sendMail swallows failures and returns null, so null == failed.
  const sent = await EmailService.sendClientRequestForm({
    to: request.recipientEmail,
    cc: request.ccEmails || [],
    recipientName: request.recipientName,
    brandName: branding?.brandName || 'Your agency',
    logoUrl: branding?.logoUrl || null,
    projectName: project?.name || 'your project',
    subject: request.subject,
    message: request.message,
    formUrl: publicUrl(request.publicToken),
    dueAt: request.dueAt,
    fieldCount: (request.fields || []).length,
  });

  return { emailSent: !!sent };
}

/** Admin releases a pending request: the client is emailed now. Route-gated by
 *  middleware/adminOnly; re-checked here so a non-HTTP caller can't skip it. */
async function approve(id, orgId, user) {
  if (!isApprover(user)) {
    throw Object.assign(new Error('Only an administrator can approve a client request.'), { status: 403 });
  }

  const request = await db.ClientRequest.findOne({ where: { id, orgId } });
  if (!request) throw notFound();
  if (request.status !== 'pending_approval') {
    throw conflict(request.status === 'rejected'
      ? 'This request was rejected — the sender needs to compose a new one.'
      : 'This request is not waiting for approval.');
  }

  const project = await db.Project.findOne({ where: { id: request.projectId, orgId }, attributes: ['id', 'name'] });
  const branding = await db.WhiteLabelConfig.findOne({ where: { orgId } });
  const { emailSent } = await release(request, project, branding, user.id);

  // Tell the composer their form went out. Fire-and-forget — a notification
  // failure must not turn a successful send into an error.
  if (request.sentBy && request.sentBy !== user.id) {
    NotificationService.notify(request.sentBy, orgId, {
      type: 'client_request_approved',
      title: `Approved: ${request.subject}`,
      body: emailSent
        ? `${user.name || 'An admin'} approved your requirements form — it's been emailed to ${request.recipientName || request.recipientEmail}.`
        : `${user.name || 'An admin'} approved your requirements form, but the email could not be sent — share the link manually.`,
      refTable: 'projects',
      refId: request.projectId,
    }).catch(() => {});
  }

  return { request: await findById(id, orgId), emailSent };
}

/** Admin turns a pending request down. Terminal — the composer writes a new one
 *  rather than editing this, so the rejected row stays on the record as history. */
async function reject(id, orgId, user, rawReason) {
  if (!isApprover(user)) {
    throw Object.assign(new Error('Only an administrator can reject a client request.'), { status: 403 });
  }

  const reason = String(rawReason || '').trim();
  if (!reason) throw badRequest('Tell the sender why it was rejected.');

  const request = await db.ClientRequest.findOne({ where: { id, orgId } });
  if (!request) throw notFound();
  if (request.status !== 'pending_approval') {
    throw conflict(request.status === 'sent' || request.status === 'responded'
      ? 'This request has already gone out to the client.'
      : 'This request is not waiting for approval.');
  }

  await request.update({
    status: 'rejected',
    rejectionReason: reason,
    approvedBy: user.id,
    approvedAt: new Date(),
  });

  if (request.sentBy && request.sentBy !== user.id) {
    NotificationService.notify(request.sentBy, orgId, {
      type: 'client_request_rejected',
      title: `Rejected: ${request.subject}`,
      body: `${user.name || 'An admin'} did not approve your requirements form: "${reason}"`,
      refTable: 'projects',
      refId: request.projectId,
    }).catch(() => {});
  }

  return findById(id, orgId);
}

async function listForProject(projectId, orgId, query = {}) {
  const requests = await db.ClientRequest.findAll({
    where: { projectId, orgId, ...activeWhere(db.ClientRequest, query) },
    include: [
      { model: db.User, as: 'sender', attributes: ['id', 'name'] },
      { model: db.User, as: 'approver', attributes: ['id', 'name'] },
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
      { model: db.User, as: 'approver', attributes: ['id', 'name'] },
      { model: db.Contact, as: 'contact', attributes: ['id', 'name', 'email'] },
      { model: db.RequirementFormTemplate, as: 'template', attributes: ['id', 'name'] },
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
    ],
  });
  if (!request) throw notFound();
  return { ...request.toJSON(), formUrl: publicUrl(request.publicToken) };
}

/** Withdraws a request — the public link stops resolving. Also how the composer
 *  pulls back something still sitting in pending_approval. An already-answered
 *  request can't be cancelled: the reply is real history. A rejected one can't
 *  either — it never went anywhere, so there is nothing to withdraw. */
async function cancel(id, orgId) {
  const request = await db.ClientRequest.findOne({ where: { id, orgId } });
  if (!request) throw notFound();
  if (request.status === 'responded') throw conflict('This request has already been answered.');
  if (request.status === 'rejected') throw conflict('This request was rejected and never sent.');
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
  if (request.status !== 'sent') {
    throw conflict(request.status === 'pending_approval'
      ? 'This request is still waiting for an admin to approve it — it hasn\'t been emailed yet.'
      : 'Only a request still awaiting a reply can be resent.');
  }

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
  // `sent`/`responded` are the only states in which this link is real. A
  // pending_approval row already has its token minted, so this — not the
  // absence of a token — is what keeps an unapproved form off the internet if
  // its URL leaks; same for rejected and cancelled. Deliberately the same
  // "no longer available" wording for all four, so the token can't be used to
  // probe which state a request is in.
  if (!['sent', 'responded'].includes(request.status)) throw notFound('This form is no longer available.');
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
    // form renderer that would drift from it. request.theme is the appearance
    // snapshotted at send time (see RequirementFormService#normalizeTheme);
    // effectiveTheme fills in whatever wasn't customized.
    theme: effectiveTheme(request.theme, {
      fallbackHeadline: request.subject,
      fallbackDescription: request.message,
      orgPrimaryColor: request.org?.brand?.primaryColor,
    }),
  };
}

/** Uploads one attachment for a `file`-type question. Scoped by token the same
 *  way as every other public function here, and only allowed while the form
 *  is still fillable — same states loadByToken already gates. The returned
 *  URL is what the client's browser then submits back as that field's answer
 *  (see utils/formFields#validateAnswers's `file` handling). */
async function uploadPublicFile(token, tmpPath, originalName, mimetype, req) {
  checkRateLimit(req?.ip);
  const request = await loadByToken(token);
  if (request.status === 'responded') {
    throw conflict('This form has already been submitted.');
  }
  const stream = fs.createReadStream(tmpPath);
  const result = await MediaService.upload(stream, originalName, mimetype);
  return { url: result.url, name: result.originalName, size: result.size };
}

/** The client's reply. This is what flips the project tab to "Responded". */
async function submitPublic(token, body, req) {
  // Honeypot — see LeadService#submitPublic for why this returns success.
  if (body?._hp) {
    return { success: true, message: 'Thanks — we\'ve received your requirements.' };
  }

  checkRateLimit(req?.ip);
  await CaptchaService.verify(body?.turnstileToken, req?.ip);

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
      refTable: 'projects',
      refId: request.projectId,
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
  approve,
  reject,
  listForProject,
  findById,
  cancel,
  remind,
  recipientOptions,
  getPublicByToken,
  submitPublic,
  uploadPublicFile,
  publicUrl,
};
