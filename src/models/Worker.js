const { v4: uuidv4 } = require('uuid');
const { ensureColumns, ensureColumnType } = require('../utils/schemaSync');

module.exports = (sequelize, DataTypes) => {
  const Worker = sequelize.define('Worker', {
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
    userId: {
      type: DataTypes.CHAR(36),
      allowNull: false,
      references: { model: 'users', key: 'id' },
    },
    workerType: {
      type: DataTypes.ENUM('employee', 'contractor'),
      defaultValue: 'employee',
    },
    payModel: {
      type: DataTypes.ENUM('salary', 'per_deliverable', 'hourly', 'fixed_invoice'),
      defaultValue: 'salary',
    },
    designation: {
      type: DataTypes.STRING(150),
    },
    department: {
      type: DataTypes.STRING(150),
    },
    dateOfBirth: {
      type: DataTypes.DATEONLY,
    },
    profilePictureUrl: {
      type: DataTypes.TEXT,
    },
    joiningDate: {
      type: DataTypes.DATEONLY,
    },
    probationEndDate: {
      type: DataTypes.DATEONLY,
    },
    confirmationDate: {
      type: DataTypes.DATEONLY,
    },
    salaryBase: {
      type: DataTypes.DECIMAL(12, 2),
    },
    currency: {
      type: DataTypes.STRING(10),
      defaultValue: 'PKR',
    },
    bankName: {
      type: DataTypes.STRING(255),
    },
    bankBranchName: {
      type: DataTypes.STRING(255),
    },
    bankBranchCity: {
      type: DataTypes.STRING(255),
    },
    bankAccountTitle: {
      type: DataTypes.STRING(255),
    },
    bankAccountNumber: {
      type: DataTypes.STRING(50),
    },
    iban: {
      type: DataTypes.STRING(50),
    },
    cnic: {
      type: DataTypes.STRING(20),
    },
    address: {
      type: DataTypes.TEXT,
    },
    emergencyContact: {
      type: DataTypes.STRING(255),
    },
    emergencyPhone: {
      type: DataTypes.STRING(50),
    },
    // 'profile_amended' is distinct from 'under_review': the latter is a first-time
    // onboarding submission (invited/profile_pending -> under_review), the former is
    // an already-active employee editing their profile post-onboarding (e.g. bank
    // details, photo, DOB) and needs a separate re-approval pass — see
    // pendingAmendmentDiff below and HrService.submitProfile/onboardWorker.
    status: {
      type: DataTypes.ENUM('invited', 'profile_pending', 'under_review', 'active', 'inactive', 'profile_amended'),
      defaultValue: 'invited',
    },
    rejectionReason: {
      type: DataTypes.TEXT,
    },
    // JSON-serialized { field: { old, new } } diff of what an active employee
    // changed in their most recent profile amendment — shown to the approver,
    // cleared back to null once the amendment is approved/rejected.
    pendingAmendmentDiff: {
      type: DataTypes.TEXT,
    },
    // Permanent per-employee override of which Shift Schedule (see
    // ShiftSchedule.js) governs this worker's attendance timing — null means
    // "use the org-wide default resolution" (an active date-ranged schedule,
    // else PayrollSettings). Set/cleared from the worker's profile or from
    // Policies → Attendance; applies every day regardless of that schedule's
    // own date range until changed again. See HrService#resolveShiftTimings.
    shiftScheduleId: {
      type: DataTypes.CHAR(36),
      references: { model: 'shift_schedules', key: 'id' },
    },
  }, {
    tableName: 'workers',
    indexes: [{ fields: ['org_id'] }, { unique: true, fields: ['user_id'] }],
  });

  Worker.associate = (db) => {
    Worker.belongsTo(db.Org, { foreignKey: 'orgId', as: 'org' });
    Worker.belongsTo(db.User, { foreignKey: 'userId', as: 'user' });
    // One-directional only (no inverse hasMany on ShiftSchedule) — per
    // schemaSync.js's own warning, the inverse is what risks Sequelize
    // materializing a hard onDelete: CASCADE we don't want here.
    Worker.belongsTo(db.ShiftSchedule, { foreignKey: 'shiftScheduleId', as: 'shiftSchedule' });
    Worker.hasMany(db.Attendance, { foreignKey: 'workerId', as: 'attendances' });
    Worker.hasMany(db.LeaveRequest, { foreignKey: 'workerId', as: 'leaveRequests' });
    Worker.hasMany(db.PayrollItem, { foreignKey: 'workerId', as: 'payrollItems' });
    Worker.hasMany(db.HrDocument, { foreignKey: 'workerId', as: 'documents' });
    Worker.hasMany(db.ContractorInvoice, { foreignKey: 'workerId', as: 'contractorInvoices' });
    Worker.hasMany(db.Appraisal, { foreignKey: 'workerId', as: 'appraisals' });
  };

  Worker.ensureSchema = async () => {
    await ensureColumns(Worker);
    // Widen the live status ENUM to include 'profile_amended' — ensureColumns only
    // adds missing columns, it never alters an existing column's type.
    await ensureColumnType(Worker, 'status');
  };

  return Worker;
};
