const db = require('../models');
const { Op } = require('sequelize');
const ClientService = require('../services/ClientService');
const ProjectService = require('../services/ProjectService');
const InvoiceService = require('../services/InvoiceService');
const UserService = require('../services/UserService');
const LeadService = require('../services/LeadService');
const PersonalInvoiceService = require('../services/PersonalInvoiceService');
const CustomerDocumentService = require('../services/CustomerDocumentService');

const BYPASS_KEYS = ['super_admin', 'admin'];

function hasPerm(user, key) {
  const role = user?.role;
  if (!role) return false;
  if (BYPASS_KEYS.includes(role.key)) return true;
  return !!role.permissions?.[key];
}

const LIMIT = 6;

class SearchController {
  // Fans out to each entity's own list/service (same query.search support, same
  // rbac gate its own route already uses) rather than a bespoke search index —
  // so a result never shows something the caller couldn't already see on that
  // entity's own page. Projects and Tasks have no separate permission gate
  // because their own routes don't either: visibility is scoped by caller
  // inside ProjectService.list, and by ownership below for Tasks.
  async search(req, res, next) {
    try {
      const q = String(req.query.q || '').trim();
      if (q.length < 2) return res.json({ query: q, groups: [] });

      const orgId = req.orgId;
      const user = req.user;
      const lookups = [];

      if (hasPerm(user, 'clients.read')) {
        lookups.push(
          ClientService.list(orgId, { search: q, limit: LIMIT })
            .then((r) => ({
              type: 'clients',
              label: 'Clients',
              items: r.data.map((c) => ({ id: c.id, title: c.name, subtitle: null, href: `/clients/${c.id}` })),
            }))
            .catch(() => null),
        );
      }

      lookups.push(
        ProjectService.list(orgId, { search: q, limit: LIMIT }, user)
          .then((r) => ({
            type: 'projects',
            label: 'Projects',
            items: r.data.map((p) => ({ id: p.id, title: p.name, subtitle: p.client?.name || null, href: `/projects/${p.id}` })),
          }))
          .catch(() => null),
      );

      if (hasPerm(user, 'billing.read')) {
        lookups.push(
          InvoiceService.list(orgId, { search: q, limit: LIMIT })
            .then((r) => ({
              type: 'invoices',
              label: 'Invoices',
              items: r.data.map((inv) => ({ id: inv.id, title: inv.number, subtitle: inv.client?.name || null, href: `/invoices/${inv.id}` })),
            }))
            .catch(() => null),
        );
      }

      if (hasPerm(user, 'users.read')) {
        lookups.push(
          UserService.list(orgId, { search: q, limit: LIMIT })
            .then((r) => ({
              type: 'team',
              label: 'Team',
              items: r.data.map((u) => ({ id: u.id, title: u.name, subtitle: u.email, href: `/team/${u.id}` })),
            }))
            .catch(() => null),
        );
      }

      if (hasPerm(user, 'leads.read')) {
        lookups.push(
          LeadService.list(orgId, { q })
            .then((rows) => ({
              type: 'leads',
              label: 'Leads',
              items: rows.slice(0, LIMIT).map((l) => ({ id: l.id, title: l.fullName, subtitle: l.email || l.phone || null, href: `/leads?open=${l.id}` })),
            }))
            .catch(() => null),
        );
      }

      if (hasPerm(user, 'personalInvoices.read')) {
        lookups.push(
          PersonalInvoiceService.list(orgId, { search: q, limit: LIMIT })
            .then((r) => ({
              type: 'personalInvoices',
              label: 'Personal Invoices',
              items: r.data.map((inv) => ({ id: inv.id, title: inv.number, subtitle: inv.contact?.name || null, href: `/personal-invoices/${inv.id}` })),
            }))
            .catch(() => null),
        );
      }

      // Quotes & Agreements — gated on admin.access, matching this route's own
      // gate (routes/documents.js: "admin and super_admin only, per spec").
      if (hasPerm(user, 'admin.access')) {
        lookups.push(
          CustomerDocumentService.list(orgId, { search: q, limit: LIMIT })
            .then((r) => ({
              type: 'documents',
              label: 'Quotes & Agreements',
              items: r.data.map((d) => ({ id: d.id, title: d.number, subtitle: d.businessName || d.prospectName || null, href: `/documents/${d.id}` })),
            }))
            .catch(() => null),
        );
      }

      // Org-wide for managers/admins (mirrors GET /api/tasks, gated on
      // projects.manage) — otherwise scoped to the caller's own assignee/reviewer
      // tasks (mirrors the default GET /api/tasks/mine ownership clause).
      const canManageProjects = hasPerm(user, 'projects.manage');
      const taskWhere = { orgId, title: { [Op.like]: `%${q}%` } };
      if (!canManageProjects) {
        taskWhere[Op.or] = [{ assigneeId: user.id }, { reviewerId: user.id }];
      }
      lookups.push(
        db.Task.findAll({
          where: taskWhere,
          include: [{ model: db.Project, as: 'project', attributes: ['id', 'name'] }],
          order: [['createdAt', 'DESC']],
          limit: LIMIT,
        })
          .then((rows) => ({
            type: 'tasks',
            label: 'Tasks',
            items: rows
              .filter((t) => t.projectId)
              .map((t) => ({ id: t.id, title: t.title, subtitle: t.project?.name || null, href: `/tasks/${t.projectId}/${t.id}` })),
          }))
          .catch(() => null),
      );

      const settled = await Promise.all(lookups);
      const groups = settled.filter((g) => g && g.items.length);

      res.json({ query: q, groups });
    } catch (err) { next(err); }
  }
}

module.exports = new SearchController();
