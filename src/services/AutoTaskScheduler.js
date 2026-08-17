const { Op } = require('sequelize');
const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const NotificationService = require('./NotificationService');
const EmailService = require('./EmailService');
const { computeReminderAt } = require('../utils/taskDates');

// Materializes RecurringTaskRule rows into real Task rows on schedule — the
// "monthly SEO review", "monthly ranking update", and any admin-configured
// weekly/biweekly/monthly rule (GMB, blog posts, etc.). Follows the same
// setInterval polling pattern as RetainerScheduler.js (no cron library).
//
// Due date is always the start of the next cycle (not an hour offset):
//   weekly   → +7 days (same weekday next week)
//   biweekly → +14 days
//   monthly  → next month's generate day
//
// Calendar checks (day-of-month, weekday) deliberately use local Date accessors
// (getDate/getMonth/getDay), not `toISOString()` — UTC-based date strings roll
// back a calendar day during early-morning hours in positive-UTC-offset
// timezones (see the attendance timezone fix), which would make "generate on
// the 1st" or "generate every Wednesday" fire a day early/late.
function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function lastDayOfMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function parseDateOnly(str) {
  const [y, m, d] = String(str).split('-').map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function firstWeekdayOnOrAfter(startDateStr, weekday) {
  const start = parseDateOnly(startDateStr);
  const delta = (weekday - start.getDay() + 7) % 7;
  return addDays(start, delta);
}

async function resolveAssignee(projectId, roleSlot) {
  const assignment = await db.ProjectAssignment.findOne({ where: { projectId, roleSlot } });
  return assignment?.userId || null;
}

function resolveSchedule(rule, now) {
  let shouldRun = false;
  let periodKey = null;
  let dueAt = null;

  if (rule.frequency === 'monthly') {
    const generateDay = rule.generateDayOfMonth || 1;
    if (now.getDate() === generateDay) {
      periodKey = monthKey(now);
      if (rule.lastGeneratedPeriod !== periodKey) {
        shouldRun = true;
        // Due when the next monthly cycle starts.
        const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        const dueDay = Math.min(generateDay, lastDayOfMonth(next.getFullYear(), next.getMonth()));
        dueAt = new Date(next.getFullYear(), next.getMonth(), dueDay);
      }
    }
  } else if (rule.frequency === 'weekly' || rule.frequency === 'biweekly') {
    const weekday = parseInt(rule.weekday, 10);
    if (Number.isNaN(weekday) || now.getDay() !== weekday) {
      return { shouldRun: false, periodKey: null, dueAt: null };
    }

    const intervalDays = rule.frequency === 'biweekly' ? 14 : 7;
    const first = firstWeekdayOnOrAfter(rule.startDate, weekday);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (today < first) {
      return { shouldRun: false, periodKey: null, dueAt: null };
    }

    const daysSinceFirst = Math.round((today - first) / (24 * 60 * 60 * 1000));
    if (daysSinceFirst % intervalDays !== 0) {
      return { shouldRun: false, periodKey: null, dueAt: null };
    }

    periodKey = dateKey(now);
    if (rule.lastGeneratedPeriod !== periodKey) {
      shouldRun = true;
      dueAt = addDays(today, intervalDays);
    }
  }

  return { shouldRun, periodKey, dueAt };
}

// `now` is injectable (defaults to the real clock) purely so this can be verified
// on demand — e.g. simulating "today is the 1st of the month" — without waiting
// for the calendar or faking the system clock.
async function runAutoTaskGeneration(now = new Date()) {

  const rules = await db.RecurringTaskRule.findAll({
    where: { isActive: true, startDate: { [Op.lte]: dateKey(now) } },
    include: [{
      model: db.Project,
      as: 'project',
      attributes: ['id', 'orgId', 'status', 'currentStageKey', 'isRecurring', 'name'],
    }],
  });

  let created = 0;
  for (const rule of rules) {
    try {
      const project = rule.project;
      // Retainer SEO (and other isRecurring projects) keep generating tasks after
      // they reach the terminal "completed" stage — only cancelled projects stop.
      if (!project || project.status === 'cancelled') continue;
      if (project.status === 'completed' && !project.isRecurring) continue;

      const { shouldRun, periodKey, dueAt } = resolveSchedule(rule, now);
      if (!shouldRun || !dueAt) continue;

      const assigneeId = await resolveAssignee(project.id, rule.roleSlot);
      // Blog posts (and similar reviewable retainer work) go to strategist/PM for sign-off.
      let reviewerId = null;
      if (rule.taskType === 'blog_post' || rule.roleSlot === 'blog_writer') {
        reviewerId = await resolveAssignee(project.id, 'project_strategist')
          || await resolveAssignee(project.id, 'project_manager');
      }
      const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      const title = rule.frequency === 'monthly'
        ? `${rule.title} — ${monthLabel}`
        : `${rule.title} — ${dateKey(now)}`;

      const dueAtStr = dateKey(dueAt);
      const taskType = rule.taskType === 'custom' && rule.roleSlot === 'blog_writer'
        ? 'blog_post'
        : rule.taskType;
      const task = await db.Task.create({
        id: uuidv4(),
        orgId: project.orgId,
        projectId: project.id,
        ruleId: rule.id,
        stageKey: rule.stageKey || project.currentStageKey,
        type: taskType,
        title,
        assigneeId,
        reviewerId,
        status: 'todo',
        dueAt: dueAtStr,
        reminderAt: computeReminderAt(dueAtStr),
        autoCreated: true,
      });
      await rule.update({ lastGeneratedPeriod: periodKey });
      created += 1;

      if (assigneeId) {
        db.User.findByPk(assigneeId).then((assignee) => {
          if (!assignee) return;
          if (assignee.email) {
            EmailService.sendTaskAssigned(assignee.email, assignee.name, task.title, project.name, task.dueAt);
          }
          NotificationService.notify(assignee.id, project.orgId, {
            type: 'task_assigned',
            title: `New task assigned: "${task.title}"`,
            body: `A recurring task was generated on ${project.name}. Status: To do. Due ${task.dueAt}.`,
            refTable: 'projects',
            refId: project.id,
          });
        }).catch(() => {});
      }
    } catch (err) {
      console.error(`[AutoTaskScheduler] Failed for rule ${rule.id}:`, err.message);
    }
  }

  if (created > 0) console.log(`[AutoTaskScheduler] Generated ${created} recurring task(s).`);
}

function startScheduler() {
  runAutoTaskGeneration().catch(console.error);
  setInterval(() => runAutoTaskGeneration().catch(console.error), 60 * 60 * 1000);
}

module.exports = { startScheduler, runAutoTaskGeneration, resolveSchedule };
