const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const PublicDocumentService = require('../services/PublicDocumentService');
const { User, Role, CustomerDocument } = require('../models');

// Fully public — no auth/tenancy/rbac. The publicToken in the URL is the only
// credential; every PublicDocumentService method is scoped by it alone.

/** True when a logged-in org teammate (not a portal client) is opening the link. */
async function isStaffPreview(req, documentOrgId) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return false;
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    const user = await User.findByPk(payload.sub, {
      include: [{ model: Role, as: 'role', attributes: ['key'] }],
    });
    if (!user || !user.isActive) return false;
    if (user.orgId !== documentOrgId) return false;
    // Portal clients viewing the review link should still count as a real view.
    if (user.role?.key === 'client') return false;
    return true;
  } catch {
    return false;
  }
}

async function shouldMarkAsViewed(req, token) {
  // Explicit staff/preview mode (e.g. opening from dashboard with ?preview=1).
  if (String(req.query.preview || '') === '1') return false;

  const row = await CustomerDocument.findOne({
    where: { publicToken: token },
    attributes: ['orgId'],
  });
  if (!row) return true; // let getByToken throw 404

  if (await isStaffPreview(req, row.orgId)) return false;
  return true;
}

router.get('/:token', async (req, res, next) => {
  try {
    const markAsViewed = await shouldMarkAsViewed(req, req.params.token);
    res.json(await PublicDocumentService.getByToken(req.params.token, req.ip, { markAsViewed }));
  } catch (err) { next(err); }
});

router.post('/:token/approve', async (req, res, next) => {
  try {
    res.json(await PublicDocumentService.approve(req.params.token, {
      signerName: req.body.signerName,
      selectedPackageId: req.body.selectedPackageId,
      selectionReason: req.body.selectionReason,
      menuSelections: req.body.menuSelections,
      ip: req.ip,
    }));
  } catch (err) { next(err); }
});

// Step two of approval — the client's own billing details. Public for the same
// reason approve is: the token is the credential.
router.post('/:token/details', async (req, res, next) => {
  try {
    res.json(await PublicDocumentService.submitDetails(req.params.token, {
      details: req.body || {},
      ip: req.ip,
    }));
  } catch (err) { next(err); }
});

router.post('/:token/pay', async (req, res, next) => {
  try { res.json(await PublicDocumentService.startPayment(req.params.token)); }
  catch (err) { next(err); }
});

router.post('/:token/reject', async (req, res, next) => {
  try { res.json(await PublicDocumentService.reject(req.params.token, { note: req.body.note, ip: req.ip })); }
  catch (err) { next(err); }
});

router.get('/:token/pdf', async (req, res, next) => {
  try {
    const { buffer, document } = await PublicDocumentService.getPdfBuffer(req.params.token);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${document.number}.pdf"`);
    // Review page (frontend) embeds this PDF in an iframe — helmet's default
    // SAMEORIGIN / CORP:same-origin would blank the preview across ports/hosts.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.removeHeader('X-Frame-Options');
    res.send(buffer);
  } catch (err) { next(err); }
});

module.exports = router;
