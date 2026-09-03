const { Op } = require('sequelize');
const { createPdfBuffer, drawTable } = require('./PdfService');
const { letterheadForOrg, drawPdfKitLetterhead } = require('./letterhead');
const { formatPeriod } = require('../utils/formatPeriod');
const { PayrollItem, PayrollRun, Worker, User } = require('../models');

function fmtDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * One row per payroll month within [from, to] ('YYYY-MM' period strings,
 * inclusive) that this worker has a PayrollItem for. Meant for the worker's
 * own tax filing, not internal payroll review, so it only carries identity +
 * the bare figures a filer needs — not the earnings/deductions breakdown a
 * salary slip has. Payment Date is PayrollRun.paidAt (see
 * HrService#advancePayrollStatus) — null until that run actually reaches
 * 'paid', same as a real disbursement not having happened yet.
 */
async function getTaxCertificateData(workerId, orgId, { from, to }) {
  const worker = await Worker.findOne({
    where: { id: workerId, orgId },
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
  });
  if (!worker) throw Object.assign(new Error('Worker not found'), { status: 404 });

  const items = await PayrollItem.findAll({
    where: { workerId },
    include: [{
      model: PayrollRun,
      as: 'run',
      where: { orgId, period: { [Op.gte]: from, [Op.lte]: to } },
      attributes: ['id', 'period', 'paidAt', 'status', 'cprNumber'],
      required: true,
    }],
  });
  items.sort((a, b) => a.run.period.localeCompare(b.run.period));

  // CPR No is the tax authority's deposit receipt for THAT MONTH's withheld
  // tax (PayrollRun.cprNumber) — it varies run to run, not a fixed per-
  // employee identifier, so each row reads it off its own run.
  const rows = items.map((item, i) => ({
    srNo: i + 1,
    cprNumber: item.run.cprNumber || '',
    month: formatPeriod(item.run.period),
    salary: Number(item.computedGross) || 0,
    tax: Number(item.taxAmount) || 0,
    paymentDate: fmtDate(item.run.paidAt),
  }));

  return { worker, rows };
}

async function generateTaxCertificatePdf(workerId, orgId, { from, to }) {
  const { worker, rows } = await getTaxCertificateData(workerId, orgId, { from, to });
  const letterhead = await letterheadForOrg(orgId, 'hr');

  const buffer = await createPdfBuffer((doc) => {
    drawPdfKitLetterhead(doc, letterhead, {
      title: 'TAX CERTIFICATE',
      subtitle: `${worker.user?.name || 'Employee'} — ${formatPeriod(from)} to ${formatPeriod(to)}`,
    });
    doc.moveDown(1);
    if (!rows.length) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#999999').text('No payroll records in this period.');
    } else {
      drawTable(doc, {
        columns: [
          { label: 'Sr No', key: 'srNo', width: 6, align: 'right' },
          { label: 'CPR No', key: 'cprNumber', width: 14 },
          { label: 'Month', key: 'month', width: 12 },
          { label: 'Salary', key: 'salary', width: 10, align: 'right' },
          { label: 'Tax', key: 'tax', width: 10, align: 'right' },
          { label: 'Payment Date', key: 'paymentDate', width: 12 },
        ],
        rows: rows.map((r) => ({
          ...r,
          salary: Number(r.salary).toLocaleString(),
          tax: Number(r.tax).toLocaleString(),
          paymentDate: r.paymentDate || 'Not yet paid',
        })),
      });
    }
  });

  return { buffer, worker };
}

function generateTaxCertificateCsv(rows) {
  const headers = ['Sr No', 'CPR No', 'Month', 'Salary', 'Tax', 'Payment Date'];
  const lines = [headers, ...rows.map((r) => [
    r.srNo, r.cprNumber, r.month, r.salary, r.tax, r.paymentDate || 'Not yet paid',
  ])];
  return lines.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

module.exports = { getTaxCertificateData, generateTaxCertificatePdf, generateTaxCertificateCsv };
