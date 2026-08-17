// One-off maintenance script: regenerates every project's name via
// buildProjectName() so projects created before the "Client - Service -
// Package" naming convention existed get renamed to match it.
//
// Deliberately NOT run automatically on server startup (unlike the other
// backfills in app.js) — Project.name is user-editable (see the "Label" field
// on project creation and the project edit form), so silently re-running this
// on every boot would clobber any legitimate manual rename. Run it once, by
// hand, whenever you deploy the naming-convention change to an environment
// that has pre-existing projects.
//
// Usage:
//   node scripts/backfillProjectNames.js            (dry run — prints what would change, writes nothing)
//   node scripts/backfillProjectNames.js --apply     (actually renames)
//
// Run it with whatever DB_* env vars point at the target environment — e.g.
// on the production server itself, or locally with production DB env vars
// exported — same as any other script in this repo that uses ./src/models.

const db = require('../src/models');
const { buildProjectName } = require('../src/utils/projectName');

const APPLY = process.argv.includes('--apply');

async function main() {
  await db.sequelize.authenticate();
  console.log(`Connected to ${process.env.DB_NAME}@${process.env.DB_HOST}. Mode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (no changes will be written — pass --apply to commit)'}\n`);

  const projects = await db.Project.findAll({
    include: [
      { model: db.Client, as: 'client', attributes: ['id', 'name'] },
      { model: db.Package, as: 'package', attributes: ['id', 'name', 'tier'] },
    ],
  });

  const serviceTypes = await db.ServiceType.findAll({ attributes: ['orgId', 'key', 'name'] });
  const serviceTypeMap = new Map(serviceTypes.map((s) => [`${s.orgId}:${s.key}`, s.name]));

  let toRename = 0;
  let skippedNoClient = 0;

  for (const p of projects) {
    if (!p.client) {
      skippedNoClient++;
      console.log(`SKIP (no linked client, can't rename safely): ${p.id} — "${p.name}"`);
      continue;
    }
    const serviceLabel = serviceTypeMap.get(`${p.orgId}:${p.serviceTypeKey}`) || p.serviceTypeKey;
    const packageLabel = p.package ? (p.package.tier || p.package.name) : null;
    const correctName = buildProjectName(p.client.name, serviceLabel, packageLabel, null);

    if (correctName && correctName !== p.name) {
      toRename++;
      console.log(`${APPLY ? 'RENAMED' : 'WOULD RENAME'}: "${p.name}"  ->  "${correctName}"`);
      if (APPLY) await p.update({ name: correctName });
    }
  }

  console.log(`\n${toRename} project(s) ${APPLY ? 'renamed' : 'would be renamed'}, ${skippedNoClient} skipped (no client), ${projects.length - toRename - skippedNoClient} already correct.`);
  if (!APPLY && toRename > 0) {
    console.log('This was a dry run — no changes were made. Re-run with --apply to commit these renames.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Backfill failed:', err.message, err.stack); process.exit(1); });
