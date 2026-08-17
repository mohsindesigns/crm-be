/**
 * Attendance day runs noon → next noon in the employee's local clock.
 * Example: 3:00 PM Jul 15 … 12:30 AM Jul 16 → attendance date = Jul 15.
 * Before 12:00 PM belongs to the previous calendar day's attendance sheet.
 */
const ATTENDANCE_DAY_CUTOFF_HOUR = 12; // noon
const ATTENDANCE_TIMEZONE = 'Asia/Karachi';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Server-authoritative "now" in Pakistan wall-clock time, independent of the
 * server's own OS timezone and of anything a client could report. Employees
 * connecting over a VPN (e.g. to reach US-hours clients) may have a browser
 * clock/timezone that no longer reflects Karachi time — attendance must not
 * trust that, so check-in/out always derive date/time from this instead of
 * any client-submitted value.
 */
function nowInKarachi(timeZone = ATTENDANCE_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}:${map.second}`,
  };
}

function shiftCalendarDate(yyyyMmDd, deltaDays) {
  const [y, m, d] = String(yyyyMmDd).slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * @param {string} localDate YYYY-MM-DD (employee local calendar)
 * @param {string} localTime HH:MM or HH:MM:SS (employee local clock)
 * @param {number} [cutoffHour=12]
 */
function getAttendanceDate(localDate, localTime, cutoffHour = ATTENDANCE_DAY_CUTOFF_HOUR) {
  const date = String(localDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || null;
  const hour = parseInt(String(localTime || '0').split(':')[0], 10);
  if (!Number.isFinite(hour)) return date;
  if (hour >= cutoffHour) return date;
  return shiftCalendarDate(date, -1);
}

function timeToMinutes(t) {
  const [h, m, s] = String(t || '0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0) + ((s || 0) / 60);
}

/** Hours between check-in and check-out on the same attendance day (supports overnight). */
function workedHours(checkIn, checkOut) {
  let mins = timeToMinutes(checkOut) - timeToMinutes(checkIn);
  if (mins < 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

module.exports = {
  ATTENDANCE_DAY_CUTOFF_HOUR,
  ATTENDANCE_TIMEZONE,
  nowInKarachi,
  getAttendanceDate,
  timeToMinutes,
  workedHours,
  shiftCalendarDate,
};
