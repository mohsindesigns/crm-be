const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const GmbPhoneNumber = sequelize.define('GmbPhoneNumber', {
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
    phoneNumber: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // Exactly one phone per profile is active at a time — mirrors Company.isPrimary.
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
    tableName: 'gmb_phone_numbers',
    indexes: [{ fields: ['gmb_profile_id'] }],
  });

  GmbPhoneNumber.associate = (db) => {
    GmbPhoneNumber.belongsTo(db.GmbProfile, { foreignKey: 'gmbProfileId', as: 'profile' });
  };

  GmbPhoneNumber.ensureSchema = () => ensureColumns(GmbPhoneNumber);

  return GmbPhoneNumber;
};
