import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import { experimental_createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import plugin, { rpcContract } from "../server";
import { RelayStore } from "../relay/store";
import { createRelayServer } from "../relay/http";
import { fixtureSnapshot } from "./mirror-fixture";
import {
  MIRROR_TOOL,
  MIRROR_PROVIDER,
  REFRESH_PROMPT,
  mirrorReplySchema,
} from "../provider/contracts";
import { batchDeltas } from "../provider/mirror-projection";

let db: Database.Database,
  relay: RelayStore,
  http: ReturnType<typeof createRelayServer>;
let host: ReturnType<typeof createFakePluginHost>, url: string, token: string;
let owner: ReturnType<RelayStore["authenticate"]>;
const local = makeThreadResponse({
  id: "thr_mirror",
  projectId: "proj_b",
  providerId: MIRROR_PROVIDER,
});
let events: unknown[] = [];
let handles: ReturnType<typeof createFakePluginHost>[] = [];
beforeEach(async () => {
  db = new Database(":memory:");
  relay = new RelayStore(db);
  owner = relay.authenticate(relay.initialize("Team", "Alice").token);
  const { ownerId: _, updatedAt: __, ...snapshot } = fixtureSnapshot();
  relay.publish(owner, snapshot);
  token = relay.join(relay.invite(owner).code, "Bob").token;
  http = createRelayServer(relay);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  events = [];
  host = createFakePluginHost({
    pluginId: "multiplayer",
    experimental_declaredIconNames: ["people"],
    agentSkillIds: ["multiplayer"],
    sdk: {
      projects: {
        get: async () => ({ id: "proj_b", name: "B" }),
        list: async () => [],
      },
      threads: {
        get: async () => local,
        spawn: async () => local,
        send: async () => ({}),
        stop: async () => ({}),
        events: { list: async () => events },
      },
    },
  });
  handles = [host];
  plugin(host.bb);
  await host.harness.behavior.callRpc("connect", {
    url,
    projectId: "proj_b",
    token,
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of handles) await h.harness.lifecycle.dispose();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  db.close();
});
async function open() {
  return rpcContract.openNativeMirror.output.parse(
    await host.harness.behavior.callRpc("openNativeMirror", {
      sharedId: fixtureSnapshot().id,
      hostId: "host_local",
    }),
  );
}
async function operation(input: unknown) {
  const result = await host.harness.behavior.callAgentTool(MIRROR_TOOL, input, {
    threadId: local.id,
    projectId: "proj_b",
  });
  if (typeof result !== "string") throw new Error(JSON.stringify(result));
  return mirrorReplySchema.parse(JSON.parse(result));
}
function hook(
  overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {},
) {
  return host.harness.registrations.hooks["message.dispatch"]!(
    makeMessageDispatchHookContext({
      thread: local,
      requestedExecution: { providerId: MIRROR_PROVIDER },
      input: {
        text: REFRESH_PROMPT,
        blocks: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
      },
      ...overrides,
    }),
  );
}

async function persistImport() {
  const result = await operation({ op: "read" });
  if (result.kind !== "batch") throw new Error("Expected batch");
  const assembler = experimental_createDeltaAssembler({
    providerId: MIRROR_PROVIDER,
  });
  const offset = events.length;
  events.push(
    ...assembler
      .assemble({
        threadId: local.id,
        deltas: [{ kind: "turn.open" }, ...batchDeltas(result.batch)],
      })
      .map(({ type, scope, ...data }, i) => ({
        type,
        scope,
        data,
        seq: offset + i + 1,
        id: `e${offset + i}`,
        threadId: local.id,
        createdAt: 1,
      })),
  );
  return result.batch;
}
function autoRefresh() {
  return host.harness.behavior.callRpc("refreshNativeMirror", {
    threadId: local.id,
    onlyIfChanged: true,
  });
}

describe("native mirror server boundary", () => {
  it("enables native views by default but respects an explicitly disabled setting", async () => {
    expect(
      await host.harness.behavior.callRpc("nativeMirrorOptions", {
        projectId: "proj_b",
      }),
    ).toMatchObject({ enabled: true, mirrors: [] });
    await host.harness.behavior.setSettings({ nativeMirrors: false });
    expect(
      await host.harness.behavior.callRpc("nativeMirrorOptions", {
        projectId: "proj_b",
      }),
    ).toMatchObject({ enabled: false });
    await expect(open()).rejects.toThrow("Enable experimental native mirrors");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(
      0,
    );
  });
  it("polls only changed message versions, including edits, without empty refresh turns", async () => {
    await open();
    const first = await persistImport();
    await operation({ op: "commit", batchId: first.id });
    await autoRefresh();
    await autoRefresh();
    await open();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    const { ownerId: _, updatedAt: __, ...snapshot } = fixtureSnapshot();
    const text = "Updated remote answer";
    relay.publish(owner, {
      ...snapshot,
      revision: 2,
      messages: snapshot.messages.map((m) =>
        m.id === "a1"
          ? {
              ...m,
              text,
              version: createHash("sha256").update(text).digest("hex"),
            }
          : m,
      ),
    });
    await autoRefresh();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(
      host.harness.inspection.sdk.callsTo("threads.send")[0]?.[0],
    ).toMatchObject({
      threadId: local.id,
      mode: "start",
      input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
    });
    const edit = await persistImport();
    expect(edit.entries).toHaveLength(1);
    expect(edit.entries[0].text).toContain("Updated remote assistant message");
    await operation({ op: "commit", batchId: edit.id });
    await autoRefresh();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
  it("rechecks connection and runtime after an in-flight relay read", async () => {
    await open();
    const fetch = globalThis.fetch;
    let finish!: () => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
      const response = await fetch(...args);
      if (String(args[0]).includes("/v1/thread?"))
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return response;
    });
    const refresh = autoRefresh();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    host.harness.inspection.sdk.stub("threads.get", async () => ({
      ...local,
      runtime: { displayStatus: "active" },
    }));
    finish();
    await refresh;
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);

    host.harness.inspection.sdk.stub("threads.get", async () => local);
    let settled = false;
    const disconnected = autoRefresh().catch((cause) => {
      settled = true;
      expect(cause.message).toContain("not mapped");
    });
    const previous = finish;
    await vi.waitFor(() => expect(finish).not.toBe(previous));
    await host.harness.behavior.callRpc("disconnect", { projectId: "proj_b" });
    finish();
    await disconnected;
    expect(settled).toBe(true);
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("coalesces simultaneous refreshes from multiple views", async () => {
    await open();
    let finish!: () => void;
    host.harness.inspection.sdk.stub(
      "threads.send",
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, delivery: "sent" });
        }),
    );
    const refreshes = [autoRefresh(), autoRefresh(), autoRefresh()];
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    finish();
    await Promise.all(refreshes);
  });
  it.each([
    "active",
    "starting",
    "pending",
    "provisioning",
    "waiting-for-host",
    "stopping",
  ] as const)(
    "does not queue refreshes while runtime is %s",
    async (displayStatus) => {
      await open();
      host.harness.inspection.sdk.stub("threads.get", async () => ({
        ...local,
        runtime: { displayStatus },
      }));
      await autoRefresh();
      await autoRefresh();
      expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(
        0,
      );
    },
  );
  it("does not queue behind proposals and requires manual retry after runtime failure", async () => {
    await open();
    host.harness.inspection.sdk.stub("threads.get", async () => ({
      ...local,
      queuedMessageCount: 1,
    }));
    await autoRefresh();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    host.harness.inspection.sdk.stub("threads.get", async () => ({
      ...local,
      runtime: { displayStatus: "error" },
    }));
    await expect(autoRefresh()).rejects.toThrow("needs attention");
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    await host.harness.behavior.callRpc("refreshNativeMirror", {
      threadId: local.id,
    });
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  });
  it("reconciles a persisted pending import during polling without sending another turn", async () => {
    await open();
    await persistImport();
    await autoRefresh();
    await autoRefresh();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
    expect(await operation({ op: "read" })).toEqual({ kind: "done" });
  });
  it("never replays uncertain pending imports from the automatic poller", async () => {
    await open();
    expect((await operation({ op: "read" })).kind).toBe("batch");
    await expect(autoRefresh()).rejects.toThrow("persistence is uncertain");
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it.each([
    "disabled",
    "disconnected",
    "archived",
    "deleted",
    "wrong-provider",
    "revoked",
  ])("does not auto-refresh a %s mirror", async (reason) => {
    await open();
    if (reason === "disabled")
      await host.harness.behavior.setSettings({ nativeMirrors: false });
    if (reason === "disconnected")
      await host.harness.behavior.callRpc("disconnect");
    if (reason === "revoked") relay.revoke(owner, relay.authenticate(token).id);
    if (
      reason === "archived" ||
      reason === "deleted" ||
      reason === "wrong-provider"
    )
      host.harness.inspection.sdk.stub("threads.get", async () => ({
        ...local,
        ...(reason === "archived" && { archivedAt: 1 }),
        ...(reason === "deleted" && { deletedAt: 1 }),
        ...(reason === "wrong-provider" && { providerId: "pi" }),
      }));
    await expect(autoRefresh()).rejects.toThrow();
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("reserves one mirror and reuses it; real owners never get a mirror of their own thread", async () => {
    const [a, b] = await Promise.all([open(), open()]);
    expect(a).toEqual(b);
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(
      1,
    );
    const args = host.harness.inspection.sdk.callsTo("threads.spawn")[0];
    expect(JSON.stringify(args)).toContain("multiplayer-view");
    expect(JSON.stringify(args)).not.toContain(token);
  });
  it("hides internal transport from normal agents and gates tools by server-owned mapping", async () => {
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        provider: { id: "pi" },
        thread: { id: "thr_normal" },
      }),
    );
    expect(config.tools).toEqual([]);
    expect(config.skills).toEqual(["multiplayer"]);
    await expect(operation({ op: "read" })).rejects.toThrow("not mapped");
    await open();
    const mirrorConfig = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        provider: { id: MIRROR_PROVIDER },
        thread: { id: local.id },
      }),
    );
    expect(mirrorConfig.tools.map((t) => t.name)).toEqual([MIRROR_TOOL]);
    host.harness.inspection.sdk.stub("threads.get", async () => ({
      ...local,
      providerId: "pi",
    }));
    await expect(operation({ op: "read" })).rejects.toThrow("mismatch");
  });
  it("confirms persistence, survives reload and emits nothing twice", async () => {
    await open();
    const first = await operation({ op: "read" });
    if (first.kind !== "batch") throw new Error("Expected batch");
    const assembler = experimental_createDeltaAssembler({
      providerId: MIRROR_PROVIDER,
    });
    events = assembler
      .assemble({
        threadId: local.id,
        deltas: [
          { kind: "session.reset" },
          { kind: "turn.open" },
          ...batchDeltas(first.batch),
        ],
      })
      .map(({ type, scope, ...data }, i) => ({
        type,
        scope,
        data,
        seq: i + 1,
        id: `e${i}`,
        threadId: local.id,
        createdAt: 1,
      }));
    // Simulate losing the commit call: reconciliation uses the persisted receipt.
    const reloaded = await host.harness.lifecycle.reload(plugin);
    handles.push(reloaded);
    host = reloaded;
    expect(await operation({ op: "read" })).toEqual({ kind: "done" });
    expect(await operation({ op: "read" })).toEqual({ kind: "done" });
  });
  it("blocks uncertain partially imported batches instead of replaying", async () => {
    await open();
    expect((await operation({ op: "read" })).kind).toBe("batch");
    await expect(operation({ op: "read" })).rejects.toThrow(
      "persistence is uncertain",
    );
  });
  it("rejects attachments/provider switches/forks/republishing and disables on disconnect", async () => {
    await open();
    expect((await hook()).action).toBe("proceed");
    expect(
      (await hook({ requestedExecution: { providerId: "pi" } })).action,
    ).toBe("reject");
    expect(
      (
        await hook({
          input: {
            text: "",
            blocks: [{ type: "localFile", path: "/private/.env" }],
          },
        })
      ).action,
    ).toBe("reject");
    expect(
      (
        await hook({
          thread: {
            ...local,
            id: "thr_fork",
            providerId: "pi",
            sourceThreadId: local.id,
          },
          requestedExecution: { providerId: "pi" },
        })
      ).action,
    ).toBe("reject");
    await expect(
      host.harness.behavior.callRpc("share", {
        threadId: local.id,
        confirmed: true,
      }),
    ).rejects.toThrow("cannot be republished");
    await host.harness.behavior.callRpc("disconnect");
    expect((await hook()).action).toBe("reject");
    expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(1);
  });
  it("creates idempotent owner proposals, never executes the owner's agent", async () => {
    await open();
    const input = {
      op: "propose",
      clientRequestId: "creq_23456789ab",
      body: "Cover rollback",
    };
    const first = await operation(input);
    expect(first.kind).toBe("proposed");
    expect(await operation(input)).toEqual(first);
    expect(db.prepare("SELECT count(*) n FROM message_requests").get()).toEqual(
      { n: 1 },
    );
    expect(host.harness.inspection.sdk.callsTo("threads.send")).toEqual([]);
  });
  it("binds the first dispatch only to the reserved mirror environment, not forged metadata", async () => {
    host.harness.inspection.sdk.stub("threads.spawn", async (args: unknown) => {
      const intent = (
        args as {
          environment: {
            type: string;
            environmentProviderId: string;
            inputs: null | { mirrorId: string };
          };
        }
      ).environment;
      if (intent.type !== "provider")
        throw new Error("Expected dedicated mirror environment");
      const fn = host.harness.registrations.hooks["message.dispatch"]!;
      const base = {
        thread: { ...local, originPluginId: "multiplayer" },
        originPluginId: "multiplayer",
        requestedExecution: { providerId: MIRROR_PROVIDER },
        input: {
          text: REFRESH_PROMPT,
          blocks: [
            { type: "text" as const, text: REFRESH_PROMPT, mentions: [] },
          ],
        },
      };
      expect(
        (
          await fn(
            makeMessageDispatchHookContext({
              ...base,
              environmentIntent: {
                kind: "provider",
                environmentProviderId: "other",
                machine: { type: "existing", hostId: "host_local" },
                inputs: intent.inputs,
              },
            }),
          )
        ).action,
      ).toBe("reject");
      expect(
        (
          await fn(
            makeMessageDispatchHookContext({
              ...base,
              environmentIntent: {
                kind: "provider",
                environmentProviderId: intent.environmentProviderId,
                machine: { type: "existing", hostId: "host_local" },
                inputs: intent.inputs,
              },
            }),
          )
        ).action,
      ).toBe("proceed");
      return local;
    });
    await open();
    expect((await operation({ op: "read" })).kind).toBe("batch");
  });
  it("retains the real API page limit when verifying native event persistence", async () => {
    await open();
    const first = await operation({ op: "read" });
    if (first.kind !== "batch") throw new Error("Expected batch");
    host.harness.inspection.sdk.stub(
      "threads.events.list",
      async (args: unknown) => {
        expect(Number((args as { limit: string }).limit)).toBeLessThanOrEqual(
          100,
        );
        const assembler = experimental_createDeltaAssembler({
          providerId: MIRROR_PROVIDER,
        });
        return assembler
          .assemble({
            threadId: local.id,
            deltas: [{ kind: "turn.open" }, ...batchDeltas(first.batch)],
          })
          .map(({ type, scope, ...data }, i) => ({
            type,
            scope,
            data,
            seq: i + 1,
            id: `e${i}`,
            threadId: local.id,
            createdAt: 1,
          }));
      },
    );
    expect(await operation({ op: "commit", batchId: first.batch.id })).toEqual({
      kind: "committed",
    });
  });
  it.each(["disconnect", "revoke"])(
    "routes mirrors by project and isolates %s from another room",
    async (action) => {
      const otherOwner = relay.authenticate(
        relay.createRoom("Other project", "Carol").token,
      );
      const { ownerId: _, updatedAt: __, ...snapshot } = fixtureSnapshot();
      const otherSnapshot = {
        ...snapshot,
        id: randomUUID(),
        title: "Other room thread",
      };
      relay.publish(otherOwner, otherSnapshot);
      const otherToken = relay.join(
        relay.invite(otherOwner).code,
        "Other member",
      ).token;
      const otherLocal = makeThreadResponse({
        ...local,
        id: "thr_mirror_c",
        projectId: "proj_c",
      });
      host.harness.inspection.sdk.stub("threads.get", async ({ threadId }) =>
        threadId === otherLocal.id ? otherLocal : local,
      );
      host.harness.inspection.sdk.stub(
        "threads.spawn",
        async ({ projectId }) => (projectId === "proj_c" ? otherLocal : local),
      );
      await open();
      await host.harness.behavior.callRpc("connect", {
        url,
        projectId: "proj_c",
        token: otherToken,
      });
      await host.harness.behavior.callRpc("openNativeMirror", {
        projectId: "proj_c",
        sharedId: otherSnapshot.id,
        hostId: "host_local",
      });
      const options = rpcContract.nativeMirrorOptions.output.parse(
        await host.harness.behavior.callRpc("nativeMirrorOptions", {
          projectId: "proj_c",
        }),
      );
      expect(options.mirrors.map((m) => m.localId)).toEqual([otherLocal.id]);
      const proposal = {
        op: "propose",
        clientRequestId: "same_client_request",
        body: "Scoped proposal",
      };
      await operation(proposal);
      await host.harness.behavior.callAgentTool(MIRROR_TOOL, proposal, {
        threadId: otherLocal.id,
        projectId: "proj_c",
      });
      const a = rpcContract.requestState.output.parse(
        await host.harness.behavior.callRpc("requestState", {
          projectId: "proj_b",
        }),
      );
      const b = rpcContract.requestState.output.parse(
        await host.harness.behavior.callRpc("requestState", {
          projectId: "proj_c",
        }),
      );
      expect(a.requests.map((r) => r.threadId)).toEqual([snapshot.id]);
      expect(b.requests.map((r) => r.threadId)).toEqual([otherSnapshot.id]);
      if (action === "disconnect")
        await host.harness.behavior.callRpc("disconnect", {
          projectId: "proj_c",
        });
      else {
        relay.revoke(otherOwner, relay.authenticate(otherToken).id);
        await expect(host.harness.behavior.callRpc("sync")).rejects.toThrow(
          "revoked",
        );
      }
      expect(host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(
        1,
      );
      expect(
        JSON.stringify(host.harness.inspection.sdk.callsTo("threads.stop")),
      ).toContain(otherLocal.id);
      expect((await operation({ op: "read" })).kind).toBe("batch");
      await expect(
        host.harness.behavior.callAgentTool(
          MIRROR_TOOL,
          { op: "read" },
          { threadId: otherLocal.id, projectId: "proj_c" },
        ),
      ).rejects.toThrow("not mapped");
      const state = rpcContract.nativeMirrorState.output.parse(
        await host.harness.behavior.callRpc("nativeMirrorState", {
          threadId: local.id,
        }),
      );
      expect(state.projectId).toBe("proj_b");
      expect(state.connected).toBe(true);
    },
  );

  it("does not create another mirror after an ambiguous spawn failure", async () => {
    host.harness.inspection.sdk.stub("threads.spawn", async () => {
      throw new Error("Lost spawn acknowledgement");
    });
    await expect(open()).rejects.toThrow("Lost spawn");
    await expect(open()).rejects.toThrow("duplicate");
    expect(host.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(
      1,
    );
  });
});
