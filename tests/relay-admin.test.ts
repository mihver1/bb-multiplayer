import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  fsyncSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoomCredential } from "../relay/admin";
import { RelayStore } from "../relay/store";
import type { Snapshot } from "../shared/protocol";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});

let directory: string, db: Database.Database, store: RelayStore;
const options = () => ({
  dataDirectory: directory,
  roomName: "Payments",
  ownerName: "Alice",
});
beforeEach(() => {
  directory = mkdtempSync(resolve(tmpdir(), "multiplayer-admin-"));
  db = new Database(resolve(directory, "relay.db"));
  store = new RelayStore(db);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(directory, { recursive: true, force: true });
});

function readCredential(path: string) {
  return JSON.parse(readFileSync(path, "utf8")) as ReturnType<
    RelayStore["createRoom"]
  >;
}

describe("local multi-project administration", () => {
  it("retains the initial private file and provisions a separate credential for each new room", () => {
    const initial = createRoomCredential(store, {
      ...options(),
      initialize: true,
    });
    expect(initial.output).toBe(resolve(directory, "owner-credential.json"));
    const original = readFileSync(initial.output, "utf8");
    const second = createRoomCredential(store, {
      ...options(),
      roomName: "Billing",
    });
    const third = createRoomCredential(store, options());
    const tokens = new Set<string>();
    for (const result of [initial, second, third]) {
      expect(Object.keys(result).sort()).toEqual(["output", "roomId"]);
      const credential = readCredential(result.output);
      tokens.add(credential.token);
      expect(credential.roomId).toBe(result.roomId);
      const actor = store.authenticate(credential.token);
      expect(actor).toMatchObject({
        id: credential.memberId,
        roomId: result.roomId,
        role: "owner",
      });
      expect(store.identity(actor).members).toHaveLength(1);
      expect(statSync(result.output).mode & 0o777).toBe(0o600);
      if (result !== initial)
        expect(result.output).toBe(
          resolve(directory, `owner-credential-${result.roomId}.json`),
        );
      expect(
        JSON.stringify(db.prepare("SELECT * FROM members").all()),
      ).not.toContain(credential.token);
    }
    expect(tokens.size).toBe(3);
    expect(readFileSync(initial.output, "utf8")).toBe(original);
  });

  it("never overwrites an existing credential or leaves an ownerless room on file failure", () => {
    const output = resolve(directory, "owner-credential.json");
    writeFileSync(output, "existing private file", { mode: 0o600 });
    expect(() =>
      createRoomCredential(store, { ...options(), initialize: true }),
    ).toThrow();
    expect(readFileSync(output, "utf8")).toBe("existing private file");
    expect(store.listRooms()).toEqual({ rooms: [], nextCursor: null });
    expect(db.prepare("SELECT id FROM members").all()).toEqual([]);
    const first = createRoomCredential(store, options());
    const before = readdirSync(directory).sort();
    expect(() =>
      createRoomCredential(store, {
        ...options(),
        dataDirectory: resolve(directory, "missing"),
      }),
    ).toThrow();
    expect(store.listRooms().rooms).toEqual([
      { id: first.roomId, name: "Payments" },
    ]);
    expect(db.prepare("SELECT id FROM members").all()).toHaveLength(1);
    expect(readdirSync(directory).sort()).toEqual(before);
    expect(() =>
      createRoomCredential(store, { ...options(), ownerName: " " }),
    ).toThrow();
    expect(store.listRooms().rooms).toHaveLength(1);
  });

  it("rolls back and removes only the new file when flushing a credential fails", () => {
    const initial = createRoomCredential(store, {
      ...options(),
      initialize: true,
    });
    const original = readFileSync(initial.output, "utf8");
    const files = readdirSync(directory).sort();
    vi.mocked(fsyncSync).mockImplementationOnce(() => {
      throw new Error("Simulated flush failure");
    });
    expect(() => createRoomCredential(store, options())).toThrow(
      "Simulated flush failure",
    );
    expect(readdirSync(directory).sort()).toEqual(files);
    expect(readFileSync(initial.output, "utf8")).toBe(original);
    expect(store.listRooms().rooms).toEqual([
      { id: initial.roomId, name: "Payments" },
    ]);
    expect(db.prepare("SELECT id FROM members").all()).toHaveLength(1);
    createRoomCredential(store, options());
    expect(store.listRooms().rooms).toHaveLength(2);
  });

  it("adds rooms to an existing single-room database without changing credentials or history", () => {
    const legacy = store.initialize("Original", "Owner");
    const owner = store.authenticate(legacy.token);
    const invitation = store.invite(owner);
    const memberToken = store.join(store.invite(owner).code, "Member").token;
    const member = store.authenticate(memberToken);
    const thread: Snapshot = {
      id: randomUUID(),
      revision: 1,
      title: "Existing history",
      status: "idle",
      messages: [],
      historyTruncated: false,
    };
    store.publish(owner, thread);
    const comment = store.addComment(member, {
      id: randomUUID(),
      threadId: thread.id,
      parentId: null,
      anchor: null,
      body: "Preserve me",
    });
    const request = store.createRequest(member, {
      id: randomUUID(),
      threadId: thread.id,
      body: "Keep the proposal",
    });
    const events = store.events(owner, 0);
    const requestEvents = store.requestEvents(owner, 0);
    db.close();
    db = new Database(resolve(directory, "relay.db"));
    store = new RelayStore(db);
    const additional = createRoomCredential(store, options());
    db.close();
    db = new Database(resolve(directory, "relay.db"));
    store = new RelayStore(db);
    const restored = store.authenticate(legacy.token);
    expect(restored).toEqual(owner);
    expect(store.authenticate(memberToken)).toEqual(member);
    expect(store.thread(restored, thread.id)).toMatchObject(thread);
    expect(store.comment(restored, comment.id)).toEqual(comment);
    expect(store.request(restored, request.id)).toEqual(request);
    expect(store.events(restored, 0)).toEqual(events);
    expect(store.requestEvents(restored, 0)).toEqual(requestEvents);
    expect(
      store.authenticate(store.join(invitation.code, "Later").token).roomId,
    ).toBe(legacy.roomId);
    expect(
      store.authenticate(readCredential(additional.output).token).roomId,
    ).toBe(additional.roomId);
    expect(store.listRooms().rooms).toHaveLength(2);
  });

  it("paginates the local room inventory without exposing credentials", () => {
    const expected = new Set<string>();
    for (let i = 0; i < 107; i++)
      expected.add(store.createRoom(`Project ${i}`, "Owner").roomId);
    const found: string[] = [];
    let after = "";
    for (;;) {
      const page = store.listRooms(after);
      expect(page.rooms.length).toBeLessThanOrEqual(50);
      for (const room of page.rooms) {
        expect(Object.keys(room).sort()).toEqual(["id", "name"]);
        found.push(room.id);
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    expect(found).toHaveLength(107);
    expect(new Set(found)).toEqual(expected);
    expect(found).toEqual([...found].sort());
    expect(store.listRooms(found.at(-1)!)).toEqual({
      rooms: [],
      nextCursor: null,
    });
  });

  it("exposes init, create-room and credential-free list-rooms commands", async () => {
    const run = (command: string, ...args: string[]) =>
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", resolve("relay/main.ts"), command, ...args],
        {
          env: {
            ...process.env,
            MULTIPLAYER_DATA_DIR: directory,
            MULTIPLAYER_ROOM_NAME: "CLI project",
            MULTIPLAYER_OWNER_NAME: "CLI owner",
          },
        },
      );
    // Exercise the real on-disk CLI alongside an already-open relay store.
    const initial = await run("init");
    const first = readCredential(resolve(directory, "owner-credential.json"));
    const created = await run("create-room");
    const listed = await run("list-rooms");
    const page = JSON.parse(listed.stdout);
    expect(page.rooms).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(store.listRooms()).toEqual(page);
    const extraRoom = page.rooms.find(
      (room: { id: string }) => room.id !== first.roomId,
    );
    const second = readCredential(
      resolve(directory, `owner-credential-${extraRoom.id}.json`),
    );
    for (const result of [initial, created, listed]) {
      expect(result.stderr).toBe("");
      expect(result.stdout).not.toContain(first.token);
      expect(result.stdout).not.toContain(second.token);
    }
    expect(store.authenticate(first.token).roomId).toBe(first.roomId);
    expect(store.authenticate(second.token).roomId).toBe(second.roomId);
    expect(
      JSON.parse((await run("list-rooms", page.rooms[0].id)).stdout).rooms,
    ).toEqual([page.rooms[1]]);
    await expect(run("init")).rejects.toMatchObject({ code: 1 });
    await expect(run("unknown-command")).rejects.toMatchObject({ code: 1 });
    await expect(
      run("create-room", "unexpected-argument"),
    ).rejects.toMatchObject({ code: 1 });
    await expect(run("list-rooms", "invalid-cursor")).rejects.toMatchObject({
      code: 1,
    });
    expect(store.listRooms().rooms).toHaveLength(2);
  });
});
