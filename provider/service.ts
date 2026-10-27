import type {
  BbPluginApi,
  MessageDispatchHookContext,
} from "@get-bb/plugin-sdk";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { LocalStore } from "../plugin/local-store";
import type { RelayClient } from "../plugin/client";
import { threadSchema } from "../shared/protocol";
import { messageRequestSchema } from "../shared/requests";
import { MirrorStore, proposalId, type Mirror } from "./mirror-store";
import {
  MIRROR_PROVIDER,
  MIRROR_ENVIRONMENT,
  MIRROR_TOOL,
  REFRESH_PROMPT,
  mirrorMarkerSchema,
  mirrorHostContract,
  mirrorModel,
  mirrorOperationSchema,
  type MirrorReply,
} from "./contracts";
import { batchIsPersisted, nextMirrorBatch } from "./mirror-projection";

type Connection = {
  roomId: string;
  memberId: string;
  projectId: string;
  url: string;
};
export function registerMirrors(
  bb: BbPluginApi,
  store: LocalStore,
  options: {
    enabled: () => Promise<boolean>;
    connection: () => Connection | null;
    client: (signal?: AbortSignal) => Promise<RelayClient>;
    signal: AbortSignal;
    changed: () => void;
  },
) {
  const mirrors = new MirrorStore(store.db);
  const host = bb.hosts.experimental_client({ contract: mirrorHostContract });
  let creation = Promise.resolve();
  const operations = new Map<string, Promise<unknown>>();
  const refreshInFlight = new Set<string>();
  function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const result = (operations.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    operations.set(id, result);
    void result
      .finally(() => {
        if (operations.get(id) === result) operations.delete(id);
      })
      .catch(() => {});
    return result;
  }
  async function authorized(localId: string, signal = options.signal) {
    const mirror = mirrors.byLocal(localId),
      conn = options.connection();
    if (
      !(await options.enabled()) ||
      !mirror ||
      mirror.state !== "ready" ||
      !conn ||
      mirror.roomId !== conn.roomId ||
      mirror.memberId !== conn.memberId ||
      mirror.projectId !== conn.projectId
    )
      throw new Error(
        "Mirror is disconnected, disabled or not mapped to this account",
      );
    const thread = await bb.sdk.threads.get({ threadId: localId, signal });
    if (
      thread.providerId !== MIRROR_PROVIDER ||
      thread.projectId !== mirror.projectId ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null
    )
      throw new Error("Mirror provider/project/lifecycle mismatch");
    return mirror;
  }
  async function history(mirror: Mirror, signal: AbortSignal) {
    const rows = [] as Awaited<ReturnType<typeof bb.sdk.threads.events.list>>;
    let after = "0";
    for (let page = 0; page < 100; page++) {
      const batch = await bb.sdk.threads.events.list({
        threadId: mirror.localId!,
        afterSeq: after,
        limit: "100",
        types: ["item/completed"],
        signal,
      });
      rows.push(...batch);
      if (batch.length < 100) return rows;
      const next = batch.at(-1)!.seq;
      if (next <= Number(after))
        throw new Error("Invalid local history cursor");
      after = String(next);
    }
    throw new Error(
      "Mirror history recovery exceeds safety limit; no batch was replayed",
    );
  }
  async function confirm(mirror: Mirror, batchId: string, signal: AbortSignal) {
    const batch = mirrors.pending(mirror.id);
    if (!batch || batch.id !== batchId)
      throw new Error("Unknown pending mirror batch");
    // Provider output and tool delivery use separate queues. Wait for durable
    // ingestion, not an unverified bridge acknowledgement.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (batchIsPersisted(batch, await history(mirror, signal))) {
        mirrors.commit(mirror.id, batchId);
        return;
      }
      await delay(100, undefined, { signal });
    }
    throw new Error(
      "Import persistence is uncertain. Automatic replay is blocked to avoid duplicate messages.",
    );
  }
  bb.providers.register({
    id: MIRROR_PROVIDER,
    displayName: "Multiplayer Mirror [Experimental]",
    icon: "./assets/people.svg",
    family: "multiplayer",
    strings: {
      signInHint: "Connect Multiplayer and open a shared conversation.",
      expiredHint: "Reconnect Multiplayer.",
      installUrl: "https://github.com/mihver1/bb-multiplayer",
    },
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["accept-edits"],
      reasoningLevels: ["low"],
    },
    composerActions: [],
    completedTurnDisplay: "flat",
    models: { fallback: [mirrorModel], scope: "host" },
    extensionKinds: { "mirror-batch": { item: mirrorMarkerSchema } },
  });
  bb.experimental_environments.register({
    id: MIRROR_ENVIRONMENT,
    displayName: "Multiplayer view",
    description: "Empty plugin-owned directory; not a code checkout.",
    icon: "multiplayer/people",
    inputs: z.object({ mirrorId: z.string().uuid() }).strict(),
    requires: {},
    policy: { retireGraceMs: null },
    async create({ host: target, inputs, thread, signal }) {
      const mirror = mirrors.byId(inputs.mirrorId);
      if (
        !mirror ||
        mirror.hostId !== target.id ||
        mirror.localId !== thread.id ||
        mirror.state !== "ready" ||
        thread.providerId !== MIRROR_PROVIDER
      )
        return {
          status: "failed",
          message: "No matching native mirror reservation",
        };
      const path = await host.call("workspace", inputs, {
        hostId: target.id,
        signal,
      });
      return { status: "created", path: path.path, ownsPath: false };
    },
    async remove() {
      return { status: "removed" };
    },
  });
  bb.agents.registerTool({
    name: MIRROR_TOOL,
    description:
      "Internal transport for mapped Multiplayer mirrors only. Never executes code or forwards instructions to an agent.",
    parameters: mirrorOperationSchema,
    async execute(input, ctx) {
      return exclusive(ctx.threadId, async () => {
        const signal = AbortSignal.any([ctx.signal, options.signal]);
        signal.throwIfAborted();
        const mirror = await authorized(ctx.threadId, signal);
        const remote = await options.client(signal);
        // Every read revalidates remote membership; no member credential ever
        // crosses the provider wire. A disconnected mirror cannot read stale cache.
        if (input.op === "propose") {
          const request = await remote.call(
            "message-requests",
            messageRequestSchema,
            {
              id: proposalId(mirror.id, input.clientRequestId),
              threadId: mirror.sharedId,
              body: input.body,
            },
          );
          store.request(request);
          options.changed();
          return JSON.stringify({
            kind: "proposed",
            requestId: request.id,
          } satisfies MirrorReply);
        }
        const snapshot = await remote.call(
          `thread?id=${mirror.sharedId}`,
          threadSchema,
        );
        if (
          snapshot.id !== mirror.sharedId ||
          snapshot.ownerId === mirror.memberId ||
          snapshot.status === "deleted"
        )
          throw new Error("Remote thread unavailable for this mirror");
        if (input.op === "commit") {
          await confirm(mirror, input.batchId, signal);
          return JSON.stringify({ kind: "committed" } satisfies MirrorReply);
        }
        const pending = mirrors.pending(mirror.id);
        if (pending) {
          await confirm(mirror, pending.id, signal);
        }
        const batch = nextMirrorBatch(snapshot, mirrors.imported(mirror.id));
        if (!batch)
          return JSON.stringify({ kind: "done" } satisfies MirrorReply);
        mirrors.prepare(mirror.id, batch);
        return JSON.stringify({ kind: "batch", batch } satisfies MirrorReply);
      });
    },
  });
  bb.agents.configure((ctx) => ({
    tools:
      ctx.provider.id === MIRROR_PROVIDER &&
      mirrors.byLocal(ctx.thread.id)?.state === "ready"
        ? [MIRROR_TOOL]
        : [],
    skills: ctx.provider.id === MIRROR_PROVIDER ? [] : ["multiplayer"],
  }));
  function bindCreation(ctx: MessageDispatchHookContext) {
    const intent = ctx.environmentIntent;
    if (
      intent?.kind !== "provider" ||
      intent.environmentProviderId !== MIRROR_ENVIRONMENT ||
      intent.machine.type !== "existing"
    )
      return null;
    const mirrorId = (intent.inputs as { mirrorId?: unknown } | null)?.mirrorId;
    const hostId = intent.machine.hostId;
    const candidate = mirrors
      .list()
      .filter(
        (m) =>
          m.state === "creating" &&
          m.projectId === ctx.thread.projectId &&
          m.id === mirrorId &&
          m.hostId === hostId,
      );
    if (
      candidate.length !== 1 ||
      ctx.thread.originPluginId !== bb.pluginId ||
      ctx.originPluginId !== bb.pluginId ||
      ctx.input.text !== REFRESH_PROMPT
    )
      return null;
    const mirror = candidate[0];
    mirrors.bind(mirror.id, ctx.thread.id);
    return mirrors.byLocal(ctx.thread.id);
  }
  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    let mirror = mirrors.byLocal(ctx.thread.id);
    if (
      ctx.thread.providerId !== MIRROR_PROVIDER &&
      ctx.requestedExecution.providerId !== MIRROR_PROVIDER &&
      !mirror
    ) {
      if (
        ctx.thread.sourceThreadId &&
        mirrors.byLocal(ctx.thread.sourceThreadId)
      )
        return {
          action: "reject",
          message:
            "Mirror provider switching/forking is disabled. Create a separate local task instead.",
        };
      return { action: "proceed" };
    }
    if (!(await options.enabled()))
      return {
        action: "reject",
        message: "Native mirrors are disabled in Multiplayer settings.",
      };
    if (
      ctx.requestedExecution.providerId !== MIRROR_PROVIDER ||
      ctx.thread.providerId !== MIRROR_PROVIDER
    )
      return {
        action: "reject",
        message: "A native mirror cannot switch to an executable provider.",
      };
    mirror ??= bindCreation(ctx);
    const conn = options.connection();
    if (
      !mirror ||
      mirror.state !== "ready" ||
      !conn ||
      mirror.roomId !== conn.roomId ||
      mirror.memberId !== conn.memberId ||
      mirror.projectId !== conn.projectId
    )
      return {
        action: "reject",
        message: "Open this mirror from its connected Multiplayer project.",
      };
    if (
      ctx.input.blocks.some((b) => b.type !== "text" || b.mentions.length > 0)
    )
      return {
        action: "reject",
        message:
          "Mirrors accept plain text only; attachments and mentions are not uploaded.",
      };
    if (
      ctx.input.text !== REFRESH_PROMPT &&
      (ctx.input.text.length > 16000 ||
        !ctx.input.text.trim() ||
        ctx.initiator !== "user")
    )
      return {
        action: "reject",
        message:
          "Only a human plain-text proposal can be sent to the remote owner.",
      };
    if (ctx.attempt === "join-turn")
      return {
        action: "wait",
        reason: "Waiting for mirror import/proposal to finish",
      };
    return { action: "proceed" };
  });
  async function open(sharedId: string, hostId: string) {
    if (!(await options.enabled()))
      throw new Error(
        "Enable experimental native mirrors in Multiplayer settings first",
      );
    const conn = options.connection();
    if (!conn) throw new Error("Connect Multiplayer first");
    const snapshot = await (
      await options.client()
    ).call(`thread?id=${sharedId}`, threadSchema);
    if (snapshot.id !== sharedId)
      throw new Error("Relay returned a different shared thread");
    const current = options.connection();
    if (
      !current ||
      current.roomId !== conn.roomId ||
      current.memberId !== conn.memberId ||
      current.projectId !== conn.projectId ||
      current.url !== conn.url
    )
      throw new Error(
        "Multiplayer connection changed while opening the mirror",
      );
    if (snapshot.ownerId === conn.memberId)
      throw new Error("Open your own original thread, not a mirror");
    if (snapshot.status === "deleted" || snapshot.status === "archived")
      throw new Error("Remote thread is not active");
    let mirror = mirrors.find({ ...conn, sharedId });
    if (mirror) {
      if (mirror.state !== "ready" || !mirror.localId)
        throw new Error(
          "Mirror creation/import requires recovery; refusing to create a duplicate",
        );
      await authorized(mirror.localId);
      await bb.sdk.threads.send({
        threadId: mirror.localId,
        mode: "queue-if-active",
        input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
      });
      return { threadId: mirror.localId };
    }
    mirror = mirrors.reserve({
      roomId: conn.roomId,
      memberId: conn.memberId,
      projectId: conn.projectId,
      sharedId,
      hostId,
    });
    const thread = await bb.sdk.threads.spawn({
      projectId: conn.projectId,
      providerId: MIRROR_PROVIDER,
      model: mirrorModel.id,
      permissionMode: "accept-edits",
      reasoningLevel: "low",
      title: `${snapshot.title} · Mirror`,
      environment: {
        type: "provider",
        environmentProviderId: MIRROR_ENVIRONMENT,
        inputs: { mirrorId: mirror.id },
        machine: { type: "existing", hostId },
      },
      input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
      pluginMetadata: { mirrorId: mirror.id },
    });
    mirrors.bind(mirror.id, thread.id);
    options.changed();
    return { threadId: thread.id };
  }
  return {
    mirrors,
    open(sharedId: string, hostId: string) {
      const result = creation.then(() => open(sharedId, hostId));
      creation = result.then(
        () => {},
        () => {},
      );
      return result;
    },
    async refresh(localId: string) {
      await authorized(localId);
      if (refreshInFlight.has(localId))
        throw new Error("Mirror refresh already requested");
      refreshInFlight.add(localId);
      try {
        await bb.sdk.threads.send({
          threadId: localId,
          mode: "queue-if-active",
          input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
        });
      } finally {
        refreshInFlight.delete(localId);
      }
    },
    async disconnect() {
      mirrors.blockAll();
      for (const mirror of mirrors.list())
        if (mirror.localId) {
          try {
            await bb.sdk.threads.stop({ threadId: mirror.localId });
          } catch {
            /* Blocking mapping already fails closed. */
          }
        }
    },
    async dispose() {
      await creation;
      await Promise.allSettled(operations.values());
    },
  };
}
