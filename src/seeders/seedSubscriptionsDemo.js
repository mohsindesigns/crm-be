/**
 * Demo data for the Subscriptions module: seeds a small catalogue of resold
 * recurring services (hosting, mailboxes, a domain) and sells them to existing
 * clients so that every entitlement state — active, awaiting payment, suspended,
 * cancelled — is visible on screen without anyone having to construct one.
 *
 * It also seeds one ordinary (non-subscription) retainer, because half the point
 * of the feature is the SPLIT: Retainers → "Service retainers" has to have
 * something in it for the Subscriptions tab beside it to mean anything.
 *
 * Everything goes through the real code path — ClientService.sellPackage, which
 * creates the ClientPackage, the retainer and the first invoice, then
 * InvoiceService.recordPayment for the ones that are paid. Nothing here
 * hand-writes a ClientPackage or an entitlement: the entitlements you see
 * afterwards were derived by SubscriptionService from the invoices this script
 * caused, exactly as they would be in production.
 *
 * Prerequisites: base seed + QA demo pack already applied.
 *   npm run db:seed
 *   npm run db:seed:qa
 *
 * Run:
 *   npm run db:seed:subscriptions
 *
 * Re-running wipes and recreates only the rows this script made — every one of
 * them hangs off a package whose name starts with the marker below — so it is
 * safe to run repeatedly.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });

// Seeding raises invoices, and raising an invoice as `sent` emails it to the
// client's billing contact. The demo clients have @*.test addresses that can
// only ever bounce, so outbound mail is hard-disabled for the duration of the
// script rather than spraying a real SMTP account with undeliverable sends.
// SMTP_USER is the single switch every send is gated on — see EmailService.sendMail.
//
// Blanked, NOT deleted: requiring ../app below runs dotenv again, and dotenv
// only leaves alone the keys that still exist in process.env — a deleted one is
// repopulated straight back from .env and the sends resume.
process.env.SMTP_USER = '';

const { Op } = require('sequelize');
const db = require('../models');
const app = require('../app');
const ClientService = require('../services/ClientService');
const InvoiceService = require('../services/InvoiceService');
const SubscriptionService = require('../services/SubscriptionService');

const MARKER = 'QA Sub —';
const HOSTING_SERVICE_KEY = 'hosting';

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The catalogue. `skipProjectCreation` is what stops each of these spawning a
 * workflow — nobody delivers a domain renewal, it just bills — and
 * `isSubscription` is what puts it on the Subscriptions tab and gates the
 * client's access to it on payment.
 */
const PACKAGES = [
  {
    key: 'hosting',
    name: `${MARKER} Business Hosting`,
    vendor: 'Hostinger',
    price: 25,
    billingCycle: 'monthly',
    isSubscription: true,
    features: ['1 managed WordPress site', 'Daily backups, 14-day retention', 'Free SSL certificate', '99.9% uptime SLA'],
  },
  {
    key: 'mailbox',
    name: `${MARKER} Mailboxes (5 seats)`,
    vendor: 'Google Workspace',
    price: 36,
    billingCycle: 'monthly',
    isSubscription: true,
    features: ['5 × 30GB business mailboxes', 'Custom domain addresses', 'Shared calendars & Drive'],
  },
  {
    key: 'domain',
    name: `${MARKER} Domain Renewal (.com)`,
    vendor: 'Namecheap',
    price: 18,
    billingCycle: 'annual',
    isSubscription: true,
    features: ['One .com registration', 'WHOIS privacy included', 'Auto-renew managed by us'],
  },
  {
    // Deliberately NOT a subscription — this is the control that proves the
    // Retainers tab still behaves exactly as it did, and gives the
    // "Service retainers" tab something to show next to the subscriptions.
    key: 'maintenance',
    name: `${MARKER} Website Care Plan`,
    vendor: null,
    price: 400,
    billingCycle: 'monthly',
    isSubscription: false,
    features: ['Monthly plugin & core updates', 'Content changes up to 2 hours', 'Uptime monitoring'],
  },
];

