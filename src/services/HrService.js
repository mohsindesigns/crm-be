const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../models');
const NotificationService = require('./NotificationService');
const EmailService = require('./EmailService');
const { formatPeriod } = require('../utils/formatPeriod');

const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CHANGE_MAX_ATTEMPTS = 5;

const {
  Worker, User, Role, Attendance, LeaveRequest, Holiday, ShiftSchedule,
  PayrollRun, PayrollItem, SalarySlip, HrDocument, ContractorInvoice, PayrollSettings, Appraisal,
  TaxYear, TaxSlab, SalaryBeneficiary,
} = db;

// Roles that don't mark attendance. Owners and admins run the company rather
// than clock in against a shift, so they get no check-in widget, don't appear in
// the roll call / summary / log, and aren't counted as absent for never marking.
// Matched case-insensitively, and any role key containing "partner" counts —
// partner roles are org-defined and may be keyed `partner`, `managing_partner`,
// and so on.
const NON_ATTENDANCE_ROLE_KEYS = ['super_admin', 'admin', 'partner'];

function isNonAttendanceRole(roleKey) {
  const key = String(roleKey || '').trim().toLowerCase();
  if (!key) return false;
  return NON_ATTENDANCE_ROLE_KEYS.includes(key) || key.includes('partner');
}
const {
  daysInCalendarMonth, computePayableDays, computeSalaryStructure,
  computeEarnedAmounts, computeMonthlyTaxable, computeCumulativeTax, activeRangeForMonth,
  computeSalaryComponents, computeDisbursementSplit, computeSplitPayrollTax,
} = require('../utils/payrollCalc');

// Sanitize incoming worker updates so partial PATCH payloads never trip generic
// database-format errors (e.g. empty date/number strings).
const safeDate = (v) => (v && v !== 'Invalid date' ? v : null);
const DATE_FIELDS = ['joiningDate', 'leavingDate', 'probationEndDate', 'confirmationDate', 'dateOfBirth'];
const NUMERIC_FIELDS = ['salaryBase', 'medicalAllowance'];
const TEXT_FIELDS = [
  'designation', 'department', 'profilePictureUrl', 'cnic', 'address', 'emergencyContact',
  'emergencyPhone', 'bankName', 'bankBranchName', 'bankBranchCity',
  'bankAccountTitle', 'bankAccountNumber', 'iban', 'currency',
  'payModel', 'workerType', 'status',
];

function normalizeWorkerUpdates(updates) {
  const clean = { ...updates };
  DATE_FIELDS.forEach((f) => {
    if (f in clean) clean[f] = safeDate(clean[f]);
  });
  NUMERIC_FIELDS.forEach((f) => {
    if (!(f in clean)) return;
    if (clean[f] === '' || clean[f] === null || clean[f] === undefined) {
      clean[f] = null;
      return;
    }
    const n = Number(clean[f]);
    clean[f] = Number.isFinite(n) ? n : null;
  });
  TEXT_FIELDS.forEach((f) => {
    if (!(f in clean) || typeof clean[f] !== 'string') return;
    clean[f] = clean[f].trim();
  });
  // '' means "Default" in the Timing Policy picker — coerce to null rather
  // than writing an empty string into the CHAR(36) column.
  if ('shiftScheduleId' in clean && !clean.shiftScheduleId) clean.shiftScheduleId = null;
  if ('taxExempt' in clean) clean.taxExempt = !!clean.taxExempt;
  if ('noAttendanceDeduction' in clean) clean.noAttendanceDeduction = !!clean.noAttendanceDeduction;
  // Drop incomplete/garbage rows (blank name, non-numeric or zero amount)
  // before they ever reach the DB — calculatePayrollItems would silently
  // skip them anyway (see payrollCalc#computeSalaryComponents), so this just
  // keeps what's actually saved in sync with what the Salary tab shows.
  if (Array.isArray(clean.salaryComponents)) {
    clean.salaryComponents = clean.salaryComponents
      .map((c) => ({
        id: c?.id || uuidv4(),
        name: String(c?.name || '').trim(),
        amount: Number(c?.amount) || 0,
        taxable: !!c?.taxable,
      }))
      .filter((c) => c.name && c.amount > 0);
  }
  return clean;
}

// ─── Workers ──────────────────────────────────────────────────────────────────

async function listWorkers(orgId) {
  // Get all non-client users and existing worker userIds separately, then diff
  const [allUsers, existingWorkers] = await Promise.all([
    User.findAll({
      where: { orgId },
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }),
    Worker.findAll({ where: { orgId }, attributes: ['userId'] }),
  ]);

  const workerUserIds = new Set(existingWorkers.map((w) => w.userId));
  const toCreate = allUsers.filter(
    (u) => !workerUserIds.has(u.id) && u.role?.key !== 'client',
  );

  if (toCreate.length) {
    // Backfill worker records for pre-existing users who never had one (e.g. the seeded
    // super admin). These users predate onboarding, so grandfather them in as 'active'
    // rather than forcing them back through profile completion.
    await Worker.bulkCreate(
      toCreate.map((u) => ({
        id: uuidv4(),
        orgId,
        userId: u.id,
        workerType: 'employee',
        status: 'active',
      })),
      { ignoreDuplicates: true },
    );
  }

  return Worker.findAll({
    where: { orgId },
    include: [{
      model: User,
      as: 'user',
      attributes: ['id', 'name', 'email', 'avatarUrl'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }, {
      model: ShiftSchedule, as: 'shiftSchedule', attributes: ['id', 'label', 'isArchived'], required: false,
    }],
    order: [['createdAt', 'DESC']],
  });
}

async function getWorker(id, orgId) {
  const w = await Worker.findOne({
    where: { id, orgId },
    include: [{
      model: User,
      as: 'user',
      attributes: ['id', 'name', 'email', 'avatarUrl', 'phone'],
      include: [{ association: 'role', attributes: ['id', 'name', 'key', 'color'] }],
    }, {
      model: ShiftSchedule, as: 'shiftSchedule', attributes: ['id', 'label', 'isArchived'], required: false,
    }],
  });
  if (!w) throw Object.assign(new Error('Worker not found'), { status: 404 });
  return w;
}

async function createWorker(data, orgId) {
  return Worker.create({ ...data, orgId });
}

async function updateWorker(id, updates, orgId, actorUserId = null) {
  const w = await Worker.findOne({
    where: { id, orgId },
    include: workerUserInclude,
  });
  if (!w) throw Object.assign(new Error('Worker not found'), { status: 404 });
  const clean = normalizeWorkerUpdates(updates);
  // Name lives on User (login / display), not Worker — peel it off before the
  // worker row update so Sequelize never sees an unknown column.
  const nextName = clean.name !== undefined ? String(clean.name || '').trim() : undefined;
  delete clean.name;
  delete clean.email;
  delete clean.documents;
  delete clean.roleId;

  if (nextName !== undefined) {
    if (nextName.length < 2) {
      throw Object.assign(new Error('Full name must be at least 2 characters.'), { status: 400 });
    }
    await User.update({ name: nextName }, { where: { id: w.userId, orgId } });
  }

  const wasOnboardingReview = w.status === 'under_review';
  const wasPendingProfileReview = wasOnboardingReview || w.status === 'profile_amended';

  // HR saving from the Profile tab counts as approval — no separate Amendment /
  // Onboarding Review step when an admin is the one applying the changes.
  if (wasPendingProfileReview && clean.status !== 'inactive') {
    clean.status = 'active';
    clean.pendingAmendmentDiff = null;
    clean.rejectionReason = null;
  }

  // Guards against the run's worker query (calculatePayrollItems) silently
  // dropping a resigned employee entirely: it only includes an inactive
  // worker for a run whose period covers their leavingDate, so status
  // flipping to inactive with no leavingDate set (or one left over from a
  // date the form doesn't clear) would zero out their final paycheck instead
  // of prorating it. Stamp "today" only when the caller didn't supply one.
  if (clean.status === 'inactive' && w.status !== 'inactive' && !clean.leavingDate && !w.leavingDate) {
    clean.leavingDate = new Date().toISOString().slice(0, 10);
  }

  if (clean.profilePictureUrl !== undefined) {
    await User.update({ avatarUrl: clean.profilePictureUrl }, { where: { id: w.userId, orgId } });
  }
  const updated = await w.update(clean);
  if (clean.status === 'inactive') {
    await User.update({ isActive: false }, { where: { id: w.userId, orgId } });
  } else if (clean.status === 'active') {
    await User.update({ isActive: true }, { where: { id: w.userId, orgId } });
  }

  if (wasOnboardingReview && updated.status === 'active') {
    try {
      await generateAndSaveDocument(updated.id, orgId, 'appointment_letter', actorUserId);
    } catch (err) {
      console.error('[HrService] failed to generate appointment letter on admin profile save:', err.message);
      const existing = await HrDocument.findOne({
        where: { workerId: updated.id, orgId, type: 'appointment_letter' },
      });
      if (!existing) {
        await HrDocument.create({
          orgId,
          workerId: updated.id,
          type: 'appointment_letter',
          label: 'Appointment Letter',
          fileUrl: '',
          uploadedBy: actorUserId,
        });
      }
    }
  }

  return updated.reload({ include: workerUserInclude });
}

function makeTempPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Invite flow: creates User account + Worker record, returns temp password
async function inviteWorker({ name, email, workerType = 'employee', roleId, password }, orgId) {
  const existingUser = await User.findOne({ where: { orgId, email } });
  if (existingUser) {
    const existing = await Worker.findOne({ where: { userId: existingUser.id, orgId } });
    if (existing) throw Object.assign(new Error('This email already has a worker profile'), { status: 409 });
    const worker = await Worker.create({ orgId, userId: existingUser.id, workerType, status: 'invited' });
    return { worker, tempPassword: null };
  }

  const role = roleId
    ? await Role.findOne({ where: { id: roleId, orgId } })
    : await Role.findOne({ where: { key: 'employee', orgId } });

  // Use the admin-provided temporary password when supplied, otherwise generate one
  const tempPassword = password && password.length >= 8 ? password : makeTempPassword();

  const user = await User.create({
    name,
    email,
    passwordHash: tempPassword, // beforeCreate hook auto-hashes it
    orgId,
    roleId: role?.id || null,
    isActive: true,
    mustChangePassword: true, // force a password change on first login
  });
  const worker = await Worker.create({ orgId, userId: user.id, workerType, status: 'invited' });
  return { worker, tempPassword };
}

// Persist a profile photo immediately (capture/upload) without requiring the full
// profile form submit — otherwise refresh loses the new photo until Save is clicked.
async function updateMyAvatar(userId, profilePictureUrl, orgId) {
  const url = typeof profilePictureUrl === 'string' ? profilePictureUrl.trim() : '';
  if (!url) {
    throw Object.assign(new Error('Photo URL is required.'), { status: 400 });
  }
  const worker = await Worker.findOne({ where: { userId, orgId } });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });
  if (!['invited', 'profile_pending', 'under_review', 'active', 'profile_amended'].includes(worker.status)) {
    throw Object.assign(new Error('Photo cannot be updated in the current status.'), { status: 400 });
  }

  await User.update({ avatarUrl: url }, { where: { id: userId, orgId } });
  await worker.update({ profilePictureUrl: url });

  return worker.reload({
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatarUrl'] }],
  });
}

// Employee submits their own profile for admin review. An `active` worker editing
// their profile post-onboarding takes a different target status ('profile_amended')
// than a first-time onboarding submission ('under_review'), and has its changed
// fields captured as a diff so the approver can see exactly what changed — see
// Worker.pendingAmendmentDiff.
async function submitProfile(userId, data, orgId) {
  const worker = await Worker.findOne({
    where: { userId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });
  const user = worker.user;
  if (!user) throw Object.assign(new Error('User account not found'), { status: 404 });
  // 'under_review' is allowed too — lets an employee fix a mistake or add a missed
  // document before HR has acted, without needing HR to reject it back first.
  // 'active' is allowed as the entry point for a post-onboarding amendment.
  if (!['invited', 'profile_pending', 'under_review', 'active'].includes(worker.status)) {
    throw Object.assign(new Error('Profile cannot be submitted in current status'), { status: 400 });
  }
  const isAmendment = worker.status === 'active';
  const allowed = ['joiningDate', 'dateOfBirth', 'profilePictureUrl', 'cnic', 'address', 'emergencyContact', 'emergencyPhone',
    'bankName', 'bankBranchName', 'bankBranchCity', 'bankAccountTitle', 'bankAccountNumber', 'iban'];
  const updates = {};
  allowed.forEach((f) => { if (data[f] !== undefined) updates[f] = data[f]; });
  const cleanUpdates = normalizeWorkerUpdates(updates);

  const fieldErrors = {};
  // Email is changed only via the verified OTP flow (requestEmailChange / confirmEmailChange).
  // Profile submit must not silently swap the login email.
  if (data.email !== undefined) {
    const normalizedEmail = String(data.email || '').trim().toLowerCase();
    if (normalizedEmail && normalizedEmail !== String(user.email || '').toLowerCase()) {
      fieldErrors.email = 'Verify the new email with the code sent to that address before saving.';
    }
  }

  const nextName = data.name !== undefined ? String(data.name || '').trim() : undefined;
  if (nextName !== undefined && nextName.length < 2) {
    fieldErrors.name = 'Full name must be at least 2 characters.';
  }

  if (!cleanUpdates.cnic) fieldErrors.cnic = 'CNIC is required.';
  if (!cleanUpdates.bankName) fieldErrors.bankName = 'Bank name is required.';
  if (!cleanUpdates.bankAccountTitle) fieldErrors.bankAccountTitle = 'Account title is required.';
  if (!cleanUpdates.bankAccountNumber) fieldErrors.bankAccountNumber = 'Account number is required.';
  if (cleanUpdates.cnic && !/^\d{5}-\d{7}-\d{1}$/.test(cleanUpdates.cnic)) {
    fieldErrors.cnic = 'CNIC must be in the format 12345-1234567-1.';
  }
  if (Object.keys(fieldErrors).length > 0) {
    const err = new Error(Object.values(fieldErrors)[0]);
    err.status = 422;
    err.errors = fieldErrors;
    throw err;
  }

  // Keep User.avatarUrl (used app-wide, e.g. the header) in sync with the
  // worker's uploaded photo — they're separate columns on separate tables.
  if (cleanUpdates.profilePictureUrl !== undefined) {
    await User.update({ avatarUrl: cleanUpdates.profilePictureUrl }, { where: { id: userId, orgId } });
  }

  // Display name is on User; apply it here so employees can correct spelling
  // without waiting on a separate Team → Users edit.
  if (nextName !== undefined && nextName !== String(user.name || '').trim()) {
    await User.update({ name: nextName }, { where: { id: userId, orgId } });
  }

  let diff = worker.pendingAmendmentDiff || null;
  if (isAmendment) {
    const changed = {};
    for (const f of Object.keys(cleanUpdates)) {
      const oldVal = worker[f] ?? null;
      const newVal = cleanUpdates[f] ?? null;
      if (String(oldVal) !== String(newVal)) changed[f] = { old: oldVal, new: newVal };
    }
    if (nextName !== undefined && nextName !== String(user.name || '').trim()) {
      changed.name = { old: user.name || null, new: nextName };
    }
    diff = Object.keys(changed).length ? JSON.stringify(changed) : null;
  }

  await worker.update({
    ...cleanUpdates,
    status: isAmendment ? 'profile_amended' : 'under_review',
    pendingAmendmentDiff: diff,
    rejectionReason: null,
  });

  // Persist any documents (CV, CNIC front/back) uploaded alongside the profile.
  // On resubmission, replace the prior version of each type rather than piling up duplicates.
  const allowedDocTypes = ['cv', 'cnic_front', 'cnic_back'];
  const docs = Array.isArray(data.documents) ? data.documents.filter((d) => d?.fileUrl && allowedDocTypes.includes(d.type)) : [];
  if (docs.length) {
    await HrDocument.destroy({ where: { workerId: worker.id, type: docs.map((d) => d.type) } });
    await HrDocument.bulkCreate(docs.map((doc) => ({
      orgId,
      workerId: worker.id,
      type: doc.type,
      fileUrl: doc.fileUrl,
      fileName: doc.fileName || null,
      uploadedBy: userId,
    })));
  }

  return worker.reload({
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatarUrl'] }],
  });
}

async function requestEmailChange(userId, orgId, newEmailRaw) {
  const user = await User.findOne({ where: { id: userId, orgId } });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const newEmail = String(newEmailRaw || '').trim().toLowerCase();
  if (!newEmail) throw Object.assign(new Error('Email is required.'), { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    throw Object.assign(new Error('A valid email address is required.'), { status: 400 });
  }
  if (newEmail === String(user.email || '').toLowerCase()) {
    throw Object.assign(new Error('That is already your current email.'), { status: 400 });
  }

  const taken = await User.findOne({ where: { orgId, email: newEmail, id: { [Op.ne]: userId } } });
  if (taken) throw Object.assign(new Error('This email is already in use.'), { status: 409 });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = await bcrypt.hash(code, 10);
  await user.update({
    pendingEmail: newEmail,
    emailChangeCodeHash: codeHash,
    emailChangeCodeExpiresAt: new Date(Date.now() + EMAIL_CHANGE_CODE_TTL_MS),
    emailChangeCodeAttempts: 0,
  });

  const brandingConfig = await db.WhiteLabelConfig.findOne({ where: { orgId } }).catch(() => null);
  const brandName = brandingConfig?.brandName || process.env.EMAIL_BRAND_NAME || 'Mohsin Designs Project Management';

  await EmailService.sendEmailChangeCode(newEmail, user.name, brandName, code);

  return { message: 'A verification code has been sent to your new email address.', email: newEmail };
}

async function confirmEmailChange(userId, orgId, { email: emailRaw, code: codeRaw }) {
  const user = await User.findOne({ where: { id: userId, orgId } });
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });

  const email = String(emailRaw || '').trim().toLowerCase();
  const code = String(codeRaw || '').trim();
  if (!email || !code) {
    throw Object.assign(new Error('Email and verification code are required.'), { status: 400 });
  }
  if (!user.pendingEmail || !user.emailChangeCodeHash) {
    throw Object.assign(new Error('No email change is pending. Request a new verification code.'), { status: 400 });
  }
  if (email !== String(user.pendingEmail).toLowerCase()) {
    throw Object.assign(new Error('Email does not match the address waiting for verification.'), { status: 400 });
  }
  if (!user.emailChangeCodeExpiresAt || new Date(user.emailChangeCodeExpiresAt) < new Date()) {
    await user.update({
      pendingEmail: null,
      emailChangeCodeHash: null,
      emailChangeCodeExpiresAt: null,
      emailChangeCodeAttempts: 0,
    });
    throw Object.assign(new Error('Your code has expired. Please request a new one.'), { status: 401 });
  }
  if ((user.emailChangeCodeAttempts || 0) >= EMAIL_CHANGE_MAX_ATTEMPTS) {
    await user.update({
      pendingEmail: null,
      emailChangeCodeHash: null,
      emailChangeCodeExpiresAt: null,
      emailChangeCodeAttempts: 0,
    });
    throw Object.assign(new Error('Too many incorrect attempts. Please request a new code.'), { status: 429 });
  }

  const ok = await bcrypt.compare(code, user.emailChangeCodeHash);
  if (!ok) {
    await user.update({ emailChangeCodeAttempts: (user.emailChangeCodeAttempts || 0) + 1 });
    throw Object.assign(new Error('Incorrect code. Please try again.'), { status: 401 });
  }

  const taken = await User.findOne({ where: { orgId, email, id: { [Op.ne]: userId } } });
  if (taken) {
    await user.update({
      pendingEmail: null,
      emailChangeCodeHash: null,
      emailChangeCodeExpiresAt: null,
      emailChangeCodeAttempts: 0,
    });
    throw Object.assign(new Error('This email is already in use.'), { status: 409 });
  }

  const previousEmail = user.email;
  await user.update({
    email,
    pendingEmail: null,
    emailChangeCodeHash: null,
    emailChangeCodeExpiresAt: null,
    emailChangeCodeAttempts: 0,
  });

  return {
    email: user.email,
    previousEmail,
    message: 'Email updated successfully.',
  };
}

