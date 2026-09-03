const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * One row per area on a GMB profile's service-area master list. `isTarget` +
 * `targetStartDate` fold "is this area currently being targeted, and since
 * when" onto the same row rather than a second table — removing an area
 * removes its targeting in the same stroke, which is exactly the paired
 * behavior the Profile form wants (see GmbService's removal guard).
 */
module.exports = (sequelize, DataTypes) => {
  const GmbServiceArea = sequelize.define('GmbServiceArea', {
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
    areaName: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    isTarget: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Required when isTarget is true — enforced in GmbService, not the DB.
    targetStartDate: {
      type: DataTypes.DATEONLY,
    },
  }, {
    tableName: 'gmb_service_areas',
    indexes: [{ fields: ['gmb_profile_id'] }],
  });

  GmbServiceArea.associate = (db) => {
    GmbServiceArea.belongsTo(db.GmbProfile, { foreignKey: 'gmbProfileId', as: 'profile' });
  };

  GmbServiceArea.ensureSchema = () => ensureColumns(GmbServiceArea);

  return GmbServiceArea;
};
