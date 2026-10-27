import { expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { initialMirrorDeltas } from "../provider/mirror-projection";
import type { SharedThread } from "../shared/protocol";

it("proves initial remote messages can enter the native timeline without ACP or tool execution", () => {
  const snapshot: SharedThread = {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    title: "Remote",
    status: "idle",
    historyTruncated: false,
    updatedAt: 1,
    messages: [
      {
        id: "user_1",
        role: "user",
        text: "Remote owner prompt",
        version: "a".repeat(64),
        truncated: false,
        createdAt: 1,
      },
      {
        id: "assistant_1",
        role: "assistant",
        text: "Remote assistant answer",
        version: "b".repeat(64),
        truncated: false,
        createdAt: 2,
      },
    ],
  };
  const deltas = initialMirrorDeltas(snapshot);
  for (const delta of deltas)
    expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
  const assembler = experimental_createDeltaAssembler({
    providerId: "multiplayer-mirror",
    entropyPrefix: "test",
    textDeltaFlushMs: 0,
  });
  const events = assembler.assemble({ threadId: "thr_mirror", deltas });
  const text = JSON.stringify(events);
  expect(text).toContain("Remote owner prompt");
  expect(text).toContain("Remote assistant answer");
  expect(text).not.toContain('"tool"');
  expect(assembler.getOpenTurnId("thr_mirror")).toBeUndefined();
  // session.reset is an identity boundary, not replace-history. Replaying a
  // snapshot mints new items. This test pins why the spike is not enabled.
  const replay = assembler.assemble({ threadId: "thr_mirror", deltas });
  expect(JSON.stringify(replay)).toContain("Remote assistant answer");
});
