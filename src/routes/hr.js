const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const adminOnly = require('../middleware/adminOnly');
const { isTruthy } = require('../services/SoftDeleteService');
const rbac = require('../middleware/rbac');
const validate = require('../middleware/validate');
const HrService = require('../services/HrService');
const EmailService = require('../services/EmailService');
const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');

router.use(auth, tenancy);

// CNIC (Pakistani national ID): NNNNN-NNNNNNN-N. Designation/department are
// free-text columns capped at STRING(150) in the Worker model — without this,
// an overlong value hits MySQL raw and surfaces as the generic "One of the
// values you entered is invalid..." message from errorHandler's DatabaseError
// branch instead of a field-specific one.
const workerProfileValidators = () => [
  body('name').optional({ checkFalsy: true }).trim().isLength({ min: 2, max: 150 })
    .withMessage('Full name must be between 2 and 150 characters.'),
  body('email').optional({ checkFalsy: true }).isEmail()
    .withMessage('A valid email address is required.'),
  body('cnic').optional({ checkFalsy: true }).matches(/^\d{5}-\d{7}-\d{1}$/)
    .withMessage('CNIC must be in the format 12345-1234567-1.'),
  body('designation').optional({ checkFalsy: true }).isLength({ max: 150 })
    .withMessage('Designation must be 150 characters or fewer.'),
  body('department').optional({ checkFalsy: true }).isLength({ max: 150 })
    .withMessage('Department must be 150 characters or fewer.'),
];

// ─── Departments ───────────────────────────────────────────────────────────────
router.get('/departments', rbac('hr.read'), async (req, res, next) => {
  try {
    const { HrDepartment } = require('../models');
    const rows = await HrDepartment.findAll({
      where: { orgId: req.orgId, ...(isTruthy(req.query.includeInactive) ? {} : { isActive: true }) },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/departments', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDepartment } = require('../models');
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'name is required.' });
    const row = await HrDepartment.create({ id: uuidv4(), orgId: req.orgId, name: name.trim() });
    res.status(201).json(row);
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ message: 'Department already exists.' });
    next(e);
  }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/departments/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDepartment } = require('../models');
    await HrDepartment.update({ isActive: false }, { where: { id: req.params.id, orgId: req.orgId } });
    res.json({ message: 'Department set to Inactive.' });
  } catch (e) { next(e); }
});

router.post('/departments/:id/activate', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDepartment } = require('../models');
    await HrDepartment.update({ isActive: true }, { where: { id: req.params.id, orgId: req.orgId } });
    res.json({ message: 'Department set to Active.' });
  } catch (e) { next(e); }
});

// ─── Designations ──────────────────────────────────────────────────────────────
router.get('/designations', rbac('hr.read'), async (req, res, next) => {
  try {
    const { HrDesignation } = require('../models');
    const rows = await HrDesignation.findAll({
      where: { orgId: req.orgId, ...(isTruthy(req.query.includeInactive) ? {} : { isActive: true }) },
      order: [['name', 'ASC']],
    });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/designations', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDesignation } = require('../models');
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'name is required.' });
    const row = await HrDesignation.create({ id: uuidv4(), orgId: req.orgId, name: name.trim() });
    res.status(201).json(row);
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') return res.status(409).json({ message: 'Designation already exists.' });
    next(e);
  }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/designations/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDesignation } = require('../models');
    await HrDesignation.update({ isActive: false }, { where: { id: req.params.id, orgId: req.orgId } });
    res.json({ message: 'Designation set to Inactive.' });
  } catch (e) { next(e); }
});

router.post('/designations/:id/activate', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const { HrDesignation } = require('../models');
    await HrDesignation.update({ isActive: true }, { where: { id: req.params.id, orgId: req.orgId } });
    res.json({ message: 'Designation set to Active.' });
  } catch (e) { next(e); }
});

// ─── Payroll Settings ─────────────────────────────────────────────────────────
router.get('/payroll-settings', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.getOrCreatePayrollSettings(req.orgId)); } catch (e) { next(e); }
});

router.patch('/payroll-settings', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.updatePayrollSettings(req.orgId, req.body)); } catch (e) { next(e); }
});

