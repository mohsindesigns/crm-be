// One-off reset script: wipes all Customers (Clients), Projects, Tasks,
// Invoices, and Quotes/Agreements/Proposals (CustomerDocuments) — plus
// everything that hangs off them — so the CRM can be tested against a clean
// slate. Deliberately leaves Users, Workers/HR/Payroll, Orgs, ServiceTypes,
// Packages, and DocumentTemplates (the reusable templates, not the documents
// generated from them) untouched, since none of that was asked for and
// wiping it would break login/HR/payroll setup.
//
// Deletes in child-to-parent order inside a single transaction so a failure
// partway through rolls back cleanly instead of leaving orphaned rows.
//
// Usage:
//   node scripts/wipeCrmTestData.js             (dry run — prints counts, writes nothing)
//   node scripts/wipeCrmTestData.js --apply      (actually deletes)
//   node scripts/wipeCrmTestData.js --apply --org=<orgId>   (scope to one org only)
//
// Run it with whatever DB_* env vars point at the target environment — same
// as any other script in this repo that uses ./src/models.

const db = require('../src/models');
const { Op } = require('sequelize');

const APPLY = process.argv.includes('--apply');
const orgArg = process.argv.find((a) => a.startsWith('--org='));
const ORG_ID = orgArg ? orgArg.split('=')[1] : null;

async function main() {
  await db.sequelize.authenticate();
  console.log(`Connected to ${process.env.DB_NAME}@${process.env.DB_HOST}.`);
  console.log(`Scope: ${ORG_ID ? `org ${ORG_ID}` : 'ALL orgs'}. Mode: ${APPLY ? 'APPLY (will delete)' : 'DRY RUN (no changes — pass --apply to commit)'}\n`);

  const orgWhere = ORG_ID ? { orgId: ORG_ID } : {};

  const clients = await db.Client.findAll({ where: orgWhere, attributes: ['id'] });
  const projects = await db.Project.findAll({ where: orgWhere, attributes: ['id'] });
  const tasks = await db.Task.findAll({ where: orgWhere, attributes: ['id'] });
  const invoices = await db.Invoice.findAll({ where: orgWhere, attributes: ['id'] });
  // Quotations/agreements/proposals — a prospect-facing document that isn't
  // necessarily tied to a Client yet, so it's queried independently by org.
  const documents = await db.CustomerDocument.findAll({ where: orgWhere, attributes: ['id'] });

  const clientIds = clients.map((c) => c.id);
  const projectIds = projects.map((p) => p.id);
  const taskIds = tasks.map((t) => t.id);
  const invoiceIds = invoices.map((i) => i.id);
  const documentIds = documents.map((d) => d.id);

  if (clientIds.length === 0 && projectIds.length === 0 && documentIds.length === 0) {
    console.log('Nothing to delete — no clients, projects, or documents found in scope.');
    return;
  }

  console.log(`Found: ${clientIds.length} client(s), ${projectIds.length} project(s), ${taskIds.length} task(s), ${invoiceIds.length} invoice(s), ${documentIds.length} quote/agreement document(s).\n`);

  // [model, where] in child-to-parent order.
  const plan = [
    ['TaskEvent', { taskId: { [Op.in]: taskIds } }],
    ['Artifact', { projectId: { [Op.in]: projectIds } }],
    ['Comment', { projectId: { [Op.in]: projectIds } }],
    ['ContentSubmission', { projectId: { [Op.in]: projectIds } }],
    ['Keyword', { projectId: { [Op.in]: projectIds } }],
    ['Backlink', { projectId: { [Op.in]: projectIds } }],
    ['BlogTask', { projectId: { [Op.in]: projectIds } }],
    ['RankSnapshot', { projectId: { [Op.in]: projectIds } }],
    ['RecurringTaskRule', { projectId: { [Op.in]: projectIds } }],
    ['ProjectCycle', { projectId: { [Op.in]: projectIds } }],
    ['ProjectEvent', { projectId: { [Op.in]: projectIds } }],
    ['ProjectAssignment', { projectId: { [Op.in]: projectIds } }],
    ['Task', { id: { [Op.in]: taskIds } }],
    ['Retainer', { clientId: { [Op.in]: clientIds } }],
    ['Payment', { invoiceId: { [Op.in]: invoiceIds } }],
    ['InvoiceLine', { invoiceId: { [Op.in]: invoiceIds } }],
    ['Invoice', { clientId: { [Op.in]: clientIds } }],
    ['Contact', { clientId: { [Op.in]: clientIds } }],
    ['ClientPackage', { clientId: { [Op.in]: clientIds } }],
    ['PortalNotification', { clientId: { [Op.in]: clientIds } }],
    ['DocumentEvent', { documentId: { [Op.in]: documentIds } }],
    ['Notification', { refTable: 'projects', refId: { [Op.in]: projectIds } }],
    ['Notification', { refTable: 'invoices', refId: { [Op.in]: invoiceIds } }],
    ['Notification', { refTable: 'customer_documents', refId: { [Op.in]: documentIds } }],
    ['CustomerDocument', { id: { [Op.in]: documentIds } }],
    ['Project', { id: { [Op.in]: projectIds } }],
    ['Client', { id: { [Op.in]: clientIds } }],
  ];

  const t = APPLY ? await db.sequelize.transaction() : null;
  try {
    for (const [modelName, where] of plan) {
      // Skip clauses whose Op.in array is empty — Sequelize would otherwise
      // match/delete rows with no matching where at all for some dialects.
      const idKey = Object.keys(where).find((k) => where[k] && where[k][Op.in]);
      if (idKey && where[idKey][Op.in].length === 0) continue;

      const count = await db[modelName].count({ where });
      console.log(`${APPLY ? 'Deleting' : 'Would delete'} ${count} row(s) from ${modelName}`);
      if (APPLY && count > 0) {
        await db[modelName].destroy({ where, transaction: t });
      }
    }

    if (APPLY) {
      await t.commit();
      console.log('\nDone — CRM data wiped.');
    } else {
      console.log('\nThis was a dry run — no changes were made. Re-run with --apply to commit.');
    }
  } catch (err) {
    if (t) await t.rollback();
    throw err;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Wipe failed:', err.message, err.stack); process.exit(1); });
