import { z } from "zod";

export const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const uuid = z.string().uuid();
export const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const name = z.string().trim().min(1).max(100);
// BB timeline IDs are opaque (e.g. thr_x:user-seed:1), not path segments.
export const messageId = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export const messageSchema = z
  .object({
    id: messageId,
    role: z.enum(["user", "assistant"]),
    text: z.string().max(16_000),
    version: hash,
    createdAt: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export const snapshotSchema = z
  .object({
    id: uuid,
    revision: z.number().int().positive(),
    title: z.string().max(300),
    status: z.enum([
      "active",
      "idle",
      "error",
      "pending",
      "starting",
      "stopping",
      "archived",
      "deleted",
    ]),
    messages: z.array(messageSchema).max(100),
    historyTruncated: z.boolean(),
  })
  .strict()
  .refine(
    (s) => new Set(s.messages.map((m) => m.id)).size === s.messages.length,
    "Duplicate message IDs",
  );
export const threadSchema = snapshotSchema.safeExtend({
  ownerId: uuid,
  updatedAt: z.number().int(),
});
export const anchorSchema = z
  .object({
    messageId,
    version: hash,
    quote: z.string().min(1).max(2000),
  })
  .strict();
export const newCommentSchema = z
  .object({
    id: uuid,
    threadId: uuid,
    parentId: uuid.nullable(),
    anchor: anchorSchema.nullable(),
    body: z.string().trim().min(1).max(4000),
  })
  .strict();
export const commentSchema = newCommentSchema.extend({
  authorId: uuid,
  createdAt: z.number().int(),
  resolved: z.boolean(),
  version: z.number().int().positive(),
});
export const memberSchema = z.object({
  id: uuid,
  name,
  // Additive flag: older v1 clients still see an ordinary member and keep syncing.
  role: z.enum(["owner", "member"]),
  admin: z.boolean().optional(),
  lastSeenAt: z.number().int(),
  revoked: z.boolean(),
});
export const identitySchema = z.object({
  room: z.object({ id: uuid, name }),
  member: memberSchema,
  members: z.array(memberSchema).max(100),
  capabilities: z
    .object({ memberAdministration: z.boolean().optional() })
    .optional(),
});
export const setMemberAdminSchema = z
  .object({ memberId: uuid, admin: z.boolean() })
  .strict();
export function canCreateRooms(
  member:
    | Pick<z.infer<typeof memberSchema>, "role" | "admin" | "revoked">
    | null
    | undefined,
): boolean {
  return Boolean(
    member &&
    !member.revoked &&
    (member.role === "owner" || member.admin === true),
  );
}
export const eventsSchema = z.object({
  events: z
    .array(
      z.object({
        seq: z.number().int().positive(),
        kind: z.enum(["thread", "comment", "member"]),
        id: uuid,
      }),
    )
    .max(50),
  cursor: z.number().int().nonnegative(),
});
export const invitationSchema = z.object({
  code: z.string(),
  expiresAt: z.number(),
});
export const credentialSchema = z.object({
  token: z.string().min(32).max(200),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export type SharedThread = z.infer<typeof threadSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type NewComment = z.infer<typeof newCommentSchema>;
export type Anchor = z.infer<typeof anchorSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type SyncEvents = z.infer<typeof eventsSchema>;

export function serverUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "Use an HTTPS server origin (HTTP is allowed only on loopback), without credentials or a path.",
    );
  }
  return url.origin;
}

export class ProtocolError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
