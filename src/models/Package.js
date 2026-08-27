const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Package = sequelize.define('Package', {
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
    serviceTypeKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Free-text blurb shown alongside the package wherever it's picked for sale —
    // scope notes, what's excluded, anything that doesn't belong in the
    // client-facing `features` bullet list.
    description: {
      type: DataTypes.TEXT,
    },
    tier: {
      type: DataTypes.STRING(50),
    },
    price: {
      type: DataTypes.DECIMAL(12, 2),
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    features: {
      type: DataTypes.JSON,
    },
    // Bundle of services included in this package: [{ serviceTypeKey, workflowTemplateId }, ...]
    // Selling the package spawns one project per entry. Falls back to the single
    // serviceTypeKey column above for legacy packages created before bundling existed.
    services: {
      type: DataTypes.JSON,
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Subscription vs. delivered service. A subscription is a recurring line the
    // agency resells rather than work the team performs — hosting, domains, SSL,
    // mailbox seats. It bills through exactly the same
    // ClientPackage -> Retainer -> Invoice chain as any other recurring package;
    // the flag only decides how it's grouped in the UI and that the client's
    // access to it is gated on payment (see ClientPackage.entitlement).
    // Implies isRecurring in practice, but the two are stored separately so an
    // annual domain renewal and a monthly retainer can coexist.
    isSubscription: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Who the subscription is actually bought FROM ("Hostinger", "Google
    // Workspace", "Namecheap") — shown on the Subscriptions tab so renewals can
    // be reconciled against the supplier's own bill. Free text, not a lookup;
    // meaningless on non-subscription packages.
    vendor: {
      type: DataTypes.STRING(255),
    },
    billingCycle: {
      type: DataTypes.ENUM('monthly', 'quarterly', 'annual'),
      defaultValue: 'monthly',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    // Retainer-only packages (e.g. hosting): selling this package still creates a
    // ClientPackage + retainer/invoice billing exactly as normal, but skips
    // spawning a Project/workflow entirely — hosting isn't a task-driven service,
    // just a recurring billing line. Config flag, not a hardcoded service check.
    skipProjectCreation: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Installment plan for one-time (non-recurring) package sales: an array of
    // { type: 'percent'|'amount', value, offsetDays, label } — e.g. 40% due
    // immediately, 30% in 30 days, 30% in 60 days; or a mix of percentages and
    // flat amounts. Percent-type rows should sum to 100 (validated where this is
    // set). Older rows saved before `type`/`value` existed still store
    // { percent, offsetDays, label } and are read as percent-type — see
    // ClientService#sellPackage's normalization. When set, selling the package
    // generates all N invoices upfront instead of the default "no invoice
    // created automatically" behavior for one-time sales.
    installmentPlan: {
      type: DataTypes.JSON,
    },
  }, {
    tableName: 'packages',
    timestamps: false,
  });

  Package.associate = (db) => {
    Package.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Package.hasMany(db.Project, { foreignKey: 'packageId', as: 'projects' });
    Package.hasMany(db.Retainer, { foreignKey: 'packageId', as: 'retainers' });
    Package.hasMany(db.ClientPackage, { foreignKey: 'packageId', as: 'sales' });
  };

  // Adds any columns this model defines that the live table is missing — called once
  // at startup instead of hand-written ALTER TABLE statements (see utils/schemaSync).
  Package.ensureSchema = () => ensureColumns(Package);

  return Package;
};
