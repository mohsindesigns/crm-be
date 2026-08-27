const { Op } = require('sequelize');
const db = require('../models');
const { INVOICE_STATUS } = require('../config/constants');

/**
 * Subscriptions — the recurring lines the agency RESELLS rather than delivers:
 * hosting (Hostinger), domains, SSL, mailbox seats, licences.
 *
 * There is no separate subscription table. A subscription is a `Package` with
 * `isSubscription: true`, sold exactly like any other package, so it reuses the
 * whole existing chain untouched:
 *
 *   Package(isSubscription) -> ClientPackage -> Retainer -> Invoice
 *
 * The one thing subscriptions add is an ENTITLEMENT: agency work carries on
 * while an invoice is chased, but a resold subscription the client hasn't paid
 * for is not theirs to use. `ClientPackage.entitlement` is that switch, and this
 * service is the only thing that writes it — always DERIVED from the
 * subscription's own invoices, never set by hand, so it can't drift out of step
 * with billing:
 *
 *   cancelled sale ................................ 'cancelled'
 *   any unpaid invoice past its due date .......... 'suspended'
 *   billed but nothing paid yet ................... 'pending_payment'
 *   otherwise (paid up, or nothing to pay) ........ 'active'
 *
 * Non-subscription packages are always forced back to 'active' — the flag is
 * deliberately inert for them so that adding it changed nothing about how normal
 * service packages behave.
 */

const ENTITLEMENT = {
  ACTIVE: 'active',
  PENDING_PAYMENT: 'pending_payment',
  SUSPENDED: 'suspended',
  CANCELLED: 'cancelled',
};

// Invoice states that still represent money owed. `payment_review` counts as
// open — the client says they've paid but nobody has confirmed it, so the
// subscription shouldn't switch back on yet. `draft` counts too: an installment
// or future cycle that exists but hasn't been issued is still unpaid.
const OPEN_STATUSES = [
  INVOICE_STATUS.DRAFT,
  INVOICE_STATUS.SENT,
  INVOICE_STATUS.OVERDUE,
  INVOICE_STATUS.PAYMENT_REVIEW,
];

/**
 * The label a sold package gets on its invoice line.
 *
 * Subscriptions are called out separately from recurring agency work — and name
 * their vendor — because they are the lines whose access actually switches off
 * when the invoice goes unpaid, so "which of these is my hosting?" has to be
 * answerable from the invoice alone. Non-subscription output is byte-identical
 * to what it was before subscriptions existed ("SEO — Growth (Recurring ·
 * monthly)"), so existing invoices keep reading the same.
 */
