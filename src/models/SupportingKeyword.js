const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// One row per supporting/secondary keyword phrase under a main Keyword — lets
// the Monthly Report track a rank position and a "show to client" flag per
// phrase, instead of Keyword.secondaryKeywords staying an untracked free-text
// blob. Rows are seeded from — and kept in sync with — that text field by
// SeoService.syncSupportingKeywords, additive only: editing the text never
// deletes a row, so a phrase's rank history survives even if it's later
// removed from the text (same "nothing is hard-deleted" rule as the rest of
// this app).
module.exports = (sequelize, DataTypes) => {
  const SupportingKeyword = sequelize.define('SupportingKeyword', {
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
    keywordId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'keywords', key: 'id' },
    },
    text: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Whether this phrase's ranking belongs in the client-facing monthly
    // report — off by default; a strategist opts each one in once it's worth
    // showing.
    showToClient: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Preserves the order phrases appear in the source secondaryKeywords text.
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
  }, {
    tableName: 'supporting_keywords',
    updatedAt: false,
    indexes: [{ fields: ['project_id'] }, { fields: ['keyword_id'] }],
  });

  SupportingKeyword.ensureSchema = async () => {
    await ensureColumns(SupportingKeyword);
  };

  SupportingKeyword.associate = (db) => {
    SupportingKeyword.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    SupportingKeyword.belongsTo(db.Keyword, { foreignKey: 'keywordId', as: 'keyword' });
    SupportingKeyword.hasMany(db.SupportingKeywordRanking, { foreignKey: 'supportingKeywordId', as: 'rankings' });
  };

  return SupportingKeyword;
};
