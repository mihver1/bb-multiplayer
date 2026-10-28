import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RelayStore, digest, secret } from "../relay/store";
import { createRelayServer } from "../relay/http";
import {
  canCreateRooms,
  identitySchema,
  memberSchema,
} from "../shared/protocol";
import { REMOTE_ROOM_LIMIT } from "../shared/rooms";

let directory: string,
  db: Database.Database,
  store: RelayStore,
  server: ReturnType<typeof createRelayServer>,
  url: string;
let ownerToken: string, memberToken: string, otherToken: string;
const owner = () => store.authenticate(ownerToken);
const member = () => store.authenticate(memberToken);
const creation = () => ({
  requestId: randomUUID(),
  name: "Admin's project",
  tokenHash: digest(secret()),
});
async function post(
  token: string,
  path: string,
  input: unknown,
  origin?: string,
) {
  const response = await fetch(`${url}/v1/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() };
}
async function identity(token: string) {
  const response = await fetch(`${url}/v1/me`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return identitySchema.parse(await response.json());
}
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "multiplayer-admins-"));
  db = new Database(join(directory, "relay.db"));
  store = new RelayStore(db);
  ownerToken = store.initialize("Source room", "Alice").token;
  memberToken = store.join(store.invite(owner()).code, "Bob").token;
  otherToken = store.join(store.invite(owner()).code, "Carol").token;
  server = createRelayServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

it("lets the room owner appoint an admin who can provision isolated rooms with a separate owner credential", async () => {
  expect(canCreateRooms((await identity(memberToken)).member)).toBe(false);
  const result = await post(ownerToken, "member-admin", {
    memberId: member().id,
    admin: true,
  });
  expect(result).toEqual({ status: 200, data: { ok: true } });
  const promoted = await identity(memberToken);
  expect(promoted.member).toMatchObject({ role: "member", admin: true });
  expect(promoted.capabilities?.memberAdministration).toBe(true);
  expect(canCreateRooms(promoted.member)).toBe(true);
  const token = secret(),
    input = { ...creation(), tokenHash: digest(token) };
  const created = await post(memberToken, "rooms", input);
  expect(created.status).toBe(200);
  const newOwner = store.authenticate(token);
  expect(newOwner).toMatchObject({
    id: created.data.memberId,
    roomId: created.data.roomId,
    role: "owner",
    name: "Bob",
  });
  expect(store.identity(newOwner).members).toHaveLength(1);
  expect(store.threads(newOwner, "")).toEqual([]);
  expect((await identity(ownerToken)).room.id).not.toBe(created.data.roomId);
  expect((await identity(ownerToken)).members).toHaveLength(3);
  for (const value of [
    result,
    promoted,
    created,
    db.prepare("SELECT * FROM member_admins").all(),
  ])
    for (const credential of [token, ownerToken, memberToken])
      expect(JSON.stringify(value)).not.toContain(credential);
});

it("denies self-promotion, delegation, membership management and changes outside the owner's room", async () => {
  const input = { memberId: member().id, admin: true };
  expect((await post("", "member-admin", input)).status).toBe(401);
  expect((await post(memberToken, "member-admin", input)).status).toBe(403);
  expect(
    (await post(ownerToken, "member-admin", input, "https://evil.example"))
      .status,
  ).toBe(403);
  expect(
    (
      await post(ownerToken, "member-admin", {
        memberId: owner().id,
        admin: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await post(ownerToken, "member-admin", {
        memberId: owner().id,
        admin: false,
      })
    ).status,
  ).toBe(403);
  store.setMemberAdmin(owner(), input);
  const carol = store.authenticate(otherToken);
  expect(
    (
      await post(memberToken, "member-admin", {
        memberId: carol.id,
        admin: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (await post(memberToken, "member-admin", { ...input, admin: false }))
      .status,
  ).toBe(403);
  expect((await post(memberToken, "invites", {})).status).toBe(403);
  expect(
    (await post(memberToken, "revoke", { memberId: carol.id })).status,
  ).toBe(403);
  const foreign = store.authenticate(store.createRoom("Other", "Owner").token);
  const foreignMember = store.authenticate(
    store.join(store.invite(foreign).code, "Other member").token,
  );
  expect(
    (
      await post(ownerToken, "member-admin", {
        memberId: foreignMember.id,
        admin: true,
      })
    ).status,
  ).toBe(404);
  store.revoke(owner(), carol.id);
  expect(
    (
      await post(ownerToken, "member-admin", {
        memberId: carol.id,
        admin: true,
      })
    ).status,
  ).toBe(404);
  expect(
    (await post(ownerToken, "member-admin", { ...input, admin: "true" }))
      .status,
  ).toBe(422);
  expect(
    (await post(ownerToken, "member-admin", { ...input, role: "owner" }))
      .status,
  ).toBe(422);
  expect(
    (
      await post(ownerToken, "member-admin", {
        ...input,
        roomId: foreign.roomId,
      })
    ).status,
  ).toBe(422);
  expect(db.prepare("SELECT * FROM member_admins").all()).toEqual([
    { memberId: member().id },
  ]);
});

it("keeps assignment idempotent, emits room-scoped member events and removes creation rights immediately", async () => {
  const id = member().id,
    input = { memberId: id, admin: true };
  const start = store.events(owner(), 0).cursor;
  expect((await post(ownerToken, "member-admin", input)).status).toBe(200);
  expect((await post(ownerToken, "member-admin", input)).status).toBe(200);
  expect(store.events(owner(), start).events).toEqual([
    { seq: expect.any(Number), kind: "member", id },
  ]);
  // Even a previously-authenticated actor must not retain rights after demotion.
  const stale = member(),
    token = secret(),
    newRoom = { ...creation(), tokenHash: digest(token) };
  store.createRoomForMember(stale, newRoom);
  await post(ownerToken, "member-admin", { ...input, admin: false });
  const end = store.events(owner(), 0).cursor;
  await post(ownerToken, "member-admin", { ...input, admin: false });
  expect(store.events(owner(), end).events).toEqual([]);
  expect(() => store.createRoomForMember(stale, creation())).toThrow(
    "administrator",
  );
  expect(() => store.createRoomForMember(stale, newRoom)).toThrow(
    "administrator",
  );
  expect((await post(memberToken, "rooms", creation())).status).toBe(403);
  expect((await identity(memberToken)).member.admin).toBe(false);
  // Demotion does not recall rooms/credentials already issued to their new owner.
  expect(store.authenticate(token).role).toBe("owner");
  expect(store.identity(store.authenticate(token)).members).toHaveLength(1);
  store.setMemberAdmin(owner(), input);
  store.revoke(owner(), id);
  expect((await post(memberToken, "rooms", creation())).status).toBe(401);
  expect(store.identity(owner()).members.find((m) => m.id === id)?.admin).toBe(
    false,
  );
  expect(() => store.createRoomForMember(stale, creation())).toThrow("revoked");
});

it("does not grant admins ownership of source threads, discussion moderation or owner requests", async () => {
  store.setMemberAdmin(owner(), { memberId: member().id, admin: true });
  const thread = {
    id: randomUUID(),
    revision: 1,
    title: "Owner thread",
    status: "idle" as const,
    messages: [],
    historyTruncated: false,
  };
  store.publish(owner(), thread);
  const comment = store.addComment(owner(), {
    id: randomUUID(),
    threadId: thread.id,
    parentId: null,
    anchor: null,
    body: "Owner discussion",
  });
  expect(() => store.publish(member(), { ...thread, revision: 2 })).toThrow(
    "another member",
  );
  expect(() => store.resolve(member(), comment.id, 1, true)).toThrow(
    "author or owner",
  );
  const request = store.createRequest(store.authenticate(otherToken), {
    id: randomUUID(),
    threadId: thread.id,
    body: "Private proposal",
  });
  expect(() => store.request(member(), request.id)).toThrow("not found");
  const ownRequest = store.createRequest(member(), {
    id: randomUUID(),
    threadId: thread.id,
    body: "Admin proposal",
  });
  expect(() =>
    store.reviewRequest(member(), {
      id: ownRequest.id,
      version: 1,
      status: "drafted",
    }),
  ).toThrow("thread owner");
});

it("uses the same room and request-rate caps for administrators", async () => {
  store.setMemberAdmin(owner(), { memberId: member().id, admin: true });
  for (let i = 1; i < REMOTE_ROOM_LIMIT; i++)
    store.createRoom(`Room ${i}`, "Owner");
  expect(() => store.createRoomForMember(member(), creation())).toThrow(
    "limit",
  );
  for (let i = 0; i < 10; i++)
    expect((await post(memberToken, "rooms", creation())).status).toBe(409);
  expect((await post(memberToken, "rooms", creation())).status).toBe(429);
});

it("adds grants without modifying v0.4 member rows and retains them across reopening SQLite", () => {
  const before = db.prepare("SELECT * FROM members ORDER BY id").all();
  // v0.4 has the same schema except for the additive grant table.
  db.exec("DROP TABLE member_admins");
  db.close();
  db = new Database(join(directory, "relay.db"));
  store = new RelayStore(db);
  expect(db.prepare("SELECT * FROM members ORDER BY id").all()).toEqual(before);
  expect(store.identity(member()).member.admin).toBe(false);
  const afterHeartbeat = db.prepare("SELECT * FROM members ORDER BY id").all();
  store.setMemberAdmin(owner(), { memberId: member().id, admin: true });
  db.close();
  db = new Database(join(directory, "relay.db"));
  store = new RelayStore(db);
  expect(db.prepare("SELECT * FROM members ORDER BY id").all()).toEqual(
    afterHeartbeat,
  );
  const value = store.identity(member());
  expect(value.member.admin).toBe(true);
  // The old v1 schema strips extensions and still accepts all identities.
  const legacyMember = memberSchema.omit({ admin: true });
  const legacyIdentity = z.object({
    room: identitySchema.shape.room,
    member: legacyMember,
    members: z.array(legacyMember).max(100),
  });
  expect(legacyIdentity.parse(value).member.role).toBe("member");
  expect(
    canCreateRooms(identitySchema.parse(legacyIdentity.parse(value)).member),
  ).toBe(false);
});

it.each(["revoked-owner", "demoted-admin"])(
  "rechecks %s after streaming the mutation body",
  async (scenario) => {
    const token = scenario === "revoked-owner" ? ownerToken : memberToken;
    if (scenario === "demoted-admin")
      store.setMemberAdmin(owner(), { memberId: member().id, admin: true });
    const path = scenario === "revoked-owner" ? "member-admin" : "rooms";
    const bytes = JSON.stringify(
      scenario === "revoked-owner"
        ? { memberId: member().id, admin: true }
        : creation(),
    );
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${url}/v1/${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(bytes),
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      server.once("request", () => {
        if (scenario === "revoked-owner")
          db.prepare("UPDATE members SET revoked=1 WHERE id=?").run(owner().id);
        else
          store.setMemberAdmin(owner(), {
            memberId: member().id,
            admin: false,
          });
        req.end(bytes.slice(1));
      });
      req.write(bytes.slice(0, 1));
    });
    expect(status).toBe(scenario === "revoked-owner" ? 401 : 403);
    expect(db.prepare("SELECT * FROM member_admins").all()).toEqual([]);
    expect(store.listRooms().rooms).toHaveLength(1);
  },
);
