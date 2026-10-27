import { z } from "zod";
import { hash, name, uuid } from "./protocol";

// The plugin persists a fresh owner credential before sending only its hash.
// Replays use the same request ID and hash; the relay never returns the token.
export const createRoomSchema = z
  .object({
    requestId: uuid,
    name,
    tokenHash: hash,
  })
  .strict();
export const createdRoomSchema = z
  .object({ roomId: uuid, memberId: uuid })
  .strict();
export type CreateRoom = z.infer<typeof createRoomSchema>;
export const REMOTE_ROOM_LIMIT = 100;
