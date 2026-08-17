const CustomerDocumentService = require('../services/CustomerDocumentService');

class DocumentController {
  async list(req, res, next) {
    try { res.json(await CustomerDocumentService.list(req.orgId, req.query)); }
    catch (err) { next(err); }
  }

  async getById(req, res, next) {
    try { res.json(await CustomerDocumentService.findById(req.params.id, req.orgId)); }
    catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const document = await CustomerDocumentService.create(req.orgId, req.user.id, req.body);
      res.status(201).json(document);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try { res.json(await CustomerDocumentService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const document = await CustomerDocumentService.remove(req.params.id, req.orgId, false);
      res.json({ message: 'Document set to Inactive.', document });
    } catch (err) { next(err); }
  }

  async activate(req, res, next) {
    try {
      const document = await CustomerDocumentService.remove(req.params.id, req.orgId, true);
      res.json({ message: 'Document set to Active.', document });
    } catch (err) { next(err); }
  }

  async preview(req, res, next) {
    try { res.json(await CustomerDocumentService.preview(req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async send(req, res, next) {
    try { res.json(await CustomerDocumentService.send(req.params.id, req.orgId, req.user.id)); }
    catch (err) { next(err); }
  }

  async remind(req, res, next) {
    try { res.json(await CustomerDocumentService.remind(req.params.id, req.orgId, req.user.id)); }
    catch (err) { next(err); }
  }

  async convert(req, res, next) {
    try { res.json(await CustomerDocumentService.convert(req.params.id, req.orgId, req.user.id, req.body)); }
    catch (err) { next(err); }
  }

  async pdf(req, res, next) {
    try {
      const { buffer, document } = await CustomerDocumentService.generatePdfBuffer(req.params.id, req.orgId);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${document.number}.pdf"`);
      res.send(buffer);
    } catch (err) { next(err); }
  }
}

module.exports = new DocumentController();
