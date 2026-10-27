import type { ThreadDelta } from "@get-bb/plugin-sdk/provider-bridge";
import type { SharedThread } from "../shared/protocol";

/** Protocol feasibility spike only. Not registered as a provider: session
 * resume/edit/withdrawal needs a durable import contract before activation.
 * A full ACP shim is unnecessary; these are public BB grammar-v3 deltas.
 */
export function initialMirrorDeltas(snapshot: SharedThread): ThreadDelta[] {
  const deltas: ThreadDelta[] = [{ kind: "session.reset" }];
  for (const message of snapshot.messages) {
    deltas.push({ kind: "turn.open" });
    if (message.role === "user")
      deltas.push({ kind: "input.provider", text: message.text });
    else
      deltas.push({
        kind: "item.close",
        key: { providerItemId: message.id },
        status: "completed",
        item: { type: "agentMessage", text: message.text },
      });
    deltas.push({ kind: "turn.boundary", status: "completed" });
  }
  return deltas;
}