// ─── Income tax years & slabs (Pakistan payroll withholding) ───────────────────
router.get('/tax-years', rbac('hr.read'), async (req, res, next) => {
  try {
    res.json(await HrService.listTaxYears(req.orgId, { includeInactive: isTruthy(req.query.includeInactive) }));
  } catch (e) { next(e); }
});

router.post('/tax-years', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.createTaxYear(req.orgId, req.body)); } catch (e) { next(e); }
});

router.patch('/tax-years/:id', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.updateTaxYear(req.params.id, req.orgId, req.body)); } catch (e) { next(e); }
});

router.post('/tax-years/:id/activate', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.activateTaxYear(req.params.id, req.orgId)); } catch (e) { next(e); }
});

// Archives, never destroys — see services/SoftDeleteService.js.
router.delete('/tax-years/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.deleteTaxYear(req.params.id, req.orgId, true)); } catch (e) { next(e); }
});

router.post('/tax-years/:id/restore', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.deleteTaxYear(req.params.id, req.orgId, false)); } catch (e) { next(e); }
});

router.post('/tax-years/:id/slabs', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.createTaxSlab(req.params.id, req.orgId, req.body)); } catch (e) { next(e); }
});

router.patch('/tax-slabs/:id', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.updateTaxSlab(req.params.id, req.orgId, req.body)); } catch (e) { next(e); }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/tax-slabs/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.deleteTaxSlab(req.params.id, req.orgId, false)); } catch (e) { next(e); }
});

router.post('/tax-slabs/:id/activate', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.deleteTaxSlab(req.params.id, req.orgId, true)); } catch (e) { next(e); }
});

// ─── Workers ──────────────────────────────────────────────────────────────────
router.get('/workers', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.listWorkers(req.orgId)); } catch (e) { next(e); }
});

router.get('/workers/:id', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.getWorker(req.params.id, req.orgId)); } catch (e) { next(e); }
});

// Invite: creates User account + Worker in one step
router.post('/workers/invite', rbac('hr.manage'), async (req, res, next) => {
  try {
    const result = await HrService.inviteWorker(req.body, req.orgId);
    // tempPassword is only set when a new User was created (not when reusing an
    // existing account) — fire-and-forget invite email, same as Team module.
    if (result.tempPassword) {
      EmailService.sendUserInvite(
        req.body.email, req.body.name, result.tempPassword,
        process.env.FRONTEND_URL || 'http://localhost:3000'
      ).catch(() => {});
    }
    res.status(201).json(result);
  } catch (e) { next(e); }
});

router.post('/workers', rbac('hr.manage'), workerProfileValidators(), validate, async (req, res, next) => {
  try { res.status(201).json(await HrService.createWorker(req.body, req.orgId)); } catch (e) { next(e); }
});

router.patch('/workers/:id', rbac('hr.manage'), workerProfileValidators(), validate, async (req, res, next) => {
  try { res.json(await HrService.updateWorker(req.params.id, req.body, req.orgId, req.user.id)); } catch (e) { next(e); }
});

// Admin onboarding review: approve (with salary/designation) or reject
router.patch('/workers/:id/onboard', rbac('hr.manage'), workerProfileValidators(), validate, async (req, res, next) => {
  try {
    const { action, ...adminData } = req.body;
    const result = await HrService.onboardWorker(req.params.id, action, { ...adminData, adminId: req.user.id }, req.orgId);
    res.json(result);
  } catch (e) { next(e); }
});

// ─── Appraisals ───────────────────────────────────────────────────────────────
router.get('/workers/:id/appraisals', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.listAppraisals(req.params.id, req.orgId)); } catch (e) { next(e); }
});

router.post('/workers/:id/appraisals', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.createAppraisal(req.params.id, req.body, req.user.id, req.orgId)); } catch (e) { next(e); }
});

// ─── Salary Beneficiaries (salary split) ───────────────────────────────────────
router.get('/workers/:id/salary-beneficiaries', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.getSalaryBeneficiaries(req.params.id, req.orgId)); } catch (e) { next(e); }
});

router.put('/workers/:id/salary-beneficiaries', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.setSalaryBeneficiaries(req.params.id, req.orgId, req.body.beneficiaries));
  } catch (e) { next(e); }
});

