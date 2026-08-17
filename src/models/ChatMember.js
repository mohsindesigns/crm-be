const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const ChatMember = sequelize.define('ChatMember', {
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
    // Employees are CRM users; portal clients are contacts.
    memberType: {
      type: DataTypes.ENUM('user', 'contact'),
      allowNull: false,
    },
    userId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    contactId: {
      type: DataTypes.CHAR(36),
      references: { model: 'contacts', key: 'id' },
    },
    role: {
      type: DataTypes.ENUM('admin', 'member'),
      allowNull: false,
      defaultValue: 'member',
    },
    // Unread = messages with createdAt > lastReadAt.
    lastReadAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    // Per-room notification volume. 'all' pings on every message, 'mentions'
    // only when named (or @all), 'muted' never.
    //
    // Defaults to 'all' because the realistic action is muting a few noisy
    // rooms, not opting into the rest. Defaulting to 'mentions' meant someone
    // with a hundred conversations had to open every one and switch it on
    // before notifications did anything — so in practice they'd just be
    // silently missing messages.
    notifyLevel: {
      type: DataTypes.ENUM('all', 'mentions', 'muted'),
      allowNull: false,
      defaultValue: 'all',
    },
    // Sidebar pin — personal, unlike ChatMessage.isPinned which is room-wide.
    isFavorite: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Unsent composer text, so switching rooms mid-sentence doesn't lose it.
    draft: {
      type: DataTypes.TEXT,
    },
    joinedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'chat_members',
    updatedAt: false,
    indexes: [
      { fields: ['roomId'] },
      { fields: ['userId'] },
      { fields: ['contactId'] },
      { unique: true, fields: ['roomId', 'userId'], name: 'chat_members_room_user_unique' },
      { unique: true, fields: ['roomId', 'contactId'], name: 'chat_members_room_contact_unique' },
    ],
  });

  ChatMember.associate = (db) => {
    ChatMember.belongsTo(db.ChatRoom, { foreignKey: 'roomId', as: 'room' });
    ChatMember.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
    ChatMember.belongsTo(db.Contact, { foreignKey: 'contactId', as: 'contact' });
  };

  ChatMember.ensureSchema = async () => {
    await ensureColumns(ChatMember);

    // One-time correction of the original 'mentions' default.
    //
    // Keyed on the column's own default rather than a flag: while the column
    // still defaults to 'mentions', no row can hold that value by deliberate
    // choice — the setting had no working UI at the time — so they are all
    // artefacts of the wrong default and safe to move to 'all'. Once the
    // default has been switched this block stops matching, so a user who later
    // picks 'mentions' on purpose is never overwritten.
    try {
      const qiCheck = ChatMember.sequelize.getQueryInterface();
      const cols = await qiCheck.describeTable('chat_members');
      const current = cols.notifyLevel?.defaultValue;
      if (current === 'mentions') {
        const [, meta] = await ChatMember.sequelize.query(
          "UPDATE chat_members SET notifyLevel = 'all' WHERE notifyLevel = 'mentions'",
        );
        await ensureColumnType(ChatMember, 'notifyLevel');
        console.log(`[Schema] chat_members.notifyLevel default corrected to 'all' (${meta?.affectedRows ?? 0} row(s) updated).`);
      }
    } catch (err) {
      console.error('[Schema] chat_members.notifyLevel default fix skipped:', err.message);
    }

    const qi = ChatMember.sequelize.getQueryInterface();
    for (const [fields, name] of [
      [['roomId', 'userId'], 'chat_members_room_user_unique'],
      [['roomId', 'contactId'], 'chat_members_room_contact_unique'],
    ]) {
      try {
        await qi.addIndex('chat_members', fields, { unique: true, name });
      } catch {
        // Already present (MySQL allows multiple NULLs in unique indexes).
      }
    }
  };

  return ChatMember;
};
