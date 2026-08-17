const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const ProjectEvent = sequelize.define('ProjectEvent', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    fromStageKey: {
      type: DataTypes.STRING(100),
    },
    toStageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    action: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    reasonCategory: {
      type: DataTypes.STRING(100),
    },
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    note: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'project_events',
    updatedAt: false,
    indexes: [
      { fields: ['project_id', 'created_at'] },
    ],
  });

  ProjectEvent.associate = (db) => {
    ProjectEvent.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    ProjectEvent.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  return ProjectEvent;
};
