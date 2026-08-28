/**
 * Pakistan salaried-employee income tax withholding (Section 149).
 * Tax year: 1 July – 30 June. Pure, DB-free functions — see
 * Payroll_Tax_Calculation_Spec.docx for the method this implements.
 *
 * Core principle: salary tax is an ANNUAL calculation applied monthly, never
 * a tax on one month's salary in isolation. Method: (1) project the full tax
 * year's taxable salary, (2) compute annual tax on that projection from the
 * configured slabs, (3) spread it across the remaining pay periods
 * (computeCumulativeTax). A mid-year joiner/leaver must be annualized off
 * their ACTUAL partial-year projection, never a flat ×12 — that over/under-
 * taxes them (the spec's worked example, Section 8).
 */

const { computeAnnualTax } = require('./taxCalc');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Spec rule: round tax to the nearest rupee, consistently. */
function roundRupee(n) {
  return Math.round(Number(n) || 0);
}

function toDateStr(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d).toISOString().slice(0, 10);
}

/** Calendar days in a given year/month (1-indexed month) — D in the spec. */
function daysInCalendarMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

/**
 * Bounds the payroll period to the worker's actual employment window this
 * month (mid-month join/leave). Returns null if not employed at all during
 * [periodStart, periodEnd].
 */
function activeRangeForMonth({
  periodStart, periodEnd, joinDate, leaveDate,
}) {
  let start = periodStart;
  let end = periodEnd;
  if (joinDate && joinDate > start) start = joinDate;
  if (leaveDate && leaveDate < end) end = leaveDate;
  if (start > end) return null;
  return { start, end };
}

function daysBetweenInclusive(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  return Math.round((end - start) / 86400000) + 1;
}

/**
 * Section 4: payable days this month.
 * activeDays = calendar days actually on the books this month (bounded by
 * join/leave date). The denominator (D, daysInMonth) stays the FULL calendar
 * month even for a partial joiner/leaver — see the worked example in Section 8
 * (Aug earned = 90,000 × 14/31, not 14/14).
 */
function computePayableDays({
  daysInMonth, periodStart, periodEnd, joinDate, leaveDate, unpaidAbsentDays,
}) {
  const range = activeRangeForMonth({
    periodStart, periodEnd, joinDate, leaveDate,
  });
  if (!range) return { activeDays: 0, payableDays: 0 };
  const activeDays = daysBetweenInclusive(range.start, range.end);
  const payableDays = Math.max(0, round2(activeDays - (Number(unpaidAbsentDays) || 0)));
  return { activeDays, payableDays };
}

/**
 * Section 2: salary structure. Medical is exempt up to medicalExemptionCapPercent
 * of Basic (config, never hard-coded — Finance Act changes it). Any Medical
 * configured above that cap has the excess treated as taxable.
 */
function computeSalaryStructure({ basic, medicalAllowance, medicalExemptionCapPercent }) {
  const b = Number(basic) || 0;
  const capPercent = Number(medicalExemptionCapPercent);
  const cap = round2((Number.isFinite(capPercent) ? capPercent : 10) / 100 * b);
  const medical = medicalAllowance != null && medicalAllowance !== '' ? round2(medicalAllowance) : cap;
  const exemptMedical = Math.min(medical, cap);
  const taxableMedicalExcess = round2(Math.max(0, medical - cap));
  const gross = round2(b + medical);
  return {
    basic: b, medical, gross, medicalCap: cap, exemptMedical, taxableMedicalExcess,
  };
}

/** Section 5: earned amounts this month (calendar-day proration). */
function computeEarnedAmounts({
  basic, medical, taxableMedicalExcess, payableDays, daysInMonth, overtimeAmount,
}) {
  const ratio = daysInMonth > 0 ? payableDays / daysInMonth : 0;
  const earnedBasic = round2(basic * ratio);
  const earnedMedical = round2(medical * ratio);
  const earnedTaxableMedicalExcess = round2((taxableMedicalExcess || 0) * ratio);
  const overtime = round2(overtimeAmount || 0);
  const earnedGross = round2(earnedBasic + earnedMedical + overtime);
  return {
    earnedBasic, earnedMedical, earnedTaxableMedicalExcess, overtime, earnedGross,
  };
}

/**
 * Extra salary components beyond Basic + Medical (House Rent Allowance,
 * Conveyance, Special Allowance, etc.) — each independently flagged taxable
 * or non-taxable. Every component is paid (calendar-day prorated like
 * Basic); only the taxable ones feed into taxable salary. Feed
 * earnedTaxableTotal into computeMonthlyTaxable's otherTaxableAllowance, and
 * fullMonthTaxableTotal into computeCumulativeTax's remainingFullMonthBasic
 * (added to Basic) so the YTD projection assumes taxable allowances repeat
 * at their configured full-month amount, same as Basic.
 */
