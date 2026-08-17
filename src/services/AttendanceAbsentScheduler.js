/**
 * Nightly absent sweep — runs once per calendar day at ~3:00 AM Asia/Karachi.
 *
 * For the previous attendance date (shift 3:00 PM → 12:30 AM), any worker who
 * never checked in is stamped absent. Matches the attendance day model in
 * utils/attendanceDate.js (noon → noon sheets, but the shift window closes
 * shortly after midnight — 3 AM is safely past 12:30 AM checkout time).
 */
const db = require('../models');
const HrService = require('./HrService');
const { nowInKarachi, shiftCalendarDate } = require('../utils/attendanceDate');

const CHECK_MS = 60 * 1000;
let lastRunKey = null;

async function runAbsentSweep() {
  const { date, time } = nowInKarachi();
  const [hour, minute] = time.split(':').map(Number);

  // Fire once in the 3:00–3:04 AM window (polls every minute).
  if (hour !== 3 || minute > 4) return;

  const runKey = date;
  if (lastRunKey === runKey) return;
  lastRunKey = runKey;

  const targetDate = shiftCalendarDate(date, -1);
  const orgs = await db.Org.findAll({ attributes: ['id'] });
  let totalMarked = 0;

  for (const org of orgs) {
    try {
      const { marked } = await HrService.markAbsentForUnmarkedWorkers(org.id, targetDate);
      totalMarked += marked || 0;
    } catch (err) {
      console.error(`[AttendanceAbsentScheduler] org ${org.id}:`, err.message);
    }
  }

  console.log(
    `[AttendanceAbsentScheduler] Sweep for ${targetDate}: marked ${totalMarked} absent across ${orgs.length} org(s).`,
  );
}

function startScheduler() {
  setTimeout(() => runAbsentSweep().catch(console.error), 2 * 60 * 1000);
  setInterval(() => runAbsentSweep().catch(console.error), CHECK_MS);
  console.log('[AttendanceAbsentScheduler] started (daily ~3:00 AM Asia/Karachi).');
}

module.exports = { startScheduler, runAbsentSweep };
