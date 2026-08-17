/**
 * QA demo data for non-chat fixes from recent work.
 * Does NOT create ChatRoom / ChatMember / ChatMessage rows.
 *
 * Prerequisites: base seed already applied (org + roles + SEO workflow + admin).
 *
 * Run:
 *   npm run db:seed:qa
 *   npm run db:seed:qa -- --force   # delete prior QA Demo Client pack and recreate
 *
 * Marker client name: "QA Demo Client"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const db = require('../models');
// Bring schema up to date the same way seed.js does.
const app = require('../app');

const DEMO_CLIENT_NAME = 'QA Demo Client';
const DEMO_INVOICE_PREFIX = 'QA-INV-';
const FORCE = process.argv.includes('--force');

const SECONDARY_KEYWORDS = [
  'seo services near me',
  'local seo agency',
  'on page optimization',
  'technical seo audit',
  'keyword research tools',
  'content marketing strategy',
  'google business profile',
  'link building services',
  'seo reporting dashboard',
  'ecommerce seo checklist',
].join(', ');

const SUPPORTING_KEYWORDS = [
  'pillar content',
  'topic cluster',
  'search intent',
  'internal linking',
  'featured snippet',
  'content calendar',
  'blog seo checklist',
  'conversion copy',
].join(', ');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Most recent Saturday (UTC), for weekend attendance demo. */
function lastSaturday() {
  const d = new Date();
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  const back = dow === 6 ? 0 : (dow + 1) % 7 || 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

async function wipeDemoPack(orgId, clientId) {
  const projects = await db.Project.findAll({ where: { orgId, clientId }, attributes: ['id'] });
  const projectIds = projects.map((p) => p.id);
  const invoices = await db.Invoice.findAll({ where: { orgId, clientId }, attributes: ['id'] });
  const invoiceIds = invoices.map((i) => i.id);
  const tasks = projectIds.length
    ? await db.Task.findAll({ where: { projectId: { [Op.in]: projectIds } }, attributes: ['id'] })
    : [];
  const taskIds = tasks.map((t) => t.id);

  if (taskIds.length) await db.TaskEvent.destroy({ where: { taskId: { [Op.in]: taskIds } } });
  // Tasks reference project_cycles — delete tasks before cycles.
  if (taskIds.length) await db.Task.destroy({ where: { id: { [Op.in]: taskIds } } });
  if (projectIds.length) {
    await db.Artifact.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Comment.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ContentSubmission.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Keyword.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Backlink.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.BlogTask.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.RankSnapshot.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.RecurringTaskRule.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ProjectEvent.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ProjectAssignment.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ProjectCycle.destroy({ where: { projectId: { [Op.in]: projectIds } } });
  }
  if (invoiceIds.length) {
    await db.Payment.destroy({ where: { invoiceId: { [Op.in]: invoiceIds } } });
    await db.InvoiceLine.destroy({ where: { invoiceId: { [Op.in]: invoiceIds } } });
    await db.Invoice.destroy({ where: { id: { [Op.in]: invoiceIds } } });
  }
  await db.Retainer.destroy({ where: { clientId } });
  await db.Contact.destroy({ where: { clientId } });
  await db.ClientPackage.destroy({ where: { clientId } });
  await db.PortalNotification.destroy({ where: { clientId } }).catch(() => {});
  await db.Notification.destroy({
    where: {
      orgId,
      [Op.or]: [
        { refTable: 'projects', refId: { [Op.in]: projectIds.length ? projectIds : ['__none__'] } },
        { refTable: 'invoices', refId: { [Op.in]: invoiceIds.length ? invoiceIds : ['__none__'] } },
        { title: { [Op.like]: 'QA Demo%' } },
      ],
    },
  });
  if (projectIds.length) await db.Project.destroy({ where: { id: { [Op.in]: projectIds } } });
  await db.Client.destroy({ where: { id: clientId } });
}

async function seed() {
  await app.schemaReady;
  await db.sequelize.authenticate();

  const org = await db.Org.findOne({ order: [['createdAt', 'ASC']] });
  if (!org) {
    console.error('No org found. Run `npm run db:seed` first.');
    process.exit(1);
  }
  const orgId = org.id;

  const superRole = await db.Role.findOne({ where: { orgId, key: 'super_admin' } });
  const adminUser = (superRole
    ? await db.User.findOne({ where: { orgId, roleId: superRole.id }, order: [['createdAt', 'ASC']] })
    : null) || await db.User.findOne({ where: { orgId }, order: [['createdAt', 'ASC']] });
  if (!adminUser) {
    console.error('No users found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const existing = await db.Client.findOne({ where: { orgId, name: DEMO_CLIENT_NAME } });
  if (existing && !FORCE) {
    console.log(`✓ QA demo already present (client "${DEMO_CLIENT_NAME}").`);
    console.log('  Re-run with --force to wipe and recreate that pack only.');
    printGuide({ orgId, clientId: existing.id, adminEmail: adminUser.email });
    process.exit(0);
  }
  if (existing && FORCE) {
    console.log('Removing previous QA Demo Client pack…');
    await wipeDemoPack(orgId, existing.id);
  }

  const seoTemplate = await db.WorkflowTemplate.findOne({
    where: { orgId, serviceTypeKey: 'seo', isActive: true },
    order: [['version', 'DESC']],
  });
  if (!seoTemplate) {
    console.error('No SEO workflow template. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const writerRole = await db.Role.findOne({ where: { orgId, key: 'content_writer' } });
  const strategistRole = await db.Role.findOne({ where: { orgId, key: 'project_strategist' } });
  const employeeRole = await db.Role.findOne({ where: { orgId, key: 'employee' } });

  const passwordHash = await bcrypt.hash('Demo@1234', 10);

  // Demo teammates (public profile + assignments) — skip chat memberships.
  const [writerUser] = await db.User.findOrCreate({
    where: { orgId, email: 'qa.writer@mohsindesigns.com' },
    defaults: {
      id: uuidv4(),
      orgId,
      roleId: writerRole?.id || adminUser.roleId,
      name: 'QA Content Writer',
      email: 'qa.writer@mohsindesigns.com',
      passwordHash,
      phone: '+92-300-1112233',
      isActive: true,
    },
  });
  const [strategistUser] = await db.User.findOrCreate({
    where: { orgId, email: 'qa.strategist@mohsindesigns.com' },
    defaults: {
      id: uuidv4(),
      orgId,
      roleId: strategistRole?.id || adminUser.roleId,
      name: 'QA Strategist',
      email: 'qa.strategist@mohsindesigns.com',
      passwordHash,
      phone: '+92-300-4445566',
      isActive: true,
    },
  });
  const [profileUser] = await db.User.findOrCreate({
    where: { orgId, email: 'qa.profile@mohsindesigns.com' },
    defaults: {
      id: uuidv4(),
      orgId,
      roleId: employeeRole?.id || adminUser.roleId,
      name: 'Ayesha Khan',
      email: 'qa.profile@mohsindesigns.com',
      passwordHash,
      phone: '+92-321-7654321',
      isActive: true,
    },
  });

  await db.Worker.findOrCreate({
    where: { orgId, userId: profileUser.id },
    defaults: {
      id: uuidv4(),
      orgId,
      userId: profileUser.id,
      workerType: 'employee',
      payModel: 'salary',
      designation: 'Account Executive',
      department: 'Client Success',
      joiningDate: daysAgo(120),
      salaryBase: 85000,
      currency: 'PKR',
      status: 'active',
    },
  });
  await db.Worker.findOrCreate({
    where: { orgId, userId: writerUser.id },
    defaults: {
      id: uuidv4(),
      orgId,
      userId: writerUser.id,
      workerType: 'employee',
      payModel: 'salary',
      designation: 'Content Writer',
      department: 'SEO',
      joiningDate: daysAgo(200),
      salaryBase: 70000,
      currency: 'PKR',
      status: 'active',
    },
  });

  // Attendance weekends: ensure Sat+Sun off days.
  const [payrollSettings] = await db.PayrollSettings.findOrCreate({
    where: { orgId },
    defaults: { orgId, weekendDays: [0, 6], halfDayRestrictedDays: [1, 5] },
  });
  if (JSON.stringify(payrollSettings.weekendDays || []) !== JSON.stringify([0, 6])) {
    await payrollSettings.update({ weekendDays: [0, 6] });
  }

  const writerWorker = await db.Worker.findOne({ where: { orgId, userId: writerUser.id } });
  if (writerWorker) {
    await db.Attendance.findOrCreate({
      where: { workerId: writerWorker.id, date: lastSaturday() },
      defaults: {
        id: uuidv4(),
        orgId,
        workerId: writerWorker.id,
        date: lastSaturday(),
        status: 'weekend',
      },
    });
  }

  // Packages for multi-line invoice (no PACKAGE block on PDF; merge test).
  let pkgSeo = await db.Package.findOne({ where: { orgId, name: 'QA SEO Starter' } });
  if (!pkgSeo) {
    pkgSeo = await db.Package.create({
      id: uuidv4(),
      orgId,
      serviceTypeKey: 'seo',
      name: 'QA SEO Starter',
      tier: 'starter',
      price: 950,
      currency: 'USD',
      features: ['Keyword research', 'On-page', 'Monthly report'],
      services: [{ serviceTypeKey: 'seo', workflowTemplateId: seoTemplate.id }],
      isRecurring: true,
      billingCycle: 'monthly',
      isActive: true,
    });
  }
  let pkgContent = await db.Package.findOne({ where: { orgId, name: 'QA Content Add-on' } });
  if (!pkgContent) {
    pkgContent = await db.Package.create({
      id: uuidv4(),
      orgId,
      serviceTypeKey: 'seo',
      name: 'QA Content Add-on',
      tier: 'addon',
      price: 450,
      currency: 'USD',
      features: ['4 blogs / month'],
      services: [{ serviceTypeKey: 'seo', workflowTemplateId: seoTemplate.id }],
      isRecurring: false,
      billingCycle: 'monthly',
      isActive: true,
      skipProjectCreation: true,
    });
  }

  const client = await db.Client.create({
    id: uuidv4(),
    orgId,
    name: DEMO_CLIENT_NAME,
    status: 'active',
    defaultCurrency: 'USD',
    // `notes` is shown to real users on the client record, so it must read as
    // content, not as a message from the build system. The name already says
    // this is demo data; naming the npm script that made it does not help
    // anyone looking at the CRM.
    notes: 'Demo data for testing. Safe to delete.',
    isActive: true,
  });

  await db.Contact.create({
    id: uuidv4(),
    clientId: client.id,
    name: 'Jordan Lee',
    email: 'billing@qademoclient.test',
    phone: '+1-555-0100',
    role: 'Billing',
    businessName: 'QA Demo Client LLC',
    billingAddress: '100 Test Ave, Austin, TX 78701',
    state: 'TX',
    useForInvoice: true,
    isActive: true,
  });

  const cp1 = await db.ClientPackage.create({
    id: uuidv4(),
    orgId,
    clientId: client.id,
    packageId: pkgSeo.id,
    basePrice: 950,
    soldPrice: 950,
    currency: 'USD',
    billingCycle: 'monthly',
    status: 'active',
    startDate: today(),
    createdBy: adminUser.id,
  });
  const cp2 = await db.ClientPackage.create({
    id: uuidv4(),
    orgId,
    clientId: client.id,
    packageId: pkgContent.id,
    basePrice: 450,
    soldPrice: 450,
    currency: 'USD',
    billingCycle: 'monthly',
    status: 'active',
    startDate: today(),
    createdBy: adminUser.id,
  });

  // Single invoice with BOTH packages as line items (merged-sale scenario).
  const invoiceNumber = `${DEMO_INVOICE_PREFIX}${Date.now().toString().slice(-6)}`;
  const invoice = await db.Invoice.create({
    id: uuidv4(),
    orgId,
    clientId: client.id,
    clientPackageId: cp1.id,
    number: invoiceNumber,
    currency: 'USD',
    status: 'sent',
    issuedAt: today(),
    dueAt: daysAgo(-14),
    total: 1400,
    notes: 'QA demo — one invoice covering two packages. PDF should list line items only (no PACKAGE / What\'s included block).',
  });
  await db.InvoiceLine.bulkCreate([
    {
      id: uuidv4(),
      invoiceId: invoice.id,
      description: 'QA SEO Starter — monthly retainer',
      qty: 1,
      unitPrice: 950,
      amount: 950,
    },
    {
      id: uuidv4(),
      invoiceId: invoice.id,
      description: 'QA Content Add-on — 4 blogs',
      qty: 1,
      unitPrice: 450,
      amount: 450,
    },
  ]);

  // SEO project stuck in Content Writing with approved content + leftover tasks.
  const project = await db.Project.create({
    id: uuidv4(),
    orgId,
    clientId: client.id,
    name: 'QA Demo SEO — Content Writing',
    serviceTypeKey: 'seo',
    workflowTemplateId: seoTemplate.id,
    packageId: pkgSeo.id,
    clientPackageId: cp1.id,
    currentStageKey: 'content_writing',
    status: 'active',
    startDate: daysAgo(30),
    isRecurring: true,
    description: 'QA: all keywords have approved content; leftover content tasks should not block Mark Complete.',
    createdBy: adminUser.id,
  });

  await db.ProjectAssignment.bulkCreate([
    {
      id: uuidv4(),
      projectId: project.id,
      userId: writerUser.id,
      roleSlot: 'content_writer',
    },
    {
      id: uuidv4(),
      projectId: project.id,
      userId: strategistUser.id,
      roleSlot: 'project_strategist',
    },
    {
      id: uuidv4(),
      projectId: project.id,
      userId: adminUser.id,
      roleSlot: 'project_manager',
    },
  ]);

  const cycle = await db.ProjectCycle.create({
    id: uuidv4(),
    projectId: project.id,
    period: `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, '0')}`,
    status: 'active',
  });

  const kwHome = await db.Keyword.create({
    id: uuidv4(),
    projectId: project.id,
    cycleId: cycle.id,
    primaryKeyword: 'seo agency austin',
    secondaryKeywords: SECONDARY_KEYWORDS,
    kd: 28,
    volume: 2400,
    pageName: 'Home',
    targetUrl: 'https://qademoclient.test/',
    status: 'active',
    assignedWriterId: writerUser.id,
    sortOrder: 0,
    createdBy: adminUser.id,
  });
  const kwAbout = await db.Keyword.create({
    id: uuidv4(),
    projectId: project.id,
    cycleId: cycle.id,
    primaryKeyword: 'about our seo team',
    secondaryKeywords: 'company story, meet the team, seo experts, agency values, why choose us, our process',
    kd: 12,
    volume: 320,
    pageName: 'About',
    targetUrl: 'https://qademoclient.test/about',
    status: 'active',
    assignedWriterId: writerUser.id,
    sortOrder: 1,
    createdBy: adminUser.id,
  });
  const kwServices = await db.Keyword.create({
    id: uuidv4(),
    projectId: project.id,
    cycleId: cycle.id,
    primaryKeyword: 'managed seo services',
    secondaryKeywords: SECONDARY_KEYWORDS,
    kd: 35,
    volume: 1900,
    pageName: 'Services',
    targetUrl: 'https://qademoclient.test/services',
    status: 'active',
    assignedWriterId: writerUser.id,
    sortOrder: 2,
    createdBy: adminUser.id,
  });

  // Content tab: mix of approved (Mark Complete) + pending (review UI).
  const contentRows = [
    ['Home', [kwHome.id], 'approved'],
    ['About', [kwAbout.id], 'approved'],
    ['Services', [kwServices.id], 'approved'],
    ['Pricing', [kwServices.id], 'pending'],
  ];
  for (const [page, kws, status] of contentRows) {
    await db.ContentSubmission.create({
      id: uuidv4(),
      projectId: project.id,
      pageName: page,
      keywordIds: kws,
      fileUrl: 'https://example.com/qa-demo-content.docx',
      fileName: `${page}-content.docx`,
      submittedBy: writerUser.id,
      wordCount: status === 'pending' ? 980 : 1200,
      status,
      reviewedBy: status === 'approved' ? strategistUser.id : null,
      reviewedAt: status === 'approved' ? new Date() : null,
    });
  }

  // Leftover auto content tasks still "todo" — should be cleared on Mark Complete.
  for (const page of ['Home', 'About', 'Services']) {
    await db.Task.create({
      id: uuidv4(),
      orgId,
      projectId: project.id,
      cycleId: cycle.id,
      stageKey: 'content_writing',
      type: 'content',
      title: `Write content — ${page}`,
      pageName: page,
      assigneeId: writerUser.id,
      status: 'todo',
      autoCreated: true,
      createdBy: adminUser.id,
    });
  }

  // Backlinks for PDF split (Backlinks tab only).
  await db.Backlink.bulkCreate([
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      sourceUrl: 'https://partner-site.test/resources/seo',
      targetUrl: 'https://qademoclient.test/',
      anchorText: 'seo agency austin',
      da: 42,
      linkType: 'dofollow',
      isIndexed: true,
      addedBy: adminUser.id,
      assignedWriterId: strategistUser.id,
      date: daysAgo(10),
      isActive: true,
    },
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      sourceUrl: 'https://directory.test/listings/qa-demo',
      targetUrl: 'https://qademoclient.test/services',
      anchorText: 'managed seo services',
      da: 28,
      linkType: 'nofollow',
      isIndexed: false,
      addedBy: adminUser.id,
      date: daysAgo(4),
      isActive: true,
    },
  ]);

  // Blogs — chips + statuses (pending = ready for strategist/PM review on Blogs tab).
  await db.BlogTask.bulkCreate([
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      title: 'How Local SEO Wins Clients in 2026',
      contentType: 'PILLAR',
      mainKeyword: 'local seo agency',
      volume: 1800,
      kd: 30,
      supportingKeywords: SUPPORTING_KEYWORDS,
      urlSlug: 'local-seo-wins-clients',
      status: 'approved',
      assignedWriterId: writerUser.id,
      submittedBy: writerUser.id,
      reviewedBy: strategistUser.id,
      reviewedAt: new Date(),
      fileUrl: 'https://example.com/qa-blog-pillar.docx',
      sortOrder: 0,
      createdBy: adminUser.id,
      isActive: true,
    },
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      title: 'On-Page Checklist for Service Pages',
      contentType: 'Cluster',
      mainKeyword: 'on page optimization',
      volume: 720,
      kd: 18,
      supportingKeywords: SUPPORTING_KEYWORDS,
      urlSlug: 'on-page-checklist',
      status: 'pending',
      assignedWriterId: writerUser.id,
      submittedBy: writerUser.id,
      fileUrl: 'https://example.com/qa-blog-cluster.docx',
      sortOrder: 1,
      createdBy: adminUser.id,
      isActive: true,
    },
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      title: 'Building Topic Clusters That Rank',
      contentType: 'Cluster',
      mainKeyword: 'topic cluster seo',
      volume: 540,
      kd: 22,
      supportingKeywords: 'cluster map, pillar page, internal links, semantic keywords, content briefs, outline templates, writer workflow',
      urlSlug: 'topic-clusters-that-rank',
      status: 'pending',
      assignedWriterId: writerUser.id,
      submittedBy: writerUser.id,
      fileUrl: 'https://example.com/qa-blog-clusters.docx',
      sortOrder: 2,
      createdBy: adminUser.id,
      isActive: true,
    },
    {
      id: uuidv4(),
      projectId: project.id,
      cycleId: cycle.id,
      title: 'Draft: Seasonal SEO Calendar',
      contentType: 'Cluster',
      mainKeyword: 'seo content calendar',
      volume: 410,
      kd: 14,
      supportingKeywords: SUPPORTING_KEYWORDS,
      urlSlug: 'seasonal-seo-calendar',
      status: 'draft',
      assignedWriterId: writerUser.id,
      sortOrder: 3,
      createdBy: adminUser.id,
      isActive: true,
    },
  ]);

  // Non-chat notifications for Header bell (clean bodies + one legacy wire-format body to verify FE sanitizer).
  await db.Notification.bulkCreate([
    {
      id: uuidv4(),
      orgId,
      recipientId: adminUser.id,
      channel: 'in_app',
      type: 'blog_submitted',
      title: 'QA Demo · Blog submitted for review',
      body: 'On-Page Checklist for Service Pages is ready for review.',
      refTable: 'projects',
      refId: project.id,
      isRead: false,
    },
    {
      id: uuidv4(),
      orgId,
      recipientId: adminUser.id,
      channel: 'in_app',
      type: 'content_rejected',
      title: 'QA Demo · Sample clean notification',
      body: 'This body has no mention tokens — baseline UI check.',
      refTable: 'projects',
      refId: project.id,
      isRead: false,
    },
    {
      id: uuidv4(),
      orgId,
      recipientId: adminUser.id,
      channel: 'in_app',
      type: 'blog_approved',
      title: 'QA Demo · Mention preview sanitizer',
      // Intentionally raw wire format — FE formatMentionPreview should show @QA Strategist only.
      body: `@[QA Strategist](user:${strategistUser.id}) approved the pillar blog.`,
      refTable: 'projects',
      refId: project.id,
      isRead: false,
    },
  ]);

  const verify = {
    keywords: await db.Keyword.count({ where: { projectId: project.id } }),
    content: await db.ContentSubmission.count({ where: { projectId: project.id } }),
    contentPending: await db.ContentSubmission.count({ where: { projectId: project.id, status: 'pending' } }),
    blogs: await db.BlogTask.count({ where: { projectId: project.id } }),
    blogsPending: await db.BlogTask.count({ where: { projectId: project.id, status: 'pending' } }),
  };
  if (!verify.keywords || !verify.content || !verify.blogs) {
    throw new Error(`QA seed verification failed: ${JSON.stringify(verify)}`);
  }

  console.log('\n✓ QA demo seed complete (no chat rooms/messages created).');
  console.log(`  Verified on project: ${verify.keywords} keywords, ${verify.content} content (${verify.contentPending} pending), ${verify.blogs} blogs (${verify.blogsPending} pending)\n`);
  printGuide({
    orgId,
    clientId: client.id,
    projectId: project.id,
    invoiceId: invoice.id,
    invoiceNumber,
    adminEmail: adminUser.email,
    writerEmail: writerUser.email,
    strategistEmail: strategistUser.email,
    profileEmail: profileUser.email,
    profileUserId: profileUser.id,
    verify,
  });
  process.exit(0);
}