// Reserved additions/deductions keys a free-form component name must not
// collide with, or it would silently overwrite Basic/Medical/Overtime/Tax on
// the payslip instead of adding a new line.
const RESERVED_COMPONENT_NAMES = new Set([
  'attendancepay', 'medical', 'overtime', 'tax', 'base',
  'payabledays', 'daysinmonth', 'perdayrate', 'monthlysalary',
  'halfdaycredit', 'holidaydays', 'formula', 'nontaxablecomponents',
]);

function computeSalaryComponents({ components, payableDays, daysInMonth }) {
  const ratio = daysInMonth > 0 ? payableDays / daysInMonth : 0;
  let earnedTaxableTotal = 0;
  let earnedNonTaxableTotal = 0;
  let fullMonthTaxableTotal = 0;
  const rows = [];
  for (const c of (Array.isArray(components) ? components : [])) {
    const name = String(c?.name || '').trim();
    const fullAmount = round2(c?.amount);
    if (!name || !fullAmount || RESERVED_COMPONENT_NAMES.has(name.toLowerCase())) continue;
    const taxable = !!c.taxable;
    const earned = round2(fullAmount * ratio);
    if (taxable) {
      earnedTaxableTotal += earned;
      fullMonthTaxableTotal += fullAmount;
    } else {
      earnedNonTaxableTotal += earned;
    }
    rows.push({
      id: c.id, name, taxable, fullAmount, earned,
    });
  }
  return {
    rows,
    earnedTaxableTotal: round2(earnedTaxableTotal),
    earnedNonTaxableTotal: round2(earnedNonTaxableTotal),
    fullMonthTaxableTotal: round2(fullMonthTaxableTotal),
  };
}

/**
 * Section 6: taxable salary this month. Medical (up to the cap) is EXCLUDED;
 * overtime and any medical excess above the cap are INCLUDED.
 */
function computeMonthlyTaxable({
  earnedBasic, overtime, earnedTaxableMedicalExcess, otherTaxableAllowance,
}) {
  return round2(
    (earnedBasic || 0) + (overtime || 0)
    + (earnedTaxableMedicalExcess || 0) + (otherTaxableAllowance || 0),
  );
}

/** 'YYYY-MM-DD' -> 'YYYY-MM' */
function yearMonth(dateStr) {
  return dateStr.slice(0, 7);
}

