const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Contact = sequelize.define('Contact', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'clients', key: 'id' },
    },
    userId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
    },
    phone: {
      type: DataTypes.STRING(50),
    },
    role: {
      type: DataTypes.STRING(100),
    },
    // ─── Billing identity ──────────────────────────────────────────────────────
    // A client can have several contacts (a day-to-day project contact, an
    // accounts-payable contact, an owner). These fields capture the details an
    // invoice has to print, and `useForInvoice` marks which single contact the
    // invoice PDF bills to — otherwise generatePdfBuffer just grabbed whichever
    // contact happened to have portal access, which is rarely the billing one.
    //
    // `businessName` is the registered business name to bill (may differ from
    // the CRM's client name — e.g. "410 Muscle Therapy" trading as "410 MT LLC").
    businessName: {
      type: DataTypes.STRING(255),
    },
    state: {
      type: DataTypes.STRING(100),
    },
    billingAddress: {
      type: DataTypes.TEXT,
    },
    useForInvoice: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    portalAccess: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Portal login one-time code (email second factor)
    loginCodeHash: {
      type: DataTypes.STRING(255),
    },
    loginCodeExpiresAt: {
      type: DataTypes.DATE,
    },
    loginCodeAttempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'contacts',
    timestamps: false,
  });

  Contact.associate = (db) => {
    Contact.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    Contact.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
  };

  Contact.ensureSchema = () => ensureColumns(Contact);

  return Contact;
};
