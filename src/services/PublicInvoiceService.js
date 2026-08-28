// Token-scoped only — every method here is reachable with zero authentication,
// so none of them takes an orgId param; the publicToken in the URL is the scope.
// Mirrors PublicDocumentService, which does the same for quotations.
//
// This exists because portal access is a separate grant most clients never get.
// Without it the only payment route was a Stripe link built for the full
// balance, so a client who wanted to pay part now and the rest on delivery had
// nowhere to do it.
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const { DEFAULT_BRAND_COLOR } = require('../config/constants');

const PAYABLE_STATUSES = [INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, 'sent', 'overdue'];

// Fallback names for payments recorded before methodLabel was stored. Mirrors
// PAYMENT_PROVIDER_LABELS in InvoiceService so the page and the PDF read alike.
const PAYMENT_METHOD_LABELS = {
  manual: 'Manual / Cash',
  bank: 'Bank Transfer',
  stripe: 'Credit / Debit Card (Stripe)',
  paddle: 'Paddle',
  payfast: 'PayFast',
  wise: 'Wise',
  payoneer: 'Payoneer',
};

class PublicInvoiceService {
  async _findByToken(token) {
    if (!token) {
      const err = new Error('Invalid link.');
      err.status = 404;
      throw err;
    }
    const invoice = await db.Invoice.findOne({
      where: { publicToken: token },
      include: [
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Payment, as: 'payments' },
        { model: db.Client, as: 'client', attributes: ['id', 'name'] },
        { model: db.PaymentMethod, as: 'preferredPaymentMethod', attributes: ['id', 'kind', 'label', 'instructions'] },
      ],
    });
    if (!invoice) {
      const err = new Error('This link is invalid or has expired.');
      err.status = 404;
      throw err;
    }
    return invoice;
  }

  /** Total / paid / outstanding, from the payments actually recorded. */
  _settlement(invoice) {
    const total = Number(invoice.total) || 0;
    const paid = (invoice.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const due = Math.max(0, Math.round((total - paid) * 100) / 100);
    return { total, amountPaid: Math.round(paid * 100) / 100, amountDue: due };
  }

  /**
   * Pull the truth from Stripe before showing a balance.
   *
   * The webhook is the fast path, not the only one: it needs a publicly
   * reachable URL and STRIPE_WEBHOOK_SECRET, so in local dev — and any time
   * delivery fails or is retried late — a payment can clear at Stripe while our
   * row still says nothing was paid. The client then reopens the link and is
   * asked for money they already sent, which is the worst possible failure here.
   *
   * Safe to call on every read: _markPaidFromStripeInvoice dedupes on the
   * provider reference, so reconciling twice records one payment.
   */
  async _reconcile(invoice) {
    if (!invoice.stripeInvoiceId) return invoice;
    if (![...PAYABLE_STATUSES, INVOICE_STATUS.PAYMENT_REVIEW, 'payment_review'].includes(invoice.status)) {
      return invoice;
    }
    try {
      const StripeService = require('./StripeService');
      await StripeService.syncFromStripe(invoice.id, invoice.orgId);
    } catch (err) {
      // Stripe unreachable or not configured — show what we have rather than
      // failing the page.
      console.warn(`[PublicInvoiceService] Could not reconcile ${invoice.number} with Stripe:`, err.message);
      return invoice;
    }
    return this._findByToken(invoice.publicToken);
  }

  async getByToken(token) {
    let invoice = await this._findByToken(token);
    invoice = await this._reconcile(invoice);
    const { total, amountPaid, amountDue } = this._settlement(invoice);

    const branding = await db.WhiteLabelConfig.findOne({ where: { orgId: invoice.orgId } });
    const isStripe = invoice.preferredPaymentMethod?.kind === 'stripe';
    const isPayable = PAYABLE_STATUSES.includes(invoice.status) && amountDue > 0.005;

    return {
      invoice: {
        id: invoice.id,
        number: invoice.number,
        status: invoice.status,
        currency: invoice.currency || 'USD',
        issuedAt: invoice.issuedAt,
        dueAt: invoice.dueAt,
        notes: invoice.notes,
        clientName: invoice.client?.name || '',
        total,
        amountPaid,
        amountDue,
        allowPartialPayment: !!invoice.allowPartialPayment,
        // Drives the UI: card clients get the amount picker when partial payments are enabled,
        // everyone else gets the manual instructions their method carries.
        canPayByCard: isPayable && isStripe,
        // Retainer and installment invoices are included deliberately. A recurring
        // cycle charge is still a balance a client can chip away at, and carving
        // them out meant the clients most likely to ask for part payment — the
        // ones on a monthly retainer — were the only ones who could never get it.
        // The flag on the invoice is the single gate now, for every invoice type.
        canPayPartial: isPayable && !!invoice.allowPartialPayment,
        isPayable,
        // Still reported so the page can label a recurring charge as such; it no
        // longer restricts what the client is allowed to pay.
        isRetainer: !!invoice.retainerId,
        paymentLinkUrl: invoice.paymentLinkUrl || null,
        paymentMethodLabel: invoice.preferredPaymentMethod?.label || null,
        paymentInstructions: invoice.preferredPaymentMethod?.kind === 'manual'
          ? invoice.preferredPaymentMethod?.instructions || null
          : null,
        lines: (invoice.lines || []).map((l) => ({
          description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
        })),
        // What they've already paid, when, and how — the same three columns the
        // PDF prints, so the page and the document agree.
        payments: (invoice.payments || [])
          .slice()
          .sort((a, b) => String(a.paidAt || '').localeCompare(String(b.paidAt || '')))
          .map((p) => ({
            amount: Number(p.amount) || 0,
            paidAt: p.paidAt,
            provider: p.provider,
            methodLabel: p.methodLabel || PAYMENT_METHOD_LABELS[p.provider] || p.provider || 'Payment',
          })),
      },
      branding: {
        brandName: branding?.brandName || 'Mohsin Designs Project Management',
        primaryColor: branding?.primaryColor || DEFAULT_BRAND_COLOR,
        logoUrl: branding?.logoUrl || null,
        businessPhone: branding?.businessPhone || null,
        website: branding?.website || null,
        email: branding?.emailFrom || null,
      },
    };
  }

  /**
   * Start a card payment for the whole balance, or for `amount` of it.
   *
   * The part-payment rules (must be > 0, never more than outstanding, invoice
   * stays open until settled) all live in StripeService.startPayment — this
   * only forwards the figure the client typed.
   */
  async startPayment(token, { amount = null } = {}) {
    const invoice = await this._findByToken(token);

    // The invoice's own flag is the only gate — no invoice type is excluded.
    // Mirrored server-side because the UI check is advisory: this endpoint is
    // public, so anything only enforced in the browser is not enforced at all.
    if (!invoice.allowPartialPayment && amount != null) {
      const { amountDue } = this._settlement(invoice);
      if (Number(amount) < amountDue - 0.005) {
        const err = new Error('Partial payment is not enabled for this invoice.');
        err.status = 400;
        throw err;
      }
    }

    if (!PAYABLE_STATUSES.includes(invoice.status)) {
      const err = new Error(
        invoice.status === INVOICE_STATUS.PAID || invoice.status === 'paid'
          ? 'This invoice has already been paid in full.'
          : 'This invoice is not currently awaiting payment.',
      );
      err.status = 409;
      throw err;
    }

    const method = invoice.preferredPaymentMethod?.kind === 'stripe'
      ? invoice.preferredPaymentMethod
      : await db.PaymentMethod.findOne({ where: { orgId: invoice.orgId, kind: 'stripe', isActive: true } });
    if (!method) {
      const err = new Error('Card payment is not available for this invoice.');
      err.status = 400;
      throw err;
    }

    const StripeService = require('./StripeService');
    const result = await StripeService.startPayment(invoice.id, invoice.orgId, {
      method,
      payAmount: amount ?? null,
    });
    return result;
  }

  async getPdfBuffer(token) {
    const invoice = await this._findByToken(token);
    const InvoiceService = require('./InvoiceService');
    return InvoiceService.generatePdfBuffer(invoice.id, invoice.orgId);
  }
}

module.exports = new PublicInvoiceService();
