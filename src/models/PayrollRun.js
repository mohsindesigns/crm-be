const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PayrollRun = sequelize.define('PayrollRun', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'orgs', key: 'id' },
    },
    period: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('draft', 'open_for_review', 'locked', 'paid'),
      defaultValue: 'draft',
    },
    // Per-run override (holidays / summer months). Defaults from PayrollSettings
    // at create time; used as divisor + unmarked-absence baseline in calculate.
    workingDaysPerMonth: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 26,
    },
    // Per-run switch: whether calculatePayrollItems pays out overtime for this
    // month. Attendance-detected overtimeHours are still recorded either way —
    // this only zeroes the overtimePay addition to gross when off.
    includeOvertime: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Per-run switch: whether unpaid absence, half-day, and late-penalty days
    // reduce pay this month. Attendance is still recorded/shown either way —
    // this only zeroes their contribution to unpaidAbsentDays in calculate.
    // Overridable per employee — see PayrollItem.deductAttendanceOverride.
    deductAttendance: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Set once, in advancePayrollStatus, the moment the run first transitions
    // to 'paid' — the real-world disbursement date, used as "Payment Date" on
    // the Tax Certificate (see HrService#generateTaxCertificate). Nothing
    // else in this app tracked this before; SalarySlipService's own
    // "Payment Date" field is a separate, cruder fallback (today's date, the
    // slip's print date) for a run that hasn't reached 'paid' yet.
    paidAt: {
      type: DataTypes.DATE,
    },
    // This month's Computerized Payment Receipt number — the tax authority's
    // receipt for depositing the tax withheld across this whole run, entered
    // by HR once that deposit is actually made. That typically happens after
    // the run is locked/paid, so unlike workingDaysPerMonth/includeOvertime/
    // deductAttendance this is editable regardless of run status — see
    // HrService#updatePayrollRun. Free text, no format validation ("we just
    // save it there"). Printed as "CPR No" on the Tax Certificate — see
    // TaxCertificateService.
    cprNumber: {
      type: DataTypes.STRING(100),
    },
  }, {
    tableName: 'payroll_runs',
    indexes: [
      { unique: true, fields: ['org_id', 'period'] },
    ],
    updatedAt: false,
  });

  PayrollRun.associate = (db) => {
    PayrollRun.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    PayrollRun.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    PayrollRun.hasMany(db.PayrollItem, { foreignKey: 'payrollRunId', as: 'items' });
  };

  PayrollRun.ensureSchema = () => ensureColumns(PayrollRun);

  return PayrollRun;
};
