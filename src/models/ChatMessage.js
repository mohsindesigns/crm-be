const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const ChatMessage = sequelize.define('ChatMessage', {
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
    senderType: {
      type: DataTypes.ENUM('user', 'contact'),
      allowNull: false,
    },
    senderUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    senderContactId: {
      type: DataTypes.CHAR(36),
      references: { model: 'contacts', key: 'id' },
    },
    // Plain text; mentions stored as @[Display Name](user:uuid) or @[Name](contact:uuid).
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '',
    },
    // [{ url, name, mime, size, kind: 'file'|'image'|'audio' }]
    attachments: {
      type: DataTypes.JSON,
      allowNull: true,
    },
    // ─── Threads ───────────────────────────────────────────────────────────────
    // Set on a reply; null on a top-level message. The main transcript shows only
    // top-level messages plus a "N replies" affordance, which is what stops a
    // busy client room from becoming an unreadable interleave of three
    // conversations.
    parentMessageId: {
      type: DataTypes.CHAR(36),
    },
    // Denormalised counter on the PARENT, so rendering the transcript doesn't
    // need a COUNT per message.
    replyCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    lastReplyAt: {
      type: DataTypes.DATE,
    },
    // ─── Edit / delete ─────────────────────────────────────────────────────────
    // Soft delete only. `body` is blanked for display and the row is tombstoned,
    // but `originalBody` retains what was actually said — an enterprise chat that
    // lets someone erase what they wrote with no trace is a compliance problem,
    // not a feature.
    editedAt: {
      type: DataTypes.DATE,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    deletedBy: {
      type: DataTypes.CHAR(36),
    },
    originalBody: {
      type: DataTypes.TEXT,
    },
    // ─── Pins ──────────────────────────────────────────────────────────────────
    isPinned: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    pinnedAt: {
      type: DataTypes.DATE,
    },
    pinnedBy: {
      type: DataTypes.CHAR(36),
    },
  }, {
    tableName: 'chat_messages',
    updatedAt: false,
    indexes: [
      { fields: ['roomId', 'createdAt'] },
      { fields: ['parentMessageId'] },
      { fields: ['roomId', 'isPinned'] },
    ],
  });

  ChatMessage.associate = (db) => {
    ChatMessage.belongsTo(db.ChatRoom, { foreignKey: 'roomId', as: 'room' });
    ChatMessage.belongsTo(db.User, { foreignKey: 'senderUserId', as: 'senderUser' });
    ChatMessage.belongsTo(db.Contact, { foreignKey: 'senderContactId', as: 'senderContact' });
    ChatMessage.belongsTo(ChatMessage, { foreignKey: 'parentMessageId', as: 'parent' });
    ChatMessage.hasMany(ChatMessage, { foreignKey: 'parentMessageId', as: 'replies' });
    ChatMessage.hasMany(db.ChatReaction, { foreignKey: 'messageId', as: 'reactions' });
  };

  ChatMessage.ensureSchema = async () => {
    await ensureColumns(ChatMessage);
    const qi = ChatMessage.sequelize.getQueryInterface();
    for (const [fields, name] of [
      [['parentMessageId'], 'chat_messages_parent_idx'],
      [['roomId', 'isPinned'], 'chat_messages_room_pinned_idx'],
    ]) {
      try {
        await qi.addIndex('chat_messages', fields, { name });
      } catch {
        // Already present.
      }
    }
    // Full-text index so message search is a MATCH…AGAINST rather than a
    // `LIKE '%term%'` table scan, which stops being usable somewhere around the
    // first hundred thousand messages. Search falls back to LIKE if this fails
    // (older MySQL, or a non-InnoDB table), so it is best-effort by design.
    try {
      await ChatMessage.sequelize.query(
        'ALTER TABLE chat_messages ADD FULLTEXT INDEX chat_messages_body_ft (body)',
      );
    } catch {
      // Already present, or unsupported — ChatService.searchMessages degrades.
    }
  };

  return ChatMessage;
};
