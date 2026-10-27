import { z } from "zod";
import { uuid } from "./protocol";

// Separate feed from protocol-v1 conversation events: older clients must keep
// syncing when requests are introduced. Every author/owner identity is assigned
// by the relay, never accepted from the browser or another member.
export const newMessageRequestSchema = z
  .object({
    id: uuid,
    threadId: uuid,
    body: z.string().trim().min(1).max(16_000),
  })
  .strict();
export const messageRequestSchema = newMessageRequestSchema.extend({
  authorId: uuid,
  ownerId: uuid,
  status: z.enum(["pending", "drafted", "dismissed"]),
  version: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export const reviewMessageRequestSchema = z
  .object({
    id: uuid,
    version: z.number().int().positive(),
    status: z.enum(["drafted", "dismissed"]),
  })
  .strict();
export const requestFeedSchema = z.object({
  cursor: z.number().int().nonnegative(),
  events: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        request: messageRequestSchema,
      }),
    )
    .max(50),
});
export type MessageRequest = z.infer<typeof messageRequestSchema>;
export type NewMessageRequest = z.infer<typeof newMessageRequestSchema>;
export type ReviewMessageRequest = z.infer<typeof reviewMessageRequestSchema>;
