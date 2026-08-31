const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const EmailService = require('./EmailService');
const { buildInvoicePdf } = require('./InvoicePdf');
const { resolveEntities } = require('./letterhead');

// Mirrors InvoiceService, simplified: no retainer/package linkage, no
// client.billingMode auto-selection, no merge-onto-open-invoice, no
// SubscriptionService sync — none of that applies to a personal invoice.
// See models/PersonalInvoice.js for why this is a separate table rather than
// a flag on Invoice.

const DEFAULT_INVOICE_NOTES = 'Payment is due by the date shown above. Please reference the invoice number with your payment. For any billing questions, contact us using the details above.';
const DEFAULT_INVOICE_TERMS = 'This invoice covers only the items listed above. Any additional work outside this scope will be billed separately. Please settle payment by the due date to avoid late fees or service interruption.';

const PAYMENT_PROVIDER_LABELS = {
  manual: 'Manual / Cash',
  bank: 'Bank Transfer',
  paddle: 'Paddle',
  payfast: 'PayFast',
  wise: 'Wise',
  payoneer: 'Payoneer',
};

function toAbsoluteHttpUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

class PersonalInvoiceService {
  async _paymentMethodById(orgId, paymentMethodId, { transaction = null } = {}) {
    if (!paymentMethodId) return null;
    return db.PaymentMethod.findOne({
      where: { id: paymentMethodId, orgId },
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
  }

  async _companyById(orgId, companyId, { transaction = null } = {}) {
    if (!companyId) return null;
    return db.Company.findOne({
      where: { id: companyId, orgId },
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
  }

  // Same self-healing overdue check as InvoiceService, on its own table.
  async _healOverdue(rows) {
    const today = new Date().toISOString().split('T')[0];
    const stale = rows.filter((inv) => inv.status === 'sent' && inv.dueAt && inv.dueAt < today);
    if (!stale.length) return;
    await db.PersonalInvoice.update(
      { status: 'overdue' },
      { where: { id: stale.map((inv) => inv.id) } },
    );
    for (const inv of stale) inv.status = 'overdue';
  }

  async list(orgId, filters = {}) {
    const page = Math.max(1, parseInt(filters.page) || 1);
    const limit = Math.min(100, parseInt(filters.limit) || 25);
    const offset = (page - 1) * limit;

    const where = { orgId };
    if (filters.contactId) where.contactId = filters.contactId;
    if (filters.status) {
      where.status = filters.status;
    } else if (filters.excludeVoid === 'true' || filters.excludeVoid === true) {
      where.status = { [Op.ne]: INVOICE_STATUS.VOID };
    }
    if (filters.month) {
      const [year, m] = filters.month.split('-');
      const daysInMonth = new Date(parseInt(year, 10), parseInt(m, 10), 0).getDate();
      where.dueAt = { [Op.between]: [`${year}-${m}-01`, `${year}-${m}-${String(daysInMonth).padStart(2, '0')}`] };
    }

    if (filters.search) {
      const matchingContacts = await db.PersonalContact.findAll({
        where: { orgId, name: { [Op.like]: `%${filters.search}%` } },
        attributes: ['id'],
      });
      const contactIds = matchingContacts.map((c) => c.id);
      where[Op.or] = [
        { number: { [Op.like]: `%${filters.search}%` } },
        ...(contactIds.length ? [{ contactId: { [Op.in]: contactIds } }] : []),
      ];
    }

    const { count, rows } = await db.PersonalInvoice.findAndCountAll({
      where,
      include: [
        { model: db.PersonalContact, as: 'contact', attributes: ['id', 'name'] },
        { model: db.PersonalInvoiceLine, as: 'lines', separate: true },
        { model: db.PersonalPayment, as: 'payments', separate: true, attributes: ['id', 'amount', 'paidAt', 'provider'] },
      ],
      order: [['issuedAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });

    await this._healOverdue(rows);

    for (const inv of rows) {
      const paid = (inv.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      const total = parseFloat(inv.total) || 0;
      inv.dataValues.amountPaid = Math.round(paid * 100) / 100;
      inv.dataValues.amountDue = Math.max(0, Math.round((total - paid) * 100) / 100);
    }

    return { data: rows, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  async findById(id, orgId) {
    const invoice = await db.PersonalInvoice.findOne({
      where: { id, orgId },
      include: [
        { model: db.PersonalContact, as: 'contact' },
        { model: db.PersonalInvoiceLine, as: 'lines' },
        { model: db.PersonalPayment, as: 'payments' },
        { model: db.PaymentMethod, as: 'preferredPaymentMethod', attributes: ['id', 'kind', 'provider', 'label'] },
        { model: db.Company, as: 'company', attributes: ['id', 'legalName', 'code'] },
      ],
    });
    if (!invoice) {
      const err = new Error('Personal invoice not found.');
      err.status = 404;
      throw err;
    }
    await this._healOverdue([invoice]);
    return invoice;
  }

  async generatePdfBuffer(id, orgId) {
    const invoice = await db.PersonalInvoice.findOne({
      where: { id, orgId },
      include: [
        { model: db.PersonalContact, as: 'contact' },
        { model: db.PersonalInvoiceLine, as: 'lines' },
        { model: db.PersonalPayment, as: 'payments' },
        { model: db.PaymentMethod, as: 'preferredPaymentMethod', attributes: ['id', 'kind', 'provider', 'label'] },
      ],
    });
    if (!invoice) {
      const err = new Error('Personal invoice not found.');
      err.status = 404;
      throw err;
    }

    const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
    // Always the manually-picked company — no LLC/LLP auto-detection, since
    // there's no "official" rail here to infer an entity from.
    let letterhead = { entities: [], legalName: null, note: null, invoiceNotes: null, invoiceTerms: null };
    if (invoice.companyId) {
      const issuer = await db.Company.findOne({ where: { id: invoice.companyId, orgId } });
      if (issuer) letterhead = resolveEntities([issuer], org ? org.toJSON() : null);
    }

    const amountPaid = (invoice.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const total = parseFloat(invoice.total) || 0;
    const amountDue = Math.max(0, total - amountPaid);
    const payUrl = await this._resolveInvoicePayUrl(invoice, orgId);

    const buffer = await buildInvoicePdf({
      number: invoice.number,
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      currency: invoice.currency,
      org: org ? org.toJSON() : null,
      letterhead,
      client: {
        name: invoice.contact?.name,
        billingName: invoice.contact?.billingName || invoice.contact?.name,
        contactEmail: invoice.contact?.contactEmail,
        contactPhone: invoice.contact?.contactPhone,
        billingAddress: invoice.contact?.billingAddress,
      },
      lineItems: (invoice.lines || []).map((l) => ({
        description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
      })),
      subtotal: total,
      total,
      amountPaid,
      amountDue,
      payUrl,
      transactions: (invoice.payments || [])
        .slice()
        .sort((a, b) => String(a.paidAt || '').localeCompare(String(b.paidAt || '')))
        .map((p) => ({
          mode: p.methodLabel || PAYMENT_PROVIDER_LABELS[p.provider] || p.provider || 'Payment',
          date: p.paidAt,
          amount: p.amount,
        })),
      notes: letterhead.invoiceNotes || DEFAULT_INVOICE_NOTES,
      terms: letterhead.invoiceTerms || DEFAULT_INVOICE_TERMS,
      qrUrl: this.publicInvoiceUrl(invoice),
    });

    return {
      buffer, invoice, contactEmail: invoice.contact?.contactEmail || null, payUrl,
    };
  }

  async ensurePublicToken(invoice) {
    if (!invoice) return null;
    if (invoice.publicToken) return invoice.publicToken;
    const token = crypto.randomBytes(32).toString('hex');
    await invoice.update({ publicToken: token });
    return token;
  }

  publicInvoiceUrl(invoice) {
    if (!invoice?.publicToken) return null;
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/personal-invoice/${invoice.publicToken}`;
  }

  async _resolveInvoicePayUrl(invoice, orgId) {
    if (!invoice || invoice.status === INVOICE_STATUS.PAID || invoice.status === INVOICE_STATUS.VOID) {
      return null;
    }
    if (invoice.status === INVOICE_STATUS.DRAFT || invoice.status === 'draft') {
      return null;
    }

    const manualLink = toAbsoluteHttpUrl(invoice.paymentLinkUrl);
    if (manualLink) return manualLink;

    await this.ensurePublicToken(invoice).catch(() => null);
    return this.publicInvoiceUrl(invoice);
  }

  async sendPaymentThankYou(invoice, orgId, { amount, currency, methodLabel } = {}) {
    try {
      const contactEmail = invoice.contact?.contactEmail
        || (await db.PersonalContact.findByPk(invoice.contactId, { attributes: ['contactEmail'] }))?.contactEmail;
      if (!contactEmail) return;
      const contactName = invoice.contact?.name
        || (await db.PersonalContact.findByPk(invoice.contactId, { attributes: ['name'] }))?.name;
      const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
      await EmailService.sendPaymentThankYou({
        to: contactEmail,
        clientName: contactName,
        brandName: org?.brandName || 'Mohsin Designs Project Management',
        logoUrl: org?.logoUrl || null,
        invoiceNumber: invoice.number,
        amount: amount != null ? amount : invoice.total,
        currency: currency || invoice.currency,
        methodLabel,
        portalUrl: this.publicInvoiceUrl(invoice),
      });
    } catch (err) {
      console.error('[PersonalInvoiceService] Failed to send payment thank-you email:', err.message);
    }
  }

  async _emailInvoiceToClient(id, orgId) {
    try {
      const {
        buffer, invoice, contactEmail, payUrl,
      } = await this.generatePdfBuffer(id, orgId);
      if (!contactEmail) {
        console.warn(`[PersonalInvoiceService] Invoice ${invoice.number} sent but the contact has no email on file — skipping email.`);
        return;
      }
      const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
      await EmailService.sendInvoiceEmail({
        to: contactEmail,
        clientName: invoice.contact?.name,
        brandName: org?.brandName || 'Mohsin Designs Project Management',
        invoiceNumber: invoice.number,
        amountDue: Math.max(0, (parseFloat(invoice.total) || 0)),
        currency: invoice.currency,
        dueAt: invoice.dueAt,
        portalUrl: this.publicInvoiceUrl(invoice),
        payUrl,
        attachmentBuffer: buffer,
        attachmentName: `${invoice.number}.pdf`,
      });
    } catch (err) {
      console.error('[PersonalInvoiceService] Failed to email invoice PDF:', err.message);
    }
  }

  async _nextNumber(orgId, { transaction = null, company = null } = {}) {
    if (!company) {
      const last = await db.PersonalInvoice.findOne({
        where: { orgId, number: { [Op.like]: 'PINV-%' } },
        order: [['number', 'DESC']],
        attributes: ['number'],
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined,
      });
      if (!last) return 'PINV-0001';
      const n = parseInt((last.number || '').replace(/\D/g, ''), 10) || 0;
      return `PINV-${String(n + 1).padStart(4, '0')}`;
    }
    // New docType key -> its own isolated DocumentSequence counter, no
    // collision risk against the official INV/INVS/INVM series.
    return db.DocumentSequence.next({
      orgId,
      companyCode: company.code,
      docType: 'PINV',
      transaction,
    });
  }

  async resolveAllowPartialPayment(orgId, requested) {
    if (requested !== undefined && requested !== null && requested !== '') {
      return requested === true || requested === 'true' || requested === 1 || requested === '1';
    }
    return false;
  }

  async create(orgId, data) {
    if (!data.contactId) {
      const err = new Error('A contact is required.');
      err.status = 400;
      throw err;
    }
    const contact = await db.PersonalContact.findOne({ where: { id: data.contactId, orgId } });
    if (!contact) {
      const err = new Error('Unknown contact.');
      err.status = 400;
      throw err;
    }

    const lines = (data.lines || []).map((l) => ({
      id: uuidv4(),
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: Number(l.qty) * Number(l.unitPrice),
    }));
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const status = data.status || INVOICE_STATUS.DRAFT;
    const issuedAt = toDateOnly(data.issuedAt) || toDateOnly(new Date());
    const dueAt = toDateOnly(data.dueAt) || issuedAt;
    const allowPartialPayment = await this.resolveAllowPartialPayment(orgId, data.allowPartialPayment);

    const company = await this._companyById(orgId, data.companyId).catch(() => null);
    const preferredMethod = await this._paymentMethodById(orgId, data.preferredPaymentMethodId).catch(() => null);

    const invoice = await db.sequelize.transaction(async (t) => {
      const number = await this._nextNumber(orgId, { transaction: t, company });

      const created = await db.PersonalInvoice.create({
        id: uuidv4(),
        orgId,
        contactId: data.contactId,
        companyId: company?.id || null,
        preferredPaymentMethodId: preferredMethod?.id || null,
        paymentLinkUrl: toAbsoluteHttpUrl(data.paymentLinkUrl) || null,
        allowPartialPayment,
        number,
        currency: data.currency || contact.defaultCurrency || 'USD',
        status,
        issuedAt,
        dueAt,
        total,
        notes: data.notes,
      }, { transaction: t });

      if (lines.length > 0) {
        await db.PersonalInvoiceLine.bulkCreate(
          lines.map((l) => ({ ...l, personalInvoiceId: created.id })),
          { transaction: t },
        );
      }

      return created;
    });

    if (status === INVOICE_STATUS.SENT || status === 'sent') {
      await this.ensurePublicToken(invoice).catch(() => {});
      this._emailInvoiceToClient(invoice.id, orgId);
    }

    return invoice;
  }

  async update(id, orgId, data) {
    const invoice = await db.PersonalInvoice.findOne({ where: { id, orgId } });
    if (!invoice) {
      const err = new Error('Personal invoice not found.');
      err.status = 404;
      throw err;
    }
    if (invoice.status !== INVOICE_STATUS.DRAFT) {
      const err = new Error('Only draft invoices can be edited.');
      err.status = 400;
      throw err;
    }

    if (data.contactId) {
      const contact = await db.PersonalContact.findOne({ where: { id: data.contactId, orgId } });
      if (!contact) {
        const err = new Error('Unknown contact.');
        err.status = 400;
        throw err;
      }
    }

    const company = data.companyId !== undefined
      ? await this._companyById(orgId, data.companyId).catch(() => null)
      : null;

    const lines = (data.lines || []).map((l) => ({
      id: uuidv4(),
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: Number(l.qty) * Number(l.unitPrice),
    }));
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const issuedAt = toDateOnly(data.issuedAt) || invoice.issuedAt;
    const dueAt = toDateOnly(data.dueAt) || issuedAt;

    await db.sequelize.transaction(async (t) => {
      await db.PersonalInvoiceLine.destroy({ where: { personalInvoiceId: id }, transaction: t });
      if (lines.length > 0) {
        await db.PersonalInvoiceLine.bulkCreate(
          lines.map((l) => ({ ...l, personalInvoiceId: id })),
          { transaction: t },
        );
      }
      await invoice.update({
        contactId: data.contactId || invoice.contactId,
        companyId: data.companyId !== undefined ? (company?.id || null) : invoice.companyId,
        currency: data.currency || invoice.currency,
        issuedAt,
        dueAt,
        total,
        notes: data.notes !== undefined ? data.notes : invoice.notes,
        allowPartialPayment: data.allowPartialPayment !== undefined
          ? await this.resolveAllowPartialPayment(orgId, data.allowPartialPayment)
          : invoice.allowPartialPayment,
      }, { transaction: t });
    });

    return this.findById(id, orgId);
  }

  async updateStatus(id, orgId, status) {
    const invoice = await this.findById(id, orgId);
    if (invoice.status === INVOICE_STATUS.VOID) {
      const err = new Error('Cannot update a void invoice.');
      err.status = 400;
      throw err;
    }
    await invoice.update({ status });

    if (status === INVOICE_STATUS.SENT) {
      await this.ensurePublicToken(invoice).catch((err) => {
        console.error('[PersonalInvoiceService] Could not mint public invoice token:', err.message);
      });
      await this._resolveInvoicePayUrl(invoice, orgId).catch(() => null);
      this._emailInvoiceToClient(invoice.id, orgId);
    }

    return invoice;
  }

  async bulkVoid(orgId, ids) {
    const idList = Array.isArray(ids) ? [...new Set(ids.filter(Boolean))] : [];
    if (!idList.length) {
      const err = new Error('No invoice IDs provided.');
      err.status = 400;
      throw err;
    }
    if (idList.length > 100) {
      const err = new Error('You can void at most 100 invoices at a time.');
      err.status = 400;
      throw err;
    }

    const VOIDABLE = new Set([
      INVOICE_STATUS.DRAFT, INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, INVOICE_STATUS.PAYMENT_REVIEW,
    ]);

    const invoices = await db.PersonalInvoice.findAll({
      where: { id: idList, orgId },
      attributes: ['id', 'number', 'status'],
    });

    const foundIds = new Set(invoices.map((inv) => inv.id));
    const voided = [];
    const skipped = [];

    for (const id of idList) {
      if (!foundIds.has(id)) skipped.push({ id, reason: 'not_found' });
    }
    for (const inv of invoices) {
      if (!VOIDABLE.has(inv.status)) {
        skipped.push({ id: inv.id, number: inv.number, reason: inv.status === INVOICE_STATUS.VOID ? 'already_void' : 'not_voidable', status: inv.status });
        continue;
      }
      voided.push(inv.id);
    }

    if (voided.length) {
      await db.PersonalInvoice.update({ status: INVOICE_STATUS.VOID }, { where: { id: voided, orgId } });
    }

    return { voided: voided.length, skipped };
  }

  async configurePaymentProfile(id, orgId, {
    paymentMethodId = null,
    paymentLinkUrl,
    allowPartialPayment,
    companyId,
    renumber = true,
  } = {}) {
    const invoice = await db.PersonalInvoice.findOne({
      where: { id, orgId },
      include: [{ model: db.PersonalPayment, as: 'payments', attributes: ['id'] }],
    });
    if (!invoice) {
      const err = new Error('Personal invoice not found.');
      err.status = 404;
      throw err;
    }
    if (invoice.status === INVOICE_STATUS.PAID || invoice.status === INVOICE_STATUS.VOID) {
      const err = new Error('This invoice can no longer be reconfigured.');
      err.status = 400;
      throw err;
    }

    const hasSettlements = (invoice.payments || []).length > 0;
    if (hasSettlements) renumber = false;

    await db.sequelize.transaction(async (t) => {
      const locked = await db.PersonalInvoice.findOne({ where: { id, orgId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!locked) {
        const err = new Error('Personal invoice not found.');
        err.status = 404;
        throw err;
      }

      const method = paymentMethodId
        ? await this._paymentMethodById(orgId, paymentMethodId, { transaction: t })
        : null;
      if (paymentMethodId && !method) {
        const err = new Error('Unknown payment method.');
        err.status = 400;
        throw err;
      }
      if (method?.kind === 'stripe') {
        const err = new Error('Stripe is not available for personal invoices.');
        err.status = 400;
        throw err;
      }

      const nextCompany = companyId !== undefined
        ? await this._companyById(orgId, companyId, { transaction: t })
        : (locked.companyId ? await db.Company.findOne({ where: { id: locked.companyId, orgId }, transaction: t }) : null);
      if (companyId && !nextCompany) {
        const err = new Error('Unknown company.');
        err.status = 400;
        throw err;
      }

      const updates = {};
      if (paymentMethodId !== undefined) updates.preferredPaymentMethodId = method?.id || null;
      if (paymentLinkUrl !== undefined) updates.paymentLinkUrl = toAbsoluteHttpUrl(paymentLinkUrl) || null;
      if (allowPartialPayment !== undefined) {
        updates.allowPartialPayment = allowPartialPayment === true || allowPartialPayment === 'true' || allowPartialPayment === 1;
      }

      const companyChanged = companyId !== undefined && locked.companyId !== (nextCompany?.id || null);
      if (companyChanged && renumber && nextCompany) {
        updates.number = await this._nextNumber(orgId, { transaction: t, company: nextCompany });
        updates.companyId = nextCompany.id;
      } else if (companyChanged) {
        updates.companyId = nextCompany?.id || null;
      }

      if (Object.keys(updates).length) await locked.update(updates, { transaction: t });
    });

    return this.findById(id, orgId);
  }

  async settlementFor(invoiceId, { total = null } = {}) {
    const rows = await db.PersonalPayment.findAll({ where: { personalInvoiceId: invoiceId }, attributes: ['amount'] });
    const paid = Math.round(rows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100) / 100;
    const invoiceTotal = total != null
      ? Number(total) || 0
      : Number((await db.PersonalInvoice.findByPk(invoiceId, { attributes: ['total'] }))?.total) || 0;
    const due = Math.round(Math.max(0, invoiceTotal - paid) * 100) / 100;
    return { total: invoiceTotal, amountPaid: paid, amountDue: due, isFullySettled: due <= 0.005 };
  }

  async recordPayment(id, orgId, data) {
    const invoice = await this.findById(id, orgId);
    const amount = Math.round((parseFloat(data.amount) || 0) * 100) / 100;
    if (!(amount > 0)) {
      const err = new Error('A payment amount greater than zero is required.');
      err.status = 400;
      throw err;
    }
    const payment = await db.PersonalPayment.create({
      id: uuidv4(),
      personalInvoiceId: invoice.id,
      provider: data.provider || 'manual',
      providerRef: data.providerRef,
      amount,
      methodLabel: data.methodLabel || null,
      paidAt: data.paidAt || new Date(),
    });

    const settlement = await this.settlementFor(invoice.id, { total: invoice.total });
    if (settlement.isFullySettled) {
      await invoice.update({ status: INVOICE_STATUS.PAID });
      this.sendPaymentThankYou(invoice, orgId, {
        amount: settlement.amountPaid,
        methodLabel: data.methodLabel || PAYMENT_PROVIDER_LABELS[data.provider] || null,
      }).catch(() => {});
    } else {
      const stillOpen = invoice.dueAt && invoice.dueAt < new Date().toISOString().split('T')[0]
        ? INVOICE_STATUS.OVERDUE
        : INVOICE_STATUS.SENT;
      if (invoice.status !== stillOpen) await invoice.update({ status: stillOpen });
    }

    return payment;
  }
}

module.exports = new PersonalInvoiceService();
