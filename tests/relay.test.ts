import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { RelayStore, digest } from "../relay/store";
import { createRelayServer } from "../relay/http";
import { RelayClient } from "../plugin/client";
import { identitySchema, serverUrl, type Snapshot } from "../shared/protocol";

let db: Database.Database,
  store: RelayStore,
  owner: ReturnType<RelayStore["authenticate"]>,
  member: typeof owner,
  clock: number;
function snapshot(): Snapshot {
  return {
    id: randomUUID(),
    revision: 1,
    title: "Plan",
    status: "idle",
    historyTruncated: false,
    messages: [
      {
        id: "msg_1",
        role: "assistant",
        text: "Add a migration test",
        version: digest("Add a migration test"),
        createdAt: 1,
        truncated: false,
      },
    ],
  };
}
beforeEach(() => {
  clock = 1000;
  db = new Database(":memory:");
  store = new RelayStore(db, () => clock);
  owner = store.authenticate(store.initialize("Team", "Alice").token);
  member = store.authenticate(
    store.join(store.invite(owner).code, "Bob").token,
  );
});
afterEach(() => db.close());

describe("relay permissions and durability", () => {
  it("stores only credential hashes, never bearer credentials", () => {
    const token = store.join(store.invite(owner).code, "Carol").token;
    expect(
      JSON.stringify(db.prepare("SELECT * FROM members").all()),
    ).not.toContain(token);
    expect(store.authenticate(token).name).toBe("Carol");
  });
  it("requires owner invitations, single use, expiration and immediate revocation", () => {
    expect(() => store.invite(member)).toThrow("owner");
    const invite = store.invite(owner);
    const token = store.join(invite.code, "Carol").token;
    expect(() => store.join(invite.code, "Impostor")).toThrow("already used");
    const expired = store.invite(owner);
    clock += 86_400_001;
    expect(() => store.join(expired.code, "Late")).toThrow("expired");
    const carol = store.authenticate(token);
    expect(() => store.revoke(member, carol.id)).toThrow("owner");
    store.revoke(owner, carol.id);
    expect(() => store.authenticate(token)).toThrow("revoked");
    expect(() => store.revoke(owner, owner.id)).toThrow("owner");
  });
  it("does not allow another member or room to overwrite or read a thread", () => {
    const value = snapshot();
    store.publish(owner, value);
    expect(() => store.publish(member, { ...value, revision: 2 })).toThrow(
      "another member",
    );
    const foreign = { ...member, roomId: randomUUID() };
    expect(() => store.thread(foreign, value.id)).toThrow("not found");
    expect(store.events(foreign, 0).events).toEqual([]);
    expect(store.threads(foreign, "")).toEqual([]);
  });
  it("deduplicates replay, ignores stale snapshots and rejects revision collisions", () => {
    const value = snapshot();
    store.publish(owner, value);
    const cursor = store.events(owner, 0).cursor;
    store.publish(owner, value);
    expect(store.events(owner, cursor).events).toEqual([]);
    expect(() =>
      store.publish(owner, { ...value, title: "collision" }),
    ).toThrow("different data");
    store.publish(owner, { ...value, revision: 3, title: "New" });
    store.publish(owner, { ...value, revision: 2, title: "Old" });
    expect(store.thread(owner, value.id).title).toBe("New");
  });
  it("validates anchored versions and preserves the original quote after updates", () => {
    const value = snapshot();
    store.publish(owner, value);
    const input = {
      id: randomUUID(),
      threadId: value.id,
      parentId: null,
      body: "Cover rollback too",
      anchor: {
        messageId: "msg_1",
        version: value.messages[0].version,
        quote: "migration test",
      },
    };
    const comment = store.addComment(member, input);
    expect(store.addComment(member, input)).toEqual(comment);
    expect(() => store.addComment(owner, input)).toThrow("already in use");
    store.publish(owner, { ...value, revision: 2, messages: [] });
    expect(store.comment(owner, comment.id).anchor?.quote).toBe(
      "migration test",
    );
    expect(() =>
      store.addComment(member, { ...input, id: randomUUID() }),
    ).toThrow("Message changed");
  });
  it("supports replies and compare-and-swap resolution, rejects cross-thread replies", () => {
    const a = snapshot(),
      b = snapshot();
    store.publish(owner, a);
    store.publish(owner, b);
    const root = store.addComment(owner, {
      id: randomUUID(),
      threadId: a.id,
      parentId: null,
      anchor: null,
      body: "Question",
    });
    expect(() => store.resolve(member, root.id, 1, true)).toThrow(
      "author or owner",
    );
    expect(() =>
      store.addComment(member, {
        id: randomUUID(),
        threadId: b.id,
        parentId: root.id,
        anchor: null,
        body: "Wrong thread",
      }),
    ).toThrow("this thread");
    const reply = store.addComment(member, {
      id: randomUUID(),
      threadId: a.id,
      parentId: root.id,
      anchor: null,
      body: "Answer",
    });
    expect(() => store.resolve(member, reply.id, 1, true)).toThrow(
      "root discussion",
    );
    expect(store.resolve(owner, root.id, 1, true).version).toBe(2);
    expect(() => store.resolve(owner, root.id, 1, false)).toThrow("changed");
  });
  it("paginates event catch-up without losing or duplicating events", () => {
    for (let i = 0; i < 110; i++) store.publish(owner, snapshot());
    let cursor = 0;
    const ids: number[] = [];
    for (;;) {
      const result = store.events(member, cursor);
      ids.push(...result.events.map((e) => e.seq));
      cursor = result.cursor;
      if (result.events.length < 50) break;
    }
    expect(ids.length).toBe(111); // member joined + 110 snapshots
    expect(new Set(ids).size).toBe(ids.length);
    expect(store.events(member, cursor).events).toEqual([]);
    const reopened = new RelayStore(db);
    expect(reopened.events(member, 0).events.length).toBe(50);
  });
  it("does not accept credentials in redirects or insecure remote URLs", () => {
    expect(serverUrl("http://127.0.0.1:4789")).toBe("http://127.0.0.1:4789");
    for (const url of [
      "http://example.com",
      "https://user:pass@example.com",
      "https://example.com/path",
      "https://example.com?token=x",
      "file:///tmp/x",
    ])
      expect(() => serverUrl(url)).toThrow();
  });
  it("enforces HTTP authentication and rejects browser-origin requests", async () => {
    const server = createRelayServer(store);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number },
      url = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${url}/v1/me`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/health`, {
            headers: { Origin: "https://evil.example" },
          })
        ).status,
      ).toBe(403);
      const token = store.join(store.invite(owner).code, "HTTP client").token;
      const client = new RelayClient(url, token);
      expect((await client.call("me", identitySchema)).member.name).toBe(
        "HTTP client",
      );
      expect(
        (
          await fetch(`${url}/v1/comments`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: "{}",
          })
        ).status,
      ).toBe(422);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
