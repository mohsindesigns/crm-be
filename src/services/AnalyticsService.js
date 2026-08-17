const { Op } = require('sequelize');
const db = require('../models');
const { formatPeriod } = require('../utils/formatPeriod');
const {
  Project, ProjectEvent, ProjectAssignment,
  Invoice, Client, Stage, User,
} = db;

// ─── Dashboard ────────────────────────────────────────────────────────────────

function isAdmin(user) {
  return user?.role?.key === 'super_admin' || user?.role?.key === 'admin';
}

async function getUserProjectIds(userId) {
  const assignments = await ProjectAssignment.findAll({
    where: { userId },
    attributes: ['projectId'],
  });
  return assignments.map((a) => a.projectId);
}

async function getDashboardMetrics(orgId, user) {
  const admin = isAdmin(user);
  const canSeeBilling = admin || !!user?.role?.permissions?.['billing.read'];
  let projectWhere = { orgId };
  let hasProjects = true;

  if (!admin) {
    const projectIds = await getUserProjectIds(user.id);
    if (!projectIds.length) {
      hasProjects = false;
      // Only return early if there's nothing useful to show (no billing access either)
      if (!canSeeBilling) {
        return { totalProjects: 0, activeProjects: 0, completedProjects: 0, revenueByCurrency: {}, outstandingByCurrency: {} };
      }
    } else {
      projectWhere = { orgId, id: { [Op.in]: projectIds } };
    }
  }

  const [totalProjects, activeProjects, completedProjects, invoices] = await Promise.all([
    hasProjects ? Project.count({ where: projectWhere }) : Promise.resolve(0),
    hasProjects ? Project.count({ where: { ...projectWhere, status: 'active' } }) : Promise.resolve(0),
    hasProjects ? Project.count({ where: { ...projectWhere, status: 'completed' } }) : Promise.resolve(0),
    canSeeBilling ? Invoice.findAll({ where: { orgId }, attributes: ['status', 'total', 'currency', [db.sequelize.literal('(SELECT COALESCE(SUM(`p`.`amount`),0) FROM `payments` `p` WHERE `p`.`invoiceId` = `Invoice`.`id`)'), 'amountPaid']] }) : Promise.resolve([]),
  ]);

  const revenueByCurrency = {};
  const outstandingByCurrency = {};
  for (const inv of invoices) {
    const cur = inv.currency || 'USD';
    const amt = parseFloat(inv.total || 0);
    if (inv.status === 'paid') revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;
    // What's still OWED, not the invoice's face value: a part-paid invoice
    // was being counted in full (see the same correction in ClientService.list).
    const stillDue = Math.max(0, amt - (parseFloat(inv.get('amountPaid')) || 0));
    if (['sent', 'overdue', 'payment_review'].includes(inv.status)) outstandingByCurrency[cur] = (outstandingByCurrency[cur] || 0) + stillDue;
  }

  return { totalProjects, activeProjects, completedProjects, revenueByCurrency, outstandingByCurrency };
}

async function getProjectsByStage(orgId, user) {
  let where = { orgId, status: 'active' };

  if (!isAdmin(user)) {
    const projectIds = await getUserProjectIds(user.id);
    if (!projectIds.length) return {};
    where = { ...where, id: { [Op.in]: projectIds } };
  }

  const projects = await Project.findAll({
    where,
    attributes: ['id', 'name', 'currentStageKey', 'serviceTypeKey', 'status', 'deliveryDate'],
    include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
    order: [['currentStageKey', 'ASC'], ['createdAt', 'DESC']],
  });

  const grouped = {};
  for (const p of projects) {
    const key = p.currentStageKey;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(p);
  }
  return grouped;
}

