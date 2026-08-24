const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

// A saved column selection for the Admin → Export Data screen ("Bank details
// for the payroll bank", "New joiner handover sheet", …). The template stores
// only WHICH columns to export — never which employees — so the same template
// is reused every month against a different selection of people.
//
// `fields` is a plain array of field keys drawn from the dataset's catalog in
// services/ExportService.js. Unknown keys are dropped at export time rather
// than erroring, so a template written before a field was renamed still works;
// the export screen shows the surviving selection when the template is applied.
module.exports = (sequelize, DataTypes) => {
  const ExportTemplate = sequelize.define('ExportTemplate', {
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
    // Which export dataset this column set belongs to — 'employees' is the only
    // one today. A STRING rather than an ENUM on purpose: adding a dataset is a
    // catalog entry in ExportService, not a schema migration (see the ENUM
    // caveat in utils/schemaSync.js — widening one needs ensureColumnType).
    dataset: {
      type: DataTypes.STRING(50),
      allowNull: false,
      defaultValue: 'employees',
    },
    // Ordered array of field keys, e.g. ['bankName','bankAccountNumber','iban'].
    fields: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Soft delete — see models/softDeletable.js. Deleting a template just takes
    // it out of the picker; nothing in this app is ever hard-deleted.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'export_templates',
    indexes: [
      { fields: ['org_id'] },
    ],
  });

  ExportTemplate.associate = (db) => {
    ExportTemplate.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    ExportTemplate.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
  };

  ExportTemplate.ensureSchema = () => ensureColumns(ExportTemplate);

  return ExportTemplate;
};
