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
export class LocalStore {
  constructor(readonly db: Database.Database) {}
  static migrations = [
    `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE links (localId TEXT PRIMARY KEY, sharedId TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1, dirty INTEGER NOT NULL DEFAULT 1, contentHash TEXT, payload TEXT)`,
    `CREATE TABLE cache_threads (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `CREATE TABLE cache_comments (id TEXT PRIMARY KEY, data TEXT NOT NULL)`,
    `ALTER TABLE links ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0`,
  ];
  state<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db
      .prepare("SELECT value FROM state WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? schema.parse(JSON.parse(row.value)) : null;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO state VALUES (?, ?)")
      .run(key, JSON.stringify(value));
  }
  reset() {
    this.db.exec(
      "DELETE FROM state; DELETE FROM links; DELETE FROM cache_threads; DELETE FROM cache_comments;",
    );
  }
  identity() {
    return this.state("identity", identitySchema);
  }
  links() {
    return this.db
      .prepare("SELECT * FROM links ORDER BY localId")
      .all() as Link[];
  }
  link(localId: string) {
    return this.db
      .prepare("SELECT * FROM links WHERE localId = ?")
      .get(localId) as Link | undefined;
  }
  enable(localId: string) {
    this.db
      .prepare(
        `INSERT INTO links(localId, sharedId) VALUES (?, ?)
      ON CONFLICT(localId) DO UPDATE SET enabled=1, dirty=1`,
      )
      .run(localId, randomUUID());
  }
  pause(localId: string) {
    this.db
      .prepare(
        "UPDATE links SET enabled=0, payload=NULL, contentHash=NULL WHERE localId=?",
      )
      .run(localId);
  }
  dirty(localId: string) {
    this.db
      .prepare(
        "UPDATE links SET dirty=1 WHERE localId=? AND enabled=1 AND terminal=0",
      )
      .run(localId);
  }
  prepare(localId: string, snapshot: Omit<Snapshot, "revision">, hash: string) {
    const link = this.link(localId)!;
    if (link.contentHash === hash) return;
    const payload: Snapshot = { ...snapshot, revision: link.revision + 1 };
    this.db
      .prepare(
        "UPDATE links SET revision=?, contentHash=?, payload=? WHERE localId=?",
      )
      .run(payload.revision, hash, JSON.stringify(payload), localId);
  }
  ack(localId: string, revision: number) {
    this.db
      .prepare("UPDATE links SET payload=NULL WHERE localId=? AND revision=?")
      .run(localId, revision);
  }
  thread(value: SharedThread) {
    this.db
      .prepare("INSERT OR REPLACE INTO cache_threads VALUES (?, ?)")
      .run(value.id, JSON.stringify(value));
  }
  comment(value: Comment) {
    this.db
      .prepare("INSERT OR REPLACE INTO cache_comments VALUES (?, ?)")
      .run(value.id, JSON.stringify(value));
  }
  threads(): SharedThread[] {
    return (
      this.db.prepare("SELECT data FROM cache_threads ORDER BY id").all() as {
        data: string;
      }[]
    ).map((r) => threadSchema.parse(JSON.parse(r.data)));
  }
  getThread(id: string): SharedThread | null {
    const row = this.db
      .prepare("SELECT data FROM cache_threads WHERE id=?")
      .get(id) as { data: string } | undefined;
    return row ? threadSchema.parse(JSON.parse(row.data)) : null;
  }
  comments(threadId: string): Comment[] {
    return (
      this.db.prepare("SELECT data FROM cache_comments").all() as {
        data: string;
      }[]
    )
      .map((r) => commentSchema.parse(JSON.parse(r.data)))
      .filter((c) => c.threadId === threadId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  cacheIdentity(value: Identity) {
    this.set("identity", value);
  }
}
