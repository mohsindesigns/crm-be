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

  async send(req, res, next) {
    try {
      const result = await ClientRequestService.send(
        req.params.projectId,
        req.orgId,
        req.body,
        req.user.id,
      );
      // 201 either way — the request row exists and its link is live. `emailSent`
      // is how the UI knows to warn that SMTP didn't deliver it (unconfigured
      // SMTP_USER in dev, or a rejected send) and to offer the link for manual
      // sharing instead of silently claiming success.
      res.status(201).json({
        ...result,
        message: result.emailSent
          ? 'Requirements form sent to the client.'
          : 'Request created, but the email could not be sent — share the link manually.',
      });
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
