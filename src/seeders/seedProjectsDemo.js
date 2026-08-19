/**
 * Demo data for exercising the project detail page across non-SEO service
 * types (SEO already has deep coverage via `db:seed:qa`). Creates three
 * projects, each parked mid-workflow with a realistic stage history, mixed
 * task statuses, comments, and artifacts:
 *   - Web Development  → sitting in "QA & Testing" (approval stage)
 *   - App Development  → sitting in "Development" (work stage)
 *   - Social Media     → sitting in "Review & Approval" (approval stage)
 *
 * Prerequisites: base seed already applied (org + roles + workflow templates + admin).
 *
 * Run:
 *   npm run db:seed:projects
 *   npm run db:seed:projects -- --force   # wipe and recreate the three demo packs
 *
 * Marker clients: "Acme Retail Co", "Nimbus Health Co", "Bright Bakery Co"
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const db = require('../models');
const app = require('../app');

const FORCE = process.argv.includes('--force');

function today() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function hoursAgo(n) {
  return new Date(Date.now() - n * 3600 * 1000);
}

async function ensureDemoUser(orgId, roleKey, fallbackRoleId, email, name, phone) {
  const role = await db.Role.findOne({ where: { orgId, key: roleKey } });
  const passwordHash = await bcrypt.hash('Demo@1234', 10);
  const [user] = await db.User.findOrCreate({
    where: { orgId, email },
    defaults: {
      id: uuidv4(),
      orgId,
      roleId: role?.id || fallbackRoleId,
      name,
      email,
      passwordHash,
      phone,
      isActive: true,
    },
  });
  return user;
}

async function wipeClientPack(orgId, clientId) {
  const projects = await db.Project.findAll({ where: { orgId, clientId }, attributes: ['id'] });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length) {
    await db.Task.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Artifact.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Comment.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ProjectEvent.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.ProjectAssignment.destroy({ where: { projectId: { [Op.in]: projectIds } } });
    await db.Notification.destroy({
      where: { orgId, refTable: 'projects', refId: { [Op.in]: projectIds } },
    }).catch(() => {});
    await db.Project.destroy({ where: { id: { [Op.in]: projectIds } } });
  }
  await db.Contact.destroy({ where: { clientId } });
  await db.Client.destroy({ where: { id: clientId } });
}

/** Replays `events` (ordered oldest→newest) as ProjectEvent rows and leaves the
 *  project sitting on the last event's toStageKey. */
