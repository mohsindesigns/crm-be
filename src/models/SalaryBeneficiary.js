const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * A recipient of part of a worker's net salary — e.g. a worker who wants
 * their pay split between themselves, a spouse, and a parent.
 *
 * A worker with no active beneficiaries behaves exactly as before: their full
 * net pay goes to their own Worker.bank* fields. Beneficiaries only cover the
 * *other* recipients — whatever isn't allocated to them is assumed to still
 * go to the worker's own account, so nothing needs to change for the common
 * case. See utils/payrollCalc.js#computeDisbursementSplit for how splitType/
 * splitValue turn into actual amounts against a payroll item's net pay.
 */
module.exports = (sequelize, DataTypes) => {
  const SalaryBeneficiary = sequelize.define('SalaryBeneficiary', {
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
    workerId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workers', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Free-text label shown next to the name — "Wife", "Father", etc. Not an
    // enum: HR should be able to write whatever makes sense to them.
    relation: {
      type: DataTypes.STRING(100),
    },
    splitType: {
      type: DataTypes.ENUM('percentage', 'fixed'),
      allowNull: false,
      defaultValue: 'percentage',
    },
    // Percentage points (0-100) if splitType is 'percentage', else a flat
    // currency amount in the worker's Worker.currency.
    splitValue: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    bankName: {
      type: DataTypes.STRING(255),
    },
    bankBranchName: {
      type: DataTypes.STRING(255),
    },
    bankAccountTitle: {
      type: DataTypes.STRING(255),
    },
    bankAccountNumber: {
      type: DataTypes.STRING(50),
    },
    iban: {
      type: DataTypes.STRING(50),
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  }, {
    tableName: 'salary_beneficiaries',
    indexes: [
      { fields: ['org_id'] },
      { fields: ['worker_id'] },
    ],
  });

  SalaryBeneficiary.associate = (db) => {
    SalaryBeneficiary.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    SalaryBeneficiary.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
  };

  SalaryBeneficiary.ensureSchema = async () => ensureColumns(SalaryBeneficiary);

  return SalaryBeneficiary;
};
