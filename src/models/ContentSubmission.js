const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const ContentSubmission = sequelize.define('ContentSubmission', {
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
    pageName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    keywordIds: {
      type: DataTypes.JSON,
    },
    fileUrl: {
      type: DataTypes.TEXT,
    },
    fileName: {
      type: DataTypes.STRING(255),
    },
    // Revision chain metadata: every resubmission for the same page/writer links
    // to the chain root, and increments revisionNumber.
    revisionOfId: {
      type: DataTypes.CHAR(36),
    },
    revisionNumber: {
      type: DataTypes.INTEGER,
      defaultValue: 1,
    },
    submittedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Optional word count of the submitted content — feeds the Keywords tab's
    // "words generated" stat. Nullable/no backfill for pre-existing rows.
    wordCount: {
      type: DataTypes.INTEGER,
    },
    // Review status — only live 'approved' submissions take keywords out of the
    // pool. 'superseded' keeps prior approved files in history after a reopen
    // without locking the keyword picker.
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected', 'superseded'),
      defaultValue: 'pending',
    },
    // Required when status is 'rejected' — tells the writer what to fix.
    rejectionReason: {
      type: DataTypes.TEXT,
    },
    reviewedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    reviewedAt: {
      type: DataTypes.DATE,
    },
    // Post-approval "implemented on the live page" tracking, independent of the
    // approve/reject/superseded lifecycle above — a second, separate mini
    // review loop that only ever applies to already-`approved` rows.
    implementationStatus: {
      type: DataTypes.ENUM('not_started', 'submitted', 'approved', 'rejected'),
      defaultValue: 'not_started',
    },
    implementedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    implementedAt: {
      type: DataTypes.DATE,
    },
    implementationRejectionReason: {
      type: DataTypes.TEXT,
    },
    implementationReviewedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    implementationReviewedAt: {
      type: DataTypes.DATE,
    },
  }, {
    tableName: 'content_submissions',
    updatedAt: false,
  });

  ContentSubmission.associate = (db) => {
    ContentSubmission.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    ContentSubmission.belongsTo(db.User, { foreignKey: 'submittedBy', as: 'submitter' });
    ContentSubmission.belongsTo(db.User, { foreignKey: 'reviewedBy', as: 'reviewer' });
    ContentSubmission.belongsTo(db.User, { foreignKey: 'implementedBy', as: 'implementer' });
    ContentSubmission.belongsTo(db.User, { foreignKey: 'implementationReviewedBy', as: 'implementationReviewer' });
  };

  ContentSubmission.ensureSchema = async () => {
    await ensureColumns(ContentSubmission);
    await ensureColumnType(ContentSubmission, 'status');
    await ensureColumnType(ContentSubmission, 'implementationStatus');
  };

  return ContentSubmission;
};
