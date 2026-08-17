const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const Transition = sequelize.define('Transition', {
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
    fromStageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    action: {
      type: DataTypes.ENUM('complete', 'approve', 'reject'),
      allowNull: false,
    },
    reasonCategory: {
      type: DataTypes.STRING(100),
    },
    toStageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
  }, {
    tableName: 'transitions',
    indexes: [
      { fields: ['template_id', 'from_stage_key'] },
    ],
    timestamps: false,
  });

  Transition.associate = (db) => {
    Transition.belongsTo(db.WorkflowTemplate, { foreignKey: 'templateId', as: 'template' });
  };

  return Transition;
};
