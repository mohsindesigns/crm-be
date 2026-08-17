const { Op } = require('sequelize');
const db = require('../models');
const NotificationService = require('./NotificationService');
const EmailService = require('./EmailService');

// Sends the automatic "due tomorrow" reminder for open tasks. Uses local calendar
// dates (same pattern as AutoTaskScheduler) so timezone offsets don't skip a day.
function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function runTaskReminders(now = new Date()) {
  const today = dateKey(now);

  const tasks = await db.Task.findAll({
    where: {
      reminderAt: today,
      reminderSentAt: null,
      assigneeId: { [Op.ne]: null },
      status: { [Op.notIn]: ['done', 'approved'] },
    },
    include: [
      { model: db.User, as: 'assignee', attributes: ['id', 'name', 'email'] },
      { model: db.Project, as: 'project', attributes: ['id', 'name'] },
    ],
  });

  let sent = 0;
  for (const task of tasks) {
    try {
      const assignee = task.assignee;
      if (!assignee) {
        await task.update({ reminderSentAt: new Date() });
        continue;
      }

      const projectName = task.project?.name || 'a project';
      NotificationService.notify(assignee.id, task.orgId, {
        type: 'task_reminder',
        title: `Reminder: "${task.title}" due soon`,
        body: `Your task on ${projectName} is due ${task.dueAt || 'soon'} (24 hours left). Status: ${task.status || 'todo'}.`,
        refTable: 'projects',
        refId: task.projectId,
      });

      if (assignee.email) {
        EmailService.sendTaskReminder(
          assignee.email,
          assignee.name,
          task.title,
          projectName,
          task.dueAt,
        ).catch(() => {});
      }

      await task.update({ reminderSentAt: new Date() });
      sent += 1;
    } catch (err) {
      console.error(`[TaskReminderScheduler] Failed for task ${task.id}:`, err.message);
    }
  }

  if (sent > 0) console.log(`[TaskReminderScheduler] Sent ${sent} task reminder(s).`);
}

function startScheduler() {
  runTaskReminders().catch(console.error);
  // Hourly is enough for DATEONLY reminders; matches AutoTaskScheduler cadence.
  setInterval(() => runTaskReminders().catch(console.error), 60 * 60 * 1000);
}

module.exports = { startScheduler, runTaskReminders };
