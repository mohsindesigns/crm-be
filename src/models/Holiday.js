const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

// Public / company holidays. A day listed here is not a working day: nobody is
// expected to check in, the attendance summary counts it as `holiday` rather
// than an unmarked absence, and payroll doesn't dock it.
//
// `isRecurring` covers fixed-date national holidays (e.g. 14 August) that repeat
// every year — those are matched on month/day, so one row covers every year.
// Moving holidays (Eid, and anything the company declares ad hoc) stay
// non-recurring and are added per year.
module.exports = (sequelize, DataTypes) => {
  const Holiday = sequelize.define('Holiday', {
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
    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    // Optional multi-day span (e.g. Eid holidays 3–5 April). When set, the
    // holiday covers `date`..`endDate` inclusive; when null it's a single day.
    endDate: {
      type: DataTypes.DATEONLY,
    },
    isRecurring: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    note: {
      type: DataTypes.TEXT,
    },
    // Soft delete — see models/softDeletable.js. A removed holiday stays on
    // record so past attendance still explains itself.
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
  }, {
    tableName: 'holidays',
    indexes: [{ fields: ['org_id'] }, { fields: ['org_id', 'date'] }],
  });

  Holiday.associate = (db) => {
    Holiday.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  Holiday.ensureSchema = () => ensureColumns(Holiday);

  return Holiday;
};
