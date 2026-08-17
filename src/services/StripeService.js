/**
 * Card payments for portal invoices, via real Stripe Invoices.
 *
 * Deliberately NOT Checkout Sessions. A Checkout Session is a throwaway payment
 * page — nothing durable lands in the Stripe dashboard, so reconciling a bank
 * payout against "which client paid which invoice" means digging through payment
 * intents. Creating an actual Stripe Invoice means the charge exists as a first
 * class invoice on Stripe's side too: it carries our invoice number, the same
 * line items, the customer's history, and Stripe's own PDF/receipt. Its
 * `hosted_invoice_url` IS a hosted payment page, so the client experience is the
 * same redirect — we just get a real record out of it.
 *
 * The flow:
 *   1. Client picks "Credit / Debit Card" on a portal invoice.
 *   2. startPayment() ensures a Stripe Customer, creates a Stripe Invoice with
 *      one line per InvoiceLine (plus a processing-fee line if the client is
 *      absorbing it), finalizes it, and hands back hosted_invoice_url.
 *   3. Client pays on Stripe.
 *   4. Stripe POSTs `invoice.paid` to /api/stripe/webhook, which records the
 *      Payment and flips our invoice to `paid`. No human in the loop.
 *
 * Everything here degrades to a clean 503 when STRIPE_ENABLED is off or the
 * secret key is blank, so the rest of billing keeps working un-configured.
 */
const Stripe = require('stripe');
const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const PortalNotificationService = require('./PortalNotificationService');
const NotificationService = require('./NotificationService');

// Currencies Stripe expects as whole units rather than minor units. Multiplying
// a ¥1000 invoice by 100 would charge the client ¥100,000.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga',
  'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);

/**
 * Whether this org is accepting cards right now.
 *
 * Requires BOTH halves: an admin has switched cards on in the panel, and a
 * secret key is present in the environment. Credentials are deliberately not
 * stored in the database (see models/PaymentSetting.js).
 */
async function isEnabled(orgId) {
  const db = require('../models');
  const settings = await db.PaymentSetting.resolve(orgId).catch(() => null);
  return !!settings?.enabled;
}

let _client = null;
let _clientKey = null;

function stripe() {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) {
    const err = new Error('Card payments are not available right now. Please choose another payment method.');
    err.status = 503;
    throw err;
  }
  // Rebuild if the key changed under a running process (a rotation, or a
  // sandbox→live switch) rather than serving the old account forever.
  if (!_client || _clientKey !== key) {
    _clientKey = key;
    _client = new Stripe(key, {
      // No apiVersion override on purpose. stripe-node pins its own version
      // (see node_modules/stripe/cjs/apiVersion.js) and its response handling is
      // written against exactly that; forcing an older one here would pin the
      // wire format while leaving the SDK expecting the newer shapes.
      maxNetworkRetries: 2,
      timeout: 20000,
      appInfo: { name: 'Cadence', version: '1.0.0' },
    });
  }
  return _client;
}

function toMinorUnits(amount, currency) {
  const cur = String(currency || 'usd').toLowerCase();
  const n = Number(amount) || 0;
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) return Math.round(n);
  return Math.round(n * 100);
}

function fromMinorUnits(amount, currency) {
  const cur = String(currency || 'usd').toLowerCase();
  const n = Number(amount) || 0;
  if (ZERO_DECIMAL_CURRENCIES.has(cur)) return n;
  return Math.round(n) / 100;
}

/**
 * The card processing fee passed on to the client, from the org's per-currency
 * rule in Admin → Payments.
 *
 * Always charged to the client — it becomes a line on the Stripe invoice so the
 * agency receives its invoice total intact. A currency with no configured rule
 * charges nothing, rather than inventing a surcharge for a rate nobody set.
 */
async function processingFeeFor(orgId, amount, currency) {
  const db = require('../models');
  return db.PaymentFeeRule.feeFor(orgId, currency, amount).catch(() => 0);
}

/**
 * A stable reference for the money that settled a Stripe invoice, used as the
 * dedupe key for Payment rows.
 *
 * `invoice.payment_intent` was a top-level field on older API versions and moved
 * under `invoice.payments[]` on newer ones, so both shapes are probed. The Stripe
 * invoice id is the last resort — it is unique per invoice, which is all the
 * idempotency guard actually needs.
 */
