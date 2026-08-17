const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const WorkflowTemplate = sequelize.define('WorkflowTemplate', {
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
    version: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    tableName: 'workflow_templates',
    indexes: [{ fields: ['org_id', 'service_type_key'] }],
    timestamps: false,
  });

  WorkflowTemplate.associate = (db) => {
    WorkflowTemplate.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    WorkflowTemplate.hasMany(db.Stage, { foreignKey: 'templateId', as: 'stages' });
    WorkflowTemplate.hasMany(db.Transition, { foreignKey: 'templateId', as: 'transitions' });
    WorkflowTemplate.hasMany(db.Project, { foreignKey: 'workflowTemplateId', as: 'projects' });
    WorkflowTemplate.hasMany(db.SlaPolicy, { foreignKey: 'templateId', as: 'slaPolicies' });
  };

  return WorkflowTemplate;
};