// ─── Attendance ───────────────────────────────────────────────────────────────
router.get('/attendance', rbac('hr.read'), async (req, res, next) => {
  try {
    const { workerId, month, date, page, limit } = req.query;
    res.json(await HrService.listAttendance(req.orgId, { workerId, month, date, page, limit }));
  } catch (e) { next(e); }
});

// Admin marks (or corrects) one employee's day — the backstop for someone who
// forgot to check in. See HrService.upsertAttendance.
router.post('/attendance', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.upsertAttendance(req.body, req.orgId, req.user.id)); } catch (e) { next(e); }
});

// Marks a whole day at once — closing out a public holiday, or sweeping a day's
// non-markers as absent.
router.post('/attendance/bulk-mark', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.bulkMarkAttendance(req.orgId, req.body, req.user.id)); } catch (e) { next(e); }
});

// Per-employee + org-wide monthly attendance summary (present/absent/leave/half-day counts)
router.get('/attendance/summary', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.getAttendanceSummary(req.orgId, req.query.month)); } catch (e) { next(e); }
});

// ─── Public holidays ──────────────────────────────────────────────────────────
// Readable by any authenticated employee (everyone needs to know when the office
// is closed); only hr.manage can change the calendar.
router.get('/holidays', async (req, res, next) => {
  try {
    res.json(await HrService.listHolidays(req.orgId, {
      year: req.query.year,
      includeInactive: isTruthy(req.query.includeInactive),
    }));
  } catch (e) { next(e); }
});

router.post('/holidays', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.createHoliday(req.orgId, req.body)); } catch (e) { next(e); }
});

router.patch('/holidays/:id', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.updateHoliday(req.params.id, req.orgId, req.body)); } catch (e) { next(e); }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/holidays/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const holiday = await HrService.deleteHoliday(req.params.id, req.orgId, false);
    res.json({ message: 'Holiday set to Inactive.', holiday });
  } catch (e) { next(e); }
});

router.post('/holidays/:id/activate', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const holiday = await HrService.deleteHoliday(req.params.id, req.orgId, true);
    res.json({ message: 'Holiday set to Active.', holiday });
  } catch (e) { next(e); }
});

// ─── Shift schedules (seasonal timings, e.g. Ramadan) ─────────────────────────
router.get('/shift-schedules', async (req, res, next) => {
  try {
    res.json(await HrService.listShiftSchedules(req.orgId, {
      includeArchived: isTruthy(req.query.includeArchived),
    }));
  } catch (e) { next(e); }
});

router.post('/shift-schedules', rbac('hr.manage'), async (req, res, next) => {
  try { res.status(201).json(await HrService.createShiftSchedule(req.orgId, req.body)); } catch (e) { next(e); }
});

router.patch('/shift-schedules/:id', rbac('hr.manage'), async (req, res, next) => {
  try { res.json(await HrService.updateShiftSchedule(req.params.id, req.orgId, req.body)); } catch (e) { next(e); }
});

// Archives, never destroys — a past schedule still explains how lateness was
// judged on the days it covered.
router.delete('/shift-schedules/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const schedule = await HrService.deleteShiftSchedule(req.params.id, req.orgId, true);
    res.json({ message: 'Shift schedule archived.', schedule });
  } catch (e) { next(e); }
});

router.post('/shift-schedules/:id/restore', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const schedule = await HrService.deleteShiftSchedule(req.params.id, req.orgId, false);
    res.json({ message: 'Shift schedule restored.', schedule });
  } catch (e) { next(e); }
});

// ─── Leave Requests ───────────────────────────────────────────────────────────
router.get('/leaves', rbac('hr.read'), async (req, res, next) => {
  try {
    const { workerId, status } = req.query;
    res.json(await HrService.listLeaveRequests(req.orgId, { workerId, status }));
  } catch (e) { next(e); }
});

router.post('/leaves', async (req, res, next) => {
  try { res.status(201).json(await HrService.createLeaveRequest(req.body, req.orgId)); } catch (e) { next(e); }
});

router.patch('/leaves/:id/review', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { status, approverNote } = req.body;
    res.json(await HrService.reviewLeave(req.params.id, { status, approverNote }, req.user.id, req.orgId));
  } catch (e) { next(e); }
});

