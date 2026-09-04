/**
 * The one query behind the Overview page — the org-wide command centre.
 *
 * Every other analytics endpoint answers one question for one screen. This
 * answers "what is the state of the whole company right now?" in a single
 * round trip, because the page it feeds is meant to be the first thing an
 * owner/admin opens in the morning: money, delivery, people, pipeline, the
 * approval queue, and the health of the servers themselves.
 *
 * Two rules kept this from becoming a slow page:
 *
 *  1. Count, don't fetch. Anything that only ever renders as a number uses
 *     COUNT (usually grouped) instead of loading rows and reducing in JS. Rows
 *     are only fetched where the UI actually lists them, and always with an
 *     explicit `limit` and `attributes`.
 *  2. Everything fans out under Promise.all. The sections are independent, so
 *     the page costs roughly one slow query, not the sum of forty.
 *
 * `getOverview` is org-scoped like every other tenant query (orgId on every
 * where clause — see middleware/tenancy.js); `getSystemHealth` deliberately is
 * not, because it describes the Node process and its dependencies rather than
 * any org's data, which is why the route gates it on admin.access.
 */

const os = require('os');
const http = require('http');
const https = require('https');
const { Op } = require('sequelize');
const db = require('../models');
const { formatPeriod } = require('../utils/formatPeriod');
const AnalyticsService = require('./AnalyticsService');
const ApprovalService = require('./ApprovalService');
const SlaService = require('./SlaService');
const schedulerRegistry = require('./schedulerRegistry');

// ─── Small helpers ────────────────────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

/** Local YYYY-MM-DD — DATEONLY columns are compared as local dates elsewhere. */
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(d, n) {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/**
 * `{ [column]: count }` for one grouped COUNT. Returns a plain object so a
 * missing status is simply absent rather than a zero row the caller has to
 * filter — every consumer reads it as `map.foo || 0`.
 */
async function countBy(model, where, column) {
  const rows = await model.findAll({
    where,
    attributes: [column, [db.sequelize.fn('COUNT', db.sequelize.col(column)), 'n']],
    group: [column],
    raw: true,
  });
  const out = {};
  for (const row of rows) {
    const key = row[column];
    if (key === null || key === undefined) continue;
    out[key] = Number(row.n) || 0;
  }
  return out;
}

const sumValues = (map) => Object.values(map || {}).reduce((a, b) => a + b, 0);

/** Total across currencies, for ranking only — never rendered as one figure. */
const approxTotal = (byCurrency) => Object.values(byCurrency || {}).reduce((a, b) => a + b, 0);

function addMoney(map, currency, amount) {
  const cur = currency || 'USD';
  const amt = parseFloat(amount || 0);
  if (!amt) return;
  map[cur] = (map[cur] || 0) + amt;
}

/** Most models carry an `isActive` soft-delete flag — nothing is ever hard-deleted. */
const LIVE = { isActive: true };

// ─── Money ────────────────────────────────────────────────────────────────────

// Statuses that mean "the client still owes us this". Mirrors the same list in
// AnalyticsService/ClientService — an invoice in payment_review has been
// claimed as paid by the client but not confirmed, so it is still receivable.
const OWED_STATUSES = ['sent', 'overdue', 'payment_review'];

// `amountPaid` as a correlated subquery rather than a join: an invoice with
// three payments would otherwise fan out to three rows and triple its own
// total. Same literal AnalyticsService uses.
const AMOUNT_PAID = [
  db.sequelize.literal('(SELECT COALESCE(SUM(`p`.`amount`),0) FROM `payments` `p` WHERE `p`.`invoiceId` = `Invoice`.`id`)'),
  'amountPaid',
];

async function getFinance(orgId) {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const today = dayKey(now);

  const [
    invoices, retainersByStatus, retainersDue, paymentsThisMonth, docsByStatus,
    paymentRows, personalByStatus, packageRows, clientNames,
  ] = await Promise.all([
    db.Invoice.findAll({
      where: { orgId },
      attributes: ['id', 'number', 'status', 'total', 'currency', 'issuedAt', 'dueAt', 'clientId', AMOUNT_PAID],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
    }),
    countBy(db.Retainer, { orgId, ...LIVE }, 'status'),
    db.Retainer.findAll({
      where: { orgId, ...LIVE, status: 'active', nextInvoiceDate: { [Op.lte]: dayKey(addDays(now, 7)) } },
      attributes: ['id', 'amount', 'currency', 'cycle', 'nextInvoiceDate'],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
      order: [['nextInvoiceDate', 'ASC']],
      limit: 10,
    }),
    // `payments` carries neither orgId nor a currency of its own — a payment is
    // only ever meaningful against its invoice, which is where both live. Hence
    // the required join rather than a flat where.
    db.Payment.findAll({
      where: { paidAt: { [Op.gte]: monthStart } },
      attributes: ['amount'],
      include: [{ model: db.Invoice, as: 'invoice', attributes: ['currency'], where: { orgId }, required: true }],
    }),
    countBy(db.CustomerDocument, { orgId }, 'status'),
    // Every payment ever, by provider — "how do clients actually pay us" is a
    // different question from "how much have they paid", and the answer decides
    // which payment methods are worth keeping switched on.
    db.Payment.findAll({
      attributes: ['provider', 'amount', 'processingFee'],
      include: [{ model: db.Invoice, as: 'invoice', attributes: ['currency'], where: { orgId }, required: true }],
    }).catch(() => []),
    countBy(db.PersonalInvoice, { orgId }, 'status').catch(() => ({})),
    // Sold packages are the recurring-revenue base sitting underneath the
    // one-off invoices; `soldPrice` is what the client actually pays, not list.
    db.ClientPackage.findAll({
      where: { orgId, status: 'active' },
      attributes: ['id', 'soldPrice', 'currency', 'billingCycle', 'status'],
      raw: true,
    }).catch(() => []),
    db.Client.findAll({ where: { orgId }, attributes: ['id', 'name'], raw: true }),
  ]);

  // ── One pass over the invoice set feeds every money figure on the page ──
  const byStatus = {};
  const revenueAllTime = {};
  const revenueThisMonth = {};
  const outstanding = {};
  const overdueAmount = {};
  // Receivables aging, by how long past due — "how bad is the outstanding
  // balance?" is unanswerable from a single total.
  const aging = { current: {}, d1_30: {}, d31_60: {}, d61_90: {}, d90_plus: {} };
  const clientRevenue = {};
  const owedByClient = {};
  const trendBuckets = new Map();

  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    trendBuckets.set(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, {
      label: d.toLocaleString('en', { month: 'short', year: '2-digit' }),
      count: 0,
      byCurrency: {},
      totalApprox: 0,
    });
  }

  const overdueInvoices = [];

  for (const inv of invoices) {
    byStatus[inv.status] = (byStatus[inv.status] || 0) + 1;
    const total = parseFloat(inv.total || 0);
    const paid = parseFloat(inv.get('amountPaid')) || 0;

    if (inv.status === 'paid') {
      addMoney(revenueAllTime, inv.currency, total);
      if (inv.issuedAt && new Date(inv.issuedAt) >= monthStart) addMoney(revenueThisMonth, inv.currency, total);

      const issued = inv.issuedAt ? new Date(inv.issuedAt) : null;
      if (issued) {
        const bucket = trendBuckets.get(`${issued.getFullYear()}-${pad(issued.getMonth() + 1)}`);
        if (bucket) {
          bucket.count += 1;
          addMoney(bucket.byCurrency, inv.currency, total);
          bucket.totalApprox += total;
        }
      }

      const cid = inv.clientId;
      if (!clientRevenue[cid]) clientRevenue[cid] = { id: cid, name: inv.client?.name || '—', byCurrency: {}, totalApprox: 0 };
      addMoney(clientRevenue[cid].byCurrency, inv.currency, total);
      clientRevenue[cid].totalApprox += total;
    }

    if (!OWED_STATUSES.includes(inv.status)) continue;

    const due = Math.max(0, total - paid);
    if (!due) continue;
    addMoney(outstanding, inv.currency, due);

    if (!owedByClient[inv.clientId]) owedByClient[inv.clientId] = { byCurrency: {}, count: 0, totalApprox: 0 };
    addMoney(owedByClient[inv.clientId].byCurrency, inv.currency, due);
    owedByClient[inv.clientId].count += 1;
    owedByClient[inv.clientId].totalApprox += due;

    // Age off `dueAt`. An invoice with no due date is treated as current rather
    // than silently landing in the worst bucket.
    const dueDay = inv.dueAt ? dayKey(new Date(inv.dueAt)) : null;
    const daysLate = dueDay && dueDay < today
      ? Math.floor((new Date(today) - new Date(dueDay)) / 86400000)
      : 0;

    if (daysLate <= 0) addMoney(aging.current, inv.currency, due);
    else if (daysLate <= 30) addMoney(aging.d1_30, inv.currency, due);
    else if (daysLate <= 60) addMoney(aging.d31_60, inv.currency, due);
    else if (daysLate <= 90) addMoney(aging.d61_90, inv.currency, due);
    else addMoney(aging.d90_plus, inv.currency, due);

    if (daysLate > 0 || inv.status === 'overdue') {
      addMoney(overdueAmount, inv.currency, due);
      overdueInvoices.push({
        id: inv.id,
        number: inv.number,
        client: inv.client?.name || '—',
        currency: inv.currency || 'USD',
        due,
        daysLate,
        dueAt: inv.dueAt,
      });
    }
  }

  overdueInvoices.sort((a, b) => b.daysLate - a.daysLate || b.due - a.due);

  const collectedThisMonth = {};
  for (const p of paymentsThisMonth) addMoney(collectedThisMonth, p.invoice?.currency, p.amount);

  // ── Who owes the most ──
  // The overdue list is per-invoice; a client with six small late invoices
  // never appears near the top of it but may be the biggest exposure.
  const nameOf = {};
  for (const c of clientNames) nameOf[c.id] = c.name;
  const debtors = Object.entries(owedByClient)
    .map(([id, entry]) => ({ id, name: nameOf[id] || '—', byCurrency: entry.byCurrency, count: entry.count, totalApprox: entry.totalApprox }))
    .sort((a, b) => b.totalApprox - a.totalApprox)
    .slice(0, 6);

  // ── How money arrives, and what the processor takes ──
  const byProvider = {};
  const feesByCurrency = {};
  for (const p of paymentRows) {
    const key = p.provider || 'manual';
    if (!byProvider[key]) byProvider[key] = { count: 0, byCurrency: {} };
    byProvider[key].count += 1;
    addMoney(byProvider[key].byCurrency, p.invoice?.currency, p.amount);
    addMoney(feesByCurrency, p.invoice?.currency, p.processingFee);
  }

  // ── Contracted recurring value, normalised to a monthly figure ──
  // Quarterly and annual packages are divided down so the number answers "what
  // lands in a typical month", which is the only way a mixed book compares.
  const MONTHLY_DIVISOR = { monthly: 1, quarterly: 3, annual: 12, yearly: 12 };
  const recurringMonthly = {};
  for (const cp of packageRows) {
    const divisor = MONTHLY_DIVISOR[cp.billingCycle] || 1;
    addMoney(recurringMonthly, cp.currency, parseFloat(cp.soldPrice || 0) / divisor);
  }

  return {
    invoices: { total: invoices.length, byStatus },
    revenue: { allTime: revenueAllTime, thisMonth: revenueThisMonth },
    collectedThisMonth,
    outstanding,
    overdueAmount,
    aging,
    revenueTrend: [...trendBuckets.values()],
    topClients: Object.values(clientRevenue).sort((a, b) => b.totalApprox - a.totalApprox).slice(0, 6),
    overdueInvoices: overdueInvoices.slice(0, 8),
    overdueInvoiceCount: overdueInvoices.length,
    retainers: {
      byStatus: retainersByStatus,
      dueSoon: retainersDue.map((r) => ({
        id: r.id,
        client: r.client?.name || '—',
        amount: parseFloat(r.amount || 0),
        currency: r.currency || 'USD',
        cycle: r.cycle,
        nextInvoiceDate: r.nextInvoiceDate,
      })),
    },
    documents: { byStatus: docsByStatus, total: sumValues(docsByStatus) },
    debtors,
    payments: { byProvider, feesByCurrency, total: paymentRows.length },
    personalInvoices: { byStatus: personalByStatus, total: sumValues(personalByStatus) },
    packages: { active: packageRows.length, recurringMonthly },
  };
}

