import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { z } from "zod";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { FakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server";
import { LocalStore } from "../plugin/local-store";
import { MirrorStore, mirrorMigrations } from "../provider/mirror-store";
import { RelayStore } from "../relay/store";
import { createRelayServer } from "../relay/http";

let db: Database.Database,
  relay: RelayStore,
  http: ReturnType<typeof createRelayServer>,
  url: string;
let a: ReturnType<RelayStore["createRoom"]>, b: typeof a;
const hosts: FakePluginHost[] = [];
function host(legacyToken?: string) {
  const threads = new Map(
    ["a", "b"].map((suffix) => [
      `thr_${suffix}`,
      makeThreadResponse({
        id: `thr_${suffix}`,
        projectId: `proj_${suffix}`,
        title: `Thread ${suffix}`,
        status: "idle",
      }),
    ]),
  );
  const result = createFakePluginHost({
    pluginId: "multiplayer",
    experimental_declaredIconNames: ["people"],
    agentSkillIds: ["multiplayer"],
    settings: legacyToken ? { credential: legacyToken } : {},
    sdk: {
      projects: {
        list: async () => [
          { id: "proj_a", name: "A" },
          { id: "proj_b", name: "B" },
        ],
        get: async ({ projectId }) => ({ id: projectId, name: projectId }),
      },
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread unavailable");
          return thread;
        },
        timeline: async ({ threadId }) => ({
          rows: [
            {
              kind: "conversation",
              id: "message",
              role: "user",
              initiator: "user",
              text: `Private text for ${threadId}`,
              createdAt: 1,
            },
          ],
          timelinePage: { olderCursor: null },
        }),
      },
    },
  });
  hosts.push(result);
  return { ...result, threads };
}
async function rpc<K extends keyof typeof rpcContract>(
  host: FakePluginHost,
  method: K,
  input?: z.input<(typeof rpcContract)[K]["input"]>,
) {
  return rpcContract[method].output.parse(
    await host.harness.behavior.callRpc(method, input),
  ) as z.output<(typeof rpcContract)[K]["output"]>;
}
async function connectBoth(local: FakePluginHost) {
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  await rpc(local, "connect", { projectId: "proj_b", url, token: b.token });
}
beforeEach(async () => {
  db = new Database(":memory:");
  relay = new RelayStore(db);
  a = relay.initialize("Room A", "Owner A");
  b = relay.createRoom("Room B", "Owner B");
  http = createRelayServer(relay);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const local of hosts.splice(0)) await local.harness.lifecycle.dispose();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});

it("creates a room from a saved owner connection, attaches only the target project and keeps tokens server-side", async () => {
  const local = host();
  plugin(local.bb);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  const before = await rpc(local, "status", { projectId: "proj_a" });
  const original = globalThis.fetch,
    calls: { url: string; body?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: init?.body as string | undefined,
      });
      return original(input, init);
    },
  );
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).sources,
  ).toEqual([
    { projectId: "proj_a", url, roomName: "Room A", ownerName: "Owner A" },
  ]);
  const input = {
    projectId: "proj_b",
    sourceProjectId: "proj_a",
    name: "Billing",
  };
  expect(await rpc(local, "createRoom", input)).toEqual({ ok: true });
  const state = await rpc(local, "status", { projectId: "proj_b" });
  expect(state.identity?.room.name).toBe("Billing");
  expect(state.identity?.member).toMatchObject({
    name: "Owner A",
    role: "owner",
  });
  expect(state.identity?.members).toHaveLength(1);
  expect(state.online).toBe(true);
  expect(state.threads).toEqual([]);
  expect((await rpc(local, "localThread", { threadId: "thr_b" })).sharing).toBe(
    false,
  );
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).connection,
  ).toEqual(before.connection);
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).pending,
  ).toBeNull();
  const payload = JSON.parse(
    calls.find((c) => c.url.endsWith("/v1/rooms"))!.body!,
  );
  expect(Object.keys(payload).sort()).toEqual([
    "name",
    "requestId",
    "tokenHash",
  ]);
  expect(payload.tokenHash).toMatch(/^[a-f0-9]{64}$/);
  expect(await rpc(local, "createRoom", input)).toEqual({ ok: true });
  expect(relay.listRooms().rooms).toHaveLength(3);
  expect(local.harness.inspection.sdk.callsTo("threads.timeline")).toEqual([]);
  expect(JSON.stringify(state)).not.toContain(a.token);
});

