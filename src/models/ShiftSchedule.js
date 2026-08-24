const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

// A named set of shift timings that applies for a date range — modelled on
// TaxYear, which solves the same shape of problem.
//
// The office doesn't run one fixed shift all year: Ramadan hours are shorter,
// and other periods (summer timings, a client-driven schedule change) shift the
// start too. Editing PayrollSettings.shiftStartTime each time silently
// re-judged every *past* day's lateness against the new hours, since lateness
// is computed from whatever the settings said at read time.
//
// A schedule is used when it's `isActive` AND today falls inside its range, so
// the timings that applied on a given date stay correct forever. When no
// schedule matches, PayrollSettings supplies the default shift.
module.exports = (sequelize, DataTypes) => {
  const ShiftSchedule = sequelize.define('ShiftSchedule', {
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
    label: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    startDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    // Nullable: an open-ended schedule ("effective from this date on") stays in
    // effect indefinitely, with no auto-revert date. Only schedules that need to
    // auto-expire (e.g. Ramadan) set this.
    endDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    // Asia/Karachi wall-clock "HH:MM", 24h. End ≤ start wraps past midnight,
    // matching PayrollSettings.
    shiftStartTime: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '15:00',
    },
    shiftEndTime: {
      type: DataTypes.STRING(5),
      allowNull: false,
      defaultValue: '00:30',
    },
    lateGraceMinutes: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 15,
    },
    // Switched on/off by an admin — an out-of-season schedule (next year's
    // Ramadan) can be prepared in advance and left inactive until it applies.
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    // Soft delete — archived schedules drop out of the settings list but stay
    // resolvable for any past date they covered.
    isArchived: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
  }, {
    tableName: 'shift_schedules',
    indexes: [{ fields: ['org_id'] }, { fields: ['org_id', 'start_date', 'end_date'] }],
  });

  ShiftSchedule.associate = (db) => {
    ShiftSchedule.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
  };

  ShiftSchedule.ensureSchema = async () => {
    await ensureColumns(ShiftSchedule);
    await ensureColumnType(ShiftSchedule, 'endDate');
  };

  return ShiftSchedule;
};
