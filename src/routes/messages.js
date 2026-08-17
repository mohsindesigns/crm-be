const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const tenancy = require('../middleware/tenancy');
const rbac = require('../middleware/rbac');
const ChatService = require('../services/ChatService');

function isOrgAdmin(user) {
  return ['super_admin', 'admin'].includes(user?.role?.key)
    || !!user?.role?.permissions?.['admin.access'];
}

/**
 * Strictly the super_admin role — narrower than isOrgAdmin on purpose.
 * Retiring a channel closes the record of an engagement, so it is not something
 * a plain admin, a room admin, or the person who created the room may do.
 */
function isSuperAdmin(user) {
  return user?.role?.key === 'super_admin';
}

function actorFromReq(req) {
  return {
    userId: req.user.id,
    contactId: null,
    isOrgAdmin: isOrgAdmin(req.user),
    isSuperAdmin: isSuperAdmin(req.user),
  };
}

router.use(auth, tenancy);

router.get('/rooms', rbac('projects.read'), async (req, res, next) => {
  try {
    const rooms = await ChatService.listRoomsForUser(req.orgId, req.user.id, isOrgAdmin(req.user), {
      // active | inactive | all — the sidebar filter. Defaults to active so a
      // retired channel doesn't clutter the list, but never disappears.
      status: req.query.status || 'active',
      isSuperAdmin: isSuperAdmin(req.user),
    });
    res.json(rooms);
  } catch (e) { next(e); }
});

/** Create a custom group room (name + optional member userIds). */
router.post('/rooms', rbac('projects.read'), async (req, res, next) => {
  try {
    const room = await ChatService.createGroupRoom(req.orgId, actorFromReq(req), {
      name: req.body.name,
      userIds: req.body.userIds || [],
    });
    res.status(201).json(room);
  } catch (e) { next(e); }
});

/** Open or reuse a 1:1 DM with another org user. */
router.post('/dms', rbac('projects.read'), async (req, res, next) => {
  try {
    const room = await ChatService.openDm(req.orgId, req.user.id, req.body.userId);
    res.status(201).json(room);
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/messages', rbac('projects.read'), async (req, res, next) => {
  try {
    await ChatService.assertRoomAccess(req.params.roomId, req.orgId, actorFromReq(req));
    const messages = await ChatService.listMessages(req.params.roomId, {
      before: req.query.before || null,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.json(messages);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/messages', rbac('projects.read'), async (req, res, next) => {
  try {
    const message = await ChatService.sendMessage(
      req.params.roomId,
      req.orgId,
      actorFromReq(req),
      {
        body: req.body.body,
        attachments: req.body.attachments,
        parentMessageId: req.body.parentMessageId || null,
      }
    );
    // Broadcast if socket hub is attached.
    const io = req.app.get('io');
    const payload = message?.toJSON ? message.toJSON() : message;
    if (io) {
      io.to(`room:${req.params.roomId}`).emit('message:new', payload);
      // Same desktop fan-out the socket path does, so a message sent over REST
      // (socket down, or a slow ack falling back) still notifies people.
      const room = await ChatService.roomForNotification(req.params.roomId);
      if (room) {
        const recipients = await ChatService.notificationRecipients(room, message, actorFromReq(req));
        for (const r of recipients) {
          const note = ChatService.notificationPayload(room, message, { isMentioned: r.isMentioned });
          if (r.userId) io.to(`user:${r.userId}`).emit('notify:message', note);
          if (r.contactId) io.to(`contact:${r.contactId}`).emit('notify:message', note);
        }
      }
    }
    res.status(201).json(payload);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/read', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.markRead(req.params.roomId, req.orgId, actorFromReq(req)));
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/members', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.listMembers(req.params.roomId, req.orgId, actorFromReq(req)));
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/mentions', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.mentionCandidates(req.params.roomId, req.orgId, actorFromReq(req)));
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/members', rbac('projects.read'), async (req, res, next) => {
  try {
    const member = await ChatService.addMember(req.params.roomId, req.orgId, actorFromReq(req), {
      userId: req.body.userId || null,
      contactId: req.body.contactId || null,
    });
    res.status(201).json(member);
  } catch (e) { next(e); }
});

router.delete('/rooms/:roomId/members/:memberId', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.removeMember(
      req.params.roomId,
      req.orgId,
      actorFromReq(req),
      req.params.memberId
    ));
  } catch (e) { next(e); }
});

/** Add several people at once — explicit ids, a whole role, or a department. */
router.post('/rooms/:roomId/members/bulk', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.addMembersBulk(req.params.roomId, req.orgId, actorFromReq(req), {
      userIds: req.body.userIds || [],
      roleKey: req.body.roleKey || null,
      department: req.body.department || null,
    }));
  } catch (e) { next(e); }
});

// ─── Room lifecycle & settings ────────────────────────────────────────────────

/**
 * Activate / deactivate. There is deliberately no DELETE for a room anywhere in
 * this API — a channel is the record of what was agreed, so it is retired, not
 * destroyed. See ChatService.setRoomActive.
 */
router.post('/rooms/:roomId/active', rbac('projects.read'), async (req, res, next) => {
  try {
    const room = await ChatService.setRoomActive(
      req.params.roomId, req.orgId, actorFromReq(req), !!req.body.active,
    );
    const io = req.app.get('io');
    if (io) io.to(`room:${req.params.roomId}`).emit('room:updated', room);
    res.json(room);
  } catch (e) { next(e); }
});

