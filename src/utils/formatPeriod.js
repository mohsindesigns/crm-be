const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Stored payroll periods are "YYYY-MM" — display as "July-2026". */
function formatPeriod(period) {
  if (!period) return '—';
  const match = String(period).trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return String(period);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) return String(period);
  return `${MONTH_NAMES[month - 1]}-${year}`;
}

module.exports = { formatPeriod };
