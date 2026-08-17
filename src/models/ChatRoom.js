const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const ChatRoom = sequelize.define('ChatRoom', {
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
    // client | group | dm — client rooms stay 1:1 with a Client; group/dm have no client.
    roomType: {
      type: DataTypes.ENUM('client', 'group', 'dm'),
      allowNull: false,
      defaultValue: 'client',
    },
    // Required for client rooms; null for group/dm.
    clientId: {
      type: DataTypes.CHAR(36),
      allowNull: true,
      references: { model: 'clients', key: 'id' },
    },
    // Stable key for DMs: sorted "userIdA:userIdB" — unique per org when set.
    dmKey: {
      type: DataTypes.STRING(80),
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // Channel purpose, shown under the room name in the header.
    description: {
      type: DataTypes.STRING(500),
    },
    createdBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    // Rooms are never deleted, only deactivated. An inactive room keeps its full
    // history, stays searchable and exportable, and simply refuses new messages —
    // deleting a channel would destroy the record of what was agreed with a
    // client, which is the one thing an agency cannot afford to lose.
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    deactivatedAt: {
      type: DataTypes.DATE,
    },
    deactivatedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // ─── Governance ────────────────────────────────────────────────────────────
    // 'internal'      — staff only; a client contact can never be added.
    // 'client_shared' — client contacts may be members, so the UI shows a
    //                   persistent warning banner. The distinction exists so
    //                   nobody pastes internal margins into a room the client
    //                   can read; it is enforced server-side in addMember, not
    //                   just displayed.
    visibility: {
      type: DataTypes.ENUM('internal', 'client_shared'),
      allowNull: false,
      defaultValue: 'internal',
    },
    // Announcement rooms are read-only for everyone but room admins.
    isAnnouncement: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Messages older than this are purged by the retention sweep. Null = keep
    // forever, which stays the default: retention must be opted into.
    retentionDays: {
      type: DataTypes.INTEGER,
    },
  }, {
    tableName: 'chat_rooms',
    indexes: [
      { unique: true, fields: ['orgId', 'clientId'], name: 'chat_rooms_org_client_unique' },
      { unique: true, fields: ['orgId', 'dmKey'], name: 'chat_rooms_org_dm_unique' },
      { fields: ['orgId'] },
      { fields: ['orgId', 'roomType'] },
    ],
  });

  ChatRoom.associate = (db) => {
    ChatRoom.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    ChatRoom.belongsTo(db.Client, { foreignKey: 'clientId', as: 'client' });
    ChatRoom.belongsTo(db.User, { foreignKey: 'createdBy', as: 'creator' });
    ChatRoom.belongsTo(db.User, { foreignKey: 'deactivatedBy', as: 'deactivator' });
    ChatRoom.hasMany(db.ChatMember, { foreignKey: 'roomId', as: 'members' });
    ChatRoom.hasMany(db.ChatMessage, { foreignKey: 'roomId', as: 'messages' });
    ChatRoom.hasMany(db.ChatRoomEvent, { foreignKey: 'roomId', as: 'events' });
  };

  ChatRoom.ensureSchema = async () => {
    await ensureColumns(ChatRoom);
    // Existing installs created clientId as NOT NULL — open it for group/dm rooms.
    try {
      await ensureColumnType(ChatRoom, 'clientId');
    } catch {
      // Column may already match.
    }
    try {
      await ensureColumnType(ChatRoom, 'roomType');
    } catch {
      // ENUM may already exist.
    }
    // Existing installs get isActive added as NULL on old rows; ensureColumns
    // backfills boolean-true defaults, but be explicit so no room silently
    // disappears from the default "Active" filter after deploy.
    try {
      await ChatRoom.sequelize.query(
        'UPDATE chat_rooms SET isActive = true WHERE isActive IS NULL',
      );
    } catch {
      // Column freshly created with the default already applied.
    }
    // Client rooms are shared with the client by definition — existing ones
    // predate the column and would otherwise default to internal-only, which
    // would block adding the client contacts already in them.
    try {
      await ChatRoom.sequelize.query(
        "UPDATE chat_rooms SET visibility = 'client_shared' WHERE roomType = 'client'",
      );
    } catch {
      // Column not present yet on this pass.
    }

    const qi = ChatRoom.sequelize.getQueryInterface();
    for (const [fields, name, unique] of [
      [['orgId', 'clientId'], 'chat_rooms_org_client_unique', true],
      [['orgId', 'dmKey'], 'chat_rooms_org_dm_unique', true],
      [['orgId', 'roomType'], 'chat_rooms_org_type_idx', false],
      [['orgId', 'isActive'], 'chat_rooms_org_active_idx', false],
    ]) {
      try {
        await qi.addIndex('chat_rooms', fields, { unique, name });
      } catch {
        // Already present, or duplicates still blocking — ChatService.dedupeClientRooms runs at list time.
      }
    }
  };

  return ChatRoom;
};
