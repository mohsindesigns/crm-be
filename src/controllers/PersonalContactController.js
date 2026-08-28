const PersonalContactService = require('../services/PersonalContactService');

class PersonalContactController {
  async list(req, res, next) {
    try { res.json(await PersonalContactService.list(req.orgId, req.query)); }
    catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const contact = await PersonalContactService.create(req.orgId, req.body);
      res.status(201).json(contact);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try { res.json(await PersonalContactService.update(req.params.id, req.orgId, req.body)); }
    catch (err) { next(err); }
  }

  async deactivate(req, res, next) {
    try { res.json(await PersonalContactService.setActive(req.params.id, req.orgId, false)); }
    catch (err) { next(err); }
  }

  async reactivate(req, res, next) {
    try { res.json(await PersonalContactService.setActive(req.params.id, req.orgId, true)); }
    catch (err) { next(err); }
  }
}

module.exports = new PersonalContactController();