// ─── Delivery (projects + tasks) ──────────────────────────────────────────────

// The workflow engine treats both as "finished" — a task through a review
// pipeline lands on `approved` without ever passing through `done`, and an
// ad-hoc task completed without a reviewer does the opposite. See
// workflow/engine.js ADVANCE_RULE.
const FINISHED_TASK_STATUSES = ['done', 'approved'];

async function getDelivery(orgId) {
  const now = new Date();
  const today = dayKey(now);
  const weekOut = dayKey(addDays(now, 7));
  const weekAgo = new Date(now.getTime() - 7 * 86400000);

  const [
    projectsByStatus, tasksByStatus, stages, activeProjects,
    overdueTaskCount, unassignedTaskCount, dueThisWeekTasks, tasksDoneThisWeek,
    onTime, slaRows, workload,
    tasksByType, openTaskRows, reviewRows, auditPending, recurringRules, artifactCount,
  ] = await Promise.all([
    countBy(db.Project, { orgId }, 'status'),
    countBy(db.Task, { orgId }, 'status'),
    db.Stage.findAll({ attributes: ['key', 'name', 'templateId'], raw: true }),
    db.Project.findAll({
      where: { orgId, status: { [Op.in]: ['active', 'on_hold', 'blocked'] } },
      attributes: ['id', 'name', 'status', 'currentStageKey', 'workflowTemplateId', 'serviceTypeKey', 'deliveryDate', 'updatedAt'],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
    }),
    db.Task.count({ where: { orgId, dueAt: { [Op.lt]: now }, status: { [Op.notIn]: FINISHED_TASK_STATUSES } } }),
    db.Task.count({ where: { orgId, assigneeId: null, status: { [Op.notIn]: FINISHED_TASK_STATUSES } } }),
    db.Task.count({
      where: {
        orgId,
        dueAt: { [Op.between]: [now, addDays(now, 7)] },
        status: { [Op.notIn]: FINISHED_TASK_STATUSES },
      },
    }),
    db.Task.count({ where: { orgId, status: { [Op.in]: FINISHED_TASK_STATUSES }, completedAt: { [Op.gte]: weekAgo } } }),
    AnalyticsService.getOnTimeDelivery(orgId).catch(() => null),
    SlaService.getSlaStatus(orgId).catch(() => []),
    getWorkload(orgId),
    countBy(db.Task, { orgId }, 'type'),
    // Every open task's age and project, for the aging buckets and the
    // "which project is soaking up the team" table. Two derived views off one
    // read rather than two more COUNT queries.
    db.Task.findAll({
      where: { orgId, status: { [Op.notIn]: FINISHED_TASK_STATUSES } },
      attributes: ['id', 'projectId', 'createdAt'],
      raw: true,
    }),
    db.Task.findAll({
      where: { orgId, status: { [Op.in]: ['submitted', 'in_review'] }, reviewerId: { [Op.ne]: null } },
      attributes: ['reviewerId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['reviewerId'],
      raw: true,
    }),
    db.Task.count({ where: { orgId, requiresTechnicalAudit: true, auditStatus: 'pending' } }),
    db.RecurringTaskRule.count({ where: { orgId, isActive: true } }).catch(() => 0),
    db.Artifact.count({ where: { isActive: true }, include: [{ model: db.Project, as: 'project', attributes: [], where: { orgId }, required: true }], distinct: true, col: 'id' }).catch(() => 0),
  ]);

  // Stage keys are only unique within a template, so index by template:key —
  // two pipelines can both have a "review" stage meaning different things.
  const stageName = {};
  for (const s of stages) stageName[`${s.templateId}:${s.key}`] = s.name;

  const byStage = {};
  const overdueProjects = [];
  const dueSoonProjects = [];
  let blocked = 0;
  let onHold = 0;

  for (const p of activeProjects) {
    if (p.status === 'blocked') blocked += 1;
    if (p.status === 'on_hold') onHold += 1;

    const key = p.currentStageKey || 'unassigned';
    if (!byStage[key]) {
      byStage[key] = { key, name: stageName[`${p.workflowTemplateId}:${key}`] || key, count: 0 };
    }
    byStage[key].count += 1;

    if (!p.deliveryDate) continue;
    const row = {
      id: p.id,
      name: p.name,
      client: p.client?.name || '—',
      status: p.status,
      stage: stageName[`${p.workflowTemplateId}:${p.currentStageKey}`] || p.currentStageKey,
      deliveryDate: p.deliveryDate,
      daysLate: Math.floor((new Date(today) - new Date(p.deliveryDate)) / 86400000),
    };
    if (p.deliveryDate < today) overdueProjects.push(row);
    else if (p.deliveryDate <= weekOut) dueSoonProjects.push(row);
  }

  overdueProjects.sort((a, b) => b.daysLate - a.daysLate);
  dueSoonProjects.sort((a, b) => (a.deliveryDate < b.deliveryDate ? -1 : 1));

  const openTasks = sumValues(tasksByStatus)
    - FINISHED_TASK_STATUSES.reduce((n, s) => n + (tasksByStatus[s] || 0), 0);

  // ── How long open work has been sitting ──
  // Age, not due date: a task with no deadline can still be three weeks stale,
  // and "nothing is overdue" hides exactly that.
  const aging = { d0_1: 0, d1_3: 0, d3_7: 0, d7_14: 0, d14_plus: 0 };
  const perProject = {};
  for (const t of openTaskRows) {
    const days = (now - new Date(t.createdAt)) / 86400000;
    if (days < 1) aging.d0_1 += 1;
    else if (days < 3) aging.d1_3 += 1;
    else if (days < 7) aging.d3_7 += 1;
    else if (days < 14) aging.d7_14 += 1;
    else aging.d14_plus += 1;
    if (t.projectId) perProject[t.projectId] = (perProject[t.projectId] || 0) + 1;
  }

  const projectName = {};
  for (const p of activeProjects) projectName[p.id] = { name: p.name, client: p.client?.name || '—' };
  const busiestProjects = Object.entries(perProject)
    .filter(([id]) => projectName[id])
    .map(([id, count]) => ({ id, name: projectName[id].name, client: projectName[id].client, openTasks: count }))
    .sort((a, b) => b.openTasks - a.openTasks)
    .slice(0, 8);

  const workloadById = {};
  for (const w of workload) workloadById[w.id] = w.name;
  const reviewerLoad = reviewRows
    .map((r) => ({ id: r.reviewerId, name: workloadById[r.reviewerId] || 'Unknown', awaiting: Number(r.n) || 0 }))
    .sort((a, b) => b.awaiting - a.awaiting)
    .slice(0, 8);

  return {
    projects: { byStatus: projectsByStatus, total: sumValues(projectsByStatus) },
    tasks: {
      byStatus: tasksByStatus,
      total: sumValues(tasksByStatus),
      open: openTasks,
      overdue: overdueTaskCount,
      unassigned: unassignedTaskCount,
      dueThisWeek: dueThisWeekTasks,
      completedThisWeek: tasksDoneThisWeek,
      byType: tasksByType,
      aging,
      auditPending,
    },
    byStage: Object.values(byStage).sort((a, b) => b.count - a.count),
    overdueProjects: overdueProjects.slice(0, 8),
    overdueProjectCount: overdueProjects.length,
    dueSoonProjects: dueSoonProjects.slice(0, 8),
    dueSoonProjectCount: dueSoonProjects.length,
    blocked,
    onHold,
    onTimeDelivery: onTime,
    sla: {
      breached: slaRows.filter((s) => s.slaStatus === 'breached').length,
      atRisk: slaRows.filter((s) => s.slaStatus === 'at_risk').length,
      items: slaRows.filter((s) => s.slaStatus !== 'ok').slice(0, 8),
    },
    workload,
    busiestProjects,
    reviewerLoad,
    recurringRules,
    artifacts: artifactCount,
  };
}

/**
 * Per-person load: open tasks, how many are already late, and how many active
 * projects they own a role slot on. This is the "who is drowning / who is idle"
 * table, so it deliberately lists every active staff user, including the ones
 * with nothing on their plate.
 */
async function getWorkload(orgId) {
  const [users, openRows, lateRows, projectRows] = await Promise.all([
    db.User.findAll({
      where: { orgId, isActive: true },
      attributes: ['id', 'name', 'email'],
      include: [{ model: db.Role, as: 'role', attributes: ['id', 'name', 'key'] }],
    }),
    db.Task.findAll({
      where: { orgId, assigneeId: { [Op.ne]: null }, status: { [Op.notIn]: FINISHED_TASK_STATUSES } },
      attributes: ['assigneeId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['assigneeId'],
      raw: true,
    }),
    db.Task.findAll({
      where: {
        orgId,
        assigneeId: { [Op.ne]: null },
        status: { [Op.notIn]: FINISHED_TASK_STATUSES },
        dueAt: { [Op.lt]: new Date() },
      },
      attributes: ['assigneeId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['assigneeId'],
      raw: true,
    }),
    db.ProjectAssignment.findAll({
      attributes: ['userId', 'projectId'],
      include: [{ model: db.Project, as: 'project', attributes: [], where: { orgId, status: 'active' }, required: true }],
      raw: true,
    }),
  ]);

  const open = {};
  for (const r of openRows) open[r.assigneeId] = Number(r.n) || 0;
  const late = {};
  for (const r of lateRows) late[r.assigneeId] = Number(r.n) || 0;

  // A user can hold several role slots on one project; count the project once.
  const projects = {};
  const seen = new Set();
  for (const r of projectRows) {
    const pair = `${r.userId}:${r.projectId}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    projects[r.userId] = (projects[r.userId] || 0) + 1;
  }

  return users
    .map((u) => ({
      id: u.id,
      name: u.name,
      role: u.role?.name || '—',
      openTasks: open[u.id] || 0,
      overdueTasks: late[u.id] || 0,
      activeProjects: projects[u.id] || 0,
    }))
    .sort((a, b) => b.overdueTasks - a.overdueTasks
      || b.openTasks - a.openTasks
      || String(a.name).localeCompare(String(b.name)));
}

// ─── People (HR) ──────────────────────────────────────────────────────────────

async function getPeople(orgId) {
  const now = new Date();
  const today = dayKey(now);
  const in30 = dayKey(addDays(now, 30));

  const [
    workers, attendanceToday, leaveByStatus, upcomingLeave,
    payrollRuns, contractorByStatus, hrDocsByStatus, probationEnding,
    attendanceHistory, leaveByType, upcomingHolidays, recentAppraisals, workerUsers,
  ] = await Promise.all([
    db.Worker.findAll({
      where: { orgId },
      attributes: ['id', 'status', 'workerType', 'department', 'joiningDate', 'probationEndDate'],
      raw: true,
    }),
    db.Attendance.findAll({
      where: { orgId, date: today },
      attributes: ['status', 'isLate'],
      raw: true,
    }),
    countBy(db.LeaveRequest, { orgId }, 'status'),
    db.LeaveRequest.findAll({
      where: { orgId, status: 'approved', fromDate: { [Op.between]: [today, in30] } },
      attributes: ['id', 'type', 'fromDate', 'toDate', 'days'],
      include: [{
        model: db.Worker,
        as: 'worker',
        attributes: ['id'],
        include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
      }],
      order: [['fromDate', 'ASC']],
      limit: 8,
    }),
    db.PayrollRun.findAll({
      where: { orgId },
      attributes: ['id', 'period', 'status', 'createdAt', 'paidAt'],
      order: [['period', 'DESC']],
      limit: 3,
      raw: true,
    }),
    countBy(db.ContractorInvoice, { orgId }, 'status'),
    countBy(db.HrDocument, { orgId }, 'status'),
    db.Worker.count({
      where: { orgId, status: 'active', probationEndDate: { [Op.between]: [today, in30] } },
    }),
    // Two weeks of attendance, for the trend strip and the late-arrival tally.
    // Bounded by definition (headcount × 14), so it is cheap to read whole.
    db.Attendance.findAll({
      where: { orgId, date: { [Op.between]: [dayKey(addDays(now, -13)), today] } },
      attributes: ['date', 'status', 'isLate', 'lateMinutes', 'workerId'],
      raw: true,
    }),
    countBy(db.LeaveRequest, { orgId }, 'type'),
    db.Holiday.findAll({
      where: { orgId, isActive: true, date: { [Op.between]: [today, dayKey(addDays(now, 60))] } },
      attributes: ['id', 'name', 'date', 'endDate'],
      order: [['date', 'ASC']],
      limit: 5,
      raw: true,
    }).catch(() => []),
    db.Appraisal.findAll({
      where: { orgId },
      attributes: ['id', 'workerId', 'reviewDate', 'rating', 'salaryBefore', 'salaryAfter'],
      order: [['reviewDate', 'DESC']],
      limit: 5,
      raw: true,
    }).catch(() => []),
    // One join to put a human name on every worker id used below.
    db.Worker.findAll({
      where: { orgId },
      attributes: ['id', 'salaryBase', 'currency', 'department', 'joiningDate', 'status'],
      include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
    }),
  ]);

  const byStatus = {};
  const byType = {};
  const byDepartment = {};
  for (const w of workers) {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1;
    if (w.status !== 'active') continue;
    byType[w.workerType] = (byType[w.workerType] || 0) + 1;
    const dept = (w.department || '').trim() || 'Unassigned';
    byDepartment[dept] = (byDepartment[dept] || 0) + 1;
  }

  const attendance = { present: 0, absent: 0, leave: 0, half_day: 0, holiday: 0, weekend: 0, late: 0 };
  for (const a of attendanceToday) {
    if (attendance[a.status] !== undefined) attendance[a.status] += 1;
    if (a.isLate) attendance.late += 1;
  }
  // Active staff with no attendance row yet today. The absent-marking scheduler
  // only fills these in after the day's cutoff, so before then "unmarked" is
  // genuinely different from "absent" and must not be reported as it.
  const activeHeadcount = byStatus.active || 0;
  attendance.unmarked = Math.max(0, activeHeadcount - attendanceToday.length);
  attendance.headcount = activeHeadcount;

  // ── Two-week attendance trend + who is repeatedly late ──
  const nameOfWorker = {};
  const salaryByDepartment = {};
  for (const w of workerUsers) {
    nameOfWorker[w.id] = w.user?.name || 'Unknown';
    if (w.status !== 'active') continue;
    const dept = (w.department || '').trim() || 'Unassigned';
    if (!salaryByDepartment[dept]) salaryByDepartment[dept] = {};
    addMoney(salaryByDepartment[dept], w.currency, w.salaryBase);
  }

  const trendByDay = new Map();
  for (let i = 13; i >= 0; i--) {
    const key = dayKey(addDays(now, -i));
    trendByDay.set(key, { date: key, present: 0, absent: 0, leave: 0, other: 0, late: 0 });
  }
  const lateTally = {};
  for (const a of attendanceHistory) {
    const bucket = trendByDay.get(String(a.date));
    if (bucket) {
      if (a.status === 'present') bucket.present += 1;
      else if (a.status === 'absent') bucket.absent += 1;
      else if (a.status === 'leave') bucket.leave += 1;
      else bucket.other += 1;
      if (a.isLate) bucket.late += 1;
    }
    if (a.isLate) {
      if (!lateTally[a.workerId]) lateTally[a.workerId] = { count: 0, minutes: 0 };
      lateTally[a.workerId].count += 1;
      lateTally[a.workerId].minutes += Number(a.lateMinutes) || 0;
    }
  }
  const lateLeaders = Object.entries(lateTally)
    .map(([id, v]) => ({ id, name: nameOfWorker[id] || 'Unknown', count: v.count, minutes: v.minutes }))
    .sort((a, b) => b.count - a.count || b.minutes - a.minutes)
    .slice(0, 6);

  // ── Work anniversaries and probation confirmations coming up ──
  // Anniversary matching ignores the year: a 2023 joiner has one every year.
  const milestones = [];
  const windowEnd = addDays(now, 30);
  for (const w of workerUsers) {
    if (w.status !== 'active' || !w.joiningDate) continue;
    const joined = new Date(w.joiningDate);
    const thisYear = new Date(now.getFullYear(), joined.getMonth(), joined.getDate());
    const target = thisYear < now ? new Date(now.getFullYear() + 1, joined.getMonth(), joined.getDate()) : thisYear;
    if (target > windowEnd) continue;
    const years = target.getFullYear() - joined.getFullYear();
    if (years <= 0) continue;
    milestones.push({ id: w.id, name: nameOfWorker[w.id], date: dayKey(target), years });
  }
  milestones.sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    headcount: {
      total: workers.length,
      active: activeHeadcount,
      byStatus,
      byType,
      byDepartment: Object.entries(byDepartment)
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    },
    attendanceToday: attendance,
    leave: {
      byStatus: leaveByStatus,
      pending: leaveByStatus.requested || 0,
      upcoming: upcomingLeave.map((l) => ({
        id: l.id,
        name: l.worker?.user?.name || 'Unknown',
        type: l.type,
        fromDate: l.fromDate,
        toDate: l.toDate,
        days: parseFloat(l.days || 0),
      })),
    },
    payroll: payrollRuns.map((r) => ({
      id: r.id,
      period: r.period,
      periodLabel: formatPeriod(r.period),
      status: r.status,
      paidAt: r.paidAt,
    })),
    contractorInvoices: contractorByStatus,
    hrDocuments: hrDocsByStatus,
    probationEndingSoon: probationEnding,
    attendanceTrend: [...trendByDay.values()],
    lateLeaders,
    leaveByType,
    salaryByDepartment: Object.entries(salaryByDepartment)
      .map(([label, byCurrency]) => ({ label, byCurrency }))
      .sort((a, b) => approxTotal(b.byCurrency) - approxTotal(a.byCurrency)),
    upcomingHolidays,
    appraisals: recentAppraisals.map((a) => ({
      id: a.id,
      name: nameOfWorker[a.workerId] || 'Unknown',
      reviewDate: a.reviewDate,
      rating: a.rating,
      salaryBefore: a.salaryBefore ? parseFloat(a.salaryBefore) : null,
      salaryAfter: a.salaryAfter ? parseFloat(a.salaryAfter) : null,
    })),
    milestones: milestones.slice(0, 6),
  };
}

// ─── Growth (clients, leads, client requests) ────────────────────────────────

async function getGrowth(orgId) {
  const now = new Date();
  const monthStart = startOfMonth(now);

  const [
    clientsByStatus, leadsByStatus, leadRows, newClientsThisMonth, requestsByStatus,
    leadAssigneeRows, contactRows, recentRequests, staffNames,
  ] = await Promise.all([
    countBy(db.Client, { orgId, ...LIVE }, 'status'),
    countBy(db.Lead, { orgId, ...LIVE }, 'status'),
    db.Lead.findAll({
      where: { orgId, ...LIVE },
      attributes: ['source', 'status', 'createdAt'],
      raw: true,
    }),
    db.Client.count({ where: { orgId, ...LIVE, createdAt: { [Op.gte]: monthStart } } }),
    countBy(db.ClientRequest, { orgId }, 'status'),
    db.Lead.findAll({
      where: { orgId, isActive: true, assignedToUserId: { [Op.ne]: null } },
      attributes: ['assignedToUserId', [db.sequelize.fn('COUNT', db.sequelize.col('id')), 'n']],
      group: ['assignedToUserId'],
      raw: true,
    }),
    // Portal adoption: a client contact who never logs in is a client who
    // emails you instead, so the ratio is an operating cost, not a vanity stat.
    db.Contact.findAll({
      attributes: ['id', 'portalAccess'],
      include: [{ model: db.Client, as: 'client', attributes: [], where: { orgId }, required: true }],
      raw: true,
    }).catch(() => []),
    db.ClientRequest.findAll({
      where: { orgId },
      attributes: ['id', 'status', 'createdAt', 'projectId'],
      order: [['createdAt', 'DESC']],
      limit: 6,
      raw: true,
    }).catch(() => []),
    db.User.findAll({ where: { orgId }, attributes: ['id', 'name'], raw: true }),
  ]);

  const bySource = {};
  const trendBuckets = new Map();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    trendBuckets.set(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`, {
      label: d.toLocaleString('en', { month: 'short', year: '2-digit' }),
      value: 0,
      converted: 0,
    });
  }

  for (const l of leadRows) {
    const src = (l.source || '').trim() || 'unknown';
    bySource[src] = (bySource[src] || 0) + 1;
    const created = new Date(l.createdAt);
    const bucket = trendBuckets.get(`${created.getFullYear()}-${pad(created.getMonth() + 1)}`);
    if (bucket) {
      bucket.value += 1;
      if (l.status === 'converted') bucket.converted += 1;
    }
  }

  const totalLeads = leadRows.length;
  const converted = leadsByStatus.converted || 0;

  const staffName = {};
  for (const u of staffNames) staffName[u.id] = u.name;
  const byAssignee = leadAssigneeRows
    .map((r) => ({ id: r.assignedToUserId, name: staffName[r.assignedToUserId] || 'Unknown', value: Number(r.n) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
  const unassignedLeads = totalLeads - byAssignee.reduce((n, a) => n + a.value, 0);

  const portalEnabled = contactRows.filter((c) => c.portalAccess).length;

  return {
    clients: {
      byStatus: clientsByStatus,
      total: sumValues(clientsByStatus),
      newThisMonth: newClientsThisMonth,
    },
    leads: {
      byStatus: leadsByStatus,
      bySource: Object.entries(bySource).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
      total: totalLeads,
      converted,
      // Guarded against an empty pipeline rather than rendering NaN%.
      conversionRate: totalLeads ? Math.round((converted / totalLeads) * 100) : 0,
      trend: [...trendBuckets.values()],
      byAssignee,
      unassigned: Math.max(0, unassignedLeads),
    },
    clientRequests: requestsByStatus,
    recentRequests,
    portal: {
      contacts: contactRows.length,
      enabled: portalEnabled,
      pct: contactRows.length ? Math.round((portalEnabled / contactRows.length) * 100) : 0,
    },
  };
}

// ─── SEO delivery ─────────────────────────────────────────────────────────────

// The SEO deliverable tables (keywords, backlinks, content, blogs) have no
// orgId of their own — they hang off a Project, which is where tenancy lives.
// Resolving the org's project ids once and filtering on `projectId IN (...)`
// keeps these as plain grouped COUNTs; joining Project into each instead would
// make `status` ambiguous (Project has one too) in every one of them.
async function getSeo(orgId) {
  const projectIds = (await db.Project.findAll({
    where: { orgId }, attributes: ['id'], raw: true,
  })).map((p) => p.id);

  if (!projectIds.length) {
    return {
      keywords: { byStatus: {}, total: 0, rankBuckets: {}, ranked: 0 },
      keywordBatches: {},
      backlinks: { total: 0, byType: {}, indexed: 0, indexedPct: 0, avgDa: null },
      contentSubmissions: {},
      contentImplementation: {},
      blogTasks: {},
      gmb: {},
    };
  }

  const scope = { projectId: { [Op.in]: projectIds } };
  const now = new Date();
  const [keywords, batches, backlinkRows, content, blogs, snapshots, gmbByStatus, implementation] = await Promise.all([
    countBy(db.Keyword, scope, 'status'),
    countBy(db.KeywordBatch, scope, 'status'),
    db.Backlink.findAll({ where: { ...scope, isActive: true }, attributes: ['linkType', 'isIndexed', 'da'], raw: true }),
    countBy(db.ContentSubmission, scope, 'status'),
    countBy(db.BlogTask, scope, 'status'),
    // Ranking positions come from RankSnapshot, not Keyword — a keyword has no
    // "current position" column, only a history. Ninety days is far enough back
    // that every tracked keyword has at least one reading, and the latest row
    // per keyword is the one that counts.
    db.RankSnapshot.findAll({
      where: { orgId, date: { [Op.gte]: dayKey(addDays(now, -90)) } },
      attributes: ['keywordId', 'position', 'date'],
      order: [['date', 'DESC']],
      raw: true,
    }).catch(() => []),
    countBy(db.GmbProfile, { orgId }, 'status').catch(() => ({})),
    countBy(db.ContentSubmission, scope, 'implementationStatus').catch(() => ({})),
  ]);

  // ── Where the tracked keywords actually rank ──
  const latestByKeyword = new Map();
  for (const snap of snapshots) {
    if (!latestByKeyword.has(snap.keywordId)) latestByKeyword.set(snap.keywordId, snap.position);
  }
  const rankBuckets = { top3: 0, top10: 0, top30: 0, beyond30: 0, unranked: 0 };
  for (const position of latestByKeyword.values()) {
    const p = Number(position);
    if (!p || p <= 0) rankBuckets.unranked += 1;
    else if (p <= 3) rankBuckets.top3 += 1;
    else if (p <= 10) rankBuckets.top10 += 1;
    else if (p <= 30) rankBuckets.top30 += 1;
    else rankBuckets.beyond30 += 1;
  }

  const backlinksByType = {};
  let indexed = 0;
  let daSum = 0;
  let daCount = 0;
  for (const b of backlinkRows) {
    const key = b.linkType || 'other';
    backlinksByType[key] = (backlinksByType[key] || 0) + 1;
    if (b.isIndexed) indexed += 1;
    const da = Number(b.da);
    if (Number.isFinite(da) && da > 0) { daSum += da; daCount += 1; }
  }

  return {
    keywords: { byStatus: keywords, total: sumValues(keywords), rankBuckets, ranked: latestByKeyword.size },
    keywordBatches: batches,
    backlinks: {
      total: backlinkRows.length,
      byType: backlinksByType,
      indexed,
      indexedPct: backlinkRows.length ? Math.round((indexed / backlinkRows.length) * 100) : 0,
      avgDa: daCount ? Math.round((daSum / daCount) * 10) / 10 : null,
    },
    contentSubmissions: content,
    contentImplementation: implementation,
    blogTasks: blogs,
    gmb: gmbByStatus,
  };
}

// ─── Done (finished work) ────────────────────────────────────────────────────

/**
 * What the company has actually shipped, as opposed to what it owes.
 *
 * Every other section of this page is a queue - things not yet finished. That
 * makes the whole page read as a list of failures in a week where the team did
 * fine, so this is the counterweight: throughput over time, what closed, and
 * who closed it. It is also the only section that answers "are we speeding up?".
 */
async function getDone(orgId) {
  const now = new Date();
  const monthStart = startOfMonth(now);
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthAgo = new Date(now.getTime() - 30 * 86400000);
  // Eight weeks back, aligned to whole local days so a bucket boundary never
  // lands mid-afternoon and splits one day's work across two bars.
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 55);

  const [
    finishedTasks, completedProjects, paidInvoices, stageEvents,
    approvedLeaves, signedDocuments, approvedContent, approvedBlogs, staffNames,
  ] = await Promise.all([
    db.Task.findAll({
      where: { orgId, status: { [Op.in]: FINISHED_TASK_STATUSES }, completedAt: { [Op.gte]: windowStart } },
      attributes: ['id', 'title', 'type', 'assigneeId', 'projectId', 'completedAt', 'createdAt'],
      raw: true,
    }),
    db.Project.findAll({
      where: { orgId, status: 'completed' },
      attributes: ['id', 'name', 'serviceTypeKey', 'startDate', 'deliveryDate', 'updatedAt'],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
      order: [['updatedAt', 'DESC']],
      limit: 8,
    }),
    db.Invoice.findAll({
      where: { orgId, status: 'paid' },
      attributes: ['id', 'number', 'total', 'currency', 'issuedAt', 'updatedAt'],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
      order: [['updatedAt', 'DESC']],
      limit: 8,
    }),
    // Stage advances are the truest "something moved" signal in the app - the
    // workflow engine writes one for every transition it performs.
    db.ProjectEvent.findAll({
      attributes: ['id', 'projectId', 'fromStageKey', 'toStageKey', 'action', 'actorUserId', 'createdAt'],
      include: [{ model: db.Project, as: 'project', attributes: ['id', 'name'], where: { orgId }, required: true }],
      order: [['createdAt', 'DESC']],
      limit: 10,
    }).catch(() => []),
    db.LeaveRequest.count({ where: { orgId, status: 'approved', updatedAt: { [Op.gte]: monthAgo } } }).catch(() => 0),
    db.CustomerDocument.count({ where: { orgId, status: 'approved' } }).catch(() => 0),
    db.ContentSubmission.count({
      where: { status: 'approved' },
      include: [{ model: db.Project, as: 'project', attributes: [], where: { orgId }, required: true }],
      distinct: true,
      col: 'id',
    }).catch(() => 0),
    db.BlogTask.count({
      where: { status: 'approved' },
      include: [{ model: db.Project, as: 'project', attributes: [], where: { orgId }, required: true }],
      distinct: true,
      col: 'id',
    }).catch(() => 0),
    db.User.findAll({ where: { orgId }, attributes: ['id', 'name'], raw: true }),
  ]);

  const staffName = {};
  for (const u of staffNames) staffName[u.id] = u.name;

  // -- Weekly throughput --
  const weeks = [];
  const weekRange = new Map();
  for (let i = 7; i >= 0; i--) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7 - 6);
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i * 7 + 1);
    const bucket = { label: `${start.toLocaleString('en', { month: 'short' })} ${start.getDate()}`, value: 0 };
    weeks.push(bucket);
    weekRange.set(bucket, { start, end });
  }

  const perFinisher = {};
  const byType = {};
  let doneThisWeek = 0;
  let doneThisMonth = 0;
  let cycleSum = 0;
  let cycleCount = 0;

  for (const t of finishedTasks) {
    const at = new Date(t.completedAt);
    for (const bucket of weeks) {
      const { start, end } = weekRange.get(bucket);
      if (at >= start && at < end) { bucket.value += 1; break; }
    }
    if (at >= weekAgo) doneThisWeek += 1;
    if (at >= monthStart) doneThisMonth += 1;
    if (at >= monthAgo) {
      byType[t.type || 'other'] = (byType[t.type || 'other'] || 0) + 1;
      if (t.assigneeId) perFinisher[t.assigneeId] = (perFinisher[t.assigneeId] || 0) + 1;
    }
    // Turnaround in days, from raised to finished.
    if (t.createdAt) {
      const days = (at - new Date(t.createdAt)) / 86400000;
      if (days >= 0) { cycleSum += days; cycleCount += 1; }
    }
  }

  const topFinishers = Object.entries(perFinisher)
    .map(([id, value]) => ({ id, name: staffName[id] || 'Unknown', value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const revenueCollected = {};
  for (const inv of paidInvoices) addMoney(revenueCollected, inv.currency, inv.total);

  return {
    throughput: weeks,
    tasks: {
      window: finishedTasks.length,
      thisWeek: doneThisWeek,
      thisMonth: doneThisMonth,
      byType,
      avgTurnaroundDays: cycleCount ? Math.round((cycleSum / cycleCount) * 10) / 10 : null,
    },
    topFinishers,
    completedProjects: completedProjects.map((p) => ({
      id: p.id,
      name: p.name,
      client: p.client?.name || '\u2014',
      service: p.serviceTypeKey,
      finishedAt: p.updatedAt,
      // Only meaningful when both dates exist; a project with no start date
      // gets null rather than a duration measured from the epoch.
      durationDays: p.startDate
        ? Math.max(0, Math.round((new Date(p.updatedAt) - new Date(p.startDate)) / 86400000))
        : null,
    })),
    paidInvoices: paidInvoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      client: inv.client?.name || '\u2014',
      total: parseFloat(inv.total || 0),
      currency: inv.currency || 'USD',
      paidAt: inv.updatedAt,
    })),
    revenueCollected,
    stageEvents: stageEvents.map((e) => ({
      id: e.id,
      projectId: e.projectId,
      project: e.project?.name || '\u2014',
      from: e.fromStageKey,
      to: e.toStageKey,
      action: e.action,
      actor: staffName[e.actorUserId] || 'System',
      at: e.createdAt,
    })),
    totals: {
      leavesApproved30d: approvedLeaves,
      documentsSigned: signedDocuments,
      contentApproved: approvedContent,
      blogsApproved: approvedBlogs,
    },
  };
}

// ─── Attention feed ──────────────────────────────────────────────────────────

/**
 * The "act on this" list: one flat, severity-ranked feed rather than a set of
 * numbers the reader has to go hunting behind. Everything here is already
 * counted elsewhere in the payload — this is what turns those counts into a
 * to-do list, and it's the reason the page opens on a decision rather than a
 * chart.
 */
function buildAttention({ finance, delivery, people, approvals, growth }) {
  const items = [];
  const push = (severity, label, detail, href, count) => {
    if (!count) return;
    items.push({ severity, label, detail, href, count });
  };

  push('critical', 'Overdue invoices', 'Past their due date and still unpaid', '/invoices?status=overdue',
    finance.overdueInvoiceCount);
  push('critical', 'SLA breached', 'Projects past their stage SLA target', '/projects', delivery.sla.breached);
  push('critical', 'Overdue projects', 'Delivery date has passed', '/projects', delivery.overdueProjectCount);
  push('critical', 'Overdue tasks', 'Past due and not finished', '/tasks?view=overdue', delivery.tasks.overdue);

  push('warning', 'Pending approvals', 'Waiting on a decision', '/approvals', approvals?.totals?.pending || 0);
  push('warning', 'Leave requests', 'Awaiting approval', '/hr?tab=leaves', people.leave.pending);
  push('warning', 'Employees under review', 'Registration submitted, not yet onboarded', '/hr',
    people.headcount.byStatus.under_review || 0);
  push('warning', 'Contractor invoices', 'Submitted, awaiting review', '/hr?tab=contractor-invoices',
    people.contractorInvoices.submitted || 0);
  push('warning', 'Unassigned tasks', 'Open with nobody on them', '/tasks?view=all', delivery.tasks.unassigned);
  push('warning', 'Attendance unmarked', 'Active staff with no attendance today', '/self-service?tab=attendance',
    people.attendanceToday.unmarked);
  push('warning', 'Blocked projects', 'Marked blocked and not moving', '/projects', delivery.blocked);
  push('warning', 'SLA at risk', 'Approaching their stage SLA target', '/projects', delivery.sla.atRisk);

  push('info', 'Retainers billing soon', 'Auto-invoice within 7 days', '/retainers', finance.retainers.dueSoon.length);
  push('info', 'Projects due this week', 'Delivery date within 7 days', '/projects', delivery.dueSoonProjectCount);
  push('info', 'New leads', 'Not yet contacted', '/leads', growth.leads.byStatus.new || 0);
  push('info', 'Client requests pending', 'Requirement forms awaiting approval', '/projects',
    growth.clientRequests.pending_approval || 0);
  push('info', 'Probation ending', 'Confirmation due within 30 days', '/hr', people.probationEndingSoon);

  const rank = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count);
}