const workerUserInclude = [
  { model: User, as: 'user', attributes: ['id', 'name', 'email'] },
  { model: ShiftSchedule, as: 'shiftSchedule', attributes: ['id', 'label', 'isArchived'], required: false },
];

async function notifyProfileReviewDecision(worker, orgId, { action, reason, isAmendment }) {
  if (action !== 'reject') return;
  try {
    let employeeUser = worker.user;
    if (!employeeUser) {
      const loaded = await Worker.findOne({
        where: { id: worker.id, orgId },
        include: workerUserInclude,
      });
      employeeUser = loaded?.user;
    }
    if (!employeeUser) return;

    const title = isAmendment ? 'Profile changes rejected' : 'Profile submission rejected';
    const body = isAmendment
      ? `HR rejected your profile changes.${reason ? ` Reason: "${reason}"` : ''} Please update your profile and submit again.`
      : `HR rejected your profile submission.${reason ? ` Reason: "${reason}"` : ''} Please revise your details and resubmit for review.`;

    NotificationService.notify(employeeUser.id, orgId, {
      type: 'profile_rejected',
      title,
      body,
      refTable: 'self_service',
      refId: worker.id,
    }).catch((err) => {
      console.error('[HrService] profile rejection in-app notification failed:', err.message);
    });

    if (employeeUser.email) {
      EmailService.sendProfileReviewUpdate({
        workerEmail: employeeUser.email,
        workerName: employeeUser.name,
        status: 'rejected',
        isAmendment,
        reason,
        appUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      }).catch((err) => {
        console.error('[HrService] profile rejection email failed:', err.message);
      });
    }
  } catch (err) {
    console.error('[HrService] profile review notification failed:', err.message);
  }
}

// Admin approves or rejects an onboarding worker, OR reviews a post-onboarding
// profile amendment (worker.status === 'profile_amended') — same approve/reject
// shape, but an amendment always returns to 'active' either way (there's no
// "employment terms" to (re)set, unlike first-time onboarding) and clears the diff.
async function onboardWorker(workerId, action, adminData, orgId) {
  const worker = await Worker.findOne({
    where: { id: workerId, orgId },
    include: workerUserInclude,
  });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });
  if (worker.status === 'profile_amended') {
    if (action === 'approve') {
      await worker.update({ status: 'active', pendingAmendmentDiff: null, rejectionReason: null });
      return worker.reload({ include: workerUserInclude });
    }
    if (action === 'reject') {
      if (!adminData.reason?.trim()) {
        throw Object.assign(new Error('A reason is required when rejecting a submission.'), { status: 400 });
      }
      const reason = adminData.reason.trim();
      await worker.update({ status: 'active', pendingAmendmentDiff: null, rejectionReason: reason });
      await notifyProfileReviewDecision(worker, orgId, { action: 'reject', reason, isAmendment: true });
      return worker.reload({ include: workerUserInclude });
    }
    throw Object.assign(new Error('Invalid action: must be approve or reject'), { status: 400 });
  }
  if (worker.status !== 'under_review') {
    throw Object.assign(new Error('Worker is not under review'), { status: 400 });
  }
  if (action === 'approve') {
    const { designation, department, salaryBase, probationEndDate, payModel, workerType, joiningDate, adminId } = adminData;
    await worker.update({
      designation,
      department,
      salaryBase,
      probationEndDate: safeDate(probationEndDate),
      payModel: payModel || worker.payModel,
      workerType: workerType || worker.workerType,
      joiningDate: safeDate(joiningDate) || worker.joiningDate,
      status: 'active',
      rejectionReason: null,
    });
    // Issue a real appointment letter PDF (not an empty stub) so the employee can open it immediately.
    try {
      await generateAndSaveDocument(worker.id, orgId, 'appointment_letter', adminId);
    } catch (err) {
      console.error('[HrService] failed to generate appointment letter on approve:', err.message);
      await HrDocument.create({
        orgId,
        workerId: worker.id,
        type: 'appointment_letter',
        label: 'Appointment Letter',
        fileUrl: '',
        uploadedBy: adminId,
      });
    }
    return worker.reload({ include: workerUserInclude });
  }
  if (action === 'reject') {
    if (!adminData.reason?.trim()) {
      throw Object.assign(new Error('A reason is required when rejecting a submission.'), { status: 400 });
    }
    const reason = adminData.reason.trim();
    await worker.update({ status: 'profile_pending', rejectionReason: reason });
    await notifyProfileReviewDecision(worker, orgId, { action: 'reject', reason, isAmendment: false });
    return worker.reload({ include: workerUserInclude });
  }
  throw Object.assign(new Error('Invalid action: must be approve or reject'), { status: 400 });
}

// ─── Public holidays ──────────────────────────────────────────────────────────

async function listHolidays(orgId, { year, includeInactive = false } = {}) {
  const where = { orgId, ...(includeInactive ? {} : { isActive: true }) };
  const rows = await Holiday.findAll({ where, order: [['date', 'ASC']] });
  if (!year) return rows;
  // Recurring (fixed-date) holidays apply to every year, so they're kept
  // regardless of which year their stored row happens to sit in.
  return rows.filter((h) => h.isRecurring || String(h.date).slice(0, 4) === String(year));
}

async function createHoliday(orgId, data) {
  const name = String(data.name || '').trim();
  const date = data.date ? String(data.date).slice(0, 10) : '';
  if (!name) throw Object.assign(new Error('Holiday name is required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('A valid holiday date (YYYY-MM-DD) is required.'), { status: 400 });
  }
  const endDate = data.endDate ? String(data.endDate).slice(0, 10) : null;
  if (endDate && endDate < date) {
    throw Object.assign(new Error('The holiday end date cannot be before its start date.'), { status: 400 });
  }
  const holiday = await Holiday.create({
    orgId, name, date, endDate,
    isRecurring: !!data.isRecurring,
    note: data.note || null,
  });
  // Reflect it onto the attendance log immediately — fixes any already-marked
  // absence (e.g. a retroactive holiday, or one declared after the overnight
  // sweep ran) rather than leaving it to the next payroll run or manual sweep.
  await ensureHolidayMarks(orgId, date, endDate || date);
  return holiday;
}

async function updateHoliday(id, orgId, updates) {
  const holiday = await Holiday.findOne({ where: { id, orgId } });
  if (!holiday) throw Object.assign(new Error('Holiday not found.'), { status: 404 });
  const patch = { ...updates };
  if (patch.date) patch.date = String(patch.date).slice(0, 10);
  if (patch.endDate !== undefined) patch.endDate = patch.endDate ? String(patch.endDate).slice(0, 10) : null;
  const start = patch.date || holiday.date;
  const end = patch.endDate !== undefined ? patch.endDate : holiday.endDate;
  if (end && String(end) < String(start)) {
    throw Object.assign(new Error('The holiday end date cannot be before its start date.'), { status: 400 });
  }
  await holiday.update(patch);
  if (holiday.isActive) await ensureHolidayMarks(orgId, holiday.date, holiday.endDate || holiday.date);
  return holiday;
}

// Deactivates rather than destroys — see services/SoftDeleteService.js.
async function deleteHoliday(id, orgId, active = false) {
  const holiday = await Holiday.findOne({ where: { id, orgId } });
  if (!holiday) throw Object.assign(new Error('Holiday not found.'), { status: 404 });
  await holiday.update({ isActive: active });
  if (active) await ensureHolidayMarks(orgId, holiday.date, holiday.endDate || holiday.date);
  return holiday;
}

/** Does holiday `h` cover `dateStr`? Matches month/day for recurring rows. */
function holidayCoversDate(h, dateStr) {
  const day = String(dateStr).slice(0, 10);
  const start = String(h.date).slice(0, 10);
  const end = h.endDate ? String(h.endDate).slice(0, 10) : start;
  if (h.isRecurring) {
    // Fixed-date annual holiday — compare month/day across the whole span.
    const mmdd = day.slice(5);
    return mmdd >= start.slice(5) && mmdd <= end.slice(5);
  }
  return day >= start && day <= end;
}

/** The holiday covering `dateStr`, or null. */
async function findHolidayFor(orgId, dateStr) {
  const holidays = await Holiday.findAll({ where: { orgId, isActive: true } });
  return holidays.find((h) => holidayCoversDate(h, dateStr)) || null;
}

/**
 * Reflects declared holidays onto the attendance log for a date range (capped
 * at today, same as ensureWeekendMarks): fills missing rows with `holiday`,
 * and — unlike ensureWeekendMarks — repairs any `absent` row with no check-in,
 * since that's exactly what happens when the overnight sweep marked someone
 * absent before HR declared the day a holiday (or declared it retroactively).
 * Never touches present/half_day/leave rows, or any row with an actual check-in.
 */
async function ensureHolidayMarks(orgId, rangeStart, rangeEnd) {
  const workerIds = await attendanceWorkerIds(orgId);
  if (!workerIds.length) return;

  const { date: todayKarachi } = nowInKarachi();
  const start = String(rangeStart).slice(0, 10);
  const cappedEnd = String(rangeEnd).slice(0, 10) > todayKarachi ? todayKarachi : String(rangeEnd).slice(0, 10);
  if (start > cappedEnd) return;

  const holidays = await Holiday.findAll({ where: { orgId, isActive: true } });
  if (!holidays.length) return;

  const holidayByDate = new Map();
  for (let t = new Date(`${start}T00:00:00Z`).getTime(); t <= new Date(`${cappedEnd}T00:00:00Z`).getTime(); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const match = holidays.find((h) => holidayCoversDate(h, date));
    if (match) holidayByDate.set(date, match);
  }
  if (!holidayByDate.size) return;

  const holidayDates = [...holidayByDate.keys()];
  const existing = await Attendance.findAll({
    where: { orgId, workerId: { [Op.in]: workerIds }, date: { [Op.in]: holidayDates } },
  });
  const byKey = new Map(existing.map((a) => [`${a.workerId}|${a.date}`, a]));

  const toCreate = [];
  const repairs = [];
  for (const workerId of workerIds) {
    for (const date of holidayDates) {
      const row = byKey.get(`${workerId}|${date}`);
      if (row) {
        if (row.status === 'absent' && !row.checkIn) repairs.push(row);
        continue;
      }
      toCreate.push({
        orgId, workerId, date, status: 'holiday',
        note: holidayByDate.get(date).name, source: 'system',
      });
    }
  }

  await Promise.all(repairs.map((row) => row.update({
    status: 'holiday',
    note: holidayByDate.get(row.date).name,
    source: 'system',
    checkOut: null, hours: null, isLate: false, lateMinutes: null, markedBy: null,
  })));

  // Insert only missing rows beyond the repairs above — never overwrite present/leave.
  if (toCreate.length) {
    try {
      await Attendance.bulkCreate(toCreate, { ignoreDuplicates: true });
    } catch (err) {
      // Unique (worker_id, date) races shouldn't fail the attendance view.
      console.error('[HrService] ensureHolidayMarks skipped:', err.message);
    }
  }
}

// ─── Shift schedules (seasonal timings, e.g. Ramadan) ─────────────────────────

async function listShiftSchedules(orgId, { includeArchived = false } = {}) {
  return ShiftSchedule.findAll({
    where: { orgId, ...(includeArchived ? {} : { isArchived: false }) },
    order: [['startDate', 'DESC']],
  });
}

// `endDate` is optional — an open-ended schedule has no auto-revert date and
// stays in effect indefinitely once its start date arrives.
function assertScheduleRange(startDate, endDate) {
  const start = startDate ? String(startDate).slice(0, 10) : '';
  const end = endDate ? String(endDate).slice(0, 10) : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    throw Object.assign(new Error('A valid start date (YYYY-MM-DD) is required.'), { status: 400 });
  }
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw Object.assign(new Error('The end date must be a valid date (YYYY-MM-DD).'), { status: 400 });
  }
  if (end && end < start) {
    throw Object.assign(new Error('The schedule end date cannot be before its start date.'), { status: 400 });
  }
  return { start, end };
}

async function createShiftSchedule(orgId, data) {
  const label = String(data.label || '').trim();
  if (!label) throw Object.assign(new Error('A schedule name is required (e.g. "Ramadan 2027").'), { status: 400 });
  const { start, end } = assertScheduleRange(data.startDate, data.endDate);
  return ShiftSchedule.create({
    orgId,
    label,
    startDate: start,
    endDate: end,
    shiftStartTime: data.shiftStartTime || '15:00',
    shiftEndTime: data.shiftEndTime || '00:30',
    lateGraceMinutes: data.lateGraceMinutes != null ? parseInt(data.lateGraceMinutes, 10) : 15,
    isActive: data.isActive !== false,
  });
}

async function updateShiftSchedule(id, orgId, updates) {
  const schedule = await ShiftSchedule.findOne({ where: { id, orgId } });
  if (!schedule) throw Object.assign(new Error('Shift schedule not found.'), { status: 404 });
  const patch = { ...updates };
  if (patch.startDate !== undefined || patch.endDate !== undefined) {
    const { start, end } = assertScheduleRange(
      patch.startDate !== undefined ? patch.startDate : schedule.startDate,
      patch.endDate !== undefined ? patch.endDate : schedule.endDate,
    );
    patch.startDate = start;
    patch.endDate = end;
  }
  await schedule.update(patch);
  return schedule;
}

