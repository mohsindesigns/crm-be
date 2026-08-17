const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

/**
 * One emoji reaction by one person on one message.
 *
 * Stored as rows rather than a JSON blob on the message so a reaction can be
 * toggled by a single delete without read-modify-writing the whole message (two
 * people reacting at the same instant would otherwise clobber each other), and
 * so "who reacted" is queryable for the hover tooltip.
 *
 * The unique index on (messageId, memberKey, emoji) is what makes toggling
 * idempotent — clicking 😀 twice can never leave two rows behind.
 */
module.exports = (sequelize, DataTypes) => {
  const ChatReaction = sequelize.define('ChatReaction', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    messageId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'chat_messages', key: 'id' },
    },
    // Reactors are either CRM users or portal contacts, mirroring senderType.
    reactorType: {
      type: DataTypes.ENUM('user', 'contact'),
      allowNull: false,
      defaultValue: 'user',
    },
    userId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    contactId: {
      type: DataTypes.CHAR(36),
      references: { model: 'contacts', key: 'id' },
    },
    // `user:<uuid>` / `contact:<uuid>`. A single column is used for the unique
    // index because MySQL treats NULLs as distinct, so a composite index over
    // the two nullable id columns would not actually prevent duplicates.
    memberKey: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // The literal emoji character(s), e.g. '👍'.
    emoji: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
  }, {
    tableName: 'chat_reactions',
    updatedAt: false,
    indexes: [
      { fields: ['messageId'] },
      { unique: true, fields: ['messageId', 'memberKey', 'emoji'], name: 'chat_reactions_unique' },
    ],
  });

  ChatReaction.associate = (db) => {
    ChatReaction.belongsTo(db.ChatMessage, { foreignKey: 'messageId', as: 'message' });
    ChatReaction.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
    ChatReaction.belongsTo(db.Contact, { foreignKey: 'contactId', as: 'contact' });
  };

  ChatReaction.ensureSchema = async () => {
    await ensureColumns(ChatReaction);
    try {
      await ChatReaction.sequelize.getQueryInterface().addIndex(
        'chat_reactions',
        ['messageId', 'memberKey', 'emoji'],
        { unique: true, name: 'chat_reactions_unique' },
      );
    } catch {
      // Already present.
    }
  };

  return ChatReaction;
};