// ─── Public: the whole page in one call ──────────────────────────────────────

async function getOverview(orgId, user) {
  const [finance, delivery, people, growth, seo, done, approvals, waiting, activity] = await Promise.all([
    getFinance(orgId),
    getDelivery(orgId),
    getPeople(orgId),
    getGrowth(orgId),
    getSeo(orgId),
    getDone(orgId),
    // Reused rather than re-derived: the approval inbox already owns the
    // definition of what is pending and who may see it (eleven sources, each
    // with its own visibility rule). Duplicating that here would drift the
    // moment a source is added.
    ApprovalService.counts(orgId, user)
      .catch(() => ({ totals: { pending: 0, approved: 0, rejected: 0 }, byType: {} })),
    AnalyticsService.getWaitingOnMe(orgId, user).catch(() => []),
    db.ActivityLog.findAll({
      where: { orgId },
      attributes: ['id', 'actorName', 'action', 'resource', 'description', 'statusCode', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: 15,
      raw: true,
    }).catch(() => []),
  ]);

  const attention = buildAttention({ finance, delivery, people, approvals, growth });

  return {
    generatedAt: new Date().toISOString(),
    headline: {
      revenueThisMonth: finance.revenue.thisMonth,
      revenueAllTime: finance.revenue.allTime,
      outstanding: finance.outstanding,
      overdueAmount: finance.overdueAmount,
      activeClients: growth.clients.byStatus.active || 0,
      activeProjects: delivery.projects.byStatus.active || 0,
      openTasks: delivery.tasks.open,
      overdueTasks: delivery.tasks.overdue,
      headcount: people.headcount.active,
      presentToday: people.attendanceToday.present,
      pendingApprovals: approvals?.totals?.pending || 0,
      newLeads: growth.leads.byStatus.new || 0,
      tasksDoneThisWeek: done.tasks.thisWeek,
      collected: finance.collectedThisMonth,
      criticalCount: attention
        .filter((i) => i.severity === 'critical')
        .reduce((n, i) => n + i.count, 0),
    },
    attention,
    approvals,
    waitingOnMe: waiting.slice(0, 12),
    delivery,
    finance,
    people,
    growth,
    seo,
    done,
    activity,
  };
}

// ─── Public: system / server health ──────────────────────────────────────────

/** GET a URL with a hard timeout, resolving to latency instead of throwing. */
function ping(url, { timeoutMs = 4000, headers = {} } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, error: 'Invalid URL', latencyMs: null, status: null });
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        // Body drained but ignored — we only care that it answered, and leaving
        // it unread would hold the socket open.
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          status: res.statusCode,
          latencyMs: Date.now() - startedAt,
          error: null,
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, latencyMs: Date.now() - startedAt, error: `No response in ${timeoutMs}ms` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: null, latencyMs: Date.now() - startedAt, error: err.message });
    });
    req.end();
  });
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

