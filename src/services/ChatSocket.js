/**
 * Socket.IO hub for Messages.
 *
 * Nginx (VPS) — proxy WebSockets to this Node process:
 *   location /socket.io/ {
 *     proxy_pass http://127.0.0.1:4000;
 *     proxy_http_version 1.1;
 *     proxy_set_header Upgrade $http_upgrade;
 *     proxy_set_header Connection "upgrade";
 *     proxy_set_header Host $host;
 *   }
 */
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('../models');
const ChatService = require('./ChatService');

function isOrgAdmin(user) {
  return ['super_admin', 'admin'].includes(user?.role?.key)
    || !!user?.role?.permissions?.['admin.access'];
}

async function resolveHandshake(socket) {
  const token = socket.handshake.auth?.token
    || (socket.handshake.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    const err = new Error('Authentication required.');
    err.data = { status: 401 };
    throw err;
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Token invalid or expired.');
    err.data = { status: 401 };
    throw err;
  }

  if (payload.type === 'portal') {
    const contact = await db.Contact.findByPk(payload.sub, {
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'orgId', 'name'] }],
    });
    if (!contact || !contact.portalAccess || !contact.client) {
      const err = new Error('Portal access revoked.');
      err.data = { status: 401 };
      throw err;
    }
    return {
      kind: 'portal',
      contactId: contact.id,
      userId: null,
      orgId: contact.client.orgId,
      clientId: contact.clientId,
      isOrgAdmin: false,
      name: contact.name,
    };
  }

  const user = await db.User.findByPk(payload.sub, {
    include: [{ model: db.Role, as: 'role' }],
  });
  if (!user || !user.isActive) {
    const err = new Error('Account not found.');
    err.data = { status: 401 };
    throw err;
  }
  return {
    kind: 'user',
    userId: user.id,
    contactId: null,
    orgId: user.orgId,
    clientId: null,
    isOrgAdmin: isOrgAdmin(user),
    name: user.name,
  };
}

/**
 * Fan a new message out to the personal channels of members who should be
 * alerted, so they get a desktop notification wherever they are in the app.
 *
 * Never throws: a failed notification must not fail the message that triggered
 * it — the message is already saved and broadcast by the time this runs.
 */
async function emitDesktopNotifications(io, roomId, actor, message) {
  try {
    const room = await db.ChatRoom.findByPk(roomId, {
      attributes: ['id', 'name', 'roomType', 'orgId'],
    });
    if (!room) return;

    const full = await ChatService.getMessageById(message.id);
    const recipients = await ChatService.notificationRecipients(room, full || message, actor);

    for (const r of recipients) {
      const payload = ChatService.notificationPayload(room, full || message, { isMentioned: r.isMentioned });
      if (r.userId) io.to(`user:${r.userId}`).emit('notify:message', payload);
      if (r.contactId) io.to(`contact:${r.contactId}`).emit('notify:message', payload);
    }
  } catch (err) {
    console.error('[ChatSocket] desktop notification fan-out failed:', err.message);
  }
}