router.patch('/rooms/:roomId', rbac('projects.read'), async (req, res, next) => {
  try {
    const room = await ChatService.updateRoomSettings(
      req.params.roomId, req.orgId, actorFromReq(req), req.body,
    );
    const io = req.app.get('io');
    if (io) io.to(`room:${req.params.roomId}`).emit('room:updated', room);
    res.json(room);
  } catch (e) { next(e); }
});

/** Admin audit trail for the room's activity panel. */
router.get('/rooms/:roomId/events', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.roomEvents(req.params.roomId, req.orgId, actorFromReq(req), {
      limit: parseInt(req.query.limit, 10) || 50,
    }));
  } catch (e) { next(e); }
});

// ─── Message actions ──────────────────────────────────────────────────────────

router.patch('/rooms/:roomId/messages/:messageId', rbac('projects.read'), async (req, res, next) => {
  try {
    const message = await ChatService.editMessage(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId, req.body.body,
    );
    const payload = message?.toJSON ? message.toJSON() : message;
    const io = req.app.get('io');
    if (io) io.to(`room:${req.params.roomId}`).emit('message:updated', payload);
    res.json(payload);
  } catch (e) { next(e); }
});

router.delete('/rooms/:roomId/messages/:messageId', rbac('projects.read'), async (req, res, next) => {
  try {
    const message = await ChatService.deleteMessage(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId,
    );
    const payload = message?.toJSON ? message.toJSON() : message;
    const io = req.app.get('io');
    if (io) io.to(`room:${req.params.roomId}`).emit('message:updated', payload);
    res.json(payload);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/messages/:messageId/reactions', rbac('projects.read'), async (req, res, next) => {
  try {
    const reactions = await ChatService.toggleReaction(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId, req.body.emoji,
    );
    const io = req.app.get('io');
    if (io) {
      io.to(`room:${req.params.roomId}`).emit('message:reactions', {
        messageId: req.params.messageId, reactions,
      });
    }
    res.json(reactions);
  } catch (e) { next(e); }
});

router.post('/rooms/:roomId/messages/:messageId/pin', rbac('projects.read'), async (req, res, next) => {
  try {
    const message = await ChatService.setPinned(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId, !!req.body.pinned,
    );
    const payload = message?.toJSON ? message.toJSON() : message;
    const io = req.app.get('io');
    if (io) io.to(`room:${req.params.roomId}`).emit('message:updated', payload);
    res.json(payload);
  } catch (e) { next(e); }
});

router.get('/rooms/:roomId/pinned', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.listPinned(req.params.roomId, req.orgId, actorFromReq(req)));
  } catch (e) { next(e); }
});

/** One thread: the parent message plus its replies. */
router.get('/rooms/:roomId/messages/:messageId/thread', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.listThread(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId,
    ));
  } catch (e) { next(e); }
});

/** Who has read up to a message (or up to now, if none given). */
router.get('/rooms/:roomId/receipts', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.readReceipts(
      req.params.roomId, req.orgId, actorFromReq(req), req.query.messageId || null,
    ));
  } catch (e) { next(e); }
});

/** Every attachment posted in the room. */
router.get('/rooms/:roomId/files', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.listFiles(req.params.roomId, req.orgId, actorFromReq(req)));
  } catch (e) { next(e); }
});

// ─── Search ───────────────────────────────────────────────────────────────────

router.get('/search', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.searchMessages(req.orgId, actorFromReq(req), {
      q: req.query.q,
      roomId: req.query.roomId || null,
      limit: parseInt(req.query.limit, 10) || 40,
    }));
  } catch (e) { next(e); }
});

// ─── Per-member preferences ───────────────────────────────────────────────────

router.put('/rooms/:roomId/notify', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.setNotifyLevel(
      req.params.roomId, req.orgId, actorFromReq(req), req.body.level,
    ));
  } catch (e) { next(e); }
});

router.put('/rooms/:roomId/favorite', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.setFavorite(
      req.params.roomId, req.orgId, actorFromReq(req), !!req.body.favorite,
    ));
  } catch (e) { next(e); }
});

router.put('/rooms/:roomId/draft', rbac('projects.read'), async (req, res, next) => {
  try {
    res.json(await ChatService.saveDraft(
      req.params.roomId, req.orgId, actorFromReq(req), req.body.draft,
    ));
  } catch (e) { next(e); }
});

// ─── Compliance ───────────────────────────────────────────────────────────────

router.get('/rooms/:roomId/export', rbac('projects.read'), async (req, res, next) => {
  try {
    const { csv, filename } = await ChatService.exportTranscript(
      req.params.roomId, req.orgId, actorFromReq(req),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    // BOM so Excel opens the file as UTF-8 rather than mangling non-ASCII names.
    res.send(`﻿${csv}`);
  } catch (e) { next(e); }
});

/** Turn a message into a task on one of the client's projects. */
router.post('/rooms/:roomId/messages/:messageId/task', rbac('projects.read'), async (req, res, next) => {
  try {
    const task = await ChatService.createTaskFromMessage(
      req.params.roomId, req.orgId, actorFromReq(req), req.params.messageId, {
        projectId: req.body.projectId,
        title: req.body.title,
        assigneeId: req.body.assigneeId || null,
        dueDate: req.body.dueDate || req.body.dueAt || null,
        remarks: req.body.remarks || '',
      },
    );
    res.status(201).json(task);
  } catch (e) { next(e); }
});

module.exports = router;
