const express = require('express');
const { DEFAULT_BRAND_COLOR } = require('../config/constants');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Contact, Client } = require('../models');
const portalAuth = require('../middleware/portalAuth');
const { performAction } = require('../workflow/engine');
const db = require('../models');
const MediaService = require('../services/MediaService');
const EmailService = require('../services/EmailService');
const InvoiceService = require('../services/InvoiceService');
const StripeService = require('../services/StripeService');

const uploadProof = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype) || file.mimetype === 'application/pdf'),
});

// ─── Public branding (no auth required) ──────────────────────────────────────

router.get('/branding', async (req, res, next) => {
  try {
    const config = await db.WhiteLabelConfig.findOne({});
    res.json({
      brandName: config?.brandName || 'Mohsin Designs Project Management',
      primaryColor: config?.primaryColor || DEFAULT_BRAND_COLOR,
      logoUrl: config?.logoUrl || null,
    });
  } catch (e) { next(e); }
});

// ─── Auth (email + one-time code, two steps) ─────────────────────────────────

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CODE_ATTEMPTS = 5;

// Step 1 — request a verification code, emailed to the contact
router.post('/auth/request-code', async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ message: 'Email is required.' });

    const contact = await Contact.findOne({
      where: { email, portalAccess: true },
      include: [{ model: Client, as: 'client' }],
    });
    if (!contact || !contact.client) {
      return res.status(401).json({ message: 'No portal access for this email.' });
    }

    // Generate a 6-digit code, store only its hash
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 10);
    await contact.update({
      loginCodeHash: codeHash,
      loginCodeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
      loginCodeAttempts: 0,
    });

    const brandingConfig = await db.WhiteLabelConfig.findOne({ where: { orgId: contact.client.orgId } });
    const brandName = brandingConfig?.brandName || 'Mohsin Designs Project Management';
    EmailService.sendPortalLoginCode(contact.email, contact.name, brandName, code).catch(() => {});

    res.json({ message: 'A verification code has been sent to your email.' });
  } catch (e) { next(e); }
});

// Step 2 — verify the code and issue the portal token
router.post('/auth/verify', async (req, res, next) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const code = String(req.body.code || '').trim();
    if (!email || !code) return res.status(400).json({ message: 'Email and code are required.' });

    const contact = await Contact.findOne({
      where: { email, portalAccess: true },
      include: [{ model: Client, as: 'client' }],
    });
    if (!contact || !contact.client || !contact.loginCodeHash) {
      return res.status(401).json({ message: 'Invalid or expired code. Please request a new one.' });
    }

    // Expired?
    if (!contact.loginCodeExpiresAt || new Date(contact.loginCodeExpiresAt) < new Date()) {
      await contact.update({ loginCodeHash: null, loginCodeExpiresAt: null, loginCodeAttempts: 0 });
      return res.status(401).json({ message: 'Your code has expired. Please request a new one.' });
    }

    // Too many wrong attempts?
    if ((contact.loginCodeAttempts || 0) >= MAX_CODE_ATTEMPTS) {
      await contact.update({ loginCodeHash: null, loginCodeExpiresAt: null, loginCodeAttempts: 0 });
      return res.status(429).json({ message: 'Too many incorrect attempts. Please request a new code.' });
    }

    const ok = await bcrypt.compare(code, contact.loginCodeHash);
    if (!ok) {
      await contact.update({ loginCodeAttempts: (contact.loginCodeAttempts || 0) + 1 });
      return res.status(401).json({ message: 'Incorrect code. Please try again.' });
    }

    // Success — consume the code so it can't be reused
    await contact.update({ loginCodeHash: null, loginCodeExpiresAt: null, loginCodeAttempts: 0 });

    const token = jwt.sign(
      { sub: contact.id, clientId: contact.clientId, orgId: contact.client.orgId, type: 'portal' },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );

    const brandingConfig = await db.WhiteLabelConfig.findOne({ where: { orgId: contact.client.orgId } });
    const branding = {
      brandName: brandingConfig?.brandName || 'Mohsin Designs Project Management',
      primaryColor: brandingConfig?.primaryColor || DEFAULT_BRAND_COLOR,
      logoUrl: brandingConfig?.logoUrl || null,
    };

    res.json({
      token,
      branding,
      contact: { id: contact.id, name: contact.name, email: contact.email, role: contact.role },
      client: { id: contact.client.id, name: contact.client.name, currency: contact.client.defaultCurrency },
    });
  } catch (e) { next(e); }
});

// All routes below require portal auth
router.use(portalAuth);

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get('/me', async (req, res, next) => {
  try {
    const client = await db.Client.findByPk(req.portalClientId);
    res.json({ contact: req.portalContact, client });
  } catch (e) { next(e); }
});

