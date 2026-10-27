import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  createFakePluginHost,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server";
import { RelayStore } from "../relay/store";
import { createRelayServer } from "../relay/http";

let db: Database.Database,
  relay: RelayStore,
  http: ReturnType<typeof createRelayServer>,
  url: string,
  token: string;
const hosts: FakePluginHost[] = [];
function makeClient(projectId: string, threadId: string) {
  let text = "Plan: add a migration test";
  const thread = makeThreadResponse({
    id: threadId,
    projectId,
    title: "Migration",
    status: "idle",
  });
  const host = createFakePluginHost({
    pluginId: "multiplayer",
    sdk: {
      projects: {
        list: async () => [{ id: projectId, name: projectId }],
        get: async () => ({ id: projectId, name: projectId }),
      },
      threads: {
        get: async () => thread,
        timeline: async () => ({
          rows: [
            {
              kind: "conversation",
              id: "thr_a:user-seed:1",
              role: "user",
              initiator: "user",
              text: "Please make a plan",
              createdAt: 1,
            },
            {
              kind: "turn",
              children: [
                {
                  kind: "conversation",
                  id: "thr_a:assistant:kind:assistant|turn:t1|parent:root|item:i9",
                  role: "assistant",
                  text,
                  createdAt: 2,
                },
                { kind: "work", workKind: "tool", secret: "DO NOT PUBLISH" },
              ],
            },
            {
              kind: "conversation",
              id: "internal",
              role: "user",
              initiator: "system",
              text: "PRIVATE AGENT CONTEXT",
              createdAt: 3,
            },
          ],
          timelinePage: { olderCursor: null },
        }),
      },
    },
  });
  plugin(host.bb);
  hosts.push(host);
  return {
    ...host,
    thread,
    changeText: (next: string) => {
      text = next;
    },
  };
}
async function rpc<K extends keyof typeof rpcContract>(
  host: FakePluginHost,
  method: K,
  input?: z.input<(typeof rpcContract)[K]["input"]>,
) {
  const result = await host.harness.behavior.callRpc(method, input);
  return rpcContract[method].output.parse(result) as z.output<
    (typeof rpcContract)[K]["output"]
  >;
}
beforeEach(async () => {
  db = new Database(":memory:");
  relay = new RelayStore(db);
  token = relay.initialize("Team", "Alice").token;
  http = createRelayServer(relay);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});

