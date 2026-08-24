const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { activeWhere, setActive } = require('./SoftDeleteService');

const { Worker, User, Role, ShiftSchedule, ExportTemplate } = db;

/**
 * Admin → Export Data.
 *
 * Turns a chosen set of employees plus a chosen set of columns into a CSV. The
 * column list is data (the catalog below), not code branches — adding an
 * exportable field means adding one entry here, and every consumer (the field
 * picker on the frontend, preset validation, saved templates, the CSV writer)
 * follows automatically.
 *
 * Two rules the rest of this file exists to enforce:
 *   • Nothing leaves the org. Every query is org-scoped, and the worker ids the
 *     caller asks for are re-resolved against that scope rather than trusted.
 *   • The identity column is not optional. `locked: true` fields are always
 *     included and always come first, so a bank-details sheet can never come
 *     out as a list of account numbers with no name attached to them.
 *
 * The route is a POST (see routes/exports.js) so that exporting bank details
 * lands in the Activity Log — middleware/activityLogger only records mutating
 * verbs, and an export of everyone's salary and IBAN is exactly the kind of
 * thing an audit trail should show.
 */

function notFound(message = 'Export template not found.') {
  return Object.assign(new Error(message), { status: 404 });
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

// ─── Employee field catalog ───────────────────────────────────────────────────

const GROUPS = [
  { key: 'identity',   label: 'Identity' },
  { key: 'contact',    label: 'Contact' },
  { key: 'employment', label: 'Employment' },
  { key: 'salary',     label: 'Salary' },
  { key: 'bank',       label: 'Bank Details' },
];

function fmtDate(v) {
  if (!v) return '';
  // DATEONLY comes back as 'YYYY-MM-DD' already; DATE comes back as a Date.
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function titleCase(v) {
  return String(v || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Every exportable employee column.
 *
 * `sensitive` drives the warning the export screen shows before a download —
 * it does not gate anything on its own (the whole module is already behind
 * admin.access + hr.read), it just makes it obvious what is about to leave the
 * system in a plaintext file.
 */
const EMPLOYEE_FIELDS = [
  { key: 'employeeName',     label: 'Employee Name',      group: 'identity',   locked: true, value: (w) => w.user?.name },
  { key: 'employeeEmail',    label: 'Work Email',         group: 'identity',   value: (w) => w.user?.email },
  { key: 'roleName',         label: 'System Role',        group: 'identity',   value: (w) => w.user?.role?.name },
  { key: 'cnic',             label: 'CNIC / National ID', group: 'identity',   sensitive: true, value: (w) => w.cnic },
  { key: 'dateOfBirth',      label: 'Date of Birth',      group: 'identity',   sensitive: true, value: (w) => fmtDate(w.dateOfBirth) },

  { key: 'phone',            label: 'Phone',              group: 'contact',    value: (w) => w.user?.phone },
  { key: 'address',          label: 'Address',            group: 'contact',    sensitive: true, value: (w) => w.address },
  { key: 'emergencyContact', label: 'Emergency Contact',  group: 'contact',    value: (w) => w.emergencyContact },
  { key: 'emergencyPhone',   label: 'Emergency Phone',    group: 'contact',    value: (w) => w.emergencyPhone },

  { key: 'designation',      label: 'Designation',        group: 'employment', value: (w) => w.designation },
  { key: 'department',       label: 'Department',         group: 'employment', value: (w) => w.department },
  { key: 'workerType',       label: 'Worker Type',        group: 'employment', value: (w) => titleCase(w.workerType) },
  { key: 'status',           label: 'Status',             group: 'employment', value: (w) => titleCase(w.status) },
  { key: 'joiningDate',      label: 'Joining Date',       group: 'employment', value: (w) => fmtDate(w.joiningDate) },
  { key: 'probationEndDate', label: 'Probation End Date', group: 'employment', value: (w) => fmtDate(w.probationEndDate) },
  { key: 'confirmationDate', label: 'Confirmation Date',  group: 'employment', value: (w) => fmtDate(w.confirmationDate) },
  { key: 'shiftSchedule',    label: 'Shift Schedule',     group: 'employment', value: (w) => w.shiftSchedule?.label },

  { key: 'payModel',         label: 'Pay Model',          group: 'salary',     value: (w) => titleCase(w.payModel) },
  { key: 'salaryBase',       label: 'Base Salary',        group: 'salary',     sensitive: true, value: (w) => (w.salaryBase == null ? '' : String(w.salaryBase)) },

  { key: 'bankName',         label: 'Bank Name',          group: 'bank',       value: (w) => w.bankName },
  { key: 'bankBranchName',   label: 'Branch Name',        group: 'bank',       value: (w) => w.bankBranchName },
  { key: 'bankBranchCity',   label: 'Branch City',        group: 'bank',       value: (w) => w.bankBranchCity },
  { key: 'bankAccountTitle', label: 'Account Title',      group: 'bank',       value: (w) => w.bankAccountTitle },
  { key: 'bankAccountNumber', label: 'Account Number',    group: 'bank',       sensitive: true, value: (w) => w.bankAccountNumber },
  { key: 'iban',             label: 'IBAN',               group: 'bank',       sensitive: true, value: (w) => w.iban },
  { key: 'currency',         label: 'Currency',           group: 'bank',       value: (w) => w.currency },
];

const FIELD_BY_KEY = new Map(EMPLOYEE_FIELDS.map((f) => [f.key, f]));
const LOCKED_KEYS = EMPLOYEE_FIELDS.filter((f) => f.locked).map((f) => f.key);

function keysInGroup(group) {
  return EMPLOYEE_FIELDS.filter((f) => f.group === group).map((f) => f.key);
}

/**
 * One-click column sets. `bank_details` is the default the screen opens on —
 * the original ask was "export everyone's bank details", so that arrives with
 * every bank column already ticked and the rest left for the user to add.
 */
const EMPLOYEE_PRESETS = [
  {
    key: 'bank_details',
    label: 'Bank Details',
    description: 'Everything payroll needs to pay this person — bank, branch, account title, account number, IBAN.',
    isDefault: true,
    fields: keysInGroup('bank'),
  },
  {
    key: 'contact_directory',
    label: 'Contact Directory',
    description: 'Email, phone and emergency contact for each employee.',
    fields: [...keysInGroup('contact'), 'employeeEmail', 'designation', 'department'],
  },
  {
    key: 'employment_record',
    label: 'Employment Record',
    description: 'Designation, department, dates and current employment status.',
    fields: keysInGroup('employment'),
  },
  {
    key: 'payroll_sheet',
    label: 'Payroll Sheet',
    description: 'Salary and bank columns together — the disbursement view.',
    fields: [...keysInGroup('salary'), ...keysInGroup('bank'), 'designation', 'department'],
  },
  {
    key: 'full_profile',
    label: 'Full Profile',
    description: 'Every available column.',
    fields: EMPLOYEE_FIELDS.map((f) => f.key),
  },
];

/** The whole catalog, shaped for the field picker on the frontend. */
function getEmployeeSchema() {
  return {
    dataset: 'employees',
    groups: GROUPS.map((g) => ({
      ...g,
      fields: EMPLOYEE_FIELDS
        .filter((f) => f.group === g.key)
        .map(({ key, label, locked, sensitive }) => ({
          key, label, locked: !!locked, sensitive: !!sensitive,
        })),
    })),
    presets: EMPLOYEE_PRESETS.map(({ key, label, description, isDefault, fields }) => ({
      key, label, description, isDefault: !!isDefault, fields,
    })),
    lockedFields: LOCKED_KEYS,
  };
}

/**
 * Whitelist the requested columns, drop anything unrecognized, force the locked
 * ones in front, and keep the catalog's own ordering so two exports of the same
 * columns always come out with the same column order regardless of the order the
 * user happened to tick the boxes in.
 */
function resolveFields(requested) {
  const asked = new Set(
    (Array.isArray(requested) ? requested : [])
      .map((k) => String(k || '').trim())
      .filter((k) => FIELD_BY_KEY.has(k)),
  );
  LOCKED_KEYS.forEach((k) => asked.add(k));
  const resolved = EMPLOYEE_FIELDS.filter((f) => asked.has(f.key));
  if (resolved.length <= LOCKED_KEYS.length) {
    throw badRequest('Pick at least one column to export.');
  }
  return resolved;
}

// ─── Employee picker ──────────────────────────────────────────────────────────

const PICKER_INCLUDES = [
  {
    model: User,
    as: 'user',
    attributes: ['id', 'name', 'email', 'avatarUrl', 'isActive'],
    include: [{ model: Role, as: 'role', attributes: ['id', 'key', 'name'] }],
  },
];

/**
 * The selectable employees, already filtered the way the screen filters them.
 *
 * Unlike HrService#listWorkers this never backfills missing Worker rows — an
 * export screen is a read-only view and should not be creating records as a
 * side effect of being opened. Anyone missing here has simply never been
 * through HR, and will appear as soon as HR → Employees is opened once.
 */
async function listEmployees(orgId, { search, department, status, workerType } = {}) {
  const where = { orgId };
  if (department) where.department = department;
  if (status) where.status = status;
  if (workerType) where.workerType = workerType;

  const workers = await Worker.findAll({
    where,
    include: PICKER_INCLUDES,
    order: [[{ model: User, as: 'user' }, 'name', 'ASC']],
  });

  // Role 'client' users are portal contacts' staff counterparts, never employees.
  const rows = workers.filter((w) => w.user && w.user.role?.key !== 'client');

  const term = String(search || '').trim().toLowerCase();
  const matched = term
    ? rows.filter((w) => [w.user?.name, w.user?.email, w.designation, w.department]
      .some((v) => String(v || '').toLowerCase().includes(term)))
    : rows;

  return matched.map((w) => ({
    id: w.id,
    name: w.user?.name || '',
    email: w.user?.email || '',
    avatarUrl: w.user?.avatarUrl || null,
    designation: w.designation || '',
    department: w.department || '',
    status: w.status,
    workerType: w.workerType,
    // Lets the screen warn "3 of the selected employees have no bank details on
    // file" before producing a sheet full of blank account numbers.
    hasBankDetails: !!(w.bankAccountNumber || w.iban),
  }));
}

/** Distinct departments actually in use, for the picker's filter dropdown. */
async function listEmployeeFilters(orgId) {
  const rows = await Worker.findAll({
    where: { orgId },
    attributes: ['department'],
    group: ['department'],
    raw: true,
  });
  return {
    departments: rows.map((r) => r.department).filter(Boolean).sort(),
    statuses: ['invited', 'profile_pending', 'under_review', 'active', 'inactive', 'profile_amended'],
    workerTypes: ['employee', 'contractor'],
  };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

// Every cell is quoted, not just the ones that need it — same convention as the
// disbursement sheet in routes/hr.js, and it keeps leading zeros in account
// numbers from being eaten by a spreadsheet's number parser.
function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function toCsv(headers, rows) {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/**
 * Build the CSV for the given employees and columns.
 *
 * @param {string} orgId
 * @param {object} payload
 * @param {string[]} payload.workerIds  which employees — required, re-scoped to the org
 * @param {string[]} payload.fields     which columns — validated against the catalog
 * @returns {{ csv: string, filename: string, rowCount: number, fieldCount: number }}
 */
async function exportEmployees(orgId, { workerIds, fields } = {}) {
  const ids = [...new Set((Array.isArray(workerIds) ? workerIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
  if (!ids.length) throw badRequest('Select at least one employee to export.');

  const resolved = resolveFields(fields);

  const workers = await Worker.findAll({
    // `id: ids` narrows to the requested people; `orgId` is what makes a
    // guessed/stale id from another tenant come back empty instead of exporting
    // someone else's bank account.
    where: { orgId, id: ids },
    include: [
      ...PICKER_INCLUDES,
      { model: ShiftSchedule, as: 'shiftSchedule', attributes: ['id', 'label'], required: false },
    ],
    order: [[{ model: User, as: 'user' }, 'name', 'ASC']],
  });

  if (!workers.length) throw badRequest('None of the selected employees could be found.');

  const csv = toCsv(
    resolved.map((f) => f.label),
    workers.map((w) => resolved.map((f) => f.value(w))),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    // Prefixed with a BOM so Excel opens it as UTF-8 instead of mangling
    // non-ASCII names — same reason routes/messages.js does it for transcripts.
    csv: `﻿${csv}`,
    filename: `employees-export-${stamp}.csv`,
    rowCount: workers.length,
    fieldCount: resolved.length,
  };
}

// ─── Saved templates ──────────────────────────────────────────────────────────

function shapeTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    dataset: t.dataset,
    // Stored keys are filtered through the live catalog on the way out, so a
    // template saved before a field was removed silently loses that column
    // instead of sending the picker a key it can't render.
    fields: (Array.isArray(t.fields) ? t.fields : []).filter((k) => FIELD_BY_KEY.has(k)),
    isActive: t.isActive,
    createdBy: t.createdBy,
    creator: t.creator ? { id: t.creator.id, name: t.creator.name } : null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

async function listTemplates(orgId, query = {}) {
  const where = { orgId, ...activeWhere(ExportTemplate, query) };
  if (query.dataset) where.dataset = query.dataset;
  const rows = await ExportTemplate.findAll({
    where,
    include: [{ model: User, as: 'creator', attributes: ['id', 'name'] }],
    order: [['name', 'ASC']],
  });
  return rows.map(shapeTemplate);
}

async function createTemplate(orgId, userId, { name, dataset, fields } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw badRequest('Give the template a name.');
  // Validates and normalizes exactly like an export would, so a template can
  // never be saved in a state that fails at download time.
  const resolved = resolveFields(fields);

  const created = await ExportTemplate.create({
    id: uuidv4(),
    orgId,
    name: cleanName.slice(0, 255),
    dataset: String(dataset || 'employees'),
    fields: resolved.map((f) => f.key),
    createdBy: userId,
  });
  return shapeTemplate(created);
}

async function updateTemplate(id, orgId, { name, fields } = {}) {
  const tmpl = await ExportTemplate.findOne({ where: { id, orgId } });
  if (!tmpl) throw notFound();

  const patch = {};
  if (name !== undefined) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw badRequest('Give the template a name.');
    patch.name = cleanName.slice(0, 255);
  }
  if (fields !== undefined) patch.fields = resolveFields(fields).map((f) => f.key);

  await tmpl.update(patch);
  return shapeTemplate(tmpl);
}

/** Deactivates — never destroys. See services/SoftDeleteService.js. */
async function setTemplateActive(id, orgId, active) {
  const updated = await setActive(ExportTemplate, { id, orgId }, active, 'Export template not found.');
  return shapeTemplate(updated);
}

module.exports = {
  getEmployeeSchema,
  listEmployees,
  listEmployeeFilters,
  exportEmployees,
  listTemplates,
  createTemplate,
  updateTemplate,
  setTemplateActive,
};