// ─── Projects ─────────────────────────────────────────────────────────────────

router.get('/projects', async (req, res, next) => {
  try {
    const projects = await db.Project.findAll({
      where: { clientId: req.portalClientId, orgId: req.orgId },
      include: [
        {
          model: db.WorkflowTemplate, as: 'template',
          include: [{ model: db.Stage, as: 'stages', separate: true, order: [['orderIndex', 'ASC']] }],
          attributes: ['id', 'name', 'serviceTypeKey'],
        },
        { model: db.Package, as: 'package', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
    });
    res.json(projects);
  } catch (e) { next(e); }
});

router.get('/projects/:id', async (req, res, next) => {
  try {
    const project = await db.Project.findOne({
      where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId },
      include: [
        {
          model: db.WorkflowTemplate, as: 'template',
          include: [{ model: db.Stage, as: 'stages', separate: true, order: [['orderIndex', 'ASC']] }],
        },
        { model: db.ProjectEvent, as: 'events', order: [['createdAt', 'DESC']], limit: 20, separate: true },
        { model: db.Package, as: 'package', attributes: ['id', 'name'] },
      ],
    });
    if (!project) return res.status(404).json({ message: 'Project not found.' });

    let keywords = [];
    if (project.serviceTypeKey === 'seo') {
      keywords = await db.Keyword.findAll({
        where: { projectId: project.id },
        order: [['createdAt', 'DESC']],
      });
    }

    const artifacts = await db.Artifact.findAll({
      where: { projectId: project.id },
      attributes: ['id', 'stageKey', 'fileUrl', 'fileName', 'mimeType', 'kind', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });

    res.json({ project, keywords, artifacts });
  } catch (e) { next(e); }
});

// ─── Approve / Reject ─────────────────────────────────────────────────────────

router.post('/projects/:id/approve', async (req, res, next) => {
  try {
    const project = await db.Project.findOne({
      where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId },
    });
    if (!project) return res.status(404).json({ message: 'Project not found.' });

    const currentStage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: project.currentStageKey },
    });

    if (!currentStage || currentStage.stageType !== 'approval') {
      return res.status(400).json({ message: 'Current stage is not an approval stage.' });
    }
    if (!currentStage.ownerRoleSlot?.toLowerCase().includes('client')) {
      return res.status(403).json({ message: 'This stage is not awaiting client review. It is handled internally.' });
    }

    // actorUserId must be a User FK (or null) — Contact IDs are not users
    const portalUser = { id: null, role: { key: 'super_admin' }, orgId: req.orgId };
    const result = await performAction({
      user: portalUser,
      project,
      action: 'approve',
      note: req.body.note || 'Approved via client portal',
    });

    res.json(result);
  } catch (e) { next(e); }
});

router.post('/projects/:id/reject', async (req, res, next) => {
  try {
    const project = await db.Project.findOne({
      where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId },
    });
    if (!project) return res.status(404).json({ message: 'Project not found.' });

    const currentStage = await db.Stage.findOne({
      where: { templateId: project.workflowTemplateId, key: project.currentStageKey },
    });

    if (!currentStage || currentStage.stageType !== 'approval') {
      return res.status(400).json({ message: 'Current stage is not an approval stage.' });
    }
    if (!currentStage.ownerRoleSlot?.toLowerCase().includes('client')) {
      return res.status(403).json({ message: 'This stage is not awaiting client review. It is handled internally.' });
    }

    const portalUser = { id: null, role: { key: 'super_admin' }, orgId: req.orgId };
    const result = await performAction({
      user: portalUser,
      project,
      action: 'reject',
      reasonCategory: req.body.reasonCategory || null,
      note: req.body.note || 'Rejected via client portal',
    });

    res.json(result);
  } catch (e) { next(e); }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

router.get('/invoices', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    // Clients only see invoices that have been formally sent — not internal drafts or voided ones
    const invoices = await db.Invoice.findAll({
      where: {
        clientId: req.portalClientId,
        orgId: req.orgId,
        status: { [Op.in]: ['sent', 'overdue', 'payment_review', 'paid'] },
      },
      // Payments come along so the portal can show what's already been settled
      // and only offer the client the balance that is actually still owed.
      include: [
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Payment, as: 'payments', attributes: ['id', 'amount', 'paidAt', 'methodLabel'] },
      ],
      order: [['issuedAt', 'DESC']],
    });
    res.json(invoices);
  } catch (e) { next(e); }
});

