const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * One row per GMB (Google Business Profile) project — the listing details a
 * GMB specialist tracks outside of Google itself: the profile/website URLs,
 * the category and keyword sets currently targeted, and which service areas
 * out of the full coverage list are actively being worked right now.
 *
 * Phone numbers and addresses live in their own child tables (GmbPhoneNumber /
 * GmbAddress) rather than as JSON here, because a listing can carry several of
 * each with exactly one marked "currently active" — the same isPrimary shape
 * as `Company`.
 */
module.exports = (sequelize, DataTypes) => {
  const GmbProfile = sequelize.define('GmbProfile', {
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
      unique: true,
      references: { model: 'projects', key: 'id' },
    },
    gmbProfileUrl: {
      type: DataTypes.TEXT,
    },
    websiteUrl: {
      type: DataTypes.TEXT,
    },
    // Arrays of strings, all stored as JSON — none of these are single values.
    primaryCategories: {
      type: DataTypes.JSON,
    },
    secondaryCategories: {
      type: DataTypes.JSON,
    },
    // The full list of areas this listing covers.
    serviceAreasTotal: {
      type: DataTypes.JSON,
    },
    // Which of serviceAreasTotal are being actively worked right now — always
    // a subset, enforced in GmbService rather than at the DB layer.
    serviceAreasActive: {
      type: DataTypes.JSON,
    },
    keywordsPrimary: {
      type: DataTypes.JSON,
    },
    keywordsSecondary: {
      type: DataTypes.JSON,
    },
    keywordsRanking: {
      type: DataTypes.JSON,
    },
  }, {
    tableName: 'gmb_profiles',
    indexes: [{ fields: ['org_id'] }],
  });

  GmbProfile.associate = (db) => {
    GmbProfile.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    GmbProfile.hasMany(db.GmbPhoneNumber, { foreignKey: 'gmbProfileId', as: 'phones' });
    GmbProfile.hasMany(db.GmbAddress, { foreignKey: 'gmbProfileId', as: 'addresses' });
    GmbProfile.hasMany(db.GmbKeywordRank, { foreignKey: 'gmbProfileId', as: 'keywordRanks' });
  };

  GmbProfile.ensureSchema = () => ensureColumns(GmbProfile);

  return GmbProfile;
};
