const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const WhiteLabelConfig = sequelize.define('WhiteLabelConfig', {
    orgId: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      references: { model: 'orgs', key: 'id' },
    },
    brandName: {
      type: DataTypes.STRING(100),
      defaultValue: 'Mohsin Designs Project Management',
    },
    logoUrl: {
      type: DataTypes.TEXT,
    },
    primaryColor: {
      type: DataTypes.STRING(20),
      defaultValue: '#0B1D5E',
    },
    customDomain: {
      type: DataTypes.STRING(255),
    },
    emailFrom: {
      type: DataTypes.STRING(255),
    },
    // The agency's own business details — shown to prospects on the public
    // quotation/agreement review page (and available for PDFs/letters later),
    // distinct from `emailFrom` (which is just the reply-to for system emails).
    businessAddress: {
      type: DataTypes.TEXT,
    },
    businessPhone: {
      type: DataTypes.STRING(50),
    },
    website: {
      type: DataTypes.STRING(255),
    },
    taxNumber: {
      type: DataTypes.STRING(100),
    },
    // Shown on generated invoice PDFs — a payment-instructions/policy callout
    // (e.g. accepted payment methods, bank details) and the formal Terms &
    // Conditions block. Both admin-editable, both optional (sections are
    // simply omitted from the PDF when blank).
    invoiceNotes: {
      type: DataTypes.TEXT,
    },
    invoiceTerms: {
      type: DataTypes.TEXT,
    },
    // ─── Letterhead ────────────────────────────────────────────────────────────
    // The header block drawn at the top of every generated document (invoices,
    // quotations, agreements, HR letters, SEO reports). Drawn in code rather than
    // stamped from a letterhead image/PDF so it stays crisp, searchable, and fully
    // editable from Admin → Branding without re-exporting artwork.
    //
    // `legalName` is the registered entity ("MOHSIN DESIGNS LLC") — distinct from
    // `brandName`, which is the app's display name ("… Project Management").
    legalName: {
      type: DataTypes.STRING(150),
    },
    // Multi-line office blocks. Each renders as its own labelled paragraph.
    usOfficeAddress: {
      type: DataTypes.TEXT,
    },
    pkOfficeAddress: {
      type: DataTypes.TEXT,
    },
    einNumber: {
      type: DataTypes.STRING(50),
    },
    contactEmail: {
      type: DataTypes.STRING(255),
    },
    // The quoted policy paragraph printed under the address block on every
    // letterhead ("For all official matters, the preferred communication
    // channel is email…").
    letterheadNote: {
      type: DataTypes.TEXT,
    },
    // Comma-separated subset of ['logo','address','tax','email','phone','website','note']
    // — which company details print by default on the Keywords/Backlinks SEO
    // report letterhead (Admin → Branding). A report request can still override
    // this with its own `?fields=` query, but nothing in the app does anymore;
    // orgs that never configure this get logo-only, not the full block.
    seoReportLetterheadFields: {
      type: DataTypes.STRING(255),
      defaultValue: 'logo',
    },
    // Admin-editable "thank you for your payment" email — sent whenever an
    // invoice becomes fully settled (Stripe or a manually-recorded payment).
    // Both blank by default; EmailService.sendPaymentThankYou falls back to
    // its own built-in wording when these are empty. See Admin → Branding.
    paymentThankYouSubject: {
      type: DataTypes.STRING(255),
    },
    paymentThankYouBody: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'white_label_configs',
    timestamps: false,
  });

  WhiteLabelConfig.ensureSchema = async () => ensureColumns(WhiteLabelConfig);

  WhiteLabelConfig.associate = (db) => {
    WhiteLabelConfig.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  return WhiteLabelConfig;
};