function printGuide(info) {
  console.log('══════════════════════════════════════════════════════════════');
  console.log(' QA DEMO — WHAT WAS ADDED & HOW TO TEST');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` Org:              ${info.orgId}`);
  console.log(` Client:           ${DEMO_CLIENT_NAME}  (${info.clientId || 'existing'})`);
  if (info.projectId) console.log(` SEO project:      ${info.projectId}`);
  if (info.invoiceNumber) console.log(` Invoice:          ${info.invoiceNumber}  (${info.invoiceId})`);
  console.log(` Login (admin):    ${info.adminEmail}`);
  if (info.writerEmail) {
    console.log(` Demo users pass:  Demo@1234`);
    console.log(`   Writer:         ${info.writerEmail}`);
    console.log(`   Strategist:     ${info.strategistEmail}`);
    console.log(`   Public profile: ${info.profileEmail}  (userId ${info.profileUserId})`);
  }
  console.log('');
  if (info.projectId) {
    console.log(` Open project:     /projects/${info.projectId}`);
    console.log(`   Content tab:    /projects/${info.projectId}?tab=content`);
    console.log(`   Blogs tab:      /projects/${info.projectId}?tab=blogs`);
  }
  console.log('');
  console.log(' 1) Content + Blogs for review');
  console.log('    Project: QA Demo SEO — Content Writing (NOT Verensoft)');
  console.log('    Content tab → submissions (incl. Pending “Pricing”)');
  console.log('    Blogs tab → Pending rows ready to Approve / Request changes');
  console.log('');
  console.log(' 2) Supporting keywords chips (+N more)');
  console.log('    Keywords / Blogs tabs on the same project');
  console.log('');
  console.log(' 3) Mark Complete on Content Writing');
  console.log('    3 approved content pages + leftover todo content tasks');
  console.log('');
  console.log(' 4) Keywords vs Backlinks PDF split');
  console.log('    Keywords tab vs Backlinks tab on the same project');
  console.log('');
  console.log(' 5) Invoice PDF (merged packages, no PACKAGE block)');
  console.log('    Invoices → QA-INV-*');
  console.log('');
  console.log(' 6) Attendance weekends + notification sanitizer + public profile');
  console.log('    (see prior notes; chat rooms not seeded)');
  console.log('');
  console.log(' NOT seeded: ChatRoom / ChatMember / ChatMessage.');
  console.log('══════════════════════════════════════════════════════════════\n');
}

seed().catch((err) => {
  console.error('QA demo seed failed:', err);
  process.exit(1);
});
