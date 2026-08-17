const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const Stage = sequelize.define('Stage', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    templateId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workflow_templates', key: 'id' },
    },
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    orderIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    ownerRoleSlot: {
      type: DataTypes.STRING(100),
    },
    stageType: {
      type: DataTypes.ENUM('work', 'approval'),
      defaultValue: 'work',
    },
    requiresArtifact: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    isTerminal: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    advanceRule: {
      type: DataTypes.ENUM('single_action', 'all_tasks_done', 'all_tasks_approved', 'any_task_done', 'manual'),
      defaultValue: 'single_action',
    },
    taskType: {
      type: DataTypes.STRING(100),
    },
    approvalGranularity: {
      type: DataTypes.ENUM('batch', 'per_item'),
    },
    description: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'stages',
    indexes: [
      { unique: true, fields: ['template_id', 'key'] },
      { fields: ['template_id', 'order_index'] },
    ],
    timestamps: false,
  });

  Stage.associate = (db) => {
    Stage.belongsTo(db.WorkflowTemplate, { foreignKey: 'templateId', as: 'template' });
  };

  return Stage;
};
