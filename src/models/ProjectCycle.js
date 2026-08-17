const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const ProjectCycle = sequelize.define('ProjectCycle', {
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
    period: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('active', 'completed', 'cancelled'),
      defaultValue: 'active',
    },
  }, {
    tableName: 'project_cycles',
    timestamps: false,
    indexes: [
      { unique: true, fields: ['project_id', 'period'] },
    ],
  });

  ProjectCycle.associate = (db) => {
    ProjectCycle.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    ProjectCycle.hasMany(db.Keyword, { foreignKey: 'cycleId', as: 'keywords' });
    ProjectCycle.hasMany(db.Backlink, { foreignKey: 'cycleId', as: 'backlinks' });
    ProjectCycle.hasMany(db.BlogTask, { foreignKey: 'cycleId', as: 'blogs' });
    ProjectCycle.hasMany(db.Task, { foreignKey: 'cycleId', as: 'tasks' });
  };

  return ProjectCycle;
};
