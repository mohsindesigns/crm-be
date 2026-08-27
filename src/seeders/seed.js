/**
 * One-shot seed: creates the default org, white-label config,
 * system roles, super admin user, default service types,
 * and a complete SEO workflow template with stages + transitions.
 *
 * Run: npm run db:seed
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../models');
// Pulls in app.js purely to await its `schemaReady` chain — that's what actually
// brings a freshly `db:migrate`d database (base tables only) up to what the
// current models expect (e.g. User's email-change-OTP columns). Without this,
// seeding a brand-new DB fails on the very first insert with "Unknown column"
// errors, since db:migrate only ever runs the one original create-tables
// migration and every column added since then lives in ensureSchema(), which
// normally only runs when the actual server boots (see server.js). Requiring
// app.js here is safe — it only builds the Express app and starts schemaReady;
// app.listen() and all schedulers live in server.js, not app.js.
const app = require('../app');
const { ensureExampleTemplates } = require('./documentTemplateDefaults');

const ORG_ID = process.env.SEED_ORG_ID || uuidv4();

const SYSTEM_ROLES = [
  {
    id: uuidv4(), orgId: ORG_ID, name: 'Super Admin', key: 'super_admin',
    permissions: {}, isSystemRole: true, color: '#E53E3E',
  },
  {
    id: uuidv4(), orgId: ORG_ID, name: 'Admin', key: 'admin',
    permissions: {}, isSystemRole: true, color: '#D69E2E',
  },
  {
    id: uuidv4(), orgId: ORG_ID, name: 'Client', key: 'client',
    permissions: { 'projects.read': true }, isSystemRole: true, color: '#2B6CB0',
  },
  {
    id: uuidv4(), orgId: ORG_ID, name: 'Employee', key: 'employee',
    permissions: {
      'projects.read': true,
      'projects.act': true,
    },
    isSystemRole: true, color: '#276749',
  },
];

// Department roles — matched to ownerRoleSlot keys used in workflow stages
const DEPARTMENT_ROLES = [
  { id: uuidv4(), orgId: ORG_ID, key: 'project_manager',  name: 'Project Manager',      color: '#2B6CB0', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true, 'projects.manage': true, 'clients.read': true, 'users.read': true, 'leads.read': true, 'leads.act': true, 'leads.manage': true, 'reports.read': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'ui_designer',      name: 'UI/UX Designer',        color: '#7B2D8B', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'web_developer',    name: 'Web Developer',         color: '#276749', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'app_developer',    name: 'App Developer',         color: '#1A5276', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'qa_engineer',      name: 'QA Engineer',           color: '#7D6608', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'content_writer',   name: 'Content Writer',        color: '#7E5109', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'project_strategist', name: 'Project Strategist',  color: '#1D6A96', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'link_builder',     name: 'Link Builder',          color: '#145A32', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'social_manager',   name: 'Social Media Manager',  color: '#6C3483', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'ads_manager',      name: 'Ads Manager',           color: '#922B21', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true, 'leads.read': true, 'leads.act': true, 'leads.manage': true } },
  { id: uuidv4(), orgId: ORG_ID, key: 'account_manager',  name: 'Account Manager',       color: '#1B4F72', isSystemRole: false, permissions: { 'projects.read': true, 'projects.act': true, 'clients.read': true, 'leads.read': true, 'leads.act': true } },
];

const SEO_STAGES = [
  { key: 'briefing', name: 'Client Briefing', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'keyword_research', name: 'Keyword Research', ownerRoleSlot: 'project_strategist', stageType: 'work', advanceRule: 'all_tasks_done', taskType: 'keyword', orderIndex: 1 },
  { key: 'keyword_approval', name: 'Keyword Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', approvalGranularity: 'batch', orderIndex: 2 },
  { key: 'content_writing', name: 'Content Writing', ownerRoleSlot: 'content_writer', stageType: 'work', advanceRule: 'all_tasks_done', taskType: 'content', orderIndex: 3 },
  { key: 'content_review', name: 'Content Review', ownerRoleSlot: 'project_strategist', stageType: 'approval', advanceRule: 'all_tasks_approved', approvalGranularity: 'per_item', orderIndex: 4 },
  { key: 'on_page_implementation', name: 'On-Page Implementation', ownerRoleSlot: 'web_developer', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 5 },
  { key: 'link_building', name: 'Link Building', ownerRoleSlot: 'link_builder', stageType: 'work', advanceRule: 'all_tasks_done', taskType: 'backlink', orderIndex: 6 },
  { key: 'reporting', name: 'Monthly Report', ownerRoleSlot: 'project_strategist', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 7 },
  { key: 'client_delivery', name: 'Client Delivery', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', isTerminal: true, orderIndex: 8 },
];

const SEO_TRANSITIONS = [
  { fromStageKey: 'briefing', action: 'complete', toStageKey: 'keyword_research' },
  { fromStageKey: 'keyword_research', action: 'complete', toStageKey: 'keyword_approval' },
  { fromStageKey: 'keyword_approval', action: 'approve', toStageKey: 'content_writing' },
  { fromStageKey: 'keyword_approval', action: 'reject', toStageKey: 'keyword_research' },
  { fromStageKey: 'content_writing', action: 'complete', toStageKey: 'content_review' },
  { fromStageKey: 'content_review', action: 'approve', toStageKey: 'on_page_implementation' },
  { fromStageKey: 'content_review', action: 'reject', reasonCategory: 'needs_revision', toStageKey: 'content_writing' },
  { fromStageKey: 'on_page_implementation', action: 'complete', toStageKey: 'link_building' },
  { fromStageKey: 'link_building', action: 'complete', toStageKey: 'reporting' },
  { fromStageKey: 'reporting', action: 'complete', toStageKey: 'client_delivery' },
  { fromStageKey: 'client_delivery', action: 'approve', toStageKey: 'client_delivery' },
];

const WEB_STAGES = [
  { key: 'discovery', name: 'Discovery & Scoping', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'wireframes', name: 'Wireframes', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 1 },
  { key: 'wireframe_approval', name: 'Wireframe Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'design', name: 'UI Design', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 3 },
  { key: 'design_approval', name: 'Design Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 4 },
  { key: 'development', name: 'Development', ownerRoleSlot: 'web_developer', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 5 },
  { key: 'qa', name: 'QA & Testing', ownerRoleSlot: 'qa_engineer', stageType: 'approval', advanceRule: 'all_tasks_approved', orderIndex: 6 },
  { key: 'client_uat', name: 'Client UAT', ownerRoleSlot: 'client', stageType: 'approval', advanceRule: 'single_action', orderIndex: 7 },
  { key: 'launch', name: 'Launch', ownerRoleSlot: 'web_developer', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 8 },
];

const WEB_TRANSITIONS = [
  { fromStageKey: 'discovery', action: 'complete', toStageKey: 'wireframes' },
  { fromStageKey: 'wireframes', action: 'complete', toStageKey: 'wireframe_approval' },
  { fromStageKey: 'wireframe_approval', action: 'approve', toStageKey: 'design' },
  { fromStageKey: 'wireframe_approval', action: 'reject', toStageKey: 'wireframes' },
  { fromStageKey: 'design', action: 'complete', toStageKey: 'design_approval' },
  { fromStageKey: 'design_approval', action: 'approve', toStageKey: 'development' },
  { fromStageKey: 'design_approval', action: 'reject', toStageKey: 'design' },
  { fromStageKey: 'development', action: 'complete', toStageKey: 'qa' },
  { fromStageKey: 'qa', action: 'approve', toStageKey: 'client_uat' },
  { fromStageKey: 'qa', action: 'reject', toStageKey: 'development' },
  { fromStageKey: 'client_uat', action: 'approve', toStageKey: 'launch' },
  { fromStageKey: 'client_uat', action: 'reject', toStageKey: 'development' },
  { fromStageKey: 'launch', action: 'complete', toStageKey: 'launch' },
];

// ─── App Development ───────────────────────────────────────────────────────────
const APP_STAGES = [
  { key: 'requirements', name: 'Requirements', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'ui_ux', name: 'UI/UX Design', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 1 },
  { key: 'ui_ux_approval', name: 'UI/UX Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'development', name: 'Development', ownerRoleSlot: 'app_developer', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 3 },
  { key: 'qa', name: 'QA & Testing', ownerRoleSlot: 'qa_engineer', stageType: 'approval', advanceRule: 'all_tasks_approved', orderIndex: 4 },
  { key: 'review', name: 'Final Review', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 5 },
  { key: 'released', name: 'Released', ownerRoleSlot: 'app_developer', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 6 },
];
const APP_TRANSITIONS = [
  { fromStageKey: 'requirements', action: 'complete', toStageKey: 'ui_ux' },
  { fromStageKey: 'ui_ux', action: 'complete', toStageKey: 'ui_ux_approval' },
  { fromStageKey: 'ui_ux_approval', action: 'approve', toStageKey: 'development' },
  { fromStageKey: 'ui_ux_approval', action: 'reject', toStageKey: 'ui_ux' },
  { fromStageKey: 'development', action: 'complete', toStageKey: 'qa' },
  { fromStageKey: 'qa', action: 'approve', toStageKey: 'review' },
  { fromStageKey: 'qa', action: 'reject', toStageKey: 'development' },
  { fromStageKey: 'review', action: 'approve', toStageKey: 'released' },
  { fromStageKey: 'review', action: 'reject', toStageKey: 'development' },
  { fromStageKey: 'released', action: 'complete', toStageKey: 'released' },
];

// ─── Social Media ──────────────────────────────────────────────────────────────
const SOCIAL_STAGES = [
  { key: 'content_plan', name: 'Content Plan', ownerRoleSlot: 'social_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'creative', name: 'Creative Design', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'all_tasks_done', requiresArtifact: true, orderIndex: 1 },
  { key: 'copy', name: 'Copywriting', ownerRoleSlot: 'content_writer', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 2 },
  { key: 'review', name: 'Review & Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 3 },
  { key: 'scheduled', name: 'Scheduled', ownerRoleSlot: 'social_manager', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 4 },
];
const SOCIAL_TRANSITIONS = [
  { fromStageKey: 'content_plan', action: 'complete', toStageKey: 'creative' },
  { fromStageKey: 'creative', action: 'complete', toStageKey: 'copy' },
  { fromStageKey: 'copy', action: 'complete', toStageKey: 'review' },
  { fromStageKey: 'review', action: 'approve', toStageKey: 'scheduled' },
  { fromStageKey: 'review', action: 'reject', toStageKey: 'copy' },
  { fromStageKey: 'scheduled', action: 'complete', toStageKey: 'scheduled' },
];

// ─── Branding ──────────────────────────────────────────────────────────────────
const BRANDING_STAGES = [
  { key: 'discovery', name: 'Brand Discovery', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'concepts', name: 'Brand Concepts', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 1 },
  { key: 'concept_review', name: 'Concept Review', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'revisions', name: 'Revisions', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 3 },
  { key: 'final_delivery', name: 'Final Delivery', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 4 },
];
const BRANDING_TRANSITIONS = [
  { fromStageKey: 'discovery', action: 'complete', toStageKey: 'concepts' },
  { fromStageKey: 'concepts', action: 'complete', toStageKey: 'concept_review' },
  { fromStageKey: 'concept_review', action: 'approve', toStageKey: 'revisions' },
  { fromStageKey: 'concept_review', action: 'reject', toStageKey: 'concepts' },
  { fromStageKey: 'revisions', action: 'complete', toStageKey: 'final_delivery' },
  { fromStageKey: 'final_delivery', action: 'complete', toStageKey: 'final_delivery' },
];

// ─── Logo Design ───────────────────────────────────────────────────────────────
const LOGO_STAGES = [
  { key: 'brief', name: 'Brief', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'drafts', name: 'Logo Drafts', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 1 },
  { key: 'review', name: 'Client Review', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'revisions', name: 'Revisions', ownerRoleSlot: 'ui_designer', stageType: 'work', advanceRule: 'single_action', requiresArtifact: true, orderIndex: 3 },
  { key: 'final_files', name: 'Final Files', ownerRoleSlot: 'project_manager', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 4 },
];
const LOGO_TRANSITIONS = [
  { fromStageKey: 'brief', action: 'complete', toStageKey: 'drafts' },
  { fromStageKey: 'drafts', action: 'complete', toStageKey: 'review' },
  { fromStageKey: 'review', action: 'approve', toStageKey: 'revisions' },
  { fromStageKey: 'review', action: 'reject', toStageKey: 'drafts' },
  { fromStageKey: 'revisions', action: 'complete', toStageKey: 'final_files' },
  { fromStageKey: 'final_files', action: 'complete', toStageKey: 'final_files' },
];

// ─── GMB Optimization ─────────────────────────────────────────────────────────
const GMB_STAGES = [
  { key: 'audit', name: 'GMB Audit', ownerRoleSlot: 'project_strategist', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'optimization', name: 'Optimization', ownerRoleSlot: 'project_strategist', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 1 },
  { key: 'review', name: 'Review', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'recurring_posts', name: 'Recurring Posts', ownerRoleSlot: 'project_strategist', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 3 },
];
const GMB_TRANSITIONS = [
  { fromStageKey: 'audit', action: 'complete', toStageKey: 'optimization' },
  { fromStageKey: 'optimization', action: 'complete', toStageKey: 'review' },
  { fromStageKey: 'review', action: 'approve', toStageKey: 'recurring_posts' },
  { fromStageKey: 'review', action: 'reject', toStageKey: 'optimization' },
  { fromStageKey: 'recurring_posts', action: 'complete', toStageKey: 'recurring_posts' },
];

// ─── Google Ads ────────────────────────────────────────────────────────────────
const GADS_STAGES = [
  { key: 'account_setup', name: 'Account Setup', ownerRoleSlot: 'ads_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 0 },
  { key: 'campaign_build', name: 'Campaign Build', ownerRoleSlot: 'ads_manager', stageType: 'work', advanceRule: 'all_tasks_done', orderIndex: 1 },
  { key: 'review', name: 'Review & Approval', ownerRoleSlot: 'project_manager', stageType: 'approval', advanceRule: 'single_action', orderIndex: 2 },
  { key: 'live', name: 'Live', ownerRoleSlot: 'ads_manager', stageType: 'work', advanceRule: 'single_action', orderIndex: 3 },
  { key: 'optimization', name: 'Optimization', ownerRoleSlot: 'ads_manager', stageType: 'work', advanceRule: 'single_action', isTerminal: true, orderIndex: 4 },
];
const GADS_TRANSITIONS = [
  { fromStageKey: 'account_setup', action: 'complete', toStageKey: 'campaign_build' },
  { fromStageKey: 'campaign_build', action: 'complete', toStageKey: 'review' },
  { fromStageKey: 'review', action: 'approve', toStageKey: 'live' },
  { fromStageKey: 'review', action: 'reject', toStageKey: 'campaign_build' },
  { fromStageKey: 'live', action: 'complete', toStageKey: 'optimization' },
  { fromStageKey: 'optimization', action: 'complete', toStageKey: 'optimization' },
];

async function seed() {
  await db.sequelize.authenticate();
  await app.schemaReady;

  const existingOrg = await db.Org.findByPk(ORG_ID);
  if (existingOrg) {
    console.log('Seed already applied. Exiting.');
    process.exit(0);
  }

  await db.sequelize.transaction(async (t) => {
    // Org
    await db.Org.create({
      id: ORG_ID,
      name: process.env.SEED_ORG_NAME || 'Mohsin Designs',
      subdomain: process.env.SEED_ORG_SUBDOMAIN || 'mohsindesigns',
      plan: 'pro',
      status: 'active',
    }, { transaction: t });

    // White-label branding
    await db.WhiteLabelConfig.create({
      orgId: ORG_ID,
      brandName: process.env.SEED_BRAND_NAME || 'Mohsin Designs Project Management',
      primaryColor: process.env.SEED_BRAND_COLOR || '#0B1D5E',
    }, { transaction: t });

    // System roles + department roles
    await db.Role.bulkCreate([...SYSTEM_ROLES, ...DEPARTMENT_ROLES], { transaction: t });

    const superAdminRole = SYSTEM_ROLES.find((r) => r.key === 'super_admin');

    // Super admin user
    const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'Admin@1234', 12);
    await db.User.create({
      id: uuidv4(),
      orgId: ORG_ID,
      roleId: superAdminRole.id,
      name: process.env.SEED_ADMIN_NAME || 'Super Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@mohsindesigns.com',
      passwordHash,
      isActive: true,
    }, { transaction: t });

    // Payroll settings
    await db.PayrollSettings.create({ orgId: ORG_ID }, { transaction: t });

    // Service types
    const seoId = uuidv4();
    const webId = uuidv4();
    const appId = uuidv4();
    const socialId = uuidv4();
    const brandingId = uuidv4();
    const logoId = uuidv4();
    const gmbId = uuidv4();
    const gadsId = uuidv4();
    await db.ServiceType.bulkCreate([
      { id: seoId,      orgId: ORG_ID, key: 'seo',      name: 'SEO',              icon: 'search',       isActive: true },
      { id: webId,      orgId: ORG_ID, key: 'web',      name: 'Web Development',  icon: 'code',         isActive: true },
      { id: appId,      orgId: ORG_ID, key: 'app',      name: 'App Development',  icon: 'smartphone',   isActive: true },
      { id: socialId,   orgId: ORG_ID, key: 'social',   name: 'Social Media',     icon: 'share',        isActive: true },
      { id: brandingId, orgId: ORG_ID, key: 'branding', name: 'Branding',         icon: 'layers',       isActive: true },
      { id: logoId,     orgId: ORG_ID, key: 'logo',     name: 'Logo Design',      icon: 'pen-tool',     isActive: true },
      { id: gmbId,      orgId: ORG_ID, key: 'gmb',      name: 'GMB Optimization', icon: 'map-pin',      isActive: true },
      { id: gadsId,     orgId: ORG_ID, key: 'gads',     name: 'Google Ads',       icon: 'trending-up',  isActive: true },
    ], { transaction: t });

    // SEO workflow template
    const seoTemplateId = uuidv4();
    await db.WorkflowTemplate.create({
      id: seoTemplateId, orgId: ORG_ID, serviceTypeKey: 'seo',
      name: 'SEO Monthly Retainer', version: 1, isActive: true, isRecurring: true,
    }, { transaction: t });
    await db.Stage.bulkCreate(SEO_STAGES.map((s) => ({ id: uuidv4(), templateId: seoTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(SEO_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: seoTemplateId, ...tr })), { transaction: t });

    // Web workflow template
    const webTemplateId = uuidv4();
    await db.WorkflowTemplate.create({
      id: webTemplateId, orgId: ORG_ID, serviceTypeKey: 'web',
      name: 'Web Design & Development', version: 1, isActive: true, isRecurring: false,
    }, { transaction: t });
    await db.Stage.bulkCreate(WEB_STAGES.map((s) => ({ id: uuidv4(), templateId: webTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(WEB_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: webTemplateId, ...tr })), { transaction: t });

    // App Development
    const appTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: appTemplateId, orgId: ORG_ID, serviceTypeKey: 'app', name: 'App Development', version: 1, isActive: true, isRecurring: false }, { transaction: t });
    await db.Stage.bulkCreate(APP_STAGES.map((s) => ({ id: uuidv4(), templateId: appTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(APP_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: appTemplateId, ...tr })), { transaction: t });

    // Social Media
    const socialTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: socialTemplateId, orgId: ORG_ID, serviceTypeKey: 'social', name: 'Social Media Management', version: 1, isActive: true, isRecurring: true }, { transaction: t });
    await db.Stage.bulkCreate(SOCIAL_STAGES.map((s) => ({ id: uuidv4(), templateId: socialTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(SOCIAL_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: socialTemplateId, ...tr })), { transaction: t });

    // Branding
    const brandingTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: brandingTemplateId, orgId: ORG_ID, serviceTypeKey: 'branding', name: 'Brand Identity', version: 1, isActive: true, isRecurring: false }, { transaction: t });
    await db.Stage.bulkCreate(BRANDING_STAGES.map((s) => ({ id: uuidv4(), templateId: brandingTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(BRANDING_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: brandingTemplateId, ...tr })), { transaction: t });

    // Logo Design
    const logoTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: logoTemplateId, orgId: ORG_ID, serviceTypeKey: 'logo', name: 'Logo Design', version: 1, isActive: true, isRecurring: false }, { transaction: t });
    await db.Stage.bulkCreate(LOGO_STAGES.map((s) => ({ id: uuidv4(), templateId: logoTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(LOGO_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: logoTemplateId, ...tr })), { transaction: t });

    // GMB Optimization
    const gmbTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: gmbTemplateId, orgId: ORG_ID, serviceTypeKey: 'gmb', name: 'GMB Optimization', version: 1, isActive: true, isRecurring: true }, { transaction: t });
    await db.Stage.bulkCreate(GMB_STAGES.map((s) => ({ id: uuidv4(), templateId: gmbTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(GMB_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: gmbTemplateId, ...tr })), { transaction: t });

    // Google Ads
    const gadsTemplateId = uuidv4();
    await db.WorkflowTemplate.create({ id: gadsTemplateId, orgId: ORG_ID, serviceTypeKey: 'gads', name: 'Google Ads', version: 1, isActive: true, isRecurring: true }, { transaction: t });
    await db.Stage.bulkCreate(GADS_STAGES.map((s) => ({ id: uuidv4(), templateId: gadsTemplateId, ...s })), { transaction: t });
    await db.Transition.bulkCreate(GADS_TRANSITIONS.map((tr) => ({ id: uuidv4(), templateId: gadsTemplateId, ...tr })), { transaction: t });
  });

  // Starter quotation / agreement / proposal bodies (outside the txn — uses its
  // own findOrCreate). Same set Admin → Document Templates auto-installs.
  await ensureExampleTemplates(ORG_ID, db.DocumentTemplate);

  console.log('✓ Seed complete.');
  console.log(`  Org ID : ${ORG_ID}`);
  console.log(`  Admin  : ${process.env.SEED_ADMIN_EMAIL || 'admin@mohsindesigns.com'}`);
  console.log(`  Pass   : ${process.env.SEED_ADMIN_PASSWORD || 'Admin@1234'}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
