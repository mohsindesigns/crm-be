const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Project = sequelize.define('Project', {
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
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'clients', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    serviceTypeKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    workflowTemplateId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workflow_templates', key: 'id' },
    },
    packageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'packages', key: 'id' },
    },
    // Set when this project was auto-spawned as one service of a sold package.
    clientPackageId: {
      type: DataTypes.CHAR(36),
      references: { model: 'client_packages', key: 'id' },
    },
    currentStageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('active', 'on_hold', 'blocked', 'cancelled', 'completed'),
      defaultValue: 'active',
    },
    startDate: {
      type: DataTypes.DATEONLY,
    },
    deliveryDate: {
      type: DataTypes.DATEONLY,
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    description: {
      type: DataTypes.TEXT,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'projects',
    indexes: [
      { fields: ['org_id'] },
      { fields: ['client_id'] },
      { fields: ['org_id', 'status'] },
      { fields: ['workflow_template_id', 'current_stage_key'] },
    ],
  });

  Project.associate = (db) => {
    Project.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Project.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    Project.belongsTo(db.WorkflowTemplate, { foreignKey: 'workflowTemplateId', as: 'template' });
    Project.belongsTo(db.Package, { foreignKey: 'packageId', as: 'package' });
    Project.belongsTo(db.ClientPackage, { foreignKey: 'clientPackageId', as: 'clientPackage' });
    Project.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    Project.hasMany(db.ProjectAssignment, { foreignKey: 'projectId', as: 'assignments' });
    Project.hasMany(db.ProjectEvent, { foreignKey: 'projectId', as: 'events' });
    Project.hasMany(db.Artifact, { foreignKey: 'projectId', as: 'artifacts' });
    Project.hasMany(db.Comment, { foreignKey: 'projectId', as: 'comments' });
    Project.hasMany(db.Task, { foreignKey: 'projectId', as: 'tasks' });
    Project.hasMany(db.ProjectCycle, { foreignKey: 'projectId', as: 'cycles' });
    Project.hasMany(db.Keyword, { foreignKey: 'projectId', as: 'keywords' });
    Project.hasMany(db.Backlink, { foreignKey: 'projectId', as: 'backlinks' });
    Project.hasOne(db.GmbProfile, { foreignKey: 'projectId', as: 'gmbProfile' });
    Project.hasMany(db.BlogTask, { foreignKey: 'projectId', as: 'blogs' });
    Project.hasMany(db.RecurringTaskRule, { foreignKey: 'projectId', as: 'recurringTaskRules' });
  };

  Project.ensureSchema = () => ensureColumns(Project);

  return Project;
};
