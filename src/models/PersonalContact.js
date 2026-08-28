const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PersonalContact = sequelize.define('PersonalContact', {
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
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    billingName: {
      type: DataTypes.STRING(255),
    },
    billingAddress: {
      type: DataTypes.TEXT,
    },
    contactEmail: {
      type: DataTypes.STRING(255),
    },
    contactPhone: {
      type: DataTypes.STRING(50),
    },
    defaultCurrency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    // Cached Stripe Customer id, same pattern/account as Client.stripeCustomerId
    // — lets a repeat "pay via CRM" checkout reuse the same Customer.
    stripeCustomerId: {
      type: DataTypes.STRING(255),
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  }, {
    tableName: 'personal_contacts',
    indexes: [
      { fields: ['org_id'] },
    ],
  });

  PersonalContact.associate = (db) => {
    PersonalContact.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    PersonalContact.hasMany(db.PersonalInvoice, { foreignKey: 'contactId', as: 'invoices' });
  };

  PersonalContact.ensureSchema = () => ensureColumns(PersonalContact);

  return PersonalContact;
};
