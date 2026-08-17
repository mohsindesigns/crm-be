const { v4: uuidv4 } = require('uuid');
const { ensureColumns } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const LeaveRequest = sequelize.define('LeaveRequest', {
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
    type: {
      type: DataTypes.ENUM('annual', 'sick', 'casual', 'unpaid', 'other'),
      allowNull: false,
    },
    fromDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    toDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    days: {
      type: DataTypes.DECIMAL(4, 1),
    },
    reason: {
      type: DataTypes.TEXT,
    },
    status: {
      type: DataTypes.ENUM('requested', 'approved', 'rejected'),
      defaultValue: 'requested',
    },
    approverId: {
      type: DataTypes.CHAR(36),
      references: { model: 'users', key: 'id' },
    },
    approverNote: {
      type: DataTypes.TEXT,
    },
    // A half-day leave request must be a single date (fromDate === toDate),
    // with days = 0.5 — used on restricted days (see PayrollSettings.
    // halfDayRestrictedDays) as the required pre-approval for a half-day checkout.
    isHalfDay: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
  }, {
    tableName: 'leave_requests',
  });

  LeaveRequest.ensureSchema = async () => ensureColumns(LeaveRequest);

  LeaveRequest.associate = (db) => {
    LeaveRequest.belongsTo(db.Worker, { foreignKey: 'workerId', as: 'worker' });
    LeaveRequest.belongsTo(db.User, { foreignKey: 'approverId', as: 'approver' });
  };

  return LeaveRequest;
};