it.each(["lost-ack", "identity-failure"])(
  "resumes pending room creation after %s and plugin reload without duplicates",
  async (failure) => {
    const local = host();
    plugin(local.bb);
    await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
    const original = globalThis.fetch,
      payloads: string[] = [];
    let created = false,
      failed = false;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/v1/rooms")) {
          payloads.push(init!.body as string);
          const response = await original(input, init);
          created = true;
          if (failure === "lost-ack" && !failed) {
            failed = true;
            throw new Error("Lost acknowledgement");
          }
          return response;
        }
        if (created && !failed && path.endsWith("/v1/me")) {
          failed = true;
          throw new Error("Temporary failure");
        }
        return original(input, init);
      },
    );
    const input = {
      projectId: "proj_b",
      sourceProjectId: "proj_a",
      name: "Retry room",
    };
    await expect(rpc(local, "createRoom", input)).rejects.toThrow();
    expect(relay.listRooms().rooms).toHaveLength(3);
    const pending = (
      await rpc(local, "roomCreationOptions", { projectId: "proj_b" })
    ).pending;
    expect(pending).toMatchObject({
      name: "Retry room",
      sourceProjectId: "proj_a",
    });
    expect(JSON.stringify(pending)).not.toContain("token");
    await expect(
      rpc(local, "createRoom", { ...input, name: "Different" }),
    ).rejects.toThrow("pending");
    await expect(
      rpc(local, "disconnect", { projectId: "proj_b" }),
    ).rejects.toThrow("pending");
    await expect(
      rpc(local, "connect", { projectId: "proj_b", url, token: b.token }),
    ).rejects.toThrow("pending");
    const reloaded = await local.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    expect(
      (await rpc(reloaded, "roomCreationOptions", { projectId: "proj_b" }))
        .pending,
    ).toEqual(pending);
    expect(await rpc(reloaded, "createRoom", input)).toEqual({ ok: true });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toBe(payloads[1]);
    expect(relay.listRooms().rooms).toHaveLength(3);
    expect(
      (await rpc(reloaded, "status", { projectId: "proj_b" })).identity?.room
        .name,
    ).toBe("Retry room");
  },
);

it("rejects old relay capability, non-owner membership, and unavailable target projects before creation", async () => {
  const local = host();
  plugin(local.bb);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  const original = globalThis.fetch;
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      return String(input).endsWith("/health")
        ? Promise.resolve(
            new Response(JSON.stringify({ ok: true, protocol: 1 }), {
              headers: { "content-type": "application/json" },
            }),
          )
        : original(input, init);
    },
  );
  const input = { projectId: "proj_b", sourceProjectId: "proj_a", name: "New" };
  await expect(rpc(local, "createRoom", input)).rejects.toThrow(
    "Upgrade the relay",
  );
  expect(calls).toEqual([`${url}/health`]);
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).pending,
  ).toBeNull();
  vi.unstubAllGlobals();
  db.prepare("UPDATE members SET role='member' WHERE id=?").run(a.memberId);
  await expect(rpc(local, "createRoom", input)).rejects.toThrow(
    "Only a room owner",
  );
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).sources,
  ).toEqual([]);
  expect(relay.listRooms().rooms).toHaveLength(2);
  local.harness.inspection.sdk.stub("projects.get", async () => {
    throw new Error("Project not found");
  });
  await expect(rpc(local, "createRoom", input)).rejects.toThrow(
    "Project not found",
  );
});

