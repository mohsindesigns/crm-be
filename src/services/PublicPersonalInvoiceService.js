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

  async getByToken(token) {
    const invoice = await this._findByToken(token);
    const { total, amountPaid, amountDue } = this._settlement(invoice);

    const branding = await db.WhiteLabelConfig.findOne({ where: { orgId: invoice.orgId } });
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
        canPayByCard: false,
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

  async getPdfBuffer(token) {
    const invoice = await this._findByToken(token);
    const PersonalInvoiceService = require('./PersonalInvoiceService');
    return PersonalInvoiceService.generatePdfBuffer(invoice.id, invoice.orgId);
  }
}

module.exports = new PublicPersonalInvoiceService();