// ─── Payroll Runs ─────────────────────────────────────────────────────────────
router.get('/payroll', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.listPayrollRuns(req.orgId)); } catch (e) { next(e); }
});

router.post('/payroll', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { period, workingDaysPerMonth, includeOvertime } = req.body;
    if (!period) return res.status(400).json({ error: 'period is required (YYYY-MM)' });
    res.status(201).json(await HrService.createPayrollRun(period, req.orgId, req.user.id, { workingDaysPerMonth, includeOvertime }));
  } catch (e) { next(e); }
});

router.patch('/payroll/:id', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.updatePayrollRun(req.params.id, req.orgId, req.body));
  } catch (e) { next(e); }
});

// Temporary: hard-delete a payroll run while QA-ing the workflow — remove once done.
router.delete('/payroll/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.deletePayrollRun(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

router.patch('/payroll/:id/status', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { status } = req.body;
    res.json(await HrService.advancePayrollStatus(req.params.id, status, req.orgId));
  } catch (e) { next(e); }
});

// Reopen locked/paid run for correction (recalculate → lock → mark paid again)
router.post('/payroll/:id/revert', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.revertPayrollRun(req.params.id, req.orgId));
  } catch (e) { next(e); }
});

// Manually trigger auto-calculation (also runs automatically on draft→open_for_review)
router.post('/payroll/:id/calculate', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { workingDaysPerMonth } = req.body || {};
    const items = await HrService.calculatePayrollItems(req.params.id, req.orgId, { workingDaysPerMonth });
    res.json(items);
  } catch (e) { next(e); }
});

router.get('/payroll/:id/items', rbac('hr.read'), async (req, res, next) => {
  try { res.json(await HrService.getPayrollItems(req.params.id, req.orgId)); } catch (e) { next(e); }
});

router.put('/payroll/:id/items/:workerId', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.upsertPayrollItem(req.params.id, req.params.workerId, req.body, req.orgId));
  } catch (e) { next(e); }
});

