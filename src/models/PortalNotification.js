const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const PortalNotification = sequelize.define('PortalNotification', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId:     { type: DataTypes.CHAR(36), allowNull: false },
    clientId:  { type: DataTypes.CHAR(36), allowNull: false },
    type:      { type: DataTypes.STRING(80), allowNull: false },
    title:     { type: DataTypes.STRING(255), allowNull: false },
    body:      { type: DataTypes.TEXT },
    refTable:  { type: DataTypes.STRING(50) },
    refId:     { type: DataTypes.CHAR(36) },
    isRead:    { type: DataTypes.BOOLEAN, defaultValue: false },
  }, {
    tableName: 'portal_notifications',
    underscored: true,   // maps orgId→org_id, clientId→client_id, isRead→is_read, etc.
    updatedAt: false,
  });

  return PortalNotification;
};
