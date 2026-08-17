const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Payment = sequelize.define('Payment', {
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
    // Card processing fee the client was charged on top of `amount` when
    // STRIPE_FEE_PAYER=client. Deliberately NOT folded into `amount`: the invoice
    // must reconcile to exactly its own total, so an invoice for $100 settled by
    // card records amount=100.00 / processingFee=3.20 rather than a $103.20
    // payment that would leave the invoice looking overpaid.
    processingFee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // The PaymentMethod label the client actually picked ("Bank Transfer
    // (Pakistan)"). `provider` is a coarse ENUM shared by several methods, so
    // this is what the admin needs to see to know which account to check.
    methodLabel: {
      type: DataTypes.STRING(120),
    },
    paidAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'payments',
    timestamps: false,
  });

  Payment.associate = (db) => {
    Payment.belongsTo(db.Invoice, { foreignKey: 'invoiceId', as: 'invoice' });
  };

  // The "Accept Payment" form's Method dropdown offers 'bank' (Bank Transfer), but the
  // live DB column's ENUM never included it — selecting it crashed with a MySQL "Data
  // truncated for column 'provider'" error, and since that throw happens before the
  // invoice is marked paid, the invoice (and client portal) kept showing unpaid/overdue.
  // Same reason 'wise'/'payoneer' must be widened here rather than only in the dropdown.
  // ensureColumns FIRST: this model gained `processingFee` and `methodLabel`
  // for card payments, and widening the provider ENUM alone would leave those
  // columns missing — which breaks every query that selects Payment (invoice
  // PDFs, the client portal, the invoice detail page) with an "Unknown column"
  // error rather than anything that points at the cause.
  Payment.ensureSchema = async () => {
    await ensureColumns(Payment);
    await ensureColumnType(Payment, 'provider');
  };

  return Payment;
};
