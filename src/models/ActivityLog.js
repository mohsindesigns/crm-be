const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const ActivityLog = sequelize.define('ActivityLog', {
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
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Snapshotted at write time so a log entry still reads sensibly if the
    // actor is later deactivated/renamed — mirrors how DocumentEvent/ProjectEvent
    // keep a `note`/`action` alongside the FK rather than relying on the join alone.
    actorName: {
      type: DataTypes.STRING(150),
    },
    method: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    path: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // First path segment after /api/ (e.g. "projects", "invoices") — lets the
    // UI filter/group without re-parsing `path` client-side.
    resource: {
      type: DataTypes.STRING(60),
    },
    action: {
      type: DataTypes.ENUM('create', 'update', 'delete', 'other'),
      allowNull: false,
      defaultValue: 'other',
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: false,
    },
    statusCode: {
      type: DataTypes.INTEGER,
    },
    ip: {
      type: DataTypes.STRING(64),
    },
  }, {
    tableName: 'activity_logs',
    updatedAt: false,
    indexes: [
      { fields: ['org_id', 'created_at'] },
      { fields: ['org_id', 'actor_user_id'] },
    ],
  });

  ActivityLog.associate = (db) => {
    ActivityLog.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  ActivityLog.ensureSchema = async () => {
    await ensureColumns(ActivityLog);
  };

  return ActivityLog;
};
