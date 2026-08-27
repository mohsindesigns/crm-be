const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * The card processing fee passed on to the client, per currency.
 *
 * Stripe's rate is not one number: it differs by country and settlement
 * currency, so a single 2.9% + $0.30 baked into the environment was wrong for
 * every currency but one. An admin sets the real rate per currency here.
 *
 * The fee is ALWAYS charged to the client — it is added as a line on the Stripe
 * invoice, so the agency receives the invoice total intact. There is no
 * "company absorbs it" option; that was a setting nobody wanted.
 *
 * A currency with no rule charges no fee. That is the safe default: silently
 * inventing a surcharge for a currency the admin hasn't configured would
 * overcharge a real client.
 */
module.exports = (sequelize, DataTypes) => {
  const PaymentFeeRule = sequelize.define('PaymentFeeRule', {
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
    // ISO code, uppercase — 'USD', 'PKR', 'GBP'.
    currency: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    // Percentage of the amount due, e.g. 2.900. Three decimals because real
    // card rates are quoted at that precision (e.g. 2.9%, 1.4%, 3.25%).
    percent: {
      type: DataTypes.DECIMAL(6, 3),
      allowNull: false,
      defaultValue: 0,
    },
    // Flat amount added on top, in the same currency (Stripe's per-transaction
    // component — $0.30, £0.20, and so on).
    fixedFee: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // Optional country label, purely so the admin can see why a rate is what it
    // is ("United States", "Pakistan") — the fee is matched on currency.
    label: {
      type: DataTypes.STRING(80),
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  }, {
    tableName: 'payment_fee_rules',
    indexes: [
      { unique: true, fields: ['orgId', 'currency'], name: 'payment_fee_rules_org_currency_unique' },
    ],
  });

  PaymentFeeRule.associate = (db) => {
    PaymentFeeRule.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  PaymentFeeRule.ensureSchema = async () => {
    await ensureColumns(PaymentFeeRule);
    try {
      await PaymentFeeRule.sequelize.getQueryInterface().addIndex(
        'payment_fee_rules',
        ['orgId', 'currency'],
        { unique: true, name: 'payment_fee_rules_org_currency_unique' },
      );
    } catch {
      // Already present.
    }
  };

  /**
   * The fee to add for one charge, rounded to the currency's precision.
   *
   * Grossed up rather than a flat surcharge on the invoice net: Stripe takes
   * its cut off the *total* charged, including the fee line itself, so a
   * naive `net * percent + fixed` surcharge would still leave the agency
   * short by percent-of-the-fee. Solving for the charge amount that nets the
   * agency exactly `InvoiceNet` after Stripe's cut:
   *   ChargeAmount = (InvoiceNet + FixedFee) / (1 − PercentFee)
   * and the fee passed on to the client is ChargeAmount − InvoiceNet.
   *
   * Returns 0 when no active rule covers the currency — see the note above on
   * why that is the right default.
   */
  PaymentFeeRule.feeFor = async (orgId, currency, amount) => {
    const base = Number(amount) || 0;
    if (base <= 0) return 0;

    const code = String(currency || 'USD').toUpperCase();
    const rule = await PaymentFeeRule.findOne({
      where: { orgId, currency: code, isActive: true },
    }).catch(() => null);
    if (!rule) return 0;

    const percent = parseFloat(rule.percent) || 0;
    const fixed = parseFloat(rule.fixedFee) || 0;
    const percentFee = percent / 100;
    if (percentFee >= 1) return 0; // misconfigured rule — division below would blow up or go negative

    const chargeAmount = (base + fixed) / (1 - percentFee);
    const fee = chargeAmount - base;
    if (fee <= 0) return 0;

    // Zero-decimal currencies (JPY, KRW, …) have no minor unit to round to.
    const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
    return ZERO_DECIMAL.has(code) ? Math.round(fee) : Math.round(fee * 100) / 100;
  };

  /**
   * First-run rules, seeded from whatever the environment was using so an
   * upgrade doesn't silently change what clients are charged. Only ever runs
   * when the org has no rules at all.
   */
  PaymentFeeRule.seedDefaults = async (orgId) => {
    if (!orgId) return;
    const existing = await PaymentFeeRule.count({ where: { orgId } });
    if (existing > 0) return;

    const envPercent = Number(process.env.STRIPE_FEE_PERCENT);
    const envFixed = Number(process.env.STRIPE_FEE_FIXED);

    await PaymentFeeRule.create({
      id: uuidv4(),
      orgId,
      currency: 'USD',
      label: 'United States',
      percent: Number.isFinite(envPercent) ? envPercent : 2.9,
      fixedFee: Number.isFinite(envFixed) ? envFixed : 0.30,
      isActive: true,
    });
  };

  return PaymentFeeRule;
};
