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
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
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
