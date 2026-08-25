/**
 * Card payments for portal invoices, via Stripe Checkout Sessions (mode:
 * "payment") — deliberately NOT Stripe Invoices.
 *
 * We used to create a real Stripe Invoice per payment (`stripe.invoices.*`).
 * That's the wrong tool here: Stripe's Invoicing product bills an extra ~0.4%
 * fee per paid invoice, on top of ordinary card processing, and we don't need
 * anything Invoicing provides — our own InvoiceService/EmailService already
 * generates and emails the invoice document the client actually sees. Stripe's
 * invoice was never shown to the client as "the invoice"; only its
 * `hosted_invoice_url` payment page was ever used, built fresh on demand each
 * time the client clicked Pay. A Checkout Session gives the exact same
 * redirect-to-pay experience (`session.url`) without ever touching the
 * Invoicing API, so the 0.4% fee simply doesn't apply.
 *
 * Reconciliation — the reason Invoices were chosen originally — is preserved
 * through `metadata.cadenceInvoiceId`/`cadenceDocumentId` on the session
 * instead of through a durable Stripe-side invoice record: the webhook (and
 * `syncFromStripe`) resolve our row from that metadata, never from a Stripe
 * invoice object.
 *
 * IMPORTANT: never set `invoice_creation` on a Checkout Session created here.
 * That flag is what turns a session back into a real Stripe Invoice and
 * re-introduces the fee this rewrite exists to remove.
 *
 * The flow:
 *   1. Client picks "Credit / Debit Card" on a portal invoice.
 *   2. startPayment() ensures a Stripe Customer, creates a Checkout Session
 *      with one line item per InvoiceLine (plus a processing-fee line if the
 *      client is absorbing it), and hands back session.url.
 *   3. Client pays on Stripe's hosted Checkout page.
 *   4. Stripe POSTs `checkout.session.completed` (or the async variant) to
 *      /api/stripe/webhook, which records the Payment and flips our invoice to
 *      `paid`. No human in the loop.
 *
 * Everything here degrades to a clean 503 when STRIPE_ENABLED is off or the
 * secret key is blank, so the rest of billing keeps working un-configured.
 */
const Stripe = require('stripe');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');
const SubscriptionService = require('./SubscriptionService');
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
 * Charged to the client by default — it becomes a line item on the Checkout
 * Session so the agency receives its invoice total intact. A currency with no
 * configured rule charges nothing, rather than inventing a surcharge for a rate nobody
 * set. `chargeFee: false` (Client.chargeCardFee unticked — see the Pay via CRM
 * section on the client page) absorbs it into the agency's side instead, for
 * both ordinary invoices and quotation/agreement/proposal payments.
 */
async function processingFeeFor(orgId, amount, currency, { chargeFee = true } = {}) {
  if (!chargeFee) return 0;
  const db = require('../models');
  return db.PaymentFeeRule.feeFor(orgId, currency, amount).catch(() => 0);
}

/**
 * A stable reference for the money that settled a Checkout Session, used as
 * the dedupe key for Payment rows. `session.payment_intent` is always a flat
 * string id on a Checkout Session (no object-vs-string ambiguity like an
 * Invoice's payment_intent had), so it's used directly; the session id is the
 * last-resort fallback — unique per session, which is all the idempotency
 * guard actually needs.
 */
function extractPaymentRef(session) {
  const pi = session?.payment_intent;
  if (typeof pi === 'string' && pi) return pi;
  if (pi?.id) return pi.id;
  return session?.id || null;
}

