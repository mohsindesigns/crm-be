const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * A legal entity that issues documents — e.g. "MOHSIN DESIGNS LLC" (US) and the
 * Pakistan company. Distinct from `WhiteLabelConfig`, which stays as the *app's*
 * branding (product name, portal colour, portal logo). This is the *business*
 * that appears on paper.
 *
 * Why this exists: the letterhead used to print the US office AND the Pakistan
 * office on every single document, because both addresses lived on one
 * WhiteLabelConfig row. An appointment letter for a Karachi employee carried a
 * Wyoming address and an EIN; a US client invoice carried a Karachi address.
 * Splitting them into rows lets each entity own its own identity.
 *
 * Which entity prints on what is decided globally by two checkboxes, not per
 * document:
 *
 *   useForHrDocuments → appointment / experience / bank-opening letters,
 *                       salary slips, and other HR paperwork
 *   useForBilling     → invoices, quotations, agreements, proposals
 *
 * Ticking both boxes on both companies prints both blocks side by side; ticking
 * one box on one company prints only that one. A document category with nothing
 * ticked falls back to the legacy WhiteLabelConfig letterhead, so an org that
 * never configures companies keeps working exactly as before.
 */
module.exports = (sequelize, DataTypes) => {
  const Company = sequelize.define('Company', {
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
    // The registered entity name printed at the top of the letterhead.
    legalName: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    // Short uppercase code used to build document numbers — "MDL" produces
    // MDL-INV-26-0001. Kept separate from the name so renaming the entity never
    // renumbers historical documents.
    code: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'CO',
    },
    // Free-text label for the address block, e.g. "US Office" / "Pakistan
    // Office". Printed as the bolded prefix on the first address line.
    officeLabel: {
      type: DataTypes.STRING(60),
      defaultValue: 'Office',
    },
    address: {
      type: DataTypes.TEXT,
    },
    // Tax registration — an EIN in the US, an NTN/STRN in Pakistan. `taxLabel`
    // keeps the printed prefix accurate for whichever jurisdiction this is.
    taxLabel: {
      type: DataTypes.STRING(30),
      defaultValue: 'EIN',
    },
    taxNumber: {
      type: DataTypes.STRING(60),
    },
    email: {
      type: DataTypes.STRING(255),
    },
    phone: {
      type: DataTypes.STRING(50),
    },
    website: {
      type: DataTypes.STRING(255),
    },
    // Per-entity wordmark. Blank falls back to the bundled Mohsin Designs logo,
    // so a company added without artwork still produces a branded document.
    logoUrl: {
      type: DataTypes.TEXT,
    },
    // Optional scanned signature and company stamp used on HR letters.
    signatureUrl: {
      type: DataTypes.TEXT,
    },
    stampUrl: {
      type: DataTypes.TEXT,
    },
    // The quoted policy paragraph under the address block.
    letterheadNote: {
      type: DataTypes.TEXT,
    },
    // Billing-only copy, used when this company issues an invoice.
    invoiceNotes: {
      type: DataTypes.TEXT,
    },
    invoiceTerms: {
      type: DataTypes.TEXT,
    },
    defaultCurrency: {
      type: DataTypes.STRING(10),
      defaultValue: 'USD',
    },
    // ─── Which documents this entity appears on ───────────────────────────────
    useForHrDocuments: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    useForBilling: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Tie-breaker when more than one company is ticked for the same category:
    // the primary one supplies the document-number prefix (a single document
    // can only carry one number, however many letterheads it prints).
    isPrimary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  }, {
    tableName: 'companies',
    indexes: [
      { fields: ['orgId'] },
      { fields: ['orgId', 'isActive'] },
    ],
  });

  Company.associate = (db) => {
    Company.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  Company.ensureSchema = async () => {
    await ensureColumns(Company);
    try {
      await Company.sequelize.getQueryInterface()
        .addIndex('companies', ['orgId', 'isActive'], { name: 'companies_org_active_idx' });
    } catch {
      // Already present.
    }
  };

  /**
   * Seed the first company from the org's existing WhiteLabelConfig so upgrading
   * changes nothing visible on day one: the same details print on the same
   * documents until an admin edits them or adds a second entity.
   *
   * The legacy config carried a US block and a Pakistan block on one row, so
   * both are split out into their own companies here. The US entity keeps the
   * EIN and is marked primary (it is the invoicing entity); the Pakistan entity
   * is created ticked for HR only, which is the arrangement the split was asked
   * for in the first place. Only ever runs when the org has zero companies.
   */
  Company.seedFromBranding = async (orgId, config) => {
    if (!orgId) return;
    const existing = await Company.count({ where: { orgId } });
    if (existing > 0) return;

    const { LETTERHEAD_DEFAULTS } = require('../services/letterhead');
    const pick = (value, fallback) => {
      const s = value == null ? '' : String(value).trim();
      return s || fallback;
    };

    const legalName = pick(config?.legalName, LETTERHEAD_DEFAULTS.legalName);
    const note = pick(config?.letterheadNote, LETTERHEAD_DEFAULTS.letterheadNote);
    const email = pick(config?.contactEmail, LETTERHEAD_DEFAULTS.contactEmail);
    const phone = pick(config?.businessPhone, LETTERHEAD_DEFAULTS.businessPhone);
    const website = pick(config?.website, '');
    const usAddress = pick(config?.usOfficeAddress, LETTERHEAD_DEFAULTS.usOfficeAddress);
    const pkAddress = pick(config?.pkOfficeAddress, LETTERHEAD_DEFAULTS.pkOfficeAddress);

    const rows = [{
      id: uuidv4(),
      orgId,
      legalName,
      code: 'MDL',
      officeLabel: 'US Office',
      address: usAddress,
      taxLabel: 'EIN',
      taxNumber: pick(config?.einNumber, LETTERHEAD_DEFAULTS.einNumber),
      email,
      phone,
      website,
      logoUrl: null,
      letterheadNote: note,
      invoiceNotes: config?.invoiceNotes || null,
      invoiceTerms: config?.invoiceTerms || null,
      defaultCurrency: 'USD',
      // Preserves pre-split behaviour: the entity that has always issued
      // invoices keeps issuing them, and keeps appearing on HR letters too
      // until an admin unticks it.
      useForBilling: true,
      useForHrDocuments: true,
      isPrimary: true,
      sortOrder: 0,
      isActive: true,
    }];

    if (pkAddress) {
      rows.push({
        id: uuidv4(),
        orgId,
        legalName,
        code: 'MDP',
        officeLabel: 'Pakistan Office',
        address: pkAddress,
        taxLabel: 'NTN',
        taxNumber: pick(config?.taxNumber, ''),
        email,
        phone,
        website,
        logoUrl: null,
        letterheadNote: note,
        invoiceNotes: null,
        invoiceTerms: null,
        defaultCurrency: 'PKR',
        useForBilling: false,
        useForHrDocuments: true,
        isPrimary: false,
        sortOrder: 1,
        isActive: true,
      });
    }

    await Company.bulkCreate(rows);
  };

  /**
   * The companies whose details print on a given document category.
   *
   * @param {'billing'|'hr'} category
   * @returns {Promise<Company[]>} ordered; empty when nothing is ticked, which
   *   callers treat as "fall back to the legacy WhiteLabelConfig letterhead".
   */
  Company.forCategory = async (orgId, category) => {
    const field = category === 'hr' ? 'useForHrDocuments' : 'useForBilling';
    return Company.findAll({
      where: { orgId, isActive: true, [field]: true },
      order: [['isPrimary', 'DESC'], ['sortOrder', 'ASC'], ['createdAt', 'ASC']],
    });
  };

  /** The entity that supplies a document number's prefix for this category. */
  Company.primaryFor = async (orgId, category) => {
    const rows = await Company.forCategory(orgId, category);
    return rows[0] || null;
  };

  return Company;
};
