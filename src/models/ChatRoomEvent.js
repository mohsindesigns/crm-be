const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * Audit trail for administrative actions on a room.
 *
 * Rooms are never deleted — they are deactivated — and the point of that rule is
 * that the record survives. A record that can be silently switched off without
 * anyone knowing who did it, or when, only half solves the problem, so every
 * deactivate / reactivate / member change / setting change lands here and is
 * shown in the room's activity panel.
 *
 * Deliberately separate from ChatMessage: these are not things anyone said, they
 * should not appear in search, be repliable, or carry reactions.
 */
module.exports = (sequelize, DataTypes) => {
  const ChatRoomEvent = sequelize.define('ChatRoomEvent', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    roomId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'chat_rooms', key: 'id' },
    },
    // created | deactivated | reactivated | renamed | member_added |
    // member_removed | visibility_changed | announcement_changed |
    // retention_changed | exported | purged
    eventType: {
      type: DataTypes.STRING(40),
      allowNull: false,
    },
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    // Human-readable summary, rendered as-is in the activity panel.
    summary: {
      type: DataTypes.STRING(500),
    },
    // Structured before/after for anything the summary flattens.
    meta: {
      type: DataTypes.JSON,
    },
  }, {
    tableName: 'chat_room_events',
    updatedAt: false,
    indexes: [
      { fields: ['roomId', 'createdAt'] },
    ],
  });

  ChatRoomEvent.associate = (db) => {
    ChatRoomEvent.belongsTo(db.ChatRoom, { foreignKey: 'roomId', as: 'room' });
    ChatRoomEvent.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  ChatRoomEvent.ensureSchema = () => ensureColumns(ChatRoomEvent);

  /** Never let an audit write break the action it is auditing. */
  ChatRoomEvent.record = async (roomId, eventType, { actorUserId = null, summary = null, meta = null } = {}) => {
    try {
      return await ChatRoomEvent.create({
        id: uuidv4(), roomId, eventType, actorUserId, summary, meta,
      });
    } catch (err) {
      console.error('[ChatRoomEvent] audit write failed:', err.message);
      return null;
    }
  };

  return ChatRoomEvent;
};