// Archives rather than destroys — a past schedule still explains how lateness
// was judged on the days it covered.
async function deleteShiftSchedule(id, orgId, archived = true) {
  const schedule = await ShiftSchedule.findOne({ where: { id, orgId } });
  if (!schedule) throw Object.assign(new Error('Shift schedule not found.'), { status: 404 });
  await schedule.update({ isArchived: archived });
  return schedule;
}

/**
 * The shift timings in force on `dateStr`: the active, non-archived schedule
 * whose range covers that date, falling back to the org's PayrollSettings.
 * Everything that judges lateness or shift length goes through this, so a
 * Ramadan schedule automatically applies to Ramadan days and to nothing else.
 *
 * If `worker` carries a `shiftScheduleId` (a permanent per-employee policy
 * assignment — see Worker.js), that schedule wins outright and short-circuits
 * the date-range matching below entirely: an assigned employee stays on
 * their assigned policy every day, Active toggle and date range notwithstanding,
 * until the assignment is changed or cleared. Falls through to the normal
 * date-based resolution if the assigned schedule has since been archived.
 */
async function resolveShiftTimings(orgId, dateStr, settings, worker) {
  const base = settings || await getOrCreatePayrollSettings(orgId);

  if (worker?.shiftScheduleId) {
    const assigned = await ShiftSchedule.findOne({
      where: { id: worker.shiftScheduleId, orgId, isArchived: false },
    });
    if (assigned) {
      return {
        shiftStartTime: assigned.shiftStartTime,
        shiftEndTime: assigned.shiftEndTime,
        lateGraceMinutes: assigned.lateGraceMinutes,
        source: 'assigned',
        label: assigned.label,
      };
    }
  }

  const day = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ...timingsFrom(base), source: 'default', label: null };

  const schedule = await ShiftSchedule.findOne({
    where: {
      orgId,
      isActive: true,
      isArchived: false,
      startDate: { [Op.lte]: day },
      // Open-ended (endDate null) schedules never expire.
      [Op.or]: [{ endDate: null }, { endDate: { [Op.gte]: day } }],
    },
    // Most recently starting schedule wins if two somehow overlap.
    order: [['startDate', 'DESC']],
  });
  if (!schedule) return { ...timingsFrom(base), source: 'default', label: null };
  return {
    shiftStartTime: schedule.shiftStartTime,
    shiftEndTime: schedule.shiftEndTime,
    lateGraceMinutes: schedule.lateGraceMinutes,
    source: 'schedule',
    label: schedule.label,
  };
}

function timingsFrom(settings) {
  return {
    shiftStartTime: settings.shiftStartTime || '15:00',
    shiftEndTime: settings.shiftEndTime || '00:30',
    lateGraceMinutes: parseInt(settings.lateGraceMinutes, 10) || 0,
  };
}

// ─── Attendance ───────────────────────────────────────────────────────────────

/** Worker ids for everyone who is expected to mark attendance. */
async function attendanceWorkerIds(orgId) {
  const workers = await Worker.findAll({
    where: { orgId },
    attributes: ['id'],
    include: [{
      model: User, as: 'user', attributes: ['id'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }],
  });
  return workers.filter((w) => !isNonAttendanceRole(w.user?.role?.key)).map((w) => w.id);
}

async function listAttendance(orgId, { workerId, month, date, page, limit } = {}) {
  await purgeFutureWeekendMarks(orgId);

  const where = { orgId };
  if (workerId) where.workerId = workerId;
  else {
    // Admins/partners never mark attendance, so any stray row of theirs (from
    // before this rule, or from a role change) must not surface in the log either.
    where.workerId = { [Op.in]: await attendanceWorkerIds(orgId) };
  }
  if (date) {
    // Exact day for Daily Roll Call — must not rely on a paginated month page,
    // or past dates look empty / stuck on "today".
    const day = String(date).slice(0, 10);
    where.date = day;
    // Repair any row the 3 AM sweep already marked `absent` before this day was
    // (or became) a declared holiday — same repair getAttendanceSummary does,
    // but this view wasn't running it, so stale absents never self-healed here.
    await ensureHolidayMarks(orgId, day, day).catch((err) => {
      console.error('[HrService] listAttendance holiday backfill skipped:', err.message);
    });
    // If the shift window for this date has closed, persist absent rows for
    // anyone who never checked in (same rules as the 3 AM cron).
    if (isAbsentSweepDue(day)) {
      await markAbsentForUnmarkedWorkers(orgId, day).catch((err) => {
        console.error('[HrService] listAttendance absent backfill skipped:', err.message);
      });
    }
  } else if (month) {
    const [year, m] = month.split('-');
    const daysInMonth = new Date(parseInt(year, 10), parseInt(m, 10), 0).getDate();
    const monthStart = `${year}-${m}-01`;
    const monthEnd = `${year}-${m}-${String(daysInMonth).padStart(2, '0')}`;
    where.date = { [Op.between]: [monthStart, monthEnd] };
    // Same repair — the monthly Attendance Log has the same self-heal gap as Daily Roll Call.
    await ensureHolidayMarks(orgId, monthStart, monthEnd).catch((err) => {
      console.error('[HrService] listAttendance holiday backfill skipped:', err.message);
    });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(500, parseInt(limit, 10) || 50);
  const offset = (pageNum - 1) * limitNum;

  const { count, rows } = await Attendance.findAndCountAll({
    where,
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }],
    order: [['date', 'DESC']],
    limit: limitNum,
    offset,
    distinct: true,
  });

  return { data: rows, total: count, page: pageNum, totalPages: Math.ceil(count / limitNum) || 1, limit: limitNum };
}

