const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { DEFAULT_BRAND_COLOR } = require('./config/constants');

const authRouter = require('./routes/auth');
const usersRouter = require('./routes/users');
const rolesRouter = require('./routes/roles');
const clientsRouter = require('./routes/clients');
const projectsRouter = require('./routes/projects');
const tasksRouter = require('./routes/tasks');
const recurringTaskRulesRouter = require('./routes/recurringTaskRules');
const commentsRouter = require('./routes/comments');
const invoicesRouter = require('./routes/invoices');
const notificationsRouter = require('./routes/notifications');
const adminRouter = require('./routes/admin');
const mediaRouter = require('./routes/media');
const seoRouter = require('./routes/seo');
const hrRouter = require('./routes/hr');
const analyticsRouter = require('./routes/analytics');
const retainersRouter = require('./routes/retainers');
const myTasksRouter = require('./routes/myTasks');
const portalRouter = require('./routes/portal');
const documentsRouter = require('./routes/documents');
const publicDocumentsRouter = require('./routes/publicDocuments');
const publicInvoicesRouter = require('./routes/publicInvoices');
const messagesRouter = require('./routes/messages');
const portalMessagesRouter = require('./routes/portalMessages');
const stripeWebhookRouter = require('./routes/stripeWebhook');
const leadFormsRouter = require('./routes/leadForms');
const publicLeadFormsRouter = require('./routes/publicLeadForms');
const leadsRouter = require('./routes/leads');
const portalLeadFormsRouter = require('./routes/portalLeadForms');
const portalLeadsRouter = require('./routes/portalLeads');
const errorHandler = require('./middleware/errorHandler');

