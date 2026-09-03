const { createPdfBuffer, fetchImageBuffer } = require('./PdfService');
const { letterheadForOrg } = require('./letterhead');
const { drawSalarySlip, drawPaymentAdvice } = require('./SalarySlipPdf');
const { formatPeriod } = require('../utils/formatPeriod');
const { computeDisbursementSplit } = require('../utils/payrollCalc');
const { getTaxYearForPeriod } = require('./HrService');
const {
  PayrollItem, Worker, PayrollRun, User, WhiteLabelConfig, Company, SalaryBeneficiary,
} = require('../models');

/**
 * Keys in PayrollItem.additions that describe HOW the pay was worked out rather
 * than being money earned. They drive the attendance strip and the calculation,
 * and must never be listed as an earnings line.
 */
const META_KEYS = new Set([
  'payableDays', 'workingDays', 'perDayRate', 'monthlySalary',
  'halfDayCredit', 'holidayDays', 'weekendDays', 'formula', 'daysInMonth', 'nonTaxableComponents',
]);

/**
 * The reference payslip names five specific earnings and three deductions.
 * Payroll stores them as free-form JSON maps, so these map the known keys onto
 * the printed labels; anything unrecognised still prints, humanised, rather than
 * being silently dropped from someone's payslip.
 */
const EARNING_LABELS = {
  basic: 'Basic Salary',
  base: 'Basic Salary',
  attendancePay: 'Basic Salary',
  houseRent: 'House Rent Allowance',
  houseRentAllowance: 'House Rent Allowance',
  medical: 'Medical Allowance',
  medicalAllowance: 'Medical Allowance',
  conveyance: 'Conveyance Allowance',
  conveyanceAllowance: 'Conveyance Allowance',
  allowance: 'Other Allowance',
  otherAllowance: 'Other Allowance',
  bonus: 'Bonus',
  overtime: 'Overtime',
};

const DEDUCTION_LABELS = {
  tax: 'Income Tax',
  incomeTax: 'Income Tax',
  absenceCut: 'Leave Deduction',
  leaveDeduction: 'Leave Deduction',
  late: 'Late Deduction',
  other: 'Other Deduction',
  otherDeduction: 'Other Deduction',
};

/** Preferred print order, so two slips never list the same items differently. */
const EARNING_ORDER = ['Basic Salary', 'House Rent Allowance', 'Medical Allowance', 'Conveyance Allowance', 'Other Allowance', 'Bonus', 'Overtime'];
const DEDUCTION_ORDER = ['Income Tax', 'Leave Deduction', 'Late Deduction', 'Other Deduction'];

function humanise(key) {
  // Free-form component names (e.g. "House Rent Allowance") are already
  // human-readable — only camelCase keys (e.g. "attendancePay") need splitting.
  if (key.includes(' ')) return key;
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
}

/**
 * Collapse a JSON money map into ordered { label, amount } rows, merging any
 * keys that share a label (e.g. `tax` and `incomeTax` both → Income Tax).
 */
function toRows(map, labels, order) {
  const byLabel = new Map();
  for (const [key, raw] of Object.entries(map || {})) {
    if (META_KEYS.has(key)) continue;
    const amount = Number(raw) || 0;
    if (!amount) continue;
    const label = labels[key] || humanise(key);
    byLabel.set(label, (byLabel.get(label) || 0) + amount);
  }
  const rows = [...byLabel.entries()].map(([label, amount]) => ({ label, amount }));
  rows.sort((a, b) => {
    const ai = order.indexOf(a.label);
    const bi = order.indexOf(b.label);
    // Unknown labels keep their relative order, after the known ones.
    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
  });
  return rows;
}

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Last four digits only — a full account number has no business on a printout. */
function maskAccountNumber(raw) {
  const clean = String(raw || '').replace(/\s+/g, '');
  if (!clean) return null;
  const tail = clean.slice(-4);
  return `${'X'.repeat(Math.max(0, Math.min(8, clean.length - 4)))}${tail}`;
}

function maskAccount(worker) {
  return maskAccountNumber(worker.iban || worker.bankAccountNumber);
}

