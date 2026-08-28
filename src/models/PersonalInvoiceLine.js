const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const PersonalInvoiceLine = sequelize.define('PersonalInvoiceLine', {
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
    description: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    qty: {
      type: DataTypes.DECIMAL(10, 2),
      defaultValue: 1,
    },
    unitPrice: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
    },
  }, {
    tableName: 'personal_invoice_lines',
    timestamps: false,
  });

  PersonalInvoiceLine.associate = (db) => {
    PersonalInvoiceLine.belongsTo(db.PersonalInvoice, { foreignKey: 'personalInvoiceId', as: 'invoice' });
  };

  PersonalInvoiceLine.ensureSchema = () => ensureColumns(PersonalInvoiceLine);

  return PersonalInvoiceLine;
};