function attachChatSocket(httpServer, { corsOrigin } = {}) {
  const io = new Server(httpServer, {
    path: '/socket.io',
    cors: {
      origin: corsOrigin || process.env.FRONTEND_URL || 'http://localhost:3000',
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      socket.data.actor = await resolveHandshake(socket);
      next();
    } catch (err) {
      next(err);
    }
  });

  /**
   * Presence.
   *
   * Held in memory rather than in the database on purpose: it is worthless the
   * moment the process restarts, and writing an online/offline row per socket
   * event would be a lot of churn for information that is only ever a hint. A
   * user counts as online while they hold at least one socket, so opening a
   * second tab and closing it doesn't make them blink offline.
   */
  const onlineByOrg = new Map(); // orgId -> Map(userId -> socket count)

  function presenceFor(orgId) {
    return [...(onlineByOrg.get(orgId)?.keys() || [])];
  }

  function markOnline(orgId, userId) {
    if (!orgId || !userId) return false;
    if (!onlineByOrg.has(orgId)) onlineByOrg.set(orgId, new Map());
    const counts = onlineByOrg.get(orgId);
    const next = (counts.get(userId) || 0) + 1;
    counts.set(userId, next);
    return next === 1; // first socket → they just came online
  }

  function markOffline(orgId, userId) {
    const counts = onlineByOrg.get(orgId);
    if (!counts) return false;
    const next = (counts.get(userId) || 0) - 1;
    if (next > 0) {
      counts.set(userId, next);
      return false;
    }
    counts.delete(userId);
    if (!counts.size) onlineByOrg.delete(orgId);
    return true; // last socket closed → offline
  }

  /**
   * Persist "last seen" for the WhatsApp-style line shown when someone is offline.
   *
   * Fire-and-forget: presence is a hint, and a failed write must never take down
   * a socket handler. Errors are swallowed deliberately.
   */
  function touchLastSeen(userId) {
    if (!userId) return;
    db.User.update({ lastSeenAt: new Date() }, { where: { id: userId } }).catch(() => {});
  }

  /**
   * Refresh it periodically while connected, not only on disconnect. A browser
   * killed, a laptop closed or the process crashing never fires `disconnect`, so
   * a disconnect-only stamp can leave someone reading "last seen" hours stale —
   * or, for a user who has never cleanly disconnected, blank forever.
   *
   * Five minutes: the label is rendered as a relative time, so this is well
   * inside the resolution anyone actually reads.
   */
  const LAST_SEEN_HEARTBEAT_MS = 5 * 60 * 1000;

  io.on('connection', (socket) => {
    const actor = socket.data.actor;

    // Everyone in an org shares a room, so presence and room-level changes can
    // be pushed without knowing which channels each person has open.
    if (actor.orgId) socket.join(`org:${actor.orgId}`);
    // A personal channel, so a desktop notification can reach someone who is
    // anywhere in the app — not only those who have that conversation open.
    if (actor.userId) socket.join(`user:${actor.userId}`);
    if (actor.contactId) socket.join(`contact:${actor.contactId}`);

    if (markOnline(actor.orgId, actor.userId)) {
      socket.to(`org:${actor.orgId}`).emit('presence:online', { userId: actor.userId });
    }
    socket.emit('presence:list', { online: presenceFor(actor.orgId) });
    touchLastSeen(actor.userId);

    const lastSeenTimer = setInterval(() => touchLastSeen(actor.userId), LAST_SEEN_HEARTBEAT_MS);

    socket.on('presence:get', (_payload, ack) => {
      if (typeof ack === 'function') ack({ online: presenceFor(actor.orgId) });
    });

    socket.on('disconnect', () => {
      clearInterval(lastSeenTimer);
      // Stamped for everyone, not just the last socket to close — this is when
      // the person was last connected regardless of how many tabs they had.
      touchLastSeen(actor.userId);
      if (markOffline(actor.orgId, actor.userId)) {
        // Carry the timestamp on the event so other clients can switch straight
        // to "last seen …" without waiting for a refetch.
        socket.to(`org:${actor.orgId}`).emit('presence:offline', {
          userId: actor.userId,
          lastSeenAt: new Date().toISOString(),
        });
      }
    });

    socket.on('room:join', async ({ roomId }, ack) => {
      try {
        await ChatService.assertRoomAccess(roomId, actor.orgId, {
          userId: actor.userId,
          contactId: actor.contactId,
          isOrgAdmin: actor.isOrgAdmin,
        });
        socket.join(`room:${roomId}`);
        // Opening a room means the thread is on screen — clear unread.
        await ChatService.markRead(roomId, actor.orgId, {
          userId: actor.userId,
          contactId: actor.contactId,
          isOrgAdmin: actor.isOrgAdmin,
        }).catch(() => {});
        if (typeof ack === 'function') ack({ ok: true });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, message: err.message });
      }
    });

    socket.on('room:leave', ({ roomId }) => {
      if (roomId) socket.leave(`room:${roomId}`);
    });

    socket.on('typing', ({ roomId, isTyping }) => {
      if (!roomId) return;
      socket.to(`room:${roomId}`).emit('typing', {
        roomId,
        isTyping: !!isTyping,
        name: actor.name,
        userId: actor.userId,
        contactId: actor.contactId,
      });
    });

    socket.on('message:send', async (payload, ack) => {
      try {
        const roomId = payload?.roomId;
        if (!roomId) throw Object.assign(new Error('roomId required'), { status: 400 });
        const message = await ChatService.sendMessage(roomId, actor.orgId, {
          userId: actor.userId,
          contactId: actor.contactId,
          isOrgAdmin: actor.isOrgAdmin,
        }, {
          body: payload.body,
          attachments: payload.attachments,
          parentMessageId: payload.parentMessageId || null,
        });
        const payloadOut = message?.toJSON ? message.toJSON() : message;
        io.to(`room:${roomId}`).emit('message:new', payloadOut);
        await emitDesktopNotifications(io, roomId, actor, message);
        if (typeof ack === 'function') ack({ ok: true, message: payloadOut });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, message: err.message });
      }
    });

    socket.on('reaction:toggle', async ({ roomId, messageId, emoji } = {}, ack) => {
      try {
        const reactions = await ChatService.toggleReaction(roomId, actor.orgId, {
          userId: actor.userId,
          contactId: actor.contactId,
          isOrgAdmin: actor.isOrgAdmin,
        }, messageId, emoji);
        io.to(`room:${roomId}`).emit('message:reactions', { messageId, reactions });
        if (typeof ack === 'function') ack({ ok: true, reactions });
      } catch (err) {
        if (typeof ack === 'function') ack({ ok: false, message: err.message });
      }
    });
  });

  return io;
}

module.exports = { attachChatSocket };
