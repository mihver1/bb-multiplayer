import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { id, uuid } from "../shared/protocol";
import { mirrorBatchSchema, type MirrorBatch } from "./contracts";

const mirrorSchema = z.object({
  id: uuid,
  sharedId: uuid,
  roomId: uuid,
  memberId: uuid,
  projectId: id,
  hostId: id,
  localId: id.nullable(),
  state: z.enum(["creating", "ready", "blocked"]),
});
export type Mirror = z.infer<typeof mirrorSchema>;
export const mirrorMigrations = [
  `CREATE TABLE native_mirrors (id TEXT PRIMARY KEY, sharedId TEXT NOT NULL, roomId TEXT NOT NULL, memberId TEXT NOT NULL, projectId TEXT NOT NULL, hostId TEXT NOT NULL, localId TEXT UNIQUE, state TEXT NOT NULL, UNIQUE(roomId, memberId, projectId, sharedId))`,
  `CREATE TABLE mirror_imports (mirrorId TEXT NOT NULL, sourceId TEXT NOT NULL, version TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(mirrorId, sourceId))`,
  `CREATE TABLE mirror_batches (mirrorId TEXT PRIMARY KEY, data TEXT NOT NULL)`,
];
export class MirrorStore {
  constructor(readonly db: Database.Database) {}
  list(): Mirror[] {
    return this.db
      .prepare("SELECT * FROM native_mirrors")
      .all()
      .map((row) => mirrorSchema.parse(row));
  }
  byLocal(localId: string): Mirror | null {
    const row = this.db
      .prepare("SELECT * FROM native_mirrors WHERE localId=?")
      .get(localId);
    return row ? mirrorSchema.parse(row) : null;
  }
  byId(id: string): Mirror | null {
    const row = this.db
      .prepare("SELECT * FROM native_mirrors WHERE id=?")
      .get(id);
    return row ? mirrorSchema.parse(row) : null;
  }
  find(
    scope: Pick<Mirror, "roomId" | "memberId" | "projectId" | "sharedId">,
  ): Mirror | null {
    const row = this.db
      .prepare(
        "SELECT * FROM native_mirrors WHERE roomId=? AND memberId=? AND projectId=? AND sharedId=?",
      )
      .get(scope.roomId, scope.memberId, scope.projectId, scope.sharedId);
    return row ? mirrorSchema.parse(row) : null;
  }
  reserve(scope: Omit<Mirror, "id" | "localId" | "state">): Mirror {
    const value: Mirror = {
      ...scope,
      id: randomUUID(),
      localId: null,
      state: "creating",
    };
    this.db
      .prepare(
        "INSERT INTO native_mirrors VALUES (@id,@sharedId,@roomId,@memberId,@projectId,@hostId,@localId,@state)",
      )
      .run(value);
    return value;
  }
  bind(id: string, localId: string) {
    this.db
      .prepare(
        "UPDATE native_mirrors SET localId=?, state='ready' WHERE id=? AND (localId IS NULL OR localId=?)",
      )
      .run(localId, id, localId);
  }
  block(id: string) {
    this.db
      .prepare("UPDATE native_mirrors SET state='blocked' WHERE id=?")
      .run(id);
  }
  blockAll() {
    this.db.exec("UPDATE native_mirrors SET state='blocked'");
  }
  imported(mirrorId: string): Map<string, { version: string; role: string }> {
    return new Map(
      (
        this.db
          .prepare(
            "SELECT sourceId,version,role FROM mirror_imports WHERE mirrorId=?",
          )
          .all(mirrorId) as {
          sourceId: string;
          version: string;
          role: string;
        }[]
      ).map((row) => [row.sourceId, row]),
    );
  }
  pending(mirrorId: string): MirrorBatch | null {
    const row = this.db
      .prepare("SELECT data FROM mirror_batches WHERE mirrorId=?")
      .get(mirrorId) as { data: string } | undefined;
    return row ? mirrorBatchSchema.parse(JSON.parse(row.data)) : null;
  }
  prepare(mirrorId: string, batch: MirrorBatch) {
    this.db
      .prepare("INSERT INTO mirror_batches VALUES (?,?)")
      .run(mirrorId, JSON.stringify(batch));
  }
  commit(mirrorId: string, batchId: string) {
    this.db.transaction(() => {
      const batch = this.pending(mirrorId);
      if (!batch || batch.id !== batchId)
        throw new Error("Unknown mirror batch");
      for (const entry of batch.entries)
        this.db
          .prepare("INSERT OR REPLACE INTO mirror_imports VALUES (?,?,?,?)")
          .run(mirrorId, entry.sourceId, entry.version, entry.sourceRole);
      this.db
        .prepare("DELETE FROM mirror_batches WHERE mirrorId=?")
        .run(mirrorId);
    })();
  }
}
export function proposalId(mirrorId: string, requestId: string): string {
  const hex = createHash("sha256")
    .update(`multiplayer-mirror\0${mirrorId}\0${requestId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "4";
  hex[16] = "8";
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
