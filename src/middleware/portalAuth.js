const jwt = require('jsonwebtoken');
const { Contact, Client } = require('../models');

const portalAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Portal authentication required.' });
  }

  const token = header.slice(7);
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Portal token invalid or expired.' });
  }

  if (payload.type !== 'portal') {
    return res.status(401).json({ message: 'Invalid portal token.' });
  }

  const contact = await Contact.findByPk(payload.sub, {
    include: [{ model: Client, as: 'client' }],
  });

  if (!contact || !contact.portalAccess) {
    return res.status(401).json({ message: 'Portal access revoked or contact not found.' });
  }

  req.portalContact = contact;
  req.portalClientId = contact.clientId;
  req.orgId = contact.client?.orgId;
  next();
};

module.exports = portalAuth;