// Disbursement sheet as JSON (frontend exports to CSV)
router.get('/payroll/:id/disbursement', rbac('hr.manage'), async (req, res, next) => {
  try {
    const data = await HrService.getDisbursementData(req.params.id, req.orgId);
    if (req.query.format === 'csv') {
      const headers = ['Employee', 'Recipient', 'Relation', 'Designation', 'Department', 'Bank', 'Account Title', 'Account #', 'IBAN', 'Currency', 'Amount'];
      const rows = data.map((d) => [
        d.employee, d.recipient, d.relation, d.designation, d.department,
        d.bankName, d.accountTitle, d.accountNumber, d.iban,
        d.currency, d.netAmount,
      ]);
      const csv = [headers, ...rows]
        .map((row) => row.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="disbursement-${req.params.id}.csv"`);
      return res.send(csv);
    }
    res.json(data);
  } catch (e) { next(e); }
});

// Employee self-review their own payroll item
router.patch('/payroll-items/:itemId/review', async (req, res, next) => {
  try {
    const { Worker } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(403).json({ error: 'No worker profile found' });
    const { employeeStatus, concernNote } = req.body;
    res.json(await HrService.employeeReviewPayroll(req.params.itemId, { employeeStatus, concernNote }, worker.id));
  } catch (e) { next(e); }
});

// Admin rectifies a concern-raised item
router.patch('/payroll-items/:itemId/rectify', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.rectifyPayrollItem(req.params.itemId, req.body, req.orgId));
  } catch (e) { next(e); }
});

// ─── HR Documents ─────────────────────────────────────────────────────────────
router.get('/documents', rbac('hr.read'), async (req, res, next) => {
  try {
    res.json(await HrService.listHrDocuments(req.orgId, req.query.workerId, {
      includeInactive: isTruthy(req.query.includeInactive),
    }));
  } catch (e) { next(e); }
});

router.post('/documents', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.status(201).json(await HrService.createHrDocument({ ...req.body, uploadedBy: req.user.id }, req.orgId));
  } catch (e) { next(e); }
});

// Deactivates, never destroys — see services/SoftDeleteService.js.
router.delete('/documents/:id', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const doc = await HrService.deleteHrDocument(req.params.id, req.orgId, false);
    res.json({ message: 'Document set to Inactive', document: doc });
  } catch (e) { next(e); }
});

router.post('/documents/:id/activate', adminOnly, rbac('hr.manage'), async (req, res, next) => {
  try {
    const doc = await HrService.deleteHrDocument(req.params.id, req.orgId, true);
    res.json({ message: 'Document set to Active', document: doc });
  } catch (e) { next(e); }
});

// ─── Contractor Invoices ──────────────────────────────────────────────────────
router.get('/contractor-invoices', rbac('hr.read'), async (req, res, next) => {
  try {
    res.json(await HrService.listContractorInvoices(req.orgId, req.query.workerId));
  } catch (e) { next(e); }
});

router.post('/contractor-invoices', async (req, res, next) => {
  try {
    res.status(201).json(await HrService.createContractorInvoice(req.body, req.orgId));
  } catch (e) { next(e); }
});

router.patch('/contractor-invoices/:id/review', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { status, note } = req.body;
    res.json(await HrService.approveContractorInvoice(req.params.id, { status, note }, req.user.id, req.orgId));
  } catch (e) { next(e); }
});

// ─── Salary Slip PDF ──────────────────────────────────────────────────────────
router.get('/payroll-items/:itemId/slip', async (req, res, next) => {
  try {
    const { Worker } = require('../models');
    const SalarySlipService = require('../services/SalarySlipService');
    const { buffer, item } = await SalarySlipService.generateSlipBuffer(req.params.itemId, req.orgId);

    const hasHrRead =
      ['super_admin', 'admin'].includes(req.user.role?.key) ||
      req.user.role?.permissions?.['hr.read'];
    if (!hasHrRead) {
      const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
      if (!worker || item.workerId !== worker.id) {
        return res.status(403).json({ message: 'Access denied.' });
      }
    }

    const { formatPeriod } = require('../utils/formatPeriod');
    const period = formatPeriod(item.run?.period) || 'slip';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="salary-slip-${period}.pdf"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

// ─── Document generation (PDF download) ──────────────────────────────────────
router.get('/workers/:id/generate-document', rbac('hr.manage'), async (req, res, next) => {
  try {
    const DocumentService = require('../services/DocumentService');
    const { type } = req.query;
    if (!type) return res.status(400).json({ message: 'type query param is required.' });
    const { buffer, title } = await DocumentService.generateDocumentBuffer(req.params.id, req.orgId, type);
    const filename = `${type.replace(/_/g, '-')}-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

// Generates a standard PDF (appointment letter, salary certificate, etc.) AND
// persists it as a real HrDocument (fileUrl pointing at the media server) so it
// shows up in the worker's Documents list and can be re-downloaded later exactly
// as issued — the GET route above only ever streamed a one-off download with no
// record kept. Admin picks a type from a dropdown; no manual upload needed
// since the document is generated from the worker's own on-file data.
router.post('/workers/:id/generate-document', rbac('hr.manage'), async (req, res, next) => {
  try {
    const { type } = req.body;
    if (!type) return res.status(400).json({ message: 'type is required.' });
    const doc = await HrService.generateAndSaveDocument(req.params.id, req.orgId, type, req.user.id);
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

// ─── Self-service (any authenticated user with a worker profile) ──────────────

// Persist profile photo immediately after capture/upload (no full-form submit needed)
router.patch('/me/avatar', async (req, res, next) => {
  try {
    res.json(await HrService.updateMyAvatar(req.user.id, req.body.profilePictureUrl, req.orgId));
  } catch (e) { next(e); }
});

// Employee submits their own profile for admin review
router.patch('/me/profile', workerProfileValidators(), validate, async (req, res, next) => {
  try {
    res.json(await HrService.submitProfile(req.user.id, req.body, req.orgId));
  } catch (e) { next(e); }
});

// Verify a new email on the spot (OTP sent to the new address) before it becomes the login email
router.post('/me/email/request-code', async (req, res, next) => {
  try {
    res.json(await HrService.requestEmailChange(req.user.id, req.orgId, req.body.email));
  } catch (e) { next(e); }
});

router.post('/me/email/confirm', async (req, res, next) => {
  try {
    res.json(await HrService.confirmEmailChange(req.user.id, req.orgId, req.body));
  } catch (e) { next(e); }
});

router.get('/me', async (req, res, next) => {
  try {
    const { Worker, User, HrDocument } = require('../models');
    const worker = await Worker.findOne({
      where: { userId: req.user.id, orgId: req.orgId },
      include: [
        { model: User, as: 'user', attributes: ['name', 'email'] },
        { model: HrDocument, as: 'documents', attributes: ['id', 'type', 'fileUrl', 'fileName'] },
      ],
    });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    res.json(worker);
  } catch (e) { next(e); }
});

router.get('/me/payroll', async (req, res, next) => {
  try {
    const { Worker, PayrollItem, PayrollRun } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const items = await PayrollItem.findAll({
      where: { workerId: worker.id },
      include: [{ model: PayrollRun, as: 'run', attributes: ['id', 'period', 'status'] }],
      order: [['createdAt', 'DESC']],
      limit: 12,
    });
    res.json(items);
  } catch (e) { next(e); }
});

// Read-only — an employee can see how their own pay is split (HR sets it up
// based on info the employee themselves provided), but not edit it here;
// changing where someone else's money goes stays an HR-only action via
// PUT /hr/workers/:id/salary-beneficiaries.
router.get('/me/salary-split', async (req, res, next) => {
  try {
    const { Worker } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    res.json(await HrService.getSalaryBeneficiaries(worker.id, req.orgId));
  } catch (e) { next(e); }
});

router.get('/me/slips', async (req, res, next) => {
  try {
    const { Worker, SalarySlip, PayrollItem, PayrollRun } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const items = await PayrollItem.findAll({ where: { workerId: worker.id }, attributes: ['id'] });
    const itemIds = items.map((i) => i.id);
    if (itemIds.length === 0) return res.json([]);
    const slips = await SalarySlip.findAll({
      where: { payrollItemId: itemIds },
      include: [{
        model: PayrollItem,
        as: 'payrollItem',
        attributes: ['id', 'computedNet'],
        include: [{ model: PayrollRun, as: 'run', attributes: ['id', 'period'] }],
      }],
      order: [['generatedAt', 'DESC']],
    });
    res.json(slips);
  } catch (e) { next(e); }
});

router.get('/me/documents', async (req, res, next) => {
  try {
    const { Worker, HrDocument } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const docs = await HrDocument.findAll({ where: { workerId: worker.id }, order: [['createdAt', 'DESC']] });
    res.json(docs);
  } catch (e) { next(e); }
});

// Employee requests a letter — HR is notified; document is issued later by admin.
router.post('/me/request-document', async (req, res, next) => {
  try {
    const { type, note } = req.body;
    if (!type) return res.status(400).json({ message: 'type is required.' });
    const doc = await HrService.requestEmployeeDocument(req.user.id, req.orgId, type, note);
    res.status(201).json(doc);
  } catch (e) { next(e); }
});

router.get('/document-requests', rbac('hr.read'), async (req, res, next) => {
  try {
    res.json(await HrService.listPendingDocumentRequests(req.orgId));
  } catch (e) { next(e); }
});

router.post('/document-requests/:id/fulfill', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.fulfillDocumentRequest(req.params.id, req.user.id, req.orgId));
  } catch (e) { next(e); }
});

router.post('/document-requests/:id/reject', rbac('hr.manage'), async (req, res, next) => {
  try {
    res.json(await HrService.rejectDocumentRequest(req.params.id, req.user.id, req.orgId, req.body?.reason));
  } catch (e) { next(e); }
});

// Employee self check-in/out — requires GPS coordinates from the browser. The
// frontend refuses to call this at all if geolocation permission was denied, and
// the server also requires lat/lng here so attendance can't be marked without it.
router.post('/me/attendance/check-in', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined || lat === null || lng === null) {
      return res.status(400).json({ message: 'Location is required to mark attendance.' });
    }
    res.status(201).json(await HrService.selfCheckIn(req.user.id, req.orgId, { lat, lng }));
  } catch (e) { next(e); }
});

router.post('/me/attendance/check-out', async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (lat === undefined || lng === undefined || lat === null || lng === null) {
      return res.status(400).json({ message: 'Location is required to mark attendance.' });
    }
    res.json(await HrService.selfCheckOut(req.user.id, req.orgId, { lat, lng }));
  } catch (e) { next(e); }
});