it("fails closed if a pending credential is missing or the source account changes", async () => {
  const local = host();
  plugin(local.bb);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await original(input, init);
      if (String(input).endsWith("/v1/rooms"))
        throw new Error("Lost acknowledgement");
      return response;
    },
  );
  const input = {
    projectId: "proj_b",
    sourceProjectId: "proj_a",
    name: "Pending",
  };
  await expect(rpc(local, "createRoom", input)).rejects.toThrow();
  vi.unstubAllGlobals();
  await local.harness.behavior.setSettings({
    credentials: JSON.stringify({ proj_a: a.token }),
  });
  await expect(rpc(local, "createRoom", input)).rejects.toThrow(
    "credential is missing",
  );
  await expect(
    rpc(local, "disconnect", { projectId: "proj_a" }),
  ).rejects.toThrow("pending room creations");
  // Simulate an externally restored connection with a different account.
  new LocalStore(local.bb.storage.database(), "proj_a").set("connection", {
    url,
    projectId: "proj_a",
    roomId: b.roomId,
    memberId: b.memberId,
  });
  await expect(rpc(local, "createRoom", input)).rejects.toThrow("pending");
  expect(relay.listRooms().rooms).toHaveLength(3);
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).pending
      ?.name,
  ).toBe("Pending");
});

it("does not strand a project after a definite first-request rejection", async () => {
  const local = host();
  plugin(local.bb);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    String(input).endsWith("/v1/rooms")
      ? Promise.resolve(
          new Response(JSON.stringify({ error: "Room limit reached" }), {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        )
      : original(input, init),
  );
  await expect(
    rpc(local, "createRoom", {
      projectId: "proj_b",
      sourceProjectId: "proj_a",
      name: "At cap",
    }),
  ).rejects.toThrow();
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).pending,
  ).toBeNull();
  expect(relay.listRooms().rooms).toHaveLength(2);
  await rpc(local, "connect", { projectId: "proj_b", url, token: b.token });
  expect(
    (await rpc(local, "status", { projectId: "proj_b" })).identity?.room.id,
  ).toBe(b.roomId);
});

it("does not create a room when persisting its owner secret fails", async () => {
  const local = host();
  const define = local.bb.settings.define.bind(local.bb.settings);
  let fail = false;
  const spy = vi
    .spyOn(local.bb.settings, "define")
    .mockImplementation((descriptors) => {
      const handle = define(descriptors),
        save = handle.experimental_set.bind(handle);
      handle.experimental_set = async (values) => {
        if (fail) throw new Error("Secret storage unavailable");
        return save(values);
      };
      return handle;
    });
  plugin(local.bb);
  spy.mockRestore();
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  fail = true;
  await expect(
    rpc(local, "createRoom", {
      projectId: "proj_b",
      sourceProjectId: "proj_a",
      name: "Unsaved",
    }),
  ).rejects.toThrow("Secret storage unavailable");
  expect(relay.listRooms().rooms).toHaveLength(2);
  expect(
    (await rpc(local, "roomCreationOptions", { projectId: "proj_b" })).pending,
  ).toBeNull();
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).connection?.roomId,
  ).toBe(a.roomId);
});

