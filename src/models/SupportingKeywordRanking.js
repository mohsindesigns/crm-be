const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// The supporting-keyword counterpart to RankSnapshot — one row per supporting
// keyword per report date. Kept as its own table (rather than reusing
// rank_snapshots with a nullable second FK) so the two stay unambiguous:
// RankSnapshot.keywordId is always a main keyword, this is always a
// SupportingKeyword.
module.exports = (sequelize, DataTypes) => {
  const SupportingKeywordRanking = sequelize.define('SupportingKeywordRanking', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    projectId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'projects', key: 'id' },
    },
    supportingKeywordId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'supporting_keywords', key: 'id' },
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    position: {
      type: DataTypes.INTEGER,
    },
    searchEngine: {
      type: DataTypes.STRING(50),
      defaultValue: 'google',
    },
  }, {
    tableName: 'supporting_keyword_rankings',
    timestamps: false,
    indexes: [{ fields: ['project_id', 'date'] }, { fields: ['supporting_keyword_id'] }],
  });

  SupportingKeywordRanking.ensureSchema = async () => {
    await ensureColumns(SupportingKeywordRanking);
  };

  SupportingKeywordRanking.associate = (db) => {
    SupportingKeywordRanking.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    SupportingKeywordRanking.belongsTo(db.SupportingKeyword, { foreignKey: 'supportingKeywordId', as: 'supportingKeyword' });
  };

  return SupportingKeywordRanking;
};