// Resolves a *stale* open session — a check-in from a previous attendance day
// that never got a check-out — using a time-of-day the employee enters rather
// than "now" (the regular check-out endpoint below always stamps the current
// moment, which would be wrong for a session that's already a day or more
// old). No GPS required: this isn't happening live at the office.
router.post('/me/attendance/check-out-late', async (req, res, next) => {
  try {
    res.json(await HrService.selfCheckOutForOpenSession(req.user.id, req.orgId, req.body.checkOutTime));
  } catch (e) { next(e); }
});

router.get('/me/attendance/status', async (req, res, next) => {
  try {
    res.json(await HrService.getSelfAttendanceStatus(req.user.id, req.orgId));
  } catch (e) { next(e); }
});

router.get('/me/attendance', async (req, res, next) => {
  try {
    const { Worker, Attendance } = require('../models');
    const { month, page, limit } = req.query;
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const where = { workerId: worker.id };
    // Op.like silently matches nothing against a DATEONLY column (Sequelize routes it
    // through moment's date parser, which rejects the '%' wildcard) — use a real date
    // range instead, same as the admin-facing listAttendance query.
    if (month) {
      const [year, m] = month.split('-');
      const daysInMonth = new Date(parseInt(year, 10), parseInt(m, 10), 0).getDate();
      where.date = { [Op.between]: [`${year}-${m}-01`, `${year}-${m}-${String(daysInMonth).padStart(2, '0')}`] };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, parseInt(limit, 10) || 50);
    const offset = (pageNum - 1) * limitNum;

    const { count, rows } = await Attendance.findAndCountAll({
      where, order: [['date', 'DESC']], limit: limitNum, offset,
    });
    res.json({ data: rows, total: count, page: pageNum, totalPages: Math.ceil(count / limitNum) || 1, limit: limitNum });
  } catch (e) { next(e); }
});

