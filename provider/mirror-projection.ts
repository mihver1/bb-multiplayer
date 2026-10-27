import { randomUUID } from "node:crypto";
import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { SharedThread } from "../shared/protocol";
import { MIRROR_MARKER, type MirrorBatch, type MirrorEntry } from "./contracts";

/** Native messages are rendered by BB Markdown. Quote as fenced plain text so
 * remote images, links, plugin directives and executable code-fence renderers
 * cannot become active in the local UI. The source body remains legible.
 */
export function safeMirrorText(text: string): string {
  const longest = Math.max(
    2,
    ...Array.from(text.matchAll(/`+/g), (m) => m[0].length),
  );
  const tildeLongest = Math.max(
    2,
    ...Array.from(text.matchAll(/~+/g), (m) => m[0].length),
  );
  const fence =
    longest > 16 && tildeLongest < longest
      ? "~".repeat(tildeLongest + 1)
      : "`".repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}
export function nextMirrorBatch(
  snapshot: SharedThread,
  imported: ReadonlyMap<string, { version: string; role: string }>,
): MirrorBatch | null {
  const entries: MirrorEntry[] = [];
  for (const message of snapshot.messages) {
    const old = imported.get(message.id);
    if (old?.version === message.version && old.role === message.role) continue;
    const heading = old
      ? `[Updated remote ${message.role} message — previous version remains above]`
      : `[Remote ${message.role === "user" ? "owner" : "assistant"}]`;
    entries.push({
      sourceId: message.id,
      version: message.version,
      sourceRole: message.role,
      role: old ? "assistant" : message.role,
      text: `${heading}${message.truncated ? " [truncated preview]" : ""}\n\n${safeMirrorText(message.text)}`,
    });
    if (entries.length === 4) break;
  }
  return entries.length ? { id: randomUUID(), entries } : null;
}
/** All entries and the batch marker stay in one logical turn. Commit waits for
 * the marker and every expected message to appear in persisted BB events. */
export function batchDeltas(batch: MirrorBatch): ThreadDelta[] {
  const deltas: ThreadDelta[] = [];
  for (const [index, entry] of batch.entries.entries()) {
    if (entry.role === "user")
      deltas.push({ kind: "input.provider", text: entry.text });
    else
      deltas.push(
        {
          kind: "item.open",
          key: { providerItemId: `${batch.id}:${index}` },
          item: { type: "agentMessage", text: "" },
        },
        {
          kind: "item.close",
          key: { providerItemId: `${batch.id}:${index}` },
          status: "completed",
          item: { type: "agentMessage", text: entry.text },
        },
      );
  }
  const item = {
    type: "extension" as const,
    kind: MIRROR_MARKER as typeof MIRROR_MARKER,
    payload: { batchId: batch.id, count: batch.entries.length },
  };
  const presentation = {
    label: {
      pending: "Importing shared preview",
      completed: "Shared preview imported",
    },
    icon: { glyph: "multiplayer/people" },
    suppress: true,
  };
  deltas.push(
    {
      kind: "item.open",
      key: { providerItemId: `${batch.id}:receipt` },
      item,
      presentation,
    },
    {
      kind: "item.close",
      key: { providerItemId: `${batch.id}:receipt` },
      status: "completed",
      item,
      presentation,
    },
  );
  return deltas;
}

export function batchIsPersisted(
  batch: MirrorBatch,
  events: readonly { type: string; data: unknown; scope: unknown }[],
): boolean {
  const completed = events.filter((e) => e.type === "item/completed");
  const receiptIndex = completed.findIndex((e) => {
    const item = (
      e.data as {
        item?: {
          type?: string;
          kind?: string;
          payload?: { batchId?: string; count?: number };
        };
      }
    )?.item;
    return (
      item?.type === "extension" &&
      item.kind === MIRROR_MARKER &&
      item.payload?.batchId === batch.id &&
      item.payload.count === batch.entries.length
    );
  });
  if (receiptIndex < 0) return false;
  const receipt = completed[receiptIndex];
  const turn = (receipt.scope as { turnId?: string })?.turnId;
  if (!turn) return false;
  // Each receipt closes its own batch. Identical text in an earlier batch of
  // the same import turn cannot prove that this batch was written successfully.
  let start = 0;
  for (let i = receiptIndex - 1; i >= 0; i--) {
    const event = completed[i];
    const item = (event.data as { item?: { type?: string; kind?: string } })
      ?.item;
    if (
      (event.scope as { turnId?: string })?.turnId === turn &&
      item?.type === "extension" &&
      item.kind === MIRROR_MARKER
    ) {
      start = i + 1;
      break;
    }
  }
  const texts = completed
    .slice(start, receiptIndex)
    .filter((e) => (e.scope as { turnId?: string })?.turnId === turn)
    .flatMap((e) => {
      const item = (
        e.data as {
          item?: {
            type?: string;
            text?: string;
            content?: { type: string; text?: string }[];
          };
        }
      )?.item;
      if (item?.type === "agentMessage")
        return [{ role: "assistant", text: item.text }];
      if (item?.type === "userMessage")
        return [
          {
            role: "user",
            text: item.content
              ?.filter((c) => c.type === "text")
              .map((c) => c.text ?? "")
              .join(""),
          },
        ];
      return [];
    });
  let cursor = 0;
  for (const entry of batch.entries) {
    let found = false;
    while (cursor < texts.length) {
      const row = texts[cursor++];
      if (row.role === entry.role && row.text === entry.text) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}
