const jwt = require('jsonwebtoken');
const { User, Role, Worker } = require('../models');

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required.' });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Token invalid or expired.' });
  }

  const user = await User.findByPk(payload.sub, {
    include: [{ model: Role, as: 'role' }],
  });

  if (!user || !user.isActive) {
    return res.status(401).json({ message: 'Account not found or inactive.' });
  }

  const roleKey = user.role?.key;
  if (!['super_admin', 'admin'].includes(roleKey)) {
    const worker = await Worker.findOne({
      where: { userId: user.id, orgId: user.orgId },
      attributes: ['status'],
    });
    if (worker?.status === 'inactive') {
      return res.status(403).json({
        message: 'Your employee account is inactive. Contact your administrator.',
      });
    }
  }

  req.user = user;
  req.orgId = user.orgId;
  next();
};

module.exports = auth;