router.get('/me/leaves', async (req, res, next) => {
  try {
    const { Worker, LeaveRequest } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const leaves = await LeaveRequest.findAll({ where: { workerId: worker.id }, order: [['fromDate', 'DESC']] });
    res.json(leaves);
  } catch (e) { next(e); }
});

router.get('/me/leave-balance', async (req, res, next) => {
  try {
    res.json(await HrService.getEmployeeLeaveBalance(req.user.id, req.orgId));
  } catch (e) { next(e); }
});

router.get('/me/appraisals', async (req, res, next) => {
  try {
    const { Worker } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    res.json(await HrService.listAppraisals(worker.id, req.orgId));
  } catch (e) { next(e); }
});

router.post('/me/leaves', async (req, res, next) => {
  try {
    const leave = await HrService.createEmployeeLeaveRequest(req.user.id, req.orgId, req.body);
    res.status(201).json(leave);
  } catch (e) { next(e); }
});

// ─── Contractor invoice self-service ─────────────────────────────────────────
router.get('/me/contractor-invoices', async (req, res, next) => {
  try {
    const { Worker, ContractorInvoice } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    const invoices = await ContractorInvoice.findAll({
      where: { workerId: worker.id, orgId: req.orgId },
      order: [['createdAt', 'DESC']],
    });
    res.json(invoices);
  } catch (e) { next(e); }
});

router.post('/me/contractor-invoices', async (req, res, next) => {
  try {
    const { Worker, ContractorInvoice } = require('../models');
    const worker = await Worker.findOne({ where: { userId: req.user.id, orgId: req.orgId } });
    if (!worker) return res.status(404).json({ message: 'No worker profile linked to your account.' });
    if (worker.workerType !== 'contractor') return res.status(403).json({ message: 'Only contractors can submit invoices.' });
    const { period, amount, currency, description, fileUrl } = req.body;
    if (!period || !amount) return res.status(400).json({ message: 'period and amount are required.' });
    const invoice = await ContractorInvoice.create({
      orgId: req.orgId, workerId: worker.id, period, amount,
      currency: currency || worker.currency || 'PKR',
      description: description || null,
      fileUrl: fileUrl || null,
      status: 'submitted',
    });
    res.status(201).json(invoice);
  } catch (e) { next(e); }
});

module.exports = router;
