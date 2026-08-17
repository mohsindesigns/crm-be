const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const db = require('../models');

router.use(auth, tenancy);

router.get('/', async (req, res, next) => {
  try {
    const notifications = await db.Notification.findAll({
      where: { recipientId: req.user.id, orgId: req.orgId },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });
    res.json(notifications);
  } catch (err) { next(err); }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    const n = await db.Notification.findOne({ where: { id: req.params.id, recipientId: req.user.id } });
    if (!n) return res.status(404).json({ message: 'Notification not found.' });
    await n.update({ isRead: true, readAt: new Date() });
    res.json(n);
  } catch (err) { next(err); }
});

router.post('/mark-all-read', async (req, res, next) => {
  try {
    await db.Notification.update(
      { isRead: true, readAt: new Date() },
      { where: { recipientId: req.user.id, orgId: req.orgId, isRead: false } }
    );
    res.json({ message: 'All notifications marked as read.' });
  } catch (err) { next(err); }
});

module.exports = router;
