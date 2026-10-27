import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RelayStore } from "../relay/store";
import { createRelayServer } from "../relay/http";
import type { Snapshot } from "../shared/protocol";

let db: Database.Database,
  store: RelayStore,
  server: ReturnType<typeof createRelayServer>,
  origin: string;

const snapshot = (): Snapshot => ({
  id: randomUUID(),
  revision: 1,
  title: "Project plan",
  status: "idle",
  messages: [],
  historyTruncated: false,
});

function populate(credential: ReturnType<RelayStore["createRoom"]>) {
  const owner = store.authenticate(credential.token);
  const memberToken = store.join(store.invite(owner).code, "Bob").token;
  const member = store.authenticate(memberToken);
  const thread = snapshot();
  store.publish(owner, thread);
  const comment = store.addComment(member, {
    id: randomUUID(),
    threadId: thread.id,
    parentId: null,
    anchor: null,
    body: "Project-specific discussion",
  });
  const request = store.createRequest(member, {
    id: randomUUID(),
    threadId: thread.id,
    body: "Project-specific proposal",
  });
  return {
    roomId: credential.roomId,
    owner,
    member,
    ownerToken: credential.token,
    memberToken,
    thread,
    comment,
    request,
  };
}
let a: ReturnType<typeof populate>, b: typeof a;

