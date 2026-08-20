const nodemailer = require('nodemailer');
const { BRAND_PRIMARY, BRAND_PRIMARY_DARK, BRAND_ACCENT, BRAND_ACCENT_DARK } = require('../config/brand');
const { formatPeriod } = require('../utils/formatPeriod');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const secure = process.env.SMTP_SECURE === 'true';
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
      port,
      secure,
      // On the submission port the connection starts plaintext and upgrades via
      // STARTTLS. Relays like Brevo always offer it, so demand it rather than
      // letting nodemailer silently fall back to sending credentials in the clear.
      ...(secure ? {} : { requireTLS: true }),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEmailDate(dateStr) {
  if (!dateStr) return '—';
  try {
    const d = new Date(`${String(dateStr).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function titleCaseWords(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

function emailLayout({ brandName, logoUrl, title, accentColor, badgeLabel, badgeBg, badgeColor, bodyHtml, footerHtml }) {
  const brandBlock = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brandName)}" style="height:24px;width:auto;max-width:180px;object-fit:contain;display:block;margin:0 0 14px;">`
    : `<p style="margin:0 0 6px;color:#6b7280;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(brandName)}</p>`;
  return `
    <div style="margin:0;padding:32px 16px;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <div style="height:4px;background:${accentColor};"></div>
        <div style="padding:28px 32px 8px;">
          ${brandBlock}
          <h1 style="margin:0;color:#111827;font-size:22px;line-height:1.3;font-weight:700;">${escapeHtml(title || badgeLabel)}</h1>
          <span style="display:inline-block;margin-top:14px;padding:6px 12px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(badgeLabel)}</span>
        </div>
        <div style="padding:8px 32px 28px;">
          ${bodyHtml}
        </div>
        <div style="padding:18px 32px;background:#f9fafb;border-top:1px solid #e5e7eb;">
          <p style="margin:0;color:#9ca3af;font-size:12px;line-height:1.6;">${footerHtml}</p>
        </div>
      </div>
    </div>
  `;
}

async function sendMail({ to, subject, html, from, attachments, cc }) {
  if (!process.env.SMTP_USER) {
    console.warn(`[EmailService] SMTP_USER not configured; skipping email to ${to}`);
    return null;
  }
  try {
    return await getTransporter().sendMail({
      from: from || process.env.EMAIL_FROM || '"Mohsin Designs Project Management" <noreply@mohsindesigns.com>',
      to,
      ...(cc?.length ? { cc } : {}),
      subject,
      html,
      ...(attachments?.length ? { attachments } : {}),
    });
  } catch (err) {
    // Every caller treats a null return as "not delivered" and carries on, so this
    // log is the only trace a failed send leaves — include the SMTP-level detail
    // (auth rejection vs. unverified sender vs. connection) or it is undiagnosable.
    console.error(
      `[EmailService] Failed to send email to ${to}: ${err.message}`
      + `${err.code ? ` [code=${err.code}]` : ''}`
      + `${err.responseCode ? ` [smtp=${err.responseCode}]` : ''}`
      + `${err.response ? ` ${err.response}` : ''}`,
    );
    return null;
  }
}

// Called once at boot so a bad host/login surfaces in the startup log instead of
// on the first invite or password reset a user happens to trigger.
async function verifyTransport() {
  if (!process.env.SMTP_USER) {
    console.warn('[EmailService] SMTP_USER not configured — outbound email is disabled.');
    return false;
  }
  try {
    await getTransporter().verify();
    console.log(`[EmailService] SMTP ready (${process.env.SMTP_HOST} as ${process.env.SMTP_USER}).`);
    return true;
  } catch (err) {
    console.error(
      `[EmailService] SMTP verification FAILED — email will not send: ${err.message}`
      + `${err.responseCode ? ` [smtp=${err.responseCode}]` : ''}`,
    );
    return false;
  }
}

async function sendPayrollReady(workerEmail, workerName, period, netPay, currency = 'PKR') {
  const periodLabel = formatPeriod(period);
  return sendMail({
    to: workerEmail,
    subject: `Your salary slip is ready — ${periodLabel}`,
    html: `
      <p>Hi ${workerName},</p>
      <p>Your salary slip for <strong>${periodLabel}</strong> has been generated.</p>
      <p><strong>Net Pay: ${currency} ${Number(netPay).toLocaleString()}</strong></p>
      <p>Please log in to review and confirm your payroll.</p>
    `,
  });
}

async function sendLeaveUpdate({
  workerEmail,
  workerName,
  status,
  leaveType,
  startDate,
  endDate,
  days,
  approverNote,
  appUrl,
}) {
  const isApproved = status === 'approved';
  const action = isApproved ? 'approved' : 'rejected';
  const actionLabel = isApproved ? 'Approved' : 'Not Approved';
  const accentColor = isApproved ? BRAND_PRIMARY : '#dc2626';
  const badgeBg = isApproved ? '#fef3c7' : '#fee2e2';
  const badgeColor = isApproved ? BRAND_PRIMARY : '#b91c1c';
  const brandName = process.env.EMAIL_BRAND_NAME || 'Mohsin Designs Project Management';
  const typeLabel = titleCaseWords(leaveType || 'leave');
  const fromLabel = formatEmailDate(startDate);
  const toLabel = formatEmailDate(endDate);
  const loginUrl = appUrl ? `${String(appUrl).replace(/\/$/, '')}/self-service?tab=leaves` : null;
  const safeName = escapeHtml(workerName || 'there');
  const safeNote = approverNote?.trim() ? escapeHtml(approverNote.trim()) : '';

  const noteBlock = !isApproved && safeNote
    ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:20px 0 0;">
        <p style="margin:0 0 6px;color:#991b1b;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Reason from HR</p>
        <p style="margin:0;color:#7f1d1d;font-size:14px;line-height:1.6;">${safeNote}</p>
      </div>
    `
    : isApproved && safeNote
      ? `
      <div style="background:#eef1f9;border:1px solid #d5dcf0;border-radius:8px;padding:16px;margin:20px 0 0;">
        <p style="margin:0 0 6px;color:${BRAND_PRIMARY};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Note from HR</p>
        <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${safeNote}</p>
      </div>
    `
      : '';

  const daysRow = days != null && days !== ''
    ? `<tr>
        <td style="padding:10px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">Duration</td>
        <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(days)} day${Number(days) === 1 ? '' : 's'}</td>
      </tr>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      Your <strong>${escapeHtml(typeLabel)}</strong> leave request has been reviewed and is marked as
      <strong style="color:${accentColor};">${action}</strong>.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px 20px;margin:22px 0 0;">
      <p style="margin:0 0 12px;color:#6b7280;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Leave Summary</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">Leave Type</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(typeLabel)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;vertical-align:top;">From</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(fromLabel)}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;vertical-align:top;">To</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(toLabel)}</td>
        </tr>
        ${daysRow}
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;vertical-align:top;">Status</td>
          <td style="padding:10px 0;">
            <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:700;text-transform:uppercase;">${actionLabel}</span>
          </td>
        </tr>
      </table>
    </div>
    ${noteBlock}
    ${loginUrl
      ? `<a href="${loginUrl}" style="display:inline-block;margin-top:24px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">View Leave Requests</a>`
      : '<p style="margin:24px 0 0;color:#374151;font-size:14px;">Log in to your account to view your leave requests.</p>'}
  `;

  const subject = isApproved
    ? `Leave approved — ${typeLabel} (${fromLabel} to ${toLabel})`
    : `Leave not approved — ${typeLabel} (${fromLabel} to ${toLabel})`;

  return sendMail({
    to: workerEmail,
    subject,
    html: emailLayout({
      brandName,
      title: 'Leave Request Update',
      accentColor,
      badgeLabel: actionLabel,
      badgeBg,
      badgeColor,
      bodyHtml,
      footerHtml: `This is an automated message from ${escapeHtml(brandName)} HR. If you have questions about this decision, please contact your HR administrator.`,
    }),
  });
}

async function sendProfileReviewUpdate({
  workerEmail,
  workerName,
  status,
  isAmendment,
  reason,
  appUrl,
}) {
  const rejected = status === 'rejected';
  const actionLabel = rejected ? 'Not Approved' : 'Approved';
  const accentColor = rejected ? '#dc2626' : BRAND_PRIMARY;
  const badgeBg = rejected ? '#fee2e2' : '#fef3c7';
  const badgeColor = rejected ? '#b91c1c' : BRAND_PRIMARY;
  const brandName = process.env.EMAIL_BRAND_NAME || 'Mohsin Designs Project Management';
  const safeName = escapeHtml(workerName || 'there');
  const safeReason = reason?.trim() ? escapeHtml(reason.trim()) : '';
  const subjectType = isAmendment ? 'profile changes' : 'profile submission';
  const loginUrl = appUrl ? `${String(appUrl).replace(/\/$/, '')}/self-service?tab=profile` : null;

  const noteBlock = rejected && safeReason
    ? `
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:20px 0 0;">
        <p style="margin:0 0 6px;color:#991b1b;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Reason from HR</p>
        <p style="margin:0;color:#7f1d1d;font-size:14px;line-height:1.6;">${safeReason}</p>
      </div>
    `
    : '';

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      Your ${escapeHtml(subjectType)} has been reviewed and is marked as
      <strong style="color:${accentColor};">${rejected ? 'rejected' : 'approved'}</strong>.
    </p>
    ${rejected
      ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.6;">
          Please log in, update the requested details, and submit your profile again for HR review.
        </p>`
      : `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.6;">
          Your profile is now up to date. No further action is required.
        </p>`}
    ${noteBlock}
    ${loginUrl
      ? `<a href="${loginUrl}" style="display:inline-block;margin-top:24px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">${rejected ? 'Update My Profile' : 'View My Profile'}</a>`
      : '<p style="margin:24px 0 0;color:#374151;font-size:14px;">Log in to your account to view your profile.</p>'}
  `;

  const subject = rejected
    ? `Profile not approved — action required`
    : `Profile approved`;

  return sendMail({
    to: workerEmail,
    subject,
    html: emailLayout({
      brandName,
      title: isAmendment ? 'Profile Amendment Update' : 'Profile Submission Update',
      accentColor,
      badgeLabel: actionLabel,
      badgeBg,
      badgeColor,
      bodyHtml,
      footerHtml: `This is an automated message from ${escapeHtml(brandName)} HR. If you have questions about this decision, please contact your HR administrator.`,
    }),
  });
}

async function sendProjectAssigned(userEmail, userName, projectName, roleSlot) {
  return sendMail({
    to: userEmail,
    subject: `You've been assigned to "${projectName}"`,
    html: `
      <p>Hi ${userName},</p>
      <p>You have been assigned to the project <strong>${projectName}</strong> as <strong>${roleSlot}</strong>.</p>
      <p>Log in to view your tasks and project details.</p>
    `,
  });
}

