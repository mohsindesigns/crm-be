const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const DocumentTemplate = sequelize.define('DocumentTemplate', {
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
    // 'service_fragment' = per-service block rendered into a wrapper template's
    // {{services_block}} token — never used as a standalone document template.
    type: {
      type: DataTypes.ENUM('quotation', 'agreement', 'proposal', 'service_fragment'),
      allowNull: false,
    },
    // A real service key, or 'standard' — a standard template isn't tied to any
    // service and is picked as the fallback for any service (and is the natural
    // home for multi-service wrapper templates using {{services_block}}).
    serviceTypeKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Holds {{merge}} tokens — see utils/documentRenderer.js for the supported list.
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    defaultTerms: {
      type: DataTypes.TEXT,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  }, {
    tableName: 'document_templates',
  });

  DocumentTemplate.associate = (db) => {
    DocumentTemplate.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    DocumentTemplate.hasMany(db.CustomerDocument, { foreignKey: 'templateId', as: 'documents' });
  };

  DocumentTemplate.ensureSchema = async () => {
    await ensureColumns(DocumentTemplate);
    // Widens the type ENUM to include 'service_fragment' on existing databases.
    await ensureColumnType(DocumentTemplate, 'type');
  };

  return DocumentTemplate;
};
