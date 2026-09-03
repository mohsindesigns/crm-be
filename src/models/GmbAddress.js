const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const GmbAddress = sequelize.define('GmbAddress', {
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
    address: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    // Exactly one address per profile is active at a time — mirrors Company.isPrimary.
    isPrimary: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    sortOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
  }, {
    tableName: 'gmb_addresses',
    indexes: [{ fields: ['gmb_profile_id'] }],
  });

  GmbAddress.associate = (db) => {
    GmbAddress.belongsTo(db.GmbProfile, { foreignKey: 'gmbProfileId', as: 'profile' });
  };

  GmbAddress.ensureSchema = () => ensureColumns(GmbAddress);

  return GmbAddress;
};
