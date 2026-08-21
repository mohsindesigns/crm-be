const { v4: uuidv4 } = require('uuid');
const db = require('../models');
const { isTruthy } = require('./SoftDeleteService');
const { ensureExampleTemplates } = require('../seeders/documentTemplateDefaults');
const { sanitizeDocumentHtml } = require('../utils/htmlSanitizer');

// service_fragment bodies stay plain {{token}} text (rendered inside
// {{services_block}}, never through the rich-text HTML path) — only the
// standalone document types are authored in the rich-text editor.
function sanitizeIfHtmlType(type, value) {
  if (!value) return value;
  return type === 'service_fragment' ? value : sanitizeDocumentHtml(value);
}

class DocumentTemplateService {
  async list(orgId, query = {}) {
    // First visit installs the starter quotation / agreement / proposal examples
    // (idempotent) so admins can see the correct {{token}} layout immediately.
    await ensureExampleTemplates(orgId, db.DocumentTemplate);

    const where = { orgId };
    // Deactivated templates are hidden unless explicitly asked for.
    if (!isTruthy(query.includeInactive)) where.isActive = true;
    if (query.type) where.type = query.type;
    if (query.serviceTypeKey) where.serviceTypeKey = query.serviceTypeKey;
    return db.DocumentTemplate.findAll({ where, order: [['name', 'ASC']] });
  }

  async findById(id, orgId) {
    const template = await db.DocumentTemplate.findOne({ where: { id, orgId } });
    if (!template) {
      const err = new Error('Document template not found.');
      err.status = 404;
      throw err;
    }
    return template;
  }

  async create(orgId, data) {
    if (!data.name || !data.body || !data.type || !data.serviceTypeKey) {
      const err = new Error('type, serviceTypeKey, name, and body are required.');
      err.status = 422;
      throw err;
    }
    return db.DocumentTemplate.create({
      id: uuidv4(),
      orgId,
      type: data.type,
      serviceTypeKey: data.serviceTypeKey,
      name: data.name,
      body: sanitizeIfHtmlType(data.type, data.body),
      defaultTerms: data.defaultTerms ? sanitizeIfHtmlType(data.type, data.defaultTerms) : null,
      isActive: data.isActive ?? true,
    });
  }

  async update(id, orgId, data) {
    const template = await this.findById(id, orgId);
    const type = data.type ?? template.type;
    await template.update({
      type,
      serviceTypeKey: data.serviceTypeKey ?? template.serviceTypeKey,
      name: data.name ?? template.name,
      body: data.body !== undefined ? sanitizeIfHtmlType(type, data.body) : template.body,
      defaultTerms: data.defaultTerms !== undefined
        ? (data.defaultTerms ? sanitizeIfHtmlType(type, data.defaultTerms) : null)
        : template.defaultTerms,
      isActive: data.isActive ?? template.isActive,
    });
    return template;
  }

  // Deactivates rather than destroys — see services/SoftDeleteService.js. Existing
  // quotations/agreements resolve their template through this row, so it stays;
  // it just stops being offered for new documents.
  async remove(id, orgId, active = false) {
    const template = await this.findById(id, orgId);
    await template.update({ isActive: active });
    return template;
  }
}

module.exports = new DocumentTemplateService();
