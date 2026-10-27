import {
  experimental_defineProviderBridge,
  createBridgeIo,
  decodeToolCallResponsePayload,
  initializeParamsSchema,
  threadStartParamsSchema,
  threadResumeParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  threadStopParamsSchema,
  modelListParamsSchema,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  BRIDGE_JSON_RPC_ERRORS,
  type ThreadDelta,
  type PromptInput,
} from "@get-bb/plugin-sdk/provider-bridge";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MIRROR_TOOL,
  REFRESH_PROMPT,
  mirrorModel,
  mirrorReplySchema,
  type MirrorOperation,
  type MirrorReply,
} from "./contracts";
import { batchDeltas } from "./mirror-projection";

type RpcId = string | number;
type Session = {
  threadId: string;
  providerThreadId: string;
  active: boolean;
  controller: AbortController | null;
};
const ENVELOPE = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

/** No CLI, model, file tool, credentials or network access. The only outbound
 * requests are to our narrowly scoped server-side tool over BB's authenticated
 * provider channel. create() makes lifecycle/IO testable without spawning. */
export function createMirrorBridge(write?: (line: string) => void) {
  const io = createBridgeIo<Record<string, unknown>>({ write });
  const sessions = new Map<string, Session>();
  const pending = new Map<
    RpcId,
    {
      session: Session;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      abort: () => void;
    }
  >();
  function emit(session: Session, deltas: ThreadDelta[]) {
    io.send({
      jsonrpc: "2.0",
      method: "thread/delta",
      params: { threadId: session.threadId, deltas },
    });
  }
  function cancel(session: Session) {
    session.controller?.abort();
    if (session.active) {
      emit(session, [{ kind: "turn.boundary", status: "interrupted" }]);
      session.active = false;
    }
    sessions.delete(session.threadId);
  }
  function tool(
    session: Session,
    operation: MirrorOperation,
  ): Promise<MirrorReply> {
    const signal = session.controller!.signal;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Mirror stopped"));
        return;
      }
      const id = randomUUID();
      const cleanup = () => {
        const p = pending.get(id);
        if (p) {
          clearTimeout(p.timer);
          signal.removeEventListener("abort", p.abort);
          pending.delete(id);
        }
      };
      const finish = (value: unknown) => {
        cleanup();
        try {
          const decoded = decodeToolCallResponsePayload(value);
          if (decoded.isError)
            throw new Error(
              "Mirror synchronization was refused. Check connection, permissions and import recovery.",
            );
          resolve(mirrorReplySchema.parse(JSON.parse(decoded.content)));
        } catch {
          reject(
            new Error(
              "Mirror synchronization could not be confirmed. No uncertain batch will be replayed automatically.",
            ),
          );
        }
      };
      const abort = () => {
        cleanup();
        reject(new Error("Mirror stopped"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            "Mirror synchronization timed out. Refresh after reconnecting; uncertain imports stop rather than duplicate.",
          ),
        );
      }, 20000);
      timer.unref?.();
      pending.set(id, {
        session,
        resolve: finish,
        reject: (err) => {
          cleanup();
          reject(err);
        },
        timer,
        abort,
      });
      signal.addEventListener("abort", abort, { once: true });
      io.send({
        jsonrpc: "2.0",
        id,
        method: "item/tool/call",
        params: {
          threadId: session.threadId,
          providerThreadId: session.providerThreadId,
          turnId: null,
          callId: id,
          tool: MIRROR_TOOL,
          arguments: operation,
        },
      });
    });
  }
  function terminal(
    session: Session,
    status: "completed" | "failed",
    message?: string,
  ) {
    if (!session.active) return;
    if (message) {
      const key = { providerItemId: randomUUID() };
      emit(session, [
        { kind: "item.open", key, item: { type: "agentMessage", text: "" } },
        {
          kind: "item.close",
          key,
          status: "completed",
          item: { type: "agentMessage", text: message },
        },
      ]);
    }
    emit(session, [{ kind: "turn.boundary", status }]);
    session.active = false;
    session.controller = null;
  }
  async function run(
    session: Session,
    input: readonly PromptInput[],
    clientRequestId?: string,
  ) {
    const invalid = input.some(
      (block) => block.type !== "text" || (block.mentions?.length ?? 0) > 0,
    );
    const text = input
      .filter(
        (b): b is Extract<PromptInput, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (invalid || !text || (text !== REFRESH_PROMPT && text.length > 16000))
      throw new Error(
        "Mirror accepts plain text only (max 16,000 characters); attachments and mentions are not forwarded.",
      );
    if (session.active) throw new Error("Mirror already processing a request");
    session.active = true;
    session.controller = new AbortController();
    emit(session, [
      ...(clientRequestId
        ? [{ kind: "input.accepted" as const, clientRequestId }]
        : []),
      { kind: "turn.open" },
    ]);
    try {
      if (text !== REFRESH_PROMPT) {
        const result = await tool(session, {
          op: "propose",
          clientRequestId: clientRequestId ?? randomUUID(),
          body: text,
        });
        if (result.kind !== "proposed")
          throw new Error("Unexpected proposal result");
        if (session.controller?.signal.aborted || !session.active) return;
        terminal(
          session,
          "completed",
          "Message proposed to the remote owner for review. No agent was run. The owner must add it to their draft and send it separately.",
        );
        return;
      }
      for (let page = 0; page < 26; page++) {
        const result = await tool(session, { op: "read" });
        if (!session.active) return;
        if (result.kind === "done") {
          terminal(session, "completed");
          return;
        }
        if (result.kind !== "batch")
          throw new Error("Unexpected mirror response");
        emit(session, batchDeltas(result.batch));
        const ack = await tool(session, {
          op: "commit",
          batchId: result.batch.id,
        });
        if (ack.kind !== "committed")
          throw new Error("Import was not acknowledged");
      }
      terminal(
        session,
        "completed",
        "More shared preview remains. Refresh to continue.",
      );
    } catch (error) {
      if (!session.active) return;
      terminal(
        session,
        "failed",
        error instanceof Error ? error.message : "Mirror failed safely",
      );
    }
  }
  async function request(id: RpcId, method: string, params: unknown) {
    switch (method) {
      case "initialize": {
        initializeParamsSchema.parse(params);
        io.sendResult(id, {
          protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
          capabilities: {
            grammarVersions: [3, 3],
            sessionRestore: true,
            threadArchive: false,
            threadRename: false,
            threadGoalClear: false,
            fork: "none",
            approvalEnforcedBy: "runtime",
            steerMode: "queue",
          },
        });
        return;
      }
      case "model/list":
        modelListParamsSchema.parse(params);
        io.sendResult(id, {
          models: [{ ...mirrorModel, model: mirrorModel.id }],
          selectedOnlyModels: [],
        });
        return;
      case "thread/start":
      case "thread/resume": {
        const data =
          method === "thread/start"
            ? threadStartParamsSchema.parse(params)
            : threadResumeParamsSchema.parse(params);
        if (!data.dynamicTools?.some((t) => t.name === MIRROR_TOOL))
          throw new Error(
            "Open native mirrors from a shared Multiplayer thread; the mirror transport is unavailable.",
          );
        if (sessions.has(data.threadId))
          throw new Error("Mirror session is already attached");
        const session: Session = {
          threadId: data.threadId,
          providerThreadId:
            method === "thread/resume"
              ? threadResumeParamsSchema.parse(params).providerThreadId
              : `mirror-${randomUUID()}`,
          active: false,
          controller: null,
        };
        sessions.set(data.threadId, session);
        io.send({
          jsonrpc: "2.0",
          method: "thread/identity",
          params: {
            threadId: session.threadId,
            providerThreadId: session.providerThreadId,
          },
        });
        emit(session, [{ kind: "session.reset" }]);
        io.sendResult(id, {
          providerThreadId: session.providerThreadId,
          sessionRestorable: true,
        });
        const initialInput =
          method === "thread/start"
            ? threadStartParamsSchema.parse(params).input
            : undefined;
        if (initialInput?.length)
          void run(session, initialInput).catch(() =>
            terminal(session, "failed", "Mirror initialization failed safely."),
          );
        return;
      }
      case "turn/start": {
        const data = turnStartParamsSchema.parse(params),
          session = sessions.get(data.threadId);
        if (!session || session.providerThreadId !== data.providerThreadId)
          throw new Error("No matching mirror session");
        if (session.active)
          throw new Error("Mirror is busy; wait for the current operation");
        // Validate before acknowledging the protocol request. run() sets active
        // synchronously and owns all later success/failure settlement.
        const work = run(session, data.input, data.clientRequestId);
        if (!session.active) {
          await work;
          return;
        }
        io.sendResult(id, {});
        void work.catch(() =>
          terminal(session, "failed", "Mirror request failed safely."),
        );
        return;
      }
      case "turn/steer":
        turnSteerParamsSchema.parse(params);
        io.sendError(
          id,
          BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
          "Mirrors do not support steering; wait and send a new owner proposal.",
        );
        return;
      case "thread/stop": {
        const data = threadStopParamsSchema.parse(params),
          session = sessions.get(data.threadId);
        if (session) {
          if (session.providerThreadId !== data.providerThreadId)
            throw new Error("Mirror session mismatch");
          cancel(session);
        }
        io.sendResult(id, {});
        return;
      }
      default:
        io.sendError(
          id,
          BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
          `Unsupported mirror method: ${method}`,
        );
    }
  }
  const close = () => {
    for (const session of [...sessions.values()]) cancel(session);
  };
  return experimental_defineProviderBridge({
    handleLine(line) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !("method" in value) &&
        "id" in value
      ) {
        const reply = value as { id: RpcId; result?: unknown; error?: unknown };
        const p = pending.get(reply.id);
        if (!p) return;
        if (reply.error)
          p.reject(
            new Error(
              "Mirror transport rejected the operation. Refresh or check the local connection.",
            ),
          );
        else p.resolve(reply.result);
        return;
      }
      const envelope = ENVELOPE.safeParse(value);
      if (!envelope.success) {
        if (
          value &&
          typeof value === "object" &&
          "id" in value &&
          (typeof value.id === "string" || typeof value.id === "number")
        )
          io.sendError(
            value.id,
            BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
            "Invalid mirror request",
          );
        return;
      }
      void request(
        envelope.data.id,
        envelope.data.method,
        envelope.data.params,
      ).catch((error) =>
        io.sendError(
          envelope.data.id,
          error instanceof z.ZodError
            ? BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS
            : BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
          error instanceof z.ZodError
            ? "Invalid mirror parameters"
            : error instanceof Error
              ? error.message
              : "Mirror request failed",
        ),
      );
    },
    onClose: close,
    onSigterm: close,
    onSigint: close,
  });
}
export const experimental_providerBridge = createMirrorBridge();
