const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const BlogTask = sequelize.define('BlogTask', {
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
    cycleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'project_cycles', key: 'id' },
    },
    // The writer-facing half of this row (Task type `blog_post`). The two used to
    // be paired only by projectId + Task.pageName === title, which breaks the
    // moment either side is renamed and doesn't exist at all for blog tasks that
    // came from the recurring-task scheduler or the generic Create Task modal.
    // services/BlogSheetSync.js sets this on both directions and backfills
    // pageName so the title-matching routines keep working too.
    taskId: {
      type: DataTypes.CHAR(36),
      references: { model: 'tasks', key: 'id' },
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Pillar/cluster content-plan sheet columns (CSV import) — all optional except
    // title, mirroring the Keywords sheet: missing/invalid cells are just left null,
    // never rejected (see SeoService#bulkImportBlogTasks).
    contentType: {
      type: DataTypes.STRING(50), // e.g. "PILLAR" / "Cluster" — free text, not an ENUM
    },
    mainKeyword: {
      type: DataTypes.STRING(255),
    },
    volume: {
      type: DataTypes.INTEGER,
    },
    kd: {
      type: DataTypes.INTEGER,
    },
    supportingKeywords: {
      type: DataTypes.TEXT,
    },
    urlSlug: {
      type: DataTypes.STRING(255),
    },
    targetServicePage: {
      type: DataTypes.STRING(255),
    },
    // Optional evidence (published link, screenshot URL, etc.) the writer can attach.
    proof: {
      type: DataTypes.TEXT,
    },
    targetKeywords: {
      type: DataTypes.TEXT,
    },
    fileUrl: {
      type: DataTypes.TEXT,
    },
    // Original upload filename (or "Link" for a pasted URL) — lets the sheet
    // show what was attached without opening it. Mirrors ContentSubmission.fileName.
    fileName: {
      type: DataTypes.STRING(255),
    },
    publishedUrl: {
      type: DataTypes.TEXT,
    },
    // Content-parity workflow:
    //   draft    — planned on the sheet / assigned to a writer (like a Keyword row)
    //   pending  — writer submitted a deliverable; awaiting strategist/PM review
    //   approved / rejected — review outcome (reject reopens a revise Task)
    status: {
      type: DataTypes.ENUM('draft', 'pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'draft',
    },
    submittedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Who should write this blog (like Keyword.assignedWriterId for content).
    // Import/manual add can assign a blog_writer; submit creates/syncs their Task.
    assignedWriterId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Who designs the blog's featured/inline image — only settable once the blog
    // itself is approved (see SeoService.updateBlogTask), since there's nothing
    // to illustrate before then. Assigning creates a `blog_image` Task, same
    // ensure-Task pattern as assignedWriterId/ensureBlogTask.
    assignedDesignerId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    reviewedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    reviewedAt: {
      type: DataTypes.DATE,
    },
    rejectionReason: {
      type: DataTypes.TEXT,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Soft delete — see models/softDeletable.js. Deactivated rows drop out of
    // default listings but are never destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'blog_tasks',
    updatedAt: false,
  });

  BlogTask.ensureSchema = async () => {
    await ensureColumns(BlogTask);
    // Widen status ENUM with `draft` (plan rows before deliverable submit).
    await ensureColumnType(BlogTask, 'status');
  };

  BlogTask.associate = (db) => {
    BlogTask.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    BlogTask.belongsTo(db.ProjectCycle, { foreignKey: 'cycleId', as: 'cycle' });
    BlogTask.belongsTo(db.Task, { foreignKey: 'taskId', as: 'task' });
    BlogTask.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    BlogTask.belongsTo(db.User, { foreignKey: 'submittedBy', as: 'submitter' });
    BlogTask.belongsTo(db.User, { foreignKey: 'assignedWriterId', as: 'assignedWriter' });
    BlogTask.belongsTo(db.User, { foreignKey: 'assignedDesignerId', as: 'assignedDesigner' });
    BlogTask.belongsTo(db.User, { foreignKey: 'reviewedBy', as: 'reviewer' });
  };

  return BlogTask;
};
