import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  ProtocolError,
  name,
  snapshotSchema,
  threadSchema,
  commentSchema,
  type Identity,
  type NewComment,
  type SharedThread,
  type Snapshot,
  type Comment,
} from "../shared/protocol";

import {
  createRoomSchema,
  REMOTE_ROOM_LIMIT,
  type CreateRoom,
} from "../shared/rooms";
import {
  messageRequestSchema,
  type MessageRequest,
  type NewMessageRequest,
  type ReviewMessageRequest,
} from "../shared/requests";

export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
type Actor = {
  id: string;
  roomId: string;
  name: string;
  role: "owner" | "member";
  lastSeenAt: number;
  revoked: number;
};
const fail = (status: number, message: string): never => {
  throw new ProtocolError(status, message);
};

export class RelayStore {
  constructor(
    readonly db: Database.Database,
    private now = Date.now,
  ) {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), name TEXT NOT NULL,
        role TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE, lastSeenAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS invites (
        codeHash TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), expiresAt INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), ownerId TEXT NOT NULL REFERENCES members(id),
        revision INTEGER NOT NULL, contentHash TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), threadId TEXT NOT NULL REFERENCES threads(id),
        authorId TEXT NOT NULL REFERENCES members(id), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, roomId TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_room ON events(roomId, seq);
      CREATE INDEX IF NOT EXISTS threads_room ON threads(roomId, id);
      CREATE INDEX IF NOT EXISTS comments_thread ON comments(roomId, threadId, id);
      CREATE TABLE IF NOT EXISTS message_requests (
        id TEXT PRIMARY KEY, roomId TEXT NOT NULL REFERENCES rooms(id), threadId TEXT NOT NULL REFERENCES threads(id),
        authorId TEXT NOT NULL REFERENCES members(id), ownerId TEXT NOT NULL REFERENCES members(id), data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS request_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, requestId TEXT NOT NULL REFERENCES message_requests(id));
      CREATE INDEX IF NOT EXISTS requests_participants ON message_requests(roomId, ownerId, authorId);
      CREATE TABLE IF NOT EXISTS room_creations (
        creatorId TEXT NOT NULL REFERENCES members(id), requestId TEXT NOT NULL,
        roomId TEXT NOT NULL REFERENCES rooms(id), memberId TEXT NOT NULL REFERENCES members(id),
        name TEXT NOT NULL, tokenHash TEXT NOT NULL,
        PRIMARY KEY(creatorId, requestId)
      );
    `);
  }
  private event(roomId: string, kind: string, id: string) {
    this.db
      .prepare("INSERT INTO events(roomId, kind, id) VALUES (?, ?, ?)")
      .run(roomId, kind, id);
  }
  initialize(roomName: string, ownerName: string) {
    return this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM rooms LIMIT 1").get())
        fail(409, "Database already initialized");
      return this.createRoom(roomName, ownerName);
    })();
  }
  // Local operator bootstrap. Remote provisioning uses the owner-only method below.
  createRoom(roomName: string, ownerName: string) {
    roomName = name.parse(roomName);
    ownerName = name.parse(ownerName);
    return this.db.transaction(() => {
      const roomId = randomUUID(),
        memberId = randomUUID(),
        token = secret();
      this.db.prepare("INSERT INTO rooms VALUES (?, ?)").run(roomId, roomName);
      this.db
        .prepare("INSERT INTO members VALUES (?, ?, ?, 'owner', ?, ?, 0)")
        .run(memberId, roomId, ownerName, digest(token), this.now());
      return { roomId, memberId, token };
    })();
  }
  createRoomForOwner(actor: Actor, input: CreateRoom) {
    input = createRoomSchema.parse(input);
    return this.db.transaction(() => {
      const current = this.db
        .prepare(
          "SELECT role FROM members WHERE id=? AND roomId=? AND revoked=0",
        )
        .get(actor.id, actor.roomId) as { role: string } | undefined;
      if (!current) return fail(401, "Invalid or revoked member credential");
      if (current.role !== "owner")
        fail(403, "Only a room owner can create rooms");
      const existing = this.db
        .prepare(
          "SELECT roomId, memberId, name, tokenHash FROM room_creations WHERE creatorId=? AND requestId=?",
        )
        .get(actor.id, input.requestId) as
        | { roomId: string; memberId: string; name: string; tokenHash: string }
        | undefined;
      if (existing) {
        if (
          existing.name !== input.name ||
          existing.tokenHash !== input.tokenHash
        )
          fail(409, "Room creation request already contains different data");
        return { roomId: existing.roomId, memberId: existing.memberId };
      }
      // Global cap: a newly-created owner cannot evade it by creating more owners.
      const count = this.db
        .prepare("SELECT count(*) AS n FROM rooms")
        .get() as { n: number };
      if (count.n >= REMOTE_ROOM_LIMIT)
        fail(409, "Remote room creation limit reached");
      if (
        this.db
          .prepare("SELECT 1 FROM members WHERE tokenHash=?")
          .get(input.tokenHash)
      )
        fail(409, "A new room requires a unique owner credential");
      const roomId = randomUUID(),
        memberId = randomUUID();
      this.db
        .prepare("INSERT INTO rooms VALUES (?, ?)")
        .run(roomId, input.name);
      this.db
        .prepare("INSERT INTO members VALUES (?, ?, ?, 'owner', ?, ?, 0)")
        .run(memberId, roomId, actor.name, input.tokenHash, this.now());
      this.db
        .prepare("INSERT INTO room_creations VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          actor.id,
          input.requestId,
          roomId,
          memberId,
          input.name,
          input.tokenHash,
        );
      return { roomId, memberId };
    })();
  }
  listRooms(after = "") {
    const rows = this.db
      .prepare("SELECT id, name FROM rooms WHERE id > ? ORDER BY id LIMIT 51")
      .all(after) as { id: string; name: string }[];
    const rooms = rows.slice(0, 50);
    return {
      rooms,
      nextCursor: rows.length > 50 ? rooms.at(-1)!.id : null,
    };
  }
  authenticate(token: string): Actor {
    const actor = this.db
      .prepare("SELECT * FROM members WHERE tokenHash = ? AND revoked = 0")
      .get(digest(token)) as Actor | undefined;
    if (!actor) return fail(401, "Invalid or revoked member credential");
    return actor;
  }
  identity(actor: Actor): Identity {
    this.db
      .prepare("UPDATE members SET lastSeenAt = ? WHERE id = ?")
      .run(this.now(), actor.id);
    const room = this.db
      .prepare("SELECT id, name FROM rooms WHERE id = ?")
      .get(actor.roomId) as Identity["room"];
    const members = (
      this.db
        .prepare(
          "SELECT id, name, role, lastSeenAt, revoked FROM members WHERE roomId = ? ORDER BY name LIMIT 100",
        )
        .all(actor.roomId) as Actor[]
    ).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role,
      lastSeenAt: m.lastSeenAt,
      revoked: Boolean(m.revoked),
    }));
    return { room, member: members.find((m) => m.id === actor.id)!, members };
  }
  invite(actor: Actor) {
    if (actor.role !== "owner")
      fail(403, "Only the room owner can invite members");
    const code = secret(),
      expiresAt = this.now() + 24 * 60 * 60 * 1000;
    this.db
      .prepare("INSERT INTO invites VALUES (?, ?, ?, 0)")
      .run(digest(code), actor.roomId, expiresAt);
    return { code, expiresAt };
  }
  join(code: string, name: string) {
    return this.db.transaction(() => {
      const invite = this.db
        .prepare(
          "SELECT roomId FROM invites WHERE codeHash = ? AND used = 0 AND expiresAt > ?",
        )
        .get(digest(code), this.now()) as { roomId: string } | undefined;
      if (!invite)
        return fail(403, "Invitation is invalid, expired, or already used");
      const count = this.db
        .prepare("SELECT count(*) AS n FROM members WHERE roomId = ?")
        .get(invite.roomId) as { n: number };
      if (count.n >= 100)
        fail(
          409,
          "Prototype room limit: 100 members including revoked members",
        );
      this.db
        .prepare("UPDATE invites SET used = 1 WHERE codeHash = ?")
        .run(digest(code));
      const id = randomUUID(),
        token = secret();
      this.db
        .prepare("INSERT INTO members VALUES (?, ?, ?, 'member', ?, ?, 0)")
        .run(id, invite.roomId, name, digest(token), this.now());
      this.event(invite.roomId, "member", id);
      return { token };
    })();
  }
  revoke(actor: Actor, memberId: string) {
    if (actor.role !== "owner" || memberId === actor.id)
      fail(403, "Only the owner can revoke other members");
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          "UPDATE members SET revoked = 1 WHERE roomId = ? AND id = ? AND role != 'owner'",
        )
        .run(actor.roomId, memberId);
      if (!result.changes) fail(404, "Member not found");
      this.event(actor.roomId, "member", memberId);
    })();
  }
  thread(actor: Actor, id: string): SharedThread {
    const row = this.db
      .prepare("SELECT data FROM threads WHERE roomId = ? AND id = ?")
      .get(actor.roomId, id) as { data: string } | undefined;
    if (!row) return fail(404, "Thread not found");
    return threadSchema.parse(JSON.parse(row.data));
  }
  publish(actor: Actor, snapshot: Snapshot) {
    snapshot = snapshotSchema.parse(snapshot);
    return this.db.transaction(() => {
      const old = this.db
        .prepare(
          "SELECT roomId, ownerId, revision, contentHash FROM threads WHERE id = ?",
        )
        .get(snapshot.id) as
        | {
            roomId: string;
            ownerId: string;
            revision: number;
            contentHash: string;
          }
        | undefined;
      if (old && (old.roomId !== actor.roomId || old.ownerId !== actor.id))
        fail(403, "This thread belongs to another member");
      const contentHash = digest(JSON.stringify(snapshot));
      if (old && snapshot.revision <= old.revision) {
        if (
          snapshot.revision === old.revision &&
          contentHash !== old.contentHash
        )
          fail(409, "Revision already contains different data");
        return { revision: old.revision }; // Lost acknowledgement / out-of-order replay.
      }
      for (const message of snapshot.messages) {
        if (digest(message.text) !== message.version)
          fail(422, "Invalid message version");
      }
      const thread: SharedThread = {
        ...snapshot,
        ownerId: actor.id,
        updatedAt: this.now(),
      };
      this.db
        .prepare(
          `INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, contentHash=excluded.contentHash, data=excluded.data`,
        )
        .run(
          snapshot.id,
          actor.roomId,
          actor.id,
          snapshot.revision,
          contentHash,
          JSON.stringify(thread),
        );
      this.event(actor.roomId, "thread", snapshot.id);
      return { revision: snapshot.revision };
    })();
  }
  threads(actor: Actor, after: string) {
    return (
      this.db
        .prepare(
          "SELECT data FROM threads WHERE roomId = ? AND id > ? ORDER BY id LIMIT 50",
        )
        .all(actor.roomId, after) as { data: string }[]
    ).map((row) => {
      const { messages: _, ...summary } = threadSchema.parse(
        JSON.parse(row.data),
      );
      return summary;
    });
  }
  comments(actor: Actor, threadId: string, after: string): Comment[] {
    this.thread(actor, threadId);
    return (
      this.db
        .prepare(
          "SELECT data FROM comments WHERE roomId = ? AND threadId = ? AND id > ? ORDER BY id LIMIT 50",
        )
        .all(actor.roomId, threadId, after) as { data: string }[]
    ).map((row) => commentSchema.parse(JSON.parse(row.data)));
  }
  comment(actor: Actor, id: string): Comment {
    const row = this.db
      .prepare("SELECT data FROM comments WHERE roomId = ? AND id = ?")
      .get(actor.roomId, id) as { data: string } | undefined;
    if (!row) return fail(404, "Comment not found");
    return commentSchema.parse(JSON.parse(row.data));
  }
  addComment(actor: Actor, input: NewComment): Comment {
    return this.db.transaction(() => {
      const thread = this.thread(actor, input.threadId);
      const existing = this.db
        .prepare("SELECT data FROM comments WHERE id = ?")
        .get(input.id) as { data: string } | undefined;
      if (existing) {
        const old = commentSchema.parse(JSON.parse(existing.data));
        if (
          old.authorId !== actor.id ||
          old.threadId !== input.threadId ||
          old.body !== input.body ||
          old.parentId !== input.parentId ||
          JSON.stringify(old.anchor) !== JSON.stringify(input.anchor)
        )
          fail(409, "Comment ID already in use");
        return old;
      }
      if (input.parentId) {
        const parent = this.comment(actor, input.parentId);
        if (
          parent.threadId !== input.threadId ||
          parent.parentId !== null ||
          input.anchor !== null
        )
          fail(422, "Reply must reference a root discussion in this thread");
      }
      if (input.anchor) {
        const message = thread.messages.find(
          (m) => m.id === input.anchor!.messageId,
        );
        if (
          !message ||
          message.version !== input.anchor.version ||
          !message.text.includes(input.anchor.quote)
        ) {
          fail(409, "Message changed; reload and select the quotation again");
        }
      }
      const comment: Comment = {
        ...input,
        authorId: actor.id,
        createdAt: this.now(),
        resolved: false,
        version: 1,
      };
      this.db
        .prepare("INSERT INTO comments VALUES (?, ?, ?, ?, ?)")
        .run(
          input.id,
          actor.roomId,
          input.threadId,
          actor.id,
          JSON.stringify(comment),
        );
      this.event(actor.roomId, "comment", input.id);
      return comment;
    })();
  }
  resolve(
    actor: Actor,
    id: string,
    expectedVersion: number,
    resolved: boolean,
  ): Comment {
    return this.db.transaction(() => {
      const comment = this.comment(actor, id),
        thread = this.thread(actor, comment.threadId);
      if (comment.parentId)
        fail(422, "Resolve the root discussion, not a reply");
      if (
        actor.id !== comment.authorId &&
        actor.id !== thread.ownerId &&
        actor.role !== "owner"
      )
        fail(403, "Only the author or owner can resolve this discussion");
      if (comment.version !== expectedVersion)
        fail(409, "Discussion changed; reload before resolving");
      const next = { ...comment, resolved, version: comment.version + 1 };
      this.db
        .prepare("UPDATE comments SET data = ? WHERE id = ?")
        .run(JSON.stringify(next), id);
      this.event(actor.roomId, "comment", id);
      return next;
    })();
  }
  request(actor: Actor, id: string): MessageRequest {
    const row = this.db
      .prepare(
        "SELECT data FROM message_requests WHERE id=? AND roomId=? AND (ownerId=? OR authorId=?)",
      )
      .get(id, actor.roomId, actor.id, actor.id) as
      { data: string } | undefined;
    if (!row) return fail(404, "Request not found");
    return messageRequestSchema.parse(JSON.parse(row.data));
  }
  createRequest(actor: Actor, input: NewMessageRequest): MessageRequest {
    return this.db.transaction(() => {
      const thread = this.thread(actor, input.threadId);
      if (thread.ownerId === actor.id)
        fail(422, "Use your own local thread composer");
      const previous = this.db
        .prepare("SELECT data FROM message_requests WHERE id=?")
        .get(input.id) as { data: string } | undefined;
      if (previous) {
        const request = messageRequestSchema.parse(JSON.parse(previous.data));
        if (
          request.authorId !== actor.id ||
          request.threadId !== input.threadId ||
          request.body !== input.body
        )
          fail(409, "Request ID already in use");
        return request;
      }
      const owner = this.db
        .prepare("SELECT id FROM members WHERE id=? AND roomId=? AND revoked=0")
        .get(thread.ownerId, actor.roomId);
      if (!owner || thread.status === "deleted" || thread.status === "archived")
        fail(409, "Thread owner or thread unavailable");
      const request: MessageRequest = {
        ...input,
        authorId: actor.id,
        ownerId: thread.ownerId,
        status: "pending",
        version: 1,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      this.db
        .prepare("INSERT INTO message_requests VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          request.id,
          actor.roomId,
          request.threadId,
          actor.id,
          thread.ownerId,
          JSON.stringify(request),
        );
      this.db
        .prepare("INSERT INTO request_events(requestId) VALUES (?)")
        .run(request.id);
      return request;
    })();
  }
  reviewRequest(actor: Actor, input: ReviewMessageRequest): MessageRequest {
    return this.db.transaction(() => {
      const request = this.request(actor, input.id);
      if (request.ownerId !== actor.id)
        fail(403, "Only the thread owner can review this request");
      if (request.version !== input.version || request.status !== "pending") {
        if (
          request.version === input.version + 1 &&
          request.status === input.status
        )
          return request;
        fail(409, "Request changed; reload before reviewing");
      }
      const next = {
        ...request,
        status: input.status,
        version: request.version + 1,
        updatedAt: this.now(),
      };
      this.db
        .prepare("UPDATE message_requests SET data=? WHERE id=?")
        .run(JSON.stringify(next), input.id);
      this.db
        .prepare("INSERT INTO request_events(requestId) VALUES (?)")
        .run(input.id);
      return next;
    })();
  }
  requestEvents(actor: Actor, after: number) {
    const rows = this.db
      .prepare(
        `SELECT e.seq, r.data FROM request_events e JOIN message_requests r ON r.id=e.requestId
      WHERE e.seq>? AND r.roomId=? AND (r.ownerId=? OR r.authorId=?) ORDER BY e.seq LIMIT 50`,
      )
      .all(after, actor.roomId, actor.id, actor.id) as {
      seq: number;
      data: string;
    }[];
    return {
      cursor: rows.at(-1)?.seq ?? after,
      events: rows.map((row) => ({
        seq: row.seq,
        request: messageRequestSchema.parse(JSON.parse(row.data)),
      })),
    };
  }
  events(actor: Actor, after: number) {
    const events = this.db
      .prepare(
        "SELECT seq, kind, id FROM events WHERE roomId = ? AND seq > ? ORDER BY seq LIMIT 50",
      )
      .all(actor.roomId, after) as {
      seq: number;
      kind: "thread" | "comment" | "member";
      id: string;
    }[];
    return { events, cursor: events.at(-1)?.seq ?? after };
  }
}
