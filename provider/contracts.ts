import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { id, uuid, hash, messageId } from "../shared/protocol";

export const MIRROR_PROVIDER = "multiplayer-mirror";
export const MIRROR_ENVIRONMENT = "multiplayer-view";
export const MIRROR_TOOL = "multiplayer_mirror_io";
export const MIRROR_MARKER = "multiplayer/mirror-batch";
export const REFRESH_PROMPT = "/multiplayer-refresh";
export const mirrorMarkerSchema = z
  .object({ batchId: uuid, count: z.number().int().min(1).max(4) })
  .strict();
export const mirrorEntrySchema = z
  .object({
    sourceId: messageId,
    version: hash,
    sourceRole: z.enum(["user", "assistant"]),
    role: z.enum(["user", "assistant"]),
    text: z.string().max(40_000),
  })
  .strict();
export const mirrorBatchSchema = z
  .object({ id: uuid, entries: z.array(mirrorEntrySchema).min(1).max(4) })
  .strict();
export const mirrorReplySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("batch"), batch: mirrorBatchSchema }),
  z.object({ kind: z.literal("done") }),
  z.object({ kind: z.literal("committed") }),
  z.object({ kind: z.literal("proposed"), requestId: uuid }),
]);
export const mirrorOperationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read") }).strict(),
  z.object({ op: z.literal("commit"), batchId: uuid }).strict(),
  z
    .object({
      op: z.literal("propose"),
      clientRequestId: z.string().min(1).max(300),
      body: z.string().trim().min(1).max(16_000),
    })
    .strict(),
]);
export type MirrorBatch = z.infer<typeof mirrorBatchSchema>;
export type MirrorEntry = z.infer<typeof mirrorEntrySchema>;
export type MirrorOperation = z.infer<typeof mirrorOperationSchema>;
export type MirrorReply = z.infer<typeof mirrorReplySchema>;
export const mirrorHostContract = defineRpcContract({
  workspace: {
    input: z.object({ mirrorId: uuid }).strict(),
    output: z.object({ path: z.string() }),
  },
});
export const mirrorModel = {
  id: "shared-conversation",
  displayName: "Shared conversation",
  description:
    "No model execution; imports shared text and proposes messages to the owner.",
  supportedReasoningEfforts: [
    { reasoningEffort: "low" as const, description: "No reasoning" },
  ],
  defaultReasoningEffort: "low" as const,
  isDefault: true,
};
export const nativeMirrorStateSchema = z.object({
  enabled: z.boolean(),
  projectId: id.nullable(),
  sharedId: uuid.nullable(),
  ownerName: z.string().nullable(),
  isMirror: z.boolean(),
  connected: z.boolean(),
  localId: id.nullable(),
});