async function applyStageHistory(project, events) {
  let ts = hoursAgo(events.length * 20);
  for (const ev of events) {
    await db.ProjectEvent.create({
      id: uuidv4(),
      projectId: project.id,
      fromStageKey: ev.from,
      toStageKey: ev.to,
      action: ev.action,
      actorUserId: ev.actorId,
      note: ev.note || null,
      createdAt: ts,
    });
    ts = new Date(ts.getTime() + 20 * 3600 * 1000);
  }
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

  const webTemplate = await db.WorkflowTemplate.findOne({ where: { orgId, serviceTypeKey: 'web', isActive: true }, order: [['version', 'DESC']] });
  const appTemplate = await db.WorkflowTemplate.findOne({ where: { orgId, serviceTypeKey: 'app', isActive: true }, order: [['version', 'DESC']] });
  const socialTemplate = await db.WorkflowTemplate.findOne({ where: { orgId, serviceTypeKey: 'social', isActive: true }, order: [['version', 'DESC']] });
  if (!webTemplate || !appTemplate || !socialTemplate) {
    console.error('Workflow templates missing. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const CLIENT_NAMES = ['Acme Retail Co', 'Nimbus Health Co', 'Bright Bakery Co'];
  const existingClients = await db.Client.findAll({ where: { orgId, name: { [Op.in]: CLIENT_NAMES } } });
  if (existingClients.length && !FORCE) {
    console.log('✓ Demo projects already present:', existingClients.map((c) => c.name).join(', '));
    console.log('  Re-run with --force to wipe and recreate.');
    process.exit(0);
  }
  if (existingClients.length && FORCE) {
    console.log('Removing previous demo project packs…');
    for (const c of existingClients) await wipeClientPack(orgId, c.id);
  }

  // ─── Demo team ────────────────────────────────────────────────────────────
  const pm = await ensureDemoUser(orgId, 'project_manager', adminUser.roleId, 'demo.pm@mohsindesigns.com', 'Fatima Noor', '+92-300-1000007');
  const designer = await ensureDemoUser(orgId, 'ui_designer', adminUser.roleId, 'demo.designer@mohsindesigns.com', 'Sara Ahmed', '+92-300-1000001');
  const webDev = await ensureDemoUser(orgId, 'web_developer', adminUser.roleId, 'demo.webdev@mohsindesigns.com', 'Bilal Hussain', '+92-300-1000002');
  const appDev = await ensureDemoUser(orgId, 'app_developer', adminUser.roleId, 'demo.appdev@mohsindesigns.com', 'Hamza Iqbal', '+92-300-1000003');
  const qaEng = await ensureDemoUser(orgId, 'qa_engineer', adminUser.roleId, 'demo.qa@mohsindesigns.com', 'Ali Raza', '+92-300-1000004');
  const socialMgr = await ensureDemoUser(orgId, 'social_manager', adminUser.roleId, 'demo.social@mohsindesigns.com', 'Mahnoor Fatima', '+92-300-1000005');
  const copywriter = await ensureDemoUser(orgId, 'content_writer', adminUser.roleId, 'demo.copywriter@mohsindesigns.com', 'Usman Tariq', '+92-300-1000006');

  // ─── Project 1: Web Development — parked in QA & Testing (approval) ──────
  const webClient = await db.Client.create({
    id: uuidv4(), orgId, name: 'Acme Retail Co', status: 'active', defaultCurrency: 'USD',
    notes: 'Demo data for testing project detail. Safe to delete.', isActive: true,
  });
  await db.Contact.create({
    id: uuidv4(), clientId: webClient.id, name: 'Grace Miller', email: 'grace@acmeretail.test',
    phone: '+1-555-0111', role: 'Marketing Director', businessName: 'Acme Retail Co',
    billingAddress: '200 Commerce St, Denver, CO 80202', state: 'CO', useForInvoice: true, isActive: true,
  });

  const webProject = await db.Project.create({
    id: uuidv4(), orgId, clientId: webClient.id,
    name: 'Acme Retail — Website Redesign',
    serviceTypeKey: 'web', workflowTemplateId: webTemplate.id,
    currentStageKey: 'qa', status: 'active', startDate: daysAgo(35), isRecurring: false,
    description: 'Full storefront redesign — new IA, responsive theme, and checkout revamp.',
    createdBy: adminUser.id,
  });
  await db.ProjectAssignment.bulkCreate([
    { id: uuidv4(), projectId: webProject.id, userId: pm.id, roleSlot: 'project_manager' },
    { id: uuidv4(), projectId: webProject.id, userId: designer.id, roleSlot: 'ui_designer' },
    { id: uuidv4(), projectId: webProject.id, userId: webDev.id, roleSlot: 'web_developer' },
    { id: uuidv4(), projectId: webProject.id, userId: qaEng.id, roleSlot: 'qa_engineer' },
  ]);
  await applyStageHistory(webProject, [
    { from: 'discovery', to: 'wireframes', action: 'complete', actorId: pm.id, note: 'Kickoff done, sitemap agreed with client.' },
    { from: 'wireframes', to: 'wireframe_approval', action: 'complete', actorId: designer.id },
    { from: 'wireframe_approval', to: 'design', action: 'approve', actorId: pm.id, note: 'Client approved wireframes with minor nav tweak.' },
    { from: 'design', to: 'design_approval', action: 'complete', actorId: designer.id },
    { from: 'design_approval', to: 'development', action: 'approve', actorId: pm.id },
    { from: 'development', to: 'qa', action: 'complete', actorId: webDev.id, note: 'All templates built against staging.' },
  ]);
  await db.Task.bulkCreate([
    { id: uuidv4(), orgId, projectId: webProject.id, stageKey: 'qa', type: 'work', title: 'Cross-browser test — checkout flow', assigneeId: qaEng.id, status: 'approved', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(30) },
    { id: uuidv4(), orgId, projectId: webProject.id, stageKey: 'qa', type: 'work', title: 'Mobile responsiveness pass', assigneeId: qaEng.id, status: 'approved', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(20) },
    { id: uuidv4(), orgId, projectId: webProject.id, stageKey: 'qa', type: 'work', title: 'Verify Stripe test payments end-to-end', assigneeId: qaEng.id, reviewerId: pm.id, status: 'in_review', autoCreated: false, createdBy: pm.id, remarks: 'Blocking QA sign-off — please prioritize.' },
  ]);
  await db.Comment.bulkCreate([
    { id: uuidv4(), projectId: webProject.id, stageKey: 'design', authorId: designer.id, body: 'Uploaded final homepage + PLP mockups, Figma link in the artifact.' },
    { id: uuidv4(), projectId: webProject.id, stageKey: 'qa', authorId: qaEng.id, body: 'Found a layout shift on iPad in landscape — filing a task for it now.' },
    { id: uuidv4(), projectId: webProject.id, stageKey: 'qa', authorId: pm.id, body: 'Client wants to soft-launch next Monday — let\'s clear the checkout task by Friday.' },
  ]);
  await db.Artifact.bulkCreate([
    { id: uuidv4(), projectId: webProject.id, stageKey: 'wireframes', fileUrl: 'https://example.com/demo-assets/acme-wireframes.pdf', fileName: 'acme-wireframes.pdf', mimeType: 'application/pdf', kind: 'document', uploadedBy: designer.id },
    { id: uuidv4(), projectId: webProject.id, stageKey: 'design', fileUrl: 'https://example.com/demo-assets/acme-homepage-mockup.png', fileName: 'acme-homepage-mockup.png', mimeType: 'image/png', kind: 'image', uploadedBy: designer.id },
  ]);

  // ─── Project 2: App Development — parked in Development (work) ──────────
  const appClient = await db.Client.create({
    id: uuidv4(), orgId, name: 'Nimbus Health Co', status: 'active', defaultCurrency: 'USD',
    notes: 'Demo data for testing project detail. Safe to delete.', isActive: true,
  });
  await db.Contact.create({
    id: uuidv4(), clientId: appClient.id, name: 'Daniel Cho', email: 'daniel@nimbushealth.test',
    phone: '+1-555-0122', role: 'Product Owner', businessName: 'Nimbus Health Co',
    billingAddress: '88 Wellness Blvd, San Diego, CA 92101', state: 'CA', useForInvoice: true, isActive: true,
  });

  const appProject = await db.Project.create({
    id: uuidv4(), orgId, clientId: appClient.id,
    name: 'Nimbus — Fitness Tracking App',
    serviceTypeKey: 'app', workflowTemplateId: appTemplate.id,
    currentStageKey: 'development', status: 'active', startDate: daysAgo(50), isRecurring: false,
    description: 'iOS + Android app: workout logging, streaks, and wearable sync.',
    createdBy: adminUser.id,
  });
  await db.ProjectAssignment.bulkCreate([
    { id: uuidv4(), projectId: appProject.id, userId: pm.id, roleSlot: 'project_manager' },
    { id: uuidv4(), projectId: appProject.id, userId: designer.id, roleSlot: 'ui_designer' },
    { id: uuidv4(), projectId: appProject.id, userId: appDev.id, roleSlot: 'app_developer' },
    { id: uuidv4(), projectId: appProject.id, userId: qaEng.id, roleSlot: 'qa_engineer' },
  ]);
  await applyStageHistory(appProject, [
    { from: 'requirements', to: 'ui_ux', action: 'complete', actorId: pm.id, note: 'Scope locked: iOS + Android, wearable sync in v1.' },
    { from: 'ui_ux', to: 'ui_ux_approval', action: 'complete', actorId: designer.id },
    { from: 'ui_ux_approval', to: 'development', action: 'approve', actorId: pm.id },
  ]);
  await db.Task.bulkCreate([
    { id: uuidv4(), orgId, projectId: appProject.id, stageKey: 'development', type: 'work', title: 'Workout logging screen + local persistence', assigneeId: appDev.id, status: 'done', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(40) },
    { id: uuidv4(), orgId, projectId: appProject.id, stageKey: 'development', type: 'work', title: 'Apple HealthKit sync', assigneeId: appDev.id, status: 'done', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(15) },
    { id: uuidv4(), orgId, projectId: appProject.id, stageKey: 'development', type: 'work', title: 'Streaks + push reminders', assigneeId: appDev.id, status: 'in_progress', autoCreated: false, createdBy: pm.id, dueAt: daysAgo(-3) },
    { id: uuidv4(), orgId, projectId: appProject.id, stageKey: 'development', type: 'work', title: 'Google Fit sync (Android)', assigneeId: appDev.id, status: 'todo', autoCreated: false, createdBy: pm.id, dueAt: daysAgo(-7) },
  ]);
  await db.Comment.bulkCreate([
    { id: uuidv4(), projectId: appProject.id, stageKey: 'ui_ux', authorId: designer.id, body: 'Design system + all core screens attached — dark mode included.' },
    { id: uuidv4(), projectId: appProject.id, stageKey: 'development', authorId: appDev.id, body: 'HealthKit sync is trickier than scoped — background refresh needs its own entitlement. Flagging for PM.' },
  ]);
  await db.Artifact.bulkCreate([
    { id: uuidv4(), projectId: appProject.id, stageKey: 'ui_ux', fileUrl: 'https://example.com/demo-assets/nimbus-ui-kit.fig', fileName: 'nimbus-ui-kit.fig', mimeType: 'application/octet-stream', kind: 'design', uploadedBy: designer.id },
  ]);

  // ─── Project 3: Social Media — parked in Review & Approval ───────────────
  const socialClient = await db.Client.create({
    id: uuidv4(), orgId, name: 'Bright Bakery Co', status: 'active', defaultCurrency: 'USD',
    notes: 'Demo data for testing project detail. Safe to delete.', isActive: true,
  });
  await db.Contact.create({
    id: uuidv4(), clientId: socialClient.id, name: 'Priya Nair', email: 'priya@brightbakery.test',
    phone: '+1-555-0133', role: 'Owner', businessName: 'Bright Bakery Co',
    billingAddress: '14 Maple Ave, Portland, OR 97201', state: 'OR', useForInvoice: true, isActive: true,
  });

  const socialProject = await db.Project.create({
    id: uuidv4(), orgId, clientId: socialClient.id,
    name: 'Bright Bakery — Spring Launch Campaign',
    serviceTypeKey: 'social', workflowTemplateId: socialTemplate.id,
    currentStageKey: 'review', status: 'active', startDate: daysAgo(12), isRecurring: true,
    description: 'Instagram + TikTok content pushing the new seasonal menu.',
    createdBy: adminUser.id,
  });
  await db.ProjectAssignment.bulkCreate([
    { id: uuidv4(), projectId: socialProject.id, userId: pm.id, roleSlot: 'project_manager' },
    { id: uuidv4(), projectId: socialProject.id, userId: socialMgr.id, roleSlot: 'social_manager' },
    { id: uuidv4(), projectId: socialProject.id, userId: designer.id, roleSlot: 'ui_designer' },
    { id: uuidv4(), projectId: socialProject.id, userId: copywriter.id, roleSlot: 'content_writer' },
  ]);
  await applyStageHistory(socialProject, [
    { from: 'content_plan', to: 'creative', action: 'complete', actorId: socialMgr.id, note: '12-post calendar approved internally.' },
    { from: 'creative', to: 'copy', action: 'complete', actorId: designer.id },
    { from: 'copy', to: 'review', action: 'complete', actorId: copywriter.id },
  ]);
  await db.Task.bulkCreate([
    { id: uuidv4(), orgId, projectId: socialProject.id, stageKey: 'creative', type: 'work', title: '12 post graphics — spring menu set', assigneeId: designer.id, status: 'done', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(60) },
    { id: uuidv4(), orgId, projectId: socialProject.id, stageKey: 'copy', type: 'work', title: 'Captions + hashtags for all 12 posts', assigneeId: copywriter.id, status: 'done', autoCreated: false, createdBy: pm.id, completedAt: hoursAgo(24) },
  ]);
  await db.Comment.bulkCreate([
    { id: uuidv4(), projectId: socialProject.id, stageKey: 'review', authorId: socialMgr.id, body: 'Full set ready for sign-off — need approval by Thursday to hit the launch date.' },
  ]);
  await db.Artifact.bulkCreate([
    { id: uuidv4(), projectId: socialProject.id, stageKey: 'creative', fileUrl: 'https://example.com/demo-assets/bright-bakery-spring-set.zip', fileName: 'bright-bakery-spring-set.zip', mimeType: 'application/zip', kind: 'archive', uploadedBy: designer.id },
  ]);

  console.log('\n✓ Demo projects seeded.\n');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(` Org:  ${orgId}`);
  console.log(` Login (admin):  ${adminUser.email}`);
  console.log(' Demo team pass: Demo@1234');
  console.log(`   PM:         ${pm.email}`);
  console.log(`   Designer:   ${designer.email}`);
  console.log(`   Web dev:    ${webDev.email}`);
  console.log(`   App dev:    ${appDev.email}`);
  console.log(`   QA:         ${qaEng.email}`);
  console.log(`   Social mgr: ${socialMgr.email}`);
  console.log(`   Copywriter: ${copywriter.email}`);
  console.log('');
  console.log(` Web project    (QA & Testing / approval):   /projects/${webProject.id}`);
  console.log(` App project    (Development / work):        /projects/${appProject.id}`);
  console.log(` Social project (Review & Approval):          /projects/${socialProject.id}`);
  console.log('══════════════════════════════════════════════════════════════\n');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Demo projects seed failed:', err);
  process.exit(1);
});
