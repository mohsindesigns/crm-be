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
      startScheduler();
      startIndexationScheduler();
      startAutoTaskScheduler();
      startDocumentExpiryScheduler();
      startTaskReminderScheduler();
      startChatRetentionScheduler();
      startAttendanceAbsentScheduler();
      startDiscountExpiryScheduler();
      startClientRequestReminderScheduler();
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
