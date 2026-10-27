import { afterEach, describe, expect, it } from "vitest";
import {
  experimental_createDeltaAssembler,
  experimental_runBridgeConformance,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createMirrorBridge } from "../provider/bridge";
import {
  MIRROR_TOOL,
  REFRESH_PROMPT,
  type MirrorReply,
} from "../provider/contracts";
import { nextMirrorBatch } from "../provider/mirror-projection";
import { fixtureSnapshot } from "./mirror-fixture";

const options = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  permissionEscalation: "deny",
  approvalReviewer: "user",
};
const dynamicTools = [
  {
    name: MIRROR_TOOL,
    description: "Internal mirror channel",
    inputSchema: { type: "object" },
  },
];
type Message = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};
const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));
function harness(
  respond: (operation: Record<string, unknown>) => MirrorReply | undefined,
) {
  const messages: Message[] = [];
  const bridge = createMirrorBridge((line) => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    if (message.method === "item/tool/call") {
      expect(message.params?.tool).toBe(MIRROR_TOOL);
      const result = respond(
        message.params?.arguments as Record<string, unknown>,
      );
      if (result)
        queueMicrotask(() =>
          bridge.handleLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                success: true,
                contentItems: [
                  { type: "inputText", text: JSON.stringify(result) },
                ],
              },
            }),
          ),
        );
    }
  });
  closers.push(() => bridge.onClose?.());
  const send = (id: number, method: string, params: unknown) =>
    bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return { bridge, messages, send, settle };
}
async function start(h: ReturnType<typeof harness>) {
  h.send(1, "thread/start", {
    threadId: "thr_mirror",
    cwd: "/tmp/empty",
    instructionMode: "replace",
    options,
    dynamicTools,
  });
  await h.settle();
  return h.messages.find((m) => m.id === 1)!.result!.providerThreadId as string;
}
describe("mirror provider bridge", () => {
  it("imports native messages, waits for confirmation and completes without a model", async () => {
    const batch = nextMirrorBatch(fixtureSnapshot(), new Map())!;
    let committed = false;
    const h = harness((op) =>
      op.op === "commit"
        ? ((committed = true), { kind: "committed" })
        : committed
          ? { kind: "done" }
          : { kind: "batch", batch },
    );
    const providerThreadId = await start(h);
    h.send(2, "turn/start", {
      threadId: "thr_mirror",
      providerThreadId,
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
      options,
    });
    await h.settle();
    expect(committed).toBe(true);
    const deltas = h.messages
      .filter((m) => m.method === "thread/delta")
      .flatMap((m) => m.params!.deltas as unknown[]);
    expect(JSON.stringify(deltas)).toContain("Remote owner prompt");
    expect(JSON.stringify(deltas)).toContain("Remote answer");
    expect(deltas.at(-1)).toEqual({
      kind: "turn.boundary",
      status: "completed",
    });
    const assembler = experimental_createDeltaAssembler({
      providerId: "multiplayer-mirror",
    });
    const events = h.messages
      .filter((m) => m.method === "thread/delta")
      .flatMap((m) => assembler.assemble(m.params as never));
    expect(JSON.stringify(events)).toContain('"type":"userMessage"');
    expect(JSON.stringify(events)).not.toContain('"type":"command"');
  });
  it("submitting text creates exactly one owner proposal with the client request ID", async () => {
    const received: unknown[] = [];
    const h = harness((op) => {
      received.push(op);
      return {
        kind: "proposed",
        requestId: "11111111-1111-4111-8111-111111111111",
      };
    });
    const providerThreadId = await start(h);
    h.send(2, "turn/start", {
      threadId: "thr_mirror",
      providerThreadId,
      clientRequestId: "creq_23456789ac",
      input: [{ type: "text", text: "Please test rollback", mentions: [] }],
      options,
    });
    await h.settle();
    expect(received).toEqual([
      {
        op: "propose",
        clientRequestId: "creq_23456789ac",
        body: "Please test rollback",
      },
    ]);
    expect(JSON.stringify(h.messages)).toContain("No agent was run");
  });
  it("rejects attachments, unknown methods and invalid params before accepting input", async () => {
    const h = harness(() => {
      throw new Error("No transport call expected");
    });
    const providerThreadId = await start(h);
    h.send(2, "turn/start", {
      threadId: "thr_mirror",
      providerThreadId,
      clientRequestId: "creq_23456789ad",
      input: [{ type: "image", url: "https://example.com/x" }],
      options,
    });
    h.send(3, "unsupported", {});
    h.send(4, "turn/start", {});
    h.bridge.handleLine("not-json");
    await h.settle();
    expect(h.messages.find((m) => m.id === 2)?.error).toBeDefined();
    expect(h.messages.find((m) => m.id === 3)?.error?.code).toBe(-32601);
    expect(h.messages.find((m) => m.id === 4)?.error?.code).toBe(-32602);
    expect(JSON.stringify(h.messages)).not.toContain('"input.accepted"');
  });
  it("settles stop before replying and ignores late tool responses", async () => {
    const h = harness(() => undefined);
    const providerThreadId = await start(h);
    h.send(2, "turn/start", {
      threadId: "thr_mirror",
      providerThreadId,
      clientRequestId: "creq_23456789ae",
      input: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
      options,
    });
    await h.settle();
    const tool = h.messages.find((m) => m.method === "item/tool/call")!;
    h.send(3, "thread/stop", {
      threadId: "thr_mirror",
      providerThreadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await h.settle();
    const stop = h.messages.findIndex((m) => m.id === 3);
    expect(JSON.stringify(h.messages.slice(0, stop))).toContain(
      '"status":"interrupted"',
    );
    const count = h.messages.length;
    h.bridge.handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: tool.id,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: '{"kind":"done"}' }],
        },
      }),
    );
    await h.settle();
    expect(h.messages).toHaveLength(count);
  });
  it("passes official conformance with a simulated authenticated server transport", async () => {
    let imported = false;
    const sample = nextMirrorBatch(fixtureSnapshot(), new Map())!;
    const h = harness((op) => {
      if (op.op === "commit") {
        imported = true;
        return { kind: "committed" };
      }
      if (op.op === "propose")
        return {
          kind: "proposed",
          requestId: "11111111-1111-4111-8111-111111111111",
        };
      return imported ? { kind: "done" } : { kind: "batch", batch: sample };
    });
    const report = await experimental_runBridgeConformance({
      providerId: "multiplayer-mirror",
      timeoutMs: 2000,
      transport: {
        send(line) {
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            h.bridge.handleLine(line);
            return;
          }
          if (
            value.method === "thread/start" ||
            value.method === "thread/resume"
          )
            value.params.dynamicTools = dynamicTools;
          h.bridge.handleLine(JSON.stringify(value));
        },
        takeMessages: () => h.messages.splice(0),
      },
      session: {
        cwd: "/tmp/empty",
        promptInput: [{ type: "text", text: REFRESH_PROMPT, mentions: [] }],
        zeroWorkPromptInput: [
          { type: "text", text: REFRESH_PROMPT, mentions: [] },
        ],
        options,
        icons: { pluginId: "multiplayer", names: ["people"] },
      },
    });
    expect(report.results.filter((r) => r.status === "fail")).toEqual([]);
    expect(report.passed, JSON.stringify(report.results, null, 2)).toBe(true);
  }, 15000);
});
