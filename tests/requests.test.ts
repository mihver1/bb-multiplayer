import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { beforeEach, afterEach, expect, it } from "vitest";
import { RelayStore, digest } from "../relay/store";
import { eventsSchema } from "../shared/protocol";

let db: Database.Database,
  store: RelayStore,
  owner: ReturnType<RelayStore["authenticate"]>,
  bob: typeof owner,
  carol: typeof owner,
  threadId: string;
beforeEach(() => {
  db = new Database(":memory:");
  store = new RelayStore(db);
  owner = store.authenticate(store.initialize("Team", "Alice").token);
  bob = store.authenticate(store.join(store.invite(owner).code, "Bob").token);
  carol = store.authenticate(
    store.join(store.invite(owner).code, "Carol").token,
  );
  threadId = randomUUID();
  store.publish(owner, {
    id: threadId,
    revision: 1,
    title: "Shared",
    status: "idle",
    historyTruncated: false,
    messages: [
      {
        id: "m",
        role: "assistant",
        text: "Plan",
        version: digest("Plan"),
        truncated: false,
        createdAt: 1,
      },
    ],
  });
});
afterEach(() => db.close());
it("assigns identities on the relay and delivers only to requester and actual owner", () => {
  const input = { id: randomUUID(), threadId, body: "Please add a test" };
  const r = store.createRequest(bob, input);
  expect(r).toMatchObject({
    authorId: bob.id,
    ownerId: owner.id,
    status: "pending",
  });
  expect(store.requestEvents(owner, 0).events[0].request.id).toBe(r.id);
  expect(store.requestEvents(bob, 0).events[0].request.id).toBe(r.id);
  expect(store.requestEvents(carol, 0).events).toEqual([]);
  expect(() => store.request(carol, r.id)).toThrow("not found");
  expect(() => store.request({ ...owner, roomId: randomUUID() }, r.id)).toThrow(
    "not found",
  );
});
it("deduplicates create and review retries; rejects conflicts and non-owner decisions", () => {
  const input = { id: randomUUID(), threadId, body: "Proposal" };
  const r = store.createRequest(bob, input);
  expect(store.createRequest(bob, input)).toEqual(r);
  expect(store.requestEvents(owner, 0).events).toHaveLength(1);
  expect(() => store.createRequest(bob, { ...input, body: "Changed" })).toThrow(
    "already in use",
  );
  expect(() => store.createRequest(carol, input)).toThrow("already in use");
  expect(() =>
    store.reviewRequest(bob, { id: r.id, version: 1, status: "drafted" }),
  ).toThrow("owner");
  const next = store.reviewRequest(owner, {
    id: r.id,
    version: 1,
    status: "drafted",
  });
  expect(next.status).toBe("drafted");
  expect(
    store.reviewRequest(owner, { id: r.id, version: 1, status: "drafted" }),
  ).toEqual(next);
  expect(() =>
    store.reviewRequest(owner, { id: r.id, version: 1, status: "dismissed" }),
  ).toThrow("changed");
});
it("leaves protocol-v1 events compatible and refuses own/deleted thread proposals", () => {
  const before = eventsSchema.parse(store.events(owner, 0));
  store.createRequest(bob, { id: randomUUID(), threadId, body: "Proposal" });
  expect(eventsSchema.parse(store.events(owner, 0))).toEqual(before);
  expect(() =>
    store.createRequest(owner, { id: randomUUID(), threadId, body: "Own" }),
  ).toThrow("local thread");
  const {
    ownerId: _,
    updatedAt: __,
    ...snapshot
  } = store.thread(owner, threadId);
  store.publish(owner, { ...snapshot, revision: 2, status: "deleted" });
  expect(() =>
    store.createRequest(bob, { id: randomUUID(), threadId, body: "Late" }),
  ).toThrow("unavailable");
});
