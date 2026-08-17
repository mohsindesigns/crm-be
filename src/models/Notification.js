const { v4: uuidv4 } = require('uuid');

module.exports = (sequelize, DataTypes) => {
  const Notification = sequelize.define('Notification', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    recipientId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    channel: {
      type: DataTypes.ENUM('in_app', 'email'),
      defaultValue: 'in_app',
    },
    type: {
      type: DataTypes.STRING(80),
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    body: {
      type: DataTypes.TEXT,
    },
    refTable: {
      type: DataTypes.STRING(50),
    },
    refId: {
      type: DataTypes.CHAR(36),
    },
    isRead: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    readAt: {
      type: DataTypes.DATE,
    },
  }, {
    tableName: 'notifications',
    updatedAt: false,
    indexes: [
      { fields: ['recipient_id', 'is_read'] },
    ],
  });

  Notification.associate = (db) => {
    Notification.belongsTo(db.User, { foreignKey: 'recipientId', as: 'recipient' });
  };

  return Notification;
};