function extractPaymentRef(stripeInvoice) {
  const pi = stripeInvoice?.payment_intent;
  if (typeof pi === 'string' && pi) return pi;
  if (pi?.id) return pi.id;

  const first = stripeInvoice?.payments?.data?.[0]?.payment;
  const nested = first?.payment_intent;
  if (typeof nested === 'string' && nested) return nested;
  if (nested?.id) return nested.id;
  if (typeof first?.charge === 'string' && first.charge) return first.charge;

  return stripeInvoice?.id || null;
}

class StripeService {
  isEnabled(orgId) { return isEnabled(orgId); }

  /** Total already settled against an invoice, from our own Payment rows. */
  async _amountPaid(invoiceId) {
    const rows = await db.Payment.findAll({
      where: { invoiceId },
      attributes: ['amount'],
    });
    return rows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  }

  /**
   * Find or create the Stripe Customer for a client. Verifies a cached id still
   * resolves (and wasn't deleted in the Stripe dashboard) before reusing it.
   */
  async _ensureCustomer(client, contact) {
    const s = stripe();

    if (client.stripeCustomerId) {
      try {
        const existing = await s.customers.retrieve(client.stripeCustomerId);
        if (existing && !existing.deleted) return existing.id;
      } catch {
        // Deleted or from a different (test vs live) account — fall through and
        // create a fresh one rather than failing the payment.
      }
    }

    const customer = await s.customers.create({
      name: client.name || undefined,
      email: contact?.email || undefined,
      metadata: {
        cadenceClientId: client.id,
        cadenceOrgId: client.orgId,
      },
    });
    await client.update({ stripeCustomerId: customer.id });
    return customer.id;
  }

  /**
   * Reuse the Stripe invoice already attached to this row when it's still
   * payable, so a client who closed the tab lands back on the same page instead
   * of creating a second invoice for the same money.
   *
   * Returns a hosted URL to resume, `{ alreadyPaid: true }` if Stripe says it's
   * settled (in which case we reconcile immediately), or null to create fresh.
   */
  async _resumeExisting(invoice) {
    if (!invoice.stripeInvoiceId) return null;
    const s = stripe();
    let existing;
    try {
      existing = await s.invoices.retrieve(invoice.stripeInvoiceId);
    } catch {
      return null; // Vanished or belongs to another Stripe account — start over.
    }

    if (existing.status === 'paid') {
      // Reconciles it here and now. `fullySettled` distinguishes "the invoice is
      // done" from "an earlier part payment cleared" — the second is a reason to
      // carry on and collect the rest, not to stop.
      const result = await this._markPaidFromStripeInvoice(existing);
      return { alreadyPaid: true, fullySettled: result?.fullySettled !== false };
    }
    if (existing.status === 'open' && existing.hosted_invoice_url) {
      return { url: existing.hosted_invoice_url, stripeInvoiceId: existing.id, resumed: true };
    }
    // draft / void / uncollectible — abandon it and build a new one.
    if (existing.status === 'draft') {
      await s.invoices.del(existing.id).catch(() => {});
    }
    return null;
  }

  /**
   * Create + finalize a Stripe Invoice for one of our invoices and return the
   * hosted payment URL the portal should redirect to.
   *
   * `payAmount` lets the client settle part of the balance now — a $2,000 invoice
   * can be paid $500 at a time, with the remainder staying outstanding here. When
   * it's a part payment the Stripe invoice carries a single "part payment" line
   * for exactly that amount instead of mirroring the full line items, so the page
   * the client lands on asks for the figure they chose and nothing else.
   */
  /**
   * Serialize payment attempts per invoice.
   *
   * Two concurrent calls both read the same open Stripe invoice, both void it,
   * and both create a replacement — leaving two payable pages for one balance.
   * A public, unauthenticated endpoint makes that trivially reachable by anyone
   * holding the link (double-click, refresh loop, or deliberately), and with no
   * webhook the second payment would go unnoticed.
   *
   * In-process, which covers a single API instance. Behind multiple instances
   * this needs a shared lock (DB row lock or Redis) — see startPayment.
   */
  _withInvoiceLock(invoiceId, fn) {
    if (!this._locks) this._locks = new Map();
    const prior = this._locks.get(invoiceId) || Promise.resolve();
    // Run after the previous holder settles, whichever way it went.
    const run = prior.then(fn, fn);
    // `tail` is the swallowed version used purely for chaining, so one caller's
    // rejection never propagates into the next caller's result.
    const tail = run.catch(() => {});
    this._locks.set(invoiceId, tail);
    tail.then(() => {
      // Only clear if nobody queued behind us in the meantime.
      if (this._locks.get(invoiceId) === tail) this._locks.delete(invoiceId);
    });
    return run;
  }