it("connects and syncs two rooms in one installation without leaking credentials or context", async () => {
  const local = host();
  plugin(local.bb);
  await connectBoth(local);
  const overview = await rpc(local, "status");
  expect(overview.connections).toHaveLength(2);
  expect(overview.connection).toBeNull();
  expect(overview.threads).toEqual([]);
  expect(JSON.stringify(overview)).not.toContain(a.token);
  expect(JSON.stringify(overview)).not.toContain(b.token);
  expect(
    local.harness.registrations.settingsDescriptors.credentials,
  ).toMatchObject({ secret: true });
  const sharedA = await rpc(local, "share", {
    threadId: "thr_a",
    confirmed: true,
  });
  const sharedB = await rpc(local, "share", {
    threadId: "thr_b",
    confirmed: true,
  });
  for (const [projectId, credential, shared, foreign] of [
    ["proj_a", a, sharedA, sharedB],
    ["proj_b", b, sharedB, sharedA],
  ] as const) {
    const state = await rpc(local, "status", { projectId });
    expect(state.identity?.room.id).toBe(credential.roomId);
    expect(state.threads.map((t) => t.id)).toEqual([shared.sharedId]);
    expect(state.online).toBe(true);
    await expect(
      rpc(local, "thread", { projectId, id: foreign.sharedId }),
    ).rejects.toThrow("not synced");
    const context = await rpc(local, "discussionContext", {
      threadId: projectId === "proj_a" ? "thr_a" : "thr_b",
    });
    expect(context.identity?.room.id).toBe(credential.roomId);
    expect(context.projectId).toBe(projectId);
  }
  const teams = await rpc(local, "teamThreads");
  expect(teams.projects.map((p) => p.projectId)).toEqual(["proj_a", "proj_b"]);
  await expect(rpc(local, "disconnect")).rejects.toThrow("explicitly");
  await expect(rpc(local, "invite")).rejects.toThrow("explicitly");
  await expect(rpc(local, "thread", { id: sharedA.sharedId })).rejects.toThrow(
    "explicitly",
  );
  await expect(
    rpc(local, "connect", { projectId: "proj_a", url, token: b.token }),
  ).rejects.toThrow("Disconnect this project");
  const before = db.prepare("SELECT count(*) AS n FROM events").get();
  const reloaded = await local.harness.lifecycle.reload(plugin);
  hosts.push(reloaded);
  await rpc(reloaded, "sync");
  expect(db.prepare("SELECT count(*) AS n FROM events").get()).toEqual(before);
  expect(
    (await rpc(reloaded, "teamThreads")).projects.map((p) => p.threads[0].id),
  ).toEqual([sharedA.sharedId, sharedB.sharedId]);
  expect(reloaded.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
});

it("isolates comments, requests, invitations, disconnect and reconnect by project", async () => {
  const local = host();
  plugin(local.bb);
  await connectBoth(local);
  const sharedA = await rpc(local, "share", {
    threadId: "thr_a",
    confirmed: true,
  });
  const sharedB = await rpc(local, "share", {
    threadId: "thr_b",
    confirmed: true,
  });
  const members = [a, b].map((credential) =>
    relay.authenticate(
      relay.join(
        relay.invite(relay.authenticate(credential.token)).code,
        "Teammate",
      ).token,
    ),
  );
  const requestA = relay.createRequest(members[0], {
    id: randomUUID(),
    threadId: sharedA.sharedId,
    body: "A only",
  });
  const requestB = relay.createRequest(members[1], {
    id: randomUUID(),
    threadId: sharedB.sharedId,
    body: "B only",
  });
  const comment = await rpc(local, "addComment", {
    projectId: "proj_a",
    id: randomUUID(),
    threadId: sharedA.sharedId,
    parentId: null,
    anchor: null,
    body: "A comment",
  });
  await expect(
    rpc(local, "resolve", {
      projectId: "proj_b",
      id: comment.id,
      version: 1,
      resolved: true,
    }),
  ).rejects.toThrow();
  await rpc(local, "sync");
  expect(
    (await rpc(local, "requestState", { threadId: "thr_a" })).requests.map(
      (r) => r.id,
    ),
  ).toEqual([requestA.id]);
  expect(
    (await rpc(local, "requestState", { threadId: "thr_b" })).requests.map(
      (r) => r.id,
    ),
  ).toEqual([requestB.id]);
  const inbox = await rpc(local, "requestInbox");
  expect(inbox.requests.map((r) => r.projectId).sort()).toEqual([
    "proj_a",
    "proj_b",
  ]);
  expect(JSON.stringify(inbox)).not.toContain("A only");
  await expect(
    rpc(local, "requestDraft", { projectId: "proj_b", id: requestA.id }),
  ).rejects.toThrow();
  expect(
    (await rpc(local, "requestDraft", { projectId: "proj_a", id: requestA.id }))
      .threadId,
  ).toBe("thr_a");
  await rpc(local, "reviewRequest", {
    projectId: "proj_a",
    id: requestA.id,
    version: 1,
    status: "dismissed",
  });
  expect(relay.request(relay.authenticate(b.token), requestB.id).status).toBe(
    "pending",
  );
  const invite = await rpc(local, "invite", { projectId: "proj_b" });
  expect(
    relay.authenticate(relay.join(invite.code, "New B member").token).roomId,
  ).toBe(b.roomId);
  await rpc(local, "disconnect", { projectId: "proj_a" });
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).connection,
  ).toBeNull();
  expect(
    (await rpc(local, "status", { projectId: "proj_b" })).threads[0].id,
  ).toBe(sharedB.sharedId);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).threads[0].id,
  ).toBe(sharedA.sharedId);
  expect((await rpc(local, "localThread", { threadId: "thr_a" })).sharing).toBe(
    false,
  );
  expect((await rpc(local, "localThread", { threadId: "thr_b" })).sharing).toBe(
    true,
  );
});

