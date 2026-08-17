// Brings a model's table in line with its current attribute definitions — creates the
// table if it doesn't exist, or adds any missing columns if it does.
//
// This deliberately does NOT use Sequelize's `Model.sync({ alter: true })`. Every
// association in this codebase (hasMany/belongsTo) mutates the target attribute to add
// a real `references` + `onDelete: CASCADE`/`onUpdate: CASCADE`, even for relationships
// that were never meant to be enforced at the DB level — e.g. `Retainer.packageId`
// picks up `references: packages.id, onDelete: CASCADE` purely because `Package.hasMany
// (Retainer)` exists somewhere. `sync({ alter: true })` would try to materialize every
// one of those, silently turning soft, app-enforced relationships (see
// `WorkflowAdminService`'s manual "in use" guards before delete) into hard cascade
// deletes — deleting one Package would wipe out every Retainer/Project that ever
// referenced it. This app enforces relationships at the application layer, not via DB
// constraints (multi-tenancy itself works the same way — see tech-decisions memory),
// so schema sync here only ever adds columns/tables, never constraints.
async function ensureColumns(Model) {
  const qi = Model.sequelize.getQueryInterface();
  const tableName = Model.getTableName();

  const columns = {};
  for (const attr of Object.values(Model.rawAttributes)) {
    const field = attr.field || attr.fieldName;
    columns[field] = {
      type: attr.type,
      allowNull: attr.allowNull !== false,
      defaultValue: typeof attr.defaultValue === 'function' ? undefined : attr.defaultValue,
      primaryKey: !!attr.primaryKey,
    };
  }

  let existing = null;
  try {
    existing = await qi.describeTable(tableName);
  } catch {
    existing = null; // table doesn't exist yet
  }

  if (!existing) {
    await qi.createTable(tableName, columns);
    return;
  }

  for (const [field, definition] of Object.entries(columns)) {
    if (existing[field]) continue;
    await qi.addColumn(tableName, field, definition);
    // MySQL sometimes leaves existing rows at 0/NULL when a NOT NULL boolean
    // is added — backfill the intended default so lists (e.g. Clients) don't
    // suddenly look empty after deploy.
    if (definition.defaultValue === true || definition.defaultValue === 1) {
      try {
        const qiGen = Model.sequelize.getQueryInterface().queryGenerator;
        const tbl = typeof tableName === 'string' ? tableName : tableName.tableName;
        const qTable = qiGen.quoteTable(tbl);
        const qField = qiGen.quoteIdentifier(field);
        await Model.sequelize.query(
          `UPDATE ${qTable} SET ${qField} = true WHERE ${qField} IS NULL OR ${qField} = 0`,
        );
      } catch {
        // Non-boolean / unsupported — ignore.
      }
    }
  }
}

// Redefines a single column's type to match the model — used for widening an ENUM
// with new allowed values (`ensureColumns` only adds missing columns, it never changes
// an existing one). Only touches that column's type/nullability/default, never
// constraints, for the same reason as `ensureColumns` above.
async function ensureColumnType(Model, attributeName) {
  const qi = Model.sequelize.getQueryInterface();
  const tableName = Model.getTableName();
  const attr = Model.rawAttributes[attributeName];
  const field = attr.field || attr.fieldName;
  await qi.changeColumn(tableName, field, {
    type: attr.type,
    allowNull: attr.allowNull !== false,
    defaultValue: typeof attr.defaultValue === 'function' ? undefined : attr.defaultValue,
  });
}

module.exports = { ensureColumns, ensureColumnType };