  async startPayment(invoiceId, orgId, opts = {}) {
    return this._withInvoiceLock(invoiceId, () => this._startPaymentLocked(invoiceId, orgId, opts));
  }

  async _startPaymentLocked(invoiceId, orgId, { method = null, payAmount = null } = {}) {
    const s = stripe();

    const invoice = await db.Invoice.findOne({
      where: { id: invoiceId, orgId },
      include: [
        { model: db.InvoiceLine, as: 'lines' },
        { model: db.Client, as: 'client', include: [{ model: db.Contact, as: 'contacts' }] },
      ],
    });
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if (invoice.status === INVOICE_STATUS.PAID || invoice.status === 'paid') {
      const err = new Error('This invoice is already paid.');
      err.status = 400;
      throw err;
    }
    if (invoice.status === INVOICE_STATUS.VOID || invoice.status === 'void') {
      const err = new Error('This invoice has been voided.');
      err.status = 400;
      throw err;
    }

    const currency = String(invoice.currency || 'USD').toLowerCase();

    // Reconcile any existing Stripe invoice FIRST, so the balance below is
    // computed against payments that have actually cleared — including one that
    // settled while a webhook was missed.
    const openStripeInvoiceId = invoice.stripeInvoiceId;
    const previousPartialAmount = invoice.stripePartialAmount;
    const resumed = await this._resumeExisting(invoice);
    if (resumed?.alreadyPaid && resumed.fullySettled) {
      const err = new Error('This invoice has already been paid.');
      err.status = 400;
      throw err;
    }
    if (resumed?.alreadyPaid) await invoice.reload();

    const total = parseFloat(invoice.total) || 0;
    const amountDue = Math.round((total - await this._amountPaid(invoice.id)) * 100) / 100;
    if (amountDue <= 0) {
      const err = new Error('There is nothing left to pay on this invoice.');
      err.status = 400;
      throw err;
    }

    // How much this attempt collects: the whole balance by default, or the part
    // payment the client asked for. Never more than is actually outstanding.
    const requested = payAmount === null || payAmount === undefined || payAmount === ''
      ? null
      : Math.round((Number(payAmount) || 0) * 100) / 100;
    if (requested !== null && !(requested > 0)) {
      const err = new Error('Enter an amount greater than zero to pay.');
      err.status = 400;
      throw err;
    }
    if (requested !== null && requested > amountDue) {
      const err = new Error(`You can pay at most ${invoice.currency} ${amountDue.toFixed(2)} on this invoice.`);
      err.status = 400;
      throw err;
    }
    const chargeAmount = requested !== null ? requested : amountDue;
    const isPartPayment = chargeAmount < amountDue;

    // Only resume an open Stripe page when it is for the same money. A client who
    // paid $500 and came back for another $500 must get a fresh page for the new
    // amount, not the old one.
    if (resumed?.url && !isPartPayment && !previousPartialAmount) {
      await invoice.update({ stripeHostedUrl: resumed.url });
      return { url: resumed.url, resumed: true, chargeAmount, amountDue, isPartPayment: false };
    }
    if (resumed?.url) {
      // The void MUST succeed before we forget this invoice. Swallowing the
      // error left a still-payable Stripe page live with no reference to it on
      // our side — the client could pay the old page and the new one, and with
      // no webhook we'd never learn about the first. Failing loudly keeps the
      // old page as the only payable one, which is recoverable; orphaning it is
      // not.
      try {
        await s.invoices.voidInvoice(openStripeInvoiceId);
      } catch (err) {
        const e = new Error('Could not cancel the previous payment page. Please refresh and try again in a moment.');
        e.status = 409;
        throw e;
      }
      await invoice.update({ stripeInvoiceId: null, stripeHostedUrl: null, stripePartialAmount: null });
    }

    const activeContacts = (invoice.client?.contacts || []).filter((c) => c.isActive !== false);
    const billingContact = activeContacts.find((c) => c.useForInvoice)
      || activeContacts.find((c) => c.portalAccess)
      || activeContacts[0]
      || null;

    const customerId = await this._ensureCustomer(invoice.client, billingContact);
    const fee = await processingFeeFor(orgId, chargeAmount, currency);
    // How long the client has to pay, set by the admin rather than the deploy.
    const settings = await db.PaymentSetting.resolve(orgId).catch(() => null);
    const dueDays = Math.max(0, settings?.invoiceDueDays ?? 7);

    // Create the invoice FIRST with pending_invoice_items_behavior: 'exclude',
    // then attach items to it explicitly. The alternative (create items, then an
    // invoice that sweeps up pending items) can pull in stray items left behind
    // by an earlier failed attempt and overcharge the client.
    const draft = await s.invoices.create({
      customer: customerId,
      currency,
      collection_method: 'send_invoice',
      days_until_due: dueDays,
      pending_invoice_items_behavior: 'exclude',
      auto_advance: false,
      description: `Payment for invoice ${invoice.number}`,
      // Echoed back on every webhook — this is how we map Stripe's callback to
      // our row without trusting anything client-supplied.
      metadata: {
        cadenceInvoiceId: invoice.id,
        cadenceOrgId: orgId,
        cadenceInvoiceNumber: invoice.number,
        cadenceClientId: invoice.clientId,
        cadenceProcessingFee: String(fee),
        cadenceChargeAmount: String(chargeAmount),
        cadencePartPayment: isPartPayment ? '1' : '0',
        cadenceMethodLabel: method?.label || 'Credit / Debit Card (Stripe)',
      },
      custom_fields: [{ name: 'Invoice', value: String(invoice.number).slice(0, 30) }],
    });

    if (isPartPayment) {
      // One explicit line. Mirroring the full scope and then discounting it down
      // would show the client a page they can't reconcile against the figure they
      // just typed.
      await s.invoiceItems.create({
        customer: customerId,
        invoice: draft.id,
        currency,
        amount: toMinorUnits(chargeAmount, currency),
        description: `Part payment for invoice ${invoice.number} (balance ${invoice.currency} ${(amountDue - chargeAmount).toFixed(2)} remains)`.slice(0, 300),
      });
    } else {
      const lines = invoice.lines || [];
      if (lines.length) {
        for (const line of lines) {
          const lineAmount = Number(line.amount) || (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
          if (lineAmount <= 0) continue;
          await s.invoiceItems.create({
            customer: customerId,
            invoice: draft.id,
            currency,
            amount: toMinorUnits(lineAmount, currency),
            description: String(line.description || 'Services').slice(0, 300),
          });
        }
      } else {
        await s.invoiceItems.create({
          customer: customerId,
          invoice: draft.id,
          currency,
          amount: toMinorUnits(amountDue, currency),
          description: `Invoice ${invoice.number}`,
        });
      }

      // Partial prior payments: credit them so the client is only asked for the
      // remaining balance, even though the line items show the full scope.
      const alreadyPaid = Math.round((total - amountDue) * 100) / 100;
      if (alreadyPaid > 0) {
        await s.invoiceItems.create({
          customer: customerId,
          invoice: draft.id,
          currency,
          amount: -toMinorUnits(alreadyPaid, currency),
          description: 'Less: payments already received',
        });
      }
    }

    if (fee > 0) {
      await s.invoiceItems.create({
        customer: customerId,
        invoice: draft.id,
        currency,
        amount: toMinorUnits(fee, currency),
        description: 'Card processing fee',
      });
    }

    const finalized = await s.invoices.finalizeInvoice(draft.id, { auto_advance: false });
    if (!finalized.hosted_invoice_url) {
      const err = new Error('Stripe did not return a payment link. Please try again or use another payment method.');
      err.status = 502;
      throw err;
    }

    await invoice.update({
      stripeInvoiceId: finalized.id,
      stripeHostedUrl: finalized.hosted_invoice_url,
      // Remembered so a later attempt for a different figure knows to void this
      // page rather than sending the client back to the old amount.
      stripePartialAmount: isPartPayment ? chargeAmount : null,
    });

    return {
      url: finalized.hosted_invoice_url,
      stripeInvoiceId: finalized.id,
      amountDue,
      chargeAmount,
      isPartPayment,
      remainingAfter: Math.round((amountDue - chargeAmount) * 100) / 100,
      processingFee: fee,
      currency: invoice.currency,
    };
  }

  /**
   * Pull the current state of an invoice straight from Stripe and reconcile it.
   *
   * The webhook is the normal path, but it can't cover everything: an invoice
   * paid while the webhook secret was missing, or during an outage, or before
   * the endpoint was configured, leaves money collected at Stripe and an invoice
   * still showing overdue here. Without this the only fix is editing the
   * database by hand.
   *
   * Safe to run repeatedly — it goes through the same idempotent path the
   * webhook uses, so re-syncing an already-reconciled invoice does nothing.
   */
  async syncFromStripe(invoiceId, orgId) {
    const invoice = await db.Invoice.findOne({ where: { id: invoiceId, orgId } });
    if (!invoice) {
      const err = new Error('Invoice not found.');
      err.status = 404;
      throw err;
    }
    if (!invoice.stripeInvoiceId) {
      const err = new Error('No card payment was ever started for this invoice, so there is nothing to check.');
      err.status = 400;
      throw err;
    }

    let stripeInvoice;
    try {
      stripeInvoice = await stripe().invoices.retrieve(invoice.stripeInvoiceId);
    } catch (err) {
      const e = new Error(`Could not reach Stripe for this invoice: ${err.message}`);
      e.status = 502;
      throw e;
    }

    if (stripeInvoice.status === 'paid') {
      const result = await this._markPaidFromStripeInvoice(stripeInvoice);
      if (result?.fullySettled === false) {
        return {
          status: 'part_paid',
          message: `Part payment confirmed with Stripe — ${invoice.currency || ''} ${Number(result.remaining).toFixed(2)} is still outstanding, so the invoice stays open.`.replace(/\s+/g, ' ').trim(),
        };
      }
      return { status: 'paid', message: 'Payment confirmed with Stripe — the invoice is now marked paid.' };
    }

    return {
      status: stripeInvoice.status,
      message: `Stripe reports this invoice as "${stripeInvoice.status}" — no payment has cleared yet.`,
    };
  }

  // ─── Webhook ────────────────────────────────────────────────────────────────

  /** Verifies Stripe's signature over the raw request body. */
  constructEvent(rawBody, signature) {
    const secret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      const err = new Error('Stripe webhook secret is not configured.');
      err.status = 503;
      throw err;
    }
    return stripe().webhooks.constructEvent(rawBody, signature, secret);
  }

