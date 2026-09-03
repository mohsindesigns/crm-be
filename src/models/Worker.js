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
    // Last day of employment (payroll uses this for leaving-month proration —
    // see utils/payrollCalc.js). Set alongside status: 'inactive'; null means
    // still employed.
    leavingDate: {
      type: DataTypes.DATEONLY,
    },
    probationEndDate: {
      type: DataTypes.DATEONLY,
    },
    confirmationDate: {
      type: DataTypes.DATEONLY,
    },
    // Basic salary (taxable). "Gross" for payroll = salaryBase + medicalAllowance.
    salaryBase: {
      type: DataTypes.DECIMAL(12, 2),
    },
    // Monthly medical allowance, exempt from tax up to PayrollSettings
    // .medicalExemptionCapPercent of salaryBase — excess above the cap is
    // taxable (see utils/payrollCalc.js). Null = default to exactly the cap
    // (the standard "10% of Basic" medical allowance).
    medicalAllowance: {
      type: DataTypes.DECIMAL(12, 2),
    },
    // Extra monthly salary components beyond Basic + Medical — House Rent
    // Allowance, Conveyance, Special Allowance, Bonus, or anything else HR
    // adds. Each item: { id, name, amount, taxable }. Each is paid every
    // month (calendar-day prorated like Basic), but only the ones flagged
    // taxable: true are counted toward taxable salary — see
    // utils/payrollCalc.js#computeSalaryComponents.
    salaryComponents: {
      type: DataTypes.JSON,
      defaultValue: [],
    },
    // When true, calculatePayrollItems skips income-tax withholding entirely
    // for this worker every month (e.g. below the tax threshold, or already
    // taxed elsewhere) — see HrService#calculatePayrollItems. Does not affect
    // Basic/Medical/component earnings, only the tax deduction line.
    taxExempt: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // When true, calculatePayrollItems never deducts pay for this worker's
    // unpaid absences or half-days, regardless of the per-run deductAbsences
    // flag — an always-on, per-employee exemption HR sets once rather than
    // remembering to flip a run-level toggle every month.
    noAttendanceDeduction: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
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
    Worker.hasMany(db.SalaryBeneficiary, { foreignKey: 'workerId', as: 'salaryBeneficiaries' });
  };

  Worker.ensureSchema = async () => {
    await ensureColumns(Worker);
    // Widen the live status ENUM to include 'profile_amended' — ensureColumns only
    // adds missing columns, it never alters an existing column's type.
    await ensureColumnType(Worker, 'status');
  };

  return Worker;
};
