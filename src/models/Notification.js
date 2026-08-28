const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

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
    // Usually a single UUID, but task deep-links pack two — TaskService#taskNotifyRef
    // emits `${projectId}:${taskId}` (73 chars) so the header can route straight to
    // `/tasks/:projectId/:taskId`. This was CHAR(36), which meant MySQL rejected the
    // insert and every task notification (including "blog submitted for review" to
    // the strategist/PM) was silently dropped by NotificationService's own catch.
    refId: {
      type: DataTypes.STRING(100),
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

  Notification.ensureSchema = async () => {
    await ensureColumns(Notification);
    // Widen refId from CHAR(36) so composite task deep-link refs fit — see above.
    await ensureColumnType(Notification, 'refId');
  };

  Notification.associate = (db) => {
    Notification.belongsTo(db.User, { foreignKey: 'recipientId', as: 'recipient' });
  };

  return Notification;
};
