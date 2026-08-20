const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const CustomerDocument = sequelize.define('CustomerDocument', {
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
    type: {
      type: DataTypes.ENUM('quotation', 'agreement', 'proposal'),
      allowNull: false,
    },
    templateId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'document_templates', key: 'id' },
    },
    serviceTypeKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    number: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // Prospect basics stored inline — they aren't a client yet.
    prospectName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    businessName: {
      type: DataTypes.STRING(255),
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    phone: {
      type: DataTypes.STRING(50),
    },
    packageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'packages', key: 'id' },
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      defaultValue: 0,
    },
    // Pre-discount amount (line-item total, manual amount, or package price) —
    // stored so editing a document later can reapply a *changed* discount to
    // the original base instead of double-discounting the already-discounted
    // `amount`. Same percent/fixed pattern as ClientService._computeSoldPrice
    // for package sales; `amount` above always stores the final, post-discount
    // value. `discountType`/`discountValue` also feed the {{discount}} token.
    basePrice: {
      type: DataTypes.DECIMAL(12, 2),
    },
    discountType: {
      type: DataTypes.ENUM('percent', 'fixed'),
    },
    discountValue: {
      type: DataTypes.DECIMAL(12, 2),
    },
    // How many recurring billing cycles this discount lasts once the deal is sold
    // — e.g. 3 means "discounted for the first 3 invoices, then full price."
    // Distinct from `validUntil`, which is how long this PROPOSAL itself stands
    // before the client must respond, not how long the price inside it lasts
    // once agreed. Null means the discount never expires. Carried onto the
    // resulting ClientPackage(s) at conversion — see convert()'s
    // discountEndsAt computation.
    discountCycles: {
      type: DataTypes.INTEGER,
    },
    // [{ description, qty, unitPrice }, ...] — quotations only.
    lineItems: {
      type: DataTypes.JSON,
    },
    // Multi-service documents: [{ serviceTypeKey, packageId, price, scope }, ...].
    // When set, these render into the wrapper template's {{services_block}} token
    // (one fragment per service — see CustomerDocumentService._renderBody).
    // `serviceTypeKey` above keeps the first service for filtering/back-compat.
    services: {
      type: DataTypes.JSON,
    },
    // Alternative package tiers offered on ONE deal — e.g. Starter/Growth/Premium
    // — for the client to compare and pick exactly one, distinct from `services`
    // above (which bundles several DIFFERENT services into a single agreed deal).
    // Array of package ids. When this has 2+ entries, approving requires
    // selectedPackageId; with 0 or 1 entries no selection is required.
    packageOptions: {
      type: DataTypes.JSON,
    },
    // The package the client picked, from packageOptions, at approval time.
    selectedPackageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'packages', key: 'id' },
    },
    // "Build your own" mode — distinct from packageOptions (one pick across the
    // WHOLE deal): offers candidate packages PER SERVICE, and the client is free
    // to pick one package for any, all, or none of them independently.
    // [{ serviceTypeKey, packageIds: [...] }, ...].
    packageMenu: {
      type: DataTypes.JSON,
    },
    // The client's actual per-service picks from packageMenu, at approval time —
    // { [serviceTypeKey]: packageId }. A service with no entry means they skipped it.
    menuSelections: {
      type: DataTypes.JSON,
    },
    // Optional — why they picked it. Never required.
    selectionReason: {
      type: DataTypes.TEXT,
    },
    // Rendered content frozen at send time — what the customer actually sees/signs.
    bodySnapshot: {
      type: DataTypes.TEXT('long'),
    },
    status: {
      type: DataTypes.ENUM('draft', 'sent', 'viewed', 'approved', 'rejected', 'expired'),
      defaultValue: 'draft',
    },
    // Unguessable random token — the public review page authorizes purely on this.
    publicToken: {
      type: DataTypes.STRING(64),
    },
    validUntil: {
      type: DataTypes.DATEONLY,
    },
    // Admin override of the template's default terms for this specific document.
    scopeTerms: {
      type: DataTypes.TEXT,
    },
    responseNote: {
      type: DataTypes.TEXT,
    },
    signerName: {
      type: DataTypes.STRING(255),
    },
    signedAt: {
      type: DataTypes.DATE,
    },
    signatureMethod: {
      type: DataTypes.ENUM('typed', 'esign_provider'),
      defaultValue: 'typed',
    },
    signatureIp: {
      type: DataTypes.STRING(64),
    },
    // The client this document was raised for. Documents are quoted TO an
    // existing client now — the client record (and so their "Pay via CRM" flag)
    // is created first, which is what lets an approved quotation bill on the
    // right rail immediately instead of guessing and renumbering later.
    //
    // Nullable only for documents raised before that flow existed; those still
    // create their client at conversion time via convertedClientId.
    clientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    // Set when the client fills in the mandatory billing details on the review
    // page after approving. Billing waits for this — the invoice needs the
    // address and legal business name that only the client can confirm.
    detailsSubmittedAt: {
      type: DataTypes.DATE,
    },
    convertedClientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    convertedProjectId: {
      type: DataTypes.CHAR(36),
      references: { model: 'projects', key: 'id' },
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    sentAt: {
      type: DataTypes.DATE,
    },
    viewedAt: {
      type: DataTypes.DATE,
    },
    respondedAt: {
      type: DataTypes.DATE,
    },
    // Pay-before-convert: a client paying by card is sent straight to a Stripe
    // Checkout Session (mode: "payment", not a Stripe Invoice — see
    // StripeService.js header) for the document's own total, BEFORE any
    // Client/Project/Invoice exists — see
    // StripeService.startDocumentPayment/_convertAndMarkPaidFromDocument. Nothing
    // is created if they abandon the page, which is the whole point: raising an
    // invoice (or spinning up a project) for a sale that was never actually paid
    // is the liability this flow exists to avoid. Column names hold the Checkout
    // Session's id/url (kept from the pre-rewrite Invoice-based flow).
    stripeInvoiceId: {
      type: DataTypes.STRING(255),
    },
    stripeHostedUrl: {
      type: DataTypes.TEXT,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'customer_documents',
  });

  CustomerDocument.associate = (db) => {
    CustomerDocument.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    CustomerDocument.belongsTo(db.DocumentTemplate, { foreignKey: 'templateId', as: 'template' });
    CustomerDocument.belongsTo(db.Package, { foreignKey: 'packageId', as: 'package' });
    CustomerDocument.belongsTo(db.Package, { foreignKey: 'selectedPackageId', as: 'selectedPackage' });
    CustomerDocument.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    CustomerDocument.belongsTo(db.Client, { foreignKey: 'convertedClientId', as: 'convertedClient' });
    CustomerDocument.belongsTo(db.Project, { foreignKey: 'convertedProjectId', as: 'convertedProject' });
    CustomerDocument.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    CustomerDocument.hasMany(db.DocumentEvent, { foreignKey: 'documentId', as: 'events' });
  };

  CustomerDocument.ensureSchema = async () => {
    await ensureColumns(CustomerDocument);
    // publicToken is 256 bits of crypto.randomBytes entropy (collision odds are
    // astronomically low) but was never DB-enforced as unique — belt-and-suspenders
    // against any future weakening of the token generator. ensureColumns() only
    // ever adds columns, never indexes, so this is applied directly; idempotent
    // via try/catch since queryInterface.addIndex() errors if it already exists.
    try {
      await sequelize.getQueryInterface().addIndex('customer_documents', ['publicToken'], {
        unique: true,
        name: 'customer_documents_public_token_unique',
      });
    } catch {
      // already exists — fine
    }
  };

  return CustomerDocument;
};
