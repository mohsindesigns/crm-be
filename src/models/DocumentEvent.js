const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const DocumentEvent = sequelize.define('DocumentEvent', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    documentId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'customer_documents', key: 'id' },
    },
    event: {
      type: DataTypes.ENUM(
        'created', 'sent', 'viewed', 'approved', 'rejected', 'reminder', 'converted',
        // The client completing their billing details after approving — step two
        // of the review flow, and what releases the invoice.
        'details_submitted',
      ),
      allowNull: false,
    },
    actor: {
      type: DataTypes.ENUM('admin', 'customer', 'system'),
      allowNull: false,
    },
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    ip: {
      type: DataTypes.STRING(64),
    },
    note: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'document_events',
    updatedAt: false,
  });

  DocumentEvent.associate = (db) => {
    DocumentEvent.belongsTo(db.CustomerDocument, { foreignKey: 'documentId', as: 'document' });
    DocumentEvent.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actorUser' });
  };

  DocumentEvent.ensureSchema = async () => {
    await ensureColumns(DocumentEvent);
    // ensureColumns only ADDS columns — an existing `event` column keeps its old
    // ENUM, so a new value inserts as '' and MySQL rejects it ("Data truncated
    // for column 'event'"). Widen the type explicitly whenever a value is added.
    try {
      await ensureColumnType(DocumentEvent, 'event');
    } catch (err) {
      console.error('[Schema] Could not widen document_events.event ENUM:', err.message);
    }
  };

  return DocumentEvent;
};