/** Where the Front End lives, for building Checkout success/cancel redirects. */
function frontendBase() {
  return String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
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
   * Reuse the Checkout Session already attached to this row when it's still
   * payable, so a client who closed the tab lands back on the same page instead
   * of creating a second session for the same money.
   *
   * `invoice.stripeInvoiceId` holds a Checkout Session id (field name kept from
   * the pre-rewrite Invoice-based flow to avoid a schema change).
   *
   * Returns a hosted URL to resume, `{ alreadyPaid: true }` if Stripe says it's
   * settled (in which case we reconcile immediately), or null to create fresh.
   */
  async _resumeExisting(invoice) {
    if (!invoice.stripeInvoiceId) return null;
    const s = stripe();
    let existing;
    try {
      existing = await s.checkout.sessions.retrieve(invoice.stripeInvoiceId);
    } catch {
      return null; // Vanished or belongs to another Stripe account — start over.
    }

    if (existing.status === 'complete') {
      // Reconciles it here and now. `fullySettled` distinguishes "the invoice is
      // done" from "an earlier part payment cleared" — the second is a reason to
      // carry on and collect the rest, not to stop.
      const result = await this._markPaidFromSession(existing);
      return { alreadyPaid: true, fullySettled: result?.fullySettled !== false };
    }
    if (existing.status === 'open' && existing.url) {
      return { url: existing.url, stripeInvoiceId: existing.id, resumed: true };
    }
    // expired — abandon it and build a new one.
    return null;
  }

  /**
   * Create a Stripe Checkout Session for one of our invoices and return the
   * hosted payment URL the portal should redirect to.
   *
   * `payAmount` lets the client settle part of the balance now — a $2,000 invoice
   * can be paid $500 at a time, with the remainder staying outstanding here. When
   * it's a part payment the session carries a single "part payment" line item
   * for exactly that amount instead of mirroring the full line items, so the page
   * the client lands on asks for the figure they chose and nothing else.
   */
  /**
   * Serialize payment attempts per invoice.
   *
   * Two concurrent calls both read the same open Checkout Session, both expire
   * it, and both create a replacement — leaving two payable pages for one
   * balance. A public, unauthenticated endpoint makes that trivially reachable
   * by anyone holding the link (double-click, refresh loop, or deliberately),
   * and with no webhook the second payment would go unnoticed.
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

    // Reconcile any existing Checkout Session FIRST, so the balance below is
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
      // The expire MUST succeed before we forget this invoice. Swallowing the
      // error left a still-payable Stripe page live with no reference to it on
      // our side — the client could pay the old page and the new one, and with
      // no webhook we'd never learn about the first. Failing loudly keeps the
      // old page as the only payable one, which is recoverable; orphaning it is
      // not.
      try {
        await s.checkout.sessions.expire(openStripeInvoiceId);
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
    const fee = await processingFeeFor(orgId, chargeAmount, currency, { chargeFee: invoice.client?.chargeCardFee !== false });
    // How long the payment page stays open, set by the admin rather than the
    // deploy. Checkout Sessions cap out at 24h regardless of what's configured.
    const settings = await db.PaymentSetting.resolve(orgId).catch(() => null);
    const dueDays = Math.max(0, settings?.invoiceDueDays ?? 7);
    const expiresAt = Math.floor(Date.now() / 1000)
      + Math.min(Math.max(dueDays, 1) * 86400, 23 * 3600 + 59 * 60);

    const lineItems = [];
    if (isPartPayment) {
      // One explicit line. Mirroring the full scope and then discounting it down
      // would show the client a page they can't reconcile against the figure they
      // just typed.
      lineItems.push({
        price_data: {
          currency,
          unit_amount: toMinorUnits(chargeAmount, currency),
          product_data: {
            name: `Part payment for invoice ${invoice.number} (balance ${invoice.currency} ${(amountDue - chargeAmount).toFixed(2)} remains)`.slice(0, 300),
          },
        },
        quantity: 1,
      });
    } else {
      // Partial prior payments already cleared: a Checkout line item can't go
      // negative like the old Stripe-invoice credit line could, so a partially
      // paid invoice collects the remaining balance as a single line instead of
      // mirroring the full scope alongside a credit.
      const alreadyPaid = Math.round((total - amountDue) * 100) / 100;
      const lines = alreadyPaid > 0 ? [] : (invoice.lines || []);
      if (lines.length) {
        for (const line of lines) {
          const lineAmount = Number(line.amount) || (Number(line.qty) || 0) * (Number(line.unitPrice) || 0);
          if (lineAmount <= 0) continue;
          lineItems.push({
            price_data: {
              currency,
              unit_amount: toMinorUnits(lineAmount, currency),
              product_data: { name: String(line.description || 'Services').slice(0, 300) },
            },
            quantity: 1,
          });
        }
      }
      if (!lineItems.length) {
        lineItems.push({
          price_data: {
            currency,
            unit_amount: toMinorUnits(amountDue, currency),
            product_data: { name: `Invoice ${invoice.number}` },
          },
          quantity: 1,
        });
      }
    }

    if (fee > 0) {
      lineItems.push({
        price_data: {
          currency,
          unit_amount: toMinorUnits(fee, currency),
          product_data: { name: 'Card processing fee' },
        },
        quantity: 1,
      });
    }

    const metadata = {
      cadenceInvoiceId: invoice.id,
      cadenceOrgId: orgId,
      cadenceInvoiceNumber: invoice.number,
      cadenceClientId: invoice.clientId,
      cadenceProcessingFee: String(fee),
      cadenceChargeAmount: String(chargeAmount),
      cadencePartPayment: isPartPayment ? '1' : '0',
      cadenceMethodLabel: method?.label || 'Credit / Debit Card (Stripe)',
    };

    const returnBase = invoice.publicToken
      ? `${frontendBase()}/invoice/${invoice.publicToken}`
      : `${frontendBase()}/invoices/${invoice.id}`;

    // Deliberately no `invoice_creation` here — that's what would turn this
    // back into a billed Stripe Invoice. See the file header.
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: lineItems,
      success_url: `${returnBase}?payment=success`,
      cancel_url: `${returnBase}?payment=cancelled`,
      expires_at: expiresAt,
      // Echoed back on every webhook — this is how we map Stripe's callback to
      // our row without trusting anything client-supplied.
      metadata,
      payment_intent_data: { metadata },
    });

    if (!session.url) {
      const err = new Error('Stripe did not return a payment link. Please try again or use another payment method.');
      err.status = 502;
      throw err;
    }

    await invoice.update({
      stripeInvoiceId: session.id,
      stripeHostedUrl: session.url,
      // Remembered so a later attempt for a different figure knows to expire this
      // page rather than sending the client back to the old amount.
      stripePartialAmount: isPartPayment ? chargeAmount : null,
    });

    return {
      url: session.url,
      stripeInvoiceId: session.id,
      amountDue,
      chargeAmount,
      isPartPayment,
      remainingAfter: Math.round((amountDue - chargeAmount) * 100) / 100,
      processingFee: fee,
      currency: invoice.currency,
    };
  }

  /**
   * Pay-before-convert for a CustomerDocument (quotation/agreement/proposal).
   *
   * A real Client, Project and Invoice only get created once Stripe confirms
   * the money actually landed (see _convertAndMarkPaidFromDocument, invoked
   * from the webhook) — nothing exists yet at this point. That's deliberate:
   * the old flow converted (and raised an invoice) as soon as the client
   * submitted billing details, so a client who then declined to pay left an
   * unpaid invoice — and a live project — sitting in the system. Paying first
   * means a declined/abandoned checkout leaves no trace at all; the document
   * just sits at "approved" and Pay Now is still there to click again.
   *
   * No part-payment here (unlike invoice payments): the document total is a
   * single up-front commitment, not a balance to chip away at.
   */
  async startDocumentPayment(documentId, orgId) {
    return this._withInvoiceLock(`doc:${documentId}`, () => this._startDocumentPaymentLocked(documentId, orgId));
  }

  async _startDocumentPaymentLocked(documentId, orgId) {
    const s = stripe();
    const document = await db.CustomerDocument.findOne({ where: { id: documentId, orgId } });
    if (!document) {
      const err = new Error('Document not found.');
      err.status = 404;
      throw err;
    }
    if (document.status !== 'approved') {
      const err = new Error('This document has not been approved yet.');
      err.status = 409;
      throw err;
    }
    if (!document.detailsSubmittedAt) {
      const err = new Error('Please submit your billing details before paying.');
      err.status = 409;
      throw err;
    }
    if (document.convertedClientId || document.convertedProjectId) {
      const err = new Error('This document has already been converted — an invoice already exists for it.');
      err.status = 409;
      throw err;
    }

    const amount = Math.round((Number(document.amount) || 0) * 100) / 100;
    if (!(amount > 0)) {
      const err = new Error('There is nothing to charge on this document.');
      err.status = 400;
      throw err;
    }
    const currency = String(document.currency || 'USD').toLowerCase();

    // Resume an already-open Stripe page for this same document (refresh, or a
    // second click before the first page loaded) instead of spawning a second
    // payable page for the same money. `document.stripeInvoiceId` holds a
    // Checkout Session id (field name kept from the pre-rewrite Invoice-based
    // flow to avoid a schema change).
    if (document.stripeInvoiceId) {
      try {
        const existing = await s.checkout.sessions.retrieve(document.stripeInvoiceId);
        if (existing.status === 'open' && existing.url) {
          return { url: existing.url, resumed: true, amount, currency: document.currency };
        }
        // 'complete' means the webhook already converted this (convertedClientId
        // would be set above); 'expired' falls through to create fresh.
      } catch {
        // Vanished or belongs to another Stripe account — fall through and build a new one.
      }
    }

    // Reuse the linked client's Stripe Customer when this document already
    // points at a real client; otherwise a fresh Customer keyed to the
    // prospect's own details — there's no Client row yet, convert() creates
    // one once payment clears, and _convertAndMarkPaidFromDocument attaches
    // this same Customer id to it.
    let customerId = null;
    let chargeFee = true;
    if (document.clientId) {
      const client = await db.Client.findByPk(document.clientId);
      if (client) {
        customerId = await this._ensureCustomer(client, { email: document.email });
        chargeFee = client.chargeCardFee !== false;
      }
    }
    if (!customerId) {
      const customer = await s.customers.create({
        name: document.businessName || document.prospectName || undefined,
        email: document.email || undefined,
        metadata: { cadenceDocumentId: document.id, cadenceOrgId: orgId },
      });
      customerId = customer.id;
    }

    const fee = await processingFeeFor(orgId, amount, currency, { chargeFee });
    const settings = await db.PaymentSetting.resolve(orgId).catch(() => null);
    const dueDays = Math.max(0, settings?.invoiceDueDays ?? 7);
    const expiresAt = Math.floor(Date.now() / 1000)
      + Math.min(Math.max(dueDays, 1) * 86400, 23 * 3600 + 59 * 60);
    const typeLabel = String(document.type || 'document');
    const typeTitle = typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1);

    const lineItems = [{
      price_data: {
        currency,
        unit_amount: toMinorUnits(amount, currency),
        product_data: { name: `${typeTitle} ${document.number}` },
      },
      quantity: 1,
    }];
    if (fee > 0) {
      lineItems.push({
        price_data: {
          currency,
          unit_amount: toMinorUnits(fee, currency),
          product_data: { name: 'Card processing fee' },
        },
        quantity: 1,
      });
    }

    const metadata = {
      // Distinguishes this from an ordinary invoice payment in the webhook —
      // see StripeService.handleEvent. No cadenceInvoiceId: none exists yet.
      cadenceDocumentId: document.id,
      cadenceOrgId: orgId,
      cadenceDocumentNumber: document.number,
      cadenceProcessingFee: String(fee),
      cadenceMethodLabel: 'Credit / Debit Card (Stripe)',
    };
    const returnBase = `${frontendBase()}/review/${document.publicToken}`;

    // Deliberately no `invoice_creation` here — see the file header.
    const session = await s.checkout.sessions.create({
      mode: 'payment',
      customer: customerId,
      line_items: lineItems,
      success_url: `${returnBase}?payment=success`,
      cancel_url: `${returnBase}?payment=cancelled`,
      expires_at: expiresAt,
      metadata,
      payment_intent_data: { metadata },
    });

    if (!session.url) {
      const err = new Error('Stripe did not return a payment link. Please try again or use another payment method.');
      err.status = 502;
      throw err;
    }

    await document.update({ stripeInvoiceId: session.id, stripeHostedUrl: session.url });

    return { url: session.url, resumed: false, amount, currency: document.currency, processingFee: fee };
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

    let session;
    try {
      session = await stripe().checkout.sessions.retrieve(invoice.stripeInvoiceId);
    } catch (err) {
      const e = new Error(`Could not reach Stripe for this invoice: ${err.message}`);
      e.status = 502;
      throw e;
    }

    if (session.status === 'complete') {
      const result = await this._markPaidFromSession(session);
      if (result?.fullySettled === false) {
        return {
          status: 'part_paid',
          message: `Part payment confirmed with Stripe — ${invoice.currency || ''} ${Number(result.remaining).toFixed(2)} is still outstanding, so the invoice stays open.`.replace(/\s+/g, ' ').trim(),
        };
      }
      return { status: 'paid', message: 'Payment confirmed with Stripe — the invoice is now marked paid.' };
    }

    return {
      status: session.status,
      message: `Stripe reports this payment page as "${session.status}" — no payment has cleared yet.`,
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
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const obj = event.data.object;
        if (event.type === 'checkout.session.completed' && obj?.payment_status !== 'paid') {
          // Card payments settle synchronously, so this only fires for an
          // async payment method still pending — wait for the async event.
          return { ignored: 'payment_not_yet_paid' };
        }
        // A pay-before-convert document payment (see startDocumentPayment)
        // carries cadenceDocumentId instead of cadenceInvoiceId — no Invoice
        // row exists yet, so it needs the conversion step first.
        if (obj?.metadata?.cadenceDocumentId) return this._convertAndMarkPaidFromDocument(obj);
        return this._markPaidFromSession(obj);
      }
      case 'checkout.session.async_payment_failed':
        return this._onPaymentFailed(event.data.object);
      case 'checkout.session.expired':
        return this._onInvoiceCancelled(event.data.object);
      default:
        return { ignored: event.type };
    }
  }

  /** Resolve our Invoice row from a Checkout Session object. */
  async _localInvoiceFor(session) {
    const localId = session?.metadata?.cadenceInvoiceId;
    if (localId) {
      const byMeta = await db.Invoice.findByPk(localId);
      if (byMeta) return byMeta;
    }
    if (session?.id) {
      return db.Invoice.findOne({ where: { stripeInvoiceId: session.id } });
    }
    return null;
  }

  /**
   * The money actually landed. Records a Payment, marks the invoice paid, and
   * notifies both sides.
   *
   * Idempotent on the Stripe reference: Stripe retries webhooks, and both
   * `checkout.session.completed` and `checkout.session.async_payment_succeeded`
   * can fire for a single payment, so this runs 2+ times per payment as a
   * matter of course. Without the guard the client would show as having paid
   * twice.
   */
  async _markPaidFromSession(session) {
    const invoice = await this._localInvoiceFor(session);
    if (!invoice) return { ignored: 'unknown_invoice' };

    const providerRef = extractPaymentRef(session);

    const existing = await db.Payment.findOne({
      where: { invoiceId: invoice.id, providerRef },
    });
    if (existing) return { ok: true, deduped: true };

    const currency = session.currency || invoice.currency;
    const fee = Number(session.metadata?.cadenceProcessingFee) || 0;
    // What Stripe collected, less any surcharge — the surcharge is fee recovery,
    // not revenue against the invoice, so the invoice settles to exactly its own
    // total instead of looking overpaid.
    const collected = fromMinorUnits(session.amount_total, currency);
    const applied = Math.max(0, Math.round((collected - fee) * 100) / 100);

    await db.Payment.create({
      id: uuidv4(),
      invoiceId: invoice.id,
      provider: 'stripe',
      providerRef,
      amount: applied,
      processingFee: fee,
      methodLabel: session.metadata?.cadenceMethodLabel || 'Credit / Debit Card (Stripe)',
      paidAt: new Date(),
    });

    // Stripe saying "this Checkout Session is complete" is not the same as "our
    // invoice is settled" once part payments exist: a $500 charge against a
    // $2,000 invoice settles Stripe's side in full while $1,500 is still owed
    // here. Our own Payment rows are the source of truth for that.
    const total = Number(invoice.total) || 0;
    const paidRows = await db.Payment.findAll({ where: { invoiceId: invoice.id }, attributes: ['amount'] });
    const totalPaid = Math.round(paidRows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) * 100) / 100;
    const remaining = Math.round(Math.max(0, total - totalPaid) * 100) / 100;
    const fullySettled = remaining <= 0.005;

    if (fullySettled) {
      if (invoice.status !== INVOICE_STATUS.PAID && invoice.status !== 'paid') {
        await invoice.update({ status: INVOICE_STATUS.PAID });
      }
      // Lazy require — InvoiceService requires this file back (for the "Pay"
      // button's Stripe link), so a top-level require here would deadlock on
      // module load.
      require('./InvoiceService').sendPaymentThankYou(invoice, invoice.orgId, {
        amount: applied,
        currency,
        methodLabel: session.metadata?.cadenceMethodLabel || 'Credit / Debit Card (Stripe)',
      }).catch(() => {});
    } else {
      // Detach the completed Checkout Session so the next attempt builds a fresh
      // page for the new, smaller balance instead of resuming a paid one.
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

    // A card payment is the one path where the client is sitting in front of the
    // portal waiting for the subscription to come back on, so resync the
    // entitlement here rather than leaving it to the 6-hourly sweep.
    SubscriptionService.syncForInvoice(invoice.id).catch(() => {});

    return { ok: true, invoiceId: invoice.id, fullySettled, remaining };
  }

  /**
   * The other half of startDocumentPayment: Stripe confirms a document's
   * up-front payment cleared, so NOW — for the first time — convert it into a
   * real Client/Project/Invoice (the exact same CustomerDocumentService.convert
   * an admin's "Convert to Project" button calls), then mark the invoice it
   * produced as paid via the normal _markPaidFromSession path.
   *
   * Idempotent: a webhook retry (or `checkout.session.completed` +
   * `checkout.session.async_payment_succeeded` both firing) finds the document
   * already converted and skips straight to marking paid, which is itself
   * deduped on the Stripe payment reference.
   */
  async _convertAndMarkPaidFromDocument(session) {
    const documentId = session?.metadata?.cadenceDocumentId;
    if (!documentId) return { ignored: 'no_document_id' };

    const document = await db.CustomerDocument.findByPk(documentId);
    if (!document) return { ignored: 'unknown_document' };

    // Always a flat string id on a Checkout Session — no object-vs-string
    // branch needed here (unlike the old Invoice object's `customer` field).
    const stripeCustomerId = session.customer || null;

    if (!document.convertedClientId && !document.convertedProjectId) {
      const CustomerDocumentService = require('./CustomerDocumentService');
      let result = null;
      try {
        result = await CustomerDocumentService.convert(document.id, document.orgId, null, {});
      } catch (err) {
        // An admin converted it manually in the meantime (race between the
        // client paying and staff acting on the submitted details) — fine,
        // fall through to find and mark paid whatever invoice that produced.
        if (!/already been converted/i.test(err.message || '')) {
          console.error(`[StripeService] Payment cleared for document ${document.number} but conversion failed:`, err.stack || err.message);
          await this._notifyOrgAdmins(document.orgId, {
            type: 'payment_received',
            title: `Payment received but conversion failed: ${document.number}`,
            body: `A card payment for ${document.type} ${document.number} was collected by Stripe, but converting it to a client/project/invoice failed: ${err.message}. This needs a manual fix — the money is real, nothing was created for it yet.`,
          });
          return { ignored: 'convert_failed', error: err.message };
        }
      }

      if (result?.client) {
        // They just paid by card — keep billing this client through Stripe
        // from here on, same as an admin turning on "Pay via CRM" manually.
        await result.client.update({
          billingMode: 'stripe',
          stripeCustomerId: stripeCustomerId || result.client.stripeCustomerId,
        }).catch(() => {});
      }
      const invoice = result?.invoices?.[0];
      if (invoice) {
        await db.Invoice.update({ stripeInvoiceId: session.id }, { where: { id: invoice.id } });
      }
    }

    await document.reload();

    // Resolve the invoice to mark paid: normally the one just wired above; on
    // the race-condition path (admin converted first) it isn't linked to this
    // session yet, so fall back to the client's most recent unpaid one.
    let localInvoice = await db.Invoice.findOne({ where: { stripeInvoiceId: session.id } });
    if (!localInvoice && document.convertedClientId) {
      localInvoice = await db.Invoice.findOne({
        where: { orgId: document.orgId, clientId: document.convertedClientId, status: { [Op.ne]: INVOICE_STATUS.PAID } },
        order: [['createdAt', 'DESC']],
      });
      if (localInvoice) await localInvoice.update({ stripeInvoiceId: session.id });
    }
    if (!localInvoice) {
      console.error(`[StripeService] Paid document ${document.number} but no invoice could be resolved to mark paid — needs manual reconciliation.`);
      await this._notifyOrgAdmins(document.orgId, {
        type: 'payment_received',
        title: `Payment received, invoice not found: ${document.number}`,
        body: `A card payment for ${document.type} ${document.number} was collected, but no invoice could be matched to mark paid. Please check Billing and reconcile manually.`,
      });
      return { ignored: 'no_invoice_to_mark' };
    }

    return this._markPaidFromSession(session);
  }

  async _onPaymentFailed(session) {
    const invoice = await this._localInvoiceFor(session);
    if (!invoice) return { ignored: 'unknown_invoice' };
    await this._notifyStaff(invoice, {
      type: 'payment_failed',
      title: `Card payment failed: ${invoice.number}`,
      body: 'The client\'s card payment did not go through. They can retry from the portal, or settle another way.',
    });
    return { ok: true };
  }

  /**
   * The Checkout Session expired unpaid. Detach it so the client can start a
   * clean payment rather than being redirected to a dead Stripe page.
   */
  async _onInvoiceCancelled(session) {
    const invoice = await this._localInvoiceFor(session);
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

  /** Same recipients as _notifyStaff, for cases with no Invoice row yet to hang the notification off. */
  async _notifyOrgAdmins(orgId, payload) {
    try {
      const users = await db.User.findAll({
        where: { orgId },
        include: [{ model: db.Role, as: 'role' }],
      });
      const recipients = users.filter((u) =>
        ['super_admin', 'admin'].includes(u.role?.key) || u.role?.permissions?.['billing.read']);
      await Promise.all(recipients.map((u) => NotificationService.notify(u.id, orgId, payload)));
    } catch (err) {
      console.error('[StripeService] admin notification failed:', err.message);
    }
  }
}

module.exports = new StripeService();
module.exports.processingFeeFor = processingFeeFor;