const { WhiteLabelConfig, Org } = require('./models');

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// MUST precede express.json(). Stripe signs the raw request bytes, so the
// webhook route needs express.raw() — once a JSON parser has consumed the body,
// the re-serialised object no longer hashes to the signature Stripe sent and
// every event is rejected as invalid.
app.use('/api/stripe', stripeWebhookRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Public branding — used by login page before auth
// GET /api/brand?subdomain=mohsindesigns
app.get('/api/brand', async (req, res) => {
  try {
    const { subdomain } = req.query;
    let brand = null;
    if (subdomain) {
      const org = await Org.findOne({
        where: { subdomain },
        include: [{ model: WhiteLabelConfig, as: 'brand' }],
      });
      if (org) {
        brand = {
          orgId: org.id,
          brandName: org.brand?.brandName || 'Mohsin Designs Project Management',
          primaryColor: org.brand?.primaryColor || DEFAULT_BRAND_COLOR,
          logoUrl: org.brand?.logoUrl || null,
        };
      }
    }
    res.json(brand || { orgId: null, brandName: 'Mohsin Designs Project Management', primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null });
  } catch {
    res.json({ brandName: 'Mohsin Designs Project Management', primaryColor: DEFAULT_BRAND_COLOR, logoUrl: null });
  }
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/projects/:projectId/tasks', tasksRouter);
app.use('/api/projects/:projectId/recurring-task-rules', recurringTaskRulesRouter);
app.use('/api/projects/:projectId/comments', commentsRouter);
app.use('/api/invoices', invoicesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/media', mediaRouter);
app.use('/api/seo', seoRouter);
app.use('/api/hr', hrRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/retainers', retainersRouter);
app.use('/api/tasks', myTasksRouter);
app.use('/api/portal', portalRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/public/documents', publicDocumentsRouter);
app.use('/api/public/invoices', publicInvoicesRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/portal/messages', portalMessagesRouter);
app.use('/api/lead-forms', leadFormsRouter);
app.use('/api/public/lead-forms', publicLeadFormsRouter);
app.use('/api/leads', leadsRouter);
app.use('/api/portal/lead-forms', portalLeadFormsRouter);
app.use('/api/portal/leads', portalLeadsRouter);

// 404
app.use((req, res) => res.status(404).json({ message: 'Not found.' }));
app.use(errorHandler);

// One-time data fixes that run on every startup (idempotent).
const db = require('./models');

// Fix client_uat stage ownerRoleSlot so the client portal approval panel shows correctly.
db.sequelize.query(
  `UPDATE stages SET ownerRoleSlot = 'client' WHERE \`key\` = 'client_uat' AND ownerRoleSlot = 'project_manager'`
).catch(() => {});

// Grant project_manager role users.read so they can list team members for assignment.
db.sequelize.query(
  `UPDATE roles SET permissions = JSON_SET(permissions, '$."users.read"', CAST('true' AS JSON)) WHERE \`key\` = 'project_manager' AND JSON_EXTRACT(permissions, '$."users.read"') IS NULL`
).catch(() => {});

// Any role with billing.read also gets billing.create, billing.update, and clients.read
// so billing users can create invoices and see the client dropdown without extra config.
db.sequelize.query(
  `UPDATE roles SET permissions = JSON_SET(JSON_SET(JSON_SET(permissions,
    '$."billing.create"', CAST('true' AS JSON)),
    '$."billing.update"', CAST('true' AS JSON)),
    '$."clients.read"',  CAST('true' AS JSON))
  WHERE JSON_EXTRACT(permissions, '$."billing.read"') = true`
).catch(() => {});

// Lead management shipped after some orgs were already seeded — grant the new
// leads.* permissions to the same role keys seed.js now gives them by default,
// so an existing install doesn't need a full reseed to use the feature.
db.sequelize.query(
  `UPDATE roles SET permissions = JSON_SET(JSON_SET(JSON_SET(permissions,
    '$."leads.read"',   CAST('true' AS JSON)),
    '$."leads.act"',    CAST('true' AS JSON)),
    '$."leads.manage"', CAST('true' AS JSON))
  WHERE \`key\` IN ('project_manager', 'ads_manager') AND JSON_EXTRACT(permissions, '$."leads.manage"') IS NULL`
).catch(() => {});
db.sequelize.query(
  `UPDATE roles SET permissions = JSON_SET(JSON_SET(permissions,
    '$."leads.read"', CAST('true' AS JSON)),
    '$."leads.act"',  CAST('true' AS JSON))
  WHERE \`key\` = 'account_manager' AND JSON_EXTRACT(permissions, '$."leads.read"') IS NULL`
).catch(() => {});

// Add payment proof URL column to invoices. Errors silently if column already exists.
db.sequelize.query(
  `ALTER TABLE invoices ADD COLUMN payment_proof_url VARCHAR(500) NULL`
).catch(() => {});

// Portal login one-time code columns on contacts (email second factor). Silent if they exist.
db.sequelize.query('ALTER TABLE contacts ADD COLUMN `loginCodeHash` VARCHAR(255) NULL').catch(() => {});
db.sequelize.query('ALTER TABLE contacts ADD COLUMN `loginCodeExpiresAt` DATETIME NULL').catch(() => {});
db.sequelize.query('ALTER TABLE contacts ADD COLUMN `loginCodeAttempts` INT NOT NULL DEFAULT 0').catch(() => {});

// Note: client_packages (with discount fields) and hr_documents.type's full ENUM
// are managed by ClientPackage.ensureSchema() / HrDocument.ensureSchema() below
// (see app.schemaReady) — not raw SQL here, so there's one source of truth for
// each instead of two competing definitions.

// Portal notification table for client-facing notifications.
db.sequelize.query(`
  CREATE TABLE IF NOT EXISTS portal_notifications (
    id CHAR(36) NOT NULL PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    client_id CHAR(36) NOT NULL,
    type VARCHAR(80) NOT NULL,
    title VARCHAR(255) NOT NULL,
    body TEXT,
    ref_table VARCHAR(50),
    ref_id CHAR(36),
    is_read TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_client_read (client_id, is_read)
  )
`).catch(() => {});

// Departments and designations lookup tables
db.sequelize.query(`
  CREATE TABLE IF NOT EXISTS hr_departments (
    id CHAR(36) NOT NULL PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_dept (org_id, name)
  )
`).catch(() => {});

db.sequelize.query(`
  CREATE TABLE IF NOT EXISTS hr_designations (
    id CHAR(36) NOT NULL PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(100) NOT NULL,
    UNIQUE KEY uq_desig (org_id, name)
  )
`).catch(() => {});

// Seed default departments for each org (INSERT IGNORE skips duplicates)
db.sequelize.query(`
  INSERT IGNORE INTO hr_departments (id, org_id, name)
  SELECT UUID(), o.id, d.name
  FROM orgs o
  CROSS JOIN (
    SELECT 'SEO' AS name UNION ALL
    SELECT 'Website'     UNION ALL
    SELECT 'Applications' UNION ALL
    SELECT 'Marketing'
  ) d
`).catch(() => {});

// Seed default designations for each org
db.sequelize.query(`
  INSERT IGNORE INTO hr_designations (id, org_id, name)
  SELECT UUID(), o.id, d.name
  FROM orgs o
  CROSS JOIN (
    SELECT 'AM SEO' AS name              UNION ALL
    SELECT 'Manager SEO'                 UNION ALL
    SELECT 'SEO Officer'                 UNION ALL
    SELECT 'SEO Executive'               UNION ALL
    SELECT 'Web Developer Wordpress'     UNION ALL
    SELECT 'Web Developer Next'          UNION ALL
    SELECT 'Back Linker'
  ) d
`).catch(() => {});

// Bring tables for the models touched by the 2026-07-07 feature round in line with
// their current definitions (new columns on packages/projects/retainers/workers/
// attendances, plus the new client_packages table). Each model exposes `ensureSchema()`
// (backed by `utils/schemaSync.js#ensureColumns` — deliberately NOT `Model.sync()`,
// see that file for why) so the schema lives next to the model that owns it instead of
// hand-written SQL here. Order matters — a model referencing a new table must run
// after that table has been created.
// Exposed on `app.schemaReady` so server.js can await it before starting anything
// (e.g. RetainerScheduler) that queries these tables — otherwise a fresh migration
// races the column-add here against the first scheduler run.
app.schemaReady = (async () => {
  try {
    await db.ClientPackage.ensureSchema(); // new table; depends on packages/clients/orgs/users
    await db.Package.ensureSchema();
    await db.Project.ensureSchema();       // adds clientPackageId — depends on client_packages
    await db.Retainer.ensureSchema();      // adds projectId + clientPackageId
    await db.Invoice.ensureSchema();       // adds clientPackageId, retainerId — depends on client_packages/retainers
    // Hard backstop against duplicate retainer billing: if the invoicing scheduler
    // ever runs twice around the same cycle (a restart re-firing its immediate
    // on-boot pass, or more than one server process each running it), this stops a
    // second same-day invoice for the same retainer at the DB layer even if the
    // application-level check in RetainerScheduler races. NULLs (manual/installment
    // invoices with no retainerId) are never considered duplicates of each other.
    try {
      await db.sequelize.getQueryInterface().addIndex('invoices', ['retainer_id', 'issued_at'], {
        unique: true,
        name: 'invoices_retainer_id_issued_at_unique',
      });
    } catch (err) {
      // "Duplicate key name" / "already exists" = the index is already there, fine.
      // Any other failure (most likely "Duplicate entry ... for key" from existing
      // duplicate invoice rows) needs a human to look at it — surface it loudly.
      if (!/duplicate key name|already exists/i.test(err.message)) {
        console.error('[Schema] Could not add unique retainer/issued-date index on invoices — likely pre-existing duplicate invoices need cleanup first:', err.message);
      }
    }
    await db.User.ensureSchema();       // adds pendingEmail + email-change OTP columns
    await db.Worker.ensureSchema();     // adds pendingAmendmentDiff + widens status ENUM
    await db.Appraisal.ensureSchema();  // new table; depends on workers
    await db.TaxYear.ensureSchema();    // salary tax years
    await db.TaxSlab.ensureSchema();    // depends on tax_years
    await db.PayrollRun.ensureSchema(); // per-run workingDaysPerMonth
    await db.PayrollSettings.ensureSchema(); // adds shift/late/half-day attendance policy fields
    await db.PayrollItem.ensureSchema();     // adds lateCount/latePenaltyDays/latePenaltyUnpaidDays
    await db.LeaveRequest.ensureSchema();    // adds isHalfDay
    await db.Attendance.ensureSchema();      // adds isLate/lateMinutes
    await db.Holiday.ensureSchema();         // new table; public/company holidays
    await db.ShiftSchedule.ensureSchema();   // new table; seasonal shift timings (e.g. Ramadan)
    await db.HrDocument.ensureSchema(); // widens `type` ENUM (cv, cnic_front, cnic_back, ...)
    await db.Keyword.ensureSchema();    // adds targetLocation
    await db.RecurringTaskRule.ensureSchema(); // new table; depends on projects
    await db.Task.ensureSchema();       // adds ruleId — depends on recurring_task_rules
    await db.Artifact.ensureSchema();   // adds taskId — depends on tasks
    await db.Backlink.ensureSchema();   // widens `linkType` ENUM + adds date/domain/status/spamScore
    await db.ContentSubmission.ensureSchema(); // adds wordCount
    await db.BlogTask.ensureSchema();          // adds sheet columns + approval workflow fields
    await db.DocumentTemplate.ensureSchema();  // new table; Quotes & Agreements module
    await db.CustomerDocument.ensureSchema();  // new table; depends on document_templates/packages/clients/projects
    await db.DocumentEvent.ensureSchema();     // new table; depends on customer_documents
    await db.Payment.ensureSchema();           // widens `provider` ENUM + adds processingFee/methodLabel
    await db.PaymentMethod.ensureSchema();     // new table; portal payment options (Stripe + manual)
    await db.PaymentSetting.ensureSchema();    // new table; admin-managed card settings
    await db.PaymentFeeRule.ensureSchema();    // new table; per-currency processing fees
    await db.WhiteLabelConfig.ensureSchema();  // adds businessAddress/…/taxNumber + the letterhead block
    await db.Company.ensureSchema();           // new table; legal entities behind the letterhead
    await db.DocumentSequence.ensureSchema();  // new table; per-company/type/year document numbering
    await db.ChatRoom.ensureSchema();          // client-scoped Messages rooms
    await db.ChatMember.ensureSchema();        // depends on chat_rooms / users / contacts
    await db.ChatMessage.ensureSchema();       // depends on chat_rooms
    await db.ChatReaction.ensureSchema();      // depends on chat_messages
    await db.ChatRoomEvent.ensureSchema();     // depends on chat_rooms; room admin audit trail
    // Soft-delete rollout: every table that used to be hard-deleted from gets an
    // `is_active` flag instead (see models/softDeletable.js + services/SoftDeleteService.js).
    await db.Client.ensureSchema();
    await db.Contact.ensureSchema();
    await db.Comment.ensureSchema();
    await db.Role.ensureSchema();
    await db.SlaPolicy.ensureSchema();
    await db.HrDepartment.ensureSchema();
    await db.HrDesignation.ensureSchema();
    await db.LeadForm.ensureSchema();  // new table; depends on projects
    await db.Lead.ensureSchema();      // new table; depends on lead_forms/projects/clients
    await db.LeadEvent.ensureSchema(); // new table; depends on leads
  } catch (err) {
    console.error('[Schema] ensureSchema failed:', err.message);
  }

  // First-run data for the two features that need a working default to be usable
  // at all: an org with no payment methods shows an empty dropdown in the portal,
  // and an org with no companies has no letterhead to print. Both seeders no-op
  // once the org has rows, so an admin's edits (or deletions) are never undone.
  try {
    const orgs = await db.Org.findAll({ attributes: ['id'] });
    for (const org of orgs) {
      await db.PaymentMethod.seedDefaults(org.id);
      await db.PaymentFeeRule.seedDefaults(org.id);
      const branding = await db.WhiteLabelConfig.findOne({ where: { orgId: org.id } });
      await db.Company.seedFromBranding(org.id, branding ? branding.toJSON() : null);
    }
  } catch (err) {
    console.error('[Schema] first-run seeding failed:', err.message);
  }
})();

// One-time backfill: `User.avatarUrl` (used app-wide, e.g. the header) should mirror
// `Worker.profilePictureUrl` — profiles submitted before that sync existed left
// avatarUrl unset even though the worker's own photo was saved. Idempotent: only
// touches rows where the two are still out of sync.
app.schemaReady.then(async () => {
  try {
    const workers = await db.Worker.findAll({
      where: { profilePictureUrl: { [db.Sequelize.Op.ne]: null } },
      include: [{ model: db.User, as: 'user', attributes: ['id', 'avatarUrl'] }],
    });
    for (const w of workers) {
      if (w.user && w.user.avatarUrl !== w.profilePictureUrl) {
        await db.User.update({ avatarUrl: w.profilePictureUrl }, { where: { id: w.user.id } });
      }
    }
  } catch (err) {
    console.error('[Schema] avatarUrl backfill failed:', err.message);
  }
});

// Migrate legacy default green brand color to Mohsin Designs navy (logo palette).
app.schemaReady.then(async () => {
  try {
    const [count] = await db.WhiteLabelConfig.update(
      { primaryColor: DEFAULT_BRAND_COLOR },
      { where: { primaryColor: '#1D9E75' } },
    );
    if (count > 0) console.log(`[Schema] Updated ${count} org brand color(s) to navy.`);
  } catch (err) {
    console.error('[Schema] brand color migration failed:', err.message);
  }
});

// One-time backfill: ensure every org has a 'blog_writer' role so it's assignable
// on projects (needed by the recurring auto-task engine — weekly blog posts go
// to whoever holds it). Not in the original seed data for orgs created before
// this feature existed. Idempotent via findOrCreate on (orgId, key).
app.schemaReady.then(async () => {
  try {
    const orgs = await db.Org.findAll({ attributes: ['id'] });
    for (const org of orgs) {
      await db.Role.findOrCreate({
        where: { orgId: org.id, key: 'blog_writer' },
        defaults: { name: 'Blog Writer', color: '#9333EA', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
      });
    }
  } catch (err) {
    console.error('[Schema] blog_writer role backfill failed:', err.message);
  }
});

// One-time backfill: the monthly SEO review used to go to a dedicated 'seo_manager'
// role slot — this org's actual structure is just Project Strategist (does the work) +
// Project Manager (oversees), so that role was removed. Migrate anything already
// pointing at it: recurring rules get repointed to 'project_manager' directly, and
// any 'seo_manager' project assignment is dropped if a 'project_manager' one
// already exists for that project (can't have two rows for the same role slot per
// project — unique index — so this avoids a conflict) or renamed otherwise.
// Finally the now-unused 'seo_manager' Role rows themselves are deleted.
app.schemaReady.then(async () => {
  try {
    await db.RecurringTaskRule.update(
      { roleSlot: 'project_manager' },
      { where: { roleSlot: 'seo_manager' } }
    );

    const staleAssignments = await db.ProjectAssignment.findAll({ where: { roleSlot: 'seo_manager' } });
    for (const a of staleAssignments) {
      const existingPm = await db.ProjectAssignment.findOne({ where: { projectId: a.projectId, roleSlot: 'project_manager' } });
      if (existingPm) await a.destroy();
      else await a.update({ roleSlot: 'project_manager' });
    }

    const deleted = await db.Role.destroy({ where: { key: 'seo_manager' } });
    if (deleted > 0) console.log(`[Schema] Removed ${deleted} unused 'seo_manager' role(s).`);
  } catch (err) {
    console.error('[Schema] seo_manager -> project_manager migration failed:', err.message);
  }
});

// One-time backfill: `Project.isRecurring` should mirror its `WorkflowTemplate.
// isRecurring` — the "New Project" form never sent isRecurring in the request
// body, so ProjectService#create silently defaulted every project (including
// GMB/SEO ones) to non-recurring regardless of the template. That's what made
// the terminal-stage recurring-task prompt never appear for those projects.
// Idempotent: only touches rows where the two are still out of sync.
app.schemaReady.then(async () => {
  try {
    const templates = await db.WorkflowTemplate.findAll({ where: { isRecurring: true }, attributes: ['id'] });
    const templateIds = templates.map((t) => t.id);
    if (templateIds.length) {
      await db.Project.update(
        { isRecurring: true },
        { where: { workflowTemplateId: { [db.Sequelize.Op.in]: templateIds }, isRecurring: false } }
      );
    }
  } catch (err) {
    console.error('[Schema] Project.isRecurring backfill failed:', err.message);
  }
});

// One-time backfill: performAction used to check the stage being LEFT for
// isTerminal instead of the stage being REACHED, so a project only ever flipped
// to "completed" on the rare hop out of an already-terminal stage — reaching a
// terminal stage for the first time (Hosting's "Live", GMB's "Recurring Posts",
// etc.) left status stuck on "active" everywhere in the app (Dashboard, Projects
// list, ...) even though the stage timeline showed the terminal stage reached.
// Catches up every project already sitting on a terminal stage. Idempotent: only
// touches rows that are still active.
app.schemaReady.then(async () => {
  try {
    const terminalStages = await db.Stage.findAll({
      where: { isTerminal: true },
      attributes: ['templateId', 'key'],
    });
    if (!terminalStages.length) return;

    const byTemplate = new Map();
    for (const s of terminalStages) {
      if (!byTemplate.has(s.templateId)) byTemplate.set(s.templateId, []);
      byTemplate.get(s.templateId).push(s.key);
    }

    const activeProjects = await db.Project.findAll({
      where: { status: 'active' },
      attributes: ['id', 'workflowTemplateId', 'currentStageKey'],
    });
    const staleIds = activeProjects
      .filter((p) => (byTemplate.get(p.workflowTemplateId) || []).includes(p.currentStageKey))
      .map((p) => p.id);

    if (staleIds.length) {
      await db.Project.update({ status: 'completed' }, { where: { id: { [db.Sequelize.Op.in]: staleIds } } });
      console.log(`[Schema] Marked ${staleIds.length} project(s) completed — already on a terminal stage.`);
    }
  } catch (err) {
    console.error('[Schema] Terminal-stage project status backfill failed:', err.message);
  }
});

// One-time backfill: projects created via the old "New Project" flow (before it
// routed package selections through ClientService#sellPackage) have `packageId`
// set — for naming only — but no `ClientPackage` (sale) record, so the client's
// "Sold Packages" tab shows nothing even though the project is clearly
// package-based. Retroactively creates one ClientPackage per (client, package)
// pair still missing one, at the package's current list price (no discount —
// none was recorded at creation time), and links the orphaned project(s) to it.
// Idempotent: only touches projects where clientPackageId is still null.
app.schemaReady.then(async () => {
  try {
    const orphans = await db.Project.findAll({
      where: { packageId: { [db.Sequelize.Op.ne]: null }, clientPackageId: null },
      include: [{ model: db.Package, as: 'package', attributes: ['id', 'price', 'currency', 'isRecurring'] }],
    });
    if (!orphans.length) return;

    const groups = new Map(); // `${clientId}:${packageId}` -> projects[]
    for (const p of orphans) {
      const key = `${p.clientId}:${p.packageId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    for (const projects of groups.values()) {
      const first = projects[0];
      const pkg = first.package;
      const clientPackage = await db.ClientPackage.create({
        id: require('uuid').v4(),
        orgId: first.orgId,
        clientId: first.clientId,
        packageId: first.packageId,
        soldPrice: pkg?.price || 0,
        currency: pkg?.currency || 'USD',
        status: 'active',
        startDate: first.startDate,
      });
      await db.Project.update(
        { clientPackageId: clientPackage.id },
        { where: { id: { [db.Sequelize.Op.in]: projects.map((p) => p.id) } } }
      );
    }
    console.log(`[Schema] Backfilled ${groups.size} ClientPackage record(s) for orphaned package-linked projects.`);
  } catch (err) {
    console.error('[Schema] ClientPackage backfill failed:', err.message);
  }
});

// One-time backfill: retainers missing packageId but linked via clientPackage or project.
app.schemaReady.then(async () => {
  try {
    const { Op } = db.Sequelize;
    const orphanRetainers = await db.Retainer.findAll({
      where: {
        packageId: null,
        [Op.or]: [
          { clientPackageId: { [Op.ne]: null } },
          { projectId: { [Op.ne]: null } },
        ],
      },
      include: [
        { model: db.ClientPackage, as: 'clientPackage', attributes: ['id', 'packageId', 'soldPrice'], required: false },
        { model: db.Project, as: 'project', attributes: ['id', 'packageId', 'clientPackageId'], required: false },
      ],
    });
    let fixed = 0;
    for (const r of orphanRetainers) {
      const packageId = r.clientPackage?.packageId || r.project?.packageId || null;
      const clientPackageId = r.clientPackageId || r.project?.clientPackageId || null;
      if (!packageId && !clientPackageId) continue;
      const patch = {};
      if (!r.packageId && packageId) patch.packageId = packageId;
      if (!r.clientPackageId && clientPackageId) patch.clientPackageId = clientPackageId;
      // Repair $0 amounts when we know the sold package price.
      if (Number(r.amount) === 0 && r.clientPackage?.soldPrice != null && Number(r.clientPackage.soldPrice) > 0) {
        patch.amount = r.clientPackage.soldPrice;
      }
      if (Object.keys(patch).length) {
        await r.update(patch);
        fixed += 1;
      }
    }
    if (fixed) console.log(`[Schema] Backfilled package linkage on ${fixed} retainer(s).`);
  } catch (err) {
    console.error('[Schema] Retainer packageId backfill failed:', err.message);
  }
});

// Sync Team members into HR on startup via ORM — listWorkers() handles the per-org upsert.
// Fetch every distinct org and trigger the sync so all existing users get worker records.
(async () => {
  try {
    const { Org } = require('./models');
    const HrService = require('./services/HrService');
    const orgs = await Org.findAll({ attributes: ['id'] });
    await Promise.all(orgs.map((o) => HrService.listWorkers(o.id).catch(() => {})));
  } catch (_) { /* silent — non-critical startup task */ }
})();

module.exports = app;
