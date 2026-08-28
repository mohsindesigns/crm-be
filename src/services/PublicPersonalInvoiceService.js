// Token-scoped only — mirrors PublicInvoiceService for the Personal invoice
// table. No orgId param on any method; the publicToken in the URL is the
// scope.
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const { DEFAULT_BRAND_COLOR } = require('../config/constants');

const PAYABLE_STATUSES = [INVOICE_STATUS.SENT, INVOICE_STATUS.OVERDUE, 'sent', 'overdue'];

const PAYMENT_METHOD_LABELS = {
  manual: 'Manual / Cash',
  bank: 'Bank Transfer',
  stripe: 'Credit / Debit Card (Stripe)',
  paddle: 'Paddle',
  payfast: 'PayFast',
  wise: 'Wise',
  payoneer: 'Payoneer',
};

class PublicPersonalInvoiceService {
  async _findByToken(token) {
    if (!token) {
      const err = new Error('Invalid link.');
      err.status = 404;
      throw err;
    }
    const invoice = await db.PersonalInvoice.findOne({
      where: { publicToken: token },
      include: [
        { model: db.PersonalInvoiceLine, as: 'lines' },
        { model: db.PersonalPayment, as: 'payments' },
        { model: db.PersonalContact, as: 'contact', attributes: ['id', 'name'] },
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

  _settlement(invoice) {
    const total = Number(invoice.total) || 0;
    const paid = (invoice.payments || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const due = Math.max(0, Math.round((total - paid) * 100) / 100);
    return { total, amountPaid: Math.round(paid * 100) / 100, amountDue: due };
  }

  async _reconcile(invoice) {
    if (!invoice.stripeInvoiceId) return invoice;
    if (![...PAYABLE_STATUSES, INVOICE_STATUS.PAYMENT_REVIEW, 'payment_review'].includes(invoice.status)) {
      return invoice;
    }
    try {
      const StripeService = require('./StripeService');
      await StripeService.syncPersonalInvoiceFromStripe(invoice.id, invoice.orgId);
    } catch (err) {
      console.warn(`[PublicPersonalInvoiceService] Could not reconcile ${invoice.number} with Stripe:`, err.message);
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
        clientName: invoice.contact?.name || '',
        total,
        amountPaid,
        amountDue,
        allowPartialPayment: !!invoice.allowPartialPayment,
        canPayByCard: isPayable && isStripe,
        canPayPartial: isPayable && !!invoice.allowPartialPayment,
        isPayable,
        paymentLinkUrl: invoice.paymentLinkUrl || null,
        paymentMethodLabel: invoice.preferredPaymentMethod?.label || null,
        paymentInstructions: invoice.preferredPaymentMethod?.kind === 'manual'
          ? invoice.preferredPaymentMethod?.instructions || null
          : null,
        lines: (invoice.lines || []).map((l) => ({
          description: l.description, qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
        })),
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

  async startPayment(token, { amount = null } = {}) {
    const invoice = await this._findByToken(token);

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
    return StripeService.startPersonalInvoicePayment(invoice.id, invoice.orgId, {
      method,
      payAmount: amount ?? null,
    });
  }

  async getPdfBuffer(token) {
    const invoice = await this._findByToken(token);
    const PersonalInvoiceService = require('./PersonalInvoiceService');
    return PersonalInvoiceService.generatePdfBuffer(invoice.id, invoice.orgId);
  }
}

module.exports = new PublicPersonalInvoiceService();
