import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Snapshot } from "../shared/protocol";

export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");
type Timeline = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["timeline"]>>;
type Row = Timeline["rows"][number];

export function projectMessages(rows: Row[]) {
  const messages: Snapshot["messages"] = [];
  const walk = (items: Row[]) => {
    for (const row of items) {
      if (row.kind === "turn") {
        if (row.children) walk(row.children);
        continue;
      }
      if (
        row.kind !== "conversation" ||
        (row.role === "user" && row.initiator !== "user")
      )
        continue;
      const text = row.text.slice(0, 16_000);
      messages.push({
        id: row.id,
        role: row.role,
        text,
        version: hashText(text),
        createdAt: row.createdAt,
        truncated: row.text.length > text.length,
      });
    }
  };
  walk(rows);
  return [...new Map(messages.map((m) => [m.id, m])).values()].sort(
    (a, b) => a.createdAt - b.createdAt,
  );
}

export async function capture(
  bb: BbPluginApi,
  localId: string,
  sharedId: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<Omit<Snapshot, "revision">> {
  const thread = await bb.sdk.threads.get({ threadId: localId, signal });
  if (thread.projectId !== projectId)
    throw new Error("Thread is outside the connected local project");
  const timeline = await bb.sdk.threads.timeline({
    threadId: localId,
    includeNestedRows: "false",
    segmentLimit: "100",
    signal,
  });
  const messages = projectMessages(timeline.rows);
  return {
    id: sharedId,
    title: (thread.title ?? thread.titleFallback ?? "Untitled thread").slice(
      0,
      300,
    ),
    status: thread.deletedAt
      ? "deleted"
      : thread.archivedAt
        ? "archived"
        : thread.status,
    messages: messages.slice(-100),
    historyTruncated:
      messages.length > 100 || timeline.timelinePage.olderCursor !== null,
  };
}
