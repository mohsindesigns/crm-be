const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * One ranking check for one of a GmbProfile's `keywordsRanking` entries — the
 * append-only history the "Keyword Ranking" tab renders as a timeline.
 * "Current rank" for a keyword is never stored redundantly — it's just this
 * table's most recent row for that keyword, same as RankSnapshot/Keyword for
 * the SEO module.
 */
module.exports = (sequelize, DataTypes) => {
  const GmbKeywordRank = sequelize.define('GmbKeywordRank', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    gmbProfileId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'gmb_profiles', key: 'id' },
    },
    keyword: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Google Business Profile / local-pack position. Null means "checked, not
    // ranking in the tracked range" — distinct from no check having happened.
    rank: {
      type: DataTypes.INTEGER,
    },
    checkedOn: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  }, {
    tableName: 'gmb_keyword_ranks',
    // "One row per keyword per day" is enforced in GmbService's upsert logic
    // (find-then-update-or-create), not a DB constraint — ensureColumns()
    // never materializes `indexes:` blocks, only columns (see schemaSync.js).
    indexes: [{ fields: ['gmb_profile_id'] }],
  });

  GmbKeywordRank.associate = (db) => {
    GmbKeywordRank.belongsTo(db.GmbProfile, { foreignKey: 'gmbProfileId', as: 'profile' });
  };

  GmbKeywordRank.ensureSchema = () => ensureColumns(GmbKeywordRank);

  return GmbKeywordRank;
};