/**
 * Who buys what, and what happens to the invoice afterwards — chosen so that
 * each of the four entitlement states is reachable from a real sequence of
 * events rather than written straight into the column.
 *
 * Acme buys hosting and mailboxes on the same day on purpose: two package sales
 * to one client on one date merge onto a SINGLE invoice, which clears that
 * invoice's own clientPackageId. It's the case that only works because invoice
 * LINES carry the sold-package link, so the demo should contain one.
 */
const SALES = [
  { client: 'Acme Retail Co',    pkg: 'hosting',     startOffset: 0,   outcome: 'paid'      },
  { client: 'Acme Retail Co',    pkg: 'mailbox',     startOffset: 0,   outcome: 'paid'      },
  { client: 'Acme Retail Co',    pkg: 'domain',      startOffset: -40, outcome: 'overdue'   },
  { client: 'Nimbus Health Co',  pkg: 'hosting',     startOffset: 0,   outcome: 'unpaid'    },
  // Ten days earlier so it bills onto its OWN invoice. Same-day sales to one
  // client merge (which is the point of the Acme rows above), and a merged
  // invoice can only have one outcome — leaving this at 0 would have silently
  // dragged the care plan into the hosting invoice and left both unpaid.
  { client: 'Nimbus Health Co',  pkg: 'maintenance', startOffset: -10, outcome: 'paid'      },
  { client: 'Bright Bakery Co',  pkg: 'mailbox',     startOffset: 0,   outcome: 'cancelled' },
];

/** Every invoice billing this sale, found the way SubscriptionService finds them. */
async function invoicesForSale(clientPackageId) {
  const ids = (await db.InvoiceLine.findAll({
    where: { clientPackageId },
    attributes: ['invoiceId'],
  })).map((l) => l.invoiceId);
  return db.Invoice.findAll({
    where: {
      [Op.or]: [
        { clientPackageId },
        ...(ids.length ? [{ id: { [Op.in]: ids } }] : []),
      ],
    },
  });
}

/** Removes everything a previous run of THIS script created, and nothing else. */
async function wipePreviousRun(orgId) {
  const packages = await db.Package.findAll({
    where: { orgId, name: { [Op.like]: `${MARKER}%` } },
    attributes: ['id'],
  });
  if (!packages.length) return 0;
  const packageIds = packages.map((p) => p.id);

  const sales = await db.ClientPackage.findAll({ where: { packageId: { [Op.in]: packageIds } }, attributes: ['id'] });
  const saleIds = sales.map((s) => s.id);

  // Invoices reachable from those sales, by header link or by line link. Only
  // invoices whose every line belongs to a seeded sale are removed — a merged
  // invoice that also carries a real, non-seeded line is left alone and just has
  // the seeded lines stripped out of it.
  const invoiceIds = saleIds.length
    ? [...new Set([
      ...(await db.Invoice.findAll({ where: { clientPackageId: { [Op.in]: saleIds } }, attributes: ['id'] })).map((i) => i.id),
      ...(await db.InvoiceLine.findAll({ where: { clientPackageId: { [Op.in]: saleIds } }, attributes: ['invoiceId'] })).map((l) => l.invoiceId),
    ])]
    : [];

  const doomedInvoiceIds = [];
  for (const invoiceId of invoiceIds) {
    const lines = await db.InvoiceLine.findAll({ where: { invoiceId }, attributes: ['clientPackageId'] });
    const allSeeded = lines.length > 0 && lines.every((l) => saleIds.includes(l.clientPackageId));
    if (allSeeded) doomedInvoiceIds.push(invoiceId);
    else await db.InvoiceLine.destroy({ where: { invoiceId, clientPackageId: { [Op.in]: saleIds } } });
  }

  if (doomedInvoiceIds.length) {
    await db.Payment.destroy({ where: { invoiceId: { [Op.in]: doomedInvoiceIds } } });
    await db.InvoiceLine.destroy({ where: { invoiceId: { [Op.in]: doomedInvoiceIds } } });
    await db.Invoice.destroy({ where: { id: { [Op.in]: doomedInvoiceIds } } });
  }
  if (saleIds.length) {
    await db.Retainer.destroy({ where: { clientPackageId: { [Op.in]: saleIds } } });
    await db.Project.destroy({ where: { clientPackageId: { [Op.in]: saleIds } } });
    await db.ClientPackage.destroy({ where: { id: { [Op.in]: saleIds } } });
  }
  await db.Retainer.destroy({ where: { packageId: { [Op.in]: packageIds } } });
  await db.Package.destroy({ where: { id: { [Op.in]: packageIds } } });
  return packageIds.length;
}

