module.exports = (sequelize, DataTypes) => {
  const NotificationPref = sequelize.define('NotificationPref', {
    userId: {
      type: DataTypes.CHAR(36),
      primaryKey: true,
      references: { model: 'users', key: 'id' },
    },
    emailEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    inAppEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    muteUntil: {
      type: DataTypes.DATE,
    },
    preferences: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
  }, {
    tableName: 'notification_prefs',
    timestamps: false,
  });

  NotificationPref.associate = (db) => {
    NotificationPref.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
  };

  return NotificationPref;
};
