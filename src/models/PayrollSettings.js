const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PayrollSettings = sequelize.define('PayrollSettings', {
    orgId: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      references: { model: 'orgs', key: 'id' },
    },
    payDayOfMonth: {
      type: DataTypes.INTEGER,
      defaultValue: 30,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'PKR',
    },
    workingHoursPerDay: {
      type: DataTypes.DECIMAL(4, 2),
      defaultValue: 8.0,
    },
    workingDaysPerMonth: {
      type: DataTypes.INTEGER,
      defaultValue: 26,
    },
    otMultiplier: {
      type: DataTypes.DECIMAL(4, 2),
      defaultValue: 1.5,
    },
    halfDayDeductionFactor: {
      type: DataTypes.DECIMAL(4, 2),
      defaultValue: 0.5,
    },
    leavePolicyJson: {
      type: DataTypes.JSON,
      defaultValue: {
        annual: 14,
        sick: 7,
        casual: 7,
        unpaid: 0,
      },
    },
    deductionRulesJson: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
    allowanceRulesJson: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
    emailSlipToEmployee: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    requireEmployeeConfirmation: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    employeeReviewWindowDays: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
    },
    // ─── Attendance policy: shift timing, lateness, half-day rules ───────────
    // Shift is 3:00 PM → 12:30 AM (9.5h) by default; both in Asia/Karachi wall-clock
    // "HH:MM" 24h format. End ≤ start is treated as wrapping past midnight.
    shiftStartTime: {
      type: DataTypes.STRING(5),
      defaultValue: '15:00',
    },
    shiftEndTime: {
      type: DataTypes.STRING(5),
      defaultValue: '00:30',
    },
    // Minutes after shiftStartTime before a check-in counts as late.
    lateGraceMinutes: {
      type: DataTypes.INTEGER,
      defaultValue: 15,
    },
    // Every N late arrivals in a calendar month convert into 1 day deducted
    // from leave balance (unpaid if the balance runs out) — see calculatePayrollItems.
    lateOccurrencesPerDeduction: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
    },
    // Which leave-balance bucket (from leavePolicyJson) absorbs late-arrival
    // penalty days before they become an unpaid deduction.
    latePenaltyLeaveType: {
      type: DataTypes.STRING(20),
      defaultValue: 'casual',
    },
    // % of the shift's total duration actually worked. Below halfDayMinPercent
    // = absent; from there up to (not including) halfDayFullPercent = half-day;
    // at/above halfDayFullPercent = full present day.
    halfDayMinPercent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 40.0,
    },
    halfDayFullPercent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 75.0,
    },
    // ISO day-of-week numbers (0=Sun..6=Sat) that require a pre-approved
    // half-day leave request before a half-day checkout is honored — any
    // other day can self-declare a half-day just by checking out early.
    halfDayRestrictedDays: {
      type: DataTypes.JSON,
      defaultValue: [1, 5], // Monday, Friday
    },
    // Weekly off days (0=Sun..6=Sat). Default Sat+Sun — used for leave-day
    // counting, check-in messaging, payroll non-working days, and auto weekend marks.
    weekendDays: {
      type: DataTypes.JSON,
      defaultValue: [0, 6], // Sunday, Saturday
    },
    // Medical allowance exempt from income tax up to this % of Basic (FBR rule,
    // config so it can track Finance Act changes) — see utils/payrollCalc.js.
    medicalExemptionCapPercent: {
      type: DataTypes.DECIMAL(5, 2),
      defaultValue: 10.0,
    },
  }, {
    tableName: 'payroll_settings',
    timestamps: false,
  });

  PayrollSettings.ensureSchema = async () => ensureColumns(PayrollSettings);

  PayrollSettings.associate = (db) => {
    PayrollSettings.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  return PayrollSettings;
};
