/**
 * One-off: seed a TaxYear + illustrative FBR-style slabs for the real
 * Mohsin Designs org (none exist yet), then recalculate the existing
 * August 2026 payroll run with the new engine so it can be viewed live
 * in the app. Slab numbers are ILLUSTRATIVE — confirm with the accountant
 * before relying on them (see Payroll_Tax_Calculation_Spec.docx Section 11).
 *
 * Usage: node src/scripts/seedDemoTaxYearAndRecalc.js
 */
require('dotenv').config();
const app = require('../app');
const db = require('../models');
const HrService = require('../services/HrService');

const ORG_ID = '5d9d9145-3ad8-4884-8ba2-4247c66c7776'; // Mohsin Designs

const SLABS = [
  { minAmount: 0, maxAmount: 600000, ratePercent: 0, fixedAmount: 0 },
  { minAmount: 600000, maxAmount: 1200000, ratePercent: 15, fixedAmount: 0 },
  { minAmount: 1200000, maxAmount: 2200000, ratePercent: 25, fixedAmount: 90000 },
  { minAmount: 2200000, maxAmount: 3200000, ratePercent: 30, fixedAmount: 340000 },
  { minAmount: 3200000, maxAmount: 4100000, ratePercent: 35, fixedAmount: 640000 },
  { minAmount: 4100000, maxAmount: null, ratePercent: 35, fixedAmount: 955000 },
];

async function main() {
  await app.schemaReady;

  let taxYear = await db.TaxYear.findOne({ where: { orgId: ORG_ID, label: '2026-27' } });
  if (!taxYear) {
    taxYear = await HrService.createTaxYear(ORG_ID, {
      label: '2026-27', startDate: '2026-07-01', endDate: '2027-06-30', activate: true,
    });
    for (const s of SLABS) await HrService.createTaxSlab(taxYear.id, ORG_ID, s);
    console.log('Created TaxYear 2026-27 with 6 slabs, activated.');
  } else {
    console.log('TaxYear 2026-27 already exists, skipping creation.');
  }

  const run = await db.PayrollRun.findOne({ where: { orgId: ORG_ID, period: '2026-08' } });
  if (!run) {
    console.log('No August 2026 payroll run found — nothing to recalculate.');
    process.exit(0);
  }
  const items = await HrService.calculatePayrollItems(run.id, ORG_ID);

  console.log(`\nRecalculated ${items.length} payroll items for run ${run.id} (period 2026-08):\n`);
  for (const item of items) {
    const worker = await db.Worker.findByPk(item.workerId, {
      include: [{ model: db.User, as: 'user', attributes: ['name'] }],
    });
    console.log(
      `${(worker.user?.name || item.workerId).padEnd(20)} `
      + `Basic=${item.earnedBasic} Medical=${item.earnedMedical} `
      + `Gross=${item.computedGross} Taxable(mo)=${item.monthlyTaxable} `
      + `ProjectedAnnualTaxable=${item.projectedAnnualTaxable} `
      + `Tax=${item.taxAmount} Net=${item.computedNet}`,
    );
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