function billingLineLabel({ label, isSubscription, isRecurring, vendor }, cycle) {
  const period = cycle || 'monthly';
  if (isSubscription) {
    return `${label} (Subscription · ${period}${vendor ? ` · ${vendor}` : ''})`;
  }
  return `${label} (${isRecurring ? `Recurring · ${period}` : 'One-time'})`;
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

class SubscriptionService {
  /**
   * Every invoice that bills any part of this sold package.
   *
   * Checked on BOTH sides on purpose: the invoice header's `clientPackageId` is
   * cleared whenever two package sales are merged onto one bill
   * (InvoiceService#_appendLinesToInvoice), so a header-only lookup silently
   * misses exactly the invoices a client with several subscriptions has. The
   * per-line `clientPackageId` survives that merge; the header lookup stays for
   * rows created before that column existed.
   */
  async _invoicesFor(clientPackageId) {
    const lineInvoiceIds = (await db.InvoiceLine.findAll({
      where: { clientPackageId },
      attributes: ['invoiceId'],
    })).map((l) => l.invoiceId);

    return db.Invoice.findAll({
      where: {
        [Op.or]: [
          { clientPackageId },
          ...(lineInvoiceIds.length ? [{ id: { [Op.in]: lineInvoiceIds } }] : []),
        ],
      },
      attributes: ['id', 'number', 'status', 'dueAt', 'total'],
      order: [['issuedAt', 'ASC']],
    });
  }

  /** Derives {entitlement, entitlementReason} from a sale and its invoices. */
  _derive(clientPackage, invoices) {
    if (clientPackage.status === 'cancelled') {
      return { entitlement: ENTITLEMENT.CANCELLED, entitlementReason: 'The subscription was cancelled.' };
    }

    // A voided invoice was written off — it neither owes money nor proves payment.
    const live = invoices.filter((i) => i.status !== INVOICE_STATUS.VOID);
    const open = live.filter((i) => OPEN_STATUSES.includes(i.status));
    const paid = live.filter((i) => i.status === INVOICE_STATUS.PAID);

    const today = todayStr();
    // `status === 'overdue'` alone isn't enough: RetainerScheduler only stamps
    // that every 6 hours, so compare the due date directly as well.
    const pastDue = open.find((i) => i.status === INVOICE_STATUS.OVERDUE
      || (i.dueAt && String(i.dueAt).slice(0, 10) < today && i.status !== INVOICE_STATUS.DRAFT));
    if (pastDue) {
      return {
        entitlement: ENTITLEMENT.SUSPENDED,
        entitlementReason: `Invoice ${pastDue.number} is overdue.`,
      };
    }

    if (open.length > 0 && paid.length === 0) {
      return {
        entitlement: ENTITLEMENT.PENDING_PAYMENT,
        entitlementReason: `Awaiting payment of invoice ${open[0].number}.`,
      };
    }

    // Paid up, or a free/unbilled subscription with nothing outstanding.
    return { entitlement: ENTITLEMENT.ACTIVE, entitlementReason: null };
  }

  /**
   * Recomputes and persists one sold package's entitlement. Safe to call
   * repeatedly — it writes only when the derived value actually changed, so it
   * can sit on hot paths (every payment, every scheduler pass) without churning
   * rows. Returns the ClientPackage, or null when there's nothing to do.
   */
  async syncEntitlement(clientPackageId) {
    if (!clientPackageId) return null;
    const clientPackage = await db.ClientPackage.findByPk(clientPackageId, {
      include: [{ model: db.Package, as: 'package', attributes: ['id', 'isSubscription'] }],
    });
    if (!clientPackage) return null;

    let next;
    if (!clientPackage.package?.isSubscription) {
      // Not a subscription — the entitlement switch doesn't apply. Kept pinned to
      // 'active' rather than left at whatever it happened to hold, so a package
      // that's later un-flagged as a subscription doesn't stay stuck suspended.
      next = { entitlement: ENTITLEMENT.ACTIVE, entitlementReason: null };
    } else {
      next = this._derive(clientPackage, await this._invoicesFor(clientPackage.id));
    }

    if (clientPackage.entitlement !== next.entitlement
      || (clientPackage.entitlementReason || null) !== (next.entitlementReason || null)) {
      await clientPackage.update(next);
    }
    return clientPackage;
  }

  /**
   * Resyncs every subscription an invoice touches — called after anything that
   * moves money (a recorded payment, a Stripe webhook, a status change), so the
   * portal reflects the new state on the client's very next page load rather
   * than waiting for the scheduler.
   */
  async syncForInvoice(invoiceId) {
    if (!invoiceId) return [];
    const invoice = await db.Invoice.findByPk(invoiceId, { attributes: ['id', 'clientPackageId'] });
    if (!invoice) return [];
    const lineIds = (await db.InvoiceLine.findAll({
      where: { invoiceId, clientPackageId: { [Op.ne]: null } },
      attributes: ['clientPackageId'],
    })).map((l) => l.clientPackageId);

    const ids = [...new Set([invoice.clientPackageId, ...lineIds].filter(Boolean))];
    const out = [];
    for (const id of ids) out.push(await this.syncEntitlement(id));
    return out.filter(Boolean);
  }

  /**
   * Full sweep over every subscription sale in every org — the backstop that
   * catches an entitlement no event touched, above all a renewal invoice quietly
   * going past due. Runs off RetainerScheduler's existing 6-hourly pass rather
   * than a scheduler of its own, immediately after that pass has stamped
   * invoices overdue, so the two always agree.
   */
  async syncAll() {
    const sales = await db.ClientPackage.findAll({
      attributes: ['id', 'entitlement'],
      include: [{
        model: db.Package,
        as: 'package',
        attributes: [],
        required: true,
        where: { isSubscription: true },
      }],
    });
    let changed = 0;
    for (const sale of sales) {
      try {
        const updated = await this.syncEntitlement(sale.id);
        if (updated && updated.entitlement !== sale.entitlement) changed += 1;
      } catch (err) {
        console.error(`[SubscriptionService] entitlement sync failed for ${sale.id}:`, err.message);
      }
    }
    return { scanned: sales.length, changed };
  }

  /**
   * The client-facing view of everything a client subscribes to — what the
   * portal renders and what the client detail page's Subscriptions group shows.
   * Each row carries the vendor, the renewal date (the retainer's own
   * nextInvoiceDate, i.e. the real next bill), the entitlement, and the invoice
   * to pay when it's suspended, so the caller needs no follow-up queries.
   */
  async listForClient(clientId, orgId) {
    const sales = await db.ClientPackage.findAll({
      where: { clientId, orgId },
      include: [
        {
          model: db.Package,
          as: 'package',
          required: true,
          where: { isSubscription: true },
          attributes: ['id', 'name', 'tier', 'vendor', 'isSubscription', 'features'],
        },
        { model: db.Retainer, as: 'retainers', attributes: ['id', 'status', 'nextInvoiceDate', 'amount', 'currency', 'isActive'], required: false },
      ],
      order: [['createdAt', 'DESC']],
    });

    const out = [];
    for (const sale of sales) {
      const invoices = await this._invoicesFor(sale.id);
      const outstanding = invoices
        .filter((i) => OPEN_STATUSES.includes(i.status) && i.status !== INVOICE_STATUS.DRAFT)
        .map((i) => ({ id: i.id, number: i.number, status: i.status, dueAt: i.dueAt, total: i.total }));
      // Only live retainers describe a real upcoming renewal — a cancelled or
      // deactivated one keeps a stale nextInvoiceDate that would read as "renews
      // on…" for a subscription that is never billing again.
      const retainer = (sale.retainers || []).find((r) => r.isActive && r.status === 'active') || null;

      out.push({
        id: sale.id,
        packageId: sale.packageId,
        name: sale.package.name,
        tier: sale.package.tier,
        vendor: sale.package.vendor,
        features: sale.package.features,
        currency: sale.currency,
        soldPrice: sale.soldPrice,
        billingCycle: sale.billingCycle,
        status: sale.status,
        entitlement: sale.entitlement || ENTITLEMENT.ACTIVE,
        entitlementReason: sale.entitlementReason,
        usable: (sale.entitlement || ENTITLEMENT.ACTIVE) === ENTITLEMENT.ACTIVE,
        startDate: sale.startDate,
        endDate: sale.endDate,
        renewsAt: retainer?.nextInvoiceDate || null,
        retainerStatus: retainer?.status || null,
        outstandingInvoices: outstanding,
      });
    }
    return out;
  }
}

module.exports = new SubscriptionService();
module.exports.ENTITLEMENT = ENTITLEMENT;
module.exports.OPEN_INVOICE_STATUSES = OPEN_STATUSES;
module.exports.billingLineLabel = billingLineLabel;
