import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  commentSchema,
  threadSchema,
  identitySchema,
  type Comment,
  type SharedThread,
  type Identity,
  type Snapshot,
} from "../shared/protocol";
import { messageRequestSchema, type MessageRequest } from "../shared/requests";

export type Link = {
  localId: string;
  sharedId: string;
  revision: number;
  enabled: number;
  dirty: number;
  terminal: number;
  contentHash: string | null;
  payload: string | null;
};

/** Every query is scoped, including IDs that can collide on independent relays. */
export class LocalStore {
  constructor(
    readonly db: Database.Database,
    readonly projectId: string,
  ) {}
  static migrations = [
    `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE links (localId TEXT PRIMARY KEY, sharedId TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1, contentHash TEXT, payload TEXT)`,
    `CREATE TABLE cache_threads (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE cache_comments (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `ALTER TABLE links ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE cache_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    // Append-only migration: retain the project association until the legacy
    // credential has been moved in secret settings (never copy secrets to SQL).
    `CREATE TABLE local_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     INSERT INTO local_meta SELECT 'legacyCredentialProject', json_extract(value, '$.projectId') FROM state WHERE key='connection';
     CREATE TABLE project_state (projectId TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(projectId, key));
     CREATE TABLE project_links (
       projectId TEXT NOT NULL, localId TEXT NOT NULL, sharedId TEXT NOT NULL,
       revision INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1,
       contentHash TEXT, payload TEXT, terminal INTEGER NOT NULL DEFAULT 0,
       PRIMARY KEY(projectId, localId), UNIQUE(projectId, sharedId)
     );
     CREATE TABLE project_threads (projectId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId, id));
     CREATE TABLE project_comments (projectId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId, id));
     CREATE TABLE project_requests (projectId TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(projectId, id));
     INSERT INTO project_state SELECT m.value, s.key, s.value FROM state s JOIN local_meta m ON m.key='legacyCredentialProject';
     INSERT INTO project_links SELECT m.value, l.localId, l.sharedId, l.revision, l.enabled, l.dirty, l.contentHash, l.payload, l.terminal
       FROM links l JOIN local_meta m ON m.key='legacyCredentialProject';
     INSERT INTO project_threads SELECT m.value, c.id, c.data FROM cache_threads c JOIN local_meta m ON m.key='legacyCredentialProject';
     INSERT INTO project_comments SELECT m.value, c.id, c.data FROM cache_comments c JOIN local_meta m ON m.key='legacyCredentialProject';
     INSERT INTO project_requests SELECT m.value, c.id, c.data FROM cache_requests c JOIN local_meta m ON m.key='legacyCredentialProject';
     DROP TABLE state; DROP TABLE links; DROP TABLE cache_threads; DROP TABLE cache_comments; DROP TABLE cache_requests;`,
  ];
  static projectIds(db: Database.Database): string[] {
    return (
      db
        .prepare(
          "SELECT projectId FROM project_state WHERE key='connection' ORDER BY projectId",
        )
        .all() as { projectId: string }[]
    ).map((r) => r.projectId);
  }
  state<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db
      .prepare("SELECT value FROM project_state WHERE projectId=? AND key=?")
      .get(this.projectId, key) as { value: string } | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO project_state VALUES (?, ?, ?)")
      .run(this.projectId, key, JSON.stringify(value));
  }
  reset() {
    this.db.transaction(() => {
      for (const table of [
        "project_state",
        "project_links",
        "project_threads",
        "project_comments",
        "project_requests",
      ])
        this.db
          .prepare(`DELETE FROM ${table} WHERE projectId=?`)
          .run(this.projectId);
    })();
  }
  identity() {
    return this.state("identity", identitySchema);
  }
  links() {
    return this.db
      .prepare("SELECT * FROM project_links WHERE projectId=? ORDER BY localId")
      .all(this.projectId) as Link[];
  }
  link(localId: string) {
    return this.db
      .prepare("SELECT * FROM project_links WHERE projectId=? AND localId=?")
      .get(this.projectId, localId) as Link | undefined;
  }
  enable(localId: string) {
    this.db
      .prepare(
        `INSERT INTO project_links(projectId, localId, sharedId) VALUES (?, ?, ?)
      ON CONFLICT(projectId, localId) DO UPDATE SET enabled=1, dirty=1`,
      )
      .run(this.projectId, localId, randomUUID());
  }
  pause(localId: string) {
    this.db
      .prepare(
        "UPDATE project_links SET enabled=0, payload=NULL, contentHash=NULL WHERE projectId=? AND localId=?",
      )
      .run(this.projectId, localId);
  }
  dirty(localId: string) {
    this.db
      .prepare(
        "UPDATE project_links SET dirty=1 WHERE projectId=? AND localId=? AND enabled=1 AND terminal=0",
      )
      .run(this.projectId, localId);
  }
  clearDirty(localId: string, terminal = false) {
    this.db
      .prepare(
        "UPDATE project_links SET dirty=0, terminal=? WHERE projectId=? AND localId=?",
      )
      .run(Number(terminal), this.projectId, localId);
  }
  prepare(localId: string, snapshot: Omit<Snapshot, "revision">, hash: string) {
    const link = this.link(localId)!;
    if (link.contentHash === hash) return;
    const payload: Snapshot = { ...snapshot, revision: link.revision + 1 };
    this.db
      .prepare(
        "UPDATE project_links SET revision=?, contentHash=?, payload=? WHERE projectId=? AND localId=?",
      )
      .run(
        payload.revision,
        hash,
        JSON.stringify(payload),
        this.projectId,
        localId,
      );
  }
  ack(localId: string, revision: number) {
    this.db
      .prepare(
        "UPDATE project_links SET payload=NULL WHERE projectId=? AND localId=? AND revision=?",
      )
      .run(this.projectId, localId, revision);
  }
  thread(value: SharedThread) {
    this.db
      .prepare("INSERT OR REPLACE INTO project_threads VALUES (?, ?, ?)")
      .run(this.projectId, value.id, JSON.stringify(value));
  }
  comment(value: Comment) {
    this.db
      .prepare("INSERT OR REPLACE INTO project_comments VALUES (?, ?, ?)")
      .run(this.projectId, value.id, JSON.stringify(value));
  }
  threads(): SharedThread[] {
    return (
      this.db
        .prepare(
          "SELECT data FROM project_threads WHERE projectId=? ORDER BY id",
        )
        .all(this.projectId) as { data: string }[]
    ).map((r) => threadSchema.parse(JSON.parse(r.data)));
  }
  getThread(id: string): SharedThread | null {
    const row = this.db
      .prepare("SELECT data FROM project_threads WHERE projectId=? AND id=?")
      .get(this.projectId, id) as { data: string } | undefined;
    return row ? threadSchema.parse(JSON.parse(row.data)) : null;
  }
  comments(threadId: string): Comment[] {
    return (
      this.db
        .prepare("SELECT data FROM project_comments WHERE projectId=?")
        .all(this.projectId) as { data: string }[]
    )
      .map((r) => commentSchema.parse(JSON.parse(r.data)))
      .filter((c) => c.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  request(value: MessageRequest) {
    const previous = this.getRequest(value.id);
    if (!previous || value.version >= previous.version)
      this.db
        .prepare("INSERT OR REPLACE INTO project_requests VALUES (?, ?, ?)")
        .run(this.projectId, value.id, JSON.stringify(value));
  }
  getRequest(id: string): MessageRequest | null {
    const row = this.db
      .prepare("SELECT data FROM project_requests WHERE projectId=? AND id=?")
      .get(this.projectId, id) as { data: string } | undefined;
    return row ? messageRequestSchema.parse(JSON.parse(row.data)) : null;
  }
  requests(): MessageRequest[] {
    return (
      this.db
        .prepare("SELECT data FROM project_requests WHERE projectId=?")
        .all(this.projectId) as { data: string }[]
    )
      .map((row) => messageRequestSchema.parse(JSON.parse(row.data)))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }
  cacheIdentity(value: Identity) {
    this.set("identity", value);
  }
}
