import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { RelayStore, digest, secret } from "../relay/store";
import { createRelayServer } from "../relay/http";
import { REMOTE_ROOM_LIMIT } from "../shared/rooms";

let db: Database.Database,
  store: RelayStore,
  http: ReturnType<typeof createRelayServer>,
  url: string;
let credential: ReturnType<RelayStore["initialize"]>, memberToken: string;
beforeEach(async () => {
  db = new Database(":memory:");
  store = new RelayStore(db);
  credential = store.initialize("Existing room", "Alice");
  memberToken = store.join(
    store.invite(store.authenticate(credential.token)).code,
    "Bob",
  ).token;
  http = createRelayServer(store);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});
const input = () => ({
  requestId: randomUUID(),
  name: "New project",
  tokenHash: digest(secret()),
});
async function post(token: string, value: unknown, origin?: string) {
  const response = await fetch(`${url}/v1/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(value),
  });
  return { status: response.status, data: await response.json() };
}
it("creates an isolated room for an authenticated owner without returning or storing raw tokens", async () => {
  const token = secret(),
    value = { ...input(), tokenHash: digest(token) };
  const before = store.identity(store.authenticate(credential.token));
  const result = await post(credential.token, value);
  expect(result.status).toBe(200);
  expect(Object.keys(result.data).sort()).toEqual(["memberId", "roomId"]);
  const owner = store.authenticate(token),
    identity = store.identity(owner);
  expect(identity.room).toEqual({ id: result.data.roomId, name: value.name });
  expect(identity.member).toMatchObject({
    id: result.data.memberId,
    name: "Alice",
    role: "owner",
  });
  expect(identity.members).toHaveLength(1);
  expect(identity.room.id).not.toBe(before.room.id);
  expect(
    store
      .identity(store.authenticate(credential.token))
      .members.map((m) => m.id),
  ).toEqual(before.members.map((m) => m.id));
  expect(store.threads(owner, "")).toEqual([]);
  expect(store.events(owner, 0).events).toEqual([]);
  for (const table of ["members", "room_creations"])
    expect(
      JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()),
    ).not.toContain(token);
  expect(JSON.stringify(result.data)).not.toContain(token);
});
it("rejects anonymous, ordinary, revoked and browser-origin callers", async () => {
  const value = input();
  expect((await post("", value)).status).toBe(401);
  expect((await post(memberToken, value)).status).toBe(403);
  expect(
    (await post(credential.token, value, "https://example.com")).status,
  ).toBe(403);
  db.prepare("UPDATE members SET revoked=1 WHERE id=?").run(
    credential.memberId,
  );
  expect((await post(credential.token, value)).status).toBe(401);
  expect(store.listRooms().rooms).toHaveLength(1);
});
it("deduplicates creation across retries/restarts, rejects changed requests and token reuse", async () => {
  const value = input();
  const first = await post(credential.token, value);
  expect(await post(credential.token, value)).toEqual(first);
  const reopened = new RelayStore(db);
  expect(
    reopened.createRoomForOwner(reopened.authenticate(credential.token), value),
  ).toEqual(first.data);
  expect(
    (await post(credential.token, { ...value, name: "Changed" })).status,
  ).toBe(409);
  expect(
    (await post(credential.token, { ...value, tokenHash: digest(secret()) }))
      .status,
  ).toBe(409);
  expect(
    (
      await post(credential.token, {
        ...input(),
        tokenHash: digest(credential.token),
      })
    ).status,
  ).toBe(409);
  expect(
    (await post(credential.token, { ...input(), tokenHash: value.tokenHash }))
      .status,
  ).toBe(409);
  expect(store.listRooms().rooms).toHaveLength(2);
});
it("bounds remote creation across all owners and still permits replay at the cap", () => {
  const owner = store.authenticate(credential.token),
    value = input();
  const created = store.createRoomForOwner(owner, value);
  for (let i = 2; i < REMOTE_ROOM_LIMIT; i++)
    store.createRoom(`Room ${i}`, "Owner");
  expect(() => store.createRoomForOwner(owner, input())).toThrow("limit");
  expect(store.createRoomForOwner(owner, value)).toEqual(created);
  const other = store.authenticate(
    store.createRoom("Operator bypass", "Owner").token,
  );
  expect(() => store.createRoomForOwner(other, input())).toThrow("limit");
});
it("advertises creation capability, validates fields and rate-limits only its own route", async () => {
  expect(
    (await (await fetch(`${url}/health`)).json()).capabilities.roomCreation,
  ).toBe(true);
  for (const invalid of [
    {},
    { ...input(), name: " " },
    { ...input(), tokenHash: "secret" },
    { ...input(), roomId: randomUUID() },
  ])
    expect((await post(credential.token, invalid)).status).toBe(422);
  for (let i = 4; i < 10; i++)
    expect((await post(credential.token, {})).status).toBe(422);
  expect((await post(credential.token, input())).status).toBe(429);
  expect(
    (
      await fetch(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credential.token}` },
      })
    ).status,
  ).toBe(200);
  expect(store.listRooms().rooms).toHaveLength(1);
});
it("rechecks membership after a streamed creation body completes", async () => {
  const bytes = JSON.stringify(input());
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      `${url}/v1/rooms`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
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
    http.once("request", () => {
      db.prepare("UPDATE members SET revoked=1 WHERE id=?").run(
        credential.memberId,
      );
      req.end(bytes.slice(1));
    });
    req.write(bytes.slice(0, 1));
  });
  expect(status).toBe(401);
  expect(store.listRooms().rooms).toHaveLength(1);
});