// Per-employee monthly summary (present/absent/leave/half-day counts) + an
// org-wide total row — the existing Daily Roll Call / Attendance Log views are
// flat marking/logging tools, this is the aggregate admin wants for a
// month-at-a-glance read.
async function getAttendanceSummary(orgId, month) {
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const [year, m] = targetMonth.split('-');
  const daysInMonth = new Date(parseInt(year, 10), parseInt(m, 10), 0).getDate();
  const monthStart = `${year}-${m}-01`;
  const monthEnd = `${year}-${m}-${String(daysInMonth).padStart(2, '0')}`;

  // Stamp configured weekly offs onto the log so Sat/Sun show as Weekend without
  // HR having to bulk-mark every weekend by hand.
  await ensureWeekendMarks(orgId, monthStart, monthEnd);
  // Same for declared holidays — also repairs any already-marked `absent` row.
  await ensureHolidayMarks(orgId, monthStart, monthEnd);

  const workers = await Worker.findAll({
    where: { orgId, status: 'active' },
    include: [{
      model: User,
      as: 'user',
      attributes: ['id', 'name'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }],
    order: [[{ model: User, as: 'user' }, 'name', 'ASC']],
  });

  // Admins/owners/partners don't mark personal attendance — keep them out.
  const attendanceWorkers = workers.filter((w) => !isNonAttendanceRole(w.user?.role?.key));

  const attendances = await Attendance.findAll({
    where: { orgId, date: { [Op.between]: [monthStart, monthEnd] } },
  });
  const byWorker = new Map();
  for (const a of attendances) {
    if (!byWorker.has(a.workerId)) byWorker.set(a.workerId, []);
    byWorker.get(a.workerId).push(a);
  }

  const rows = attendanceWorkers.map((w) => {
    const records = byWorker.get(w.id) || [];
    const count = (status) => records.filter((r) => r.status === status).length;
    return {
      workerId: w.id,
      name: w.user?.name || '—',
      present: count('present'),
      absent: count('absent'),
      leave: count('leave'),
      halfDay: count('half_day'),
      holiday: count('holiday'),
      weekend: count('weekend'),
      totalMarked: records.length,
    };
  });

  const total = rows.reduce((acc, r) => ({
    present: acc.present + r.present,
    absent: acc.absent + r.absent,
    leave: acc.leave + r.leave,
    halfDay: acc.halfDay + r.halfDay,
  }), { present: 0, absent: 0, leave: 0, halfDay: 0 });

  return { month: targetMonth, daysInMonth, rows, total, workerCount: attendanceWorkers.length };
}

/**
 * Admin marks (or corrects) one employee's attendance for a day.
 *
 * This is the backstop for the everyday case of someone simply forgetting to
 * check in: attendance is otherwise self-marked with GPS, which leaves no way to
 * record a day that was genuinely worked. Rows written here are stamped
 * `source: 'admin'` so they stay distinguishable from self check-ins in the log,
 * and `markedBy` records who made the correction.
 *
 * Lateness is recomputed from the shift timings that applied on that date (see
 * resolveShiftTimings), so back-filling a Ramadan day is judged against Ramadan
 * hours, not today's.
 */
async function upsertAttendance(data, orgId, actorUserId) {
  const workerId = data.workerId;
  const date = data.date ? String(data.date).slice(0, 10) : '';
  if (!workerId) throw Object.assign(new Error('An employee is required.'), { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw Object.assign(new Error('A valid date (YYYY-MM-DD) is required.'), { status: 400 });
  }

  const worker = await Worker.findOne({
    where: { id: workerId, orgId },
    include: [{
      model: User, as: 'user', attributes: ['id'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }],
  });
  if (!worker) throw Object.assign(new Error('Employee not found.'), { status: 404 });
  if (isNonAttendanceRole(worker.user?.role?.key)) {
    throw Object.assign(
      new Error('Admins and partners do not mark attendance, so it cannot be recorded for them.'),
      { status: 400 },
    );
  }

  const checkIn = data.checkIn || null;
  const checkOut = data.checkOut || null;

  const patch = {
    orgId,
    workerId,
    date,
    status: data.status || 'present',
    checkIn,
    checkOut,
    note: data.note || null,
    source: data.source || 'admin',
    markedBy: actorUserId || null,
  };

  // Derive hours and lateness from the times given, against that date's shift.
  const timings = await resolveShiftTimings(orgId, date, null, worker);
  if (checkIn && checkOut) patch.hours = workedHours(checkIn, checkOut);
  else if (data.hours != null && data.hours !== '') patch.hours = Number(data.hours);
  if (checkIn) {
    const { isLate, lateMinutes } = computeLateness(checkIn, timings);
    patch.isLate = isLate;
    patch.lateMinutes = lateMinutes;
  } else {
    patch.isLate = false;
    patch.lateMinutes = null;
  }

  const [record, created] = await Attendance.findOrCreate({ where: { workerId, date }, defaults: patch });
  if (!created) await record.update(patch);
  return record;
}

/**
 * Marks a whole day for every attendance-marking employee at once — used to
 * close out a public holiday, or to sweep an ordinary day's non-markers as
 * absent. Existing rows are left alone unless `overwrite` is set, so a day
 * someone did check in on isn't wiped by a bulk holiday mark.
 */
async function bulkMarkAttendance(orgId, { date, status = 'holiday', note, overwrite = false }, actorUserId) {
  const day = date ? String(date).slice(0, 10) : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw Object.assign(new Error('A valid date (YYYY-MM-DD) is required.'), { status: 400 });
  }

  const workerIds = await attendanceWorkerIds(orgId);
  if (!workerIds.length) return { date: day, marked: 0, skipped: 0 };

  const existing = await Attendance.findAll({ where: { workerId: workerIds, date: day } });
  const byWorker = new Map(existing.map((a) => [a.workerId, a]));

  let marked = 0;
  let skipped = 0;
  for (const workerId of workerIds) {
    const row = byWorker.get(workerId);
    if (row && !overwrite) { skipped += 1; continue; }
    const patch = {
      orgId, workerId, date: day, status,
      note: note || null, source: 'admin', markedBy: actorUserId || null,
      checkIn: null, checkOut: null, hours: null, isLate: false, lateMinutes: null,
    };
    if (row) await row.update(patch);
    else await Attendance.create(patch);
    marked += 1;
  }
  return { date: day, marked, skipped };
}

const { getAttendanceDate, workedHours, nowInKarachi, shiftCalendarDate } = require('../utils/attendanceDate');

function timeStrToMinutes(t) {
  const [h, m] = String(t || '0:0').split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

/**
 * Shift duration in minutes — end ≤ start (e.g. 15:00 → 00:30) wraps past
 * midnight. Takes either a PayrollSettings row or a resolved timings object
 * from resolveShiftTimings, since both expose the same two fields.
 */
function shiftDurationMinutes(timings) {
  const start = timeStrToMinutes(timings.shiftStartTime || '15:00');
  let end = timeStrToMinutes(timings.shiftEndTime || '00:30');
  if (end <= start) end += 24 * 60;
  return end - start;
}

// A check-in's clock-hour alone doesn't say how late it is — someone checking
// in at 00:10 for a 3pm shift is ~9 hours late, not "early" just because 00:10
// is a small number. Early-morning hours (before noon) are folded forward a
// day so lateness is always measured forward from shiftStartTime, matching
// how the attendance day itself already runs noon→noon (see attendanceDate.js).
function computeLateness(checkInTime, timings) {
  const shiftStart = timeStrToMinutes(timings.shiftStartTime || '15:00');
  const grace = parseInt(timings.lateGraceMinutes, 10) || 0;
  let checkInMin = timeStrToMinutes(checkInTime);
  if (checkInMin < 12 * 60) checkInMin += 24 * 60;
  const diff = checkInMin - shiftStart - grace;
  return diff > 0 ? { isLate: true, lateMinutes: diff } : { isLate: false, lateMinutes: 0 };
}

// Classifies a checkout into present/half_day/absent from hours actually
// worked vs the shift's total duration, then enforces the Mon/Fri (or
// whichever days are configured) pre-approval requirement for half-days.
async function classifyCheckoutStatus(orgId, workerId, attendanceDateStr, hoursWorked, settings, timings) {
  // Shift length comes from that date's schedule (Ramadan hours are shorter, so
  // a full Ramadan day must not be scored against the year-round shift length).
  const shiftMinutes = shiftDurationMinutes(timings || settings);
  const workedMinutes = (Number(hoursWorked) || 0) * 60;
  const percent = shiftMinutes > 0 ? (workedMinutes / shiftMinutes) * 100 : 100;
  const minPct = parseFloat(settings.halfDayMinPercent) || 40;
  const fullPct = parseFloat(settings.halfDayFullPercent) || 75;

  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  if (isWeekendDate(attendanceDateStr, weekendDays)) {
    if (percent >= fullPct) {
      return { status: 'present', note: 'Weekend overtime — full day.' };
    }
    if (percent < minPct) {
      return {
        status: 'absent',
        note: `Weekend — checked out after ${Number(hoursWorked).toFixed(2)}h (${percent.toFixed(0)}% of shift) — too short to count as overtime.`,
      };
    }
    return {
      status: 'half_day',
      note: `Weekend overtime — half day (${Number(hoursWorked).toFixed(2)}h, ${percent.toFixed(0)}% of shift).`,
    };
  }

  if (percent >= fullPct) return { status: 'present', note: null };

  if (percent < minPct) {
    return {
      status: 'absent',
      note: `Checked out after ${Number(hoursWorked).toFixed(2)}h (${percent.toFixed(0)}% of the shift) — below the half-day threshold.`,
    };
  }

  const dow = new Date(`${attendanceDateStr}T00:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
  const restrictedDays = Array.isArray(settings.halfDayRestrictedDays) ? settings.halfDayRestrictedDays : [1, 5];
  if (restrictedDays.includes(dow)) {
    const approved = await LeaveRequest.findOne({
      where: {
        workerId,
        orgId,
        status: 'approved',
        isHalfDay: true,
        fromDate: { [Op.lte]: attendanceDateStr },
        toDate: { [Op.gte]: attendanceDateStr },
      },
    });
    if (!approved) {
      return {
        status: 'absent',
        note: 'Half-day checkout on a restricted day without a pre-approved half-day leave request — recorded as an unauthorized absence.',
      };
    }
  }
  return {
    status: 'half_day',
    note: `Checked out after ${Number(hoursWorked).toFixed(2)}h (${percent.toFixed(0)}% of the shift).`,
  };
}

// Employee self-marks their own check-in, with the browser-reported coordinates
// captured at the moment of check-in. Coordinates are required by the route layer —
// an employee who declines location access cannot mark attendance.
//
// date/time are ALWAYS derived server-side from Asia/Karachi wall-clock time, never
// trusted from the client. A client-submitted date/time reflects the employee's
// browser/OS clock, which is wrong whenever they're on a VPN routed through another
// region (common here — some staff VPN into US hours to reach clients) or simply has
// its system clock off; attendance must stay pinned to Pakistan Standard Time regardless.
//
// Attendance day is noon→noon: a 3pm–12:30am shift is one day, not two calendar dates.
async function selfCheckIn(userId, orgId, { lat, lng }) {
  const worker = await Worker.findOne({
    where: { userId, orgId },
    include: [{
      model: User, as: 'user', attributes: ['id'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }],
  });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });
  if (isNonAttendanceRole(worker.user?.role?.key)) {
    throw Object.assign(new Error('Attendance marking does not apply to your role.'), { status: 403 });
  }

  const { date: localDate, time: checkIn } = nowInKarachi();
  const checkInDate = getAttendanceDate(localDate, checkIn);
  const settings = await getOrCreatePayrollSettings(orgId);
  // Lateness is judged against the timings in force on this attendance date, so
  // a seasonal schedule (e.g. Ramadan) applies automatically — or the
  // worker's own assigned policy, if they have one.
  const timings = await resolveShiftTimings(orgId, checkInDate, settings, worker);

  const openSession = await Attendance.findOne({
    where: {
      workerId: worker.id,
      checkIn: { [Op.ne]: null },
      checkOut: null,
    },
    order: [['date', 'DESC']],
  });
  if (openSession) {
    throw Object.assign(
      new Error(`You already checked in on ${openSession.date} at ${String(openSession.checkIn).slice(0, 5)}. Please check out first.`),
      { status: 409 }
    );
  }

  const existingDay = await Attendance.findOne({ where: { workerId: worker.id, date: checkInDate } });
  const isWeekendShift = isWeekendDate(checkInDate, settings.weekendDays);
  const lateness = isWeekendShift
    ? { isLate: false, lateMinutes: 0 }
    : computeLateness(checkIn, timings);
  const weekendNote = isWeekendShift ? 'Weekend overtime' : null;

  if (existingDay) {
    if (existingDay.checkIn) throw Object.assign(new Error('You have already checked in for this attendance day'), { status: 409 });
    await existingDay.update({
      checkIn,
      status: 'present',
      source: 'self',
      checkInLat: lat,
      checkInLng: lng,
      isLate: lateness.isLate,
      lateMinutes: lateness.lateMinutes,
      note: weekendNote || existingDay.note,
    });
    return existingDay;
  }

  return Attendance.create({
    orgId, workerId: worker.id, date: checkInDate, checkIn, status: 'present', source: 'self',
    checkInLat: lat, checkInLng: lng, isLate: lateness.isLate, lateMinutes: lateness.lateMinutes,
    note: weekendNote,
  });
}

// Employee self-marks their own check-out, computing worked hours from check-in.
// Looks up by noon→noon attendance date, then falls back to any open session.
async function selfCheckOut(userId, orgId, { lat, lng }) {
  const worker = await Worker.findOne({ where: { userId, orgId } });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  const { date: localDate, time: checkOut } = nowInKarachi();
  const attendanceDate = getAttendanceDate(localDate, checkOut);

  let record = await Attendance.findOne({
    where: {
      workerId: worker.id,
      date: attendanceDate,
      checkIn: { [Op.ne]: null },
      checkOut: null,
    },
  });
  if (!record) {
    record = await Attendance.findOne({
      where: {
        workerId: worker.id,
        checkIn: { [Op.ne]: null },
        checkOut: null,
      },
      order: [['date', 'DESC']],
    });
  }
  if (!record || !record.checkIn) {
    throw Object.assign(new Error('You must check in before checking out'), { status: 400 });
  }
  if (record.checkOut) throw Object.assign(new Error('You have already checked out'), { status: 409 });

  const hours = workedHours(record.checkIn, checkOut);
  const settings = await getOrCreatePayrollSettings(orgId);
  const timings = await resolveShiftTimings(orgId, record.date, settings, worker);
  const { status, note } = await classifyCheckoutStatus(orgId, worker.id, record.date, hours, settings, timings);
  await record.update({ checkOut, hours, checkOutLat: lat, checkOutLng: lng, status, note: note || record.note });
  return record;
}

// Resolves a stale open session (checked in on a previous attendance day,
// never checked out) using a time-of-day the employee supplies for that
// day's shift end, instead of "now" — selfCheckOut's `nowInKarachi()` stamp
// only makes sense for a session still open on today's attendance date.
// Everything else (hours, lateness-independent half-day/absent
// classification, restricted-day rules) reuses the exact same logic as a
// normal checkout, just anchored to the open session's own date.
async function selfCheckOutForOpenSession(userId, orgId, checkOutTime) {
  if (!/^\d{2}:\d{2}$/.test(String(checkOutTime || ''))) {
    throw Object.assign(new Error('Enter a valid check-out time.'), { status: 400 });
  }
  const worker = await Worker.findOne({ where: { userId, orgId } });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  const record = await Attendance.findOne({
    where: { workerId: worker.id, checkIn: { [Op.ne]: null }, checkOut: null },
    order: [['date', 'DESC']],
  });
  if (!record) throw Object.assign(new Error('No open check-in found.'), { status: 400 });

  const { date: todayDate, time: todayTime } = nowInKarachi();
  const todayAttendanceDate = getAttendanceDate(todayDate, todayTime);
  if (record.date === todayAttendanceDate) {
    throw Object.assign(new Error("Today's check-in isn't stale — use the regular check-out instead."), { status: 400 });
  }

  const hours = workedHours(record.checkIn, checkOutTime);
  const settings = await getOrCreatePayrollSettings(orgId);
  const timings = await resolveShiftTimings(orgId, record.date, settings, worker);
  const { status, note } = await classifyCheckoutStatus(orgId, worker.id, record.date, hours, settings, timings);
  await record.update({
    checkOut: checkOutTime,
    hours,
    status,
    note: note ? `${note} Checked out late (entered manually).` : 'Checked out late — time entered manually after the fact.',
  });
  return record;
}

async function getSelfAttendanceStatus(userId, orgId) {
  const worker = await Worker.findOne({
    where: { userId, orgId },
    include: [{
      model: User, as: 'user', attributes: ['id'],
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    }],
  });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  // `applicable: false` tells the frontend to hide the check-in widget and the
  // personal attendance history entirely, rather than showing an empty one.
  if (isNonAttendanceRole(worker.user?.role?.key)) {
    return { applicable: false, attendanceDate: null, cutoffHour: 12, record: null, openSession: null };
  }

  const { date: localDate, time: localTime } = nowInKarachi();
  const attendanceDate = getAttendanceDate(localDate, localTime);

  const openSession = await Attendance.findOne({
    where: {
      workerId: worker.id,
      checkIn: { [Op.ne]: null },
      checkOut: null,
    },
    order: [['date', 'DESC']],
  });

  const dayRecord = attendanceDate
    ? await Attendance.findOne({ where: { workerId: worker.id, date: attendanceDate } })
    : null;

  const [holiday, settings, timings] = await Promise.all([
    attendanceDate ? findHolidayFor(orgId, attendanceDate) : null,
    getOrCreatePayrollSettings(orgId),
    resolveShiftTimings(orgId, attendanceDate, null, worker),
  ]);
  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  const isWeekend = attendanceDate ? isWeekendDate(attendanceDate, weekendDays) : false;

  // Stale = an open session left over from an earlier attendance day, not
  // today's — the "forgot to check out" popup only fires for this, never for
  // a session still legitimately open on the current shift.
  const openSessionIsStale = !!(openSession && openSession.date !== attendanceDate);
  const openSessionShiftEnd = openSessionIsStale
    ? (await resolveShiftTimings(orgId, openSession.date, settings, worker)).shiftEndTime
    : null;

  return {
    applicable: true,
    attendanceDate,
    cutoffHour: 12,
    record: openSession || dayRecord,
    openSession: openSession || null,
    openSessionIsStale,
    // The shift-end time in force on the stale day itself (not today's) —
    // used only to pre-fill a suggested check-out time in the popup.
    openSessionSuggestedCheckOut: openSessionShiftEnd,
    // Surfaced so the widget can say "Today is a public holiday — Eid al-Fitr"
    // and show which shift timings are in force today.
    holiday: holiday ? { name: holiday.name, date: holiday.date, endDate: holiday.endDate } : null,
    weekend: isWeekend,
    weekendDays,
    shift: {
      startTime: timings.shiftStartTime,
      endTime: timings.shiftEndTime,
      graceMinutes: timings.lateGraceMinutes,
      scheduleLabel: timings.label,
    },
  };
}

// ─── Leave Requests ───────────────────────────────────────────────────────────

async function listLeaveRequests(orgId, { workerId, status } = {}) {
  const where = { orgId };
  if (workerId) where.workerId = workerId;
  if (status) where.status = status;
  return LeaveRequest.findAll({
    where,
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }],
    order: [['createdAt', 'DESC']],
  });
}

async function notifyHrManagers(orgId, { type, title, body, refTable, refId }) {
  try {
    const allOrgUsers = await User.findAll({
      where: { orgId },
      include: [{ model: Role, as: 'role' }],
    });
    const recipients = allOrgUsers.filter((u) =>
      ['super_admin', 'admin'].includes(u.role?.key)
      || u.role?.permissions?.['hr.manage']
      || u.role?.permissions?.['hr.read']
    );
    await Promise.all(recipients.map((u) =>
      NotificationService.notify(u.id, orgId, { type, title, body, refTable, refId })
    ));
  } catch (err) {
    console.error('[HrService] failed to notify HR managers:', err.message);
  }
}

async function createLeaveRequest(data, orgId) {
  return LeaveRequest.create({ ...data, orgId });
}

/** Normalize org weekend/off days to unique ints 0–6 (Sun–Sat). Default Sat+Sun. */
function normalizeWeekendDays(value) {
  const raw = Array.isArray(value) ? value : [0, 6];
  const days = [...new Set(raw.map((n) => parseInt(n, 10)).filter((n) => n >= 0 && n <= 6))];
  return days.length ? days : [0, 6];
}

function isWeekendDate(dateStr, weekendDays) {
  const day = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return normalizeWeekendDays(weekendDays).includes(dow);
}

/** Inclusive working days between dates; configured weekend/off days are skipped. */
function leaveDaysInclusive(fromDate, toDate, weekendDays = [0, 6]) {
  const off = new Set(normalizeWeekendDays(weekendDays));
  const a = new Date(`${String(fromDate).slice(0, 10)}T00:00:00Z`);
  const b = new Date(`${String(toDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return 0;
  let days = 0;
  for (let t = a.getTime(); t <= b.getTime(); t += 86400000) {
    if (!off.has(new Date(t).getUTCDay())) days += 1;
  }
  return days;
}

/** Remove auto-created weekend rows for dates that have not occurred yet. */
async function purgeFutureWeekendMarks(orgId) {
  const { date: todayKarachi } = nowInKarachi();
  try {
    await Attendance.destroy({
      where: {
        orgId,
        status: 'weekend',
        source: 'system',
        date: { [Op.gt]: todayKarachi },
      },
    });
  } catch (err) {
    console.error('[HrService] purgeFutureWeekendMarks skipped:', err.message);
  }
}

/** Create `weekend` attendance rows for configured off days in a date range (idempotent). */
async function ensureWeekendMarks(orgId, monthStart, monthEnd) {
  const settings = await getOrCreatePayrollSettings(orgId);
  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  const workerIds = await attendanceWorkerIds(orgId);
  if (!workerIds.length || !weekendDays.length) return;

  await purgeFutureWeekendMarks(orgId);

  const { date: todayKarachi } = nowInKarachi();
  const rangeStart = String(monthStart).slice(0, 10);
  const rangeEnd = String(monthEnd).slice(0, 10);
  const cappedEnd = rangeEnd > todayKarachi ? todayKarachi : rangeEnd;
  if (rangeStart > cappedEnd) return;

  const offDates = [];
  const start = new Date(`${rangeStart}T00:00:00Z`);
  const end = new Date(`${cappedEnd}T00:00:00Z`);
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    const d = new Date(t);
    if (weekendDays.includes(d.getUTCDay())) {
      offDates.push(d.toISOString().slice(0, 10));
    }
  }
  if (!offDates.length) return;

  const existing = await Attendance.findAll({
    where: {
      orgId,
      workerId: { [Op.in]: workerIds },
      date: { [Op.in]: offDates },
    },
    attributes: ['workerId', 'date'],
  });
  const have = new Set(existing.map((r) => `${r.workerId}|${r.date}`));
  const rows = [];
  for (const workerId of workerIds) {
    for (const date of offDates) {
      if (have.has(`${workerId}|${date}`)) continue;
      rows.push({
        orgId,
        workerId,
        date,
        status: 'weekend',
        source: 'system',
        note: 'Weekly off day',
      });
    }
  }
  // Insert only missing rows — never overwrite present/leave/holiday already marked.
  if (rows.length) {
    try {
      await Attendance.bulkCreate(rows, { ignoreDuplicates: true });
    } catch (err) {
      // Unique (worker_id, date) races shouldn't fail the attendance view.
      console.error('[HrService] ensureWeekendMarks skipped:', err.message);
    }
  }
}

const AUTO_ABSENT_NOTE = 'Auto-marked absent — no check-in recorded for shift (3:00 PM – 12:30 AM).';

/** True once the 3 AM Karachi sweep for this attendance date has passed. */
function isAbsentSweepDue(attendanceDate) {
  const day = String(attendanceDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const { date, time } = nowInKarachi();
  const hour = parseInt(String(time).split(':')[0], 10);
  const dayAfter = shiftCalendarDate(day, 1);
  if (date > dayAfter) return true;
  if (date === dayAfter && hour >= 3) return true;
  return false;
}

/**
 * After the overnight absent sweep (3 AM Karachi), stamp `absent` on every
 * attendance-marking worker who never checked in for that attendance date.
 * Skips weekends, holidays, approved leave, and anyone who already has a
 * check-in or a non-absence status row.
 */
async function markAbsentForUnmarkedWorkers(orgId, attendanceDate) {
  const day = String(attendanceDate).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { date: day, marked: 0, skipped: 0 };
  }

  const settings = await getOrCreatePayrollSettings(orgId);
  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  if (isWeekendDate(day, weekendDays)) {
    return { date: day, marked: 0, skipped: 0, reason: 'weekend' };
  }
  if (await findHolidayFor(orgId, day)) {
    return { date: day, marked: 0, skipped: 0, reason: 'holiday' };
  }

  const workerIds = await attendanceWorkerIds(orgId);
  if (!workerIds.length) return { date: day, marked: 0, skipped: 0 };

  const workers = await Worker.findAll({
    where: { orgId, id: { [Op.in]: workerIds }, status: 'active' },
    attributes: ['id', 'joiningDate'],
  });

  const existing = await Attendance.findAll({
    where: { orgId, workerId: { [Op.in]: workerIds }, date: day },
  });
  const byWorker = new Map(existing.map((a) => [a.workerId, a]));

  const leaves = await LeaveRequest.findAll({
    where: {
      orgId,
      workerId: { [Op.in]: workerIds },
      status: 'approved',
      fromDate: { [Op.lte]: day },
      toDate: { [Op.gte]: day },
    },
    attributes: ['workerId'],
  });
  const onLeave = new Set(leaves.map((l) => l.workerId));

  const toCreate = [];
  let marked = 0;
  let skipped = 0;

  for (const worker of workers) {
    const joined = worker.joiningDate ? String(worker.joiningDate).slice(0, 10) : null;
    if (joined && joined > day) {
      skipped += 1;
      continue;
    }
    if (onLeave.has(worker.id)) {
      skipped += 1;
      continue;
    }

    const row = byWorker.get(worker.id);
    if (row?.checkIn) {
      skipped += 1;
      continue;
    }
    if (row && ['leave', 'holiday', 'weekend', 'present', 'half_day'].includes(row.status)) {
      skipped += 1;
      continue;
    }
    if (row?.status === 'absent') {
      skipped += 1;
      continue;
    }

    if (row) {
      await row.update({
        status: 'absent',
        source: 'system',
        note: AUTO_ABSENT_NOTE,
        checkIn: null,
        checkOut: null,
        hours: null,
        isLate: false,
        lateMinutes: null,
        markedBy: null,
      });
      marked += 1;
    } else {
      toCreate.push({
        orgId,
        workerId: worker.id,
        date: day,
        status: 'absent',
        source: 'system',
        note: AUTO_ABSENT_NOTE,
      });
    }
  }

  if (toCreate.length) {
    try {
      await Attendance.bulkCreate(toCreate, { ignoreDuplicates: true });
      marked += toCreate.length;
    } catch (err) {
      console.error('[HrService] markAbsentForUnmarkedWorkers bulkCreate skipped:', err.message);
    }
  }

  return { date: day, marked, skipped };
}

async function findOverlappingLeave(workerId, orgId, fromDate, toDate, { excludeId = null, statuses = ['approved', 'requested'] } = {}) {
  const where = {
    workerId,
    orgId,
    status: { [Op.in]: statuses },
    fromDate: { [Op.lte]: String(toDate).slice(0, 10) },
    toDate: { [Op.gte]: String(fromDate).slice(0, 10) },
  };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return LeaveRequest.findOne({ where, order: [['fromDate', 'ASC']] });
}

async function createEmployeeLeaveRequest(userId, orgId, data) {
  const worker = await Worker.findOne({
    where: { userId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  const { type, fromDate, toDate, reason, isHalfDay } = data;
  if (!type || !fromDate || !toDate) {
    throw Object.assign(new Error('type, fromDate, and toDate are required.'), { status: 400 });
  }

  const from = String(fromDate).slice(0, 10);
  // A half-day request is always a single date — the point is to pre-approve
  // one restricted-day (e.g. Monday/Friday) half-day checkout, not a range.
  const to = isHalfDay ? from : String(toDate).slice(0, 10);
  const settings = await getOrCreatePayrollSettings(orgId);
  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  const days = isHalfDay ? 0.5 : leaveDaysInclusive(from, to, weekendDays);
  if (days <= 0) {
    throw Object.assign(new Error('Invalid leave date range. Weekly off days are not counted as leave days.'), { status: 400 });
  }

  const overlap = await findOverlappingLeave(worker.id, orgId, from, to);
  if (overlap) {
    throw Object.assign(
      new Error(
        `These dates overlap an existing ${overlap.status} leave (${overlap.fromDate} → ${overlap.toDate}). Choose different dates.`
      ),
      { status: 400 }
    );
  }

  const leave = await LeaveRequest.create({
    workerId: worker.id,
    orgId,
    type,
    fromDate: from,
    toDate: to,
    days,
    isHalfDay: !!isHalfDay,
    reason: reason || null,
    status: 'requested',
  });

  const employeeName = worker.user?.name || 'An employee';
  const typeLabel = String(type).replace(/_/g, ' ');

  await notifyHrManagers(orgId, {
    type: 'leave_requested',
    title: `Leave request from ${employeeName}`,
    body: `${employeeName} requested ${typeLabel} leave from ${fromDate} to ${toDate} (${days} day${days === 1 ? '' : 's'}).${reason ? ` Reason: ${reason}` : ''}`,
    refTable: 'leave_requests',
    refId: leave.id,
  });

  return leave;
}

/** Policy totals vs used/remaining for the current calendar year (employee self-service). */
async function getEmployeeLeaveBalance(userId, orgId) {
  const worker = await Worker.findOne({ where: { userId, orgId } });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  const settings = await getOrCreatePayrollSettings(orgId);
  const policy = {
    annual: 14,
    sick: 7,
    casual: 7,
    unpaid: 0,
    ...(settings.leavePolicyJson || {}),
  };

  const year = new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const leaves = await LeaveRequest.findAll({
    where: {
      workerId: worker.id,
      orgId,
      status: { [Op.in]: ['approved', 'requested'] },
      fromDate: { [Op.lte]: yearEnd },
      toDate: { [Op.gte]: yearStart },
    },
  });

  const types = ['annual', 'sick', 'casual', 'unpaid'];
  const rows = types.map((type) => {
    const total = Number(policy[type]) || 0;
    let used = 0;
    let pending = 0;
    for (const lr of leaves) {
      if (lr.type !== type) continue;
      const days = Number(lr.days) || leaveDaysInclusive(lr.fromDate, lr.toDate, settings.weekendDays);
      if (lr.status === 'approved') used += days;
      else if (lr.status === 'requested') pending += days;
    }
    const remaining = total > 0 ? Math.max(0, total - used) : null; // 0 allowance = unlimited / N/A
    return {
      type,
      label: type.charAt(0).toUpperCase() + type.slice(1),
      total,
      used,
      pending,
      remaining,
      unlimited: total <= 0,
    };
  });

  return { year, policy, rows, weekendDays: normalizeWeekendDays(settings.weekendDays) };
}

async function reviewLeave(id, { status, approverNote }, approverId, orgId) {
  const lr = await LeaveRequest.findOne({ where: { id, orgId } });
  if (!lr) throw Object.assign(new Error('Leave request not found'), { status: 404 });
  if (!['approved', 'rejected'].includes(status)) {
    throw Object.assign(new Error('Invalid status'), { status: 400 });
  }
  if (status === 'rejected' && !approverNote?.trim()) {
    throw Object.assign(new Error('A reason is required when rejecting a leave request.'), { status: 400 });
  }

  if (status === 'approved') {
    const overlap = await findOverlappingLeave(lr.workerId, orgId, lr.fromDate, lr.toDate, {
      excludeId: lr.id,
      statuses: ['approved'],
    });
    if (overlap) {
      throw Object.assign(
        new Error(
          `Cannot approve — dates overlap an already approved leave (${overlap.fromDate} → ${overlap.toDate}).`
        ),
        { status: 400 }
      );
    }
  }

  const worker = await Worker.findOne({
    where: { id: lr.workerId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  const employeeUser = worker?.user;

  await lr.update({ status, approverNote: approverNote?.trim() || null, approverId });

  // Let the employee know their leave was decided — in-app + email.
  if (employeeUser) {
    NotificationService.notify(employeeUser.id, orgId, {
      type: status === 'approved' ? 'leave_approved' : 'leave_rejected',
      title: `Leave request ${status}`,
      body: `Your leave from ${lr.fromDate} to ${lr.toDate} was ${status}.${approverNote ? ` Note: "${approverNote}"` : ''}`,
      refTable: 'leave_requests',
      refId: lr.id,
    }).catch((err) => {
      console.error('[HrService] leave in-app notification failed:', err.message);
    });

    if (employeeUser.email) {
      EmailService.sendLeaveUpdate({
        workerEmail: employeeUser.email,
        workerName: employeeUser.name,
        status,
        leaveType: lr.type,
        startDate: lr.fromDate,
        endDate: lr.toDate,
        days: lr.days,
        approverNote,
        appUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      }).catch((err) => {
        console.error('[HrService] leave email notification failed:', err.message);
      });
    } else {
      console.warn(`[HrService] leave ${status} for worker ${lr.workerId}: no employee email on file`);
    }
  } else {
    console.warn(`[HrService] leave ${status} for request ${lr.id}: linked worker/user not found`);
  }

  return lr.reload({
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    }],
  });
}

// ─── Payroll Settings ─────────────────────────────────────────────────────────

async function getOrCreatePayrollSettings(orgId) {
  const [settings] = await PayrollSettings.findOrCreate({
    where: { orgId },
    defaults: { orgId },
  });
  return settings;
}

async function getActiveTaxSlabs(orgId) {
  const year = await TaxYear.findOne({
    where: { orgId, isActive: true },
    // Deactivated brackets must not be applied to new payroll runs.
    include: [{ model: TaxSlab, as: 'slabs', where: { isActive: true }, required: false }],
  });
  if (!year) return [];
  const slabs = [...(year.slabs || [])].sort(
    (a, b) => (a.sortOrder - b.sortOrder) || (Number(a.minAmount) - Number(b.minAmount)),
  );
  return slabs;
}

// Resolves the TaxYear that actually COVERS a given payroll period ('YYYY-MM'),
// not just whichever one is flagged isActive — a run for a past/back-dated
// period must be taxed against the slabs that were in force then, and the
// cumulative-YTD method (Section 7) needs that year's July-start/June-end
// boundary to compute remaining months. Falls back to the isActive year if no
// dated year covers the period (e.g. before any TaxYear rows were dated in).
async function getTaxYearForPeriod(orgId, period) {
  const periodStart = `${period}-01`;
  let year = await TaxYear.findOne({
    where: {
      orgId,
      startDate: { [Op.lte]: periodStart },
      endDate: { [Op.gte]: periodStart },
    },
    include: [{ model: TaxSlab, as: 'slabs', where: { isActive: true }, required: false }],
  });
  if (!year) {
    year = await TaxYear.findOne({
      where: { orgId, isActive: true },
      include: [{ model: TaxSlab, as: 'slabs', where: { isActive: true }, required: false }],
    });
  }
  if (!year) return null;
  const slabs = [...(year.slabs || [])].sort(
    (a, b) => (a.sortOrder - b.sortOrder) || (Number(a.minAmount) - Number(b.minAmount)),
  );
  return { id: year.id, startDate: year.startDate, endDate: year.endDate, slabs };
}

// Sums this worker's ACTUAL monthly-taxable and tax-withheld from every prior
// month of the given tax year (July..m-1) — read back from PayrollItem rows
// already calculated, across whichever PayrollRuns those months belong to.
// This is what makes computeCumulativeTax self-correct for overtime, absence,
// and mid-year raises: it re-sums real history every time rather than trusting
// a running total that could drift out of sync with edits/rectifications.
async function getWorkerYtdPriorTax(workerId, orgId, taxYearStartDate, beforePeriod) {
  const items = await PayrollItem.findAll({
    where: { workerId },
    include: [{
      model: PayrollRun,
      as: 'run',
      where: {
        orgId,
        period: { [Op.gte]: taxYearStartDate.slice(0, 7), [Op.lt]: beforePeriod },
      },
      attributes: ['period'],
      required: true,
    }],
    attributes: ['monthlyTaxable', 'taxAmount'],
  });
  const taxableYTDPrior = items.reduce((sum, i) => sum + (Number(i.monthlyTaxable) || 0), 0);
  const taxDeductedYTDPrior = items.reduce((sum, i) => sum + (Number(i.taxAmount) || 0), 0);
  return { taxableYTDPrior, taxDeductedYTDPrior };
}

async function listTaxYears(orgId, { includeInactive = false } = {}) {
  return TaxYear.findAll({
    where: { orgId, ...(includeInactive ? {} : { isArchived: false }) },
    include: [
      {
        model: TaxSlab,
        as: 'slabs',
        ...(includeInactive ? {} : { where: { isActive: true }, required: false }),
      },
      { model: TaxYear, as: 'sourceTaxYear', attributes: ['id', 'label'], required: false },
    ],
    order: [['startDate', 'DESC']],
  });
}

async function createTaxYear(orgId, data) {
  const label = String(data.label || '').trim();
  if (!label) throw Object.assign(new Error('Label is required (e.g. 2025-26).'), { status: 400 });
  if (!data.startDate || !data.endDate) {
    throw Object.assign(new Error('startDate and endDate are required.'), { status: 400 });
  }
  const year = await TaxYear.create({
    orgId,
    label,
    startDate: data.startDate,
    endDate: data.endDate,
    isActive: false,
  });
  if (data.activate) await activateTaxYear(year.id, orgId);
  return TaxYear.findByPk(year.id, { include: [{ model: TaxSlab, as: 'slabs' }] });
}

async function updateTaxYear(id, orgId, updates) {
  const year = await TaxYear.findOne({ where: { id, orgId } });
  if (!year) throw Object.assign(new Error('Tax year not found'), { status: 404 });
  assertTaxYearMutable(year, 'its label/dates are');
  const patch = {};
  if (updates.label !== undefined) patch.label = String(updates.label).trim();
  if (updates.startDate !== undefined) patch.startDate = updates.startDate;
  if (updates.endDate !== undefined) patch.endDate = updates.endDate;
  await year.update(patch);
  return TaxYear.findByPk(year.id, { include: [{ model: TaxSlab, as: 'slabs' }] });
}

async function activateTaxYear(id, orgId) {
  const year = await TaxYear.findOne({ where: { id, orgId } });
  if (!year) throw Object.assign(new Error('Tax year not found'), { status: 404 });
  await TaxYear.update({ isActive: false }, { where: { orgId, isActive: true } });
  await year.update({ isActive: true });
  return TaxYear.findByPk(year.id, { include: [{ model: TaxSlab, as: 'slabs' }] });
}

// Archives rather than destroys — see services/SoftDeleteService.js. Past payroll
// runs were computed from these brackets, so the slabs have to stay readable.
async function deleteTaxYear(id, orgId, archived = true) {
  const year = await TaxYear.findOne({ where: { id, orgId } });
  if (!year) throw Object.assign(new Error('Tax year not found'), { status: 404 });
  if (archived && year.isActive) {
    throw Object.assign(
      new Error('This is the active tax year — activate another year before archiving it.'),
      { status: 409 },
    );
  }
  await year.update({ isArchived: archived });
  return { message: archived ? 'Tax year archived' : 'Tax year restored', taxYear: year };
}

// Clones a tax year's dates and label plus every slab (active or not) so a new
// fiscal year can start from last year's brackets instead of re-entering them.
async function duplicateTaxYear(id, orgId) {
  const year = await TaxYear.findOne({
    where: { id, orgId },
    include: [{ model: TaxSlab, as: 'slabs' }],
  });
  if (!year) throw Object.assign(new Error('Tax year not found'), { status: 404 });

  const copy = await TaxYear.create({
    orgId,
    label: `${year.label} (copy)`,
    startDate: year.startDate,
    endDate: year.endDate,
    isActive: false,
    sourceTaxYearId: year.id,
  });

  const slabs = year.slabs || [];
  if (slabs.length) {
    await TaxSlab.bulkCreate(slabs.map((s) => ({
      taxYearId: copy.id,
      minAmount: s.minAmount,
      maxAmount: s.maxAmount,
      ratePercent: s.ratePercent,
      fixedAmount: s.fixedAmount,
      sortOrder: s.sortOrder,
      isActive: s.isActive,
    })));
  }

  return TaxYear.findByPk(copy.id, {
    include: [
      { model: TaxSlab, as: 'slabs' },
      { model: TaxYear, as: 'sourceTaxYear', attributes: ['id', 'label'], required: false },
    ],
  });
}

async function assertTaxYearAccess(taxYearId, orgId) {
  const year = await TaxYear.findOne({ where: { id: taxYearId, orgId } });
  if (!year) throw Object.assign(new Error('Tax year not found'), { status: 404 });
  return year;
}

// Once a tax year is the active one, payroll is live-calculating against it —
// editing its label/dates or slabs out from under a running payroll cycle
// would silently change already-processed math. Everything unlocks again once
// a different year is activated (this one is no longer live), but stays
// locked while active — including duplicates, which are only ever created
// inactive so they're editable up until the moment they're activated.
function assertTaxYearMutable(year, whatIsLocked = 'it') {
  if (year.isActive) {
    throw Object.assign(
      new Error(`This tax year is active — ${whatIsLocked} locked. Activate another year first, or edit a different (inactive) tax year.`),
      { status: 409 },
    );
  }
}

async function createTaxSlab(taxYearId, orgId, data) {
  const year = await assertTaxYearAccess(taxYearId, orgId);
  assertTaxYearMutable(year, 'its slabs are');
  const minAmount = parseFloat(data.minAmount);
  if (Number.isNaN(minAmount) || minAmount < 0) {
    throw Object.assign(new Error('minAmount must be a non-negative number.'), { status: 400 });
  }
  let maxAmount = null;
  if (data.maxAmount !== undefined && data.maxAmount !== null && data.maxAmount !== '') {
    maxAmount = parseFloat(data.maxAmount);
    if (Number.isNaN(maxAmount) || maxAmount < minAmount) {
      throw Object.assign(new Error('maxAmount must be >= minAmount.'), { status: 400 });
    }
  }
  const maxSort = await TaxSlab.max('sortOrder', { where: { taxYearId } });
  return TaxSlab.create({
    taxYearId,
    minAmount,
    maxAmount,
    ratePercent: parseFloat(data.ratePercent) || 0,
    fixedAmount: parseFloat(data.fixedAmount) || 0,
    sortOrder: data.sortOrder != null ? parseInt(data.sortOrder, 10) : (Number.isFinite(maxSort) ? maxSort + 1 : 0),
  });
}

async function updateTaxSlab(id, orgId, updates) {
  const slab = await TaxSlab.findOne({
    where: { id },
    include: [{ model: TaxYear, as: 'taxYear', where: { orgId }, attributes: ['id', 'isActive'] }],
  });
  if (!slab) throw Object.assign(new Error('Tax slab not found'), { status: 404 });
  assertTaxYearMutable(slab.taxYear, 'its slabs are');
  const patch = {};
  if (updates.minAmount !== undefined) patch.minAmount = parseFloat(updates.minAmount);
  if (updates.maxAmount !== undefined) {
    patch.maxAmount = (updates.maxAmount === null || updates.maxAmount === '')
      ? null
      : parseFloat(updates.maxAmount);
  }
  if (updates.ratePercent !== undefined) patch.ratePercent = parseFloat(updates.ratePercent) || 0;
  if (updates.fixedAmount !== undefined) patch.fixedAmount = parseFloat(updates.fixedAmount) || 0;
  if (updates.sortOrder !== undefined) patch.sortOrder = parseInt(updates.sortOrder, 10) || 0;
  await slab.update(patch);
  return slab;
}

// Deactivates rather than destroys — see services/SoftDeleteService.js.
async function deleteTaxSlab(id, orgId, active = false) {
  const slab = await TaxSlab.findOne({
    where: { id },
    include: [{ model: TaxYear, as: 'taxYear', where: { orgId }, attributes: ['id', 'isActive'] }],
  });
  if (!slab) throw Object.assign(new Error('Tax slab not found'), { status: 404 });
  assertTaxYearMutable(slab.taxYear, 'its slabs are');
  await slab.update({ isActive: active });
  return { message: active ? 'Tax slab set to Active' : 'Tax slab set to Inactive', slab };
}

async function updatePayrollSettings(orgId, updates) {
  const settings = await getOrCreatePayrollSettings(orgId);
  const patch = { ...updates };
  if (patch.weekendDays !== undefined) {
    patch.weekendDays = normalizeWeekendDays(patch.weekendDays);
  }
  return settings.update(patch);
}

// ─── Salary Beneficiaries (salary split) ───────────────────────────────────────

async function getSalaryBeneficiaries(workerId, orgId) {
  const worker = await Worker.findOne({ where: { id: workerId, orgId } });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });
  return SalaryBeneficiary.findAll({
    where: { workerId, orgId, isActive: true },
    order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
  });
}

// Full-list replace: soft-deletes rows no longer present (per this app's
// no-hard-delete convention — see softDeletable.js), upserts the rest. The
// worker's own net pay isn't validated to the last cent here (computedNet
// isn't known until a payroll run actually calculates it) — over-allocation
// is instead caught per-run by computeDisbursementSplit when the split is
// frozen at lock time. This only rejects shapes that can never be valid.
async function setSalaryBeneficiaries(workerId, orgId, beneficiaries = []) {
  const worker = await Worker.findOne({ where: { id: workerId, orgId } });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });

  const list = Array.isArray(beneficiaries) ? beneficiaries : [];
  for (const b of list) {
    if (!b.name || !String(b.name).trim()) {
      throw Object.assign(new Error('Every beneficiary needs a name'), { status: 400 });
    }
    if (!['percentage', 'fixed'].includes(b.splitType)) {
      throw Object.assign(new Error('splitType must be "percentage" or "fixed"'), { status: 400 });
    }
    const value = parseFloat(b.splitValue);
    if (!Number.isFinite(value) || value < 0) {
      throw Object.assign(new Error('splitValue must be a non-negative number'), { status: 400 });
    }
    if (b.splitType === 'percentage' && value > 100) {
      throw Object.assign(new Error('A single beneficiary cannot exceed 100%'), { status: 400 });
    }
  }
  const percentTotal = list
    .filter((b) => b.splitType === 'percentage')
    .reduce((sum, b) => sum + (parseFloat(b.splitValue) || 0), 0);
  if (percentTotal > 100) {
    throw Object.assign(new Error(`Beneficiary percentages sum to ${percentTotal}%, over 100%`), { status: 400 });
  }

  return db.sequelize.transaction(async (t) => {
    const existing = await SalaryBeneficiary.findAll({ where: { workerId, orgId }, transaction: t });
    const keepIds = new Set(list.filter((b) => b.id).map((b) => b.id));
    const toRetire = existing.filter((row) => !keepIds.has(row.id));
    if (toRetire.length) {
      await SalaryBeneficiary.update(
        { isActive: false },
        { where: { id: toRetire.map((r) => r.id) }, transaction: t },
      );
    }

    const results = [];
    for (let i = 0; i < list.length; i += 1) {
      const b = list[i];
      const payload = {
        orgId,
        workerId,
        name: String(b.name).trim(),
        relation: b.relation || null,
        splitType: b.splitType,
        splitValue: parseFloat(b.splitValue) || 0,
        bankName: b.bankName || null,
        bankBranchName: b.bankBranchName || null,
        bankAccountTitle: b.bankAccountTitle || null,
        bankAccountNumber: b.bankAccountNumber || null,
        iban: b.iban || null,
        sortOrder: i,
        isActive: true,
      };
      if (b.id) {
        const row = existing.find((r) => r.id === b.id);
        if (row) {
          await row.update(payload, { transaction: t });
          results.push(row);
          continue;
        }
      }
      results.push(await SalaryBeneficiary.create(payload, { transaction: t }));
    }
    return results;
  });
}

// ─── Payroll Runs ─────────────────────────────────────────────────────────────

async function listPayrollRuns(orgId) {
  return PayrollRun.findAll({
    where: { orgId },
    order: [['createdAt', 'DESC']],
  });
}

function normalizeWorkingDays(value, fallback = 26) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 31) {
    throw Object.assign(new Error('Working days must be a whole number between 1 and 31.'), { status: 400 });
  }
  return n;
}

async function createPayrollRun(period, orgId, createdBy, { workingDaysPerMonth, includeOvertime, deductAttendance } = {}) {
  const existing = await PayrollRun.findOne({ where: { orgId, period } });
  if (existing) throw Object.assign(new Error(`Payroll run for ${period} already exists`), { status: 409 });
  const settings = await getOrCreatePayrollSettings(orgId);
  const defaultDays = parseInt(settings.workingDaysPerMonth, 10) || 26;
  const wdpm = workingDaysPerMonth != null && workingDaysPerMonth !== ''
    ? normalizeWorkingDays(workingDaysPerMonth, defaultDays)
    : defaultDays;
  return PayrollRun.create({
    orgId, period, createdBy, workingDaysPerMonth: wdpm,
    includeOvertime: includeOvertime !== false,
    deductAttendance: deductAttendance !== false,
  });
}

async function updatePayrollRun(id, orgId, updates = {}) {
  const run = await PayrollRun.findOne({ where: { id, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  if (!['draft', 'open_for_review'].includes(run.status)) {
    throw Object.assign(new Error('Working days can only be changed while the run is draft or open for review.'), { status: 400 });
  }
  const patch = {};
  if (updates.workingDaysPerMonth != null && updates.workingDaysPerMonth !== '') {
    patch.workingDaysPerMonth = normalizeWorkingDays(updates.workingDaysPerMonth);
  }
  if (updates.includeOvertime != null) {
    patch.includeOvertime = !!updates.includeOvertime;
  }
  if (updates.deductAttendance != null) {
    patch.deductAttendance = !!updates.deductAttendance;
  }
  if (Object.keys(patch).length === 0) {
    throw Object.assign(new Error('No valid fields to update.'), { status: 400 });
  }
  await run.update(patch);
  return run;
}

// Temporary: lets HR delete a payroll run outright while QA-ing the workflow.
// Not the app's usual soft-delete pattern — remove this once testing is done.
async function deletePayrollRun(id, orgId) {
  const run = await PayrollRun.findOne({ where: { id, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  const items = await PayrollItem.findAll({ where: { payrollRunId: id }, attributes: ['id'] });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await SalarySlip.destroy({ where: { payrollItemId: itemIds } });
    await PayrollItem.destroy({ where: { id: itemIds } });
  }
  await run.destroy();
  return { success: true };
}

// Converts every N late arrivals in the payroll month (settings.lateOccurrencesPerDeduction)
// into 1 day deducted from the worker's leave balance (settings.latePenaltyLeaveType,
// 'casual' by default) — unpaid only for whatever the remaining balance can't cover.
// Idempotent: re-running calculatePayrollItems for the same run/month updates the same
// tagged LeaveRequest instead of stacking a new one each time.
async function applyLatePenalty(orgId, worker, period, lateCount, penaltyDays, settings) {
  const marker = `[late-penalty:${period}]`;
  const leaveType = settings.latePenaltyLeaveType || 'casual';
  const year = period.split('-')[0];
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  const existingPenalty = await LeaveRequest.findOne({
    where: { workerId: worker.id, orgId, reason: { [Op.like]: `${marker}%` } },
  });

  if (penaltyDays <= 0) {
    if (existingPenalty) await existingPenalty.destroy();
    return { coveredDays: 0, unpaidDays: 0 };
  }

  const policy = { annual: 14, sick: 7, casual: 7, unpaid: 0, ...(settings.leavePolicyJson || {}) };
  const totalAllotment = Number(policy[leaveType]) || 0;

  const otherApproved = await LeaveRequest.findAll({
    where: {
      workerId: worker.id, orgId, type: leaveType, status: 'approved',
      fromDate: { [Op.lte]: yearEnd }, toDate: { [Op.gte]: yearStart },
      ...(existingPenalty ? { id: { [Op.ne]: existingPenalty.id } } : {}),
    },
    attributes: ['days'],
  });
  const usedByOthers = otherApproved.reduce((sum, lr) => sum + (Number(lr.days) || 0), 0);
  const remaining = totalAllotment > 0 ? Math.max(0, totalAllotment - usedByOthers) : Infinity;
  const coveredDays = Math.min(penaltyDays, remaining);
  const unpaidDays = Math.round((penaltyDays - coveredDays) * 10) / 10;

  const periodEnd = `${period}-${String(new Date(parseInt(period.split('-')[0], 10), parseInt(period.split('-')[1], 10), 0).getDate()).padStart(2, '0')}`;
  const reason = `${marker} ${lateCount} late arrival(s) this month converted to ${penaltyDays} day(s); `
    + (unpaidDays > 0 ? `${unpaidDays} unpaid (leave balance exhausted).` : 'fully covered by leave balance.');

  if (coveredDays > 0) {
    if (existingPenalty) {
      await existingPenalty.update({ days: coveredDays, reason, type: leaveType, fromDate: periodEnd, toDate: periodEnd, status: 'approved' });
    } else {
      await LeaveRequest.create({
        workerId: worker.id, orgId, type: leaveType,
        fromDate: periodEnd, toDate: periodEnd, days: coveredDays,
        reason, status: 'approved',
      });
    }
  } else if (existingPenalty) {
    await existingPenalty.destroy();
  }

  return { coveredDays, unpaidDays };
}

// Auto-calculate payroll items from attendance data.
// Pay formula (with half-day + late policies):
//   payableDays = present + paid leave + public holidays
//               + halfDays × (1 − halfDayFactor)   // e.g. 0.5 credit per half day
//               − unpaid late penalty days          // e.g. 3 lates → 1 day (if no leave left)
//   attendancePay = (monthlySalary / workingDays) × payableDays
//   gross = attendancePay + overtime
//   net = gross − tax
const PAYROLL_ADDITION_META_KEYS = new Set([
  'payableDays', 'workingDays', 'perDayRate', 'monthlySalary',
  'halfDayCredit', 'holidayDays', 'weekendDays', 'formula', 'daysInMonth', 'nonTaxableComponents',
]);

function sumPayrollMoneyAdditions(additions = {}) {
  return Object.entries(additions).reduce((sum, [key, value]) => {
    if (PAYROLL_ADDITION_META_KEYS.has(key)) return sum;
    const n = parseFloat(value);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

function sumPayrollDeductions(deductions = {}) {
  return Object.values(deductions).reduce((sum, value) => {
    const n = parseFloat(value);
    return sum + (Number.isFinite(n) ? n : 0);
  }, 0);
}

/** Gross: attendance-based runs use additions.attendancePay (+ OT etc.); legacy uses base + additions. */
function computePayrollGross(base, additions = {}) {
  const moneyAdd = sumPayrollMoneyAdditions(additions);
  if (additions.attendancePay != null && additions.attendancePay !== '') {
    return Math.round(moneyAdd * 100) / 100;
  }
  return Math.round((parseFloat(base || 0) + moneyAdd) * 100) / 100;
}

async function calculatePayrollItems(runId, orgId, { workingDaysPerMonth } = {}) {
  const run = await PayrollRun.findOne({ where: { id: runId, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  if (!['draft', 'open_for_review'].includes(run.status)) {
    throw Object.assign(new Error('Can only calculate items for draft or open_for_review runs'), { status: 400 });
  }

  const settings = await getOrCreatePayrollSettings(orgId);
  // workingDaysPerMonth is still recorded on the run (kept for backward
  // compatibility / any non-salaried pay models), but salaried earned-amount
  // proration below always uses full calendar days (D) per the payroll tax
  // spec — never wdpm. See utils/payrollCalc.js.
  if (workingDaysPerMonth != null && workingDaysPerMonth !== '') {
    const wd = normalizeWorkingDays(workingDaysPerMonth);
    await run.update({ workingDaysPerMonth: wd });
  }
  const hoursPerDay = parseFloat(settings.workingHoursPerDay) || 8;
  const otMultiplier = parseFloat(settings.otMultiplier) || 1.5;
  const halfDayFactor = parseFloat(settings.halfDayDeductionFactor) || 0.5;
  const medicalExemptionCapPercent = settings.medicalExemptionCapPercent != null
    ? parseFloat(settings.medicalExemptionCapPercent) : 10;
  const taxYear = await getTaxYearForPeriod(orgId, run.period);
  const taxSlabs = taxYear?.slabs || [];

  const [year, month] = run.period.split('-');
  const monthStart = `${year}-${month}-01`;
  const daysInMonth = daysInCalendarMonth(parseInt(year, 10), parseInt(month, 10));
  const monthEnd = `${year}-${month}-${String(daysInMonth).padStart(2, '0')}`;
  const weekendDays = normalizeWeekendDays(settings.weekendDays);
  await ensureWeekendMarks(orgId, monthStart, monthEnd);
  await ensureHolidayMarks(orgId, monthStart, monthEnd);

  // Active this month, or inactive but employed for at least part of it — a
  // mid-month leaver's final prorated payroll is still owed even after HR
  // has already flipped their status to inactive.
  const workers = await Worker.findAll({
    where: {
      orgId,
      workerType: 'employee',
      [Op.or]: [
        { status: 'active' },
        { status: 'inactive', leavingDate: { [Op.gte]: monthStart, [Op.lte]: monthEnd } },
      ],
    },
  });

  // Per-worker, per-run override of the deductAttendance policy (set via the
  // Actions column on the Payroll Items table) — null/undefined means "follow
  // the run's global toggle", true/false pins this one worker for this run
  // only. Fetched once, in bulk, rather than per worker.
  const existingItems = await PayrollItem.findAll({
    where: { payrollRunId: runId },
    attributes: ['workerId', 'deductAttendanceOverride'],
  });
  const overrideByWorkerId = new Map(existingItems.map((i) => [i.workerId, i.deductAttendanceOverride]));

  // Active salary-split beneficiaries, fetched once in bulk and grouped by
  // worker — needed here (not just at lock/slip time) because a percentage-
  // only split changes how much tax is actually withheld this month. See
  // computeSplitPayrollTax.
  const allBeneficiaries = await SalaryBeneficiary.findAll({
    where: { orgId, isActive: true },
    order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
  });
  const beneficiariesByWorkerId = new Map();
  for (const b of allBeneficiaries) {
    if (!beneficiariesByWorkerId.has(b.workerId)) beneficiariesByWorkerId.set(b.workerId, []);
    beneficiariesByWorkerId.get(b.workerId).push(b);
  }

  const results = [];
  for (const worker of workers) {
    if (!worker.salaryBase) continue;

    const joinDate = worker.joiningDate ? String(worker.joiningDate).slice(0, 10) : null;
    const leaveDate = worker.leavingDate ? String(worker.leavingDate).slice(0, 10) : null;
    const range = activeRangeForMonth({
      periodStart: monthStart, periodEnd: monthEnd, joinDate, leaveDate,
    });
    if (!range) continue; // not employed at all during this period

    const attendances = await Attendance.findAll({
      where: { workerId: worker.id, date: { [Op.between]: [range.start, range.end] } },
    });

    const presentDays = attendances.filter((a) => a.status === 'present').length;
    const markedAbsent = attendances.filter((a) => a.status === 'absent').length;
    const leaveDays = attendances.filter((a) => a.status === 'leave').length;
    const halfDays = attendances.filter((a) => a.status === 'half_day').length;
    const holidayDays = attendances.filter((a) => a.status === 'holiday').length;
    // Named distinctly from the outer `weekendDays` (the org's configured
    // off-days array, e.g. [0,6]) — reusing that name here would shadow it
    // for the rest of this loop iteration and silently break isWeekendDate()
    // for orgs with a non-default weekend configuration.
    const weekendMarkedDays = attendances.filter((a) => a.status === 'weekend').length;
    const markedDates = new Set(attendances.map((a) => String(a.date).slice(0, 10)));

    // Any day in this worker's active range with no attendance row at all,
    // that isn't a weekend/holiday, is inferred unpaid-absent — nobody marked
    // it worked. Weekends/holidays are simply part of D and never deducted.
    let unmarkedAbsentDays = 0;
    for (
      let t = new Date(`${range.start}T00:00:00Z`).getTime();
      t <= new Date(`${range.end}T00:00:00Z`).getTime();
      t += 86400000
    ) {
      const dateStr = new Date(t).toISOString().slice(0, 10);
      if (markedDates.has(dateStr)) continue;
      if (isWeekendDate(dateStr, weekendDays)) continue;
      unmarkedAbsentDays += 1;
    }
    const absentDays = markedAbsent + unmarkedAbsentDays;

    const overtimeHours = attendances.reduce((sum, a) => {
      const hrs = parseFloat(a.hours) || 0;
      if (!hrs || !a.checkIn) return sum;
      const dateStr = String(a.date).slice(0, 10);
      if (isWeekendDate(dateStr, weekendDays) && ['present', 'half_day'].includes(a.status)) {
        return sum + hrs;
      }
      if (a.status === 'present' && hrs > hoursPerDay) {
        return sum + Math.max(0, hrs - hoursPerDay);
      }
      return sum;
    }, 0);

    // Every N late arrivals this month → 1 day penalty; unpaid only when leave balance can't cover.
    const lateCount = attendances.filter((a) => a.isLate).length;
    const latePenaltyPerN = parseInt(settings.lateOccurrencesPerDeduction, 10) || 3;
    const latePenaltyDays = Math.floor(lateCount / latePenaltyPerN);
    const { unpaidDays: latePenaltyUnpaidDays } = await applyLatePenalty(orgId, worker, run.period, lateCount, latePenaltyDays, settings);

    // Section 3-4: paid leave = present (no deduction); unpaid absence, the
    // unworked half of a half-day, and late-penalty days reduce pay.
    // Deduction is skipped entirely (attendance/late counts are still
    // recorded/shown as normal, only the pay impact is zeroed) when:
    //   1. worker.noAttendanceDeduction is set — a permanent, every-run
    //      exemption HR sets once on the employee's profile, or
    //   2. this specific worker has a per-run override for this run (set from
    //      the Actions column on Payroll Items) that resolves to false, or
    //   3. no per-run override exists and the run's own deductAttendance
    //      toggle is off.
    // The per-run override (if any) always wins over the run-level toggle —
    // it's a deliberate one-off exception for this one employee this month.
    const perRunOverride = overrideByWorkerId.get(worker.id);
    const runWantsDeduction = perRunOverride != null ? perRunOverride : run.deductAttendance !== false;
    const skipAttendanceDeduction = !runWantsDeduction || !!worker.noAttendanceDeduction;
    const unpaidAbsentDays = skipAttendanceDeduction ? 0 : Math.round(
      (absentDays + halfDays * halfDayFactor + Number(latePenaltyUnpaidDays || 0)) * 1000,
    ) / 1000;

    const { payableDays } = computePayableDays({
      daysInMonth,
      periodStart: monthStart,
      periodEnd: monthEnd,
      joinDate,
      leaveDate,
      unpaidAbsentDays,
    });

    // Section 2: Basic (worker.salaryBase) + Medical (exempt up to the
    // config cap — never hard-coded, tracks the Finance Act via PayrollSettings).
    const monthlySalary = parseFloat(worker.salaryBase);
    const structure = computeSalaryStructure({
      basic: monthlySalary,
      medicalAllowance: worker.medicalAllowance,
      medicalExemptionCapPercent,
    });

    const perDayRate = monthlySalary / daysInMonth;
    const overtimePay = overtimeHours > 0 && run.includeOvertime
      ? Math.round((perDayRate / hoursPerDay) * overtimeHours * otMultiplier * 100) / 100
      : 0;

    // Section 5: earned amounts this month (calendar-day proration).
    const earned = computeEarnedAmounts({
      basic: structure.basic,
      medical: structure.medical,
      taxableMedicalExcess: structure.taxableMedicalExcess,
      payableDays,
      daysInMonth,
      overtimeAmount: overtimePay,
    });

    // Extra components beyond Basic/Medical (HRA, Conveyance, etc.) — each
    // independently flagged taxable or non-taxable by HR on the Salary tab.
    const components = computeSalaryComponents({
      components: worker.salaryComponents,
      payableDays,
      daysInMonth,
    });

    // Section 6: taxable salary this month (Medical up to the cap excluded;
    // overtime, any medical excess above the cap, and taxable components included).
    const monthlyTaxable = computeMonthlyTaxable({
      earnedBasic: earned.earnedBasic,
      overtime: earned.overtime,
      earnedTaxableMedicalExcess: earned.earnedTaxableMedicalExcess,
      otherTaxableAllowance: components.earnedTaxableTotal,
    });

    const additions = {
      attendancePay: earned.earnedBasic,
      medical: earned.earnedMedical,
      payableDays,
      daysInMonth,
      perDayRate: Math.round(perDayRate * 100) / 100,
      monthlySalary,
      halfDayCredit: Math.round(halfDays * (1 - halfDayFactor) * 1000) / 1000,
      holidayDays,
      weekendDays: weekendMarkedDays,
      formula: `(${monthlySalary} / ${daysInMonth}) × ${payableDays}`,
    };
    if (earned.overtime > 0) additions.overtime = earned.overtime;
    const nonTaxableComponentNames = [];
    for (const row of components.rows) {
      additions[row.name] = row.earned;
      if (!row.taxable) nonTaxableComponentNames.push(row.name);
    }
    if (nonTaxableComponentNames.length) additions.nonTaxableComponents = nonTaxableComponentNames;

    const computedGross = computePayrollGross(earned.earnedBasic, additions);

    // Section 7: cumulative YTD tax — annualize off the ACTUAL YTD taxable sum
    // plus the projected remaining full months at the worker's CURRENT Basic.
    // Never a flat ×12 (that's the over-taxed-mid-year-joiner bug, Section 8).
    //
    // A worker who has already left by this run's period (leavingDate on or
    // before monthEnd) has no more future income to project — passing 0
    // collapses projectedAnnualTaxable down to exactly taxableYTD (what they
    // actually earned this tax year), which is also then exactly what
    // annualTax/taxDueYTD reconcile against. Without this, a leaver's final
    // slip would project a full remaining year of salary they'll never
    // actually earn, wildly inflating "Projected Annual Taxable"/"Projected
    // Annual Tax" on their last payslip.
    const hasLeftByThisMonth = !!(leaveDate && leaveDate <= monthEnd);
    let taxThisMonth = 0;
    let taxCalc = null;
    let splitTaxBreakdown = null;
    if (taxYear && taxSlabs.length && !worker.taxExempt) {
      const { taxableYTDPrior, taxDeductedYTDPrior } = await getWorkerYtdPriorTax(
        worker.id, orgId, String(taxYear.startDate), run.period,
      );
      const remainingFullMonthBasic = hasLeftByThisMonth ? 0 : structure.basic + components.fullMonthTaxableTotal;

      // Deliberate org policy: a worker whose active beneficiaries are ALL
      // percentage-type gets their salary split BEFORE tax, each share taxed
      // independently — see computeSplitPayrollTax's own comment for why this
      // taxes below the worker's real Section 149 liability by design, and
      // why a `fixed`-type beneficiary falls back to the ordinary path below.
      const splitResult = computeSplitPayrollTax({
        computedGross,
        monthlyTaxable,
        taxableYTDPrior,
        taxDeductedYTDPrior,
        remainingFullMonthBasic,
        taxYearStartDate: String(taxYear.startDate),
        taxYearEndDate: String(taxYear.endDate),
        period: run.period,
        slabs: taxSlabs,
        worker,
        beneficiaries: beneficiariesByWorkerId.get(worker.id) || [],
      });

      if (splitResult) {
        taxThisMonth = splitResult.taxThisMonth;
        splitTaxBreakdown = splitResult.lines;
        taxCalc = {
          taxableYTD: splitResult.taxableYTD,
          projectedAnnualTaxable: splitResult.projectedAnnualTaxable,
          annualTax: splitResult.annualTaxProjected,
        };
      } else {
        taxCalc = computeCumulativeTax({
          taxYearStartDate: String(taxYear.startDate),
          taxYearEndDate: String(taxYear.endDate),
          period: run.period,
          monthlyTaxable,
          taxableYTDPrior,
          taxDeductedYTDPrior,
          remainingFullMonthBasic,
          slabs: taxSlabs,
        });
        taxThisMonth = taxCalc.taxThisMonth;
      }
    }

    const deductions = {};
    if (taxThisMonth > 0) deductions.tax = taxThisMonth;
    const computedNet = Math.round((computedGross - sumPayrollDeductions(deductions)) * 100) / 100;

    const itemData = {
      presentDays, absentDays, leaveDays, halfDays,
      overtimeHours: Math.round(overtimeHours * 100) / 100,
      lateCount, latePenaltyDays, latePenaltyUnpaidDays,
      base: monthlySalary, additions, deductions, computedGross, computedNet,
      calendarDaysInMonth: daysInMonth,
      payableDaysCalendar: payableDays,
      earnedBasic: earned.earnedBasic,
      earnedMedical: earned.earnedMedical,
      monthlyTaxable,
      taxableYTD: taxCalc ? taxCalc.taxableYTD : monthlyTaxable,
      projectedAnnualTaxable: taxCalc ? taxCalc.projectedAnnualTaxable : 0,
      annualTaxProjected: taxCalc ? taxCalc.annualTax : 0,
      taxAmount: taxThisMonth,
      splitTaxBreakdown,
    };

    const [item, created] = await PayrollItem.findOrCreate({
      where: { payrollRunId: runId, workerId: worker.id },
      defaults: { ...itemData, employeeStatus: 'pending_review' },
    });
    if (!created) {
      await item.update(itemData);
    }
    results.push(item);
  }
  return results;
}

// Snapshots each newly-locked item's disbursementSplit from the worker's
// current SalaryBeneficiary rows. Called once per lock, not per calculate, so
// a later edit to the split doesn't retroactively rewrite an already-locked
// (or paid) run's history — see PayrollItem.disbursementSplit's comment.
async function freezeDisbursementSplits(runId, orgId) {
  const items = await PayrollItem.findAll({
    where: { payrollRunId: runId, isLocked: true },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }],
  });
  for (const item of items) {
    if (!item.worker) continue;
    // A percentage-only split already had tax computed per-share in
    // calculatePayrollItems (see PayrollItem.splitTaxBreakdown) — those
    // amounts are already each share's after-tax take-home, so they're used
    // directly rather than re-deriving a split off computedNet (which would
    // wrongly re-divide the COMBINED net by the gross-share percentages,
    // ignoring that progressive tax brackets mean each share's real tax
    // isn't the same fraction of the total tax as its fraction of the gross).
    let split;
    if (Array.isArray(item.splitTaxBreakdown) && item.splitTaxBreakdown.length) {
      split = item.splitTaxBreakdown;
    } else {
      const beneficiaries = await SalaryBeneficiary.findAll({
        where: { workerId: item.worker.id, orgId, isActive: true },
        order: [['sortOrder', 'ASC'], ['createdAt', 'ASC']],
      });
      split = computeDisbursementSplit(item.worker, item.computedNet, beneficiaries);
    }
    await item.update({ disbursementSplit: split });
  }
}

async function advancePayrollStatus(id, status, orgId) {
  const run = await PayrollRun.findOne({ where: { id, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  const valid = { draft: 'open_for_review', open_for_review: 'locked', locked: 'paid' };
  if (valid[run.status] !== status) {
    throw Object.assign(new Error(`Cannot transition from ${run.status} to ${status}`), { status: 400 });
  }

  // Auto-calculate when opening for review
  if (status === 'open_for_review') {
    await calculatePayrollItems(id, orgId);
  }

  // Lock all confirmed items when locking the run
  if (status === 'locked') {
    await PayrollItem.update(
      { isLocked: true },
      { where: { payrollRunId: id, employeeStatus: 'confirmed' } }
    );
    await freezeDisbursementSplits(id, orgId);
  }

  await run.update({ status });

  // Notify active employees when payroll opens for review
  if (status === 'open_for_review') {
    const items = await PayrollItem.findAll({
      where: { payrollRunId: id },
      include: [{
        model: Worker,
        as: 'worker',
        include: [{ model: User, as: 'user', attributes: ['id'] }],
      }],
    });
    for (const item of items) {
      const userId = item.worker?.user?.id;
      if (userId) {
        NotificationService.notify(userId, orgId, {
          type: 'payroll_review',
          title: `Payroll ready for review: ${formatPeriod(run.period)}`,
          body: 'Your salary for this period is ready. Please review and confirm or raise a concern.',
          refTable: 'self_service',
          refId: run.id,
        });
      }
    }
  }

  // Auto-generate salary slip records when marking paid
  if (status === 'paid') {
    const lockedItems = await PayrollItem.findAll({ where: { payrollRunId: id, isLocked: true } });
    for (const item of lockedItems) {
      await SalarySlip.findOrCreate({
        where: { payrollItemId: item.id },
        defaults: { payrollItemId: item.id, fileUrl: '', generatedAt: new Date() },
      });
    }
  }

  return run.reload();
}

// Reopen a locked/paid run so admin can fix working days / recalculate / re-lock / re-pay.
async function revertPayrollRun(id, orgId) {
  const run = await PayrollRun.findOne({ where: { id, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  if (!['locked', 'paid'].includes(run.status)) {
    throw Object.assign(
      new Error('Only locked or paid runs can be reverted. Draft and open-for-review runs are already editable.'),
      { status: 400 }
    );
  }

  const items = await PayrollItem.findAll({
    where: { payrollRunId: id },
    attributes: ['id'],
  });
  const itemIds = items.map((i) => i.id);
  if (itemIds.length) {
    await SalarySlip.destroy({ where: { payrollItemId: itemIds } });
  }

  await PayrollItem.update(
    {
      isLocked: false,
      employeeStatus: 'pending_review',
      employeeConfirmedAt: null,
    },
    { where: { payrollRunId: id } }
  );

  await run.update({ status: 'open_for_review' });
  return run.reload();
}

async function getPayrollItems(payrollRunId, orgId) {
  const run = await PayrollRun.findOne({ where: { id: payrollRunId, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  return PayrollItem.findAll({
    where: { payrollRunId },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email', 'avatarUrl'] }],
    }],
    order: [['createdAt', 'ASC']],
  });
}

async function upsertPayrollItem(payrollRunId, workerId, data, orgId) {
  const run = await PayrollRun.findOne({ where: { id: payrollRunId, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });
  if (!['draft', 'open_for_review'].includes(run.status)) {
    throw Object.assign(new Error('Can only edit items while the run is draft or open for review.'), { status: 400 });
  }

  const [item] = await PayrollItem.findOrCreate({
    where: { payrollRunId, workerId },
    defaults: { payrollRunId, workerId, employeeStatus: 'pending_review' },
  });

  const base = data.base !== undefined ? parseFloat(data.base) : parseFloat(item.base || 0);
  const additions = data.additions !== undefined ? data.additions : (item.additions || {});
  let deductions = data.deductions !== undefined ? { ...data.deductions } : { ...(item.deductions || {}) };

  // Allow overriding only tax without wiping other deduction lines.
  if (data.tax !== undefined) {
    const taxVal = parseFloat(data.tax);
    if (Number.isNaN(taxVal) || taxVal < 0) {
      throw Object.assign(new Error('tax must be a non-negative number.'), { status: 400 });
    }
    deductions = { ...deductions };
    if (taxVal === 0) delete deductions.tax;
    else deductions.tax = Math.round(taxVal * 100) / 100;
  }

  const totalDed = sumPayrollDeductions(deductions);
  const computedGross = computePayrollGross(base, additions);
  const computedNet = Math.round((computedGross - totalDed) * 100) / 100;

  const patch = {
    base,
    additions,
    deductions,
    computedGross,
    computedNet,
    // Mirror deductions.tax into the dedicated column — later months' YTD
    // cumulative tax (getWorkerYtdPriorTax) reads this back, not the JSON.
    taxAmount: Number(deductions.tax) || 0,
  };
  if (data.adminNote !== undefined) patch.adminNote = data.adminNote;
  if (data.presentDays !== undefined) patch.presentDays = data.presentDays;
  if (data.absentDays !== undefined) patch.absentDays = data.absentDays;
  if (data.leaveDays !== undefined) patch.leaveDays = data.leaveDays;
  if (data.halfDays !== undefined) patch.halfDays = data.halfDays;
  if (data.overtimeHours !== undefined) patch.overtimeHours = data.overtimeHours;
  // null clears the override back to "follow the run's toggle"; true/false
  // pins this worker for this run only. Only takes visible effect in
  // computedNet once the run is recalculated — see calculatePayrollItems.
  if (data.deductAttendanceOverride !== undefined) {
    patch.deductAttendanceOverride = data.deductAttendanceOverride === null
      ? null : !!data.deductAttendanceOverride;
  }

  await item.update(patch);
  return item.reload();
}

async function employeeReviewPayroll(payrollItemId, { employeeStatus, concernNote }, workerId) {
  const item = await PayrollItem.findOne({
    where: { id: payrollItemId, workerId },
    include: [
      { model: PayrollRun, as: 'run', attributes: ['id', 'orgId', 'period', 'status'] },
      {
        model: Worker,
        as: 'worker',
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      },
    ],
  });
  if (!item) throw Object.assign(new Error('Payroll item not found'), { status: 404 });
  if (item.isLocked) throw Object.assign(new Error('Payroll is locked'), { status: 400 });
  if (!['confirmed', 'concern_raised'].includes(employeeStatus)) {
    throw Object.assign(new Error('Invalid employee status'), { status: 400 });
  }
  if (employeeStatus === 'concern_raised' && !concernNote?.trim()) {
    throw Object.assign(new Error('Please describe your concern.'), { status: 400 });
  }

  const note = employeeStatus === 'concern_raised' ? concernNote.trim() : null;
  await item.update({
    employeeStatus,
    concernNote: note,
    employeeConfirmedAt: new Date(),
  });

  if (employeeStatus === 'concern_raised' && item.run) {
    const employeeName = item.worker?.user?.name || 'An employee';
    const period = formatPeriod(item.run.period) || 'this period';
    await notifyHrManagers(item.run.orgId, {
      type: 'payroll_concern',
      title: `Payroll concern from ${employeeName}`,
      body: `${employeeName} raised a concern on payroll ${period}: "${note}"`,
      refTable: 'payroll_runs',
      refId: item.run.id,
    });
  }

  return item.reload({
    include: [
      { model: PayrollRun, as: 'run', attributes: ['id', 'orgId', 'period', 'status'] },
      {
        model: Worker,
        as: 'worker',
        include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
      },
    ],
  });
}

// Admin adjusts a concern-raised payroll item and sends back for re-confirmation
async function rectifyPayrollItem(itemId, updates, orgId) {
  const item = await PayrollItem.findOne({
    where: { id: itemId },
    include: [{ model: PayrollRun, as: 'run', where: { orgId }, attributes: ['id', 'orgId', 'status'] }],
  });
  if (!item) throw Object.assign(new Error('Payroll item not found'), { status: 404 });
  if (item.employeeStatus !== 'concern_raised') {
    throw Object.assign(new Error('Item does not have a raised concern'), { status: 400 });
  }

  const newBase = updates.base !== undefined ? parseFloat(updates.base) : parseFloat(item.base);
  const newAdditions = updates.additions !== undefined ? updates.additions : (item.additions || {});
  let newDeductions = updates.deductions !== undefined
    ? { ...updates.deductions }
    : { ...(item.deductions || {}) };
  if (updates.tax !== undefined) {
    const taxVal = parseFloat(updates.tax);
    if (!Number.isNaN(taxVal) && taxVal >= 0) {
      newDeductions = { ...newDeductions };
      if (taxVal === 0) delete newDeductions.tax;
      else newDeductions.tax = Math.round(taxVal * 100) / 100;
    }
  }

  const totalDed = sumPayrollDeductions(newDeductions);
  const computedGross = computePayrollGross(newBase, newAdditions);
  const computedNet = Math.round((computedGross - totalDed) * 100) / 100;

  // Keep the dedicated taxAmount column in sync with deductions.tax — the
  // cumulative YTD tax method (Section 7, getWorkerYtdPriorTax) reads this
  // column back for every later month in the tax year, so an un-mirrored
  // manual rectification here would silently desync future withholding.
  const taxAmount = Number(newDeductions.tax) || 0;

  return item.update({
    base: newBase,
    additions: newAdditions,
    deductions: newDeductions,
    computedGross,
    computedNet,
    taxAmount,
    adminNote: updates.adminNote || null,
    employeeStatus: 'pending_review',
    isLocked: false,
  });
}

// Returns locked payroll items with bank details for disbursement
async function getDisbursementData(runId, orgId) {
  const run = await PayrollRun.findOne({ where: { id: runId, orgId } });
  if (!run) throw Object.assign(new Error('Payroll run not found'), { status: 404 });

  const items = await PayrollItem.findAll({
    where: { payrollRunId: runId, isLocked: true },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    }],
    order: [['createdAt', 'ASC']],
  });

  return items.flatMap((item) => {
    const base = {
      employee: item.worker?.user?.name || '',
      email: item.worker?.user?.email || '',
      designation: item.worker?.designation || '',
      department: item.worker?.department || '',
      currency: item.worker?.currency || 'PKR',
      payrollItemId: item.id,
    };
    const split = Array.isArray(item.disbursementSplit) ? item.disbursementSplit : [];

    // No split configured — same single row as before this feature existed.
    if (!split.length) {
      return [{
        ...base,
        recipient: item.worker?.user?.name || '',
        relation: 'Self',
        bankName: item.worker?.bankName || '',
        accountTitle: item.worker?.bankAccountTitle || '',
        accountNumber: item.worker?.bankAccountNumber || '',
        iban: item.worker?.iban || '',
        netAmount: parseFloat(item.computedNet || 0),
      }];
    }

    return split.map((line) => ({
      ...base,
      recipient: line.name || '',
      relation: line.relation || '',
      bankName: line.bankName || '',
      accountTitle: line.bankAccountTitle || '',
      accountNumber: line.bankAccountNumber || '',
      iban: line.iban || '',
      netAmount: parseFloat(line.amount || 0),
    }));
  });
}

// ─── HR Documents ─────────────────────────────────────────────────────────────

async function listHrDocuments(orgId, workerId, { includeInactive = false } = {}) {
  const where = { orgId };
  if (!includeInactive) where.isActive = true;
  if (workerId) where.workerId = workerId;
  return HrDocument.findAll({
    where,
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }],
    order: [['createdAt', 'DESC']],
  });
}

async function createHrDocument(data, orgId) {
  const worker = await Worker.findOne({ where: { id: data.workerId, orgId } });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });
  return HrDocument.create({
    ...data,
    fileUrl: data.fileUrl || '',
    status: data.status || 'issued',
    orgId,
  });
}

/** Generate a preformatted PDF letter and save it as an HrDocument (no manual upload). */
async function generateAndSaveDocument(workerId, orgId, type, uploadedBy) {
  const DocumentService = require('./DocumentService');
  const MediaService = require('./MediaService');
  const { SUPPORTED_TYPES } = DocumentService;
  if (!SUPPORTED_TYPES.includes(type)) {
    throw Object.assign(new Error(`Unsupported document type: ${type}`), { status: 400 });
  }

  const { buffer, title } = await DocumentService.generateDocumentBuffer(workerId, orgId, type);
  const filename = `${type.replace(/_/g, '-')}-${Date.now()}.pdf`;
  const uploaded = await MediaService.upload(buffer, filename, 'application/pdf');
  return createHrDocument({
    workerId,
    type,
    label: title,
    fileUrl: uploaded.url,
    fileName: filename,
    uploadedBy: uploadedBy || null,
    status: 'issued',
  }, orgId);
}

/**
 * Employee requests a letter — does NOT generate yet. HR is notified and the
 * request appears on the dashboard until an admin issues it.
 */
async function requestEmployeeDocument(userId, orgId, type, note) {
  const worker = await Worker.findOne({
    where: { userId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  if (!worker) throw Object.assign(new Error('No worker profile found'), { status: 404 });

  const DocumentService = require('./DocumentService');
  if (!DocumentService.SUPPORTED_TYPES.includes(type)) {
    throw Object.assign(new Error('That document type cannot be requested this way. Please contact HR.'), { status: 400 });
  }

  const existing = await HrDocument.findOne({
    where: { workerId: worker.id, orgId, type, status: 'requested' },
  });
  if (existing) {
    throw Object.assign(new Error('You already have a pending request for this document.'), { status: 409 });
  }

  const title = DocumentService.DOCUMENT_TITLES[type] || type;
  const doc = await HrDocument.create({
    orgId,
    workerId: worker.id,
    type,
    label: title,
    fileUrl: '',
    status: 'requested',
    uploadedBy: userId,
  });

  notifyHrManagers(orgId, {
    type: 'document_requested',
    title: 'Document request',
    body: `${worker.user?.name || 'An employee'} requested: ${title}.`,
    refTable: 'workers',
    refId: worker.id,
  }).catch((err) => {
    console.error('[HrService] document request HR notify failed:', err.message);
  });

  return doc;
}

async function listPendingDocumentRequests(orgId) {
  return HrDocument.findAll({
    where: { orgId, status: 'requested' },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    }],
    order: [['createdAt', 'ASC']],
  });
}

/** HR issues a pending request — generate PDF, attach it, notify the employee. */
async function fulfillDocumentRequest(docId, adminUserId, orgId) {
  const doc = await HrDocument.findOne({
    where: { id: docId, orgId },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    }],
  });
  if (!doc) throw Object.assign(new Error('Document request not found'), { status: 404 });
  if (doc.status !== 'requested') {
    throw Object.assign(new Error('This request has already been handled.'), { status: 400 });
  }

  const DocumentService = require('./DocumentService');
  const MediaService = require('./MediaService');
  if (!DocumentService.SUPPORTED_TYPES.includes(doc.type)) {
    throw Object.assign(new Error('Cannot auto-generate this document type.'), { status: 400 });
  }

  const { buffer, title } = await DocumentService.generateDocumentBuffer(doc.workerId, orgId, doc.type);
  const filename = `${doc.type.replace(/_/g, '-')}-${Date.now()}.pdf`;
  const uploaded = await MediaService.upload(buffer, filename, 'application/pdf');

  await doc.update({
    fileUrl: uploaded.url,
    fileName: filename,
    label: title || doc.label,
    status: 'issued',
    uploadedBy: adminUserId,
  });

  const employeeUser = doc.worker?.user;
  if (employeeUser) {
    NotificationService.notify(employeeUser.id, orgId, {
      type: 'document_issued',
      title: 'Document ready',
      body: `Your ${doc.label || title} is ready to view and download.`,
      refTable: 'self_service',
      refId: doc.id,
    }).catch((err) => {
      console.error('[HrService] document issued notify failed:', err.message);
    });
  }

  return doc.reload({
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    }],
  });
}

async function rejectDocumentRequest(docId, adminUserId, orgId, reason) {
  const note = String(reason || '').trim();
  if (!note) {
    throw Object.assign(new Error('A decline reason is required.'), { status: 400 });
  }

  const doc = await HrDocument.findOne({
    where: { id: docId, orgId },
    include: [{
      model: Worker,
      as: 'worker',
      include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
    }],
  });
  if (!doc) throw Object.assign(new Error('Document request not found'), { status: 404 });
  if (doc.status !== 'requested') {
    throw Object.assign(new Error('This request has already been handled.'), { status: 400 });
  }

  await doc.update({ status: 'rejected', uploadedBy: adminUserId, rejectionReason: note });

  const employeeUser = doc.worker?.user;
  if (employeeUser) {
    NotificationService.notify(employeeUser.id, orgId, {
      type: 'document_rejected',
      title: 'Document request declined',
      body: `Your request for ${doc.label || doc.type} was declined. ${note}`,
      refTable: 'self_service',
      refId: doc.id,
    }).catch((err) => {
      console.error('[HrService] document rejected notify failed:', err.message);
    });
  }

  return doc;
}

// Deactivates rather than destroys — see services/SoftDeleteService.js. HR
// paperwork (appointment letters, CNIC scans, contracts) is exactly the kind of
// record that must survive an accidental click.
async function deleteHrDocument(id, orgId, active = false) {
  const doc = await HrDocument.findOne({ where: { id, orgId } });
  if (!doc) throw Object.assign(new Error('Document not found'), { status: 404 });
  await doc.update({ isActive: active });
  return doc;
}

// ─── Contractor Invoices ──────────────────────────────────────────────────────

async function listContractorInvoices(orgId, workerId) {
  const where = { orgId };
  if (workerId) where.workerId = workerId;
  return ContractorInvoice.findAll({
    where,
    include: [{ model: Worker, as: 'worker', include: [{ model: User, as: 'user', attributes: ['id', 'name'] }] }],
    order: [['createdAt', 'DESC']],
  });
}

async function createContractorInvoice(data, orgId) {
  const worker = await Worker.findOne({ where: { id: data.workerId, orgId } });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });
  return ContractorInvoice.create({ ...data, orgId });
}

async function approveContractorInvoice(id, { status, note }, approverId, orgId) {
  const inv = await ContractorInvoice.findOne({ where: { id, orgId } });
  if (!inv) throw Object.assign(new Error('Invoice not found'), { status: 404 });
  const updates = { status, approvedBy: approverId, note };
  if (status === 'paid') updates.paidAt = new Date();
  return inv.update(updates);
}

// ─── Appraisals ───────────────────────────────────────────────────────────────

async function listAppraisals(workerId, orgId) {
  const worker = await Worker.findOne({ where: { id: workerId, orgId } });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });
  return Appraisal.findAll({
    where: { workerId, orgId },
    include: [{ model: User, as: 'approver', attributes: ['id', 'name'] }],
    order: [['reviewDate', 'DESC']],
  });
}

// Creating an appraisal that specifies a new salary updates Worker.salaryBase in
// the same transaction — the appraisal row is the permanent record of the change
// (who approved it, old vs new), Worker.salaryBase stays the single current value
// used everywhere else (payroll calculation, disbursement, etc).
async function createAppraisal(workerId, data, approvedBy, orgId) {
  const worker = await Worker.findOne({
    where: { id: workerId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'] }],
  });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });

  const salaryBefore = worker.salaryBase;
  const salaryAfter = data.salaryAfter !== undefined && data.salaryAfter !== ''
    ? parseFloat(data.salaryAfter) : salaryBefore;

  const appraisal = await db.sequelize.transaction(async (t) => {
    const row = await Appraisal.create({
      orgId,
      workerId,
      reviewDate: data.reviewDate || new Date().toISOString().slice(0, 10),
      rating: data.rating || null,
      notes: data.notes || null,
      salaryBefore,
      salaryAfter,
      approvedBy,
    }, { transaction: t });

    if (salaryAfter !== null && String(salaryAfter) !== String(salaryBefore)) {
      await worker.update({ salaryBase: salaryAfter }, { transaction: t });
    }

    return row;
  });

  const employeeUser = worker.user;
  if (employeeUser) {
    const salaryChanged = salaryAfter != null && String(salaryAfter) !== String(salaryBefore);
    const ratingLabel = appraisal.rating || 'recorded';
    NotificationService.notify(employeeUser.id, orgId, {
      type: 'appraisal_recorded',
      title: 'New appraisal recorded',
      body: salaryChanged
        ? `Your appraisal (${ratingLabel}) includes an updated compensation: ${salaryBefore} → ${salaryAfter}.`
        : `Your appraisal has been recorded${appraisal.rating ? `: ${appraisal.rating}` : ''}.`,
      refTable: 'appraisals',
      refId: appraisal.id,
    }).catch((err) => {
      console.error('[HrService] appraisal in-app notification failed:', err.message);
    });

    if (employeeUser.email) {
      EmailService.sendAppraisalUpdate({
        workerEmail: employeeUser.email,
        workerName: employeeUser.name,
        reviewDate: appraisal.reviewDate,
        rating: appraisal.rating,
        notes: appraisal.notes,
        salaryBefore,
        salaryAfter,
        currency: worker.currency || 'PKR',
        appUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
      }).catch((err) => {
        console.error('[HrService] appraisal email notification failed:', err.message);
      });
    } else {
      console.warn(`[HrService] appraisal for worker ${workerId}: no employee email on file`);
    }
  } else {
    console.warn(`[HrService] appraisal for worker ${workerId}: linked user not found`);
  }

  return Appraisal.findByPk(appraisal.id, {
    include: [{ model: User, as: 'approver', attributes: ['id', 'name'] }],
  });
}

module.exports = {
  listWorkers, getWorker, createWorker, updateWorker, inviteWorker,
  updateMyAvatar, submitProfile, requestEmailChange, confirmEmailChange, onboardWorker,
  listAttendance, getAttendanceSummary, upsertAttendance, bulkMarkAttendance, markAbsentForUnmarkedWorkers,
  selfCheckIn, selfCheckOut, selfCheckOutForOpenSession, getSelfAttendanceStatus,
  listHolidays, createHoliday, updateHoliday, deleteHoliday, findHolidayFor,
  listShiftSchedules, createShiftSchedule, updateShiftSchedule, deleteShiftSchedule, resolveShiftTimings,
  isNonAttendanceRole,
  listLeaveRequests, createLeaveRequest, createEmployeeLeaveRequest, getEmployeeLeaveBalance, reviewLeave,
  getOrCreatePayrollSettings, updatePayrollSettings,
  getSalaryBeneficiaries, setSalaryBeneficiaries,
  listTaxYears, createTaxYear, updateTaxYear, activateTaxYear, deleteTaxYear, duplicateTaxYear,
  createTaxSlab, updateTaxSlab, deleteTaxSlab, getActiveTaxSlabs, getTaxYearForPeriod,
  listPayrollRuns, createPayrollRun, updatePayrollRun, deletePayrollRun, advancePayrollStatus,
  revertPayrollRun, calculatePayrollItems, getPayrollItems, upsertPayrollItem,
  employeeReviewPayroll, rectifyPayrollItem, getDisbursementData,
  listHrDocuments, createHrDocument, generateAndSaveDocument, requestEmployeeDocument,
  listPendingDocumentRequests, fulfillDocumentRequest, rejectDocumentRequest, deleteHrDocument,
  listContractorInvoices, createContractorInvoice, approveContractorInvoice,
  listAppraisals, createAppraisal,
};
