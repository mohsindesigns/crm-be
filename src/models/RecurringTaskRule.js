const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

// Configures a recurring auto-task generator for a project — e.g. "create a task
// for the SEO Manager on the 1st of every month" or "create a blog post task
// every Monday / every other Monday". Due dates are the start of the next cycle
// (see AutoTaskScheduler).
module.exports = (sequelize, DataTypes) => {
  const RecurringTaskRule = sequelize.define('RecurringTaskRule', {
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
    stageKey: {
      type: DataTypes.STRING(100),
    },
    // Free-form key identifying the kind of recurring work, e.g.
    // 'seo_monthly_review', 'seo_ranking_update', 'gmb_recurring', 'blog_post'.
    taskType: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Resolved to a real user via ProjectAssignment{projectId, roleSlot} at
    // generation time — same resolution the stage auto-task engine already uses,
    // so re-assigning a role slot (ProjectController#setAssignment) also picks up
    // rule-generated tasks (see Task.ruleId reassignment in that handler).
    roleSlot: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    frequency: {
      type: DataTypes.ENUM('monthly', 'weekly', 'biweekly'),
      allowNull: false,
    },
    // Monthly: day-of-month a task is generated on (usually 1).
    generateDayOfMonth: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    // Legacy monthly field — scheduler now dues to next cycle start. Kept for
    // older rows / API compatibility; not used for new due-date math.
    dueDayOfMonth: {
      type: DataTypes.INTEGER,
    },
    // Weekly / biweekly: 0=Sunday..6=Saturday.
    weekday: {
      type: DataTypes.INTEGER,
    },
    // Legacy weekly field — due dates are next-cycle, not hour offsets.
    dueOffsetHours: {
      type: DataTypes.INTEGER,
      defaultValue: null,
      allowNull: true,
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    // Dedupe key for the last period a task was generated for — "2026-07" for
    // monthly rules, an ISO date for weekly/biweekly ones — so the scheduler never
    // double-creates a task for the same period even if it ticks more than once.
    lastGeneratedPeriod: {
      type: DataTypes.STRING(20),
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'recurring_task_rules',
    indexes: [
      { fields: ['project_id'] },
      { fields: ['is_active'] },
    ],
  });

  RecurringTaskRule.associate = (db) => {
    RecurringTaskRule.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    RecurringTaskRule.hasMany(db.Task, { foreignKey: 'ruleId', as: 'tasks' });
  };

  RecurringTaskRule.ensureSchema = async () => {
    await ensureColumns(RecurringTaskRule);
    await ensureColumnType(RecurringTaskRule, 'frequency');
  };

  return RecurringTaskRule;
};
