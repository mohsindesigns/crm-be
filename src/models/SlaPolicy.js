const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const SlaPolicy = sequelize.define('SlaPolicy', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    templateId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workflow_templates', key: 'id' },
    },
    stageKey: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    targetHours: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    warnAt: {
      type: DataTypes.INTEGER,
      comment: 'hours before targetHours to send warning',
    },
    escalateToRoleSlot: {
      type: DataTypes.STRING(80),
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'sla_policies',
    indexes: [
      { unique: true, fields: ['template_id', 'stage_key'] },
    ],
  });

  SlaPolicy.associate = (db) => {
    SlaPolicy.belongsTo(db.WorkflowTemplate, { foreignKey: 'templateId', as: 'template' });
  };

  SlaPolicy.ensureSchema = () => ensureColumns(SlaPolicy);

  return SlaPolicy;
};