describe("two independent BB installations", () => {
  it("shares only opted-in threads; teammate comments reach the owner without starting an agent", async () => {
    const alice = makeClient("proj_a", "thr_a"),
      bob = makeClient("proj_b", "thr_b");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    const invitation = await rpc(alice, "invite");
    await rpc(bob, "connect", {
      url,
      projectId: "proj_b",
      inviteCode: invitation.code,
      displayName: "Bob",
    });
    expect((await rpc(alice, "status")).threads).toEqual([]);
    await alice.harness.behavior.emitThreadEvent("thread.idle", {
      thread: alice.thread,
      lastAssistantText: "not shared",
    });
    await rpc(alice, "sync");
    expect((await rpc(bob, "status")).threads).toEqual([]);
    await expect(
      rpc(alice, "share", { threadId: "thr_a", confirmed: false as true }),
    ).rejects.toThrow();
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    await rpc(bob, "sync");
    let remote = await rpc(bob, "thread", { id: sharedId });
    expect(remote.localId).toBeNull();
    expect(remote.thread.messages).toHaveLength(2);
    expect(JSON.stringify(remote)).not.toContain("DO NOT PUBLISH");
    expect(JSON.stringify(remote)).not.toContain("PRIVATE AGENT CONTEXT");
    const message = remote.thread.messages[1];
    const comment = await rpc(bob, "addComment", {
      id: randomUUID(),
      threadId: sharedId,
      parentId: null,
      body: "Please cover rollback",
      anchor: {
        messageId: message.id,
        version: message.version,
        quote: "migration test",
      },
    });
    await rpc(alice, "sync");
    expect(
      (await rpc(alice, "thread", { id: sharedId })).comments,
    ).toHaveLength(1);
    expect(
      await rpc(alice, "discussionContext", { threadId: "thr_a" }),
    ).toMatchObject({
      threadTitle: "Migration",
      connectedProject: true,
      sharedId,
      sharing: true,
      online: true,
      commentCount: 1,
      openCount: 1,
    });
    const feedback = await rpc(alice, "feedback", {
      threadId: "thr_a",
      commentIds: [comment.id],
    });
    expect(feedback.text).toContain("Please cover rollback");
    expect(feedback.text).toContain("untrusted");
    await expect(
      rpc(bob, "feedback", { threadId: "thr_a", commentIds: [comment.id] }),
    ).rejects.toThrow("local thread owner");
    expect(alice.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
    expect(alice.harness.inspection.sdk.callsTo("threads.spawn")).toEqual([]);
    alice.changeText("Updated plan");
    await alice.harness.behavior.emitThreadEvent("thread.idle", {
      thread: alice.thread,
      lastAssistantText: "Updated plan",
    });
    await rpc(alice, "sync");
    await rpc(bob, "sync");
    remote = await rpc(bob, "thread", { id: sharedId });
    expect(remote.thread.messages[1].text).toBe("Updated plan");
    expect(remote.comments[0].anchor?.quote).toBe("migration test");
    expect(remote.comments[0].anchor?.version).not.toBe(
      remote.thread.messages[1].version,
    );
  });
  it("retries a lost snapshot acknowledgement and keeps cursor/cache on reload", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    const fetchOriginal = globalThis.fetch;
    let loseOnce = true;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const response = await fetchOriginal(input, init);
        if (
          loseOnce &&
          String(input).endsWith("/v1/threads") &&
          init?.method === "POST"
        ) {
          loseOnce = false;
          throw new Error("Acknowledgement lost");
        }
        return response;
      },
    );
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    expect((await rpc(alice, "status")).error).toContain(
      "could not be published",
    );
    const count = db
      .prepare("SELECT count(*) AS n FROM events WHERE kind='thread'")
      .get();
    const reloaded = await alice.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    await rpc(reloaded, "sync");
    expect(
      db.prepare("SELECT count(*) AS n FROM events WHERE kind='thread'").get(),
    ).toEqual(count);
    expect(
      (await rpc(reloaded, "thread", { id: sharedId })).thread.revision,
    ).toBe(1);
    await rpc(reloaded, "sync");
    expect(
      (await rpc(reloaded, "thread", { id: sharedId })).thread.revision,
    ).toBe(1);
  });
  it("pauses future publication and revokes remote access without leaking credentials", async () => {
    const alice = makeClient("proj_a", "thr_a"),
      bob = makeClient("proj_b", "thr_b");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    await rpc(bob, "connect", {
      url,
      projectId: "proj_b",
      inviteCode: (await rpc(alice, "invite")).code,
      displayName: "Bob",
    });
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    await rpc(bob, "sync");
    await rpc(alice, "pause", { threadId: "thr_a" });
    alice.changeText("PRIVATE NEW TEXT");
    await alice.harness.behavior.emitThreadEvent("thread.idle", {
      thread: alice.thread,
      lastAssistantText: "PRIVATE NEW TEXT",
    });
    await rpc(alice, "sync");
    await rpc(bob, "sync");
    expect(
      JSON.stringify(await rpc(bob, "thread", { id: sharedId })),
    ).not.toContain("PRIVATE NEW TEXT");
    const bobId = (await rpc(bob, "status")).identity!.member.id;
    await rpc(alice, "revoke", { memberId: bobId });
    await expect(rpc(bob, "sync")).rejects.toThrow("revoked");
    const state = await rpc(bob, "status");
    expect(state.connection).toBeNull();
    expect(state.threads).toEqual([]);
    expect(JSON.stringify(await rpc(alice, "status"))).not.toContain(token);
    expect(JSON.stringify(alice.harness.logEntries)).not.toContain(token);
  });
  it("requires the actual local project and leaves unshared threads unread", async () => {
    const alice = makeClient("proj_wrong", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_connected", token });
    await expect(
      rpc(alice, "share", { threadId: "thr_a", confirmed: true }),
    ).rejects.toThrow("outside");
    expect(alice.harness.inspection.sdk.callsTo("threads.timeline")).toEqual(
      [],
    );
    expect(
      await rpc(alice, "discussionContext", { threadId: "thr_a" }),
    ).toMatchObject({
      connectedProject: false,
      sharedId: null,
      identity: null,
      sharing: false,
      online: false,
      commentCount: 0,
      openCount: 0,
    });
  });
  it("does not let an unavailable local thread block incoming comments", async () => {
    const alice = makeClient("proj_a", "thr_a"),
      bob = makeClient("proj_b", "thr_b");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    await rpc(bob, "connect", {
      url,
      projectId: "proj_b",
      inviteCode: (await rpc(alice, "invite")).code,
      displayName: "Bob",
    });
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    await rpc(bob, "sync");
    alice.harness.inspection.sdk.stub("threads.timeline", async () => {
      throw new Error("Workspace offline");
    });
    await alice.harness.behavior.emitThreadEvent("thread.idle", {
      thread: alice.thread,
      lastAssistantText: null,
    });
    await rpc(bob, "addComment", {
      id: randomUUID(),
      threadId: sharedId,
      parentId: null,
      anchor: null,
      body: "Still delivered",
    });
    await rpc(alice, "sync");
    expect(
      (await rpc(alice, "thread", { id: sharedId })).comments[0].body,
    ).toBe("Still delivered");
    expect((await rpc(alice, "status")).error).toContain(
      "could not be published",
    );
  });
  it("persists deletion markers across reload without reading deleted local threads", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    await alice.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: { ...alice.thread, deletedAt: Date.now() },
    });
    const next = await alice.harness.lifecycle.reload(plugin);
    hosts.push(next);
    next.harness.inspection.sdk.stub("threads.get", async () => {
      throw new Error("Deleted");
    });
    await rpc(next, "sync");
    expect((await rpc(next, "thread", { id: sharedId })).thread.status).toBe(
      "deleted",
    );
    expect((await rpc(next, "status")).error).toBeNull();
  });
  it("stops its background service promptly even during a blocked network read", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.stubGlobal(
      "fetch",
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          started();
          init.signal?.addEventListener(
            "abort",
            () => reject(new Error("Aborted")),
            { once: true },
          );
        }),
    );
    const service = alice.harness.behavior.runService("sync");
    await entered;
    service.controller.abort();
    await service.done;
  });
  it.each(["token", "inviteCode"] as const)(
    "does not send a %s when the address serves HTML instead of relay health",
    async (field) => {
      const alice = makeClient("proj_a", "thr_a");
      const fetch = vi.fn().mockResolvedValue(
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        rpc(alice, "connect", {
          url,
          projectId: "proj_a",
          [field]: token,
          ...(field === "inviteCode" ? { displayName: "Alice" } : {}),
        }),
      ).rejects.toThrow("HTTP 502 (HTML)");
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][0]).toBe(`${url}/health`);
      expect(fetch.mock.calls[0][1].headers).not.toHaveProperty(
        "authorization",
      );
      expect(fetch.mock.calls[0][1].body).toBeUndefined();
      const state = await rpc(alice, "status");
      expect(state.connection).toBeNull();
      expect(state.identity).toBeNull();
    },
  );
  it("rejects a pasted credential JSON file with a clear message before networking", async () => {
    const alice = makeClient("proj_a", "thr_a");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      rpc(alice, "connect", {
        url,
        projectId: "proj_a",
        token: JSON.stringify({ token }),
      }),
    ).rejects.toThrow("Paste only the token value");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("trims surrounding whitespace in a member credential", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", {
      url,
      projectId: "proj_a",
      token: `  ${token}\n`,
    });
    expect((await rpc(alice, "status")).online).toBe(true);
  });
  it("retains a connected account and cached data if a proxy returns an HTML 401 page", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>Proxy login</html>", {
          status: 401,
          headers: { "content-type": "text/html" },
        }),
      ),
    );
    await expect(rpc(alice, "sync")).rejects.toThrow("HTTP 401 (HTML)");
    const state = await rpc(alice, "status");
    expect(state.connection).not.toBeNull();
    expect(state.identity).not.toBeNull();
  });
  it("returns bounded grouped discussion previews with roots for recent replies", async () => {
    const alice = makeClient("proj_a", "thr_a");
    await rpc(alice, "connect", { url, projectId: "proj_a", token });
    const { sharedId } = await rpc(alice, "share", {
      threadId: "thr_a",
      confirmed: true,
    });
    const actor = relay.authenticate(token);
    const add = (body: string, parentId: string | null = null) =>
      relay.addComment(actor, {
        id: randomUUID(),
        threadId: sharedId,
        body,
        parentId,
        anchor: null,
      });
    const root = add("Old root"),
      b = add("Topic B");
    for (let i = 0; i < 205; i++) add(`Filler ${i}`);
    const aReply = add("Recent reply to old root", root.id),
      bReply = add("Recent B answer", b.id);
    await rpc(alice, "sync");
    await rpc(alice, "sync");
    const result = await rpc(alice, "thread", { id: sharedId });
    expect(result.comments).toHaveLength(200);
    expect(result.commentsTruncated).toBe(true);
    expect(result.comments.findIndex((c) => c.id === aReply.id)).toBe(
      result.comments.findIndex((c) => c.id === root.id) + 1,
    );
    expect(result.comments.findIndex((c) => c.id === bReply.id)).toBe(
      result.comments.findIndex((c) => c.id === b.id) + 1,
    );
    const ids = new Set(result.comments.map((c) => c.id));
    for (const c of result.comments)
      if (c.parentId) expect(ids.has(c.parentId)).toBe(true);
    expect(alice.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });
  it("uses only the public plugin SDK", async () => {
    const scan = await experimental_scanPublicSdkOnly(process.cwd(), {
      allow: [
        /^vitest(?:\/config)?$/,
        /^@testing-library\/react$/,
        /^react(?:-dom)?$/,
        /^@radix-ui\/react-[a-z-]+$/,
        /^(?:class-variance-authority|clsx|tailwind-merge|better-sqlite3)$/,
        /^@\/(?:components|lib)\//,
      ],
    });
    expect(scan.violations).toEqual([]);
    expect(scan.privateDependencies).toEqual([]);
  });
});