  async handleEvent(event) {
    switch (event.type) {
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        return this._markPaidFromStripeInvoice(event.data.object);
      case 'invoice.payment_failed':
        return this._onPaymentFailed(event.data.object);
      case 'invoice.voided':
      case 'invoice.marked_uncollectible':
        return this._onInvoiceCancelled(event.data.object);
      default:
        return { ignored: event.type };
    }
  }

  /** Resolve our Invoice row from a Stripe invoice object. */
  async _localInvoiceFor(stripeInvoice) {
    const localId = stripeInvoice?.metadata?.cadenceInvoiceId;
    if (localId) {
      const byMeta = await db.Invoice.findByPk(localId);
      if (byMeta) return byMeta;
    }
    if (stripeInvoice?.id) {
      return db.Invoice.findOne({ where: { stripeInvoiceId: stripeInvoice.id } });
    }
    return null;
  }

  /**
   * The money actually landed. Records a Payment, marks the invoice paid, and
   * notifies both sides.
   *
   * Idempotent on the Stripe reference: Stripe retries webhooks, and both
   * `invoice.paid` and `invoice.payment_succeeded` fire for a single payment, so
   * this runs 2+ times per payment as a matter of course. Without the guard the
   * client would show as having paid twice.
   */
  async _markPaidFromStripeInvoice(stripeInvoice) {
    const invoice = await this._localInvoiceFor(stripeInvoice);
    if (!invoice) return { ignored: 'unknown_invoice' };

    const providerRef = extractPaymentRef(stripeInvoice);

    const existing = await db.Payment.findOne({
      where: { invoiceId: invoice.id, providerRef },
    });
    if (existing) return { ok: true, deduped: true };

    const currency = stripeInvoice.currency || invoice.currency;
    const fee = Number(stripeInvoice.metadata?.cadenceProcessingFee) || 0;
    // What Stripe collected, less any surcharge — the surcharge is fee recovery,
    // not revenue against the invoice, so the invoice settles to exactly its own
    // total instead of looking overpaid.
    const collected = fromMinorUnits(
      stripeInvoice.amount_paid != null ? stripeInvoice.amount_paid : stripeInvoice.amount_due,
      currency,
    );
    const applied = Math.max(0, Math.round((collected - fee) * 100) / 100);

    await db.Payment.create({
      id: uuidv4(),
      invoiceId: invoice.id,
      provider: 'stripe',
      providerRef,
      amount: applied,
      processingFee: fee,
      methodLabel: stripeInvoice.metadata?.cadenceMethodLabel || 'Credit / Debit Card (Stripe)',
      paidAt: stripeInvoice.status_transitions?.paid_at
        ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
        : new Date(),
    });

    // Stripe saying "this Stripe invoice is paid" is not the same as "our invoice
    // is settled" once part payments exist: a $500 charge against a $2,000
    // invoice settles Stripe's side in full while $1,500 is still owed here. Our
    // own Payment rows are the source of truth for that.
    const total = Number(invoice.total) || 0;
    const paidRows = await db.Payment.findAll({ where: { invoiceId: invoice.id }, attributes: ['amount'] });
    const totalPaid = Math.round(paidRows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100) / 100;
    const remaining = Math.round(Math.max(0, total - totalPaid) * 100) / 100;
    const fullySettled = remaining <= 0.005;

    if (fullySettled) {
      if (invoice.status !== INVOICE_STATUS.PAID && invoice.status !== 'paid') {
        await invoice.update({ status: INVOICE_STATUS.PAID });
      }
    } else {
      // Detach the settled Stripe invoice so the next attempt builds a fresh page
      // for the new, smaller balance instead of resuming a paid one.
      const stillOpen = invoice.dueAt && invoice.dueAt < new Date().toISOString().split('T')[0]
        ? INVOICE_STATUS.OVERDUE
        : INVOICE_STATUS.SENT;
      await invoice.update({
        status: stillOpen,
        stripeInvoiceId: null,
        stripeHostedUrl: null,
        stripePartialAmount: null,
      });
    }

    PortalNotificationService.notify(invoice.clientId, invoice.orgId, {
      type: fullySettled ? 'invoice_paid' : 'invoice_part_paid',
      title: fullySettled
        ? `Payment received: ${invoice.number}`
        : `Part payment received: ${invoice.number}`,
      body: fullySettled
        ? `Thank you — your card payment for invoice ${invoice.number} has been received and the invoice is now marked paid.`
        : `Thank you — ${invoice.currency || ''} ${applied.toFixed(2)} received by card. ${invoice.currency || ''} ${remaining.toFixed(2)} remains outstanding on invoice ${invoice.number}, payable any time from the portal.`.replace(/\s+/g, ' ').trim(),
      refTable: 'invoices',
      refId: invoice.id,
    }).catch(() => {});

    await this._notifyStaff(invoice, {
      type: 'payment_received',
      title: fullySettled
        ? `Card payment received: ${invoice.number}`
        : `Part card payment received: ${invoice.number}`,
      body: fullySettled
        ? `${invoice.currency || ''} ${applied.toFixed(2)} paid by card via Stripe. Invoice marked paid automatically.`.trim()
        : `${invoice.currency || ''} ${applied.toFixed(2)} paid by card via Stripe. ${invoice.currency || ''} ${remaining.toFixed(2)} still outstanding — the invoice stays open.`.trim(),
    });

    return { ok: true, invoiceId: invoice.id, fullySettled, remaining };
  }

