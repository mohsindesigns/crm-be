const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const ServiceType = sequelize.define('ServiceType', {
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
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    icon: {
      type: DataTypes.STRING(50),
    },
  }, {
    tableName: 'service_types',
    indexes: [
      { unique: true, fields: ['org_id', 'key'] },
    ],
    timestamps: false,
  });

  ServiceType.associate = (db) => {
    ServiceType.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    ServiceType.hasMany(db.Package, { foreignKey: 'serviceTypeKey', sourceKey: 'key', as: 'packages' });
  };

  return ServiceType;
};
