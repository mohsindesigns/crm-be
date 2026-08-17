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
