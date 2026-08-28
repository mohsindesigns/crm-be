const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const { activeWhere, setActive } = require('./SoftDeleteService');

// Simple CRUD for the "bill to" contacts a Personal invoice is raised
// against — deliberately unrelated to the Client model.
class PersonalContactService {
  async list(orgId, query = {}) {
    const where = { orgId, ...activeWhere(db.PersonalContact, query) };
    if (query.search) {
      where.name = { [Op.like]: `%${query.search}%` };
    }
    return db.PersonalContact.findAll({ where, order: [['name', 'ASC']] });
  }

  async findById(id, orgId) {
    const contact = await db.PersonalContact.findOne({ where: { id, orgId } });
    if (!contact) {
      const err = new Error('Contact not found.');
      err.status = 404;
      throw err;
    }
    return contact;
  }

  async create(orgId, data) {
    if (!data.name || !String(data.name).trim()) {
      const err = new Error('A name is required.');
      err.status = 400;
      throw err;
    }
    return db.PersonalContact.create({
      id: uuidv4(),
      orgId,
      name: data.name.trim(),
      billingName: data.billingName || null,
      billingAddress: data.billingAddress || null,
      contactEmail: data.contactEmail || null,
      contactPhone: data.contactPhone || null,
      defaultCurrency: data.defaultCurrency || 'USD',
    });
  }

  async update(id, orgId, data) {
    const contact = await this.findById(id, orgId);
    const fields = ['name', 'billingName', 'billingAddress', 'contactEmail', 'contactPhone', 'defaultCurrency'];
    const updates = {};
    for (const f of fields) {
      if (data[f] !== undefined) updates[f] = data[f];
    }
    await contact.update(updates);
    return contact;
  }

  async setActive(id, orgId, active) {
    return setActive(db.PersonalContact, { id, orgId }, active, 'Contact not found.');
  }
}

module.exports = new PersonalContactService();
