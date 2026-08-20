/**
 * Demo data for the client-request approval flow: seeds one request in each
 * status onto the QA Demo Client's project, so the "Client requirements" tab
 * (and the admin approval queue inside it) has something real to look at.
 *
 * Prerequisites: base seed + QA demo pack already applied.
 *   npm run db:seed
 *   npm run db:seed:qa
 *
 * Run:
 *   npm run db:seed:client-requests
 *
 * Re-running wipes and recreates only the rows this script made (marked by
 * the "QA Demo —" subject prefix) — safe to run repeatedly.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { Op } = require('sequelize');
const db = require('../models');
const app = require('../app');
const ClientRequestService = require('../services/ClientRequestService');

const SUBJECT_PREFIX = 'QA Demo —';

function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
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
  const roleInclude = [{ model: db.Role, as: 'role' }];
  const adminUser = (superRole
    ? await db.User.findOne({ where: { orgId, roleId: superRole.id }, order: [['createdAt', 'ASC']], include: roleInclude })
    : null) || await db.User.findOne({ where: { orgId }, order: [['createdAt', 'ASC']], include: roleInclude });
  if (!adminUser) {
    console.error('No users found. Run `npm run db:seed` first.');
    process.exit(1);
  }

  const client = await db.Client.findOne({ where: { orgId, name: 'QA Demo Client' } });
  if (!client) {
    console.error('QA Demo Client not found. Run `npm run db:seed:qa` first.');
    process.exit(1);
  }

  const project = await db.Project.findOne({ where: { orgId, clientId: client.id }, order: [['createdAt', 'ASC']] });
  if (!project) {
    console.error('No project on QA Demo Client. Run `npm run db:seed:qa` first.');
    process.exit(1);
  }

  const contact = await db.Contact.findOne({ where: { clientId: client.id } });

  // The composer must NOT be an admin, or `send` auto-approves it and there's
  // nothing left in the queue for an admin to review.
  const authorUser = await db.User.findOne({ where: { orgId, email: 'qa.writer@mohsindesigns.com' }, include: roleInclude });
  if (!authorUser) {
    console.error('QA Content Writer user not found. Run `npm run db:seed:qa` first.');
    process.exit(1);
  }

  // Idempotent: clear out any prior run's rows before recreating them.
  await db.ClientRequest.destroy({ where: { projectId: project.id, subject: { [Op.like]: `${SUBJECT_PREFIX}%` } } });

  const recipientName = contact?.name || 'Jordan Lee';
  const recipientEmail = contact?.email || 'billing@qademoclient.test';
  const contactId = contact?.id || undefined;

  // 1. Sitting in the approval queue — the case this pack exists to show.
  const pending = await ClientRequestService.send(project.id, orgId, {
    recipientName,
    recipientEmail,
    contactId,
    subject: `${SUBJECT_PREFIX} Homepage content requirements`,
    message: 'Could you send over your logo files and 2-3 competitor sites you like the look of? We\'ll use these to kick off the on-page work.',
    dueAt: daysFromNow(5),
    fields: [
      { key: 'logo_files', label: 'Link to your logo files (Drive/Dropbox)', type: 'text', required: true },
      { key: 'competitors', label: 'Competitor websites you admire', type: 'textarea', required: false },
      { key: 'brand_colors', label: 'Preferred brand colors', type: 'text', required: false },
    ],
  }, authorUser);

  // 2. Approved & emailed already — client hasn't replied yet.
  const sent = await ClientRequestService.send(project.id, orgId, {
    recipientName,
    recipientEmail,
    contactId,
    subject: `${SUBJECT_PREFIX} Monthly report — anything to highlight?`,
    message: 'Any wins, launches, or promos this month you\'d like called out in the report?',
    dueAt: daysFromNow(10),
    fields: [
      { key: 'highlights', label: 'Anything to highlight this month?', type: 'textarea', required: false },
    ],
  }, adminUser);

  // 3. Replied — flip a sent one to responded directly (skips the public
  // token/captcha flow, which is only reachable over HTTP).
  const repliedResult = await ClientRequestService.send(project.id, orgId, {
    recipientName,
    recipientEmail,
    contactId,
    subject: `${SUBJECT_PREFIX} Target locations for local SEO`,
    message: 'Which cities/regions should we prioritize for local search?',
    fields: [
      { key: 'locations', label: 'Target cities or regions', type: 'textarea', required: true },
    ],
  }, adminUser);
  await db.ClientRequest.update({
    status: 'responded',
    responseData: { locations: 'Austin, San Antonio, and Round Rock — Austin first.' },
    respondedAt: new Date(),
    viewedAt: new Date(Date.now() - 60 * 60 * 1000),
  }, { where: { id: repliedResult.request.id } });

  // 4. Rejected — composed by non-admin, an admin sends it back with a reason.
  const toReject = await ClientRequestService.send(project.id, orgId, {
    recipientName,
    recipientEmail,
    contactId,
    subject: `${SUBJECT_PREFIX} Budget and timeline questions`,
    message: 'What\'s your budget range for this project, and do you have a hard launch date?',
    fields: [
      { key: 'budget', label: 'Budget range', type: 'text', required: true },
      { key: 'launch_date', label: 'Target launch date', type: 'text', required: false },
    ],
  }, authorUser);
  await ClientRequestService.reject(
    toReject.request.id,
    orgId,
    adminUser,
    'Let\'s not lead with a budget question — soften this and ask about goals first.',
  );

  console.log('✓ Client-request demo data seeded on project:', project.name);
  console.log(`  pending_approval : ${pending.request.subject}`);
  console.log(`  sent             : ${sent.request.subject}`);
  console.log(`  responded        : ${repliedResult.request.subject}`);
  console.log(`  rejected         : ${toReject.request.subject}`);
  console.log(`  Log in as ${adminUser.email} and open "${project.name}" → Client requirements to see the approval queue.`);
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