  async _onPaymentFailed(stripeInvoice) {
    const invoice = await this._localInvoiceFor(stripeInvoice);
    if (!invoice) return { ignored: 'unknown_invoice' };
    await this._notifyStaff(invoice, {
      type: 'payment_failed',
      title: `Card payment failed: ${invoice.number}`,
      body: 'The client\'s card payment did not go through. They can retry from the portal, or settle another way.',
    });
    return { ok: true };
  }

  /**
   * The Stripe invoice was voided or written off. Detach it so the client can
   * start a clean payment rather than being redirected to a dead Stripe page.
   */
  async _onInvoiceCancelled(stripeInvoice) {
    const invoice = await this._localInvoiceFor(stripeInvoice);
    if (!invoice) return { ignored: 'unknown_invoice' };
    if (invoice.status === INVOICE_STATUS.PAID || invoice.status === 'paid') return { ok: true };
    await invoice.update({ stripeInvoiceId: null, stripeHostedUrl: null });
    return { ok: true };
  }

  /** In-app notification to admins + anyone with billing.read. */
  async _notifyStaff(invoice, payload) {
    try {
      const users = await db.User.findAll({
        where: { orgId: invoice.orgId },
        include: [{ model: db.Role, as: 'role' }],
      });
      const recipients = users.filter((u) =>
        ['super_admin', 'admin'].includes(u.role?.key) || u.role?.permissions?.['billing.read']);
      await Promise.all(recipients.map((u) => NotificationService.notify(u.id, invoice.orgId, {
        ...payload,
        refTable: 'invoices',
        refId: invoice.id,
      })));
    } catch (err) {
      console.error('[StripeService] staff notification failed:', err.message);
    }
  }
}

module.exports = new StripeService();
module.exports.processingFeeFor = processingFeeFor;