async function sendTaskAssigned(userEmail, userName, taskTitle, projectName, dueAt) {
  return sendMail({
    to: userEmail,
    subject: `New task assigned: "${taskTitle}"`,
    html: `
      <p>Hi ${userName},</p>
      <p>You've been assigned a new task on <strong>${projectName}</strong>:</p>
      <p style="font-size:16px"><strong>${taskTitle}</strong></p>
      ${dueAt ? `<p>Due: <strong>${dueAt}</strong></p>` : ''}
      <p>Log in to view details and upload your deliverable.</p>
    `,
  });
}

async function sendTaskReminder(userEmail, userName, taskTitle, projectName, dueAt) {
  return sendMail({
    to: userEmail,
    subject: `Reminder: "${taskTitle}" is due soon`,
    html: `
      <p>Hi ${userName},</p>
      <p>This is an automatic reminder — your task on <strong>${projectName}</strong> is due in about 24 hours:</p>
      <p style="font-size:16px"><strong>${taskTitle}</strong></p>
      ${dueAt ? `<p>Due: <strong>${dueAt}</strong></p>` : ''}
      <p>Log in to finish the work and upload your deliverable.</p>
    `,
  });
}

async function sendPasswordReset(userEmail, userName, resetLink) {
  return sendMail({
    to: userEmail,
    subject: 'Reset your password',
    html: `
      <p>Hi ${userName},</p>
      <p>We received a request to reset your password. Click the link below to set a new password:</p>
      <p><a href="${resetLink}">Reset Password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
    `,
  });
}

