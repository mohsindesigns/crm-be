/**
 * Integration test for the payroll tax withholding engine (utils/payrollCalc.js
 * + HrService.calculatePayrollItems), verifying all 6 test cases from
 * Payroll_Tax_Calculation_Spec.docx Section 10 against the REAL database
 * engine — not just the pure functions.
 *
 * Creates a disposable org (+ tax year/slabs/settings/workers/attendance),
 * runs 12 real payroll periods through HrService, asserts the results, then
 * deletes everything it created. Safe to run against the dev database.
 *
 * Usage: npm run payroll:test-tax
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { v4: uuidv4 } = require('uuid');
const app = require('../app'); // triggers schemaReady (creates the new columns) without starting the server
const db = require('../models');
const HrService = require('../services/HrService');
const { computeAnnualTax } = require('../utils/taxCalc');

const {
  Org, User, Worker, Attendance, PayrollRun, PayrollItem, TaxYear, TaxSlab, PayrollSettings,
} = db;

const MARKER = `payroll-tax-test-${Date.now()}`;
let failures = 0;
let passed = 0;

function assertClose(label, actual, expected, tolerance = 0.02) {
  const a = Number(actual);
  const e = Number(expected);
  const ok = Number.isFinite(a) && Math.abs(a - e) <= tolerance;
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}: ${a} (expected ~${e})`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}: got ${a}, expected ~${e} (tolerance ${tolerance})`);
  }
}

function assertTrue(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label} ${detail}`);
  }
}

function isWeekend(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}

function eachDay(startStr, endStr) {
  const days = [];
  for (
    let t = new Date(`${startStr}T00:00:00Z`).getTime();
    t <= new Date(`${endStr}T00:00:00Z`).getTime();
    t += 86400000
  ) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

function monthBounds(period) {
  const [y, m] = period.split('-').map(Number);
  const start = `${period}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const end = `${period}-${String(daysInMonth).padStart(2, '0')}`;
  return { start, end, daysInMonth };
}

// Tax year 2026-07-01..2027-06-30, all 12 periods in order.
const TAX_YEAR_START = '2026-07-01';
const TAX_YEAR_END = '2027-06-30';
const PERIODS = [
  '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12',
  '2027-01', '2027-02', '2027-03', '2027-04', '2027-05', '2027-06',
];
// Simple, deterministic 2-bracket slab table: 0% to 600,000, 15% above.
const SLABS = [
  { minAmount: 0, maxAmount: 600000, ratePercent: 0, fixedAmount: 0, sortOrder: 0 },
  { minAmount: 600000, maxAmount: null, ratePercent: 15, fixedAmount: 0, sortOrder: 1 },
];

async function main() {
  await app.schemaReady;

  const org = await Org.create({ name: `Payroll Tax Test ${MARKER}`, subdomain: MARKER, plan: 'internal' });
  const orgId = org.id;

  try {
    const admin = await User.create({
      orgId, name: 'Test Admin', email: `admin-${MARKER}@example.test`, passwordHash: 'x', isActive: true,
    });

    await PayrollSettings.create({ orgId, medicalExemptionCapPercent: 10.0 });

    const taxYear = await HrService.createTaxYear(orgId, {
      label: '2026-27', startDate: TAX_YEAR_START, endDate: TAX_YEAR_END, activate: true,
    });
    for (const s of SLABS) await HrService.createTaxSlab(taxYear.id, orgId, s);

    // ── Workers, one per test case ──────────────────────────────────────
    async function makeWorker(name, { salaryBase, joiningDate = '2020-01-01' }) {
      const u = await User.create({
        orgId, name, email: `${name.toLowerCase()}-${MARKER}@example.test`, passwordHash: 'x', isActive: true,
      });
      return Worker.create({
        orgId, userId: u.id, workerType: 'employee', status: 'active', salaryBase, joiningDate,
      });
    }

    const workerA = await makeWorker('FullYearA', { salaryBase: 90000 }); // Test 1
    const workerB = await makeWorker('MidYearJoinerB', { salaryBase: 90000, joiningDate: '2026-08-18' }); // Test 2
    const workerC = await makeWorker('AbsenceC', { salaryBase: 90000 }); // Test 3
    const workerD = await makeWorker('OvertimeD', { salaryBase: 90000 }); // Test 4
    const workerE = await makeWorker('LowSalaryE', { salaryBase: 30000 }); // Test 5
    const workerF = await makeWorker('RaiseF', { salaryBase: 90000 }); // Test 6
    const workerG = await makeWorker('ComponentsG', { salaryBase: 90000 }); // Test 7
    await workerG.update({
      salaryComponents: [
        {
          id: 'hra', name: 'House Rent Allowance', amount: 15000, taxable: true,
        },
        {
          id: 'conv', name: 'Conveyance Allowance', amount: 5000, taxable: false,
        },
      ],
    });

    // ── Attendance: present every weekday for every worker across the full
    // range they're employed, with three deliberate exceptions ──────────
    const attendanceRows = [];
    const rangeStart = TAX_YEAR_START;
    const rangeEnd = TAX_YEAR_END;
    const ABSENCE_DAYS = new Set(['2026-09-02', '2026-09-03', '2026-09-04']); // worker C, 3 unpaid absent days
    const OVERTIME_DAY = '2026-11-03'; // worker D, one day with 2h overtime

    for (const worker of [workerA, workerB, workerC, workerD, workerE, workerF, workerG]) {
      const employedFrom = String(worker.joiningDate).slice(0, 10);
      for (const day of eachDay(rangeStart, rangeEnd)) {
        if (day < employedFrom) continue;
        if (isWeekend(day)) continue; // weekends auto-marked by ensureWeekendMarks
        if (worker.id === workerC.id && ABSENCE_DAYS.has(day)) {
          attendanceRows.push({
            id: uuidv4(), orgId, workerId: worker.id, date: day, status: 'absent', source: 'manual',
          });
          continue;
        }
        const isOtDay = worker.id === workerD.id && day === OVERTIME_DAY;
        attendanceRows.push({
          id: uuidv4(),
          orgId,
          workerId: worker.id,
          date: day,
          status: 'present',
          checkIn: '09:00:00',
          checkOut: isOtDay ? '19:00:00' : '17:00:00',
          hours: isOtDay ? 10 : 8,
          source: 'manual',
        });
      }
    }
    await Attendance.bulkCreate(attendanceRows);

    // ── Run all 12 payroll periods in order (mid-year raise for worker F
    // takes effect right before the January run) ───────────────────────
    const itemsByWorker = {
      A: [], B: [], C: [], D: [], E: [], F: [], G: [],
    };
    const workerKey = {
      [workerA.id]: 'A',
      [workerB.id]: 'B',
      [workerC.id]: 'C',
      [workerD.id]: 'D',
      [workerE.id]: 'E',
      [workerF.id]: 'F',
      [workerG.id]: 'G',
    };

    for (const period of PERIODS) {
      if (period === '2027-01') {
        await workerF.update({ salaryBase: 120000 }); // Test 6: raise effective January
      }
      const run = await HrService.createPayrollRun(period, orgId, admin.id);
      const items = await HrService.calculatePayrollItems(run.id, orgId);
      for (const item of items) {
        const key = workerKey[item.workerId];
        if (key) itemsByWorker[key].push({ period, item });
      }
    }

    // ════════════════════════════════════════════════════════════════════
    console.log('\nTest 1 — Full-year employee, no absence: 12 deductions sum exactly to annual slab tax');
    const expectedAnnualTaxA = Math.round(computeAnnualTax(90000 * 12, SLABS));
    const sumTaxA = itemsByWorker.A.reduce((s, { item }) => s + Number(item.taxAmount || 0), 0);
    assertTrue('12 payroll items created for worker A', itemsByWorker.A.length === 12, `(got ${itemsByWorker.A.length})`);
    assertClose('sum of 12 months tax == annual slab tax', sumTaxA, expectedAnnualTaxA, 0.5);
    assertClose('every month earnedBasic == full Basic (no absence)', itemsByWorker.A[0].item.earnedBasic, 90000, 0.01);

    console.log('\nTest 2 — Joiner 18 Aug, Basic 90,000: annual projection = 940,645, not 1,080,000');
    const augItemB = itemsByWorker.B.find((x) => x.period === '2026-08').item;
    const julItemB = itemsByWorker.B.find((x) => x.period === '2026-07');
    assertTrue('no payroll item for worker B in July (not yet joined)', !julItemB);
    assertClose('August monthlyTaxable == 40,645 (90,000 x 14/31)', augItemB.monthlyTaxable, 40645.16, 0.02);
    assertClose('August projectedAnnualTaxable == 940,645', augItemB.projectedAnnualTaxable, 940645.16, 0.02);
    assertTrue(
      'projection is NOT the flat-x12 bug (1,080,000)',
      Math.abs(Number(augItemB.projectedAnnualTaxable) - 1080000) > 100000,
      `(got ${augItemB.projectedAnnualTaxable})`,
    );

    console.log('\nTest 3 — 3 unpaid absent days in a month: EarnedBasic and taxable both drop; tax reduces');
    const sepItemC = itemsByWorker.C.find((x) => x.period === '2026-09').item;
    const augItemC = itemsByWorker.C.find((x) => x.period === '2026-08').item;
    assertClose('Sept (3 absent, 30-day month) earnedBasic == 81,000', sepItemC.earnedBasic, 81000, 0.02);
    assertTrue(
      'Sept earnedBasic < a full-attendance month',
      Number(sepItemC.earnedBasic) < Number(augItemC.earnedBasic),
      `(Sept ${sepItemC.earnedBasic} vs Aug ${augItemC.earnedBasic})`,
    );
    assertTrue(
      'Sept monthlyTaxable dropped accordingly',
      Number(sepItemC.monthlyTaxable) < Number(augItemC.monthlyTaxable),
      `(Sept ${sepItemC.monthlyTaxable} vs Aug ${augItemC.monthlyTaxable})`,
    );

    console.log('\nTest 4 — Overtime in one month: that month’s taxable & tax rise; cumulative re-trues next month');
    const novItemD = itemsByWorker.D.find((x) => x.period === '2026-11').item;
    const decItemD = itemsByWorker.D.find((x) => x.period === '2026-12').item;
    const octItemD = itemsByWorker.D.find((x) => x.period === '2026-10').item;
    assertTrue(
      'November monthlyTaxable > October (OT bump)',
      Number(novItemD.monthlyTaxable) > Number(octItemD.monthlyTaxable),
      `(Nov ${novItemD.monthlyTaxable} vs Oct ${octItemD.monthlyTaxable})`,
    );
    assertClose('December monthlyTaxable back to plain Basic (no OT repeat)', decItemD.monthlyTaxable, 90000, 0.02);
    assertClose(
      'Nov and Dec projectedAnnualTaxable agree (self-corrected, one-off OT)',
      novItemD.projectedAnnualTaxable, decItemD.projectedAnnualTaxable, 0.5,
    );

    console.log('\nTest 5 — Salary below taxable threshold: tax = 0');
    const anyItemE = itemsByWorker.E.find((x) => x.period === '2026-10').item;
    assertTrue('worker E (30,000/mo, well under 600,000/yr threshold) owes no tax', Number(anyItemE.taxAmount) === 0, `(got ${anyItemE.taxAmount})`);

    console.log('\nTest 6 — Mid-year raise (90k→120k in Jan): projection & remaining deductions recompute upward');
    const decItemF = itemsByWorker.F.find((x) => x.period === '2026-12').item;
    const janItemF = itemsByWorker.F.find((x) => x.period === '2027-01').item;
    assertClose('January monthlyTaxable reflects the new 120,000 Basic', janItemF.monthlyTaxable, 120000, 0.02);
    // YTD after Jan = 6x90,000 + 120,000 = 660,000; remaining 5 months x 120,000 = 600,000
    assertClose('January projectedAnnualTaxable == 1,260,000 (re-projected upward)', janItemF.projectedAnnualTaxable, 1260000, 0.5);
    assertTrue(
      'January tax due jumps relative to December (raise flows through immediately)',
      Number(janItemF.taxAmount) > Number(decItemF.taxAmount),
      `(Jan ${janItemF.taxAmount} vs Dec ${decItemF.taxAmount})`,
    );
    const expectedAnnualTaxF = Math.round(computeAnnualTax(6 * 90000 + 6 * 120000, SLABS));
    const sumTaxF = itemsByWorker.F.reduce((s, { item }) => s + Number(item.taxAmount || 0), 0);
    assertClose('worker F: 12 months still sum exactly to the correct final annual tax', sumTaxF, expectedAnnualTaxF, 0.5);

    console.log('\nTest 7 — Taxable vs non-taxable salary components (HRA taxable, Conveyance non-taxable)');
    const octItemG = itemsByWorker.G.find((x) => x.period === '2026-10').item;
    assertClose('monthlyTaxable includes the 15,000 taxable HRA (90,000 + 15,000)', octItemG.monthlyTaxable, 105000, 0.02);
    assertClose('computedGross includes BOTH components (90k Basic + 9k Medical + 15k HRA + 5k Conveyance)', octItemG.computedGross, 119000, 0.02);
    assertClose('House Rent Allowance line == 15,000', octItemG.additions?.['House Rent Allowance'], 15000, 0.02);
    assertClose('Conveyance Allowance line == 5,000 (paid, just not taxed)', octItemG.additions?.['Conveyance Allowance'], 5000, 0.02);
    assertTrue(
      'Conveyance Allowance flagged non-taxable in additions.nonTaxableComponents',
      Array.isArray(octItemG.additions?.nonTaxableComponents) && octItemG.additions.nonTaxableComponents.includes('Conveyance Allowance'),
      `(got ${JSON.stringify(octItemG.additions?.nonTaxableComponents)})`,
    );
    assertTrue(
      'House Rent Allowance NOT flagged non-taxable',
      !(octItemG.additions?.nonTaxableComponents || []).includes('House Rent Allowance'),
    );
    const expectedAnnualTaxG = Math.round(computeAnnualTax(105000 * 12, SLABS));
    const sumTaxG = itemsByWorker.G.reduce((s, { item }) => s + Number(item.taxAmount || 0), 0);
    assertClose('worker G: 12 months sum exactly to annual tax on taxable-only total (1,260,000)', sumTaxG, expectedAnnualTaxG, 0.5);

    console.log(`\n${passed} passed, ${failures} failed.`);
  } finally {
    // ── Cleanup: delete everything scoped to this disposable org ───────
    const runIds = (await PayrollRun.findAll({ where: { orgId }, attributes: ['id'] })).map((r) => r.id);
    if (runIds.length) await PayrollItem.destroy({ where: { payrollRunId: runIds } });
    await PayrollRun.destroy({ where: { orgId } });
    await Attendance.destroy({ where: { orgId } });
    await Worker.destroy({ where: { orgId } });
    const taxYears = await TaxYear.findAll({ where: { orgId }, attributes: ['id'] });
    if (taxYears.length) await TaxSlab.destroy({ where: { taxYearId: taxYears.map((y) => y.id) } });
    await TaxYear.destroy({ where: { orgId } });
    await PayrollSettings.destroy({ where: { orgId } });
    await User.destroy({ where: { orgId } });
    await Org.destroy({ where: { id: orgId } });
    console.log('Cleaned up test org and all associated rows.');
  }
}

main()
  .then(() => process.exit(failures > 0 ? 1 : 0))
  .catch((err) => {
    console.error('Test script crashed:', err);
    process.exit(1);
  });
