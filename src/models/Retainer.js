const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Retainer = sequelize.define('Retainer', {
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
      references: { model: 'packages', key: 'id' },
    },
    projectId: {
      type: DataTypes.CHAR(36),
      references: { model: 'projects', key: 'id' },
    },
    clientPackageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'client_packages', key: 'id' },
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    cycle: {
      type: DataTypes.ENUM('monthly', 'quarterly', 'annual'),
      defaultValue: 'monthly',
    },
    nextInvoiceDate: {
      type: DataTypes.DATEONLY,
    },
    status: {
      type: DataTypes.ENUM('active', 'paused', 'cancelled'),
      defaultValue: 'active',
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'retainers',
    updatedAt: false,
  });

  Retainer.associate = (db) => {
    Retainer.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Retainer.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    Retainer.belongsTo(db.Package, { foreignKey: 'packageId', as: 'package' });
    Retainer.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Retainer.belongsTo(db.ClientPackage, { foreignKey: 'clientPackageId', as: 'clientPackage' });
  };

  Retainer.ensureSchema = () => ensureColumns(Retainer);

  return Retainer;
};
