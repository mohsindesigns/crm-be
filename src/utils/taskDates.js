/** dueAt − 1 calendar day (local). Null when no due date or due is today/past. */
function computeReminderAt(dueAt) {
  if (!dueAt) return null;
  const m = String(dueAt).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const due = new Date(y, mo - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (due.getTime() <= today.getTime()) return null;
  const reminder = new Date(y, mo - 1, d);
  reminder.setDate(reminder.getDate() - 1);
  return `${reminder.getFullYear()}-${String(reminder.getMonth() + 1).padStart(2, '0')}-${String(reminder.getDate()).padStart(2, '0')}`;
}

module.exports = { computeReminderAt };
