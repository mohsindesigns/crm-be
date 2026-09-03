const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PayrollItem = sequelize.define('PayrollItem', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    payrollRunId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'payroll_runs', key: 'id' },
    },
    workerId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workers', key: 'id' },
    },
    presentDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    absentDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    leaveDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    halfDays: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    overtimeHours: {
      type: DataTypes.DECIMAL(6, 2),
      defaultValue: 0,
    },
    base: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    additions: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
    deductions: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
    computedGross: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    computedNet: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    employeeStatus: {
      type: DataTypes.ENUM('pending_review', 'confirmed', 'concern_raised', 'rectifying'),
      defaultValue: 'pending_review',
    },
    employeeConfirmedAt: {
      type: DataTypes.DATE,
    },
    concernNote: {
      type: DataTypes.TEXT,
    },
    adminNote: {
      type: DataTypes.TEXT,
    },
    isLocked: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Late-arrival penalty transparency — see calculatePayrollItems.
    lateCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    latePenaltyDays: {
      type: DataTypes.DECIMAL(4, 1),
      defaultValue: 0,
    },
    latePenaltyUnpaidDays: {
      type: DataTypes.DECIMAL(4, 1),
      defaultValue: 0,
    },
    // ─── Tax withholding transparency (utils/payrollCalc.js, cumulative YTD
    // method) — persisted so next month's calculation can read prior months'
    // actuals back out, and so an accountant can audit any single month. ───
    calendarDaysInMonth: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    payableDaysCalendar: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 0,
    },
    earnedBasic: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    earnedMedical: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    // This month's taxable salary (earned Basic + overtime + any taxable
    // medical excess above the exemption cap). Medical up to the cap is
    // excluded — see Section 6 of the payroll tax spec.
    monthlyTaxable: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    // Cumulative taxable salary from the start of the tax year through and
    // including this month (actuals only).
    taxableYTD: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    projectedAnnualTaxable: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    annualTaxProjected: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    // This month's tax withheld — mirrors deductions.tax, kept as a real
    // column so YTD sums don't require parsing JSON across every prior row.
    taxAmount: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    // Snapshot of computedNet split across the worker's SalaryBeneficiary rows,
    // frozen at lock time (see HrService#advancePayrollStatus, the 'locked'
    // branch) so a later edit to the worker's split doesn't rewrite history for
    // a run that's already been disbursed. Array of
    // { beneficiaryId | null, name, relation, bankName, bankAccountTitle,
    //   bankAccountNumber, iban, amount }. beneficiaryId is null for the
    // synthetic "self" line (worker's own bank details) — see
    // utils/payrollCalc.js#computeDisbursementSplit. Empty array = no split
    // configured, full computedNet goes to the worker's own account (the
    // pre-existing behavior, still the default via getDisbursementData).
    disbursementSplit: {
      type: DataTypes.JSON,
      defaultValue: [],
    },
    // Per-employee, per-run override of PayrollRun.deductAttendance — set from
    // the Actions column on the Payroll Items table. null (the default) means
    // "follow the run's toggle"; true/false pins this one worker for this run
    // only, regardless of what the run-level toggle is set to. Preserved
    // across recalculation — see HrService#calculatePayrollItems.
    deductAttendanceOverride: {
      type: DataTypes.BOOLEAN,
    },
  }, {
    tableName: 'payroll_items',
  });

  PayrollItem.ensureSchema = async () => ensureColumns(PayrollItem);

  PayrollItem.associate = (db) => {
    PayrollItem.belongsTo(db.PayrollRun, { foreignKey: 'payrollRunId', as: 'run' });
    PayrollItem.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    PayrollItem.hasOne(db.SalarySlip, { foreignKey: 'payrollItemId', as: 'slip' });
  };

  return PayrollItem;
};
