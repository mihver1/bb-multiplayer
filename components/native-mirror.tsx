import { useCallback, useEffect, useState } from "react";
import {
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { useTeamQuery } from "../hooks/use-team-query";
import { Button } from "./ui/button";

export function OpenNativeMirror({ sharedId }: { sharedId: string }) {
  const rpc = useRpc<typeof rpcContract>(),
    sdk = useSdk(),
    navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("nativeMirrorOptions"), [rpc]);
  const { data } = useTeamQuery(load);
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]),
    [hostId, setHostId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!data?.enabled) return;
    let alive = true;
    void sdk.hosts.list().then(
      (values) => {
        if (alive) {
          setHosts(values.map((h) => ({ id: h.id, name: h.name })));
          if (values.length === 1) setHostId(values[0].id);
        }
      },
      () => {
        if (alive) setError("Could not list machines");
      },
    );
    return () => {
      alive = false;
    };
  }, [data?.enabled, sdk]);
  if (!data?.enabled)
    return (
      <p className="text-xs text-muted-foreground">
        Native view is experimental. Enable native mirrors in Multiplayer
        settings to try it; this read-only view remains available.
      </p>
    );
  const existing = data.mirrors.find(
    (m) => m.sharedId === sharedId && m.active,
  );
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-3"
      aria-label="Open native Multiplayer view"
    >
      <p className="text-xs text-muted-foreground">
        Native BB view, no model. Imports on open/Refresh. Edits append labelled
        versions; cached history is not erased by pausing or revocation.
      </p>
      <div className="flex flex-wrap gap-2">
        {!existing && (
          <select
            aria-label="Machine for native mirror"
            className="min-w-0 rounded border border-border bg-background p-2 text-xs"
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
          >
            <option value="">Choose machine…</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          disabled={busy || (!existing && !hostId)}
          onClick={() => {
            setBusy(true);
            setError(null);
            void (
              existing
                ? rpc
                    .call("refreshNativeMirror", { threadId: existing.localId })
                    .then(() => ({ threadId: existing.localId }))
                : rpc.call("openNativeMirror", { sharedId, hostId })
            )
              .then(
                (result) => {
                  navigate.toThread(result.threadId);
                },
                (cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Could not open mirror",
                  ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Open native view
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

export function NativeMirrorBanner() {
  const composer = useComposer();
  return composer.scope.kind === "thread" ? (
    <MirrorBanner key={composer.key} threadId={composer.scope.threadId} />
  ) : null;
}
function MirrorBanner({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const load = useCallback(
    () => rpc.call("nativeMirrorState", { threadId }),
    [rpc, threadId],
  );
  const { data } = useTeamQuery(load);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  if (!data?.isMirror) return null;
  return (
    <section
      className="space-y-2 rounded-lg border border-border bg-card p-3"
      aria-label="Native mirror safety notice"
    >
      <p className="text-xs">
        <strong>Multiplayer mirror</strong> · {data.ownerName ?? "Remote owner"}{" "}
        · {data.connected ? "Connected" : "Disconnected"}
      </p>
      <p className="text-xs text-muted-foreground">
        Sending proposes your text to the owner. No model or owner agent is run.
        Plain text only; imported text is a quoted preview. Changes are appended
        as new versions.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !data.enabled || !data.connected}
          onClick={() => {
            setBusy(true);
            setError(null);
            void rpc
              .call("refreshNativeMirror", { threadId })
              .catch((cause) =>
                setError(
                  cause instanceof Error ? cause.message : "Refresh failed",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          Refresh shared preview
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (data.sharedId)
              navigate.toPluginPanel("team", {
                subPath: `thread/${data.sharedId}`,
              });
          }}
        >
          Open source & discussions
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
