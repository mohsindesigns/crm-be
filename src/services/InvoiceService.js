const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const SubscriptionService = require('./SubscriptionService');
const PortalNotificationService = require('./PortalNotificationService');
const EmailService = require('./EmailService');
const { buildInvoicePdf } = require('./InvoicePdf');
const { letterheadForOrg, resolveEntities, billingCompanyFor } = require('./letterhead');

// Shown on every invoice PDF when the org hasn't set its own text under Admin →
// Branding → Invoice Notes & Terms — an invoice should never go out with a
// blank Terms & Conditions section just because nobody has configured one yet.
const DEFAULT_INVOICE_NOTES = 'Payment is due by the date shown above. Please reference the invoice number with your payment. For any billing questions, contact us using the details above.';
const DEFAULT_INVOICE_TERMS = 'This invoice covers only the items listed above. Any additional work outside this scope will be billed separately. Please settle payment by the due date to avoid late fees or service interruption.';

/** Bare domains like "pay.example.com" must become absolute or PDF/browser treat them as relative paths. */
function toAbsoluteHttpUrl(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// Human-readable Payment.provider values for the invoice PDF's Transactions block.
const PAYMENT_PROVIDER_LABELS = {
  manual: 'Manual / Cash',
  bank: 'Bank Transfer',
  stripe: 'Stripe: Credit/Debit Card',
  paddle: 'Paddle',
  payfast: 'PayFast',
  wise: 'Wise',
  payoneer: 'Payoneer',
};

function toDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

class InvoiceService {
  /**
   * There are exactly two invoice series, and which one an invoice lands on is
   * decided by one thing: whether it is being collected through Stripe.
   *
   *   INVS — Stripe ("Pay via CRM" clients)
   *   INVM — everything else: bank transfer, Payoneer, Wise, cash, no method set
   *
   * A missing method is NOT a third case. It used to fall through to a bare 'INV'
   * series, which is why some invoices ended up with neither prefix.
   */
  _invoiceDocTypeForMethod(method) {
    return method?.kind === 'stripe' ? 'INVS' : 'INVM';
  }

  /**
   * The legal entity that issues the invoice. Hard rule, deliberately NOT
   * configurable:
   *
   *   Stripe  → the LLC
   *   Anything else (bank, Payoneer, Wise, cash, no method) → the LLP
   *
   * Matched on the entity type in the company's own legal name, and read from
   * every active company rather than `Company.forCategory`. Both of those are on
   * purpose: this used to pick "the primary billing company" for Stripe and "any
   * other one" for manual, which meant a toggle in Admin → Companies — the
   * Primary star, or unticking "Use for invoices & quotations" — silently moved
   * invoices onto the wrong legal entity. That is a tax-reporting problem, not a
   * preference, so settings must not be able to reach it.
   *
   * The company that issues an invoice also supplies its number prefix, so this
   * and `_invoiceDocTypeForMethod` always agree: LLC+INVS, or LLP+INVM.
   */
  async _resolveBillingCompanyForMethod(orgId, method, { transaction = null } = {}) {
    // One implementation, shared with quotations — see letterhead.billingCompanyFor.
    return billingCompanyFor(orgId, method?.kind === 'stripe', { transaction });
  }

  async _paymentMethodById(orgId, paymentMethodId, { transaction = null } = {}) {
    if (!paymentMethodId) return null;
    return db.PaymentMethod.findOne({
      where: { id: paymentMethodId, orgId },
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });
  }

  /**
   * The rail a client is set up to pay on (Admin → Client → Contacts → "How this
   * client pays"). Only clients switched to `stripe` get one; everyone else keeps
   * the manual flow, where the method is chosen per invoice in the portal.
   *
   * Returning the Stripe method here is what makes an invoice raised for that
   * client land on the card series with a live pay link, without an admin having
   * to remember to set it invoice by invoice.
   */
  async _defaultPaymentMethodForClient(orgId, clientId) {
    if (!clientId) return null;
    const client = await db.Client.findOne({
      where: { id: clientId, orgId },
      attributes: ['id', 'billingMode'],
    });
    if (client?.billingMode !== 'stripe') return null;
    return db.PaymentMethod.findOne({ where: { orgId, kind: 'stripe', isActive: true } });
  }

  /**
   * Point every still-payable invoice of a client at their newly-chosen rail.
   *
   * Drafts are reconfigured in full (number included — nobody has seen them yet).
   * Invoices already sent keep their number: the client is holding a PDF quoting
   * it, and silently renumbering that is how payments end up unmatchable. They
   * still gain the new pay link, which is the part that actually matters.
   * Invoices with payments against them are left completely alone.
   */
  async applyClientBillingMode(orgId, clientId, billingMode) {
    const method = billingMode === 'stripe'
      ? await db.PaymentMethod.findOne({ where: { orgId, kind: 'stripe', isActive: true } })
      : null;
    if (billingMode === 'stripe' && !method) {
      const err = new Error('No active Stripe payment method is configured — set one up in Admin → Payments first.');
      err.status = 400;
      throw err;
    }

    const invoices = await db.Invoice.findAll({
      where: {
        orgId,
        clientId,
        status: { [Op.in]: [INVOICE_STATUS.DRAFT, INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, 'draft', 'sent', 'overdue'] },
      },
      include: [{ model: db.Payment, as: 'payments', attributes: ['id'] }],
      attributes: ['id', 'status'],
    });

    let updated = 0;
    for (const invoice of invoices) {
      if ((invoice.payments || []).length) continue;
      const isDraft = invoice.status === INVOICE_STATUS.DRAFT || invoice.status === 'draft';
      try {
        // Passing null for manual is deliberate: it clears the card rail so the
        // portal offers the normal method picker again, and moves the invoice
        // onto the manual series/entity — the same path Stripe takes, just the
        // other way.
        await this.configurePaymentProfile(invoice.id, orgId, {
          paymentMethodId: method ? method.id : null,
          renumber: isDraft,
        });
        updated += 1;
      } catch (err) {
        console.error(`[InvoiceService] Could not switch invoice ${invoice.id} to ${billingMode}:`, err.message);
      }
    }
    return { updated };
  }

  // Self-healing overdue check, run on every read — the batch job in
  // RetainerScheduler sweeps this too, but that's a periodic background pass
  // (every 6h) that depends on the scheduler process actually being up. Reading
  // an invoice list/detail is the moment a human actually looks at the status,
  // so it's also the moment to guarantee it's correct rather than trusting a
  // job that may not have ticked yet. Mutates the in-memory rows AND persists
  // the fix in one batched query, so both this response and the next read agree.
  async _healOverdue(rows) {
    const today = new Date().toISOString().split('T')[0];
    const stale = rows.filter((inv) => inv.status === 'sent' && inv.dueAt && inv.dueAt < today);
    if (!stale.length) return;
    await db.Invoice.update(
      { status: 'overdue' },
      { where: { id: stale.map((inv) => inv.id) } }
    );
    for (const inv of stale) inv.status = 'overdue';
  }

  async list(orgId, filters = {}) {
    const page  = Math.max(1, parseInt(filters.page)  || 1);
    const limit = Math.min(100, parseInt(filters.limit) || 25);
    const offset = (page - 1) * limit;

    const where = { orgId };
    if (filters.clientId) where.clientId = filters.clientId;
    if (filters.status) {
      where.status = filters.status;
    } else if (filters.excludeVoid === 'true' || filters.excludeVoid === true) {
      // Only applied when no explicit status filter is set — picking a specific
      // status (including "Void" itself) always takes precedence over the
      // "hide void" checkbox.
      where.status = { [Op.ne]: INVOICE_STATUS.VOID };
    }
    /**
     * `rail=stripe|manual` — which payment rail the invoice was issued on.
     *
     * Matched on the number series rather than the linked payment method,
     * because the series is what's printed on the document the client holds and
     * it never changes once issued, whereas the method can be reconfigured
     * later. "manual" is defined as NOT-Stripe rather than "is INVM", so legacy
     * invoices numbered before the two-series split still appear under it
     * instead of vanishing from both filters.
     */
    if (filters.rail === 'stripe') {
      where.number = { [Op.like]: '%-INVS-%' };
    } else if (filters.rail === 'manual') {
      where.number = { [Op.notLike]: '%-INVS-%' };
    }
    if (filters.month) {
      const [year, m] = filters.month.split('-');
      const daysInMonth = new Date(parseInt(year, 10), parseInt(m, 10), 0).getDate();
      where.dueAt = { [Op.between]: [`${year}-${m}-01`, `${year}-${m}-${String(daysInMonth).padStart(2, '0')}`] };
    }
    if (filters.dueBefore || filters.dueAfter) {
      where.dueAt = where.dueAt || {};
      if (filters.dueBefore) where.dueAt[Op.lte] = filters.dueBefore;
      if (filters.dueAfter) where.dueAt[Op.gte] = filters.dueAfter;
    }

    if (filters.search) {
      const matchingClients = await db.Client.findAll({
        where: { orgId, name: { [Op.like]: `%${filters.search}%` } },
        attributes: ['id'],
      });
      const clientIds = matchingClients.map((c) => c.id);
      where[Op.or] = [
        { number: { [Op.like]: `%${filters.search}%` } },
        ...(clientIds.length ? [{ clientId: { [Op.in]: clientIds } }] : []),
      ];
    }

    const { count, rows } = await db.Invoice.findAndCountAll({
      where,
      include: [
        { model: db.Client, as: 'client', attributes: ['id', 'name'] },
        { model: db.InvoiceLine, as: 'lines', separate: true },
        // `separate` so multiple payments can't fan out and multiply the row.
        { model: db.Payment, as: 'payments', separate: true, attributes: ['id', 'amount', 'paidAt', 'provider'] },
      ],
      order: [['issuedAt', 'DESC']],
      limit,
      offset,
      distinct: true,
    });

    await this._healOverdue(rows);

    // A part-paid invoice's `total` is NOT what the client still owes, and every
    // consumer of this list (Billing dashboard, Clients "Outstanding") was
    // reading `total` and so overstating the debt. Expose the settled figures so
    // nobody has to recompute them — or forget to.
    for (const inv of rows) {
      const paid = (inv.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      const total = parseFloat(inv.total) || 0;
      inv.dataValues.amountPaid = Math.round(paid * 100) / 100;
      inv.dataValues.amountDue = Math.max(0, Math.round((total - paid) * 100) / 100);
    }

    return { data: rows, total: count, page, totalPages: Math.ceil(count / limit) || 1, limit };
  }

  async findById(id, orgId) {
    const invoice = await db.Invoice.findOne({
      where: { id, orgId },
      include: [
        { model: db.Client, as: 'client' },
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Payment, as: 'payments' },
        { model: db.PaymentMethod, as: 'preferredPaymentMethod', attributes: ['id', 'kind', 'provider', 'label'] },
        { model: db.Retainer, as: 'retainer', attributes: ['id', 'cycle'] },
        {
          model: db.ClientPackage, as: 'clientPackage', attributes: ['id', 'billingCycle'],
          include: [{ model: db.Package, as: 'package', attributes: ['id', 'isRecurring', 'billingCycle'] }],
        },
      ],
    });
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    await this._healOverdue([invoice]);
    await this._reconcileWithStripe(invoice);

    // payment_proof_url is not in the Sequelize model (added via ALTER TABLE at startup).
    // setDataValue attaches it to the instance so it appears in JSON responses
    // while keeping the instance as a Sequelize model (so .update() still works).
    try {
      const [rows] = await db.sequelize.query(
        'SELECT payment_proof_url FROM invoices WHERE id = :id',
        { replacements: { id }, type: db.sequelize.QueryTypes.SELECT }
      );
      invoice.setDataValue('paymentProofUrl', rows?.payment_proof_url || null);
    } catch { /* column not yet created — skip */ }

    return invoice;
  }

  async generatePdfBuffer(id, orgId) {
    const invoice = await db.Invoice.findOne({
      where: { id, orgId },
      include: [
        { model: db.Client, as: 'client', include: [{ model: db.Contact, as: 'contacts' }] },
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Payment, as: 'payments' },
        { model: db.ClientPackage, as: 'clientPackage', include: [{ model: db.Package, as: 'package' }] },
        {
          model: db.Retainer, as: 'retainer',
          include: [{ model: db.ClientPackage, as: 'clientPackage', include: [{ model: db.Package, as: 'package' }] }],
        },
        {
          model: db.PaymentMethod,
          as: 'preferredPaymentMethod',
          attributes: ['id', 'kind', 'provider', 'label'],
        },
      ],
    });
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }

    const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
    // Which legal entity (or entities) appear on this invoice's letterhead is
    // decided by the "Use for invoices & quotations" checkbox in Admin →
    // Companies, not per-invoice. With nothing ticked this falls back to the
    // legacy branding letterhead, so behaviour is unchanged for orgs that never
    // configure companies.
    let letterhead = await letterheadForOrg(orgId, 'billing');
    if (invoice.companyId) {
      const issuer = await db.Company.findOne({ where: { id: invoice.companyId, orgId } });
      if (issuer) {
        letterhead = resolveEntities([issuer], org ? org.toJSON() : null);
      }
    }
    const activeContacts = (invoice.client?.contacts || []).filter((c) => c.isActive !== false);

    // What PRINTS in Bill To and where the invoice gets EMAILED are two separate
    // questions, and conflating them was wrong: falling back to "any contact"
    // for the PDF meant a contact nobody had ticked still had their name, phone
    // and address printed on the invoice. The tickbox is the opt-in — with none
    // ticked, Bill To shows the client name alone.
    const billingContact = activeContacts.find((c) => c.useForInvoice) || null;

    // Delivery keeps its fallback chain, so an invoice still reaches the client
    // even when no billing contact has been nominated yet.
    const emailContact = billingContact
      || activeContacts.find((c) => c.portalAccess)
      || activeContacts[0]
      || null;

    const amountPaid = (invoice.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const total = parseFloat(invoice.total) || 0;
    const amountDue = Math.max(0, total - amountPaid);
    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const payUrl = await this._resolveInvoicePayUrl(invoice, orgId);

    const buffer = await buildInvoicePdf({
      number: invoice.number,
      status: invoice.status,
      issuedAt: invoice.issuedAt,
      dueAt: invoice.dueAt,
      currency: invoice.currency,
      // The whole WhiteLabelConfig row — kept as the fallback for the brand
      // colour and for orgs with no companies configured.
      org: org ? org.toJSON() : null,
      letterhead,
      client: {
        name: invoice.client?.name,
        // The registered business name to bill, when the billing contact
        // records one that differs from the CRM's client name. With no billing
        // contact nominated, every field below is undefined and the PDF prints
        // the client name on its own.
        billingName: billingContact?.businessName || invoice.client?.name,
        contactName: billingContact?.name,
        contactEmail: billingContact?.email,
        contactPhone: billingContact?.phone,
        billingAddress: billingContact?.billingAddress,
        state: billingContact?.state,
      },
      lineItems: (invoice.lines || []).map((l) => ({
        description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
      })),
      subtotal: total,
      total,
      amountPaid,
      amountDue,
      // Clickable "PAY INVOICE" in the PDF header (Payoneer link or Stripe hosted URL).
      payUrl,
      // Payments received against this invoice, printed as the "Transactions"
      // block so a partially-paid invoice shows what was already settled.
      // Method, date and amount only. The provider's transaction id is internal
      // plumbing — it lives on the Payment row for reconciliation and has no
      // place on the document the client reads.
      transactions: (invoice.payments || [])
        .slice()
        .sort((a, b) => String(a.paidAt || '').localeCompare(String(b.paidAt || '')))
        .map((p) => ({
          mode: p.methodLabel || PAYMENT_PROVIDER_LABELS[p.provider] || p.provider || 'Payment',
          date: p.paidAt,
          amount: p.amount,
        })),
      // Issuing entity's own payment/terms copy first — a US LLC invoice and a
      // Pakistan invoice generally quote different payment instructions.
      notes: letterhead.invoiceNotes || org?.invoiceNotes || DEFAULT_INVOICE_NOTES,
      terms: letterhead.invoiceTerms || org?.invoiceTerms || DEFAULT_INVOICE_TERMS,
      // Public page, not the portal — scanning this must work for a client who
      // was never granted portal access, which is most of them.
      qrUrl: this.publicInvoiceUrl(invoice) || `${frontendUrl}/portal/invoices/${invoice.id}`,
    });

    return { buffer, invoice, contactEmail: emailContact?.email || null };
  }

  /**
   * Resolve the live checkout URL embedded next to the status on the PDF:
   * - Manual rails (Payoneer, etc.): admin-supplied paymentLinkUrl
   * - Stripe: create/resume a hosted Stripe Invoice URL automatically
   */
  /**
   * Pull payment state from Stripe when an invoice is opened.
   *
   * The webhook stays the fast path, but it must not be the ONLY path: it needs
   * a publicly reachable URL and STRIPE_WEBHOOK_SECRET, neither of which exists
   * in local dev, and in production a delivery can still fail or arrive late.
   * Without this a card payment clears at Stripe while the admin panel keeps
   * showing the invoice unpaid.
   *
   * Reloads the instance in place so callers see the recorded payment. Cheap to
   * repeat: _markPaidFromStripeInvoice dedupes on the provider reference.
   */
  async _reconcileWithStripe(invoice) {
    if (!invoice?.stripeInvoiceId) return invoice;
    const open = [INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, INVOICE_STATUS.PAYMENT_REVIEW,
      'sent', 'overdue', 'payment_review'];
    if (!open.includes(invoice.status)) return invoice;
    try {
      const StripeService = require('./StripeService');
      await StripeService.syncFromStripe(invoice.id, invoice.orgId);
      await invoice.reload();
    } catch (err) {
      // Stripe unreachable/unconfigured — show stored state rather than 500.
      console.warn(`[InvoiceService] Stripe reconcile skipped for ${invoice.number}:`, err.message);
    }
    return invoice;
  }

  /**
   * Mint the public-page credential the first time an invoice is issued.
   * Idempotent — re-sending keeps the link already in the client's inbox alive.
   */
  async ensurePublicToken(invoice) {
    if (!invoice) return null;
    if (invoice.publicToken) return invoice.publicToken;
    const token = crypto.randomBytes(32).toString('hex');
    await invoice.update({ publicToken: token });
    return token;
  }

  /** Absolute URL of the public invoice page, or null if not issued yet. */
  publicInvoiceUrl(invoice) {
    if (!invoice?.publicToken) return null;
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    return `${base}/invoice/${invoice.publicToken}`;
  }

  async _resolveInvoicePayUrl(invoice, orgId) {
    if (!invoice || invoice.status === INVOICE_STATUS.PAID || invoice.status === INVOICE_STATUS.VOID) {
      return null;
    }
    // A draft has not been issued to anyone, so there is nothing to pay yet.
    if (invoice.status === INVOICE_STATUS.DRAFT || invoice.status === 'draft') {
      return null;
    }

    const method = invoice.preferredPaymentMethod
      || (invoice.preferredPaymentMethodId
        ? await this._paymentMethodById(orgId, invoice.preferredPaymentMethodId).catch(() => null)
        : null);

    const manualLink = toAbsoluteHttpUrl(invoice.paymentLinkUrl);
    if (method?.kind !== 'stripe' && manualLink) {
      return manualLink;
    }

    const isStripe = method?.kind === 'stripe'
      || (!!invoice.stripeHostedUrl && !manualLink);
    if (!isStripe) {
      return manualLink || null;
    }

    // Card invoices link to OUR public page, not straight to Stripe. Going
    // direct locked the client into paying the full balance, because the Stripe
    // invoice has to be created with an amount before they ever see it. The
    // public page asks how much they want to pay first, then builds the Stripe
    // page for that figure (StripeService.startPayment already supports it).
    //
    // Minted on demand, not just at send: invoices issued before the public page
    // existed have no token, and `sent → sent` isn't a legal transition, so they
    // would otherwise stay on a full-amount-only link forever.
    await this.ensurePublicToken(invoice).catch(() => null);
    const publicUrl = this.publicInvoiceUrl(invoice);
    if (publicUrl) return publicUrl;

    // Token couldn't be minted: fall back to the old direct-to-Stripe link so
    // an already-issued invoice keeps a working button.
    if (invoice.stripeHostedUrl) {
      return toAbsoluteHttpUrl(invoice.stripeHostedUrl) || null;
    }
    try {
      const StripeService = require('./StripeService');
      const started = await StripeService.startPayment(invoice.id, orgId, { method });
      return started?.url || null;
    } catch (err) {
      console.warn(
        `[InvoiceService] Could not create Stripe pay link for invoice ${invoice.number}:`,
        err.message || err,
      );
      return null;
    }
  }

  // Generates the PDF and emails it to the client's primary contact — called
  // whenever an invoice transitions into 'sent'. Never throws: a failed email
  // (no SMTP configured, no contact email on file, PDF build error) shouldn't
  // block the status change itself, since the admin can always retry from the
  // invoice detail page's "Download PDF" / resend action.
  async _emailInvoiceToClient(id, orgId) {
    try {
      const { buffer, invoice, contactEmail } = await this.generatePdfBuffer(id, orgId);
      if (!contactEmail) {
        console.warn(`[InvoiceService] Invoice ${invoice.number} sent but client has no contact email on file — skipping email.`);
        return;
      }
      const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
      await EmailService.sendInvoiceEmail({
        to: contactEmail,
        clientName: invoice.client?.name,
        brandName: org?.brandName || 'Mohsin Designs Project Management',
        invoiceNumber: invoice.number,
        amountDue: Math.max(0, (parseFloat(invoice.total) || 0)),
        currency: invoice.currency,
        dueAt: invoice.dueAt,
        // The public invoice page works without portal access; the portal link
        // is only right for a client who actually has an account there.
        portalUrl: this.publicInvoiceUrl(invoice),
        attachmentBuffer: buffer,
        attachmentName: `${invoice.number}.pdf`,
      });
    } catch (err) {
      console.error('[InvoiceService] Failed to email invoice PDF:', err.message);
    }
  }

  /**
   * The next invoice number, as `MDL-INV-26-0001` — issuing company, document
   * type, year, sequence — so the entity and vintage are readable off the
   * number without opening the invoice.
   *
   * When more than one company is ticked for billing, the primary one supplies
   * the prefix: the letterhead can carry two entities but the number can only
   * name one. Orgs with no companies configured keep the legacy `INV-0001`
   * scheme, so nothing renumbers on upgrade.
   *
   * Must be called inside `transaction` when the caller also inserts the
   * invoice, so a rolled-back insert doesn't burn a sequence number.
   */
  /**
   * Re-send an unpaid invoice to the client as a reminder — the same PDF, framed
   * as a nudge, plus a portal notification so it lands in-app as well as by
   * email.
   *
   * Unlike `_emailInvoiceToClient` (which is fire-and-forget behind a status
   * change) this one throws: it is triggered by someone clicking a button and
   * expecting to hear whether it worked.
   */
  async sendReminder(id, orgId) {
    const invoice = await this.findById(id, orgId);

    if (invoice.status === INVOICE_STATUS.PAID || invoice.status === 'paid') {
      const err = new Error('This invoice is already paid — there is nothing to remind about.');
      err.status = 400;
      throw err;
    }
    if (invoice.status === INVOICE_STATUS.VOID || invoice.status === 'void') {
      const err = new Error('This invoice has been voided.');
      err.status = 400;
      throw err;
    }
    if (invoice.status === INVOICE_STATUS.DRAFT || invoice.status === 'draft') {
      const err = new Error('Send the invoice before reminding the client about it.');
      err.status = 400;
      throw err;
    }

    // Before the PDF and email are built, both of which link to the public page.
    // This is also what lets a reminder upgrade an older invoice: the client
    // gets a working link with the part-payment option even though the original
    // send predated it.
    await this.ensurePublicToken(invoice).catch((err) => {
      console.error('[InvoiceService] Could not mint public invoice token:', err.message);
    });

    const { buffer, contactEmail } = await this.generatePdfBuffer(id, orgId);
    if (!contactEmail) {
      const err = new Error('This client has no contact email on file, so there is nowhere to send the reminder.');
      err.status = 400;
      throw err;
    }

    const org = await db.WhiteLabelConfig.findOne({ where: { orgId } });
    const paid = (invoice.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    const amountDue = Math.max(0, (parseFloat(invoice.total) || 0) - paid);
    const isOverdue = invoice.status === INVOICE_STATUS.OVERDUE || invoice.status === 'overdue';

    await EmailService.sendInvoiceEmail({
      to: contactEmail,
      clientName: invoice.client?.name,
      brandName: org?.brandName || 'Mohsin Designs Project Management',
      invoiceNumber: invoice.number,
      amountDue,
      currency: invoice.currency,
      dueAt: invoice.dueAt,
      // The public invoice page works without portal access; the portal link
      // is only right for a client who actually has an account there.
      portalUrl: this.publicInvoiceUrl(invoice),
      attachmentBuffer: buffer,
      attachmentName: `${invoice.number}.pdf`,
      isReminder: true,
      isOverdue,
    });

    PortalNotificationService.notify(invoice.clientId, orgId, {
      type: 'invoice_reminder',
      title: `${isOverdue ? 'Overdue' : 'Reminder'}: ${invoice.number}`,
      body: `Invoice ${invoice.number} for ${invoice.currency || ''} ${amountDue.toFixed(2)} is ${isOverdue ? 'overdue' : `due ${invoice.dueAt || 'soon'}`}.`.replace(/\s+/g, ' ').trim(),
      refTable: 'invoices',
      refId: invoice.id,
    }).catch((err) => console.error('[InvoiceService] reminder portal notify failed:', err.message));

    return { message: `Reminder sent to ${contactEmail}.`, sentTo: contactEmail };
  }

  async _nextNumber(orgId, {
    transaction = null,
    company = null,
    paymentMethod = null,
  } = {}) {
    const issuer = company || await this._resolveBillingCompanyForMethod(orgId, paymentMethod, { transaction }).catch(() => null);
    const docType = this._invoiceDocTypeForMethod(paymentMethod);

    if (!issuer) {
      const last = await db.Invoice.findOne({
        where: { orgId, number: { [Op.like]: 'INV-%' } },
        order: [['number', 'DESC']],
        attributes: ['number'],
        transaction,
        lock: transaction ? transaction.LOCK.UPDATE : undefined,
      });
      if (!last) return 'INV-0001';
      const n = parseInt((last.number || '').replace(/\D/g, ''), 10) || 0;
      return `INV-${String(n + 1).padStart(4, '0')}`;
    }

    return db.DocumentSequence.next({
      orgId,
      companyCode: issuer.code,
      docType,
      transaction,
    });
  }

  // When selling several packages to the same client, fold new line items into
  // an existing unpaid invoice that shares the same due date and currency —
  // one bill with multiple rows instead of one invoice per package. Manual
  // "New Invoice" and per-retainer scheduler bills do not set this flag.
  async _findOpenMergeTarget(orgId, data, { transaction } = {}) {
    const clientId = data.clientId;
    const currency = data.currency || 'USD';
    const dueAt = toDateOnly(data.dueAt) || toDateOnly(data.issuedAt) || toDateOnly(new Date());
    if (!clientId || !dueAt) return null;

    // Lines destined for a draft may only land on a draft. Appending them to an
    // invoice the client has already been sent would change a bill they are
    // holding, without telling them — the whole point of raising it as a draft is
    // that nothing reaches the client until an admin sends it.
    const isDraftLine = data.status === INVOICE_STATUS.DRAFT || data.status === 'draft';
    const mergeableStatuses = isDraftLine
      ? [INVOICE_STATUS.DRAFT, 'draft']
      : [INVOICE_STATUS.DRAFT, INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, 'draft', 'sent', 'overdue'];

    const candidates = await db.Invoice.findAll({
      where: {
        orgId,
        clientId,
        currency,
        dueAt,
        // Don't merge onto a retainer-cycle invoice tracked by retainerId — those
        // stay one-per-retainer for the scheduler's idempotency guard.
        retainerId: null,
        status: { [Op.in]: mergeableStatuses },
      },
      include: [
        { model: db.Payment, as: 'payments', attributes: ['id', 'amount'] },
        { model: db.InvoiceLine, as: 'lines', attributes: ['id'] },
      ],
      order: [['createdAt', 'ASC']],
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });

    for (const inv of candidates) {
      const paid = (inv.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      if (paid > 0) continue;
      return inv;
    }
    return null;
  }

  async _appendLinesToInvoice(invoice, orgId, data, lines, lineTotal) {
    const status = data.status || invoice.status || INVOICE_STATUS.DRAFT;
    const newTotal = Math.round((parseFloat(invoice.total) + lineTotal) * 100) / 100;
    const notes = [invoice.notes, data.notes].filter(Boolean).join('\n');
    // Multi-package bills no longer belong to a single clientPackage row.
    const clearPackage = data.clientPackageId && invoice.clientPackageId
      && data.clientPackageId !== invoice.clientPackageId;

    await db.sequelize.transaction(async (t) => {
      if (lines.length > 0) {
        await db.InvoiceLine.bulkCreate(
          lines.map((l) => ({ ...l, invoiceId: invoice.id })),
          { transaction: t }
        );
      }
      await invoice.update({
        total: newTotal,
        notes: notes || invoice.notes,
        clientPackageId: clearPackage ? null : invoice.clientPackageId,
        // Promote draft → sent when a newly due package line is appended.
        status: (status === INVOICE_STATUS.SENT || status === 'sent')
          && invoice.status === INVOICE_STATUS.DRAFT
          ? INVOICE_STATUS.SENT
          : invoice.status,
      }, { transaction: t });
    });

    await invoice.reload({ include: [{ model: db.InvoiceLine, as: 'lines' }] });

    if (status === INVOICE_STATUS.SENT || status === 'sent') {
      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_sent',
        title: `Invoice updated: ${invoice.number}`,
        body: `Your invoice ${invoice.number} was updated — amount due ${invoice.currency || ''} ${parseFloat(invoice.total).toFixed(2)}`.trim() + '.',
        refTable: 'invoices',
        refId: invoice.id,
      }).catch((err) => {
        console.error('[InvoiceService] portal notify on append failed:', err.message);
      });
      this._emailInvoiceToClient(invoice.id, orgId);
    }

    return invoice;
  }

  // `data.status` lets system callers (RetainerService.autoCreate, RetainerScheduler,
  // installment-plan generation) issue an already-`sent` invoice — they're
  // system-generated recurring/installment bills going straight to the client, not
  // a draft an admin is still preparing. Defaults to DRAFT, preserving today's
  // behavior for the manual "New Invoice" form.
  //
  // `data.mergeWithOpenInvoice` (package sales) appends line items onto an
  // existing unpaid invoice for the same client / currency / due date.
  async create(orgId, data) {
    // A package given away free (or an installment that works out to nothing)
    // has nothing to bill, so it must not produce an invoice at all — a $0.00
    // invoice landing in the client portal reads as a billing error and clutters
    // the invoice list with rows nobody can ever pay. System callers pass
    // `skipIfZero` so they can silently no-op; the manual "New Invoice" form
    // doesn't, so an admin deliberately raising a zero-value invoice still can.
    if (data.skipIfZero) {
      const preview = (data.lines || []).reduce(
        (sum, l) => sum + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0
      );
      if (!(preview > 0)) return null;
    }

    const lines = (data.lines || []).map((l) => ({
      id: uuidv4(),
      // Stamped per line, not just on the header, because merging two package
      // sales onto one bill clears the header link (see _appendLinesToInvoice) —
      // and SubscriptionService needs to know which subscription each line paid
      // for long after that merge happened.
      clientPackageId: l.clientPackageId || data.clientPackageId || null,
      description: l.description,
      qty: l.qty,
      unitPrice: l.unitPrice,
      amount: Number(l.qty) * Number(l.unitPrice),
    }));
    const total = lines.reduce((sum, l) => sum + l.amount, 0);
    const status = data.status || INVOICE_STATUS.DRAFT;
    const issuedAt = toDateOnly(data.issuedAt) || toDateOnly(new Date());
    const dueAt = toDateOnly(data.dueAt) || issuedAt;

    if (data.mergeWithOpenInvoice && !data.retainerId) {
      // `status` (already defaulted) rather than `data.status`, so an omitted
      // status is treated as the draft it will actually become.
      const existing = await this._findOpenMergeTarget(orgId, { ...data, status, dueAt, issuedAt });
      if (existing) {
        return this._appendLinesToInvoice(existing, orgId, { ...data, status }, lines, total);
      }
    }

    // An explicit method on the request wins; otherwise the client's own billing
    // mode decides, so a Stripe client's invoices are on the card rail from the
    // moment they're raised rather than after someone remembers to set it.
    const preferredMethod = (await this._paymentMethodById(orgId, data.preferredPaymentMethodId).catch(() => null))
      || (await this._defaultPaymentMethodForClient(orgId, data.clientId).catch(() => null));
    const issuingCompany = await this._resolveBillingCompanyForMethod(orgId, preferredMethod).catch(() => null);

    const invoice = await db.sequelize.transaction(async (t) => {
      // Allocate the invoice number inside the same transaction (with a lock) so
      // selling a package with 3 installments can't race and hit the unique
      // (org_id, number) constraint — that used to abort the whole billing block.
      //
      // Drafts get a real number too: the client (and so their "Pay via CRM"
      // flag) exists before the quotation does, so the series is already known
      // and settled by the time anything is raised.
      const number = await this._nextNumber(orgId, {
        transaction: t,
        company: issuingCompany,
        paymentMethod: preferredMethod,
      });

      const created = await db.Invoice.create({
        id: uuidv4(),
        orgId,
        companyId: issuingCompany?.id || null,
        preferredPaymentMethodId: preferredMethod?.id || null,
        paymentLinkUrl: toAbsoluteHttpUrl(data.paymentLinkUrl) || null,
        clientId: data.clientId,
        clientPackageId: data.clientPackageId || null,
        retainerId: data.retainerId || null,
        number,
        currency: data.currency || 'USD',
        status,
        issuedAt,
        dueAt,
        total,
        notes: data.notes,
      }, { transaction: t });

      if (lines.length > 0) {
        await db.InvoiceLine.bulkCreate(
          lines.map((l) => ({ ...l, invoiceId: created.id })),
          { transaction: t }
        );
      }

      return created;
    });

    // Mirror updateStatus: system-issued "sent" invoices should notify the portal.
    if (status === INVOICE_STATUS.SENT || status === 'sent') {
      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_sent',
        title: `New invoice: ${invoice.number}`,
        body: `You have a new invoice for ${invoice.total ? `${invoice.currency || ''} ${parseFloat(invoice.total).toFixed(2)}`.trim() : 'an amount'} due ${invoice.dueAt || 'soon'}.`,
        refTable: 'invoices',
        refId: invoice.id,
      }).catch((err) => {
        console.error('[InvoiceService] portal notify on create failed:', err.message);
      });
      this._emailInvoiceToClient(invoice.id, orgId);
    }

    return invoice;
  }

  async updateStatus(id, orgId, status) {
    const invoice = await this.findById(id, orgId);
    if (invoice.status === INVOICE_STATUS.VOID) {
      const err = new Error('Cannot update a void invoice.');
      err.status = 400;
      throw err;
    }
    await invoice.update({ status });

    // Notify client contacts with portal access when invoice is sent or paid
    if (status === INVOICE_STATUS.SENT) {
      // The public page's credential has to exist before the email and PDF are
      // built, since both link to it.
      await this.ensurePublicToken(invoice).catch((err) => {
        console.error('[InvoiceService] Could not mint public invoice token:', err.message);
      });

      // Mint the pay link BEFORE the PDF is rendered for the email. Drafts
      // deliberately have no link (see _resolveInvoicePayUrl), so issuing the
      // invoice is the moment it has to exist — and doing it once here avoids
      // two concurrent renders each finalizing their own Stripe invoice.
      await this._resolveInvoicePayUrl(invoice, orgId).catch(() => null);

      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_sent',
        title: `New invoice: ${invoice.number}`,
        body: `You have a new invoice for ${invoice.total ? `$${parseFloat(invoice.total).toFixed(2)}` : 'an amount'} due ${invoice.dueAt || 'soon'}.`,
        refTable: 'invoices',
        refId: invoice.id,
      });
      this._emailInvoiceToClient(invoice.id, orgId);
    }
    if (status === INVOICE_STATUS.PAID) {
      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_paid',
        title: `Payment confirmed: ${invoice.number}`,
        body: `Your payment for invoice ${invoice.number} has been confirmed. Thank you!`,
        refTable: 'invoices',
        refId: invoice.id,
      });
    }

    // Any status move can change whether a subscription is paid up — issuing the
    // renewal, confirming it, or voiding it. Fire-and-forget: the entitlement is
    // a derived convenience, and RetainerScheduler's sweep re-derives it anyway,
    // so it must never be able to fail the status change itself.
    SubscriptionService.syncForInvoice(invoice.id).catch(() => {});

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
      INVOICE_STATUS.DRAFT,
      INVOICE_STATUS.SENT,
      INVOICE_STATUS.OVERDUE,
      INVOICE_STATUS.PAYMENT_REVIEW,
    ]);

    const invoices = await db.Invoice.findAll({
      where: { id: idList, orgId },
      attributes: ['id', 'number', 'status'],
    });

    const foundIds = new Set(invoices.map((inv) => inv.id));
    const voided = [];
    const skipped = [];

    for (const id of idList) {
      if (!foundIds.has(id)) {
        skipped.push({ id, reason: 'not_found' });
      }
    }

    for (const inv of invoices) {
      if (!VOIDABLE.has(inv.status)) {
        skipped.push({ id: inv.id, number: inv.number, reason: inv.status === INVOICE_STATUS.VOID ? 'already_void' : 'not_voidable', status: inv.status });
        continue;
      }
      voided.push(inv.id);
    }

    if (voided.length) {
      await db.Invoice.update(
        { status: INVOICE_STATUS.VOID },
        { where: { id: voided, orgId } },
      );
    }

    return { voided: voided.length, skipped };
  }

  // `renumber: false` applies the method without moving the invoice onto that
  // method's number series — used when the client already holds a PDF quoting
  // the current number (see applyClientBillingMode).
  async configurePaymentProfile(id, orgId, {
    paymentMethodId = null,
    paymentLinkUrl,
    renumber = true,
  } = {}) {
    const invoice = await db.Invoice.findOne({
      where: { id, orgId },
      include: [{ model: db.Payment, as: 'payments', attributes: ['id'] }],
    });
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }

    if (invoice.status === INVOICE_STATUS.PAID || invoice.status === INVOICE_STATUS.VOID) {
      const err = new Error('This invoice can no longer be reconfigured.');
      err.status = 400;
      throw err;
    }

    const hasSettlements = (invoice.payments || []).length > 0;
    if (hasSettlements) {
      const err = new Error('This invoice already has payments and cannot be renumbered.');
      err.status = 400;
      throw err;
    }

    await db.sequelize.transaction(async (t) => {
      const locked = await db.Invoice.findOne({
        where: { id, orgId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!locked) {
        const err = new Error('Invoice not found.');
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

      const nextCompany = await this._resolveBillingCompanyForMethod(orgId, method, { transaction: t });
      const updates = {};

      // `null` means "no method" — a real choice (back to manual), not "leave it
      // alone". Only `undefined` leaves the current method untouched. Treating
      // null as a no-op is what stranded invoices on the Stripe rail after a
      // client was switched back.
      if (paymentMethodId !== undefined) {
        updates.preferredPaymentMethodId = method?.id || null;
      }

      if (paymentLinkUrl !== undefined) {
        const link = toAbsoluteHttpUrl(paymentLinkUrl);
        updates.paymentLinkUrl = link || null;
      }

      // No method is the manual case, so it gets a series and an entity like any
      // other — that's what keeps every invoice on either INVS or INVM.
      const seriesType = this._invoiceDocTypeForMethod(method);
      const shouldRenumber = renumber
        && (
          locked.companyId !== (nextCompany?.id || null)
          || !String(locked.number || '').includes(`-${seriesType}-`)
        );

      if (shouldRenumber && nextCompany) {
        const nextNumber = await this._nextNumber(orgId, {
          transaction: t,
          company: nextCompany,
          paymentMethod: method,
        });
        updates.number = nextNumber;
        updates.companyId = nextCompany.id;
      } else if (nextCompany && locked.companyId !== nextCompany.id) {
        updates.companyId = nextCompany.id;
      }

      if (method?.kind !== 'stripe') {
        // Prevent stale Stripe links when switching to manual rails.
        updates.stripeInvoiceId = null;
        updates.stripeHostedUrl = null;
      }

      if (Object.keys(updates).length) {
        await locked.update(updates, { transaction: t });
      }

    });

    // Stripe: create the hosted payment URL as soon as the admin picks Stripe,
    // so the next PDF download / email already has a clickable "PAY INVOICE".
    const configured = await this.findById(id, orgId);
    if (configured?.preferredPaymentMethod?.kind === 'stripe' && !configured.stripeHostedUrl) {
      try {
        const StripeService = require('./StripeService');
        await StripeService.startPayment(id, orgId, {
          method: configured.preferredPaymentMethod,
        });
      } catch (err) {
        console.warn(
          `[InvoiceService] Stripe pay link not ready after configure for ${configured.number}:`,
          err.message || err,
        );
      }
      return this.findById(id, orgId);
    }
    return configured;
  }

  /**
   * Money already settled against an invoice, and what is still owed.
   *
   * A part payment is a real thing — a client settling $500 of a $2,000 invoice
   * has paid, but the invoice is not paid. Both halves need to be tracked, or
   * the balance silently disappears the moment the first payment lands.
   */
  async settlementFor(invoiceId, { total = null } = {}) {
    const rows = await db.Payment.findAll({ where: { invoiceId }, attributes: ['amount'] });
    const paid = Math.round(rows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100) / 100;
    const invoiceTotal = total != null
      ? Number(total) || 0
      : Number((await db.Invoice.findByPk(invoiceId, { attributes: ['total'] }))?.total) || 0;
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
    const payment = await db.Payment.create({
      id: uuidv4(),
      invoiceId: invoice.id,
      provider: data.provider || 'manual',
      providerRef: data.providerRef,
      amount,
      methodLabel: data.methodLabel || null,
      paidAt: data.paidAt || new Date(),
    });

    // Only a fully-settled invoice becomes Paid. A part payment leaves it open
    // for the rest — previously ANY payment closed the invoice, so recording
    // $500 against $2,000 wrote off the remaining $1,500.
    const settlement = await this.settlementFor(invoice.id, { total: invoice.total });
    if (settlement.isFullySettled) {
      await invoice.update({ status: INVOICE_STATUS.PAID });
      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_paid',
        title: `Payment confirmed: ${invoice.number}`,
        body: `Your payment for invoice ${invoice.number} has been confirmed. Thank you!`,
        refTable: 'invoices',
        refId: invoice.id,
      });
    } else {
      // Back to an open, chaseable state — 'payment_review' would hide the
      // outstanding balance from the client's own list.
      const stillOpen = invoice.dueAt && invoice.dueAt < new Date().toISOString().split('T')[0]
        ? INVOICE_STATUS.OVERDUE
        : INVOICE_STATUS.SENT;
      if (invoice.status !== stillOpen) await invoice.update({ status: stillOpen });
      PortalNotificationService.notify(invoice.clientId, orgId, {
        type: 'invoice_part_paid',
        title: `Part payment received: ${invoice.number}`,
        body: `Thank you — ${invoice.currency || ''} ${amount.toFixed(2)} received. ${invoice.currency || ''} ${settlement.amountDue.toFixed(2)} remains outstanding on invoice ${invoice.number}.`.replace(/\s+/g, ' ').trim(),
        refTable: 'invoices',
        refId: invoice.id,
      });
    }

    // Reinstates (or, on a part payment, keeps suspended) any subscription this
    // invoice bills for, so the client portal reflects the payment immediately
    // instead of at the next scheduler pass.
    SubscriptionService.syncForInvoice(invoice.id).catch(() => {});

    return payment;
  }
}

module.exports = new InvoiceService();
