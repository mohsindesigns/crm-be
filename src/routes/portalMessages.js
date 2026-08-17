const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const router = express.Router();
const portalAuth = require('../middleware/portalAuth');
const ChatService = require('../services/ChatService');
const MediaService = require('../services/MediaService');

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (req, file, cb) => cb(null, `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
});

function actorFromPortal(req) {
  return {
    userId: null,
    contactId: req.portalContact.id,
    isOrgAdmin: false,
  };
}

router.use(portalAuth);

/** Chat attachment upload for portal members (CRM /media requires employee auth). */
router.post('/upload', upload.single('file'), async (req, res, next) => {
  const tmpPath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded.' });
    const stream = fs.createReadStream(tmpPath);
    const result = await MediaService.upload(stream, req.file.originalname, req.file.mimetype);
    fs.unlink(tmpPath, () => {});
    res.status(201).json({
      url: result.url,
      fileUrl: result.url,
      mimeType: req.file.mimetype,
      fileName: req.file.originalname,
    });
  } catch (e) {
    if (tmpPath) fs.unlink(tmpPath, () => {});
    next(e);
  }
});

router.get('/rooms', async (req, res, next) => {
  try {
    // Only rooms this contact has been explicitly added to. The client is never
    // auto-joined — an admin invites them, deliberately.
    const rooms = await ChatService.listRoomsForContact(
      req.orgId,
      req.portalContact.id,
      req.portalClientId
    );
    res.json(rooms);
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/messages', async (req, res, next) => {
  try {
    await ChatService.assertRoomAccess(req.params.roomId, req.orgId, actorFromPortal(req));
    const messages = await ChatService.listMessages(req.params.roomId, {
      before: req.query.before || null,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json(messages);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/messages', async (req, res, next) => {
  try {
    const message = await ChatService.sendMessage(
      req.params.roomId,
      req.orgId,
      actorFromPortal(req),
      { body: req.body.body, attachments: req.body.attachments }
    );
    const io = req.app.get('io');
    const payload = message?.toJSON ? message.toJSON() : message;
    if (io) io.to(`room:${req.params.roomId}`).emit('message:new', payload);
    res.status(201).json(payload);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/read', async (req, res, next) => {
  try {
    res.json(await ChatService.markRead(req.params.roomId, req.orgId, actorFromPortal(req)));
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/members', async (req, res, next) => {
  try {
    res.json(await ChatService.listMembers(req.params.roomId, req.orgId, actorFromPortal(req)));
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/mentions', async (req, res, next) => {
  try {
    res.json(await ChatService.mentionCandidates(req.params.roomId, req.orgId, actorFromPortal(req)));
  } catch (e) { next(e); }
});

module.exports = router;
