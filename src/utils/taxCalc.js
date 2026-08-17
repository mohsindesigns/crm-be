/**
 * Pakistan FBR-style annual tax from slabs.
 * Matching band: tax = fixedAmount + ratePercent% × (yearlyIncome − minAmount).
 * Enter FBR rows as-is (e.g. "30,000 + 15% of amount exceeding 1,200,000").
 */
function computeAnnualTax(yearlyIncome, slabs) {
  const income = Math.max(0, Number(yearlyIncome) || 0);
  if (!income || !Array.isArray(slabs) || !slabs.length) return 0;

  const sorted = [...slabs].sort(
    (a, b) => (Number(a.minAmount) || 0) - (Number(b.minAmount) || 0),
  );

  let match = null;
  for (const slab of sorted) {
    const min = Number(slab.minAmount) || 0;
    const maxRaw = slab.maxAmount;
    const max = maxRaw == null || maxRaw === '' ? null : Number(maxRaw);
    if (income >= min && (max == null || Number.isNaN(max) || income <= max)) {
      match = slab;
      break;
    }
  }

  if (!match) {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (income >= (Number(sorted[i].minAmount) || 0)) {
        match = sorted[i];
        break;
      }
    }
  }
  if (!match) return 0;

  const min = Number(match.minAmount) || 0;
  const fixed = Number(match.fixedAmount) || 0;
  const rate = Number(match.ratePercent) || 0;
  const tax = fixed + Math.max(0, income - min) * (rate / 100);
  return Math.round(tax * 100) / 100;
}

/** Monthly withholding = annual tax on (monthlyTaxable × 12) ÷ 12. */
function computeMonthlyTaxWithholding(monthlyTaxable, slabs) {
  const monthly = Math.max(0, Number(monthlyTaxable) || 0);
  const annualTax = computeAnnualTax(monthly * 12, slabs);
  return Math.round((annualTax / 12) * 100) / 100;
}

module.exports = { computeAnnualTax, computeMonthlyTaxWithholding };