it("continues syncing other projects after an offline relay or revoked membership", async () => {
  const local = host();
  plugin(local.bb);
  const member = relay.join(
    relay.invite(relay.authenticate(a.token)).code,
    "Local A",
  );
  await rpc(local, "connect", {
    projectId: "proj_a",
    url,
    token: member.token,
  });
  await rpc(local, "connect", { projectId: "proj_b", url, token: b.token });
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      if (
        (init?.headers as Record<string, string>)?.authorization ===
        `Bearer ${member.token}`
      )
        return Promise.reject(new Error("Offline A"));
      return original(input, init);
    },
  );
  await expect(rpc(local, "sync")).rejects.toThrow();
  expect((await rpc(local, "status", { projectId: "proj_a" })).online).toBe(
    false,
  );
  expect((await rpc(local, "status", { projectId: "proj_b" })).online).toBe(
    true,
  );
  vi.unstubAllGlobals();
  relay.revoke(
    relay.authenticate(a.token),
    relay.authenticate(member.token).id,
  );
  await expect(rpc(local, "sync")).rejects.toThrow("revoked");
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).connection,
  ).toBeNull();
  expect((await rpc(local, "status", { projectId: "proj_b" })).online).toBe(
    true,
  );
  expect(
    (await rpc(local, "status")).connections.map((c) => c.projectId),
  ).toEqual(["proj_b"]);
});

it("stops publication to the old room when a local thread changes projects", async () => {
  const local = host();
  plugin(local.bb);
  await connectBoth(local);
  const shared = await rpc(local, "share", {
    threadId: "thr_a",
    confirmed: true,
  });
  const thread = local.threads.get("thr_a")!;
  thread.projectId = "proj_b";
  await local.harness.behavior.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Moved",
  });
  await rpc(local, "sync");
  expect(
    relay.thread(relay.authenticate(a.token), shared.sharedId).revision,
  ).toBe(1);
  expect(
    (await rpc(local, "discussionContext", { threadId: "thr_a" })).sharedId,
  ).toBeNull();
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).threads[0].sharing,
  ).toBe(false);
  await expect(
    rpc(local, "feedback", { threadId: "thr_a", commentIds: [randomUUID()] }),
  ).rejects.toThrow("local thread owner");
});

it("retains a project's pending publication when another project connects or fails to connect", async () => {
  const local = host();
  plugin(local.bb);
  await rpc(local, "connect", { projectId: "proj_a", url, token: a.token });
  const original = globalThis.fetch;
  let lost = false;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const response = await original(input, init);
      if (
        !lost &&
        String(input).endsWith("/v1/threads") &&
        init?.method === "POST"
      ) {
        lost = true;
        throw new Error("Lost publication acknowledgement");
      }
      return response;
    },
  );
  const shared = await rpc(local, "share", {
    threadId: "thr_a",
    confirmed: true,
  });
  expect((await rpc(local, "status", { projectId: "proj_a" })).error).toContain(
    "could not be published",
  );
  await expect(
    rpc(local, "connect", { projectId: "proj_b", url, token: "x".repeat(43) }),
  ).rejects.toThrow();
  expect(
    (await rpc(local, "status", { projectId: "proj_a" })).connection?.roomId,
  ).toBe(a.roomId);
  await rpc(local, "connect", { projectId: "proj_b", url, token: b.token });
  const before = db
    .prepare("SELECT count(*) AS n FROM events WHERE kind='thread'")
    .get();
  const reloaded = await local.harness.lifecycle.reload(plugin);
  hosts.push(reloaded);
  await rpc(reloaded, "sync");
  expect(
    db.prepare("SELECT count(*) AS n FROM events WHERE kind='thread'").get(),
  ).toEqual(before);
  expect(
    (
      await rpc(reloaded, "thread", {
        projectId: "proj_a",
        id: shared.sharedId,
      })
    ).thread.revision,
  ).toBe(1);
  expect((await rpc(reloaded, "status", { projectId: "proj_b" })).online).toBe(
    true,
  );
});

