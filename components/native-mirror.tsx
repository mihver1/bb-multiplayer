import { useCallback, useEffect, useRef, useState } from "react";
import {
  useBbNavigate,
  useComposer,
  useRpc,
  useSdk,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { useTeamQuery } from "../hooks/use-team-query";
import { Button } from "./ui/button";

export function OpenNativeMirror({
  sharedId,
  projectId,
  autoOpen = false,
}: {
  sharedId: string;
  projectId: string;
  autoOpen?: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>(),
    sdk = useSdk(),
    navigate = useBbNavigate();
  const load = useCallback(
    () => rpc.call("nativeMirrorOptions", { projectId }),
    [rpc, projectId],
  );
  const { data, error: loadError } = useTeamQuery(load);
  const [hosts, setHosts] = useState<{ id: string; name: string }[]>([]),
    [hostId, setHostId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const alive = useRef(false),
    opening = useRef(false),
    attempted = useRef(false);
  const existingId = data?.mirrors.find(
    (m) => m.sharedId === sharedId && m.active,
  )?.localId;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!data?.enabled || existingId) return;
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
  }, [data?.enabled, existingId, sdk]);
  const open = useCallback(() => {
    if (opening.current) return;
    // A mapped mirror opens even offline; its mounted banner owns synchronization.
    if (existingId) {
      navigate.toThread(existingId);
      return;
    }
    if (!hostId) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    void rpc.call("openNativeMirror", { sharedId, hostId, projectId }).then(
      (result) => {
        opening.current = false;
        if (alive.current) {
          setBusy(false);
          navigate.toThread(result.threadId);
        }
      },
      (cause) => {
        opening.current = false;
        if (alive.current) {
          setBusy(false);
          setError(
            cause instanceof Error ? cause.message : "Could not open mirror",
          );
        }
      },
    );
  }, [rpc, navigate, existingId, hostId, sharedId, projectId]);
  useEffect(() => {
    if (
      !autoOpen ||
      !data?.enabled ||
      attempted.current ||
      (!existingId && !hostId)
    )
      return;
    attempted.current = true;
    open();
  }, [autoOpen, data?.enabled, existingId, hostId, open]);
  if (loadError)
    return (
      <p role="alert" className="text-xs text-destructive">
        {loadError}
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-xs">
        Loading native view…
      </p>
    );
  if (!data.enabled)
    return (
      <p className="text-xs text-muted-foreground">
        Native view is disabled. Enable native mirrors in Multiplayer settings;
        this read-only view remains available.
      </p>
    );
  return (
    <section
      className="space-y-2 rounded-lg border border-border p-3"
      aria-label="Open native Multiplayer view"
    >
      <p className="text-xs text-muted-foreground">
        Native BB view, no model. Syncs automatically while open. Edits append
        labelled versions; cached history is not erased by pausing or
        revocation.
      </p>
      <div className="flex flex-wrap gap-2">
        {!existingId && (
          <select
            aria-label="Machine for native mirror"
            className="min-w-0 rounded border border-border bg-background p-2 text-xs"
            value={hostId}
            disabled={busy}
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
          disabled={busy || (!existingId && !hostId)}
          onClick={open}
        >
          {busy ? "Opening native view…" : "Open native view"}
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

/** Only mounted native views sync. Realtime wakes the same throttled poller;
 * polling also recovers missed signals. No composer draft is read or submitted. */
function useMirrorSync(threadId: string, enabled: boolean) {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const request = useRef<(manual?: boolean) => void>(() => {});
  useRealtime("changed", () => request.current());
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextCheck = 0;
    function schedule() {
      clearTimeout(timer);
      if (alive) timer = setTimeout(() => void sync(), 2000);
    }
    async function sync(manual = false) {
      if (!alive || !enabled || connection !== "connected" || document.hidden)
        return;
      if (inFlight.current) {
        schedule();
        return;
      }
      if (!manual && Date.now() < nextCheck) return;
      inFlight.current = true;
      clearTimeout(timer);
      if (manual) setBusy(true);
      try {
        await rpc.call("refreshNativeMirror", {
          threadId,
          ...(!manual && { onlyIfChanged: true }),
        });
        if (alive) setError(null);
      } catch (cause) {
        if (alive)
          setError(cause instanceof Error ? cause.message : "Sync failed");
      } finally {
        inFlight.current = false;
        nextCheck = Date.now() + 2000;
        if (alive) {
          setBusy(false);
          schedule();
        }
      }
    }
    function visibilityChanged() {
      clearTimeout(timer);
      if (!document.hidden) {
        nextCheck = 0;
        void sync();
      }
    }
    request.current = (manual) => void sync(manual);
    void sync();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      request.current = () => {};
    };
  }, [rpc, threadId, enabled, connection]);
  return { busy, error, refresh: () => request.current(true) };
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
  const { data, error: loadError } = useTeamQuery(load);
  const { busy, error, refresh } = useMirrorSync(
    threadId,
    Boolean(data?.isMirror && data.enabled && data.connected),
  );
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
        as new versions. Shared preview syncs automatically while this view is
        open.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !data.enabled || !data.connected}
          onClick={refresh}
        >
          Refresh shared preview
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (data.sharedId && data.projectId)
              navigate.toPluginPanel("team", {
                subPath: `project/${data.projectId}/thread/${data.sharedId}/source`,
              });
          }}
        >
          Open source & discussions
        </Button>
      </div>
      {(error || loadError) && (
        <p role="alert" className="text-xs text-destructive">
          {error || loadError}
        </p>
      )}
    </section>
  );
}
