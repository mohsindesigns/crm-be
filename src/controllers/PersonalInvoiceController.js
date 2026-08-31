const PersonalInvoiceService = require('../services/PersonalInvoiceService');

class PersonalInvoiceController {
  async list(req, res, next) {
    try { res.json(await PersonalInvoiceService.list(req.orgId, req.query)); }
    catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try { res.json(await PersonalInvoiceService.findById(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const invoice = await PersonalInvoiceService.create(req.orgId, req.body);
      res.status(201).json(invoice);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try { res.json(await PersonalInvoiceService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async updateStatus(req, res, next) {
    try { res.json(await PersonalInvoiceService.updateStatus(req.params.id, req.orgId, req.body.status)); }
    catch (err) { next(err); }
  }

  async bulkVoid(req, res, next) {
    try { res.json(await PersonalInvoiceService.bulkVoid(req.orgId, req.body.ids)); }
    catch (err) { next(err); }
  }

  async recordPayment(req, res, next) {
    try {
      const payment = await PersonalInvoiceService.recordPayment(req.params.id, req.orgId, req.body);
      res.status(201).json(payment);
    } catch (err) { next(err); }
  }

  async pdf(req, res, next) {
    try {
      const { buffer, invoice } = await PersonalInvoiceService.generatePdfBuffer(req.params.id, req.orgId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${invoice.number}.pdf"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(buffer);
    } catch (err) { next(err); }
  }

  async configurePayment(req, res, next) {
    try {
      res.json(await PersonalInvoiceService.configurePaymentProfile(req.params.id, req.orgId, {
        paymentMethodId: req.body.paymentMethodId,
        paymentLinkUrl: req.body.paymentLinkUrl,
        allowPartialPayment: req.body.allowPartialPayment,
        companyId: req.body.companyId,
      }));
    } catch (err) { next(err); }
  }
}

module.exports = new PersonalInvoiceController();