it("keeps identical IDs on independent relays isolated, including requests and comments", async () => {
  const otherDb = new Database(":memory:"),
    other = new RelayStore(otherDb);
  const credential = other.initialize("Other relay", "Remote owner");
  const otherHttp = createRelayServer(other);
  await new Promise<void>((resolve) =>
    otherHttp.listen(0, "127.0.0.1", resolve),
  );
  const otherUrl = `http://127.0.0.1:${(otherHttp.address() as { port: number }).port}`;
  try {
    const local = host();
    plugin(local.bb);
    const tokens = [relay, other].map(
      (store, i) =>
        store.join(
          store.invite(store.authenticate((i ? credential : a).token)).code,
          "Local member",
        ).token,
    );
    const sharedId = randomUUID(),
      commentId = randomUUID(),
      requestId = randomUUID();
    for (const [store, ownerCredential, title] of [
      [relay, a, "First"],
      [other, credential, "Second"],
    ] as const) {
      const owner = store.authenticate(ownerCredential.token);
      store.publish(owner, {
        id: sharedId,
        revision: 1,
        title,
        status: "idle",
        messages: [],
        historyTruncated: false,
      });
      store.addComment(owner, {
        id: commentId,
        threadId: sharedId,
        parentId: null,
        anchor: null,
        body: title,
      });
    }
    await rpc(local, "connect", { projectId: "proj_a", url, token: tokens[0] });
    await rpc(local, "connect", {
      projectId: "proj_b",
      url: otherUrl,
      token: tokens[1],
    });
    for (const [projectId, title] of [
      ["proj_a", "First"],
      ["proj_b", "Second"],
    ]) {
      const detail = await rpc(local, "thread", { projectId, id: sharedId });
      expect(detail.thread.title).toBe(title);
      expect(detail.comments[0].body).toBe(title);
      await rpc(local, "proposeMessage", {
        projectId,
        id: requestId,
        threadId: sharedId,
        body: title,
      });
      expect(
        (await rpc(local, "requestState", { projectId })).requests[0].body,
      ).toBe(title);
    }
    await rpc(local, "disconnect", { projectId: "proj_a" });
    expect(
      (await rpc(local, "thread", { projectId: "proj_b", id: sharedId }))
        .comments[0].body,
    ).toBe("Second");
    expect(
      (await rpc(local, "requestState", { projectId: "proj_b" })).requests[0]
        .body,
    ).toBe("Second");
  } finally {
    await new Promise<void>((resolve) => otherHttp.close(() => resolve()));
    otherDb.close();
  }
});

