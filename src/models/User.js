const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
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
    roleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'roles', key: 'id' },
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    mustChangePassword: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    lastLoginAt: {
      type: DataTypes.DATE,
    },
    /**
     * When this user was last connected to chat — the "last seen 10:42 PM" line.
     *
     * Live online/offline is held in memory by ChatSocket (worthless after a
     * restart, and far too chatty to persist per socket event). This is the
     * opposite: one timestamp, written when they disconnect and refreshed on a
     * slow heartbeat, so the answer survives a restart and can be shown to
     * someone who wasn't connected at the time.
     *
     * Null means never seen — render nothing rather than "last seen never".
     */
    lastSeenAt: {
      type: DataTypes.DATE,
    },
    avatarUrl: {
      type: DataTypes.TEXT,
    },
    phone: {
      type: DataTypes.STRING(50),
    },
    // Pending email-change verification (OTP sent to the new address)
    pendingEmail: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    emailChangeCodeHash: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    emailChangeCodeExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    emailChangeCodeAttempts: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
  }, {
    tableName: 'users',
    indexes: [
      { unique: true, fields: ['org_id', 'email'] },
      { fields: ['org_id'] },
    ],
    hooks: {
      beforeCreate: async (user) => {
        if (user.passwordHash && !user.passwordHash.startsWith('$2')) {
          user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
        }
      },
      beforeUpdate: async (user) => {
        if (user.changed('passwordHash') && !user.passwordHash.startsWith('$2')) {
          user.passwordHash = await bcrypt.hash(user.passwordHash, 12);
        }
      },
    },
  });

  User.prototype.verifyPassword = async function (plain) {
    return bcrypt.compare(plain, this.passwordHash);
  };

  User.prototype.toSafeJSON = function () {
    const values = this.toJSON();
    delete values.passwordHash;
    delete values.emailChangeCodeHash;
    delete values.emailChangeCodeExpiresAt;
    delete values.emailChangeCodeAttempts;
    delete values.pendingEmail;
    return values;
  };

  User.associate = (db) => {
    User.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    User.belongsTo(db.Role, { foreignKey: 'roleId', as: 'role' });
    User.hasOne(db.Worker, { foreignKey: 'userId', as: 'worker' });
    User.hasMany(db.ProjectAssignment, { foreignKey: 'userId', as: 'assignments' });
    User.hasMany(db.Notification, { foreignKey: 'recipientId', as: 'notifications' });
  };

  User.ensureSchema = () => ensureColumns(User);

  return User;
};
