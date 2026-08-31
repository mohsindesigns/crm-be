const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

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
    // Whether this stage shows as a pill in the project timeline. A hidden
    // work stage also auto-advances once its advance rule is satisfied
    // (see workflow/autoAdvance.js) instead of waiting on a manual click —
    // its work still happens through the stage's own tab (Keywords, Content,
    // etc). Hidden approval stages still require a manual Approve/Reject;
    // only their pill is suppressed, since the engine never auto-decides a
    // real approve/reject choice.
    showInTimeline: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
  }, {
    tableName: 'stages',
    indexes: [
      { unique: true, fields: ['template_id', 'key'] },
      { fields: ['template_id', 'order_index'] },
    ],
    timestamps: false,
  });

  Stage.ensureSchema = async () => ensureColumns(Stage);

  Stage.associate = (db) => {
    Stage.belongsTo(db.WorkflowTemplate, { foreignKey: 'templateId', as: 'template' });
  };

  return Stage;
};
