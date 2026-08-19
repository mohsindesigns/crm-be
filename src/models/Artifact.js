const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Artifact = sequelize.define('Artifact', {
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
    // Set when this deliverable was uploaded against a Task (from the Task Detail
    // modal) rather than a project stage directly — nullable, projectId stays
    // required so existing project-stage artifacts are unaffected.
    taskId: {
      type: DataTypes.CHAR(36),
      references: { model: 'tasks', key: 'id' },
    },
    // Set when this file/voice message was attached to a specific task-status
    // transition (e.g. the "Send back for changes" note) rather than uploaded as
    // a general deliverable — lets the Activity timeline show it under that exact
    // event instead of mixing it into the Deliverable list.
    taskEventId: {
      type: DataTypes.CHAR(36),
      references: { model: 'task_events', key: 'id' },
    },
    stageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    fileUrl: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    fileName: {
      type: DataTypes.STRING(255),
    },
    fileSize: {
      type: DataTypes.INTEGER,
    },
    mimeType: {
      type: DataTypes.STRING(100),
    },
    kind: {
      type: DataTypes.STRING(50),
    },
    uploadedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'artifacts',
    updatedAt: false,
  });

  Artifact.associate = (db) => {
    Artifact.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Artifact.belongsTo(db.User, { foreignKey: 'uploadedBy', as: 'uploader' });
    Artifact.belongsTo(db.Task, { foreignKey: 'taskId', as: 'task' });
    Artifact.belongsTo(db.TaskEvent, { foreignKey: 'taskEventId', as: 'taskEvent' });
  };

  Artifact.ensureSchema = () => ensureColumns(Artifact);

  return Artifact;
};
