// One-off maintenance script: renames the 'seo_strategist' role/role-slot to
// 'project_strategist' across every table that references it, for orgs that
// were already seeded before this rename shipped. New orgs seeded after this
// change already get 'project_strategist' straight from seed.js — this script
// is only needed to bring existing data in line with that.
//
// Touches, per org that still has a 'seo_strategist' role:
//   - roles.key / roles.name           ('seo_strategist' -> 'project_strategist')
//   - project_assignments.role_slot
//   - recurring_task_rules.role_slot
//   - stages.owner_role_slot           (SEO + GMB workflow template stages)
//
// Usage:
//   node scripts/renameStrategistRole.js            (dry run — prints what would change, writes nothing)
//   node scripts/renameStrategistRole.js --apply     (actually renames)
//
// Run it with whatever DB_* env vars point at the target environment, same as
// any other script in this repo that uses ./src/models.

const db = require('../src/models');

const APPLY = process.argv.includes('--apply');
const OLD_KEY = 'seo_strategist';
const NEW_KEY = 'project_strategist';
const NEW_NAME = 'Project Strategist';

async function main() {
  await db.sequelize.authenticate();
  console.log(`Connected to ${process.env.DB_NAME}@${process.env.DB_HOST}. Mode: ${APPLY ? 'APPLY (will write changes)' : 'DRY RUN (no changes will be written — pass --apply to commit)'}\n`);

  const roles = await db.Role.findAll({ where: { key: OLD_KEY } });
  if (!roles.length) {
    console.log(`No '${OLD_KEY}' role rows found — nothing to migrate.`);
    return;
  }

  for (const role of roles) {
    const orgId = role.orgId;
    const conflict = await db.Role.findOne({ where: { orgId, key: NEW_KEY } });
    if (conflict) {
      console.log(`SKIP org ${orgId}: a '${NEW_KEY}' role already exists (id ${conflict.id}) — resolve manually before re-running.`);
      continue;
    }

    const [assignmentCount, ruleCount, stageCount] = await Promise.all([
      db.ProjectAssignment.count({ where: { roleSlot: OLD_KEY }, include: [{ model: db.Project, as: 'project', where: { orgId }, attributes: [] }] }).catch(() => null),
      db.RecurringTaskRule.count({ where: { roleSlot: OLD_KEY, orgId } }),
      db.Stage.count({
        where: { ownerRoleSlot: OLD_KEY },
        include: [{ model: db.WorkflowTemplate, as: 'template', where: { orgId }, attributes: [] }],
      }),
    ]);

    console.log(`${APPLY ? 'MIGRATING' : 'WOULD MIGRATE'} org ${orgId}: role "${role.name}" (${OLD_KEY}) -> "${NEW_NAME}" (${NEW_KEY})`);
    console.log(`  project_assignments: ${assignmentCount ?? '?'}, recurring_task_rules: ${ruleCount}, stages: ${stageCount}`);

    if (!APPLY) continue;

    await db.sequelize.transaction(async (t) => {
      await role.update({ key: NEW_KEY, name: NEW_NAME }, { transaction: t });

      await db.RecurringTaskRule.update(
        { roleSlot: NEW_KEY },
        { where: { roleSlot: OLD_KEY, orgId }, transaction: t },
      );

      const projectIds = (await db.Project.findAll({ where: { orgId }, attributes: ['id'] }, { transaction: t }))
        .map((p) => p.id);
      if (projectIds.length) {
        await db.ProjectAssignment.update(
          { roleSlot: NEW_KEY },
          { where: { roleSlot: OLD_KEY, projectId: projectIds }, transaction: t },
        );
      }

      const templateIds = (await db.WorkflowTemplate.findAll({ where: { orgId }, attributes: ['id'] }, { transaction: t }))
        .map((wt) => wt.id);
      if (templateIds.length) {
        await db.Stage.update(
          { ownerRoleSlot: NEW_KEY },
          { where: { ownerRoleSlot: OLD_KEY, templateId: templateIds }, transaction: t },
        );
      }
    });
  }

  console.log(!APPLY ? '\nThis was a dry run — no changes were made. Re-run with --apply to commit.' : '\nDone.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('Migration failed:', err.message, err.stack); process.exit(1); });
