const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');


// A sold instance of a package to a client — the single "one invoice / one status
// rollup" record. Each included service spawns its own Project (workflow instance),
// all linked back here via projects.clientPackageId.
module.exports = (sequelize, DataTypes) => {
  const ClientPackage = sequelize.define('ClientPackage', {
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
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'clients', key: 'id' },
    },
    packageId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'packages', key: 'id' },
    },
    // Full package price before any discount is applied.
    basePrice: {
      type: DataTypes.DECIMAL(12, 2),
    },
    discountType: {
      type: DataTypes.ENUM('percent', 'fixed'),
    },
    discountValue: {
      type: DataTypes.DECIMAL(12, 2),
    },
    // Price actually charged to the client after the discount is applied.
    soldPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    billingCycle: {
      type: DataTypes.ENUM('monthly', 'quarterly', 'annual'),
      defaultValue: 'monthly',
    },
    status: {
      type: DataTypes.ENUM('active', 'pending', 'paused', 'completed', 'cancelled'),
      defaultValue: 'active',
    },
    startDate: {
      type: DataTypes.DATEONLY,
    },
    endDate: {
      type: DataTypes.DATEONLY,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'client_packages',
  });

  ClientPackage.associate = (db) => {
    ClientPackage.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    ClientPackage.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    ClientPackage.belongsTo(db.Package, { foreignKey: 'packageId', as: 'package' });
    ClientPackage.belongsTo(db.User, { foreignKey: 'createdBy', as: 'seller' });
    ClientPackage.hasMany(db.Project, { foreignKey: 'clientPackageId', as: 'workflowProjects' });
    ClientPackage.hasMany(db.Retainer, { foreignKey: 'clientPackageId', as: 'retainers' });
    ClientPackage.hasMany(db.Invoice, { foreignKey: 'clientPackageId', as: 'invoices' });
  };

  // Creates the table if missing, or adds missing columns if it already exists — an
  // earlier abandoned attempt at this feature already created the table by hand with
  // a slightly different column set, so this also reconciles that (see utils/schemaSync).
  ClientPackage.ensureSchema = () => ensureColumns(ClientPackage);

  return ClientPackage;
};
