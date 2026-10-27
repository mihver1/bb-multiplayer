import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../server";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Options = z.infer<typeof rpcContract.roomCreationOptions.output>;
export function CreateRoomForm({
  projectId,
  projectName,
  options,
  error,
  onDone,
  onAttempt,
  onBusy,
}: {
  projectId: string;
  projectName: string;
  options: Options | null;
  error: string | null;
  onDone: () => void;
  onAttempt: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(projectName.slice(0, 100));
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const pending = options?.pending;
  useEffect(() => {
    if (pending) setName(pending.name);
  }, [pending?.requestId]);
  const sourceProjectId =
    pending?.sourceProjectId ||
    selected ||
    options?.sources[0]?.projectId ||
    "";
  const source = options?.sources.find((s) => s.projectId === sourceProjectId);
  if (!options)
    return (
      <p role={error ? "alert" : "status"}>
        {error ?? "Loading owner connections…"}
      </p>
    );
  if (!options.sources.length && !pending)
    return (
      <p
        role="status"
        className="rounded-lg border border-border p-4 text-sm text-muted-foreground"
      >
        Connect as a room owner first using “Use member credential”. Then you
        can create rooms for other local projects here. Ordinary members cannot
        create rooms.
      </p>
    );
  return (
    <form
      className="space-y-4 rounded-xl border border-border bg-card p-5"
      aria-label="Create a project room"
      onSubmit={(event) => {
        event.preventDefault();
        if (lock.current || !name.trim() || !source) return;
        lock.current = true;
        setBusy(true);
        onBusy(true);
        setFailure(null);
        void rpc
          .call("createRoom", {
            projectId,
            sourceProjectId,
            name: pending?.name ?? name.trim(),
          })
          .then(onDone, (cause) =>
            setFailure(
              cause instanceof Error ? cause.message : "Room creation failed",
            ),
          )
          .finally(() => {
            lock.current = false;
            setBusy(false);
            onBusy(false);
            onAttempt();
          });
      }}
    >
      <label className="block space-y-1 text-sm">
        <span>Create on server using owner connection</span>
        <select
          value={sourceProjectId}
          disabled={busy || Boolean(pending)}
          onChange={(event) => setSelected(event.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background px-3"
        >
          {pending && !source && (
            <option value={pending.sourceProjectId}>
              Original owner connection unavailable
            </option>
          )}
          {options.sources.map((s) => (
            <option key={s.projectId} value={s.projectId}>
              {s.roomName} · {s.ownerName} · {s.url}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-sm">
        <span>Room name</span>
        <Input
          value={pending?.name ?? name}
          onChange={(event) => setName(event.target.value)}
          maxLength={100}
          required
          disabled={busy || Boolean(pending)}
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Creates a separate room for {projectName || "this local project"} on{" "}
        {source?.url ?? pending?.url}. You become its owner. Other members are
        not copied, no conversation is shared, and the new credential stays in
        BB's server-side secret settings.
      </p>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          A creation attempt is saved. Retry to finish connecting the same room
          without creating a duplicate. Do not clear the project's secret
          settings.
        </p>
      )}
      {!source && (
        <p role="alert" className="text-sm text-destructive">
          Restore the original owner connection before retrying.
        </p>
      )}
      {(failure || error) && (
        <p role="alert" className="text-sm text-destructive">
          {failure ?? error}
        </p>
      )}
      <Button
        type="submit"
        disabled={busy || !source || !(pending?.name ?? name).trim()}
      >
        {busy
          ? "Creating room…"
          : pending
            ? "Retry room creation"
            : "Create room and connect"}
      </Button>
    </form>
  );
}
