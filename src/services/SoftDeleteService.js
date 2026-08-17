/**
 * Deactivate-instead-of-delete.
 *
 * Org policy: nothing in the CRM is destroyed. Every endpoint that used to run a
 * hard DELETE now flips the record's active flag, so the row survives for
 * history, audit trails, reports and re-activation — and only an admin may do
 * even that (see middleware/adminOnly).
 *
 * Two flag shapes exist in the schema and both are handled here:
 *   - `isActive` boolean — the default, added by models/softDeletable.js
 *   - `status` ENUM('active','inactive') — Keyword, which already modelled this
 *
 * List endpoints hide inactive rows by default; pass `?includeInactive=1` (or
 * `?status=inactive` where a status filter already exists) to see them.
 */

/** Which attribute on this model carries the active flag, if any. */
function activeField(Model) {
  const attrs = Model?.rawAttributes || {};
  if (attrs.isActive) return 'isActive';
  // Keyword's ENUM already means exactly this.
  if (attrs.status && String(attrs.status.type?.key) === 'ENUM'
      && (attrs.status.type.values || []).includes('inactive')) {
    return 'status';
  }
  return null;
}

function activeValue(field, active) {
  if (field === 'status') return active ? 'active' : 'inactive';
  return active;
}

/**
 * A `where` fragment that hides deactivated rows.
 *
 * @param {object} Model      sequelize model
 * @param {object} [query]    the request's req.query — `includeInactive=1` opts out
 * @returns {object} spread into an existing where clause
 */
function activeWhere(Model, query) {
  const field = activeField(Model);
  if (!field) return {};
  if (isTruthy(query?.includeInactive)) return {};
  return { [field]: activeValue(field, true) };
}

function isTruthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/**
 * Flip a record's active flag. Returns the reloaded instance.
 *
 * @param {object} Model
 * @param {object} where     narrowing clause — must already be org/tenant scoped
 * @param {boolean} active
 * @param {string} notFoundMessage
 */
async function setActive(Model, where, active, notFoundMessage = 'Record not found.') {
  const record = await Model.findOne({ where });
  if (!record) throw Object.assign(new Error(notFoundMessage), { status: 404 });

  const field = activeField(Model);
  if (!field) {
    throw Object.assign(
      new Error(`${Model.name} has no Active/Inactive flag, so its status cannot be changed.`),
      { status: 500 },
    );
  }

  await record.update({ [field]: activeValue(field, active) });
  return record;
}

/** Deactivate many rows at once (bulk "delete" endpoints). Returns the row count. */
async function deactivateWhere(Model, where) {
  const field = activeField(Model);
  if (!field) {
    throw Object.assign(
      new Error(`${Model.name} has no Active/Inactive flag, so its status cannot be changed.`),
      { status: 500 },
    );
  }
  const [count] = await Model.update(
    { [field]: activeValue(field, false) },
    { where: { ...where, [field]: activeValue(field, true) } },
  );
  return count;
}

module.exports = {
  activeField,
  activeWhere,
  setActive,
  deactivateWhere,
  isTruthy,
};
