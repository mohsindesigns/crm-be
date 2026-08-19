const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Lead = sequelize.define('Lead', {
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
    // Nullable — a form-sourced lead always has one, but this table is also
    // where any future non-form source (Meta Lead Ads, manual entry) lands, and
    // those won't have a LeadForm behind them.
    formId: {
      type: DataTypes.CHAR(36),
      references: { model: 'lead_forms', key: 'id' },
    },
    // 'form' today; room for 'meta' / 'manual' later without a migration.
    source: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'form',
    },
    // Denormalized from the form at submit time so the Leads list can filter by
    // project/campaign without joining lead_forms on every request, and so the
    // value survives even if the form is later edited or deactivated.
    projectId: {
      type: DataTypes.CHAR(36),
      references: { model: 'projects', key: 'id' },
    },
    campaign: {
      type: DataTypes.STRING(255),
    },
    // Denormalized from LeadForm.clientId — set when this lead came in through
    // a client-built form (portal), null for agency-built forms. This is the
    // form owner, not an outcome — distinct from convertedClientId below,
    // which is only set after this specific lead is turned into a Client.
    sourceClientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    // Raw submitted answers, keyed by the form field's `key` at the time of
    // submission — see LeadForm.fields. Not fixed columns because every
    // project/campaign's form asks different questions.
    fieldData: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    // Pulled out of fieldData at submit time (by field type, not by guessing a
    // key name) purely so the Leads list can search/sort/display them directly
    // without unpacking JSON per row.
    fullName: {
      type: DataTypes.STRING(255),
    },
    email: {
      type: DataTypes.STRING(255),
    },
    phone: {
      type: DataTypes.STRING(50),
    },
    status: {
      type: DataTypes.ENUM('new', 'contacted', 'qualified', 'not_qualified', 'converted', 'lost'),
      allowNull: false,
      defaultValue: 'new',
    },
    assignedToUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Set by LeadService#convertToClient — the explicit, manual conversion step
    // (marking a lead Qualified does not by itself create a Client).
    convertedClientId: {
      type: DataTypes.CHAR(36),
      references: { model: 'clients', key: 'id' },
    },
    ip: {
      type: DataTypes.STRING(64),
    },
    referrer: {
      type: DataTypes.TEXT,
    },
    // Soft delete for spam/junk submissions — see models/softDeletable.js.
    // Distinct from `status`: a deactivated lead is hidden everywhere, a 'lost'
    // one is still a real (if dead) lead you report on.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'leads',
    indexes: [
      { fields: ['org_id'] },
      { fields: ['form_id'] },
      { fields: ['project_id'] },
      { fields: ['org_id', 'status'] },
    ],
  });

  Lead.associate = (db) => {
    Lead.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Lead.belongsTo(db.LeadForm, { foreignKey: 'formId', as: 'form' });
    Lead.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Lead.belongsTo(db.User, { foreignKey: 'assignedToUserId', as: 'assignee' });
    Lead.belongsTo(db.Client, { foreignKey: 'convertedClientId', as: 'convertedClient' });
    Lead.belongsTo(db.Client, { foreignKey: 'sourceClientId', as: 'sourceClient' });
    Lead.hasMany(db.LeadEvent, { foreignKey: 'leadId', as: 'events' });
  };

  Lead.ensureSchema = () => ensureColumns(Lead);

  return Lead;
};
