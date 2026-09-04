require('dotenv').config();
const http = require('http');
const app = require('./app');
const db = require('./models');
const { attachChatSocket } = require('./services/ChatSocket');
const { startScheduler } = require('./services/RetainerScheduler');
const { startIndexationScheduler } = require('./services/BacklinkIndexationScheduler');
const { startScheduler: startAutoTaskScheduler } = require('./services/AutoTaskScheduler');
const { startScheduler: startDocumentExpiryScheduler } = require('./services/DocumentExpiryScheduler');
const { startScheduler: startTaskReminderScheduler } = require('./services/TaskReminderScheduler');
const { startChatRetentionScheduler } = require('./services/ChatRetentionScheduler');
const { startScheduler: startAttendanceAbsentScheduler } = require('./services/AttendanceAbsentScheduler');
const { startScheduler: startDiscountExpiryScheduler } = require('./services/DiscountExpiryScheduler');
const { startScheduler: startClientRequestReminderScheduler } = require('./services/ClientRequestReminderScheduler');
const { verifyTransport } = require('./services/EmailService');
const { register: registerScheduler } = require('./services/schedulerRegistry');

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await db.sequelize.authenticate();
    console.log('Database connection established.');
    await app.schemaReady;

    const server = http.createServer(app);
    const io = attachChatSocket(server, {
      corsOrigin: process.env.FRONTEND_URL || 'http://localhost:3000',
    });
    app.set('io', io);

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
      // Started through the registry (services/schedulerRegistry.js) so the
      // Overview page's System tab can report which background jobs are live —
      // these are bare setInterval loops with nothing else to query about them.
      // The cadence passed here is display-only; each scheduler still owns its
      // own interval, so keep the two in sync when changing one.
      const HOUR = 60 * 60 * 1000;
      registerScheduler('retainer_invoicing', 'Retainer auto-invoicing', 6 * HOUR, startScheduler);
      registerScheduler('backlink_indexation', 'Backlink indexation checks', 6 * HOUR, startIndexationScheduler);
      registerScheduler('auto_tasks', 'Recurring task generation', HOUR, startAutoTaskScheduler);
      registerScheduler('document_expiry', 'Quote/agreement expiry', 6 * HOUR, startDocumentExpiryScheduler);
      registerScheduler('task_reminders', 'Task reminders', HOUR, startTaskReminderScheduler);
      registerScheduler('chat_retention', 'Chat retention purge', 24 * HOUR, startChatRetentionScheduler);
      registerScheduler('attendance_absent', 'Attendance absent marking', 60 * 1000, startAttendanceAbsentScheduler);
      registerScheduler('discount_expiry', 'Discount expiry', 6 * HOUR, startDiscountExpiryScheduler);
      registerScheduler('client_request_reminders', 'Client request reminders', 6 * HOUR, startClientRequestReminderScheduler);
      // Non-blocking: a bad SMTP login must not stop the API from booting, but it
      // should be visible in the log rather than only failing at first send.
      verifyTransport().catch(() => {});
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