// Unified "waiting on you" inbox for the dashboard. Every item is normalized to
// { type, id, title, subtitle, href, createdAt } regardless of source, so the
// frontend renders one list instead of one widget per approval kind.
//
// Everyone (admin or not) sees project stages where they personally own the
// current stage (same logic as before — via ProjectAssignment.roleSlot). Admins
// additionally see everything else that needs a decision only an admin can make:
// worker registrations pending review, leave requests, and contractor invoices —
// these have no per-user "assignee" concept, they're org-wide admin queues.
async function getWaitingOnMe(orgId, user) {
  const userId = user?.id || user; // back-compat: accept a raw userId too
  const admin = isAdmin(typeof user === 'object' ? user : null);
  const items = [];

  const assignments = await ProjectAssignment.findAll({
    where: { userId },
    include: [{
      model: Project,
      as: 'project',
      where: { orgId, status: 'active' },
      attributes: ['id', 'name', 'currentStageKey', 'serviceTypeKey', 'deliveryDate', 'workflowTemplateId', 'updatedAt'],
      include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
    }],
  });

  if (assignments.length) {
    const projects = assignments.map((a) => a.project);
    const templateIds = [...new Set(projects.map((p) => p.workflowTemplateId))];
    const stages = await Stage.findAll({ where: { templateId: templateIds } });
    const stageMap = {};
    for (const s of stages) stageMap[`${s.templateId}:${s.key}`] = s;

    const seen = new Set();
    for (const assignment of assignments) {
      const project = assignment.project;
      const currentStage = stageMap[`${project.workflowTemplateId}:${project.currentStageKey}`];
      if (currentStage && currentStage.ownerRoleSlot === assignment.roleSlot && !seen.has(project.id)) {
        seen.add(project.id);
        items.push({
          type: 'project',
          id: project.id,
          title: project.name,
          subtitle: `${project.client?.name || 'No client'} · ${currentStage.name || project.currentStageKey}`,
          href: `/projects/${project.id}`,
          createdAt: project.updatedAt,
        });
      }
    }
  }

  if (admin) {
    const [workers, leaves, invoices, rejectedDocs, payrollConcerns, docRequests] = await Promise.all([
      db.Worker.findAll({
        where: { orgId, status: 'under_review' },
        include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
      }),
      db.LeaveRequest.findAll({
        where: { orgId, status: 'requested' },
        include: [{ model: db.Worker, as: 'worker', include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }] }],
      }),
      db.ContractorInvoice.findAll({
        where: { orgId, status: 'submitted' },
        include: [{ model: db.Worker, as: 'worker', include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }] }],
      }),
      // Quotes & Agreements: a customer requesting changes needs an admin to
      // edit and re-send — otherwise it just sits in 'rejected' with nothing
      // surfacing that it needs attention.
      db.CustomerDocument.findAll({
        where: { orgId, status: 'rejected' },
        attributes: ['id', 'number', 'type', 'prospectName', 'businessName', 'responseNote', 'respondedAt', 'updatedAt'],
      }),
      db.PayrollItem.findAll({
        where: { employeeStatus: 'concern_raised' },
        include: [
          {
            model: db.PayrollRun,
            as: 'run',
            where: { orgId, status: { [Op.in]: ['draft', 'open_for_review', 'locked'] } },
            attributes: ['id', 'period', 'status'],
          },
          {
            model: db.Worker,
            as: 'worker',
            include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
          },
        ],
        order: [['updatedAt', 'DESC']],
      }),
      db.HrDocument.findAll({
        where: { orgId, status: 'requested' },
        include: [{
          model: db.Worker,
          as: 'worker',
          include: [{ model: db.User, as: 'user', attributes: ['id', 'name'] }],
        }],
        order: [['createdAt', 'ASC']],
      }),
    ]);

    for (const w of workers) {
      items.push({
        type: 'worker_review',
        id: w.id,
        title: `Employee registration: ${w.user?.name || 'Unknown'}`,
        subtitle: 'Profile submitted for review',
        href: `/hr/workers/${w.id}`,
        createdAt: w.updatedAt,
      });
    }
    for (const l of leaves) {
      items.push({
        type: 'leave',
        id: l.id,
        title: `Leave request: ${l.worker?.user?.name || 'Unknown'}`,
        subtitle: `${titleCaseLabel(l.type)} · ${l.fromDate} to ${l.toDate}`,
        href: '/hr?tab=leaves',
        createdAt: l.createdAt,
      });
    }
    for (const inv of invoices) {
      items.push({
        type: 'contractor_invoice',
        id: inv.id,
        title: `Contractor invoice: ${inv.worker?.user?.name || 'Unknown'}`,
        subtitle: `${formatPeriod(inv.period)} · ${inv.currency} ${parseFloat(inv.amount).toLocaleString()}`,
        href: '/hr?tab=contractor-invoices',
        createdAt: inv.createdAt,
      });
    }
    for (const doc of rejectedDocs) {
      const note = (doc.responseNote || '').trim();
      items.push({
        type: 'document',
        id: doc.id,
        title: `Changes requested: ${doc.number}`,
        subtitle: `${doc.businessName || doc.prospectName}${note ? ` · "${note.slice(0, 60)}${note.length > 60 ? '…' : ''}"` : ''}`,
        href: `/documents/${doc.id}`,
        createdAt: doc.respondedAt || doc.updatedAt,
      });
    }
    for (const item of payrollConcerns) {
      const note = (item.concernNote || '').trim();
      const period = formatPeriod(item.run?.period) || 'payroll';
      items.push({
        type: 'payroll_concern',
        id: item.id,
        title: `Payroll concern: ${item.worker?.user?.name || 'Unknown'}`,
        subtitle: `${period}${note ? ` · "${note.slice(0, 80)}${note.length > 80 ? '…' : ''}"` : ''}`,
        href: `/hr/payroll/${item.run.id}`,
        createdAt: item.updatedAt || item.employeeConfirmedAt,
      });
    }
    for (const req of docRequests) {
      items.push({
        type: 'document_request',
        id: req.id,
        title: `Document request: ${req.worker?.user?.name || 'Unknown'}`,
        subtitle: titleCaseLabel(req.type) || req.label || 'Letter',
        href: `/hr/workers/${req.workerId}?tab=documents`,
        createdAt: req.createdAt,
      });
    }
  }

  items.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return items;
}

