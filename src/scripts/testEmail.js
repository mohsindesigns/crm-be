require('dotenv').config();
const { sendMail, verifyTransport } = require('../services/EmailService');

// Usage: npm run email:test -- someone@example.com
// Sends one plain message through the same EmailService the app uses, so a
// success here means invites/resets/invoices will send too.
const to = process.argv[2] || process.env.SEED_ADMIN_EMAIL;

(async () => {
  if (!to) {
    console.error('No recipient. Usage: npm run email:test -- someone@example.com');
    process.exit(1);
  }
  console.log(`Host:  ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
  console.log(`Login: ${process.env.SMTP_USER || '(empty — set SMTP_USER in .env)'}`);
  console.log(`From:  ${process.env.EMAIL_FROM}`);

  if (!(await verifyTransport())) process.exit(1);

  const info = await sendMail({
    to,
    subject: 'Cadence SMTP test',
    html: `
      <p>This is a test message from the Cadence backend.</p>
      <p>If you are reading this, outbound email is working:
      <strong>${process.env.SMTP_HOST}</strong> as
      <strong>${process.env.SMTP_USER}</strong>.</p>
      <p>Sent ${new Date().toISOString()}</p>
    `,
  });

  if (!info) {
    console.error('Send failed — see the [EmailService] error above.');
    process.exit(1);
  }
  console.log(`Sent to ${to}. messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)}`);
  process.exit(0);
})();