async function sendStageAdvance(userEmail, userName, projectName, fromStage, toStage) {
  return sendMail({
    to: userEmail,
    subject: `Project "${projectName}" moved to ${toStage}`,
    html: `
      <p>Hi ${userName},</p>
      <p>The project <strong>${projectName}</strong> has advanced from <strong>${fromStage}</strong> to <strong>${toStage}</strong>.</p>
      <p>Log in to review the current stage and any tasks assigned to you.</p>
    `,
  });
}

async function sendUserInvite(userEmail, userName, tempPassword, appUrl) {
  return sendMail({
    to: userEmail,
    subject: 'You\'ve been invited to Mohsin Designs Project Management',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">Welcome to Mohsin Designs Project Management</h2>
        <p style="color:#374151">Hi <strong>${userName}</strong>,</p>
        <p style="color:#374151">You have been invited to join <strong>Mohsin Designs Project Management</strong>. Use the credentials below to log in for the first time.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:20px 0">
          <p style="margin:0 0 8px;color:#6b7280;font-size:13px">LOGIN CREDENTIALS</p>
          <p style="margin:0 0 6px;color:#111827"><strong>Email:</strong> ${userEmail}</p>
          <p style="margin:0;color:#111827"><strong>Temporary Password:</strong> ${tempPassword}</p>
        </div>
        <a href="${appUrl}/login" style="display:inline-block;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Log In Now</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">Please change your password after your first login. If you did not expect this invitation, you can ignore this email.</p>
      </div>
    `,
  });
}

// Sent when an admin resets someone else's password (as opposed to sendPasswordReset,
// which is for a self-service "forgot password" link flow). Carries the new temporary
// password directly, since there's no reset-link step here — the admin already set it.
async function sendAdminPasswordReset(userEmail, userName, tempPassword, appUrl) {
  return sendMail({
    to: userEmail,
    subject: 'Your password has been reset',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">Password Reset</h2>
        <p style="color:#374151">Hi <strong>${userName}</strong>,</p>
        <p style="color:#374151">An administrator has reset your password. Use the temporary password below to log in — you'll be asked to set your own new password immediately after.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:20px 0">
          <p style="margin:0 0 8px;color:#6b7280;font-size:13px">TEMPORARY PASSWORD</p>
          <p style="margin:0;color:#111827;font-family:monospace;font-size:16px"><strong>${tempPassword}</strong></p>
        </div>
        <a href="${appUrl}/login" style="display:inline-block;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Log In Now</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">If you did not expect this change, contact your administrator immediately.</p>
      </div>
    `,
  });
}

