const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const ProjectAssignment = sequelize.define('ProjectAssignment', {
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
    roleSlot: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    userId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'project_assignments',
    indexes: [
      { unique: true, fields: ['project_id', 'role_slot'] },
    ],
    timestamps: false,
  });

  ProjectAssignment.associate = (db) => {
    ProjectAssignment.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    ProjectAssignment.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
  };

  return ProjectAssignment;
};
