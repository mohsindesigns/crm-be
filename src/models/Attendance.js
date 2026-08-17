const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Attendance = sequelize.define('Attendance', {
    id: {
      type: DataTypes.CHAR(36),
      defaultValue: () => uuidv4(),
      primaryKey: true,
    },
    orgId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
    },
    workerId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'workers', key: 'id' },
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    checkIn: {
      type: DataTypes.TIME,
    },
    checkOut: {
      type: DataTypes.TIME,
    },
    checkInLat: {
      type: DataTypes.DECIMAL(10, 7),
    },
    checkInLng: {
      type: DataTypes.DECIMAL(10, 7),
    },
    checkOutLat: {
      type: DataTypes.DECIMAL(10, 7),
    },
    checkOutLng: {
      type: DataTypes.DECIMAL(10, 7),
    },
    status: {
      type: DataTypes.ENUM('present', 'absent', 'leave', 'half_day', 'holiday', 'weekend'),
      defaultValue: 'present',
    },
    hours: {
      type: DataTypes.DECIMAL(5, 2),
    },
    source: {
      type: DataTypes.STRING(50),
      defaultValue: 'manual',
    },
    note: {
      type: DataTypes.TEXT,
    },
    // Set at check-in against the shift timings in force on that date — see
    // HrService.resolveShiftTimings, which prefers a matching ShiftSchedule
    // (e.g. Ramadan hours) and falls back to PayrollSettings.
    isLate: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    lateMinutes: {
      type: DataTypes.INTEGER,
    },
    // Who recorded this row when an admin marked it on the employee's behalf
    // (source: 'admin') — the audit trail for a manual correction. Null for
    // ordinary self check-ins.
    markedBy: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
  }, {
    tableName: 'attendances',
    indexes: [
      { unique: true, fields: ['worker_id', 'date'] },
    ],
  });

  Attendance.associate = (db) => {
    Attendance.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    Attendance.belongsTo(db.User, { foreignKey: 'markedBy', as: 'markedByUser' });
  };

  Attendance.ensureSchema = () => ensureColumns(Attendance);

  return Attendance;
};