async function sendEmailChangeCode(userEmail, userName, brandName, code) {
  return sendMail({
    to: userEmail,
    subject: `Verify your new email — ${brandName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">${escapeHtml(brandName || 'Mohsin Designs Project Management')}</h2>
        <p style="color:#374151">Hi <strong>${escapeHtml(userName || 'there')}</strong>,</p>
        <p style="color:#374151">Use the verification code below to confirm this email address for your account. This code expires in 10 minutes.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:20px;margin:20px 0;text-align:center">
          <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:6px;color:#111827">${escapeHtml(code)}</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">If you did not request an email change, you can safely ignore this message.</p>
      </div>
    `,
  });
}

async function sendPortalLoginCode(contactEmail, contactName, brandName, code) {
  return sendMail({
    to: contactEmail,
    subject: `Your ${brandName} portal verification code`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">${brandName} Client Portal</h2>
        <p style="color:#374151">Hi <strong>${contactName || 'there'}</strong>,</p>
        <p style="color:#374151">Use the verification code below to sign in to your client portal. This code expires in 10 minutes.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:20px;margin:20px 0;text-align:center">
          <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:6px;color:#111827">${code}</p>
        </div>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">If you did not try to sign in, you can safely ignore this email — no one can access your account without this code.</p>
      </div>
    `,
  });
}

async function sendPortalInvite(contactEmail, contactName, brandName, portalUrl) {
  return sendMail({
    to: contactEmail,
    subject: `You've been granted access to the ${brandName} client portal`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">${brandName} Client Portal</h2>
        <p style="color:#374151">Hi <strong>${contactName}</strong>,</p>
        <p style="color:#374151">You have been granted access to the <strong>${brandName}</strong> client portal. You can use it to track your projects, review deliverables, and communicate with our team.</p>
        <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:16px;margin:20px 0">
          <p style="margin:0 0 8px;color:#6b7280;font-size:13px">YOUR LOGIN</p>
          <p style="margin:0;color:#111827"><strong>Email:</strong> ${contactEmail}</p>
        </div>
        <a href="${portalUrl}" style="display:inline-block;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Access Portal</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">Enter your email on the login page and we'll send a one-time verification code to confirm it's you. If you did not expect this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

function _documentTypeLabel(type) {
  return type === 'agreement' ? 'Agreement' : type === 'proposal' ? 'Proposal' : 'Quotation';
}

async function sendDocumentReviewLink(email, prospectName, brandName, type, number, reviewUrl) {
  const label = _documentTypeLabel(type);
  return sendMail({
    to: email,
    subject: `${brandName} sent you ${label === 'Agreement' ? 'an' : 'a'} ${label} — ${number}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">${brandName}</h2>
        <p style="color:#374151">Hi <strong>${prospectName}</strong>,</p>
        <p style="color:#374151">${brandName} has sent you a ${label.toLowerCase()} (<strong>${number}</strong>) for your review. Please take a look and let us know if you'd like to approve it or request changes.</p>
        <a href="${reviewUrl}" style="display:inline-block;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Review ${label}</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">This link doesn't require an account or password — just click it to review and respond.</p>
      </div>
    `,
  });
}

async function sendDocumentRemind(email, prospectName, brandName, type, number, reviewUrl) {
  const label = _documentTypeLabel(type);
  return sendMail({
    to: email,
    subject: `Reminder: ${label} ${number} from ${brandName} is awaiting your review`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:8px">
        <h2 style="color:${BRAND_PRIMARY};margin:0 0 16px">${brandName}</h2>
        <p style="color:#374151">Hi <strong>${prospectName}</strong>,</p>
        <p style="color:#374151">Just a friendly reminder — your ${label.toLowerCase()} (<strong>${number}</strong>) from ${brandName} is still awaiting your review.</p>
        <a href="${reviewUrl}" style="display:inline-block;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:600">Review ${label}</a>
        <p style="color:#9ca3af;font-size:12px;margin-top:24px">This link doesn't require an account or password — just click it to review and respond.</p>
      </div>
    `,
  });
}

async function sendInvoiceEmail({
  to, clientName, brandName, invoiceNumber, amountDue, currency, dueAt, portalUrl, attachmentBuffer, attachmentName,
  // A reminder is the same invoice and the same attachment — only the framing
  // changes, so it shares this function rather than duplicating the layout.
  isReminder = false, isOverdue = false,
}) {
  const safeName = escapeHtml(clientName || 'there');
  const amountStr = amountDue != null ? `${escapeHtml(currency || '')} ${Number(amountDue).toLocaleString(undefined, { minimumFractionDigits: 2 })}`.trim() : null;
  const dueLabel = dueAt ? formatEmailDate(dueAt) : null;

  // Overdue wording stays factual rather than accusatory: the most common cause
  // of a late invoice is that it was missed, not withheld.
  const lead = !isReminder
    ? `Please find attached invoice <strong>${escapeHtml(invoiceNumber)}</strong>${amountStr ? ` for <strong>${amountStr}</strong>` : ''}${dueLabel ? ` due <strong>${escapeHtml(dueLabel)}</strong>` : ''}.`
    : isOverdue
      ? `This is a reminder that invoice <strong>${escapeHtml(invoiceNumber)}</strong>${amountStr ? ` for <strong>${amountStr}</strong>` : ''} was due${dueLabel ? ` on <strong>${escapeHtml(dueLabel)}</strong>` : ''} and is still outstanding. If it has already been paid, please ignore this message.`
      : `This is a friendly reminder about invoice <strong>${escapeHtml(invoiceNumber)}</strong>${amountStr ? ` for <strong>${amountStr}</strong>` : ''}${dueLabel ? `, due <strong>${escapeHtml(dueLabel)}</strong>` : ''}.`;

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      ${lead}
    </p>
    ${portalUrl
      ? `<a href="${portalUrl}" style="display:inline-block;margin-top:22px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">View Invoice Online</a>`
      : ''}
  `;

  return sendMail({
    to,
    subject: isReminder
      ? `${isOverdue ? 'Overdue' : 'Reminder'}: invoice ${invoiceNumber} from ${brandName}`
      : `Invoice ${invoiceNumber} from ${brandName}`,
    html: emailLayout({
      brandName,
      title: `Invoice ${invoiceNumber}`,
      accentColor: BRAND_PRIMARY,
      badgeLabel: isReminder ? (isOverdue ? 'Overdue' : 'Reminder') : 'Invoice',
      badgeBg: isReminder && isOverdue ? '#fee2e2' : '#fef3c7',
      badgeColor: BRAND_PRIMARY,
      bodyHtml,
      footerHtml: `This is an automated message from ${escapeHtml(brandName)}. The attached PDF is your official invoice copy.`,
    }),
    attachments: attachmentBuffer
      ? [{ filename: attachmentName || `${invoiceNumber}.pdf`, content: attachmentBuffer, contentType: 'application/pdf' }]
      : [],
  });
}

async function sendAppraisalUpdate({
  workerEmail,
  workerName,
  reviewDate,
  rating,
  notes,
  salaryBefore,
  salaryAfter,
  currency,
  appUrl,
}) {
  const brandName = process.env.EMAIL_BRAND_NAME || 'Mohsin Designs Project Management';
  const loginUrl = appUrl ? `${String(appUrl).replace(/\/$/, '')}/self-service?tab=appraisals` : null;
  const safeName = escapeHtml(workerName || 'there');
  const safeRating = rating?.trim() ? escapeHtml(rating.trim()) : '';
  const safeNotes = notes?.trim() ? escapeHtml(notes.trim()) : '';
  const dateLabel = formatEmailDate(reviewDate);
  const cur = escapeHtml(currency || 'PKR');
  const beforeNum = salaryBefore != null && salaryBefore !== '' ? Number(salaryBefore) : null;
  const afterNum = salaryAfter != null && salaryAfter !== '' ? Number(salaryAfter) : null;
  const salaryChanged = beforeNum != null && afterNum != null && beforeNum !== afterNum;

  const salaryBlock = salaryChanged
    ? `
      <tr>
        <td style="padding:10px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">Compensation</td>
        <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">
          ${escapeHtml(String(beforeNum))} ${cur} → ${escapeHtml(String(afterNum))} ${cur}
        </td>
      </tr>`
    : '';

  const notesBlock = safeNotes
    ? `
      <div style="background:#eef1f9;border:1px solid #d5dcf0;border-radius:8px;padding:16px;margin:20px 0 0;">
        <p style="margin:0 0 6px;color:${BRAND_PRIMARY};font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Notes from reviewer</p>
        <p style="margin:0;color:#374151;font-size:14px;line-height:1.6;">${safeNotes}</p>
      </div>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      A new performance appraisal has been recorded for you${safeRating ? ` with a rating of <strong>${safeRating}</strong>` : ''}.
    </p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:18px 20px;margin:22px 0 0;">
      <p style="margin:0 0 12px;color:#6b7280;font-size:12px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">Appraisal Summary</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;width:120px;vertical-align:top;">Review Date</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(dateLabel)}</td>
        </tr>
        ${safeRating ? `<tr>
          <td style="padding:10px 0;color:#6b7280;font-size:13px;vertical-align:top;">Rating</td>
          <td style="padding:10px 0;color:#111827;font-size:14px;font-weight:600;">${safeRating}</td>
        </tr>` : ''}
        ${salaryBlock}
      </table>
    </div>
    ${notesBlock}
    ${loginUrl
      ? `<a href="${loginUrl}" style="display:inline-block;margin-top:24px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">View Appraisals</a>`
      : '<p style="margin:24px 0 0;color:#374151;font-size:14px;">Log in to your account to view your appraisals.</p>'}
  `;

  return sendMail({
    to: workerEmail,
    subject: `New appraisal recorded${safeRating ? ` — ${rating.trim()}` : ''} (${dateLabel})`,
    html: emailLayout({
      brandName,
      title: 'Performance Appraisal',
      accentColor: BRAND_PRIMARY,
      badgeLabel: 'Appraisal',
      badgeBg: '#fef3c7',
      badgeColor: BRAND_PRIMARY,
      bodyHtml,
      footerHtml: `This is an automated message from ${escapeHtml(brandName)} HR. If you have questions about this appraisal, please contact your manager or HR.`,
    }),
  });
}


/** The requirements form a staff member composes on a project and sends to a
 *  client contact (see services/ClientRequestService.js#send). `formUrl` is a
 *  tokenized public link — no login, same as the document review links above. */
async function sendClientRequestForm({
  to, cc, recipientName, brandName, logoUrl, projectName, subject, message, formUrl, dueAt, fieldCount,
}) {
  const safeName = escapeHtml(recipientName || 'there');
  const dueLabel = dueAt ? formatEmailDate(dueAt) : null;
  const messageBlock = message
    ? `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px 18px;margin:20px 0 0;">
         <p style="margin:0;color:#374151;font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(message)}</p>
       </div>`
    : '';
  const dueBlock = dueLabel
    ? `<p style="margin:20px 0 0;color:#374151;font-size:14px;line-height:1.6;">Please complete it by <strong>${escapeHtml(dueLabel)}</strong> so we can keep the project moving.</p>`
    : '';

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      For <strong>${escapeHtml(projectName)}</strong>, we need a few details from you.
      ${fieldCount ? `The form below has <strong>${fieldCount}</strong> question${fieldCount === 1 ? '' : 's'} and takes just a couple of minutes.` : ''}
    </p>
    ${messageBlock}
    ${dueBlock}
    <a href="${formUrl}" style="display:inline-block;margin-top:24px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">Fill in the form</a>
    <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;line-height:1.6;">
      No account or password needed — just click the button. If it doesn't work, copy this link into your browser:<br>
      <span style="color:#6b7280;word-break:break-all;">${formUrl}</span>
    </p>
  `;

  return sendMail({
    to,
    cc,
    subject,
    html: emailLayout({
      brandName,
      logoUrl,
      title: subject,
      accentColor: BRAND_PRIMARY,
      badgeLabel: 'Action needed',
      badgeBg: '#fef3c7',
      badgeColor: BRAND_PRIMARY,
      bodyHtml,
      footerHtml: `You're receiving this because ${escapeHtml(brandName)} is working with you on ${escapeHtml(projectName)}. Reply to this email if you have any questions.`,
    }),
  });
}

/** Nudge for a requirements form that's still unanswered. `automated: true`
 *  when it comes from ClientRequestReminderScheduler rather than a staff member
 *  clicking "Send reminder" — the wording softens accordingly. */
async function sendClientRequestReminder({
  to, cc, recipientName, brandName, logoUrl, projectName, subject, formUrl, dueAt, automated,
}) {
  const safeName = escapeHtml(recipientName || 'there');
  const dueLabel = dueAt ? formatEmailDate(dueAt) : null;
  const overdue = dueAt ? new Date(`${String(dueAt).slice(0, 10)}T23:59:59`) < new Date() : false;

  const bodyHtml = `
    <p style="margin:0 0 12px;color:#374151;font-size:15px;line-height:1.6;">Hi <strong>${safeName}</strong>,</p>
    <p style="margin:0;color:#374151;font-size:15px;line-height:1.6;">
      ${automated ? 'A quick automatic reminder' : 'Just a friendly reminder'} — the requirements form for
      <strong>${escapeHtml(projectName)}</strong> is still waiting on you.
    </p>
    ${dueLabel
      ? `<p style="margin:18px 0 0;color:#374151;font-size:14px;line-height:1.6;">${overdue
          ? `It was due on <strong>${escapeHtml(dueLabel)}</strong>.`
          : `It's due on <strong>${escapeHtml(dueLabel)}</strong>.`}</p>`
      : ''}
    <a href="${formUrl}" style="display:inline-block;margin-top:24px;background:${BRAND_ACCENT};color:${BRAND_PRIMARY};text-decoration:none;padding:12px 22px;border-radius:8px;font-size:14px;font-weight:700;">Fill in the form</a>
    <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;line-height:1.6;">
      Already sent it over? You can ignore this message.
    </p>
  `;

  return sendMail({
    to,
    cc,
    subject: `Reminder: ${subject}`,
    html: emailLayout({
      brandName,
      logoUrl,
      title: subject,
      accentColor: overdue ? '#dc2626' : BRAND_PRIMARY,
      badgeLabel: overdue ? 'Overdue' : 'Reminder',
      badgeBg: overdue ? '#fee2e2' : '#fef3c7',
      badgeColor: overdue ? '#991b1b' : BRAND_PRIMARY,
      bodyHtml,
      footerHtml: `You're receiving this because ${escapeHtml(brandName)} is working with you on ${escapeHtml(projectName)}. Reply to this email if you have any questions.`,
    }),
  });
}

module.exports = { sendMail, verifyTransport, sendPayrollReady, sendLeaveUpdate, sendProfileReviewUpdate, sendAppraisalUpdate, sendProjectAssigned, sendTaskAssigned, sendTaskReminder, sendPasswordReset, sendAdminPasswordReset, sendStageAdvance, sendUserInvite, sendPortalInvite, sendPortalLoginCode, sendEmailChangeCode, sendDocumentReviewLink, sendDocumentRemind, sendInvoiceEmail, sendClientRequestForm, sendClientRequestReminder };