it.each([
  { failurePoint: "before", mirrors: false },
  { failurePoint: "after", mirrors: false },
  { failurePoint: "before", mirrors: true },
  { failurePoint: "after", mirrors: true },
])(
  "migrates legacy state (mirrors=$mirrors) and retries a failure $failurePoint saving the project secret",
  async ({ failurePoint, mirrors }) => {
    const local = host(a.token);
    const database = local.bb.storage.database();
    local.bb.storage.migrate(database, [
      ...LocalStore.migrations.slice(0, 6),
      ...(mirrors ? mirrorMigrations : []),
    ]);
    let mirrorId: string | undefined;
    if (mirrors) {
      const mirrorStore = new MirrorStore(database);
      const mirror = mirrorStore.reserve({
        projectId: "proj_a",
        roomId: a.roomId,
        memberId: a.memberId,
        sharedId: randomUUID(),
        hostId: "host_local",
      });
      mirrorId = mirror.id;
      mirrorStore.bind(mirror.id, "thr_existing_mirror");
      database
        .prepare("INSERT INTO mirror_imports VALUES (?, ?, ?, ?)")
        .run(mirror.id, "message", "a".repeat(64), "assistant");
    }
    const actor = relay.authenticate(a.token),
      identity = relay.identity(actor),
      sharedId = randomUUID();
    const snapshot = {
      id: sharedId,
      revision: 4,
      title: "Old shared thread",
      status: "idle" as const,
      messages: [],
      historyTruncated: false,
    };
    relay.publish(actor, snapshot);
    const put = (key: string, value: unknown) =>
      database
        .prepare("INSERT INTO state VALUES (?, ?)")
        .run(key, JSON.stringify(value));
    put("connection", {
      url,
      projectId: "proj_a",
      memberId: a.memberId,
      roomId: a.roomId,
    });
    put("identity", identity);
    const legacyCursor = relay.events(actor, 0).cursor;
    put("cursor", legacyCursor);
    put("requestCursor", 0);
    put("requestsSupported", true);
    database
      .prepare(
        "INSERT INTO links(localId, sharedId, revision, enabled, dirty, payload) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("thr_a", sharedId, 4, 0, 0, JSON.stringify(snapshot));
    database
      .prepare("INSERT INTO cache_threads VALUES (?, ?)")
      .run(sharedId, JSON.stringify(relay.thread(actor, sharedId)));
    const comment = relay.addComment(actor, {
      id: randomUUID(),
      threadId: sharedId,
      parentId: null,
      anchor: null,
      body: "Legacy discussion",
    });
    const member = relay.authenticate(
      relay.join(relay.invite(actor).code, "Legacy member").token,
    );
    const request = relay.createRequest(member, {
      id: randomUUID(),
      threadId: sharedId,
      body: "Legacy proposal",
    });
    database
      .prepare("INSERT INTO cache_comments VALUES (?, ?)")
      .run(comment.id, JSON.stringify(comment));
    database
      .prepare("INSERT INTO cache_requests VALUES (?, ?)")
      .run(request.id, JSON.stringify(request));
    const define = local.bb.settings.define.bind(local.bb.settings);
    const spy = vi
      .spyOn(local.bb.settings, "define")
      .mockImplementation((descriptors) => {
        const handle = define(descriptors);
        const save = handle.experimental_set.bind(handle);
        handle.experimental_set = vi
          .fn(save)
          .mockImplementationOnce(async (values) => {
            if (failurePoint === "after") await save(values);
            throw new Error("Secret storage unavailable");
          });
        return handle;
      });
    plugin(local.bb);
    spy.mockRestore();
    await expect(rpc(local, "status", { projectId: "proj_a" })).rejects.toThrow(
      "Secret storage unavailable",
    );
    expect(database.prepare("SELECT value FROM local_meta").get()).toEqual({
      value: "proj_a",
    });
    const before = await rpc(local, "status", { projectId: "proj_a" });
    expect(before.connection?.memberId).toBe(a.memberId);
    expect(before.threads[0]).toMatchObject({
      id: sharedId,
      revision: 4,
      localId: "thr_a",
      sharing: false,
    });
    const scoped = new LocalStore(database, "proj_a");
    expect(scoped.link("thr_a")?.payload).toBe(JSON.stringify(snapshot));
    expect(scoped.comments(sharedId)).toEqual([comment]);
    expect(scoped.requests()).toEqual([request]);
    expect(scoped.state("cursor", z.number())).toBe(legacyCursor);
    expect(database.prepare("SELECT * FROM local_meta").all()).toEqual([]);
    if (mirrorId) {
      const mirrorStore = new MirrorStore(database);
      expect(mirrorStore.byLocal("thr_existing_mirror")?.id).toBe(mirrorId);
      expect(mirrorStore.imported(mirrorId).get("message")?.version).toBe(
        "a".repeat(64),
      );
    }
    // No fallback to the old secret: after migration, removing it cannot break sync.
    await local.harness.behavior.setSettings({ credential: null });
    expect(
      JSON.stringify(database.prepare("SELECT * FROM project_state").all()),
    ).not.toContain(a.token);
    await rpc(local, "connect", { projectId: "proj_b", url, token: b.token });
    const reloaded = await local.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    await rpc(reloaded, "sync");
    expect(
      (await rpc(reloaded, "status", { projectId: "proj_a" })).threads[0].id,
    ).toBe(sharedId);
    expect(
      (await rpc(reloaded, "status", { projectId: "proj_b" })).identity?.room
        .id,
    ).toBe(b.roomId);
  },
);