async function call(token: string, path: string, input?: unknown) {
  const response = await fetch(`${origin}/v1/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: response.status, data: await response.json() };
}

beforeEach(async () => {
  db = new Database(":memory:");
  store = new RelayStore(db);
  a = populate(store.initialize("Payments", "Alice"));
  // Identical member names must not imply shared identity or permissions.
  b = populate(store.createRoom("Billing", "Alice"));
  server = createRelayServer(store);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

describe("multiple projects on one relay", () => {
  it("keeps the legacy initialization guard and validates new room names", () => {
    expect(() => store.initialize("Replacement", "Owner")).toThrow(
      "already initialized",
    );
    expect(() => store.createRoom("   ", "Owner")).toThrow();
    expect(() => store.createRoom("Room", "")).toThrow();
    expect(() => store.createRoom("x".repeat(101), "Owner")).toThrow();
    expect(store.listRooms().rooms).toHaveLength(2);
    const credential = store.createRoom("  Trimmed room  ", "  Owner  ");
    expect(store.identity(store.authenticate(credential.token))).toMatchObject({
      room: { id: credential.roomId, name: "Trimmed room" },
      member: { name: "Owner" },
    });
  });

  it("scopes identity, lists and both feeds by credential without changing v1", async () => {
    for (const room of [a, b]) {
      for (const token of [room.ownerToken, room.memberToken]) {
        const identity = await call(token, "me");
        expect(identity.status).toBe(200);
        expect(identity.data.room.id).toBe(room.roomId);
        expect(identity.data.members.map((m: { id: string }) => m.id)).toEqual([
          room.owner.id,
          room.member.id,
        ]);
        const threads = await call(token, "threads");
        expect(threads.status).toBe(200);
        expect(threads.data.threads.map((t: { id: string }) => t.id)).toEqual([
          room.thread.id,
        ]);
        expect(await call(token, `thread?id=${room.thread.id}`)).toMatchObject({
          status: 200,
          data: { id: room.thread.id, ownerId: room.owner.id },
        });
        expect(await call(token, `comments?id=${room.thread.id}`)).toEqual({
          status: 200,
          data: { comments: [room.comment] },
        });
        const events = await call(token, "events");
        expect(events.status).toBe(200);
        expect(events.data.events.map((e: { id: string }) => e.id)).toEqual([
          room.member.id,
          room.thread.id,
          room.comment.id,
        ]);
        const requests = await call(token, "request-events");
        expect(requests.status).toBe(200);
        expect(requests.data.events).toEqual([
          { seq: expect.any(Number), request: room.request },
        ]);
        expect(
          await call(token, `message-request?id=${room.request.id}`),
        ).toEqual({
          status: 200,
          data: room.request,
        });
      }
    }
  });

  it("denies cross-project reads and mutations even to the other room's owner", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ]) {
      for (const token of [own.ownerToken, own.memberToken]) {
        for (const path of [
          `thread?id=${other.thread.id}`,
          `comments?id=${other.thread.id}`,
          `comment?id=${other.comment.id}`,
          `message-request?id=${other.request.id}`,
        ]) {
          expect(await call(token, path)).toEqual({
            status: 404,
            data: { error: expect.stringContaining("not found") },
          });
        }
        const mutations: [string, unknown, number][] = [
          ["threads", { ...other.thread, revision: 2 }, 403],
          [
            "comments",
            {
              id: randomUUID(),
              threadId: other.thread.id,
              parentId: null,
              anchor: null,
              body: "Foreign comment",
            },
            404,
          ],
          [
            "comments",
            {
              id: randomUUID(),
              threadId: own.thread.id,
              parentId: other.comment.id,
              anchor: null,
              body: "Foreign reply",
            },
            404,
          ],
          [
            "resolve",
            { id: other.comment.id, version: 1, resolved: true },
            404,
          ],
          [
            "message-requests",
            {
              id: randomUUID(),
              threadId: other.thread.id,
              body: "Foreign proposal",
            },
            404,
          ],
          [
            "review-request",
            { id: other.request.id, version: 1, status: "drafted" },
            404,
          ],
          [
            "revoke",
            { memberId: other.member.id },
            token === own.ownerToken ? 404 : 403,
          ],
          // Caller-supplied room selection must not override credential scope.
          ["invites", { roomId: other.roomId }, 422],
        ];
        for (const [path, input, status] of mutations)
          expect((await call(token, path, input)).status).toBe(status);
        expect(
          (await call(token, `me?roomId=${other.roomId}`)).data.room.id,
        ).toBe(own.roomId);
      }
      expect(store.thread(other.owner, other.thread.id).revision).toBe(1);
      expect(store.comment(other.owner, other.comment.id)).toEqual(
        other.comment,
      );
      expect(store.request(other.owner, other.request.id)).toEqual(
        other.request,
      );
      expect(store.authenticate(other.memberToken).revoked).toBe(0);
    }
  });

  it("rejects cross-room ID collisions without returning or modifying foreign data", async () => {
    for (const [own, other] of [
      [a, b],
      [b, a],
    ]) {
      expect(
        await call(own.memberToken, "comments", {
          id: other.comment.id,
          threadId: own.thread.id,
          parentId: null,
          anchor: null,
          body: "Different project's comment",
        }),
      ).toEqual({ status: 409, data: { error: "Comment ID already in use" } });
      expect(
        await call(own.memberToken, "message-requests", {
          id: other.request.id,
          threadId: own.thread.id,
          body: "Different project's proposal",
        }),
      ).toEqual({ status: 409, data: { error: "Request ID already in use" } });
      expect(store.comment(other.owner, other.comment.id)).toEqual(
        other.comment,
      );
      expect(store.request(other.owner, other.request.id)).toEqual(
        other.request,
      );
    }
  });

  it("binds invitations to their room and keeps revocation local", async () => {
    const invitation = await call(a.ownerToken, "invites", {});
    expect(invitation.status).toBe(200);
    const join = await fetch(`${origin}/v1/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: invitation.data.code, name: "Carol" }),
    });
    expect(join.status).toBe(200);
    const { token } = await join.json();
    expect((await call(token, "me")).data.room.id).toBe(a.roomId);
    expect(() => store.join(invitation.data.code, "Reuse")).toThrow(
      "already used",
    );
    expect(
      await call(a.ownerToken, "revoke", { memberId: a.member.id }),
    ).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect((await call(a.memberToken, "me")).status).toBe(401);
    expect((await call(b.memberToken, "me")).status).toBe(200);
    expect((await call(b.ownerToken, "invites", {})).status).toBe(200);
  });

  it("keeps membership limits per project, not per server", () => {
    for (let i = 2; i < 100; i++)
      store.join(store.invite(a.owner).code, `Member ${i}`);
    expect(() => store.join(store.invite(a.owner).code, "Overflow")).toThrow(
      "100 members",
    );
    const joined = store.join(store.invite(b.owner).code, "Still has capacity");
    expect(store.authenticate(joined.token).roomId).toBe(b.roomId);
  });

  it("paginates interleaved project feeds without exposing or skipping events", () => {
    for (let i = 0; i < 60; i++) {
      for (const room of [a, b]) {
        store.publish(room.owner, { ...room.thread, revision: i + 2 });
        store.createRequest(room.member, {
          id: randomUUID(),
          threadId: room.thread.id,
          body: `Proposal ${i}`,
        });
      }
    }
    for (const room of [a, b]) {
      let cursor = 0;
      const eventIds: string[] = [],
        sequences: number[] = [];
      for (;;) {
        const page = store.events(room.owner, cursor);
        expect(page.events.length).toBeLessThanOrEqual(50);
        eventIds.push(...page.events.map((event) => event.id));
        sequences.push(...page.events.map((event) => event.seq));
        cursor = page.cursor;
        if (page.events.length < 50) break;
      }
      expect(eventIds).toHaveLength(63);
      expect(new Set(eventIds)).toEqual(
        new Set([room.member.id, room.thread.id, room.comment.id]),
      );
      expect(new Set(sequences).size).toBe(63);
      expect(store.events(room.owner, cursor)).toEqual({ cursor, events: [] });
      cursor = 0;
      const requestIds: string[] = [];
      for (;;) {
        const page = store.requestEvents(room.owner, cursor);
        expect(page.events.length).toBeLessThanOrEqual(50);
        for (const { request } of page.events) {
          expect(request.threadId).toBe(room.thread.id);
          expect(request.ownerId).toBe(room.owner.id);
          expect(request.authorId).toBe(room.member.id);
          requestIds.push(request.id);
        }
        cursor = page.cursor;
        if (page.events.length < 50) break;
      }
      expect(requestIds).toHaveLength(61);
      expect(new Set(requestIds).size).toBe(61);
      expect(store.requestEvents(room.owner, cursor)).toEqual({
        cursor,
        events: [],
      });
    }
  });

  it("does not expose the room inventory and validates creation input", async () => {
    for (const token of ["", a.memberToken, a.ownerToken]) {
      expect((await call(token, "rooms")).status).toBe(token ? 404 : 401);
      expect(
        (await call(token, "rooms", { name: "Unauthorized room" })).status,
      ).toBe(token ? 422 : 401);
    }
    expect(store.listRooms().rooms).toHaveLength(2);
  });
});