router.get('/invoices/:id', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const invoice = await db.Invoice.findOne({
      where: {
        id: req.params.id,
        clientId: req.portalClientId,
        orgId: req.orgId,
        status: { [Op.in]: ['sent', 'overdue', 'payment_review', 'paid'] },
      },
      include: [
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Payment, as: 'payments', attributes: ['id', 'amount', 'paidAt', 'methodLabel'] },
      ],
    });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    res.json(invoice);
  } catch (e) { next(e); }
});

router.get('/invoices/:id/pdf', async (req, res, next) => {
  try {
    const owned = await db.Invoice.findOne({
      where: { id: req.params.id, orgId: req.orgId, clientId: req.portalClientId },
      attributes: ['id', 'number'],
    });
    if (!owned) return res.status(404).json({ message: 'Invoice not found.' });

    const { buffer, invoice } = await InvoiceService.generatePdfBuffer(owned.id, req.orgId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) { next(e); }
});

// ─── Payment methods ──────────────────────────────────────────────────────────

// The options shown in the invoice "Pay with" dropdown. The Stripe row is
// filtered out when Stripe isn't configured, so a half-configured deploy offers
// the client a card button that cannot work.
router.get('/payment-methods', async (req, res, next) => {
  try {
    const methods = await db.PaymentMethod.findAll({
      where: { orgId: req.orgId, isActive: true },
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    const stripeUp = await StripeService.isEnabled(req.orgId);
    res.json(methods
      .filter((m) => m.kind !== 'stripe' || stripeUp)
      .map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        instructions: m.instructions || '',
        requiresProof: m.kind === 'stripe' ? false : m.requiresProof !== false,
      })));
  } catch (e) { next(e); }
});

// Persist the client's method choice on the invoice so numbering/company profile
// can be switched to the method-specific series before payment.
router.post('/invoices/:id/select-payment-method', async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const invoice = await db.Invoice.findOne({
      where: {
        id: req.params.id,
        clientId: req.portalClientId,
        orgId: req.orgId,
        status: { [Op.in]: ['sent', 'overdue', 'payment_review'] },
      },
      attributes: ['id'],
    });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });

    if (!req.body?.paymentMethodId) {
      return res.status(400).json({ message: 'paymentMethodId is required.' });
    }
    const selected = await db.PaymentMethod.findOne({
      where: { id: req.body.paymentMethodId, orgId: req.orgId, isActive: true },
    });
    if (!selected) return res.status(400).json({ message: 'Unknown payment method.' });
    if (selected.kind === 'stripe' && !(await StripeService.isEnabled(req.orgId))) {
      return res.status(503).json({ message: 'Card payments are unavailable. Please choose another payment method.' });
    }

    const configured = await InvoiceService.configurePaymentProfile(invoice.id, req.orgId, {
      paymentMethodId: selected.id,
    });
    res.json({
      id: configured.id,
      number: configured.number,
      preferredPaymentMethodId: configured.preferredPaymentMethodId || null,
    });
  } catch (e) { next(e); }
});

// Start a card payment: creates a real Stripe Invoice and returns its hosted
// payment URL for the portal to redirect to. The invoice is marked paid later,
// by the webhook — never here, since the client hasn't paid anything yet at the
// moment this responds.
router.post('/invoices/:id/pay/stripe', async (req, res, next) => {
  try {
    if (!(await StripeService.isEnabled(req.orgId))) {
      return res.status(503).json({ message: 'Card payments are unavailable. Please choose another payment method.' });
    }

    const invoice = await db.Invoice.findOne({
      where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId },
      attributes: ['id', 'status'],
    });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (!['sent', 'overdue', 'payment_review'].includes(invoice.status)) {
      return res.status(400).json({ message: 'This invoice is not awaiting payment.' });
    }

    let method = await db.PaymentMethod.findOne({
      where: { orgId: req.orgId, kind: 'stripe', isActive: true },
    });
    if (req.body?.paymentMethodId) {
      const selected = await db.PaymentMethod.findOne({
        where: { id: req.body.paymentMethodId, orgId: req.orgId, isActive: true },
      });
      if (selected?.kind !== 'stripe') {
        return res.status(400).json({ message: 'Selected method is not a Stripe card method.' });
      }
      method = selected;
    }
    if (!method) return res.status(400).json({ message: 'Stripe method is not configured.' });

    await InvoiceService.configurePaymentProfile(invoice.id, req.orgId, {
      paymentMethodId: method.id,
    });

    // `amount` (optional) is a part payment — pay some of the balance now and
    // leave the rest outstanding. Omitted means pay the full remaining balance.
    const result = await StripeService.startPayment(invoice.id, req.orgId, {
      method,
      payAmount: req.body?.amount ?? null,
    });
    res.json(result);
  } catch (e) { next(e); }
});

