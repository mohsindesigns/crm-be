const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Client = sequelize.define('Client', {
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
    status: {
      type: DataTypes.ENUM('active', 'paused', 'churned'),
      defaultValue: 'active',
    },
    defaultCurrency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    notes: {
      type: DataTypes.TEXT,
    },
    // Stripe Customer for this client, created lazily the first time they pay a
    // card invoice from the portal. Cached here so repeat payments reuse the same
    // customer record (one payer in the Stripe dashboard, with their full invoice
    // history, rather than a new anonymous customer per invoice).
    stripeCustomerId: {
      type: DataTypes.STRING(255),
    },
    // How this client settles invoices, set once per client rather than per
    // invoice. 'stripe' puts every new invoice on the card rail automatically —
    // Stripe number series, a live PAY INVOICE link on the PDF, and the portal
    // defaulting to the card option. 'manual' (the default) leaves the existing
    // bank-transfer / receipt-upload flow exactly as it was, so nothing changes
    // for clients nobody has opted in.
    billingMode: {
      type: DataTypes.ENUM('manual', 'stripe'),
      defaultValue: 'manual',
    },
    // Only meaningful when billingMode is 'stripe'. The org's per-currency card
    // rate (Admin → Payments → Card processing fees, PaymentFeeRule) is applied
    // to every Stripe charge by default — true keeps that; unticking it for a
    // specific client means the agency absorbs the card fee instead of passing
    // it on, for every invoice AND quotation/agreement/proposal payment this
    // client makes (see StripeService.processingFeeFor).
    chargeCardFee: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    // Soft delete — distinct from `status` (a commercial lifecycle: active /
    // paused / churned). A churned client is still a real client you report on;
    // an inactive one has been removed from day-to-day use. See softDeletable.js.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'clients',
    indexes: [{ fields: ['org_id'] }],
  });

  Client.associate = (db) => {
    Client.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Client.hasMany(db.Contact, { foreignKey: 'clientId', as: 'contacts' });
    Client.hasMany(db.Project, { foreignKey: 'clientId', as: 'projects' });
    Client.hasMany(db.Invoice, { foreignKey: 'clientId', as: 'invoices' });
    Client.hasMany(db.Retainer, { foreignKey: 'clientId', as: 'retainers' });
    Client.hasMany(db.ClientPackage, { foreignKey: 'clientId', as: 'clientPackages' });
  };

  Client.ensureSchema = async () => {
    await ensureColumns(Client);
    // Safety net after soft-delete rollout: if every client was flipped inactive
    // by a bad column default, restore them. Intentionally-deactivated orgs with
    // a mix of active/inactive are left alone.
    try {
      const [active, inactive] = await Promise.all([
        Client.count({ where: { isActive: true } }),
        Client.count({ where: { isActive: false } }),
      ]);
      if (active === 0 && inactive > 0) {
        await Client.update({ isActive: true }, { where: { isActive: false } });
        console.warn(`[Schema] Reactivated ${inactive} client(s) that were all marked inactive.`);
      }
    } catch {
      // ignore
    }
  };

  return Client;
};
