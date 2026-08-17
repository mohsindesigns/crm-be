const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * The payment options a client sees on an invoice in the portal.
 *
 * Two kinds, and the difference is who confirms the money arrived:
 *
 *   • kind 'stripe'  — one row only. Picking it creates a real Stripe Invoice and
 *     redirects the client to Stripe's hosted payment page. Stripe's webhook then
 *     records the Payment and marks our invoice `paid` with no human involved.
 *
 *   • kind 'manual'  — bank transfer, Wise, Payoneer, anything else. The client
 *     pays out-of-band using `instructions`, uploads proof, and the invoice moves
 *     to `payment_review` until an admin confirms it.
 *
 * These are rows rather than a hard-coded list because the instructions (IBAN,
 * Wise email, account title) change, and an admin needs to edit them without a
 * deploy. `provider` is what gets written to Payment.provider, so it must stay
 * within that column's ENUM — the admin UI picks it from a fixed list.
 */
module.exports = (sequelize, DataTypes) => {
  const PaymentMethod = sequelize.define('PaymentMethod', {
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
    kind: {
      type: DataTypes.ENUM('stripe', 'manual'),
      allowNull: false,
      defaultValue: 'manual',
    },
    // Written verbatim to Payment.provider — must be one of that ENUM's values.
    provider: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'manual',
    },
    // What the client sees in the dropdown, e.g. "Bank Transfer (Pakistan)".
    label: {
      type: DataTypes.STRING(120),
      allowNull: false,
    },
    // Shown once the client selects this method: account title, IBAN, swift,
    // Wise email — whatever they need to actually send the money. Markdown-free
    // plain text, rendered with line breaks preserved.
    instructions: {
      type: DataTypes.TEXT,
    },
    // Manual methods normally require a screenshot/receipt before the invoice
    // moves to payment_review. Turn off for methods paid in person (cash).
    requiresProof: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  }, {
    tableName: 'payment_methods',
    indexes: [
      { fields: ['orgId'] },
      { fields: ['orgId', 'isActive'] },
    ],
  });

  PaymentMethod.associate = (db) => {
    PaymentMethod.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  PaymentMethod.ensureSchema = async () => {
    await ensureColumns(PaymentMethod);
    try {
      await PaymentMethod.sequelize.getQueryInterface()
        .addIndex('payment_methods', ['orgId', 'isActive'], { name: 'payment_methods_org_active_idx' });
    } catch {
      // Already present.
    }
  };

  /**
   * First-run defaults, so an org that upgrades into this feature has a working
   * dropdown immediately instead of an empty one. Only ever runs when the org has
   * no methods at all — it must not resurrect rows an admin deliberately deleted.
   */
  PaymentMethod.seedDefaults = async (orgId) => {
    if (!orgId) return;
    const existing = await PaymentMethod.count({ where: { orgId } });
    if (existing > 0) return;

    await PaymentMethod.bulkCreate([
      {
        id: uuidv4(),
        orgId,
        kind: 'stripe',
        provider: 'stripe',
        label: 'Credit / Debit Card (Stripe)',
        instructions: 'You will be redirected to Stripe\'s secure payment page. Your invoice is marked paid automatically as soon as the payment clears — no receipt upload needed.',
        requiresProof: false,
        isActive: true,
        sortOrder: 0,
      },
      {
        id: uuidv4(),
        orgId,
        kind: 'manual',
        provider: 'bank',
        label: 'Bank Transfer',
        instructions: 'Transfer the invoice total to our bank account, then upload the transfer receipt below.\n\nAccount Title: \nBank: \nAccount / IBAN: \nSWIFT: \n\nPlease quote the invoice number as the payment reference.',
        requiresProof: true,
        isActive: true,
        sortOrder: 1,
      },
      {
        id: uuidv4(),
        orgId,
        kind: 'manual',
        provider: 'wise',
        label: 'Wise',
        instructions: 'Send the invoice total via Wise, then upload the payment confirmation below.\n\nWise account email: \n\nPlease quote the invoice number as the reference.',
        requiresProof: true,
        isActive: true,
        sortOrder: 2,
      },
      {
        id: uuidv4(),
        orgId,
        kind: 'manual',
        provider: 'payoneer',
        label: 'Payoneer',
        instructions: 'Send the invoice total via Payoneer, then upload the payment confirmation below.\n\nPayoneer account email: \n\nPlease quote the invoice number as the reference.',
        requiresProof: true,
        isActive: true,
        sortOrder: 3,
      },
    ]);
  };

  return PaymentMethod;
};
