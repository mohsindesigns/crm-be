const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');

// Payment.provider is an ENUM; a PaymentMethod row writes straight into it, so
// an admin can only pick from values the column actually accepts. Widening this
// list means widening that ENUM in models/Payment.js first.
const ALLOWED_PROVIDERS = ['manual', 'bank', 'stripe', 'paddle', 'payfast', 'wise', 'payoneer'];

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

class BillingSettingsService {
  async list(orgId) {
    await db.PaymentMethod.seedDefaults(orgId);
    return db.PaymentMethod.findAll({
      where: { orgId },
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
  }

  _sanitize(data, { existing = null } = {}) {
    const out = {};

    if (data.label !== undefined) {
      const label = String(data.label || '').trim();
      if (!label) throw badRequest('A label is required.');
      out.label = label.slice(0, 120);
    }

    if (data.provider !== undefined) {
      const provider = String(data.provider || 'manual').trim().toLowerCase();
      if (!ALLOWED_PROVIDERS.includes(provider)) {
        throw badRequest(`Unsupported provider. Choose one of: ${ALLOWED_PROVIDERS.join(', ')}.`);
      }
      out.provider = provider;
    }

    if (data.instructions !== undefined) out.instructions = data.instructions || null;
    if (data.isActive !== undefined) out.isActive = !!data.isActive;
    if (data.requiresProof !== undefined) out.requiresProof = !!data.requiresProof;
    if (data.sortOrder !== undefined) out.sortOrder = parseInt(data.sortOrder, 10) || 0;

    // `kind` is structural, not cosmetic — flipping an existing manual method to
    // 'stripe' would change how it settles money. It's set once, at creation.
    if (existing) {
      if (existing.kind === 'stripe') {
        out.provider = 'stripe';
        out.requiresProof = false;
      }
    } else {
      const kind = data.kind === 'stripe' ? 'stripe' : 'manual';
      out.kind = kind;
      if (kind === 'stripe') {
        out.provider = 'stripe';
        out.requiresProof = false;
      } else if (!out.provider) {
        out.provider = 'manual';
      }
    }

    return out;
  }

  async create(orgId, data) {
    const payload = this._sanitize(data);
    if (!payload.label) throw badRequest('A label is required.');

    // Only one Stripe row makes sense: the portal picks "the" Stripe method to
    // start a payment, and two would make that choice arbitrary.
    if (payload.kind === 'stripe') {
      const exists = await db.PaymentMethod.count({ where: { orgId, kind: 'stripe' } });
      if (exists > 0) throw badRequest('A Stripe card method already exists. Edit that one instead.');
    }

    return db.PaymentMethod.create({ id: uuidv4(), orgId, ...payload });
  }

  async update(id, orgId, data) {
    const method = await db.PaymentMethod.findOne({ where: { id, orgId } });
    if (!method) {
      const err = new Error('Payment method not found.');
      err.status = 404;
      throw err;
    }
    await method.update(this._sanitize(data, { existing: method }));
    return method;
  }

  /**
   * Deactivate rather than delete: historical Payment rows reference the
   * provider, and an admin who removes "Wise" should stop offering it going
   * forward, not lose the ability to explain what an old Wise payment was.
   */
  async deactivate(id, orgId) {
    const method = await db.PaymentMethod.findOne({ where: { id, orgId } });
    if (!method) {
      const err = new Error('Payment method not found.');
      err.status = 404;
      throw err;
    }
    await method.update({ isActive: false });
    return method;
  }

  async reorder(orgId, ids) {
    if (!Array.isArray(ids)) throw badRequest('Expected an array of method IDs.');
    await Promise.all(ids.map((id, index) =>
      db.PaymentMethod.update({ sortOrder: index }, { where: { id, orgId } })));
    return this.list(orgId);
  }

  /**
   * How card payments are set up for this org — the admin's own settings plus
   * whether the credentials exist in the environment. Never returns the
   * credentials themselves.
   */
  async stripeStatus(orgId) {
    await db.PaymentFeeRule.seedDefaults(orgId).catch(() => {});
    const view = await db.PaymentSetting.publicView(orgId);
    const fees = await db.PaymentFeeRule.findAll({
      where: { orgId },
      order: [['currency', 'ASC']],
    });
    return {
      ...view,
      // Always the client — passing the card fee on is the whole point of the
      // per-currency rules, so there is no absorb option to report.
      feePayer: 'client',
      fees,
    };
  }

  async saveStripeSettings(orgId, patch) {
    return db.PaymentSetting.save(orgId, patch);
  }

  /**
   * Apply a part-payment decision to every invoice that is still open.
   *
   * The org default only seeds invoices raised from that point on, which leaves
   * the ones already sitting in a client's inbox on whatever they were created
   * with. For a retainer that renews monthly the default catches up on its own
   * next cycle, but the invoice the client is looking at *today* doesn't — so
   * this is the one-shot catch-up for the existing book.
   *
   * "Open" is everything not yet settled or cancelled, drafts included: a draft
   * is about to be sent and should go out matching the org's policy. `paid` and
   * `void` are deliberately excluded — a settled invoice has no balance to part
   * pay, and rewriting a closed record to say otherwise is a lie about history.
   *
   * Deliberately NOT wired into the settings toggle. Flipping a default is a
   * statement about future invoices; rewriting live invoices a client already
   * holds a link to is a separate, louder decision, and it should take a second
   * click that says so.
   */
  async applyPartialPaymentToOpenInvoices(orgId, allow) {
    const OPEN_STATUSES = ['draft', 'sent', 'overdue', 'payment_review'];
    const value = !!allow;

    // Only touch rows that would actually change, so the count reported back is
    // "invoices changed" and not "invoices looked at". NULL has to be matched
    // explicitly when switching part payment ON: `allowPartialPayment = false`
    // never matches a NULL, and any row predating the column's backfill would
    // silently be skipped — exactly the old invoices this exists to catch up.
    const notYet = value
      ? { [Op.or]: [{ allowPartialPayment: false }, { allowPartialPayment: null }] }
      : { allowPartialPayment: true };

    const [updated] = await db.Invoice.update(
      { allowPartialPayment: value },
      { where: { orgId, status: OPEN_STATUSES, ...notYet } },
    );

    return { updated: updated || 0, allowPartialPayment: value };
  }

  // ─── Per-currency processing fees ─────────────────────────────────────────

  _sanitizeFee(data) {
    const currency = String(data.currency || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (!currency || currency.length < 3) throw badRequest('Enter a 3-letter currency code, e.g. USD.');

    const percent = Number(data.percent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      throw badRequest('Percentage must be between 0 and 100.');
    }
    const fixedFee = Number(data.fixedFee);
    if (!Number.isFinite(fixedFee) || fixedFee < 0) {
      throw badRequest('The fixed fee cannot be negative.');
    }

    return {
      currency: currency.slice(0, 10),
      percent: Math.round(percent * 1000) / 1000,
      fixedFee: Math.round(fixedFee * 100) / 100,
      label: data.label ? String(data.label).trim().slice(0, 80) : null,
      isActive: data.isActive === undefined ? true : !!data.isActive,
    };
  }

  async createFeeRule(orgId, data) {
    const payload = this._sanitizeFee(data);
    const clash = await db.PaymentFeeRule.findOne({ where: { orgId, currency: payload.currency } });
    if (clash) throw badRequest(`A fee for ${payload.currency} already exists — edit that one instead.`);
    return db.PaymentFeeRule.create({ id: uuidv4(), orgId, ...payload });
  }

  async updateFeeRule(id, orgId, data) {
    const rule = await db.PaymentFeeRule.findOne({ where: { id, orgId } });
    if (!rule) {
      const err = new Error('Fee rule not found.');
      err.status = 404;
      throw err;
    }
    const payload = this._sanitizeFee({ ...rule.toJSON(), ...data });
    if (payload.currency !== rule.currency) {
      const clash = await db.PaymentFeeRule.findOne({ where: { orgId, currency: payload.currency } });
      if (clash) throw badRequest(`A fee for ${payload.currency} already exists.`);
    }
    await rule.update(payload);
    return rule;
  }

  async deleteFeeRule(id, orgId) {
    const rule = await db.PaymentFeeRule.findOne({ where: { id, orgId } });
    if (!rule) {
      const err = new Error('Fee rule not found.');
      err.status = 404;
      throw err;
    }
    // A hard delete is right here: unlike a payment method, a fee rule is a
    // live calculation input with no historical rows pointing at it. Removing
    // it simply means "stop charging a fee in this currency".
    await rule.destroy();
    return { ok: true };
  }
}

module.exports = new BillingSettingsService();
module.exports.ALLOWED_PROVIDERS = ALLOWED_PROVIDERS;
