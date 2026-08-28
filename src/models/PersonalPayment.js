const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PersonalPayment = sequelize.define('PersonalPayment', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    personalInvoiceId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'personal_invoices', key: 'id' },
    },
    provider: {
      type: DataTypes.ENUM('manual', 'bank', 'stripe', 'paddle', 'payfast', 'wise', 'payoneer'),
      defaultValue: 'manual',
    },
    providerRef: {
      type: DataTypes.STRING(255),
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    processingFee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    methodLabel: {
      type: DataTypes.STRING(120),
    },
    paidAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'personal_payments',
    timestamps: false,
  });

  PersonalPayment.associate = (db) => {
    PersonalPayment.belongsTo(db.PersonalInvoice, { foreignKey: 'personalInvoiceId', as: 'invoice' });
  };

  PersonalPayment.ensureSchema = async () => {
    await ensureColumns(PersonalPayment);
    await ensureColumnType(PersonalPayment, 'provider');
  };

  return PersonalPayment;
};
