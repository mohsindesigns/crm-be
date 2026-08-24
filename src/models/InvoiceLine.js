const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const InvoiceLine = sequelize.define('InvoiceLine', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    invoiceId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'invoices', key: 'id' },
    },
    // Which sold package this single line bills for. The invoice HEADER also has
    // a clientPackageId, but it's cleared the moment two packages get merged onto
    // one bill (see InvoiceService#_appendLinesToInvoice) — so the header link
    // can't be trusted to answer "has this subscription been paid for?".
    // Stamping it per line survives the merge, which is what lets
    // SubscriptionService derive a subscription's entitlement from its invoices.
    // Null on manually-typed lines that aren't tied to a sale.
    clientPackageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'client_packages', key: 'id' },
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
    tableName: 'invoice_lines',
    timestamps: false,
  });

  InvoiceLine.associate = (db) => {
    InvoiceLine.belongsTo(db.Invoice, { foreignKey: 'invoiceId', as: 'invoice' });
    InvoiceLine.belongsTo(db.ClientPackage, { foreignKey: 'clientPackageId', as: 'clientPackage' });
  };

  // Adds clientPackageId to the existing table — additive only, see utils/schemaSync.
  InvoiceLine.ensureSchema = () => ensureColumns(InvoiceLine);

  return InvoiceLine;
};
