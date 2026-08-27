const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const db = require('../models');
const NotificationService = require('./NotificationService');

const MENTION_RE = /@\[([^\]]+)\]\((user|contact|all):([0-9a-f-]{36}|all)\)/gi;

function dmKeyFor(userIdA, userIdB) {
  return [userIdA, userIdB].sort().join(':');
}

/** Notification / preview text: `@[Name](user:uuid)` → `@Name` (never expose IDs). */
function mentionPreviewText(text) {
  if (!text) return '';
  return String(text)
    .replace(MENTION_RE, '@$1')
    .replace(/\s+/g, ' ')
    .trim();
}

class ChatService {
  /** Idempotent: one client room per client in the org. */
  async ensureClientRoom(orgId, clientId, actorUserId = null) {
    if (!orgId || !clientId) return null;

    let room = await db.ChatRoom.findOne({ where: { orgId, clientId } });
    if (room) {
      if (room.roomType && room.roomType !== 'client') return room;
      if (!room.roomType) await room.update({ roomType: 'client' }).catch(() => {});
      return room;
    }

    const client = await db.Client.findOne({ where: { id: clientId, orgId }, attributes: ['id', 'name'] });
    if (!client) return null;

    try {
      room = await db.ChatRoom.create({
        id: uuidv4(),
        orgId,
        roomType: 'client',
        clientId,
        dmKey: null,
        name: client.name,
        // A client room exists precisely so the client can take part, so it is
        // shared by definition — and the UI shows its "client can read this"
        // banner from this flag.
        visibility: 'client_shared',
        createdBy: actorUserId || null,
      });
    } catch (err) {
      const existing = await db.ChatRoom.findOne({ where: { orgId, clientId } });
      if (existing) return existing;
      throw err;
    }

    if (actorUserId) {
      await this._upsertUserMember(room.id, actorUserId, 'admin');
    }

    await this.syncProjectAssignees(orgId, clientId);
    // Client contacts are deliberately NOT auto-joined here. Granting portal
    // access lets someone see their invoices and projects; it should not
    // silently drop them into a room the team may already be using for internal
    // discussion. An admin adds them explicitly, which is also the moment the
    // "a client can read this" banner starts showing.
    return room;
  }

  /**
   * Merge duplicate client rooms (same orgId + clientId) that slipped in before the
   * unique index existed. Keeps the room with the most messages (else oldest).
   */
  async dedupeClientRooms(orgId) {
    const rooms = await db.ChatRoom.findAll({
      where: {
        orgId,
        clientId: { [Op.ne]: null },
        [Op.or]: [{ roomType: 'client' }, { roomType: null }],
      },
      attributes: ['id', 'clientId', 'createdAt'],
      order: [['createdAt', 'ASC']],
    });

    const byClient = new Map();
    for (const r of rooms) {
      const list = byClient.get(r.clientId) || [];
      list.push(r);
      byClient.set(r.clientId, list);
    }

    for (const [, group] of byClient) {
      if (group.length < 2) continue;

      let keep = group[0];
      let bestCount = -1;
      for (const r of group) {
        const count = await db.ChatMessage.count({ where: { roomId: r.id } });
        if (count > bestCount) {
          bestCount = count;
          keep = r;
        }
      }

      for (const r of group) {
        if (r.id === keep.id) continue;

        const members = await db.ChatMember.findAll({ where: { roomId: r.id } });
        for (const m of members) {
          const where = {
            roomId: keep.id,
            memberType: m.memberType,
            ...(m.memberType === 'user' ? { userId: m.userId } : { contactId: m.contactId }),
          };
          const exists = await db.ChatMember.findOne({ where });
          if (exists) await m.destroy();
          else await m.update({ roomId: keep.id });
        }

        await db.ChatMessage.update({ roomId: keep.id }, { where: { roomId: r.id } });
        await db.ChatRoom.destroy({ where: { id: r.id } });
      }

      // Ensure kept row is typed as client.
      await db.ChatRoom.update(
        { roomType: 'client' },
        { where: { id: keep.id } },
      ).catch(() => {});
    }
  }

  /** Create rooms for every client that does not have one yet (existing CRM data). */
  async ensureAllClientRooms(orgId, actorUserId = null) {
    await this.dedupeClientRooms(orgId);

    const clients = await db.Client.findAll({ where: { orgId }, attributes: ['id'] });
    if (!clients.length) return;
    const existing = await db.ChatRoom.findAll({
      where: {
        orgId,
        [Op.or]: [{ roomType: 'client' }, { roomType: null }],
        clientId: { [Op.ne]: null },
      },
      attributes: ['clientId'],
    });
    const have = new Set(existing.map((r) => r.clientId));
    for (const c of clients) {
      if (have.has(c.id)) continue;
      // ensureClientRoom also syncs project assignees on create.
      await this.ensureClientRoom(orgId, c.id, actorUserId);
    }
  }

  async syncProjectAssignees(orgId, clientId) {
    const room = await this.ensureClientRoom(orgId, clientId, null);
    if (!room) return;

    const projects = await db.Project.findAll({
      where: { orgId, clientId },
      attributes: ['id'],
    });
    if (!projects.length) return;

    const projectIds = projects.map((p) => p.id);
    const assignments = await db.ProjectAssignment.findAll({
      where: { projectId: { [Op.in]: projectIds }, userId: { [Op.ne]: null } },
      attributes: ['userId'],
    });

    const userIds = [...new Set(assignments.map((a) => a.userId).filter(Boolean))];
    for (const userId of userIds) {
      await this._upsertUserMember(room.id, userId, 'member');
    }
  }

  /**
   * Open or return an existing 1:1 DM.
   * Only the opener is added as a member until the first message is sent — so the
   * other person does not see an empty "Start the conversation" thread.
   */
  async openDm(orgId, actorUserId, otherUserId) {
    if (!actorUserId || !otherUserId) {
      const err = new Error('Other user is required.');
      err.status = 400;
      throw err;
    }
    // Self-DM is allowed (WhatsApp-style "Message yourself") — the frontend
    // labels it "You" via the isSelf flag on the serialized room below.

    const other = await db.User.findOne({
      where: { id: otherUserId, orgId, isActive: true },
      attributes: ['id', 'name', 'avatarUrl'],
    });
    if (!other) {
      const err = new Error('User not found.');
      err.status = 404;
      throw err;
    }

    const key = dmKeyFor(actorUserId, otherUserId);
    let room = await db.ChatRoom.findOne({ where: { orgId, roomType: 'dm', dmKey: key } });
    if (!room) {
      try {
        room = await db.ChatRoom.create({
          id: uuidv4(),
          orgId,
          roomType: 'dm',
          clientId: null,
          dmKey: key,
          name: other.name,
          createdBy: actorUserId,
        });
      } catch (err) {
        room = await db.ChatRoom.findOne({ where: { orgId, roomType: 'dm', dmKey: key } });
        if (!room) throw err;
      }
    }

    // Opener can see/compose; peer joins only when the first message is sent.
    const membership = await this._upsertUserMember(room.id, actorUserId, 'member');
    // Stamp the read cursor to mark this as a room the person deliberately
    // opened, as opposed to one they were pre-added to. That distinction is what
    // stops the sidebar sweep below from removing them again on the next load.
    if (membership && !membership.lastReadAt) {
      await membership.update({ lastReadAt: new Date() }).catch(() => {});
    }
    await this._pruneEmptyDmPeer(room, [actorUserId]);

    return this._serializeRoom(room, actorUserId, { isOrgAdmin: false });
  }

