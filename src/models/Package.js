const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Package = sequelize.define('Package', {
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
    serviceTypeKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    tier: {
      type: DataTypes.STRING(50),
    },
    price: {
      type: DataTypes.DECIMAL(12, 2),
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    features: {
      type: DataTypes.JSON,
    },
    // Bundle of services included in this package: [{ serviceTypeKey, workflowTemplateId }, ...]
    // Selling the package spawns one project per entry. Falls back to the single
    // serviceTypeKey column above for legacy packages created before bundling existed.
    services: {
      type: DataTypes.JSON,
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    billingCycle: {
      type: DataTypes.ENUM('monthly', 'quarterly', 'annual'),
      defaultValue: 'monthly',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    // Retainer-only packages (e.g. hosting): selling this package still creates a
    // ClientPackage + retainer/invoice billing exactly as normal, but skips
    // spawning a Project/workflow entirely — hosting isn't a task-driven service,
    // just a recurring billing line. Config flag, not a hardcoded service check.
    skipProjectCreation: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Installment plan for one-time (non-recurring) package sales: an array of
    // { percent, offsetDays, label } — e.g. 40% due immediately, 30% in 30 days,
    // 30% in 60 days. Percents should sum to 100 (validated where this is set).
    // When set, selling the package generates all N invoices upfront instead of
    // the default "no invoice created automatically" behavior for one-time sales.
    installmentPlan: {
      type: DataTypes.JSON,
    },
  }, {
    tableName: 'packages',
    timestamps: false,
  });

  Package.associate = (db) => {
    Package.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Package.hasMany(db.Project, { foreignKey: 'packageId', as: 'projects' });
    Package.hasMany(db.Retainer, { foreignKey: 'packageId', as: 'retainers' });
    Package.hasMany(db.ClientPackage, { foreignKey: 'packageId', as: 'sales' });
  };

  // Adds any columns this model defines that the live table is missing — called once
  // at startup instead of hand-written ALTER TABLE statements (see utils/schemaSync).
  Package.ensureSchema = () => ensureColumns(Package);

  return Package;
};
