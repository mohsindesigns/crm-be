const ClientRequestService = require('../services/ClientRequestService');
const { isTruthy } = require('../services/SoftDeleteService');

// Mounted at /api/projects/:projectId/client-requests (staff) — see
// routes/clientRequests.js. Thin: parse, call service, shape response.
class ClientRequestController {
  async list(req, res, next) {
    try {
      res.json(await ClientRequestService.listForProject(req.params.projectId, req.orgId, {
        includeInactive: isTruthy(req.query.includeInactive),
      }));
    } catch (err) { next(err); }
  }

  /** Contacts on this project's client that have an email address — what the
   *  compose screen's "To" dropdown is built from. */
  async recipients(req, res, next) {
    try {
      res.json(await ClientRequestService.recipientOptions(req.params.projectId, req.orgId));
    } catch (err) { next(err); }
  }

  async get(req, res, next) {
    try {
      res.json(await ClientRequestService.findById(req.params.requestId, req.orgId));
    } catch (err) { next(err); }
  }

  /** Compose + submit. Passes the whole `req.user`, not just the id — the
   *  service needs the role to decide whether this send skips the approval
   *  queue (admins) or joins it (everyone else). */
  async send(req, res, next) {
    try {
      const result = await ClientRequestService.send(
        req.params.projectId,
        req.orgId,
        req.body,
        req.user,
      );
      // 201 in all three cases — the row exists. Which of the three it was is
      // what the UI needs to say next: still queued, emailed, or emailed-but-
      // SMTP-refused (unconfigured SMTP_USER in dev, or a rejected send), in
      // which case the link is offered for manual sharing rather than
      // silently claiming success.
      res.status(201).json({
        ...result,
        message: result.status === 'pending_approval'
          ? 'Sent to an admin for approval — the client is emailed once it\'s approved.'
          : result.emailSent
            ? 'Requirements form sent to the client.'
            : 'Approved, but the email could not be sent — share the link manually.',
      });
    } catch (err) { next(err); }
  }

  /** Admin releases a pending request — this is what emails the client. */
  async approve(req, res, next) {
    try {
      const result = await ClientRequestService.approve(req.params.requestId, req.orgId, req.user);
      res.json({
        ...result,
        message: result.emailSent
          ? 'Approved — the requirements form has been emailed to the client.'
          : 'Approved, but the email could not be sent — share the link manually.',
      });
    } catch (err) { next(err); }
  }

  async reject(req, res, next) {
    try {
      const request = await ClientRequestService.reject(
        req.params.requestId,
        req.orgId,
        req.user,
        req.body?.reason,
      );
      res.json({ message: 'Rejected — the sender has been told why. Nothing was emailed to the client.', request });
    } catch (err) { next(err); }
  }

  async remind(req, res, next) {
    try {
      const result = await ClientRequestService.remind(req.params.requestId, req.orgId);
      res.json({
        ...result,
        message: result.emailSent
          ? 'Reminder sent.'
          : 'The reminder email could not be sent — share the link manually.',
      });
    } catch (err) { next(err); }
  }

  async cancel(req, res, next) {
    try {
      const request = await ClientRequestService.cancel(req.params.requestId, req.orgId);
      res.json({ message: 'Request cancelled — the link no longer works.', request });
    } catch (err) { next(err); }
  }
}

module.exports = new ClientRequestController();