  /**
   * Keep an empty DM out of the sidebar of someone who never asked for it.
   *
   * Only prunes people who were pre-added without opening the room themselves.
   * `keepUserIds` must include whoever is opening it right now: they explicitly
   * asked for this conversation, and pruning them deleted the membership that
   * had just been created for them — so the second person to open any DM got
   * the room back and was then refused entry to it with a 403.
   */
  async _pruneEmptyDmPeer(room, keepUserIds = []) {
    if (!room || room.roomType !== 'dm' || !room.createdBy) return;
    const messageCount = await db.ChatMessage.count({ where: { roomId: room.id } });
    if (messageCount > 0) return;

    const keep = [...new Set([room.createdBy, ...keepUserIds].filter(Boolean))];
    await db.ChatMember.destroy({
      where: {
        roomId: room.id,
        memberType: 'user',
        userId: { [Op.notIn]: keep },
      },
    });
  }

  /** Ensure both DM participants are members (called on first send). */
  async _ensureDmPeerMembership(room, senderUserId) {
    if (!room || room.roomType !== 'dm' || !room.dmKey || !senderUserId) return;
    const parts = String(room.dmKey).split(':').filter(Boolean);
    for (const userId of parts) {
      await this._upsertUserMember(room.id, userId, 'member');
    }
  }

  /**
   * Remove this user from empty draft DMs they didn't create (opened by someone else
   * before the first message). Leaves the creator's draft intact.
   */
  async _pruneEmptyDmMembershipsForUser(orgId, userId) {
    if (!userId) return;
    const memberships = await db.ChatMember.findAll({
      where: { memberType: 'user', userId },
      include: [{
        model: db.ChatRoom,
        as: 'room',
        where: { orgId, roomType: 'dm' },
        required: true,
        attributes: ['id', 'createdBy'],
      }],
    });

    for (const m of memberships) {
      const room = m.room;
      if (!room || room.createdBy === userId) continue;
      // Opening a DM stamps lastReadAt. Its presence means this person chose to
      // be here, so the room is theirs to keep even while it is still empty —
      // without this check the sweep removed them again on the very next load.
      if (m.lastReadAt) continue;
      const count = await db.ChatMessage.count({ where: { roomId: room.id } });
      if (count === 0) await m.destroy();
    }
  }

  /**
   * Create a custom group room. Org admins can create freely; any employee can
   * create a group they admin and invite colleagues.
   */
  async createGroupRoom(orgId, actor, { name, userIds = [] } = {}) {
    const title = String(name || '').trim();
    if (!title) {
      const err = new Error('Room name is required.');
      err.status = 400;
      throw err;
    }

    const memberIds = [...new Set([actor.userId, ...(userIds || [])].filter(Boolean))];
    const users = await db.User.findAll({
      where: { id: { [Op.in]: memberIds }, orgId, isActive: true },
      attributes: ['id', 'name'],
    });
    if (!users.find((u) => u.id === actor.userId)) {
      const err = new Error('Creator must be an active org user.');
      err.status = 400;
      throw err;
    }

    const room = await db.ChatRoom.create({
      id: uuidv4(),
      orgId,
      roomType: 'group',
      clientId: null,
      dmKey: null,
      name: title,
      createdBy: actor.userId,
    });

    for (const u of users) {
      await this._upsertUserMember(room.id, u.id, u.id === actor.userId ? 'admin' : 'member');
    }

    return this._serializeRoom(room, actor.userId, { isOrgAdmin: !!actor.isOrgAdmin, isSuperAdmin: !!actor.isSuperAdmin });
  }

  async _upsertUserMember(roomId, userId, role = 'member') {
    if (!userId) return null;
    const existing = await db.ChatMember.findOne({
      where: { roomId, memberType: 'user', userId },
    });
    if (existing) {
      if (role === 'admin' && existing.role !== 'admin') {
        await existing.update({ role: 'admin' });
      }
      return existing;
    }
    return db.ChatMember.create({
      id: uuidv4(),
      roomId,
      memberType: 'user',
      userId,
      role,
      joinedAt: new Date(),
    });
  }

  async _upsertContactMember(roomId, contactId, role = 'member') {
    if (!contactId) return null;
    const existing = await db.ChatMember.findOne({
      where: { roomId, memberType: 'contact', contactId },
    });
    if (existing) return existing;
    return db.ChatMember.create({
      id: uuidv4(),
      roomId,
      memberType: 'contact',
      contactId,
      role,
      joinedAt: new Date(),
    });
  }

  async getMembership(roomId, { userId = null, contactId = null } = {}) {
    if (userId) {
      return db.ChatMember.findOne({ where: { roomId, memberType: 'user', userId } });
    }
    if (contactId) {
      return db.ChatMember.findOne({ where: { roomId, memberType: 'contact', contactId } });
    }
    return null;
  }

  async assertRoomAccess(roomId, orgId, actor) {
    const room = await db.ChatRoom.findOne({
      where: { id: roomId, orgId },
      include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'], required: false }],
    });
    if (!room) {
      const err = new Error('Room not found.');
      err.status = 404;
      throw err;
    }
    const membership = await this.getMembership(roomId, {
      userId: actor.userId || null,
      contactId: actor.contactId || null,
    });
    // Org admins can open client/group rooms without membership; DMs stay private.
    const adminBypass = actor.isOrgAdmin && room.roomType !== 'dm';
    if (!membership && !adminBypass) {
      const err = new Error('You are not a member of this room.');
      err.status = 403;
      throw err;
    }
    return { room, membership };
  }

  async _dmPeer(room, viewerUserId) {
    if (room.roomType !== 'dm' || !viewerUserId) return null;

    // Prefer membership list; fall back to dmKey so draft DMs still show the peer name.
    const members = await db.ChatMember.findAll({
      where: { roomId: room.id, memberType: 'user' },
      include: [{ model: db.User, as: 'user', attributes: ['id', 'name', 'avatarUrl'] }],
    });
    const peerMember = members.find((m) => m.userId !== viewerUserId);
    if (peerMember?.user) return peerMember.user;

    if (room.dmKey) {
      const ids = String(room.dmKey).split(':').filter(Boolean);
      // Self-DM ("Message yourself"): both halves of the key are the viewer,
      // so there is no *other* party — the viewer is their own peer.
      if (ids.length && ids.every((id) => id === viewerUserId)) {
        return db.User.findByPk(viewerUserId, { attributes: ['id', 'name', 'avatarUrl', 'lastSeenAt'] });
      }
      const peerId = ids.find((id) => id && id !== viewerUserId);
      if (peerId) {
        return db.User.findByPk(peerId, { attributes: ['id', 'name', 'avatarUrl', 'lastSeenAt'] });
      }
    }
    return null;
  }

  async _serializeRoom(room, viewerUserId, {
    isOrgAdmin = false,
    isSuperAdmin = false,
    membership = null,
    viewerContactId = null,
  } = {}) {
    const plain = room.toJSON ? room.toJSON() : room;
    const mem = membership || (plain.members || [])[0] || null;
    // No membership cursor → not tracking unread for this viewer.
    const unread = mem
      ? await this._unreadCount(plain.id, mem.lastReadAt || null, {
        excludeUserId: viewerUserId || null,
        excludeContactId: viewerContactId || null,
      })
      : 0;
    const last = await db.ChatMessage.findOne({
      where: { roomId: plain.id, deletedAt: null },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'body', 'createdAt', 'senderType', 'attachments'],
    });
    const peer = plain.roomType === 'dm'
      ? await this._dmPeer(plain, viewerUserId)
      : null;
    // "Message yourself" — the only DM where the peer IS the viewer.
    const isSelf = plain.roomType === 'dm' && !!peer && !!viewerUserId && peer.id === viewerUserId;

    const role = mem?.role || (isOrgAdmin && plain.roomType !== 'dm' ? 'admin' : 'member');
    const isActive = plain.isActive !== false;

