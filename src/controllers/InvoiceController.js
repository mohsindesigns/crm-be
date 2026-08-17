const InvoiceService = require('../services/InvoiceService');

class InvoiceController {
  async list(req, res, next) {
    try { res.json(await InvoiceService.list(req.orgId, req.query)); }
    catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try { res.json(await InvoiceService.findById(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const invoice = await InvoiceService.create(req.orgId, req.body);
      res.status(201).json(invoice);
    } catch (err) { next(err); }
  }

  async updateStatus(req, res, next) {
    try { res.json(await InvoiceService.updateStatus(req.params.id, req.orgId, req.body.status)); }
    catch (err) { next(err); }
  }

  async bulkVoid(req, res, next) {
    try { res.json(await InvoiceService.bulkVoid(req.orgId, req.body.ids)); }
    catch (err) { next(err); }
  }

  async recordPayment(req, res, next) {
    try {
      const payment = await InvoiceService.recordPayment(req.params.id, req.orgId, req.body);
      res.status(201).json(payment);
    } catch (err) { next(err); }
  }

  async pdf(req, res, next) {
    try {
      const { buffer, invoice } = await InvoiceService.generatePdfBuffer(req.params.id, req.orgId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
      // Invoice contents (status, payments, line items) can change between
      // views — never let the browser serve a stale cached copy.
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) { next(err); }
  }

  async syncStripe(req, res, next) {
    try {
      const StripeService = require('../services/StripeService');
      res.json(await StripeService.syncFromStripe(req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async remind(req, res, next) {
    try { res.json(await InvoiceService.sendReminder(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async configurePayment(req, res, next) {
    try {
      res.json(await InvoiceService.configurePaymentProfile(req.params.id, req.orgId, {
        paymentMethodId: req.body.paymentMethodId,
        paymentLinkUrl: req.body.paymentLinkUrl,
      }));
    } catch (err) { next(err); }
  }
}

module.exports = new InvoiceController();