/** Inclusive count of calendar months between two 'YYYY-MM' strings. */
function monthSpan(fromYearMonth, toYearMonth) {
  const [fy, fm] = fromYearMonth.split('-').map(Number);
  const [ty, tm] = toYearMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/**
 * Section 7: cumulative YTD tax method (recommended). Self-corrects every
 * month for overtime, absences, and mid-year raises, because it always
 * projects off the CURRENT configured Basic and the ACTUAL YTD taxable sum.
 *
 * - taxableYTDPrior / taxDeductedYTDPrior = actual sums from July..(m-1),
 *   read back from this worker's prior PayrollItem rows in the same tax
 *   year (0 for the first month of the year, or a mid-year joiner's first
 *   month with this employer).
 * - remainingFullMonthBasic = the worker's *current* configured Basic —
 *   used to project months (m+1)..June assuming a full month, no overtime.
 *
 * Note: taxThisMonth is clamped at 0 (never a negative/refund withholding);
 * a genuine mid-year salary CUT can therefore lag behind the ideal true-up
 * by a rupee or two versus a system that allows negative monthly tax.
 */
function computeCumulativeTax({
  taxYearStartDate, taxYearEndDate, period, monthlyTaxable,
  taxableYTDPrior, taxDeductedYTDPrior, remainingFullMonthBasic, slabs,
}) {
  const taxYearStartYM = yearMonth(taxYearStartDate);
  const taxYearEndYM = yearMonth(taxYearEndDate);
  const totalMonths = monthSpan(taxYearStartYM, taxYearEndYM);
  const elapsedMonths = monthSpan(taxYearStartYM, period);
  const remainingFullMonths = Math.max(0, totalMonths - elapsedMonths);

  const taxableYTD = round2((Number(taxableYTDPrior) || 0) + (Number(monthlyTaxable) || 0));
  const projectedRemaining = round2((Number(remainingFullMonthBasic) || 0) * remainingFullMonths);
  const projectedAnnualTaxable = round2(taxableYTD + projectedRemaining);

  const annualTax = roundRupee(computeAnnualTax(projectedAnnualTaxable, slabs));
  const taxDueYTD = projectedAnnualTaxable > 0
    ? roundRupee(annualTax * (taxableYTD / projectedAnnualTaxable))
    : 0;
  const taxDeductedYTDPriorRupee = roundRupee(taxDeductedYTDPrior);
  const taxThisMonth = Math.max(0, taxDueYTD - taxDeductedYTDPriorRupee);

  return {
    remainingFullMonths,
    taxableYTD,
    projectedRemaining,
    projectedAnnualTaxable,
    annualTax,
    taxDueYTD,
    taxThisMonth,
  };
}

/**
 * Splits one worker's net pay for a period across their SalaryBeneficiary
 * rows (e.g. wife/parents), leaving the remainder on an implicit "self" line
 * paid to the worker's own bank details.
 *
 * `fixed` beneficiaries are reserved first, then `percentage` beneficiaries
 * take their cut of whatever's left (not of the full net) — so "20,000 fixed
 * to my wife, then 10% of what's left to my father" behaves the way an HR
 * person would expect it to read. Any rounding remainder from the percentage
 * splits is folded into the self line rather than a beneficiary, so money is
 * never invented or lost across the rows.
 *
 * Returns [] (not a one-element self-only array) when there are no active
 * beneficiaries, so callers can tell "no split configured" apart from "split
 * configured but 100% still goes to the worker" and fall back to the
 * pre-existing single-row behavior.
 *
 * Throws (status 400) if the configured split over-allocates the net amount —
 * this should already have been caught in HrService#setSalaryBeneficiaries,
 * but a run can be calculated well after beneficiaries were saved, so it's
 * re-checked here against whatever computedNet actually turned out to be.
 */
function computeDisbursementSplit(worker, netAmount, beneficiaries = []) {
  const net = round2(netAmount);
  const active = (beneficiaries || [])
    .filter((b) => b.isActive !== false)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  if (!active.length) return [];

  const fixedRows = active.filter((b) => b.splitType === 'fixed');
  const percentRows = active.filter((b) => b.splitType === 'percentage');

  const fixedTotal = round2(fixedRows.reduce((sum, b) => sum + (parseFloat(b.splitValue) || 0), 0));
  if (fixedTotal > net) {
    throw Object.assign(
      new Error(`Fixed-amount beneficiaries (${fixedTotal}) exceed net pay (${net})`),
      { status: 400 },
    );
  }
  const remaining = round2(net - fixedTotal);

  const percentTotal = percentRows.reduce((sum, b) => sum + (parseFloat(b.splitValue) || 0), 0);
  if (percentTotal > 100) {
    throw Object.assign(new Error(`Beneficiary percentages sum to ${percentTotal}%, over 100%`), { status: 400 });
  }

  const toLine = (b, amount) => ({
    beneficiaryId: b.id,
    name: b.name,
    relation: b.relation || '',
    splitType: b.splitType,
    splitValue: parseFloat(b.splitValue) || 0,
    bankName: b.bankName || '',
    bankAccountTitle: b.bankAccountTitle || '',
    bankAccountNumber: b.bankAccountNumber || '',
    iban: b.iban || '',
    amount: round2(amount),
  });

  const lines = [
    ...fixedRows.map((b) => toLine(b, parseFloat(b.splitValue) || 0)),
    ...percentRows.map((b) => toLine(b, remaining * ((parseFloat(b.splitValue) || 0) / 100))),
  ];

  const allocated = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const selfAmount = round2(net - allocated);
  if (selfAmount > 0) {
    lines.push({
      beneficiaryId: null,
      name: worker.user?.name || 'Self',
      relation: 'Self',
      splitType: null,
      splitValue: null,
      bankName: worker.bankName || '',
      bankAccountTitle: worker.bankAccountTitle || '',
      bankAccountNumber: worker.bankAccountNumber || '',
      iban: worker.iban || '',
      amount: selfAmount,
    });
  }

  return lines;
}

module.exports = {
  round2,
  roundRupee,
  toDateStr,
  daysInCalendarMonth,
  activeRangeForMonth,
  daysBetweenInclusive,
  computePayableDays,
  computeSalaryStructure,
  computeSalaryComponents,
  computeEarnedAmounts,
  computeMonthlyTaxable,
  yearMonth,
  monthSpan,
  computeCumulativeTax,
  computeDisbursementSplit,
};
