const { Op } = require('sequelize');
const db = require('../models');
const InvoiceService = require('./InvoiceService');
const { addCycle } = require('./RetainerService');
const SubscriptionService = require('./SubscriptionService');
const { billingLineLabel } = SubscriptionService;

function todayLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function runRetainerInvoicing() {
  const today = todayLocal();

  const due = await db.Retainer.findAll({
    where: {
      status: 'active',
      // A deactivated retainer must stop billing — see services/SoftDeleteService.js.
      isActive: true,
      nextInvoiceDate: { [Op.lte]: today },
    },
    include: [
      { model: db.Client, as: 'client', attributes: ['id', 'name', 'orgId'] },
      // Only needed to label the renewal line — a subscription's invoice has to
      // name what it renews ("Business Hosting (Subscription · monthly ·
      // Hostinger)"), since that's the line whose access lapses if it goes unpaid.
      { model: db.Package, as: 'package', attributes: ['id', 'name', 'isSubscription', 'vendor'], required: false },
    ],
  });

  let retainerCount = 0;
  for (const retainer of due) {
    try {
      const orgId = retainer.orgId || retainer.client?.orgId;
      if (!orgId) continue;

      // Idempotency guard: if this retainer already has an invoice issued today,
      // skip it instead of billing twice. Covers the scheduler firing more than
      // once for the same cycle — e.g. a server restart re-running the immediate
      // on-boot invoicing pass before nextInvoiceDate has advanced, or more than
      // one server process each running their own copy of this scheduler. The
      // unique (retainer_id, issued_at) DB index is the hard backstop for the
      // case where two processes both pass this check at nearly the same time.
      const already = await db.Invoice.findOne({
        where: { retainerId: retainer.id, issuedAt: today },
      });
      if (already) continue;

      // skipIfZero: a free (0-amount) retainer still advances its cycle date but
      // never issues an invoice — see InvoiceService.create.
      await InvoiceService.create(orgId, {
        clientId: retainer.clientId,
        clientPackageId: retainer.clientPackageId || null,
        retainerId: retainer.id,
        currency: retainer.currency,
        status: 'sent',
        issuedAt: today,
        dueAt: today,
        notes: `Auto-generated from retainer — ${retainer.cycle} service`,
        lines: [{
          description: retainer.package?.isSubscription
            ? billingLineLabel({
              label: retainer.package.name,
              isSubscription: true,
              vendor: retainer.package.vendor,
            }, retainer.cycle)
            : `Retainer — ${retainer.cycle} service`,
          qty: 1,
          unitPrice: parseFloat(retainer.amount),
        }],
        skipIfZero: true,
      });

      // Advance from the existing anchor date (not from "today") so the renewal day
      // of month stays stable even if the scheduler runs a few days late.
      await retainer.update({ nextInvoiceDate: addCycle(retainer.nextInvoiceDate, retainer.cycle) });
      retainerCount += 1;
    } catch (err) {
      // A unique-constraint violation here means another process won the race to
      // invoice this retainer for today — that's the guard working, not a failure.
      if (err?.name !== 'SequelizeUniqueConstraintError') {
        console.error(`[RetainerScheduler] Failed for retainer ${retainer.id}:`, err.stack || err.message);
      }
    }
  }

  // Promote scheduled installment invoices (created as draft on package sale) to
  // sent when their due date arrives — so the client portal only sees them then.
  let installmentCount = 0;
  try {
    const dueDrafts = await db.Invoice.findAll({
      where: {
        status: 'draft',
        dueAt: { [Op.lte]: today },
        clientPackageId: { [Op.ne]: null },
      },
    });
    for (const inv of dueDrafts) {
      try {
        await InvoiceService.updateStatus(inv.id, inv.orgId, 'sent');
        installmentCount += 1;
      } catch (err) {
        console.error(`[RetainerScheduler] Failed to issue installment ${inv.id}:`, err.stack || err.message);
      }
    }
  } catch (err) {
    console.error('[RetainerScheduler] Installment draft scan failed:', err.stack || err.message);
  }

  // Mark past-due sent invoices as overdue (skip paid/void).
  try {
    await db.Invoice.update(
      { status: 'overdue' },
      {
        where: {
          status: 'sent',
          dueAt: { [Op.lt]: today },
        },
      }
    );
  } catch (err) {
    console.error('[RetainerScheduler] Overdue mark failed:', err.message);
  }

  /**
   * Re-derive every subscription's entitlement, immediately after the overdue
   * pass above so the two always agree.
   *
   * Payments resync their own subscriptions inline (see
   * SubscriptionService.syncForInvoice), so this sweep exists for the direction
   * no event covers: nothing HAPPENS when a renewal invoice quietly goes past its
   * due date, and that's precisely the moment a client's hosting should stop
   * reading as live in their portal. Reuses this scheduler's existing 6-hourly
   * tick rather than adding a scheduler of its own.
   */
  try {
    const { changed } = await SubscriptionService.syncAll();
    if (changed) console.log(`[RetainerScheduler] Subscription entitlements changed: ${changed}.`);
  } catch (err) {
    console.error('[RetainerScheduler] Subscription entitlement sweep failed:', err.message);
  }

  if (retainerCount || installmentCount) {
    console.log(`[RetainerScheduler] Retainers invoiced: ${retainerCount}; installments issued: ${installmentCount}.`);
  }
}

function startScheduler() {
  runRetainerInvoicing().catch(console.error);
  setInterval(() => runRetainerInvoicing().catch(console.error), 6 * 60 * 60 * 1000);
}

module.exports = { startScheduler, runRetainerInvoicing };
