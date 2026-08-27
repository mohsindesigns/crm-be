const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const TaskEvent = sequelize.define('TaskEvent', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    taskId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'tasks', key: 'id' },
    },
    fromStatus: {
      type: DataTypes.STRING(50),
    },
    toStatus: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    reasonCategory: {
      type: DataTypes.STRING(100),
    },
    note: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'task_events',
    updatedAt: false,
    indexes: [{ fields: ['task_id', 'created_at'] }],
  });

  TaskEvent.associate = (db) => {
    TaskEvent.belongsTo(db.Task, { foreignKey: 'taskId', as: 'task' });
    TaskEvent.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actor' });
    TaskEvent.hasMany(db.Artifact, { foreignKey: 'taskEventId', as: 'attachments' });
  };

  return TaskEvent;
};
