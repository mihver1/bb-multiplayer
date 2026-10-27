import { describe, expect, it } from "vitest";
import { threadDeltaSchema } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createDeltaAssembler } from "@get-bb/plugin-sdk/provider-bridge/testing";
import {
  batchDeltas,
  batchIsPersisted,
  nextMirrorBatch,
  safeMirrorText,
} from "../provider/mirror-projection";
import { fixtureSnapshot } from "./mirror-fixture";
describe("native mirror projection", () => {
  it("emits native user/assistant rows and a verifiable import marker", () => {
    const batch = nextMirrorBatch(fixtureSnapshot(), new Map())!;
    const deltas = batchDeltas(batch);
    for (const delta of deltas)
      expect(threadDeltaSchema.safeParse(delta).success).toBe(true);
    const assembler = experimental_createDeltaAssembler({
      providerId: "multiplayer-mirror",
      entropyPrefix: "test",
      textDeltaFlushMs: 0,
    });
    const events = assembler.assemble({
      threadId: "thr_mirror",
      deltas: [
        { kind: "session.reset" },
        { kind: "turn.open" },
        ...deltas,
        { kind: "turn.boundary", status: "completed" },
      ],
    });
    const rows = events.map(({ type, scope, ...data }) => ({
      type,
      scope,
      data,
    }));
    expect(batchIsPersisted(batch, rows)).toBe(true);
    expect(JSON.stringify(events)).toContain('"type":"userMessage"');
    expect(JSON.stringify(events)).toContain('"type":"agentMessage"');
    expect(assembler.getOpenTurnId("thr_mirror")).toBeUndefined();
    const missing = rows.filter(
      (row) => !JSON.stringify(row.data).includes("Remote answer"),
    );
    expect(batchIsPersisted(batch, missing)).toBe(false);
  });
  it("does not replay acknowledged versions and explicitly labels edits", () => {
    const snapshot = fixtureSnapshot();
    const imports = new Map(
      snapshot.messages.map((m) => [
        m.id,
        { version: m.version, role: m.role },
      ]),
    );
    expect(nextMirrorBatch(snapshot, imports)).toBeNull();
    snapshot.messages[0] = {
      ...snapshot.messages[0],
      text: "Edited",
      version: "a".repeat(64),
    };
    const batch = nextMirrorBatch(snapshot, imports)!;
    expect(batch.entries).toHaveLength(1);
    expect(batch.entries[0].role).toBe("assistant");
    expect(batch.entries[0].text).toContain("Updated remote user");
  });
  it("renders remote directives/images as plain quoted content with unbreakable fences", () => {
    const body =
      '```\n::inline-vis{file="secret"}\n![track](https://example.org/image)\n````';
    const text = safeMirrorText(body);
    expect(text.startsWith("`````text\n")).toBe(true);
    expect(text.endsWith("\n`````")).toBe(true);
  });
  it("does not use identical messages in an earlier batch as acknowledgement for a later batch", () => {
    const first = nextMirrorBatch(fixtureSnapshot(), new Map())!;
    const second = { ...first, id: "33333333-3333-4333-8333-333333333333" };
    const assembler = experimental_createDeltaAssembler({
      providerId: "multiplayer-mirror",
    });
    const events = assembler.assemble({
      threadId: "thr_mirror",
      deltas: [
        { kind: "turn.open" },
        ...batchDeltas(first),
        ...batchDeltas(second).slice(-2),
      ],
    });
    const rows = events.map(({ type, scope, ...data }) => ({
      type,
      scope,
      data,
    }));
    expect(batchIsPersisted(first, rows)).toBe(true);
    expect(batchIsPersisted(second, rows)).toBe(false);
  });
  it("will not accept the marker from another turn as proof of imported messages", () => {
    const batch = nextMirrorBatch(fixtureSnapshot(), new Map())!;
    expect(
      batchIsPersisted(batch, [
        {
          type: "item/completed",
          scope: { turnId: "wrong" },
          data: {
            item: {
              type: "extension",
              kind: "multiplayer/mirror-batch",
              payload: { batchId: batch.id, count: batch.entries.length },
            },
          },
        },
      ]),
    ).toBe(false);
  });
});
