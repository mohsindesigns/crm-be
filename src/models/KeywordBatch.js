const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// One row per bulk keyword-sheet upload (see SeoService.bulkImportKeywords).
// Keywords created by that import all share a batchId pointing here and start
// life `approvalStatus: 'pending'` — the batch is what actually shows up in
// the org-wide Approvals inbox (ApprovalService's `keyword_batch` source);
// approving/rejecting it cascades that decision onto every keyword it created.
// Manually added keywords (SeoService.createKeyword) never get a batch and go
// live immediately, same as before this existed.
module.exports = (sequelize, DataTypes) => {
  const KeywordBatch = sequelize.define('KeywordBatch', {
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
    fileName: {
      type: DataTypes.STRING(255),
    },
    rowCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    submittedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    status: {
      type: DataTypes.ENUM('pending', 'approved', 'rejected'),
      allowNull: false,
      defaultValue: 'pending',
    },
    // Required when status is 'rejected' — tells the uploader what to fix.
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
  }, {
    tableName: 'keyword_batches',
    updatedAt: false,
  });

  KeywordBatch.ensureSchema = async () => {
    await ensureColumns(KeywordBatch);
  };

  KeywordBatch.associate = (db) => {
    KeywordBatch.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    KeywordBatch.belongsTo(db.User, { foreignKey: 'submittedBy', as: 'submitter' });
    KeywordBatch.belongsTo(db.User, { foreignKey: 'reviewedBy', as: 'reviewer' });
    KeywordBatch.hasMany(db.Keyword, { foreignKey: 'batchId', as: 'keywords' });
  };

  return KeywordBatch;
};