async function getSystemHealth(orgId) {
  const mediaUrl = process.env.MEDIA_URL || 'http://localhost:3002';

  const dbStart = Date.now();
  const database = await db.sequelize.authenticate()
    .then(() => ({ ok: true, latencyMs: Date.now() - dbStart, error: null }))
    .catch((err) => ({ ok: false, latencyMs: Date.now() - dbStart, error: err.message }));

  const [media, dbVersion, tables, records] = await Promise.all([
    ping(`${mediaUrl}/health`, { headers: { 'x-api-key': process.env.MEDIA_API_SECRET || '' } }),
    database.ok
      ? db.sequelize.query('SELECT VERSION() AS v', { type: db.sequelize.QueryTypes.SELECT })
        .then((r) => r[0]?.v || null).catch(() => null)
      : Promise.resolve(null),
    // Storage footprint straight from information_schema — the honest answer to
    // "how big is this getting?", and the only way to get per-table sizes
    // without forty COUNT(*) queries. `TABLE_ROWS` is InnoDB's estimate, which
    // is why the UI labels that column "approx".
    database.ok
      ? db.sequelize.query(
        'SELECT TABLE_NAME AS name, TABLE_ROWS AS rowEstimate, (DATA_LENGTH + INDEX_LENGTH) AS bytes '
        + 'FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() '
        + 'ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC LIMIT 15',
        { type: db.sequelize.QueryTypes.SELECT },
      ).catch(() => [])
      : Promise.resolve([]),
    database.ok ? recordCounts(orgId) : Promise.resolve({}),
  ]);

  const mem = process.memoryUsage();
  const pool = db.sequelize.connectionManager?.pool;

  return {
    checkedAt: new Date().toISOString(),
    api: {
      ok: true,
      env: process.env.NODE_ENV || 'development',
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      host: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      cpus: os.cpus().length,
      loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
      memory: {
        rss: humanBytes(mem.rss),
        heapUsed: humanBytes(mem.heapUsed),
        heapTotal: humanBytes(mem.heapTotal),
        systemFree: humanBytes(os.freemem()),
        systemTotal: humanBytes(os.totalmem()),
      },
    },
    database: {
      ...database,
      dialect: db.sequelize.getDialect(),
      version: dbVersion,
      name: db.sequelize.config?.database || null,
      host: db.sequelize.config?.host || null,
      pool: pool ? { size: pool.size, available: pool.available, using: pool.using, waiting: pool.pending } : null,
    },
    media: { ...media, url: mediaUrl },
    schedulers: schedulerRegistry.list(),
    // Presence of configuration only — never the secret itself. Answers "is
    // email/Stripe wired up on this deployment?" without leaking keys to the
    // browser.
    integrations: [
      { key: 'smtp', label: 'Email (SMTP)', configured: !!process.env.SMTP_USER, detail: process.env.SMTP_HOST || null },
      {
        key: 'stripe',
        label: 'Stripe',
        configured: !!process.env.STRIPE_SECRET_KEY,
        detail: process.env.STRIPE_WEBHOOK_SECRET ? 'Webhook secret set' : 'No webhook secret',
      },
      { key: 'media', label: 'Media service', configured: !!process.env.MEDIA_API_SECRET, detail: mediaUrl },
      { key: 'frontend', label: 'Frontend URL', configured: !!process.env.FRONTEND_URL, detail: process.env.FRONTEND_URL || null },
    ],
    storage: {
      tables: tables.map((t) => ({
        name: t.name,
        rowEstimate: Number(t.rowEstimate) || 0,
        bytes: Number(t.bytes) || 0,
        size: humanBytes(Number(t.bytes) || 0),
      })),
      totalSize: humanBytes(tables.reduce((n, t) => n + (Number(t.bytes) || 0), 0)),
    },
    records,
  };
}

