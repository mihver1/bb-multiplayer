import { createHash } from "node:crypto";
import type { SharedThread } from "../shared/protocol";
export function fixtureSnapshot(): SharedThread {
  const message = (id: string, role: "user" | "assistant", text: string) => ({
    id,
    role,
    text,
    version: createHash("sha256").update(text).digest("hex"),
    truncated: false,
    createdAt: 1,
  });
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "22222222-2222-4222-8222-222222222222",
    revision: 1,
    title: "Remote",
    status: "idle",
    historyTruncated: false,
    updatedAt: 1,
    messages: [
      message("u1", "user", "Remote owner prompt"),
      message("a1", "assistant", "Remote answer"),
    ],
  };
}