function titleCaseLabel(v) {
  if (!v) return '';
  return v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Cycle time by stage ──────────────────────────────────────────────────────

async function getCycleTimeByStage(orgId, { templateId } = {}) {
  const projectWhere = { orgId };
  if (templateId) projectWhere.workflowTemplateId = templateId;

  const events = await ProjectEvent.findAll({
    where: { action: { [Op.in]: ['complete', 'approve'] } },
    include: [{ model: Project, as: 'project', where: projectWhere, attributes: [] }],
    order: [['createdAt', 'ASC']],
  });

  const projectTimelines = {};
  for (const ev of events) {
    const pid = ev.projectId;
    if (!projectTimelines[pid]) projectTimelines[pid] = [];
    projectTimelines[pid].push({ from: ev.fromStageKey, to: ev.toStageKey, at: new Date(ev.createdAt) });
  }

  const stageDurations = {};
  for (const timeline of Object.values(projectTimelines)) {
    for (let i = 0; i < timeline.length - 1; i++) {
      const stageKey = timeline[i].to;
      const enter = timeline[i].at;
      const exit = timeline[i + 1]?.at;
      if (!exit) continue;
      const hours = (exit - enter) / 3600000;
      if (!stageDurations[stageKey]) stageDurations[stageKey] = [];
      stageDurations[stageKey].push(hours);
    }
  }

  return Object.entries(stageDurations).map(([stageKey, durations]) => ({
    stageKey,
    avgHours: durations.reduce((a, b) => a + b, 0) / durations.length,
    sampleSize: durations.length,
  }));
}

// ─── Rejection rate by stage ──────────────────────────────────────────────────

async function getRejectionRateByStage(orgId) {
  const events = await ProjectEvent.findAll({
    where: { action: { [Op.in]: ['complete', 'approve', 'reject', 'rewind'] } },
    include: [{ model: Project, as: 'project', where: { orgId }, attributes: [] }],
  });

  const counts = {};
  for (const ev of events) {
    const key = ev.fromStageKey || ev.toStageKey;
    if (!counts[key]) counts[key] = { total: 0, rejected: 0 };
    counts[key].total++;
    if (['reject', 'rewind'].includes(ev.action)) counts[key].rejected++;
  }

  return Object.entries(counts).map(([stageKey, { total, rejected }]) => ({
    stageKey,
    total,
    rejected,
    rejectionRate: total > 0 ? Math.round((rejected / total) * 100) : 0,
  }));
}

// ─── On-time delivery ─────────────────────────────────────────────────────────

async function getOnTimeDelivery(orgId) {
  const completed = await Project.findAll({
    where: { orgId, status: 'completed' },
    attributes: ['id', 'deliveryDate'],
  });

  if (!completed.length) return { total: 0, onTime: 0, late: 0, noDeadline: 0, pct: 0 };

  const projectIds = completed.map((p) => p.id);
  // Fetch all events DESC — first seen per project is the latest (avoids GROUP BY / strict-mode issues)
  const allEvents = await ProjectEvent.findAll({
    where: { projectId: projectIds },
    attributes: ['projectId', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  const completionMap = {};
  for (const ev of allEvents) {
    if (!completionMap[ev.projectId]) completionMap[ev.projectId] = ev.createdAt;
  }

  let onTime = 0, late = 0, noDeadline = 0;
  for (const project of completed) {
    if (!project.deliveryDate) { noDeadline++; continue; }
    const completedAt = completionMap[project.id];
    if (!completedAt) continue;
    const deadline = new Date(project.deliveryDate + 'T23:59:59');
    if (completedAt <= deadline) onTime++;
    else late++;
  }

  const total = onTime + late;
  return { total, onTime, late, noDeadline, pct: total > 0 ? Math.round((onTime / total) * 100) : 0 };
}

// ─── Team utilization ─────────────────────────────────────────────────────────

async function getTeamUtilization(orgId) {
  const assignments = await ProjectAssignment.findAll({
    include: [
      {
        model: Project,
        as: 'project',
        where: { orgId, status: 'active' },
        attributes: ['id', 'currentStageKey', 'workflowTemplateId'],
        required: true,
      },
      {
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'avatarUrl'],
        required: true,
      },
    ],
  });

  if (!assignments.length) return [];

  const templateIds = [...new Set(assignments.map((a) => a.project.workflowTemplateId))];
  const stages = await Stage.findAll({ where: { templateId: templateIds } });
  const stageMap = {};
  for (const s of stages) stageMap[`${s.templateId}:${s.key}`] = s;

  const userMap = {};
  for (const assignment of assignments) {
    const { project, roleSlot, user } = assignment;
    const stage = stageMap[`${project.workflowTemplateId}:${project.currentStageKey}`];
    if (!stage || stage.ownerRoleSlot !== roleSlot) continue;
    if (!userMap[user.id]) {
      userMap[user.id] = { user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl }, activeCount: 0 };
    }
    userMap[user.id].activeCount++;
  }

  return Object.values(userMap).sort((a, b) => b.activeCount - a.activeCount);
}

// ─── Cycle time by service ────────────────────────────────────────────────────

async function getCycleTimeByService(orgId) {
  const completed = await Project.findAll({
    where: { orgId, status: 'completed' },
    attributes: ['id', 'serviceTypeKey', 'createdAt'],
  });

  if (!completed.length) return [];

  const projectIds = completed.map((p) => p.id);
  const allEvents = await ProjectEvent.findAll({
    where: { projectId: projectIds },
    attributes: ['projectId', 'createdAt'],
    order: [['createdAt', 'DESC']],
  });

  const completionMap = {};
  for (const ev of allEvents) {
    if (!completionMap[ev.projectId]) completionMap[ev.projectId] = ev.createdAt;
  }

  const serviceStats = {};
  for (const project of completed) {
    const completedAt = completionMap[project.id];
    if (!completedAt) continue;
    const hours = (completedAt - new Date(project.createdAt)) / 3600000;
    if (!serviceStats[project.serviceTypeKey]) serviceStats[project.serviceTypeKey] = [];
    serviceStats[project.serviceTypeKey].push(hours);
  }

  return Object.entries(serviceStats)
    .map(([serviceTypeKey, hours]) => ({
      serviceTypeKey,
      avgHours: Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10,
      count: hours.length,
    }))
    .sort((a, b) => b.avgHours - a.avgHours);
}

// ─── Business overview (new analytics page) ──────────────────────────────────

async function getBusinessOverview(orgId) {
  const [clients, projects, invoices] = await Promise.all([
    db.Client.findAll({ where: { orgId }, attributes: ['id', 'status', 'createdAt'] }),
    db.Project.findAll({ where: { orgId }, attributes: ['id', 'status', 'serviceTypeKey', 'createdAt'] }),
    db.Invoice.findAll({
      where: { orgId },
      attributes: ['id', 'status', 'total', 'currency', 'issuedAt', 'clientId', [db.sequelize.literal('(SELECT COALESCE(SUM(`p`.`amount`),0) FROM `payments` `p` WHERE `p`.`invoiceId` = `Invoice`.`id`)'), 'amountPaid']],
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
    }),
  ]);

  // ── Clients by status ──
  const clientsByStatus = {};
  for (const c of clients) clientsByStatus[c.status] = (clientsByStatus[c.status] || 0) + 1;

  // ── Projects by status & service type ──
  const projectsByStatus = {};
  const projectsByService = {};
  for (const p of projects) {
    projectsByStatus[p.status] = (projectsByStatus[p.status] || 0) + 1;
    if (p.serviceTypeKey) projectsByService[p.serviceTypeKey] = (projectsByService[p.serviceTypeKey] || 0) + 1;
  }

  // ── Invoice breakdown ──
  const invoicesByStatus = {};
  const revenueByCurrency = {};
  const outstandingByCurrency = {};
  for (const inv of invoices) {
    invoicesByStatus[inv.status] = (invoicesByStatus[inv.status] || 0) + 1;
    const cur = inv.currency || 'USD';
    const amt = parseFloat(inv.total || 0);
    if (inv.status === 'paid') revenueByCurrency[cur] = (revenueByCurrency[cur] || 0) + amt;
    // What's still OWED, not the invoice's face value: a part-paid invoice
    // was being counted in full (see the same correction in ClientService.list).
    const stillDue = Math.max(0, amt - (parseFloat(inv.get('amountPaid')) || 0));
    if (['sent', 'overdue', 'payment_review'].includes(inv.status)) outstandingByCurrency[cur] = (outstandingByCurrency[cur] || 0) + stillDue;
  }

  // ── Revenue trend (last 6 months, using issuedAt of paid invoices) ──
  const now = new Date();
  const revenueTrend = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth();
    const label = d.toLocaleString('en', { month: 'short', year: '2-digit' });
    const paid = invoices.filter((inv) => {
      if (inv.status !== 'paid' || !inv.issuedAt) return false;
      const id = new Date(inv.issuedAt);
      return id.getFullYear() === y && id.getMonth() === m;
    });
    const byCurrency = {};
    let totalApprox = 0;
    for (const inv of paid) {
      const cur = inv.currency || 'USD';
      const amt = parseFloat(inv.total || 0);
      byCurrency[cur] = (byCurrency[cur] || 0) + amt;
      totalApprox += amt;
    }
    revenueTrend.push({ label, count: paid.length, byCurrency, totalApprox });
  }

  // ── Top 5 clients by revenue (paid invoices) ──
  const clientRevMap = {};
  for (const inv of invoices) {
    if (inv.status !== 'paid') continue;
    const cid = inv.clientId;
    if (!clientRevMap[cid]) clientRevMap[cid] = { name: inv.client?.name || '—', byCurrency: {}, totalApprox: 0 };
    const cur = inv.currency || 'USD';
    const amt = parseFloat(inv.total || 0);
    clientRevMap[cid].byCurrency[cur] = (clientRevMap[cid].byCurrency[cur] || 0) + amt;
    clientRevMap[cid].totalApprox += amt;
  }
  const topClients = Object.values(clientRevMap)
    .sort((a, b) => b.totalApprox - a.totalApprox)
    .slice(0, 5);

  return {
    clients: { total: clients.length, byStatus: clientsByStatus },
    projects: { total: projects.length, byStatus: projectsByStatus, byService: projectsByService },
    invoices: { total: invoices.length, byStatus: invoicesByStatus },
    revenueByCurrency,
    outstandingByCurrency,
    revenueTrend,
    topClients,
  };
}

module.exports = {
  getDashboardMetrics,
  getProjectsByStage,
  getWaitingOnMe,
  getCycleTimeByStage,
  getRejectionRateByStage,
  getOnTimeDelivery,
  getTeamUtilization,
  getCycleTimeByService,
  getBusinessOverview,
};