async function generateSlipBuffer(payrollItemId, orgId) {
  const item = await PayrollItem.findOne({
    where: { id: payrollItemId },
    include: [
      {
        model: Worker,
        as: 'worker',
        required: true,
        where: { orgId },
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      },
      // payroll_runs carries only: id, orgId, period, status, workingDaysPerMonth,
      // createdBy, createdAt. No paidAt, and no updatedAt either.
      { model: PayrollRun, as: 'run', attributes: ['id', 'period', 'status', 'workingDaysPerMonth', 'createdAt'] },
    ],
  });

  if (!item) {
    const err = new Error('Payroll item not found.');
    err.status = 404;
    throw err;
  }

  const worker = item.worker;
  const additions = item.additions || {};
  const deductions = item.deductions || {};

  const [brandConfig, letterhead, hrCompany, taxYear] = await Promise.all([
    WhiteLabelConfig.findOne({ where: { orgId } }),
    // 'hr' — a payslip is an HR document, so it must carry the HR entity and
    // NOT the commercial letterhead note (see letterheadForOrg).
    letterheadForOrg(orgId, 'hr'),
    Company.primaryFor(orgId, 'hr').catch(() => null),
    // The tax year that actually COVERS this run's period — same resolution
    // HrService#calculatePayrollItems used to withhold the tax in the first
    // place (by date range, not just whichever year is flagged isActive), so
    // a back-dated/reprinted slip always shows the fiscal year it was really
    // taxed against, not today's active year.
    item.run?.period ? getTaxYearForPeriod(orgId, item.run.period) : null,
  ]);

  const earnings = toRows(additions, EARNING_LABELS, EARNING_ORDER);
  // A slip with no itemised additions still has to show what was earned.
  if (!earnings.length) earnings.push({ label: 'Basic Salary', amount: Number(item.base) || 0 });
  const deductionRows = toRows(deductions, DEDUCTION_LABELS, DEDUCTION_ORDER);

  const grossEarnings = Number(item.computedGross) || earnings.reduce((s, r) => s + r.amount, 0);
  const totalDeductions = deductionRows.reduce((s, r) => s + r.amount, 0);
  const netSalary = item.computedNet != null ? Number(item.computedNet) : grossEarnings - totalDeductions;

  // Payment split — three sources, in priority order:
  //   1. Locked/paid run: the frozen snapshot taken at lock time (see
  //      HrService#freezeDisbursementSplits) — what was actually disbursed,
  //      never recomputed off beneficiaries that may have since changed.
  //   2. Draft/open_for_review run with a percentage-only split: the
  //      precomputed splitTaxBreakdown from the last Calculate (see
  //      calculatePayrollItems/computeSplitPayrollTax) — each share's amount
  //      already has its OWN independently-computed tax subtracted, so it
  //      must be used as-is, not re-split off netSalary (which nets out the
  //      COMBINED tax and would misallocate take-home between shares under
  //      progressive brackets — see freezeDisbursementSplits' own comment).
  //   3. Anything else (no beneficiaries, or a fixed-type one — out of scope
  //      for split-then-tax): computed live off netSalary, same as before.
  let paymentSplit = Array.isArray(item.disbursementSplit) ? item.disbursementSplit : [];
  if (!paymentSplit.length && Array.isArray(item.splitTaxBreakdown) && item.splitTaxBreakdown.length) {
    paymentSplit = item.splitTaxBreakdown;
  }
  if (!paymentSplit.length) {
    const activeBeneficiaries = await SalaryBeneficiary.findAll({
      where: { workerId: worker.id, orgId, isActive: true },
      order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
    if (activeBeneficiaries.length) {
      try {
        // A draft-run preview only — over-allocation here (e.g. a fixed
        // beneficiary amount that no longer fits a lower-than-usual net this
        // month) is a real problem, but the fix is on the Salary Split tab,
        // not a reason to fail loading the slip. It still correctly blocks
        // at lock time (HrService#freezeDisbursementSplits, unguarded).
        paymentSplit = computeDisbursementSplit(worker, netSalary, activeBeneficiaries);
      } catch {
        paymentSplit = [];
      }
    }
  }

  // Calendar days in the run's month, so "Days in Month" is the real figure
  // rather than the working-day divisor used for the rate.
  const period = String(item.run?.period || '');
  const [py, pm] = period.split('-').map(Number);
  const daysInMonth = additions.daysInMonth
    || (py && pm ? new Date(py, pm, 0).getDate() : 30);

  const signatureBuffer = hrCompany?.signatureUrl
    ? await fetchImageBuffer(hrCompany.signatureUrl).catch(() => null)
    : null;

  const data = {
    companyName: hrCompany?.legalName || letterhead.legalName || brandConfig?.brandName || 'Company',
    // "Digital Agency · Karachi, Pakistan" in the reference — the office label
    // plus the last line of its address, which is the city/country.
    companyTagline: [hrCompany?.officeLabel, (hrCompany?.address || '').split('\n').pop()]
      .filter(Boolean).join(' · ')
      || (brandConfig?.businessAddress || '').split('\n')[0]
      || '',
    payPeriod: formatPeriod(item.run?.period),

    employeeName: worker.user?.name,
    // No employee-code column exists yet; CNIC is the real-world identifier
    // people recognise, with a short id as the last resort.
    employeeId: worker.cnic || (worker.id ? worker.id.slice(0, 8).toUpperCase() : null),
    designation: worker.designation,
    department: worker.department,
    joiningDate: fmtDate(worker.joiningDate),
    bankAccount: maskAccount(worker),
    // Nothing records when a run was actually paid, so this is the date the slip
    // was produced. Printing the run's creation date would be worse: it would
    // read as a payment date that never happened.
    paymentDate: fmtDate(new Date()),
    paymentMethod: (() => {
      const otherRecipients = paymentSplit.filter((l) => l.beneficiaryId).length;
      if (otherRecipients > 0) {
        return `Bank Transfer · split across ${otherRecipients + 1} recipients`;
      }
      return worker.bankName ? `Bank Transfer · ${worker.bankName}` : 'Bank Transfer';
    })(),
    // The actual per-recipient breakdown (name, relation, amount) — printed as
    // its own section below when there's more than just the worker's own
    // "Self" line, so an employee who's split their pay with family can see
    // exactly who got what, same as the internal disbursement sheet shows HR.
    paymentSplit: paymentSplit.length > 1 ? paymentSplit : null,

    earnings,
    deductions: deductionRows,
    grossEarnings,
    totalDeductions,
    netSalary,

    // Explains the single "Income Tax" deduction row: the cumulative-YTD
    // method (utils/payrollCalc.js#computeCumulativeTax) withholds this
    // month's tax off an annualized projection, not off this month's salary
    // in isolation, so the flat rupee figure alone is not auditable without
    // the fiscal-year window and the YTD numbers it was computed from.
    // Gated on the YTD/projected figures actually having data, NOT on this
    // month's withholding being non-zero — a month where nothing was withheld
    // (already covered YTD, or below threshold this month) still needs the
    // yearly context shown, it just prints "Rs 0" for Taxable This Month.
    taxBreakdown: (item.taxableYTD > 0 || item.projectedAnnualTaxable > 0 || item.taxAmount > 0) ? {
      taxYearLabel: taxYear?.label || null,
      taxYearStart: fmtDate(taxYear?.startDate),
      taxYearEnd: fmtDate(taxYear?.endDate),
      monthlyTaxable: Number(item.monthlyTaxable) || 0,
      taxableYTD: Number(item.taxableYTD) || 0,
      projectedAnnualTaxable: Number(item.projectedAnnualTaxable) || 0,
      annualTaxProjected: Number(item.annualTaxProjected) || 0,
      taxThisMonth: Number(item.taxAmount) || 0,
    } : null,

    daysInMonth,
    daysPresent: item.presentDays || 0,
    paidLeaveDays: item.leaveDays || 0,
    absentDays: item.absentDays || 0,
    holidays: additions.holidayDays || 0,
    weekends: additions.weekendDays || 0,

    signatureBuffer,
  };

  // Beneficiary lines (excluding the worker's own "Self" line) each get a
  // payment-advice page appended after the main slip — see drawPaymentAdvice
  // for why that's a plain remittance confirmation, not a duplicate payslip.
  const beneficiaryLines = paymentSplit.filter((l) => l.beneficiaryId);

  const buffer = await createPdfBuffer((doc) => {
    drawSalarySlip(doc, data);
    for (const line of beneficiaryLines) {
      doc.addPage();
      drawPaymentAdvice(doc, {
        companyName: data.companyName,
        companyTagline: data.companyTagline,
        payPeriod: data.payPeriod,
        employeeName: data.employeeName,
        recipientName: line.name,
        relation: line.relation,
        amount: line.amount,
        // Only present for a percentage-only split-then-tax breakdown (see
        // computeSplitPayrollTax) — this share's own independently-computed
        // tax, shown so the recipient can see it was already applied to
        // their portion specifically, not to the employee's whole salary.
        grossShare: line.grossShare,
        tax: line.tax,
        bankAccount: maskAccountNumber(line.iban || line.bankAccountNumber),
        paymentDate: data.paymentDate,
      });
    }
  }, {
    // No page margin — the slip's coloured bands run edge to edge, and the
    // renderer applies the reference's own 28pt inner padding.
    margin: 0,
    info: {
      Title: `Salary Slip — ${worker.user?.name || 'Employee'} — ${formatPeriod(item.run?.period)}`,
      Author: data.companyName,
    },
  });

  return { buffer, item };
}

module.exports = { generateSlipBuffer };
