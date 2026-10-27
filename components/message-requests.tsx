import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import { useTeamQuery } from "../hooks/use-team-query";
import { Button } from "./ui/button";

export function MessageRequestComposer({
  sharedId,
  ownerName,
}: {
  sharedId: string;
  ownerName: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(() => rpc.call("requestState"), [rpc]);
  const { data, refresh } = useTeamQuery(load);
  const [body, setBody] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null),
    [sent, setSent] = useState(false);
  const attempt = useRef<{ body: string; id: string } | null>(null),
    busy = useRef(false);
  return (
    <section
      className="space-y-3 rounded-lg border border-border bg-card p-4"
      aria-label="Propose a message to the thread owner"
    >
      <p className="text-sm font-medium">Propose a message to {ownerName}</p>
      <p className="text-xs text-muted-foreground">
        This is a remote conversation. Sending creates a request for its owner;
        it does not run their agent. The owner can review it and add it to their
        draft.
      </p>
      {!data?.supported && (
        <p role="status" className="text-xs text-muted-foreground">
          Message requests require the updated relay. Conversation viewing and
          comments still work.
        </p>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy.current || !body.trim() || !data?.online || !data.supported)
            return;
          busy.current = true;
          setPending(true);
          setError(null);
          const text = body.trim();
          if (attempt.current?.body !== text)
            attempt.current = { body: text, id: crypto.randomUUID() };
          void rpc
            .call("proposeMessage", {
              id: attempt.current.id,
              threadId: sharedId,
              body: text,
            })
            .then(
              () => {
                setBody("");
                attempt.current = null;
                setSent(true);
                refresh();
              },
              (cause) =>
                setError(
                  cause instanceof Error ? cause.message : "Request failed",
                ),
            )
            .finally(() => {
              busy.current = false;
              setPending(false);
            });
        }}
      >
        <textarea
          aria-label="Proposed message"
          className="min-h-24 w-full rounded-md border border-border bg-background p-3 text-sm"
          maxLength={16000}
          value={body}
          disabled={pending}
          onChange={(e) => {
            setBody(e.target.value);
            setSent(false);
          }}
        />
        <Button
          type="submit"
          disabled={pending || !body.trim() || !data?.online || !data.supported}
        >
          Request owner's review
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {sent && (
        <p role="status" className="text-xs text-muted-foreground">
          Request sent. Nothing was submitted to the owner's agent.
        </p>
      )}
      {data?.requests
        .filter((r) => r.threadId === sharedId && r.authorId === data.memberId)
        .slice(0, 5)
        .map((r) => (
          <p key={r.id} className="text-xs text-muted-foreground">
            {r.body.slice(0, 80)} · {r.status}
          </p>
        ))}
    </section>
  );
}

export function OwnerRequestInbox() {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("requestState"), [rpc]);
  const { data } = useTeamQuery(load);
  const seen = useRef(new Set<string>());
  const initial = useRef(false);
  const account = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    if (account.current !== data.memberId) {
      account.current = data.memberId;
      seen.current.clear();
      initial.current = false;
    }
    const pending = data.requests.filter(
      (r) => r.ownerId === data.memberId && r.status === "pending",
    );
    const fresh = pending.filter((r) => !seen.current.has(r.id));
    pending.forEach((r) => seen.current.add(r.id));
    if (!initial.current) {
      initial.current = true;
      if (fresh.length)
        toast.info(
          `Multiplayer: ${fresh.length} message request(s) await your review`,
        );
      return;
    }
    for (const r of fresh) {
      const author =
        data.members.find((m) => m.id === r.authorId)?.name ?? "A teammate";
      toast.info(`${author} proposes a message in ${r.threadTitle}`, {
        action: r.localThreadId
          ? {
              label: "Review",
              onClick: () => navigate.toThread(r.localThreadId!),
            }
          : undefined,
      });
    }
  }, [data, navigate]);
  return null;
}

export function OwnerRequestBanner() {
  const composer = useComposer();
  return composer.scope.kind === "thread" ? (
    <ThreadRequests key={composer.key} threadId={composer.scope.threadId} />
  ) : null;
}
function ThreadRequests({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>(),
    composer = useComposer();
  const load = useCallback(() => rpc.call("requestState"), [rpc]);
  const { data, refresh } = useTeamQuery(load);
  const [pending, setPending] = useState(false),
    [error, setError] = useState<string | null>(null);
  const inserted = useRef(new Set<string>()),
    busy = useRef(false);
  const rows =
    data?.requests.filter(
      (r) =>
        r.ownerId === data.memberId &&
        r.localThreadId === threadId &&
        r.status === "pending",
    ) ?? [];
  if (!rows.length) return null;
  return (
    <section
      aria-label="Messages proposed by teammates"
      className="max-h-64 space-y-2 overflow-y-auto rounded-lg border border-border bg-card p-3"
    >
      <p className="text-xs font-medium">
        Teammates want to send a message · review before adding to your draft
      </p>
      {rows.map((r) => (
        <article key={r.id} className="space-y-2 border-t border-border pt-2">
          <p className="text-xs font-medium">
            {data?.members.find((m) => m.id === r.authorId)?.name ?? "Teammate"}
          </p>
          <p className="whitespace-pre-wrap break-words text-sm">{r.body}</p>
          <div className="flex gap-2">
            {["drafted", "dismissed"].map((status) => (
              <Button
                key={status}
                size="sm"
                variant="outline"
                disabled={
                  pending ||
                  !data?.online ||
                  (status === "dismissed" && inserted.current.has(r.id))
                }
                onClick={() => {
                  if (busy.current) return;
                  busy.current = true;
                  setPending(true);
                  setError(null);
                  void (async () => {
                    if (status === "drafted" && !inserted.current.has(r.id)) {
                      const result = await rpc.call("requestDraft", {
                        id: r.id,
                      });
                      if (
                        result.threadId !== threadId ||
                        composer.scope.kind !== "thread" ||
                        composer.scope.threadId !== threadId
                      )
                        throw new Error(
                          "The owning composer changed; reopen the original thread",
                        );
                      composer.insert(result.text, { at: "end", block: true });
                      inserted.current.add(r.id);
                      composer.focus();
                    }
                    await rpc.call("reviewRequest", {
                      id: r.id,
                      version: r.version,
                      status: status as "drafted" | "dismissed",
                    });
                    refresh();
                  })()
                    .catch((cause) =>
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not review request",
                      ),
                    )
                    .finally(() => {
                      busy.current = false;
                      setPending(false);
                    });
                }}
              >
                {status === "drafted"
                  ? inserted.current.has(r.id)
                    ? "Confirm added to draft"
                    : "Add to my draft"
                  : "Dismiss"}
              </Button>
            ))}
          </div>
        </article>
      ))}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
