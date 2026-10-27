import { z } from "zod";
import { id, name, uuid } from "../shared/protocol";

// Only non-secret recovery metadata goes into SQLite or RPC responses.
// The prepared new token lives in the existing project-keyed secret setting.
export const pendingRoomSchema = z
  .object({
    requestId: uuid,
    sourceProjectId: id,
    sourceMemberId: uuid,
    sourceRoomId: uuid,
    url: z.string(),
    name,
  })
  .strict();
