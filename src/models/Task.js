const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Task = sequelize.define('Task', {
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
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    cycleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'project_cycles', key: 'id' },
    },
    stageKey: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    type: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Which page this task is about, for content-writing tasks — lets a PM/strategist
    // assign "write the About page" to a specific writer, and gives a page-by-page
    // authorship trail (who's currently on it, who wrote it before) when a writer
    // hands off or leaves. Mirrors ContentSubmission.pageName so the two line up.
    pageName: {
      type: DataTypes.STRING(255),
    },
    assigneeId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    reviewerId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    status: {
      type: DataTypes.ENUM('todo', 'in_progress', 'submitted', 'in_review', 'approved', 'rejected', 'done'),
      defaultValue: 'todo',
    },
    reasonCategory: {
      type: DataTypes.STRING(100),
    },
    refTable: {
      type: DataTypes.STRING(100),
    },
    refId: {
      type: DataTypes.CHAR(36),
    },
    dueAt: {
      type: DataTypes.DATEONLY,
    },
    // Free-text notes from the assigner (context for the assignee).
    remarks: {
      type: DataTypes.TEXT,
    },
    // Auto-set to dueAt − 1 day on create. Scheduler notifies the assignee that day.
    reminderAt: {
      type: DataTypes.DATEONLY,
    },
    // Set when the 24h-before-deadline reminder notification was sent (idempotent).
    reminderSentAt: {
      type: DataTypes.DATE,
    },
    autoCreated: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // Set when this task was materialized by AutoTaskScheduler from a RecurringTaskRule
    // (e.g. the monthly SEO review, the weekly GMB/blog post task) — lets
    // ProjectController#setAssignment reassign open recurring tasks when a role
    // slot's assignee changes, the same way it already does for stage auto-tasks.
    ruleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'recurring_task_rules', key: 'id' },
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    completedAt: {
      type: DataTypes.DATE,
    },
  }, {
    tableName: 'tasks',
    indexes: [
      { fields: ['project_id', 'stage_key'] },
      { fields: ['assignee_id', 'status'] },
      { fields: ['org_id'] },
    ],
  });

  Task.associate = (db) => {
    Task.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    Task.belongsTo(db.ProjectCycle, { foreignKey: 'cycleId', as: 'cycle' });
    Task.belongsTo(db.User, { foreignKey: 'assigneeId', as: 'assignee' });
    Task.belongsTo(db.User, { foreignKey: 'reviewerId', as: 'reviewer' });
    Task.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    Task.belongsTo(db.RecurringTaskRule, { foreignKey: 'ruleId', as: 'rule' });
    Task.hasMany(db.TaskEvent, { foreignKey: 'taskId', as: 'events' });
  };

  Task.ensureSchema = () => ensureColumns(Task);

  return Task;
};
