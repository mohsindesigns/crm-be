const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * One row per GMB (Google Business Profile) project — the listing details a
 * GMB specialist maintains outside of Google itself. Service areas live in
 * their own child table (GmbServiceArea) because each area can independently
 * be "targeted" with its own start date; everything else here is simple
 * enough to store directly (single values or flat string lists).
 *
 * `status` is a lightweight draft/completed marker for this form only — it
 * does NOT gate the project's real workflow stage (see workflow/engine.js);
 * this page is a standalone form, not a stage in that state machine.
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
    name: {
      type: DataTypes.STRING(150),
    },
    address: {
      type: DataTypes.STRING(300),
    },
    contactNumber: {
      type: DataTypes.STRING(50),
    },
    // "Profile link" in the UI — kept as gmbProfileUrl internally, no rename.
    gmbProfileUrl: {
      type: DataTypes.TEXT,
    },
    // "Website address" in the UI.
    websiteUrl: {
      type: DataTypes.TEXT,
    },
    primaryCategory: {
      type: DataTypes.STRING(150),
    },
    // Array of strings. Must exclude primaryCategory — enforced in GmbService.
    secondaryCategories: {
      type: DataTypes.JSON,
    },
    // Array of strings — the "Services" multi-select.
    services: {
      type: DataTypes.JSON,
    },
    status: {
      type: DataTypes.ENUM('draft', 'completed'),
      allowNull: false,
      defaultValue: 'draft',
    },
    updatedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'gmb_profiles',
    indexes: [{ fields: ['org_id'] }],
  });

  GmbProfile.associate = (db) => {
    GmbProfile.belongsTo(db.Project, { foreignKey: 'projectId', as: 'project' });
    GmbProfile.belongsTo(db.User, { foreignKey: 'updatedBy', as: 'updatedByUser' });
    GmbProfile.hasMany(db.GmbServiceArea, { foreignKey: 'gmbProfileId', as: 'serviceAreas' });
  };

  GmbProfile.ensureSchema = () => ensureColumns(GmbProfile);

  return GmbProfile;
};