/**
 * Exact org-scoped row counts for the record-inventory table on the System tab.
 *
 * Not every table has an `orgId`: the SEO deliverables hang off a Project,
 * payments off an Invoice, contacts off a Client and chat messages off a
 * ChatRoom. Each entry therefore declares how it reaches its org — a flat
 * column, or a required join through the parent that owns the tenancy.
 */
const RECORD_TARGETS = [
  { key: 'users', model: () => db.User },
  { key: 'clients', model: () => db.Client },
  { key: 'contacts', model: () => db.Contact, via: () => ({ model: db.Client, as: 'client' }) },
  { key: 'projects', model: () => db.Project },
  { key: 'tasks', model: () => db.Task },
  { key: 'invoices', model: () => db.Invoice },
  { key: 'payments', model: () => db.Payment, via: () => ({ model: db.Invoice, as: 'invoice' }) },
  { key: 'workers', model: () => db.Worker },
  { key: 'attendance', model: () => db.Attendance },
  { key: 'leads', model: () => db.Lead },
  { key: 'documents', model: () => db.CustomerDocument },
  { key: 'keywords', model: () => db.Keyword, via: () => ({ model: db.Project, as: 'project' }) },
  { key: 'backlinks', model: () => db.Backlink, via: () => ({ model: db.Project, as: 'project' }) },
  { key: 'messages', model: () => db.ChatMessage, via: () => ({ model: db.ChatRoom, as: 'room' }) },
  { key: 'notifications', model: () => db.Notification },
  { key: 'activityLogs', model: () => db.ActivityLog },
];

async function recordCounts(orgId) {
  const entries = await Promise.all(RECORD_TARGETS.map(async ({ key, model, via }) => {
    const Model = model();
    if (!Model) return [key, null];
    const parent = via ? via() : null;
    const options = parent
      // `col: 'id'` unqualified — Sequelize prefixes it with the model's own
      // alias, so passing "Contact.id" here yields `Contact->Contact.id`.
      // `distinct` guards against a hasMany parent fanning the count out.
      ? { include: [{ ...parent, attributes: [], where: { orgId }, required: true }], distinct: true, col: 'id' }
      : { where: { orgId } };
    // One bad count must not take the whole System tab down with it — a null
    // cell renders as "—", which is a better failure than a 500.
    const n = await Model.count(options).catch(() => null);
    return [key, n];
  }));
  return Object.fromEntries(entries);
}

module.exports = { getOverview, getSystemHealth };