async function seed() {
  await app.schemaReady;
  await db.sequelize.authenticate();

  const org = await db.Org.findOne({ order: [['createdAt', 'ASC']] });
  if (!org) {
    console.error('No org found. Run `npm run db:seed` first.');
    process.exit(1);
  }
  const orgId = org.id;

  const superRole = await db.Role.findOne({ where: { orgId, key: 'super_admin' } });
  const adminUser = (superRole && await db.User.findOne({ where: { orgId, roleId: superRole.id }, order: [['createdAt', 'ASC']] }))
    || await db.User.findOne({ where: { orgId }, order: [['createdAt', 'ASC']] });
  if (!adminUser) {
    console.error('No users found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const wiped = await wipePreviousRun(orgId);
  if (wiped) console.log(`· cleared ${wiped} package(s) from a previous run`);

  // Subscriptions still need a service type — Package.serviceTypeKey is required
  // — even though they never spawn a project under it.
  const [serviceType] = await db.ServiceType.findOrCreate({
    where: { orgId, key: HOSTING_SERVICE_KEY },
    defaults: { orgId, key: HOSTING_SERVICE_KEY, name: 'Hosting & Infrastructure', isActive: true },
  });

  const packagesByKey = {};
  for (const spec of PACKAGES) {
    packagesByKey[spec.key] = await db.Package.create({
      orgId,
      serviceTypeKey: serviceType.key,
      name: spec.name,
      tier: spec.vendor || 'Care',
      price: spec.price,
      currency: 'USD',
      features: spec.features,
      isRecurring: true,
      billingCycle: spec.billingCycle,
      isSubscription: spec.isSubscription,
      vendor: spec.vendor,
      // Nothing to deliver — these bill and renew, they don't run a workflow.
      skipProjectCreation: true,
      isActive: true,
    });
  }
  console.log(`✓ ${PACKAGES.length} packages created (${PACKAGES.filter((p) => p.isSubscription).length} subscriptions)`);

  // ── Pass 1: make every sale ───────────────────────────────────────────────
  // All the selling happens before any of the settling, because that's the order
  // it happens in real life — and because it's what lets Acme's two same-day
  // sales find each other and merge onto one invoice. Paying the first invoice
  // before raising the second would take it out of the merge window (a settled
  // invoice is not a mergeable target) and the demo would quietly lose the very
  // case it exists to show.
  const made = [];
  for (const sale of SALES) {
    const client = await db.Client.findOne({ where: { orgId, name: sale.client } });
    if (!client) {
      console.warn(`· skipped: client "${sale.client}" not found — run \`npm run db:seed:qa\` first.`);
      continue;
    }
    const pkg = packagesByKey[sale.pkg];
    const { clientPackage } = await ClientService.sellPackage(
      client.id,
      orgId,
      { packageId: pkg.id, startDate: dayOffset(sale.startOffset) },
      adminUser.id,
    );

    // Keep the next renewal in the future for every seeded retainer. Without
    // this, the back-dated sale's retainer is already due and RetainerScheduler
    // would raise a fresh invoice within six hours of the next boot — quietly
    // changing the demo out from under whoever is looking at it.
    await db.Retainer.update(
      { nextInvoiceDate: dayOffset(sale.pkg === 'domain' ? 325 : 20) },
      { where: { clientPackageId: clientPackage.id, status: 'active' } },
    );

    made.push({ sale, pkg, clientPackage });
  }

  // ── Pass 2: settle, chase or cancel ───────────────────────────────────────
  const results = [];
  const settledInvoices = new Map(); // invoiceId -> the outcome already applied
  for (const { sale, pkg, clientPackage } of made) {
    for (const invoice of await invoicesForSale(clientPackage.id)) {
      // A merged invoice is reached once per sale on it, so only act on it once.
      // If the sales sharing it disagree about what should happen, say so — one
      // invoice cannot be both paid and overdue, and silently applying whichever
      // came first would produce a demo that doesn't show what it claims to.
      if (settledInvoices.has(invoice.id)) {
        if (settledInvoices.get(invoice.id) !== sale.outcome) {
          console.warn(`· note: ${invoice.number} bills several sales; kept "${settledInvoices.get(invoice.id)}" over "${sale.outcome}" for ${sale.client}/${sale.pkg}.`);
        }
        continue;
      }
      settledInvoices.set(invoice.id, sale.outcome);

      if (sale.outcome === 'paid') {
        // Settle in full through the real payment path, so a Payment row exists
        // and the invoice reaches `paid` the same way it would in production.
        const settled = await InvoiceService.settlementFor(invoice.id, { total: invoice.total });
        if (settled.amountDue > 0) {
          await InvoiceService.recordPayment(invoice.id, orgId, {
            amount: settled.amountDue,
            provider: 'bank',
            methodLabel: 'Bank Transfer',
          });
        }
      } else if (sale.outcome === 'unpaid') {
        // Issued and genuinely still within terms, so it reads as "awaiting
        // payment" rather than tipping into overdue overnight.
        await invoice.update({ dueAt: dayOffset(14) });
      } else if (sale.outcome === 'overdue') {
        await InvoiceService.updateStatus(invoice.id, orgId, 'overdue');
      }
    }

    if (sale.outcome === 'cancelled') {
      await clientPackage.update({ status: 'cancelled' });
      await db.Retainer.update({ status: 'cancelled' }, { where: { clientPackageId: clientPackage.id } });
    }

    const synced = await SubscriptionService.syncEntitlement(clientPackage.id);
    results.push({
      client: sale.client,
      name: pkg.name.replace(`${MARKER} `, ''),
      subscription: pkg.isSubscription,
      entitlement: pkg.isSubscription ? synced.entitlement : '—',
    });
  }

  console.log('');
  console.log('  CLIENT                KIND          SUBSCRIPTION                    ENTITLEMENT');
  console.log('  ' + '─'.repeat(88));
  for (const r of results) {
    console.log(
      '  '
      + r.client.padEnd(22)
      + (r.subscription ? 'subscription' : 'retainer').padEnd(14)
      + r.name.padEnd(32)
      + r.entitlement,
    );
  }

  console.log('');
  console.log('Where to look:');
  console.log('  Retainers → Subscriptions   both tabs are populated; the Subscriptions tab shows vendor, renewal and client access');
  console.log('  Clients → Acme Retail Co    Packages tab is split into Packages / Subscriptions; one is suspended');
  console.log('  Admin → Packages            the four seeded packages, subscriptions badged with their vendor');
  console.log('  Client portal               Grace Miller (grace@acmeretail.test) sees an active AND a suspended subscription;');
  console.log('                              Daniel Cho (daniel@nimbushealth.test) sees one awaiting payment');
  console.log('');
  console.log('Note: Acme\'s hosting + mailbox billed onto ONE merged invoice — that invoice has no');
  console.log('      clientPackageId of its own, so its entitlements resolve purely through invoice lines.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
