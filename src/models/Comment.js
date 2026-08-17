const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Comment = sequelize.define('Comment', {
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
    stageKey: {
      type: DataTypes.STRING(100),
    },
    authorId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'comments',
    updatedAt: false,
  });

  Comment.associate = (db) => {
    Comment.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Comment.belongsTo(db.User, { foreignKey: 'authorId', as: 'author' });
  };

  Comment.ensureSchema = () => ensureColumns(Comment);

  return Comment;
};
