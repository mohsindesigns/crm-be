const ExportService = require('../services/ExportService');

class ExportController {
  /** Column catalog + presets for the employees dataset (drives the field picker). */
  async employeeSchema(req, res, next) {
    try {
      res.json(ExportService.getEmployeeSchema());
    } catch (err) {
      next(err);
    }
  }

  async listEmployees(req, res, next) {
    try {
      const { search, department, status, workerType } = req.query;
      res.json(await ExportService.listEmployees(req.orgId, { search, department, status, workerType }));
    } catch (err) {
      next(err);
    }
  }

  async employeeFilters(req, res, next) {
    try {
      res.json(await ExportService.listEmployeeFilters(req.orgId));
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST, not GET — the verb is what puts this in the Activity Log (see
   * middleware/activityLogger), and the selection can be a few hundred worker
   * ids, which does not belong in a query string.
   */
  async exportEmployees(req, res, next) {
    try {
      const { workerIds, fields } = req.body || {};
      const { csv, filename } = await ExportService.exportEmployees(req.orgId, { workerIds, fields });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      // The frontend reads the filename off this header; without the expose it
      // is invisible to the browser on a cross-origin (dev proxy) response.
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.send(csv);
    } catch (err) {
      next(err);
    }
  }

  /** Same selection/columns as exportEmployees, written as an .xlsx workbook. */
  async exportEmployeesXlsx(req, res, next) {
    try {
      const { workerIds, fields } = req.body || {};
      const { buffer, filename } = await ExportService.exportEmployeesXlsx(req.orgId, { workerIds, fields });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  }

  async listTemplates(req, res, next) {
    try {
      res.json(await ExportService.listTemplates(req.orgId, req.query));
    } catch (err) {
      next(err);
    }
  }

  async createTemplate(req, res, next) {
    try {
      res.status(201).json(await ExportService.createTemplate(req.orgId, req.user.id, req.body));
    } catch (err) {
      next(err);
    }
  }

  async updateTemplate(req, res, next) {
    try {
      res.json(await ExportService.updateTemplate(req.params.id, req.orgId, req.body));
    } catch (err) {
      next(err);
    }
  }

  async removeTemplate(req, res, next) {
    try {
      res.json(await ExportService.setTemplateActive(req.params.id, req.orgId, false));
    } catch (err) {
      next(err);
    }
  }

  async activateTemplate(req, res, next) {
    try {
      res.json(await ExportService.setTemplateActive(req.params.id, req.orgId, true));
    } catch (err) {
      next(err);
    }
  }
}

module.exports = new ExportController();
