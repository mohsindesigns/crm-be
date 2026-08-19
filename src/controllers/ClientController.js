const { body } = require('express-validator');
const ClientService = require('../services/ClientService');
const EmailService = require('../services/EmailService');
const validate = require('../middleware/validate');
const { isTruthy } = require('../services/SoftDeleteService');

const PORTAL_URL = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/portal/login`;
const BRAND_NAME = process.env.SEED_BRAND_NAME || 'Mohsin Designs Project Management';

class ClientController {
  createValidators() {
    return [
      body('name').trim().notEmpty(),
      body('status').optional().isIn(['active', 'paused', 'churned']),
      body('defaultCurrency').optional().isLength({ min: 3, max: 10 }),
    ];
  }

  async list(req, res, next) {
    try {
      res.json(await ClientService.list(req.orgId, req.query));
    } catch (err) { next(err); }
  }

  async getOne(req, res, next) {
    try {
      const client = await ClientService.findById(req.params.id, req.orgId, {
        includeInactiveContacts: isTruthy(req.query.includeInactive),
      });
      const billingCompany = await ClientService.resolveBillingCompany(client, req.orgId);
      res.json({ ...client.toJSON(), billingCompany });
    } catch (err) { next(err); }
  }

  async create(req, res, next) {
    try {
      const client = await ClientService.create(req.orgId, req.body, req.user.id);
      res.status(201).json(client);
    } catch (err) { next(err); }
  }

  async update(req, res, next) {
    try {
      res.json(await ClientService.update(req.params.id, req.orgId, req.body));
    } catch (err) { next(err); }
  }

  async setBillingMode(req, res, next) {
    try {
      res.json(await ClientService.setBillingMode(req.params.id, req.orgId, req.body?.billingMode));
    } catch (err) { next(err); }
  }

  async setChargeCardFee(req, res, next) {
    try {
      res.json(await ClientService.setChargeCardFee(req.params.id, req.orgId, req.body?.chargeCardFee));
    } catch (err) { next(err); }
  }

  // Deactivates, never destroys — see services/SoftDeleteService.js.
  async remove(req, res, next) {
    try {
      const client = await ClientService.remove(req.params.id, req.orgId, false);
      res.json({ message: 'Client set to Inactive.', client });
    } catch (err) { next(err); }
  }

  async activate(req, res, next) {
    try {
      const client = await ClientService.remove(req.params.id, req.orgId, true);
      res.json({ message: 'Client set to Active.', client });
    } catch (err) { next(err); }
  }

  async addContact(req, res, next) {
    try {
      const contact = await ClientService.addContact(req.params.id, req.orgId, req.body);
      if (contact.portalAccess && contact.email) {
        EmailService.sendPortalInvite(contact.email, contact.name, BRAND_NAME, PORTAL_URL).catch(() => {});
      }
      res.status(201).json(contact);
    } catch (err) { next(err); }
  }

  async updateContact(req, res, next) {
    try {
      const prev = await ClientService.getContact(req.params.contactId, req.params.id, req.orgId);
      const contact = await ClientService.updateContact(req.params.contactId, req.params.id, req.orgId, req.body);
      if (!prev.portalAccess && contact.portalAccess && contact.email) {
        EmailService.sendPortalInvite(contact.email, contact.name, BRAND_NAME, PORTAL_URL).catch(() => {});
      }
      res.json(contact);
    } catch (err) { next(err); }
  }

  async removeContact(req, res, next) {
    try {
      const contact = await ClientService.removeContact(req.params.contactId, req.params.id, req.orgId, false);
      res.json({ message: 'Contact set to Inactive.', contact });
    } catch (err) { next(err); }
  }

  async activateContact(req, res, next) {
    try {
      const contact = await ClientService.removeContact(req.params.contactId, req.params.id, req.orgId, true);
      res.json({ message: 'Contact set to Active.', contact });
    } catch (err) { next(err); }
  }

  async listSoldPackages(req, res, next) {
    try {
      res.json(await ClientService.listSoldPackages(req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async listSellablePackages(req, res, next) {
    try {
      res.json(await ClientService.listSellablePackages(req.orgId));
    } catch (err) { next(err); }
  }

  async sellPackage(req, res, next) {
    try {
      const result = await ClientService.sellPackage(req.params.id, req.orgId, req.body, req.user.id);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async sellPackages(req, res, next) {
    try {
      const result = await ClientService.sellPackages(req.params.id, req.orgId, req.body, req.user.id);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async cancelClientPackage(req, res, next) {
    try {
      res.json(await ClientService.cancelClientPackage(req.params.clientPackageId, req.params.id, req.orgId));
    } catch (err) { next(err); }
  }

  async updateClientPackagePrice(req, res, next) {
    try {
      res.json(await ClientService.updateClientPackagePrice(req.params.clientPackageId, req.params.id, req.orgId, req.body.price));
    } catch (err) { next(err); }
  }
}

module.exports = new ClientController();
