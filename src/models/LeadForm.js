const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const LeadForm = sequelize.define('LeadForm', {
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
    // Optional — a form can be scoped to one project ("Website Redesign intake
    // form") or left unscoped for a general enquiry form. Nullable on purpose.
    projectId: {
      type: DataTypes.CHAR(36),
      references: { model: 'projects', key: 'id' },
    },
    // Free text, not an ENUM — campaigns are named by whoever runs the ad/landing
    // page, the same reasoning as BlogTask.contentType being free text.
    campaign: {
      type: DataTypes.STRING(255),
    },
    // Set when a client built this form themselves from their portal — null for
    // agency-built forms. This is what scopes every portal lead-form/lead route
    // (see routes/portalLeadForms.js, routes/portalLeads.js): a portal contact
    // only ever sees rows where clientId === their own client, while staff see
    // everything org-wide regardless of who built it.
    clientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    // Optional — a staff-built form can be linked to an existing client so
    // every new lead it captures is also emailed to that client (see
    // LeadService#submitPublic). Distinct from `clientId` above: that field
    // means "this client built the form themselves" and drives portal
    // visibility/ownership, whereas this is purely a notification target and
    // never grants the linked client portal access to the form or its leads.
    notifyClientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Ordered field definitions: [{ key, label, type, required, options? }].
    // Submissions are validated against this at submit time (see LeadFormService)
    // and stored keyed by `key` on Lead.fieldData — there's no fixed column set
    // because every project/campaign's form asks different questions.
    fields: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    // The only credential the public embed page/route needs — same role as
    // CustomerDocument.publicToken (see PublicDocumentService): nothing else
    // gates GET/POST on the public routes, so it must be unguessable.
    publicToken: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true,
    },
    // Paused forms 404 on the public routes (still visible/editable in the CRM)
    // — lets a form be taken offline without losing its leads or embed link.
    status: {
      type: DataTypes.ENUM('active', 'paused'),
      allowNull: false,
      defaultValue: 'active',
    },
    successMessage: {
      type: DataTypes.TEXT,
    },
    // Appearance: { headline?, description?, primaryColor?, backgroundColor?,
    // buttonText?, showLogo?, showName?, borderRadius? } — every key optional,
    // unset ones fall back to org branding / sensible defaults (see
    // LeadFormService#normalizeTheme / #effectiveTheme). Kept as one JSON blob
    // rather than a column per property since this is purely display config,
    // never queried or filtered on.
    theme: {
      type: DataTypes.JSON,
    },
    // If set, the embed page redirects here after a successful submit instead
    // of showing successMessage inline (e.g. to a client's own "thank you" page).
    redirectUrl: {
      type: DataTypes.TEXT,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Set instead of createdBy when a portal contact (not a staff User) built
    // this form — the two are mutually exclusive, never both set.
    createdByContactId: {
      type: DataTypes.CHAR(36),
      references: { model: 'contacts', key: 'id' },
    },
    // Soft delete — see models/softDeletable.js. Deactivating a form also takes
    // its embed offline (same effect as `status: paused`, but this is the
    // admin-only "make it disappear from the list" flag, not the day-to-day one).
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'lead_forms',
    indexes: [
      { fields: ['org_id'] },
      { fields: ['project_id'] },
      { unique: true, fields: ['public_token'] },
    ],
  });

  LeadForm.associate = (db) => {
    LeadForm.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    LeadForm.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    LeadForm.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    LeadForm.belongsTo(db.Client, { foreignKey: 'notifyClientId', as: 'notifyClient' });
    LeadForm.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    LeadForm.belongsTo(db.Contact, { foreignKey: 'createdByContactId', as: 'creatorContact' });
    LeadForm.hasMany(db.Lead, { foreignKey: 'formId', as: 'leads' });
  };

  LeadForm.ensureSchema = () => ensureColumns(LeadForm);

  return LeadForm;
};
