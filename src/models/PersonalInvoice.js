const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

// Mirrors Invoice.js, but deliberately kept as its own table rather than a
// `type` flag on `invoices` — every revenue/outstanding-balance aggregation in
// AnalyticsService/ClientService hand-rolls its own Invoice/Payment queries with
// no shared "billable invoices" helper, so a flag would be one missed WHERE
// clause away from leaking personal invoices into company revenue. A separate
// table makes that structurally impossible instead of just currently-true.
module.exports = (sequelize, DataTypes) => {
  const PersonalInvoice = sequelize.define('PersonalInvoice', {
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
    contactId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'personal_contacts', key: 'id' },
    },
    number: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    status: {
      type: DataTypes.ENUM('draft', 'sent', 'paid', 'overdue', 'payment_review', 'void'),
      defaultValue: 'draft',
    },
    issuedAt: {
      type: DataTypes.DATEONLY,
    },
    dueAt: {
      type: DataTypes.DATEONLY,
    },
    total: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    notes: {
      type: DataTypes.TEXT,
    },
    // Which existing legal entity's letterhead prints on this invoice — always
    // manually picked (no LLC/LLP auto-detection like the official invoices).
    companyId: {
      type: DataTypes.CHAR(36),
    },
    preferredPaymentMethodId: {
      type: DataTypes.CHAR(36),
    },
    paymentLinkUrl: {
      type: DataTypes.TEXT,
    },
    // Credential for the public /personal-invoice/:token page.
    publicToken: {
      type: DataTypes.STRING(64),
      unique: true,
    },
    allowPartialPayment: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // ─── Stripe (Checkout Session id/url, same account as official invoices) ──
    stripeInvoiceId: {
      type: DataTypes.STRING(255),
    },
    stripeHostedUrl: {
      type: DataTypes.TEXT,
    },
    stripePartialAmount: {
      type: DataTypes.DECIMAL(12, 2),
    },
  }, {
    tableName: 'personal_invoices',
    indexes: [
      { unique: true, fields: ['org_id', 'number'] },
      { fields: ['org_id'] },
      { fields: ['contact_id'] },
    ],
  });

  PersonalInvoice.associate = (db) => {
    PersonalInvoice.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    PersonalInvoice.belongsTo(db.PersonalContact, { foreignKey: 'contactId', as: 'contact' });
    PersonalInvoice.belongsTo(db.Company, { foreignKey: 'companyId', as: 'company' });
    PersonalInvoice.belongsTo(db.PaymentMethod, { foreignKey: 'preferredPaymentMethodId', as: 'preferredPaymentMethod' });
    PersonalInvoice.hasMany(db.PersonalInvoiceLine, { foreignKey: 'personalInvoiceId', as: 'lines' });
    PersonalInvoice.hasMany(db.PersonalPayment, { foreignKey: 'personalInvoiceId', as: 'payments' });
  };

  PersonalInvoice.ensureSchema = async () => {
    await ensureColumns(PersonalInvoice);
    await ensureColumnType(PersonalInvoice, 'status');
    try {
      await PersonalInvoice.sequelize.getQueryInterface()
        .addIndex('personal_invoices', ['publicToken'], { unique: true, name: 'personal_invoices_public_token_uq' });
    } catch {
      // Already present.
    }
  };

  return PersonalInvoice;
};
