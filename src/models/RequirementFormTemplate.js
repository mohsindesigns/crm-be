const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

// A reusable set of requirement questions an agency asks clients ("Website
// Design Intake", "SEO Onboarding", …). Staff pick one when emailing a client
// from a project; the field list is COPIED onto the resulting ClientRequest at
// send time rather than referenced, so editing a template later never rewrites
// the form a client has already been sent (or already answered).
module.exports = (sequelize, DataTypes) => {
  const RequirementFormTemplate = sequelize.define('RequirementFormTemplate', {
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
    // Internal-only — helps staff pick the right template, never shown to the client.
    description: {
      type: DataTypes.TEXT,
    },
    // When set, this is the "Client Req Boilerplate" default for that
    // ServiceType.key — the compose modal on a project auto-selects it based
    // on the project's own serviceTypeKey. At most one active template per
    // (orgId, serviceTypeKey) may carry this — enforced in
    // RequirementFormService, not a DB constraint (see schemaSync.js header).
    serviceTypeKey: {
      type: DataTypes.STRING(100),
    },
    // Ordered field definitions: [{ key, label, type, required, options? }],
    // the same shape lead forms use (see utils/formFields#normalizeFields).
    fields: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    // Prefilled into the compose step so the common case is "pick template,
    // click send". Both remain editable per send.
    defaultSubject: {
      type: DataTypes.STRING(255),
    },
    defaultMessage: {
      type: DataTypes.TEXT,
    },
    // Shown to the client on the public page after a successful submit.
    successMessage: {
      type: DataTypes.TEXT,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Soft delete — see models/softDeletable.js. Nothing in this app is ever
    // hard-deleted; deactivating just takes the template out of the picker.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'requirement_form_templates',
    indexes: [
      { fields: ['org_id'] },
    ],
  });

  RequirementFormTemplate.associate = (db) => {
    RequirementFormTemplate.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    RequirementFormTemplate.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    RequirementFormTemplate.hasMany(db.ClientRequest, { foreignKey: 'templateId', as: 'requests' });
  };

  RequirementFormTemplate.ensureSchema = () => ensureColumns(RequirementFormTemplate);

  return RequirementFormTemplate;
};
