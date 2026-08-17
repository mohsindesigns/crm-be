const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const InvoiceService = require('./InvoiceService');

// Adds one billing cycle to `date`, preserving the day-of-month where possible
// instead of relying on the native `Date#setMonth` rollover behaviour (e.g. Jan 31
// + 1 month silently becomes Mar 2/3 because February is short). Clamping to the
// last day of the target month keeps the renewal anchor stable — the same
// "bill on this day every cycle" logic a normal subscription uses.
function addCycle(date, cycle) {
  // Parse and compute entirely in UTC — `date` is a plain DATEONLY string with no
  // time component, so using local-time Date methods here would shift the result
  // by a day whenever the server's timezone isn't UTC.
  const d = new Date(`${date}T00:00:00Z`);
  const day = d.getUTCDate();
  const monthsToAdd = cycle === 'quarterly' ? 3 : cycle === 'annual' ? 12 : 1;

  const targetMonthIndex = d.getUTCMonth() + monthsToAdd;
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonthIndex + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), targetMonthIndex, Math.min(day, daysInTargetMonth)));
  return target.toISOString().split('T')[0];
}

// Auto-creates a retainer for a recurring project or package sale so billing
// doesn't require a separate manual "create a retainer" step, and immediately
// invoices the first cycle so the engagement starts billed, not waiting for the
// next scheduler pass.
// `lineDescription` / `invoiceNotes` let a caller billing several packages onto
// ONE merged invoice label each line for what it actually is ("SEO — Growth
// (Recurring · monthly)") while writing the shared header note only once —
// without them, every merged line would repeat the same generic note.
// `invoiceStatus` decides whether the first cycle goes straight out ('sent', the
// default for a package sale an admin just made) or waits as a draft for someone
// to review and send it — which is what converting an approved quotation does.
async function autoCreate({
  orgId, clientId, projectId, clientPackageId, packageId, amount, currency, cycle, startDate, note,
  lineDescription, invoiceNotes, invoiceStatus = 'sent',
  mergeWithOpenInvoice = false,
}) {
  const start = (startDate && String(startDate).slice(0, 10)) || (() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  const billingCycle = ['monthly', 'quarterly', 'annual'].includes(cycle) ? cycle : 'monthly';

  const todayStr = (() => {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  })();
  /**
   * A sale dated in the future must not bill today.
   *
   * The first cycle used to be invoiced immediately and stamped `issuedAt =
   * start`, so selling on the 13th with a start date of the 20th produced an
   * invoice that existed — and was SENT to the client — a week before the date
   * printed on it. Instead, point `nextInvoiceDate` at the start date and let
   * RetainerScheduler raise it when that day arrives (it bills everything with
   * nextInvoiceDate <= today), so the invoice is issued on the day it claims.
   */
  const startsInFuture = start > todayStr;

  const retainer = await db.Retainer.create({
    id: uuidv4(),
    orgId,
    clientId,
    projectId: projectId || null,
    clientPackageId: clientPackageId || null,
    packageId: packageId || null,
    currency: currency || 'USD',
    amount,
    cycle: billingCycle,
    nextInvoiceDate: startsInFuture ? start : addCycle(start, billingCycle),
    status: 'active',
  });

  // Bill the first cycle now only when the retainer has actually started. Zero
  // -amount retainers (a package given away free) still no-op via skipIfZero
  // rather than issuing a $0.00 invoice.
  // mergeWithOpenInvoice: package sales fold multiple first-cycle lines onto one
  // client invoice (retainerId left null so the merge target stays eligible).
  if (!startsInFuture) {
    await InvoiceService.create(orgId, {
      clientId,
      clientPackageId: clientPackageId || null,
      currency: retainer.currency,
      status: invoiceStatus,
      issuedAt: start,
      dueAt: start,
      notes: invoiceNotes !== undefined ? invoiceNotes : (note || `Retainer — first ${billingCycle} cycle`),
      lines: [{
        description: lineDescription || note || `Retainer — ${billingCycle} service`,
        qty: 1,
        unitPrice: parseFloat(amount),
      }],
      skipIfZero: true,
      mergeWithOpenInvoice: !!mergeWithOpenInvoice,
    });
  }

  return retainer;
}

module.exports = { addCycle, autoCreate };