// Client notifies team they've made a payment — sends in-app notification to all admins
router.post('/invoices/:id/paid-notification', uploadProof.single('screenshot'), async (req, res, next) => {
  try {
    const { Op } = require('sequelize');
    const invoice = await db.Invoice.findOne({
      where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId },
    });
    if (!invoice) return res.status(404).json({ message: 'Invoice not found.' });
    if (!['sent', 'overdue'].includes(invoice.status)) {
      return res.status(400).json({ message: 'Invoice is not awaiting payment.' });
    }

    // Which method the client says they used. Validated against the org's own
    // rows rather than trusted from the request, so the label an admin later
    // reads ("Bank Transfer (Pakistan)") is one we actually offer.
    let method = null;
    if (req.body.paymentMethodId) {
      method = await db.PaymentMethod.findOne({
        where: { id: req.body.paymentMethodId, orgId: req.orgId, isActive: true },
      });
      if (!method) return res.status(400).json({ message: 'Unknown payment method.' });
      if (method.kind === 'stripe') {
        return res.status(400).json({ message: 'Card payments are confirmed automatically — no receipt upload needed.' });
      }
      if (method.requiresProof !== false && !req.file) {
        return res.status(400).json({ message: `Please attach your payment receipt for ${method.label}.` });
      }
      await InvoiceService.configurePaymentProfile(invoice.id, req.orgId, {
        paymentMethodId: method.id,
      });
    }

    const client = await db.Client.findByPk(req.portalClientId);
    const ref = (req.body.reference || '').trim();

    let screenshotUrl = null;
    if (req.file) {
      try {
        const result = await MediaService.upload(req.file.buffer, req.file.originalname, req.file.mimetype);
        screenshotUrl = result.url;
        // Non-blocking: persist proof URL on invoice — silently skipped if column not yet created
        db.sequelize.query(
          'UPDATE invoices SET payment_proof_url = :url WHERE id = :id',
          { replacements: { url: screenshotUrl, id: invoice.id }, type: db.sequelize.QueryTypes.UPDATE }
        ).catch(() => {});
      } catch {
        // Media server unavailable — continue without proof URL so notification still sends
      }
    }

    let notifBody = `${client?.name || 'Client'} has notified payment for invoice ${invoice.number}`;
    if (method) notifBody += ` via ${method.label}`;
    if (ref) notifBody += ` — Ref: ${ref}`;
    if (screenshotUrl) notifBody += '. Payment proof attached.';
    else notifBody += '.';

    // Notify all admin/super_admin users AND users with billing.read permission in this org
    const allOrgUsers = await db.User.findAll({
      where: { orgId: req.orgId },
      include: [{ model: db.Role, as: 'role' }],
    });
    const recipients = allOrgUsers.filter((u) =>
      ['super_admin', 'admin'].includes(u.role?.key) ||
      u.role?.permissions?.['billing.read']
    );

    const NotificationService = require('../services/NotificationService');
    await Promise.all(recipients.map((u) =>
      NotificationService.notify(u.id, req.orgId, {
        type: 'payment_notified',
        title: `Payment notification: ${invoice.number}`,
        body: notifBody,
        refTable: 'invoices',
        refId: invoice.id,
      })
    ));

    // Move out of sent/overdue so the portal stops telling the client they're overdue
    // once they've reported paying — it now sits in payment_review until an admin
    // confirms via "Record payment received", which sets it to 'paid'.
    await invoice.update({ status: 'payment_review' });

    res.json({ message: 'Team notified.', screenshotUrl, status: invoice.status });
  } catch (e) { next(e); }
});

// ─── Portal Notifications ─────────────────────────────────────────────────────

router.get('/notifications', async (req, res, next) => {
  try {
    const notifications = await db.PortalNotification.findAll({
      where: { clientId: req.portalClientId, orgId: req.orgId },
      order: [['createdAt', 'DESC']],
      limit: 30,
    });
    res.json(notifications);
  } catch (e) { next(e); }
});

router.patch('/notifications/mark-all-read', async (req, res, next) => {
  try {
    await db.PortalNotification.update(
      { isRead: true },
      { where: { clientId: req.portalClientId, orgId: req.orgId, isRead: false } }
    );
    res.json({ message: 'All marked read.' });
  } catch (e) { next(e); }
});

router.patch('/notifications/:id/read', async (req, res, next) => {
  try {
    await db.PortalNotification.update(
      { isRead: true },
      { where: { id: req.params.id, clientId: req.portalClientId, orgId: req.orgId } }
    );
    res.json({ message: 'Marked read.' });
  } catch (e) { next(e); }
});

module.exports = router;
