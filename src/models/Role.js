const { v4: uuidv4 } = require('uuid');
const { isActiveAttribute } = require('./softDeletable');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Role = sequelize.define('Role', {
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
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    key: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    permissions: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
    isSystemRole: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    color: {
      type: DataTypes.STRING(20),
    },
    // Soft delete — see models/softDeletable.js. Users keep pointing at their role
    // row for history, so a retired role is deactivated rather than destroyed.
    isActive: isActiveAttribute(DataTypes),
  }, {
    tableName: 'roles',
    indexes: [
      { unique: true, fields: ['org_id', 'key'] },
    ],
  });

  Role.associate = (db) => {
    Role.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Role.hasMany(db.User, { foreignKey: 'roleId', as: 'users' });
  };

  Role.ensureSchema = () => ensureColumns(Role);

  return Role;
};
