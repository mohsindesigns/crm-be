/**
 * Shared "is this record still in play?" flag.
 *
 * Org policy: nothing in the CRM is ever destroyed. Every former DELETE action
 * deactivates instead (see middleware/adminOnly + SoftDeleteService), so the row
 * stays available for history, audit trails, reports and re-activation. List
 * endpoints hide inactive rows by default and accept `?includeInactive=1`.
 *
 * Models that already carry a lifecycle ENUM with an inactive member (Keyword's
 * status active/inactive) reuse that instead of adding a second flag.
 *
 * Usage inside a model definition:
 *   const { isActiveAttribute } = require('./softDeletable');
 *   ...
 *   isActive: isActiveAttribute(DataTypes),
 */
function isActiveAttribute(DataTypes) {
  return {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: true,
  };
}

module.exports = { isActiveAttribute };
