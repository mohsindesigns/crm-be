const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const LeadEvent = sequelize.define('LeadEvent', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    leadId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'leads', key: 'id' },
    },
    fromStatus: {
      type: DataTypes.STRING(50),
    },
    toStatus: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // Null for the system-generated 'new' event created on submit — there's no
    // staff actor behind the public form POST.
    actorUserId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    note: {
      type: DataTypes.TEXT,
    },
  }, {
    tableName: 'lead_events',
    updatedAt: false,
    indexes: [
      { fields: ['lead_id', 'created_at'] },
    ],
  });

  LeadEvent.associate = (db) => {
    LeadEvent.belongsTo(db.Lead, { foreignKey: 'leadId', as: 'lead' });
    LeadEvent.belongsTo(db.User, { foreignKey: 'actorUserId', as: 'actor' });
  };

  // Unlike ProjectEvent (part of the original baseline migration), this table
  // doesn't exist yet on any installed DB — needs ensureColumns to create it.
  LeadEvent.ensureSchema = () => ensureColumns(LeadEvent);

  return LeadEvent;
};