    // How many CLIENT contacts are actually in the room — not whether the room
    // is merely *allowed* to have them. The "client can read this" warning has
    // to be driven by this: showing it on a room that contains only staff is a
    // false alarm, and a warning that cries wolf stops being read at all.
    const clientMemberCount = plain.roomType === 'dm'
      ? 0
      : await db.ChatMember.count({ where: { roomId: plain.id, memberType: 'contact' } });

    return {
      id: plain.id,
      name: peer?.name || plain.name,
      description: plain.description || null,
      roomType: plain.roomType || 'client',
      clientId: plain.clientId,
      client: plain.client || null,
      peer: peer ? { id: peer.id, name: peer.name, avatarUrl: peer.avatarUrl, lastSeenAt: peer.lastSeenAt } : null,
      isSelf,
      role,
      unread,
      lastMessage: last,
      updatedAt: plain.updatedAt,
      // ─── Lifecycle & governance ──────────────────────────────────────────
      isActive,
      deactivatedAt: plain.deactivatedAt || null,
      visibility: plain.visibility || 'internal',
      clientMemberCount,
      isAnnouncement: !!plain.isAnnouncement,
      retentionDays: plain.retentionDays || null,
      createdBy: plain.createdBy || null,
      // Whether THIS viewer may rename/configure the room. Computed server-side
      // so the UI never has to reimplement the permission rule.
      canManage: this._canManageRoomSync(plain, { userId: viewerUserId, isOrgAdmin }, mem),
      // Deliberately narrower than canManage: activating/deactivating is
      // super-admin only, and the control is hidden from everyone else rather
      // than shown and then refused.
      canDeactivate: !!isSuperAdmin && (plain.roomType || 'client') !== 'dm',
      // Composing is blocked in a deactivated room, and in an announcement room
      // for anyone who isn't an admin.
      canPost: isActive && (!plain.isAnnouncement || role === 'admin' || isOrgAdmin),
      // ─── Personal preferences ────────────────────────────────────────────
      notifyLevel: mem?.notifyLevel || 'all',
      isFavorite: !!mem?.isFavorite,
      draft: mem?.draft || '',
    };
  }

  /**
   * Who may administer a room: org admins, the person who created it, and
   * anyone holding the room-admin role. DMs have no administration.
   *
   * Sync variant used by the serializer, which already holds the membership row.
   */
  _canManageRoomSync(room, actor, membership) {
    if (!room || room.roomType === 'dm') return false;
    if (actor?.isOrgAdmin) return true;
    if (actor?.userId && room.createdBy && room.createdBy === actor.userId) return true;
    return membership?.role === 'admin';
  }

  async _assertCanManageRoom(roomId, orgId, actor) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    if (!this._canManageRoomSync(room, actor, membership)) {
      const err = new Error('Only the room creator or an admin can change this room.');
      err.status = 403;
      throw err;
    }
    return { room, membership };
  }

  async listRoomsForUser(orgId, userId, isOrgAdmin = false, { status = 'active', isSuperAdmin = false } = {}) {
    // Collapse accidental duplicate client rooms so everyone lands in the same thread.
    await this.dedupeClientRooms(orgId);
    // Hide empty draft DMs from users who never sent/received (peer was pre-added).
    await this._pruneEmptyDmMembershipsForUser(orgId, userId);
    // Backfill client rooms for orgs that had clients before Messages shipped.
    if (isOrgAdmin) {
      await this.ensureAllClientRooms(orgId, userId);
    }

    // Everyone sees rooms they belong to. Org admins also see all client + group rooms.
    const memberships = await db.ChatMember.findAll({
      where: { memberType: 'user', userId },
      include: [{
        model: db.ChatRoom,
        as: 'room',
        where: { orgId },
        required: true,
        include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'], required: false }],
      }],
    });

    const byId = new Map();
    for (const m of memberships) {
      const room = m.room.toJSON();
      // Carry the WHOLE membership row through, not a hand-picked subset.
      // Copying only id/lastReadAt/role meant notifyLevel, isFavorite and draft
      // never reached the client: the mute setting saved correctly but the UI
      // always re-read the default, so the buttons looked permanently dead.
      room.members = [{
        id: m.id,
        lastReadAt: m.lastReadAt,
        role: m.role,
        notifyLevel: m.notifyLevel,
        isFavorite: m.isFavorite,
        draft: m.draft,
      }];
      byId.set(room.id, room);
    }

    if (isOrgAdmin) {
      const extras = await db.ChatRoom.findAll({
        where: { orgId, roomType: { [Op.in]: ['client', 'group'] } },
        include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'], required: false }],
      });
      for (const r of extras) {
        if (byId.has(r.id)) continue;
        const plain = r.toJSON();
        plain.members = [];
        byId.set(plain.id, plain);
      }
    }

    const result = [];
    for (const room of byId.values()) {
      // `status` is the Active / Inactive / All filter. Applied here rather than
      // in the query because rooms arrive from two sources (memberships and the
      // admin sweep) and both need the same rule.
      const roomActive = room.isActive !== false;
      if (status === 'active' && !roomActive) continue;
      if (status === 'inactive' && roomActive) continue;

      result.push(await this._serializeRoom(room, userId, {
        isOrgAdmin,
        isSuperAdmin,
        membership: (room.members || [])[0] || null,
      }));
    }

    // Favourites first, then most recent activity — a starred channel should not
    // fall off the top of the list just because it has been quiet.
    result.sort((a, b) => {
      if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
      const at = a.lastMessage?.createdAt || a.updatedAt || 0;
      const bt = b.lastMessage?.createdAt || b.updatedAt || 0;
      return new Date(bt) - new Date(at);
    });
    return result;
  }

  async listRoomsForContact(orgId, contactId, clientId) {
    const memberships = await db.ChatMember.findAll({
      where: { memberType: 'contact', contactId },
      include: [{
        model: db.ChatRoom,
        as: 'room',
        where: { orgId, clientId, roomType: 'client' },
        required: true,
        include: [{ model: db.Client, as: 'client', attributes: ['id', 'name'] }],
      }],
    });

    const result = [];
    for (const m of memberships) {
      result.push(await this._serializeRoom(m.room, null, {
        // Full row — see listRoomsForUser for why a subset breaks the settings UI.
        membership: {
          id: m.id,
          lastReadAt: m.lastReadAt,
          role: m.role,
          notifyLevel: m.notifyLevel,
          isFavorite: m.isFavorite,
          draft: m.draft,
        },
        viewerContactId: contactId,
      }));
    }
    return result;
  }

  async _unreadCount(roomId, lastReadAt, { excludeUserId = null, excludeContactId = null } = {}) {
    const where = { roomId };
    if (lastReadAt) where.createdAt = { [Op.gt]: lastReadAt };
    // Own messages should never inflate the unread badge.
    if (excludeUserId) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { senderUserId: null },
            { senderUserId: { [Op.ne]: excludeUserId } },
          ],
        },
      ];
    }
    if (excludeContactId) {
      where[Op.and] = [
        ...(where[Op.and] || []),
        {
          [Op.or]: [
            { senderContactId: null },
            { senderContactId: { [Op.ne]: excludeContactId } },
          ],
        },
      ];
    }
    return db.ChatMessage.count({ where });
  }

  /** Cursor must be >= latest message time so DB/app clock skew can't leave a sticky unread. */
  async _readCursor(roomId) {
    const latest = await db.ChatMessage.findOne({
      where: { roomId },
      order: [['createdAt', 'DESC']],
      attributes: ['createdAt'],
    });
    const now = Date.now();
    const latestMs = latest?.createdAt ? new Date(latest.createdAt).getTime() : 0;
    return new Date(Math.max(now, latestMs));
  }

  /**
   * The main transcript: top-level messages only, newest page first, returned
   * oldest-first for rendering.
   *
   * Thread replies are excluded here and fetched per-thread — that is the whole
   * reason threads exist, and interleaving them would put the transcript back to
   * the unreadable state threads were meant to fix. Deleted messages ARE
   * returned so the UI can show a tombstone where something was removed rather
   * than silently reflowing the conversation.
   */
  async listMessages(roomId, { before = null, limit = 50 } = {}) {
    const where = { roomId, parentMessageId: null };
    if (before) where.createdAt = { [Op.lt]: new Date(before) };
    const rows = await db.ChatMessage.findAll({
      where,
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
        {
          model: db.ChatReaction,
          as: 'reactions',
          attributes: ['emoji', 'memberKey'],
          required: false,
        },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(100, Math.max(1, limit)),
    });
    return rows.reverse();
  }

  async sendMessage(roomId, orgId, actor, { body = '', attachments = [], parentMessageId = null } = {}) {
    const { room, membership: senderMembership } = await this.assertRoomAccess(roomId, orgId, actor);

    // A deactivated room is read-only: history stays fully visible, nothing new
    // goes in. This is the enforcement behind the UI's disabled composer — the
    // check has to live here or a direct API call would walk straight past it.
    if (room.isActive === false) {
      const err = new Error('This channel is inactive. Its history is still available, but new messages are closed.');
      err.status = 403;
      throw err;
    }

    // Announcement rooms: admins broadcast, everyone else reads.
    if (room.isAnnouncement) {
      const canPost = actor.isOrgAdmin || senderMembership?.role === 'admin'
        || (actor.userId && room.createdBy === actor.userId);
      if (!canPost) {
        const err = new Error('This is an announcement channel — only admins can post here.');
        err.status = 403;
        throw err;
      }
    }

    const text = String(body || '').trim();
    const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.url) : [];
    if (!text && !files.length) {
      const err = new Error('Message cannot be empty.');
      err.status = 400;
      throw err;
    }

    // Replies must hang off a live message in this same room; a thread that
    // could span rooms would let a reply leak into a conversation its author
    // never had access to.
    let parentId = null;
    if (parentMessageId) {
      const parent = await db.ChatMessage.findOne({
        where: { id: parentMessageId, roomId },
        attributes: ['id', 'parentMessageId', 'deletedAt'],
      });
      if (!parent || parent.deletedAt) {
        const err = new Error('The message you are replying to is no longer available.');
        err.status = 400;
        throw err;
      }
      // Threads are one level deep — replying to a reply joins the same thread
      // rather than nesting, which is what keeps them readable.
      parentId = parent.parentMessageId || parent.id;
    }

    // Sending into a room implies membership — auto-join org admins on client/group.
    if (actor.userId && !(await this.getMembership(roomId, { userId: actor.userId }))) {
      if (actor.isOrgAdmin && room.roomType !== 'dm') {
        await this._upsertUserMember(roomId, actor.userId, 'admin');
      }
    }

    // First real DM message invites the peer into the room (they can see it now).
    if (room.roomType === 'dm' && actor.userId) {
      await this._ensureDmPeerMembership(room, actor.userId);
    }

    const isContact = !!actor.contactId;
    const message = await db.ChatMessage.create({
      id: uuidv4(),
      roomId,
      senderType: isContact ? 'contact' : 'user',
      senderUserId: isContact ? null : actor.userId,
      senderContactId: isContact ? actor.contactId : null,
      body: text,
      attachments: files.length ? files : null,
      parentMessageId: parentId,
    });

    // Keep the parent's denormalised reply counter honest.
    if (parentId) await this._recountThread(parentId);

    await room.update({ updatedAt: new Date() });

    const membership = await this.getMembership(roomId, {
      userId: actor.userId,
      contactId: actor.contactId,
    });
    if (membership) {
      const cursor = message.createdAt
        ? new Date(Math.max(Date.now(), new Date(message.createdAt).getTime()))
        : await this._readCursor(roomId);
      await membership.update({ lastReadAt: cursor });
    }

    await this._notifyMentions(room, message, actor);

    return this.getMessageById(message.id);
  }

  /**
   * Who should get a desktop notification for this message.
   *
   * Separate from the socket broadcast: `message:new` only reaches people who
   * have the room open (they joined `room:<id>`), which is exactly the set that
   * does NOT need alerting. This returns the members who are elsewhere in the
   * app, so the WhatsApp-style toast reaches them.
   *
   * Honours each member's own notifyLevel — 'muted' never pings, 'mentions'
   * only when they were named or @all was used — so the desktop popup can't
   * become the loophole that makes muting pointless.
   */
  async notificationRecipients(room, message, actor) {
    const members = await db.ChatMember.findAll({
      where: { roomId: room.id },
      attributes: ['userId', 'contactId', 'memberType', 'notifyLevel'],
    });

    const text = message.body || '';
    const mentioned = new Set();
    let mentionsAll = false;
    MENTION_RE.lastIndex = 0;
    let match;
    while ((match = MENTION_RE.exec(text)) !== null) {
      if (match[2] === 'all') mentionsAll = true;
      else if (match[2] === 'user') mentioned.add(match[3]);
      else if (match[2] === 'contact') mentioned.add(`contact:${match[3]}`);
    }

    const out = [];
    for (const m of members) {
      // Skip the sender (staff or portal contact).
      if (m.userId && actor.userId && m.userId === actor.userId) continue;
      if (m.contactId && actor.contactId && m.contactId === actor.contactId) continue;
      if (!m.userId && !m.contactId) continue;

      const level = m.notifyLevel || 'all';
      if (level === 'muted') continue;
      const isMentioned = mentionsAll
        || (m.userId ? mentioned.has(m.userId) : false)
        || (m.contactId ? mentioned.has(`contact:${m.contactId}`) : false);
      if (level === 'mentions' && !isMentioned) continue;

      if (m.userId) out.push({ userId: m.userId, contactId: null, isMentioned });
      else if (m.contactId) out.push({ userId: null, contactId: m.contactId, isMentioned });
    }
    return out;
  }

  /** Minimal room row for building a notification payload. */
  async roomForNotification(roomId) {
    return db.ChatRoom.findByPk(roomId, { attributes: ['id', 'name', 'roomType', 'orgId'] });
  }

  /** The compact payload a desktop notification needs — never the raw body. */
  notificationPayload(room, message, { isMentioned = false } = {}) {
    const sender = message.senderUser?.name || message.senderContact?.name || 'Someone';
    const preview = mentionPreviewText(message.body).slice(0, 140)
      || (Array.isArray(message.attachments) && message.attachments.length ? 'Sent an attachment' : 'New message');
    return {
      roomId: room.id,
      roomName: room.name,
      messageId: message.id,
      sender,
      preview,
      isMentioned,
      isDm: room.roomType === 'dm',
      createdAt: message.createdAt,
    };
  }

  async getMessageById(id) {
    return db.ChatMessage.findByPk(id, {
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
      ],
    });
  }

  async _notifyMentions(room, message, actor) {
    const text = message.body || '';
    const seen = new Set();
    let match;
    let notifyAll = false;
    const userIds = new Set();

    MENTION_RE.lastIndex = 0;
    while ((match = MENTION_RE.exec(text)) !== null) {
      const [, , type, id] = match;
      const key = `${type}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (type === 'all') {
        notifyAll = true;
      } else if (type === 'user' && id !== actor.userId) {
        userIds.add(id);
      }
    }

    if (notifyAll) {
      const members = await db.ChatMember.findAll({
        where: { roomId: room.id, memberType: 'user', userId: { [Op.ne]: null } },
        attributes: ['userId'],
      });
      for (const m of members) {
        if (m.userId && m.userId !== actor.userId) userIds.add(m.userId);
      }
    }

    const preview = mentionPreviewText(text).slice(0, 140)
      || 'You were mentioned in Messages.';

    // Someone who muted this room asked not to hear from it — an @mention (and
    // especially an @all) must not be a way around that, or muting is useless
    // and people mute the whole product instead.
    if (userIds.size) {
      const muted = await db.ChatMember.findAll({
        where: {
          roomId: room.id,
          memberType: 'user',
          userId: { [Op.in]: [...userIds] },
          notifyLevel: 'muted',
        },
        attributes: ['userId'],
      });
      for (const m of muted) userIds.delete(m.userId);
    }

    for (const id of userIds) {
      NotificationService.notify(id, room.orgId, {
        type: 'chat_mention',
        title: notifyAll ? `Mentioned everyone in ${room.name}` : `Mentioned in ${room.name}`,
        body: preview,
        refTable: 'chat_rooms',
        refId: room.id,
      }).catch(() => {});
    }
  }

  async markRead(roomId, orgId, actor) {
    await this.assertRoomAccess(roomId, orgId, actor);
    const membership = await this.getMembership(roomId, {
      userId: actor.userId,
      contactId: actor.contactId,
    });
    if (!membership) return { ok: true };
    await membership.update({ lastReadAt: await this._readCursor(roomId) });
    return { ok: true };
  }

  async listMembers(roomId, orgId, actor) {
    await this.assertRoomAccess(roomId, orgId, actor);
    return db.ChatMember.findAll({
      where: { roomId },
      include: [
        { model: db.User, as: 'user', attributes: ['id', 'name', 'avatarUrl', 'email', 'lastSeenAt'] },
        { model: db.Contact, as: 'contact', attributes: ['id', 'name', 'email'] },
      ],
      order: [['joinedAt', 'ASC']],
    });
  }

  async _canManageMembers(room, actor, membership) {
    if (actor.isOrgAdmin) return true;
    if (membership?.role === 'admin') return true;
    // Group creators / room admins manage; DMs are fixed membership.
    if (room.roomType === 'dm') return false;
    return false;
  }

  async addMember(roomId, orgId, actor, { userId = null, contactId = null } = {}) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    if (!(await this._canManageMembers(room, actor, membership))) {
      const err = new Error('You cannot add people to this room.');
      err.status = 403;
      throw err;
    }

    if (room.roomType === 'dm') {
      const err = new Error('Direct messages are limited to two people.');
      err.status = 400;
      throw err;
    }

    if (userId) {
      const user = await db.User.findOne({ where: { id: userId, orgId, isActive: true } });
      if (!user) {
        const err = new Error('User not found.');
        err.status = 404;
        throw err;
      }
      return this._upsertUserMember(room.id, userId, 'member');
    }

    if (contactId) {
      if (room.roomType !== 'client' || !room.clientId) {
        const err = new Error('Client contacts can only join client rooms.');
        err.status = 400;
        throw err;
      }
      // An internal-only room shows no "client can read this" banner, so letting
      // a contact in would silently expose internal chatter. The room has to be
      // switched to client-shared first — deliberately an explicit decision.
      if (room.visibility === 'internal') {
        const err = new Error('This room is internal only. Switch it to "shared with client" before adding a client contact.');
        err.status = 400;
        throw err;
      }
      if (!actor.isOrgAdmin) {
        const err = new Error('Only an admin can add a client contact.');
        err.status = 403;
        throw err;
      }
      const contact = await db.Contact.findOne({
        where: { id: contactId, clientId: room.clientId },
      });
      if (!contact) {
        const err = new Error('Contact not found for this client.');
        err.status = 404;
        throw err;
      }
      if (!contact.portalAccess) {
        const err = new Error('Contact must have portal access before joining Messages.');
        err.status = 400;
        throw err;
      }
      return this._upsertContactMember(room.id, contactId, 'member');
    }

    const err = new Error('Provide userId or contactId.');
    err.status = 400;
    throw err;
  }

  async removeMember(roomId, orgId, actor, memberId) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    if (!(await this._canManageMembers(room, actor, membership))) {
      const err = new Error('You cannot remove people from this room.');
      err.status = 403;
      throw err;
    }
    if (room.roomType === 'dm') {
      const err = new Error('Cannot remove members from a direct message.');
      err.status = 400;
      throw err;
    }

    const member = await db.ChatMember.findOne({ where: { id: memberId, roomId } });
    if (!member) {
      const err = new Error('Member not found.');
      err.status = 404;
      throw err;
    }
    if (member.role === 'admin') {
      const adminCount = await db.ChatMember.count({ where: { roomId, role: 'admin' } });
      if (adminCount <= 1) {
        const err = new Error('Cannot remove the last room admin.');
        err.status = 400;
        throw err;
      }
    }
    await member.destroy();
    return { ok: true };
  }

  /** Mentions picker: room members only. */
  async mentionCandidates(roomId, orgId, actor) {
    const members = await this.listMembers(roomId, orgId, actor);
    return members.map((m) => {
      if (m.memberType === 'user' && m.user) {
        return { id: m.user.id, type: 'user', name: m.user.name, avatarUrl: m.user.avatarUrl, lastSeenAt: m.user.lastSeenAt };
      }
      if (m.memberType === 'contact' && m.contact) {
        return { id: m.contact.id, type: 'contact', name: m.contact.name, avatarUrl: null };
      }
      return null;
    }).filter(Boolean);
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Room lifecycle — deactivate, never delete
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Switch a room on or off.
   *
   * Deactivating keeps every message, member and attachment exactly where it is
   * and only refuses new posts. That is the whole point: a channel is the record
   * of what was agreed with a client, so it must be possible to retire one
   * without destroying the evidence. There is deliberately no delete anywhere in
   * this service.
   *
   * Client rooms are exempt — deactivating one would silently cut the client off
   * from the thread they use in the portal.
   */
  async setRoomActive(roomId, orgId, actor, active) {
    // Retiring a channel is a super-admin decision, full stop. Room creators and
    // room admins can rename and configure their channel, but closing the record
    // of a client engagement is not theirs to do — and it applies to every room
    // type, because "the project finished" is precisely when a client room
    // should be retired.
    if (!actor.isSuperAdmin) {
      const err = new Error('Only a super admin can activate or deactivate a channel.');
      err.status = 403;
      throw err;
    }

    const { room } = await this.assertRoomAccess(roomId, orgId, actor);

    if (room.roomType === 'dm') {
      const err = new Error('Direct messages cannot be deactivated.');
      err.status = 400;
      throw err;
    }

    const next = !!active;
    if ((room.isActive !== false) === next) {
      return this._serializeRoom(room, actor.userId, { isOrgAdmin: actor.isOrgAdmin, isSuperAdmin: actor.isSuperAdmin });
    }

    await room.update({
      isActive: next,
      deactivatedAt: next ? null : new Date(),
      deactivatedBy: next ? null : (actor.userId || null),
    });

    await db.ChatRoomEvent.record(room.id, next ? 'reactivated' : 'deactivated', {
      actorUserId: actor.userId || null,
      summary: next ? 'Reactivated the channel' : 'Deactivated the channel',
    });

    const membership = await this.getMembership(roomId, { userId: actor.userId });
    return this._serializeRoom(room, actor.userId, { isOrgAdmin: actor.isOrgAdmin, isSuperAdmin: actor.isSuperAdmin, membership });
  }

  /** Rename / re-describe / re-govern a room. Every change is audited. */
  async updateRoomSettings(roomId, orgId, actor, patch = {}) {
    const { room } = await this._assertCanManageRoom(roomId, orgId, actor);
    const changes = {};
    const audits = [];

    if (patch.name !== undefined && room.roomType !== 'dm') {
      const name = String(patch.name || '').trim();
      if (!name) {
        const err = new Error('Room name cannot be empty.');
        err.status = 400;
        throw err;
      }
      if (name !== room.name) {
        changes.name = name.slice(0, 255);
        audits.push(['renamed', `Renamed "${room.name}" → "${changes.name}"`, { from: room.name, to: changes.name }]);
      }
    }

    if (patch.description !== undefined) {
      changes.description = String(patch.description || '').trim().slice(0, 500) || null;
    }

    if (patch.visibility !== undefined && ['internal', 'client_shared'].includes(patch.visibility)) {
      if (patch.visibility !== room.visibility) {
        // Narrowing to internal with client contacts already in the room would
        // leave the banner off while a client can still read it.
        if (patch.visibility === 'internal') {
          const contacts = await db.ChatMember.count({
            where: { roomId, memberType: 'contact' },
          });
          if (contacts > 0) {
            const err = new Error('Remove the client contacts from this room before marking it internal-only.');
            err.status = 400;
            throw err;
          }
        }
        changes.visibility = patch.visibility;
        audits.push(['visibility_changed', `Visibility set to ${patch.visibility === 'internal' ? 'internal only' : 'shared with client'}`, { to: patch.visibility }]);
      }
    }

    if (patch.isAnnouncement !== undefined) {
      const next = !!patch.isAnnouncement;
      if (next !== !!room.isAnnouncement) {
        changes.isAnnouncement = next;
        audits.push(['announcement_changed', next ? 'Switched to announcement-only' : 'Switched back to open posting', { to: next }]);
      }
    }

    if (patch.retentionDays !== undefined) {
      const raw = patch.retentionDays;
      const days = raw === null || raw === '' ? null : Math.max(1, parseInt(raw, 10) || 0) || null;
      if (days !== room.retentionDays) {
        changes.retentionDays = days;
        audits.push(['retention_changed', days ? `Messages now deleted after ${days} days` : 'Retention limit removed — messages kept forever', { to: days }]);
      }
    }

    if (Object.keys(changes).length) await room.update(changes);
    for (const [type, summary, meta] of audits) {
      await db.ChatRoomEvent.record(room.id, type, { actorUserId: actor.userId || null, summary, meta });
    }

    const membership = await this.getMembership(roomId, { userId: actor.userId });
    return this._serializeRoom(room, actor.userId, { isOrgAdmin: actor.isOrgAdmin, isSuperAdmin: actor.isSuperAdmin, membership });
  }

  /** The room's admin audit trail, newest first. */
  async roomEvents(roomId, orgId, actor, { limit = 50 } = {}) {
    await this.assertRoomAccess(roomId, orgId, actor);
    return db.ChatRoomEvent.findAll({
      where: { roomId },
      include: [{ model: db.User, as: 'actor', attributes: ['id', 'name', 'avatarUrl'] }],
      order: [['createdAt', 'DESC']],
      limit: Math.min(200, Math.max(1, limit)),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Messages — edit, delete, pin, react, thread, search
  // ══════════════════════════════════════════════════════════════════════════

  async _messageInRoom(messageId, roomId) {
    const message = await db.ChatMessage.findOne({ where: { id: messageId, roomId } });
    if (!message) {
      const err = new Error('Message not found.');
      err.status = 404;
      throw err;
    }
    return message;
  }

  _isAuthor(message, actor) {
    if (actor.userId) return message.senderUserId === actor.userId;
    if (actor.contactId) return message.senderContactId === actor.contactId;
    return false;
  }

  /**
   * Edit your own message. The original text is preserved in `originalBody` the
   * first time it changes, so "what did they actually write" always has an
   * answer — an enterprise chat where history can be quietly rewritten is a
   * liability rather than a feature.
   */
  async editMessage(roomId, orgId, actor, messageId, body) {
    const { room } = await this.assertRoomAccess(roomId, orgId, actor);
    if (room.isActive === false) {
      const err = new Error('This channel is inactive — its messages can no longer be edited.');
      err.status = 400;
      throw err;
    }

    const message = await this._messageInRoom(messageId, roomId);
    if (message.deletedAt) {
      const err = new Error('This message was deleted.');
      err.status = 400;
      throw err;
    }
    if (!this._isAuthor(message, actor)) {
      const err = new Error('You can only edit your own messages.');
      err.status = 403;
      throw err;
    }

    const text = String(body || '').trim();
    if (!text && !(message.attachments || []).length) {
      const err = new Error('Message cannot be empty.');
      err.status = 400;
      throw err;
    }

    await message.update({
      originalBody: message.originalBody || message.body,
      body: text,
      editedAt: new Date(),
    });
    return this.getMessageById(message.id);
  }

  /**
   * Soft-delete. The row and its original text stay; only the displayed body is
   * cleared and a tombstone flag set. Authors delete their own; room admins can
   * remove anything (a client-visible room needs a way to pull a mistake).
   */
  async deleteMessage(roomId, orgId, actor, messageId) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    const message = await this._messageInRoom(messageId, roomId);
    if (message.deletedAt) return this.getMessageById(message.id);

    const canModerate = this._canManageRoomSync(room, actor, membership);
    if (!this._isAuthor(message, actor) && !canModerate) {
      const err = new Error('You can only delete your own messages.');
      err.status = 403;
      throw err;
    }

    await message.update({
      originalBody: message.originalBody || message.body,
      body: '',
      attachments: null,
      isPinned: false,
      deletedAt: new Date(),
      deletedBy: actor.userId || actor.contactId || null,
    });

    // A deleted parent shouldn't keep advertising replies it no longer heads.
    if (message.parentMessageId) await this._recountThread(message.parentMessageId);

    return this.getMessageById(message.id);
  }

  async _recountThread(parentId) {
    if (!parentId) return;
    const [count, latest] = await Promise.all([
      db.ChatMessage.count({ where: { parentMessageId: parentId, deletedAt: null } }),
      db.ChatMessage.findOne({
        where: { parentMessageId: parentId, deletedAt: null },
        order: [['createdAt', 'DESC']],
        attributes: ['createdAt'],
      }),
    ]);
    await db.ChatMessage.update(
      { replyCount: count, lastReplyAt: latest?.createdAt || null },
      { where: { id: parentId } },
    );
  }

  /** Replies under one parent message, oldest first (a thread reads forward). */
  async listThread(roomId, orgId, actor, parentId) {
    await this.assertRoomAccess(roomId, orgId, actor);
    const parent = await this._messageInRoom(parentId, roomId);
    const replies = await db.ChatMessage.findAll({
      where: { parentMessageId: parent.id },
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
        { model: db.ChatReaction, as: 'reactions', attributes: ['emoji', 'memberKey', 'userId', 'contactId'] },
      ],
      order: [['createdAt', 'ASC']],
    });
    return { parent: await this.getMessageById(parent.id), replies };
  }

  /**
   * Toggle an emoji reaction. Rows rather than a JSON blob, so two people
   * reacting at the same moment can't overwrite each other — see
   * models/ChatReaction.js.
   */
  async toggleReaction(roomId, orgId, actor, messageId, emoji) {
    const { room } = await this.assertRoomAccess(roomId, orgId, actor);
    if (room.isActive === false) {
      const err = new Error('This channel is inactive.');
      err.status = 400;
      throw err;
    }

    const clean = String(emoji || '').trim().slice(0, 16);
    if (!clean) {
      const err = new Error('An emoji is required.');
      err.status = 400;
      throw err;
    }
    await this._messageInRoom(messageId, roomId);

    const memberKey = actor.userId ? `user:${actor.userId}` : `contact:${actor.contactId}`;
    const existing = await db.ChatReaction.findOne({
      where: { messageId, memberKey, emoji: clean },
    });

    if (existing) {
      await existing.destroy();
    } else {
      await db.ChatReaction.create({
        id: uuidv4(),
        messageId,
        reactorType: actor.userId ? 'user' : 'contact',
        userId: actor.userId || null,
        contactId: actor.contactId || null,
        memberKey,
        emoji: clean,
      });
    }

    return this.listReactions(messageId);
  }

  /** Grouped `[{ emoji, count, reactedByMe, names }]` for one message. */
  async listReactions(messageId, viewerKey = null) {
    const rows = await db.ChatReaction.findAll({
      where: { messageId },
      include: [
        { model: db.User, as: 'user', attributes: ['id', 'name'] },
        { model: db.Contact, as: 'contact', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'ASC']],
    });

    const byEmoji = new Map();
    for (const r of rows) {
      const entry = byEmoji.get(r.emoji) || { emoji: r.emoji, count: 0, names: [], reactedByMe: false };
      entry.count += 1;
      entry.names.push(r.user?.name || r.contact?.name || 'Someone');
      if (viewerKey && r.memberKey === viewerKey) entry.reactedByMe = true;
      byEmoji.set(r.emoji, entry);
    }
    return [...byEmoji.values()];
  }

  /** Pin / unpin for the whole room — the brief, the credentials, the deadline. */
  async setPinned(roomId, orgId, actor, messageId, pinned) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    if (!this._canManageRoomSync(room, actor, membership) && membership?.role !== 'admin') {
      const err = new Error('Only room admins can pin messages.');
      err.status = 403;
      throw err;
    }
    const message = await this._messageInRoom(messageId, roomId);
    if (message.deletedAt && pinned) {
      const err = new Error('A deleted message cannot be pinned.');
      err.status = 400;
      throw err;
    }
    await message.update({
      isPinned: !!pinned,
      pinnedAt: pinned ? new Date() : null,
      pinnedBy: pinned ? (actor.userId || null) : null,
    });
    return this.getMessageById(message.id);
  }

  async listPinned(roomId, orgId, actor) {
    await this.assertRoomAccess(roomId, orgId, actor);
    return db.ChatMessage.findAll({
      where: { roomId, isPinned: true, deletedAt: null },
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
      ],
      order: [['pinnedAt', 'DESC']],
    });
  }

  /**
   * Search message text.
   *
   * Uses the FULLTEXT index when the table has one (see ChatMessage.ensureSchema)
   * and falls back to LIKE otherwise, so search still works on a MySQL build or
   * storage engine where the index couldn't be created — just more slowly.
   *
   * Scoped to rooms the caller can actually see: an org admin searching must not
   * surface other people's DMs.
   */
  async searchMessages(orgId, actor, { q, roomId = null, limit = 40 } = {}) {
    const term = String(q || '').trim();
    if (term.length < 2) return [];

    const visibleRoomIds = await this._visibleRoomIds(orgId, actor);
    if (!visibleRoomIds.length) return [];

    const scope = roomId
      ? visibleRoomIds.filter((id) => id === roomId)
      : visibleRoomIds;
    if (!scope.length) return [];

    const where = {
      roomId: { [Op.in]: scope },
      deletedAt: null,
      body: { [Op.like]: `%${term}%` },
    };

    const rows = await db.ChatMessage.findAll({
      where,
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
        { model: db.ChatRoom, as: 'room', attributes: ['id', 'name', 'roomType', 'isActive'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(100, Math.max(1, limit)),
    });

    return rows.map((r) => {
      const plain = r.toJSON();
      // A short window around the hit, so results are readable without opening
      // every room.
      const idx = plain.body.toLowerCase().indexOf(term.toLowerCase());
      const from = Math.max(0, idx - 40);
      plain.snippet = (from > 0 ? '…' : '')
        + plain.body.slice(from, idx + term.length + 60)
        + (idx + term.length + 60 < plain.body.length ? '…' : '');
      return plain;
    });
  }

  /** Room ids this actor may read — membership, plus admin visibility on non-DMs. */
  async _visibleRoomIds(orgId, actor) {
    const memberships = await db.ChatMember.findAll({
      where: actor.userId
        ? { memberType: 'user', userId: actor.userId }
        : { memberType: 'contact', contactId: actor.contactId },
      include: [{ model: db.ChatRoom, as: 'room', where: { orgId }, required: true, attributes: ['id'] }],
      attributes: ['roomId'],
    });
    const ids = new Set(memberships.map((m) => m.roomId));

    if (actor.isOrgAdmin) {
      const extras = await db.ChatRoom.findAll({
        where: { orgId, roomType: { [Op.in]: ['client', 'group'] } },
        attributes: ['id'],
      });
      for (const r of extras) ids.add(r.id);
    }
    return [...ids];
  }

  /** Every attachment posted in a room, newest first — the room's file gallery. */
  async listFiles(roomId, orgId, actor, { limit = 200 } = {}) {
    await this.assertRoomAccess(roomId, orgId, actor);
    const rows = await db.ChatMessage.findAll({
      where: { roomId, deletedAt: null, attachments: { [Op.ne]: null } },
      include: [
        { model: db.User, as: 'senderUser', attributes: ['id', 'name'] },
        { model: db.Contact, as: 'senderContact', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit: Math.min(500, Math.max(1, limit)),
    });

    const files = [];
    for (const m of rows) {
      for (const a of (m.attachments || [])) {
        if (!a?.url) continue;
        files.push({
          ...a,
          messageId: m.id,
          postedAt: m.createdAt,
          postedBy: m.senderUser?.name || m.senderContact?.name || 'Someone',
        });
      }
    }
    return files;
  }

  /**
   * Who has read up to a given point.
   *
   * Derived from each member's existing lastReadAt cursor rather than a separate
   * receipts table — the cursor is already maintained on every room open, so
   * "seen by" costs nothing extra to compute.
   */
  async readReceipts(roomId, orgId, actor, messageId = null) {
    await this.assertRoomAccess(roomId, orgId, actor);

    let mark = new Date();
    if (messageId) {
      const message = await this._messageInRoom(messageId, roomId);
      mark = message.createdAt;
    }

    const members = await db.ChatMember.findAll({
      where: { roomId },
      include: [
        { model: db.User, as: 'user', attributes: ['id', 'name', 'avatarUrl'] },
        { model: db.Contact, as: 'contact', attributes: ['id', 'name'] },
      ],
    });

    const seen = [];
    const notSeen = [];
    for (const m of members) {
      const who = {
        id: m.user?.id || m.contact?.id,
        name: m.user?.name || m.contact?.name || 'Someone',
        avatarUrl: m.user?.avatarUrl || null,
        type: m.memberType,
        lastReadAt: m.lastReadAt || null,
      };
      if (m.lastReadAt && new Date(m.lastReadAt) >= new Date(mark)) seen.push(who);
      else notSeen.push(who);
    }
    return { seen, notSeen };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Per-member preferences
  // ══════════════════════════════════════════════════════════════════════════

  async _myMembership(roomId, orgId, actor) {
    await this.assertRoomAccess(roomId, orgId, actor);
    const membership = await this.getMembership(roomId, {
      userId: actor.userId,
      contactId: actor.contactId,
    });
    if (!membership) {
      // Org admins can read a room without being in it; joining them on first
      // preference change is the least surprising behaviour.
      if (actor.isOrgAdmin && actor.userId) {
        return this._upsertUserMember(roomId, actor.userId, 'admin');
      }
      const err = new Error('You are not a member of this room.');
      err.status = 403;
      throw err;
    }
    return membership;
  }

  /** all | mentions | muted — how loudly this room notifies this person. */
  async setNotifyLevel(roomId, orgId, actor, level) {
    if (!['all', 'mentions', 'muted'].includes(level)) {
      const err = new Error('Notification level must be all, mentions or muted.');
      err.status = 400;
      throw err;
    }
    const membership = await this._myMembership(roomId, orgId, actor);
    await membership.update({ notifyLevel: level });
    return { ok: true, notifyLevel: level };
  }

  async setFavorite(roomId, orgId, actor, favorite) {
    const membership = await this._myMembership(roomId, orgId, actor);
    await membership.update({ isFavorite: !!favorite });
    return { ok: true, isFavorite: !!favorite };
  }

  /** Persist the composer's unsent text so switching rooms doesn't lose it. */
  async saveDraft(roomId, orgId, actor, draft) {
    const membership = await this._myMembership(roomId, orgId, actor);
    await membership.update({ draft: String(draft || '').slice(0, 8000) || null });
    return { ok: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Membership at scale
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Add everyone matching a role or department in one action — "add all of
   * Design" instead of twelve individual picks.
   */
  async addMembersBulk(roomId, orgId, actor, { userIds = [], roleKey = null, department = null } = {}) {
    const { room, membership } = await this.assertRoomAccess(roomId, orgId, actor);
    if (!(await this._canManageMembers(room, actor, membership))) {
      const err = new Error('You cannot add people to this room.');
      err.status = 403;
      throw err;
    }
    if (room.roomType === 'dm') {
      const err = new Error('Direct messages are limited to two people.');
      err.status = 400;
      throw err;
    }

    const where = { orgId, isActive: true };
    const include = [];
    if (roleKey) include.push({ model: db.Role, as: 'role', where: { key: roleKey }, required: true });
    if (department) {
      include.push({
        model: db.Worker, as: 'worker', where: { department }, required: true, attributes: ['id'],
      });
    }
    if (userIds.length) where.id = { [Op.in]: userIds };

    // Nothing to match on would silently add the entire org.
    if (!userIds.length && !roleKey && !department) {
      const err = new Error('Choose people, a role, or a department to add.');
      err.status = 400;
      throw err;
    }

    const users = await db.User.findAll({ where, include, attributes: ['id', 'name'] });
    let added = 0;
    for (const u of users) {
      const before = await this.getMembership(roomId, { userId: u.id });
      await this._upsertUserMember(room.id, u.id, 'member');
      if (!before) added += 1;
    }

    if (added) {
      await db.ChatRoomEvent.record(room.id, 'member_added', {
        actorUserId: actor.userId || null,
        summary: `Added ${added} ${added === 1 ? 'person' : 'people'}${roleKey ? ` (role: ${roleKey})` : ''}${department ? ` (department: ${department})` : ''}`,
        meta: { added, roleKey, department },
      });
    }
    return { added, matched: users.length };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  Compliance — export, retention, message→task
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Full transcript of a room as CSV, for disputes and record-keeping. Includes
   * deleted messages (marked as such, with their original text) because the
   * point of an export is the complete record, not the tidy one.
   */
  async exportTranscript(roomId, orgId, actor) {
    const { room } = await this.assertRoomAccess(roomId, orgId, actor);

    const messages = await db.ChatMessage.findAll({
      where: { roomId },
      include: [
        { model: db.User, as: 'senderUser', attributes: ['name'] },
        { model: db.Contact, as: 'senderContact', attributes: ['name'] },
      ],
      order: [['createdAt', 'ASC']],
    });

    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = ['Timestamp,Sender,Type,Message,Attachments,Status'];
    for (const m of messages) {
      const sender = m.senderUser?.name || m.senderContact?.name || 'Unknown';
      const attachments = (m.attachments || []).map((a) => a.name || a.url).join(' | ');
      const status = m.deletedAt ? 'deleted' : (m.editedAt ? 'edited' : '');
      const text = m.deletedAt ? (m.originalBody || '') : m.body;
      lines.push([
        esc(new Date(m.createdAt).toISOString()),
        esc(sender),
        esc(m.senderType),
        esc(mentionPreviewText(text)),
        esc(attachments),
        esc(status),
      ].join(','));
    }

    await db.ChatRoomEvent.record(room.id, 'exported', {
      actorUserId: actor.userId || null,
      summary: `Exported the transcript (${messages.length} messages)`,
    });

    const safeName = String(room.name || 'channel').replace(/[^\w.-]+/g, '-').slice(0, 60);
    return {
      csv: lines.join('\n'),
      filename: `${safeName}-transcript-${new Date().toISOString().slice(0, 10)}.csv`,
      count: messages.length,
    };
  }

  /**
   * Retention sweep — hard-deletes messages past a room's retentionDays.
   *
   * This is the ONE place messages are really removed, and only because an admin
   * explicitly set a retention window on that room. Rooms with no window (the
   * default) are never touched.
   */
  async purgeExpiredMessages() {
    const rooms = await db.ChatRoom.findAll({
      where: { retentionDays: { [Op.ne]: null } },
      attributes: ['id', 'name', 'retentionDays'],
    });

    let total = 0;
    for (const room of rooms) {
      const days = parseInt(room.retentionDays, 10);
      if (!days || days < 1) continue;
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const removed = await db.ChatMessage.destroy({
        where: { roomId: room.id, createdAt: { [Op.lt]: cutoff } },
      });
      if (removed > 0) {
        total += removed;
        await db.ChatRoomEvent.record(room.id, 'purged', {
          summary: `Retention: removed ${removed} message(s) older than ${days} days`,
          meta: { removed, days },
        });
      }
    }
    if (total) console.log(`[ChatService] retention sweep removed ${total} message(s).`);
    return { removed: total };
  }

  /**
   * Turn a message into a task on one of the client's projects.
   *
   * This is the feature Slack structurally cannot offer: the chat and the work
   * tracker are the same system, so "the client asked for this in the thread"
   * becomes an assigned task without anyone retyping it or losing the link back.
   */
  async createTaskFromMessage(roomId, orgId, actor, messageId, {
    projectId, title, assigneeId = null, dueDate = null, remarks = '',
  } = {}) {
    const { room } = await this.assertRoomAccess(roomId, orgId, actor);
    const message = await this._messageInRoom(messageId, roomId);
    if (!actor.userId) {
      const err = new Error('Only team members can create tasks.');
      err.status = 403;
      throw err;
    }

    const project = await db.Project.findOne({ where: { id: projectId, orgId } });
    if (!project) {
      const err = new Error('Project not found.');
      err.status = 404;
      throw err;
    }
    // A client room is tied to one client; a task on someone else's project
    // would leak this conversation into an unrelated account.
    if (room.clientId && project.clientId !== room.clientId) {
      const err = new Error('That project belongs to a different client.');
      err.status = 400;
      throw err;
    }

    const source = mentionPreviewText(message.body).slice(0, 200);
    const taskTitle = String(title || '').trim() || source || 'Task from Messages';

    const task = await db.Task.create({
      id: uuidv4(),
      orgId,
      projectId: project.id,
      // Land the task on the project's current stage — it came out of a live
      // conversation, so it belongs wherever the project actually is.
      stageKey: project.currentStageKey || 'general',
      type: 'chat_request',
      title: taskTitle.slice(0, 255),
      // The assigner's own instructions first, then the quoted message that
      // prompted the task — the assignee needs the ask and its context.
      remarks: [
        String(remarks || '').trim(),
        `From Messages · ${room.name}\n"${mentionPreviewText(message.body)}"`,
      ].filter(Boolean).join('\n\n'),
      status: 'todo',
      assigneeId: assigneeId || null,
      dueAt: dueDate || null,
      // The trail back to the conversation this came out of.
      refTable: 'chat_messages',
      refId: message.id,
      createdBy: actor.userId,
    });

    await db.ChatRoomEvent.record(room.id, 'task_created', {
      actorUserId: actor.userId,
      summary: `Created task "${task.title}"`,
      meta: { taskId: task.id, messageId: message.id, projectId: project.id },
    });

    return task;
  }
}

module.exports = new ChatService();
