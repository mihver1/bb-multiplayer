import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { z } from "zod";
import {
  definePluginApp,
  useRpc,
  useRealtime,
  useRealtimeConnectionState,
  useBbNavigate,
  useBbContext,
  useSidebarSplitLayout,
  useComposer,
  useComposers,
  experimental_copyToClipboard,
} from "@get-bb/plugin-sdk/app";
import type { JsonValue, PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Anchor, Comment, NewComment } from "./shared/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { registerThreadPanel } from "./lib/register-thread-panel";
import { FloatingDiscussion } from "./components/floating-discussion";
import { DiscussionList } from "./components/discussion-list";
import { groupDiscussions } from "./shared/discussions";
import { TeamThreadList } from "./components/team-thread-list";
import {
  MessageRequestComposer,
  OwnerRequestBanner,
  OwnerRequestInbox,
} from "./components/message-requests";
import {
  IconAction,
  MessageToDraftGlyph,
  PostCommentGlyph,
  SharingSettingsGlyph,
} from "./components/icon-action";
import "./app.css";
import {
  consumeDiscussionRequest,
  requestDiscussion,
  useDiscussionRequest,
  type DiscussionTarget,
  type DiscussionRequest,
} from "./lib/discussion-target";

type Status = z.infer<typeof rpcContract.status.output>;
type Detail = z.infer<typeof rpcContract.thread.output>;
const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : "Something went wrong";
const when = (time: number) => new Date(time).toLocaleString();

function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const request = ++sequence.current;
    void load().then(
      (value) => {
        if (request === sequence.current) {
          setData(value);
          setError(null);
        }
      },
      (cause) => {
        if (request === sequence.current) setError(errorText(cause));
      },
    );
  }, [load]);
  useEffect(() => {
    setData(null);
    refresh();
    return () => {
      ++sequence.current;
    };
  }, [refresh]);
  useRealtime("changed", refresh);
  const state = useRealtimeConnectionState();
  useEffect(() => {
    if (state === "connected") refresh();
  }, [state, refresh]);
  return { data, error, refresh };
}
function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={cn(
        "rounded-lg border border-border p-4 text-sm",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}
function useAction() {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function Connect({ status, refresh }: { status: Status; refresh: () => void }) {
  const rpc = useRpc<typeof rpcContract>(),
    action = useAction();
  const [url, setUrl] = useState("http://127.0.0.1:4789"),
    [projectId, setProjectId] = useState(status.projects[0]?.id ?? "");
  const [mode, setMode] = useState<"invite" | "owner">("invite");
  const [credential, setCredential] = useState(""),
    [displayName, setDisplayName] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void action.run(async () => {
      await rpc.call("connect", {
        url,
        projectId,
        ...(mode === "owner"
          ? { token: credential }
          : { inviteCode: credential, displayName }),
      });
      setCredential("");
      refresh();
    });
  }
  return (
    <div className="mx-auto max-w-xl space-y-5 py-8">
      <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-card">
        <Icon name="multiplayer/people" className="size-6" />
      </div>
      <div>
        <h2 className="text-xl font-semibold">
          Your own BB. One team context.
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect a local project to your team's Multiplayer server. Nothing is
          shared until you explicitly enable a thread.
        </p>
      </div>
      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-border bg-card p-5"
      >
        <label className="block space-y-1 text-sm">
          <span>Server URL</span>
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            type="url"
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span>Local project</span>
          <select
            className="h-9 w-full rounded-md border border-border bg-background px-3"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            required
          >
            {status.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={mode === "invite" ? "default" : "outline"}
            onClick={() => {
              setMode("invite");
              setCredential("");
            }}
          >
            Join with invitation
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "owner" ? "default" : "outline"}
            onClick={() => {
              setMode("owner");
              setCredential("");
            }}
          >
            Use member credential
          </Button>
        </div>
        {mode === "invite" && (
          <label className="block space-y-1 text-sm">
            <span>Your name</span>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={100}
              required
            />
          </label>
        )}
        <label className="block space-y-1 text-sm">
          <span>
            {mode === "invite" ? "Invitation code" : "Member credential"}
          </span>
          <Input
            type="password"
            autoComplete="off"
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            maxLength={200}
            required
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {mode === "owner" && (
            <>
              Paste only the <code>token</code> value, not the entire JSON
              file.{" "}
            </>
          )}
          The credential is stored in BB's server-side secret settings, never in
          this page's local storage. Use HTTPS for a remote server.
        </p>
        {action.error && <Notice error>{action.error}</Notice>}
        <Button
          type="submit"
          disabled={action.busy || !projectId || !credential}
        >
          Connect project
        </Button>
      </form>
      <Notice>
        Starting a new team? Run the self-hosted relay's init command, then use
        the owner's private credential file. See this plugin's README for setup.
      </Notice>
    </div>
  );
}

function TeamPage({ subPath }: { subPath: string }) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("status"), [rpc]);
  const { data, error, refresh } = useLoad(load),
    action = useAction();
  const [invitation, setInvitation] = useState<{
    code: string;
    expiresAt: number;
  } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false),
    [revokeId, setRevokeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setInvitation(null);
    setConfirmDisconnect(false);
  }, [data?.connection?.roomId]);
  if (!data)
    return (
      <div className="p-5">
        <Notice error={Boolean(error)}>
          {error ?? "Loading Multiplayer…"}
        </Notice>
      </div>
    );
  if (!data.connection || !data.identity)
    return (
      <div className="h-full overflow-y-auto px-5">
        <Connect status={data} refresh={refresh} />
        {data.error && <Notice error>{data.error}</Notice>}
      </div>
    );
  const selected = /^thread\/([a-f0-9-]{36})$/.exec(subPath)?.[1];
  if (selected)
    return (
      <div className="h-full overflow-y-auto p-4 md:p-5">
        <div className="mx-auto max-w-4xl space-y-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate.toPluginPanel("team")}
          >
            <Icon name="ArrowLeft" className="size-4" /> Team project
          </Button>
          <ThreadDetail key={selected} id={selected} status={data} />
        </div>
      </div>
    );
  const identity = data.identity;
  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-border bg-card p-5">
          <div>
            <div className="flex items-center gap-2">
              <Icon name="multiplayer/people" className="size-5" />
              <h2 className="text-lg font-semibold">{identity.room.name}</h2>
              <span className="rounded-full border border-border px-2 py-0.5 text-xs">
                Experimental
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Connected as {identity.member.name} ·{" "}
              {data.projects.find((p) => p.id === data.connection?.projectId)
                ?.name ?? "Local project"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {data.online
                ? "● Connected · updates every ~2s"
                : "○ Offline · showing saved context"}
              {data.lastSyncAt ? ` · last sync ${when(data.lastSyncAt)}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await rpc.call("sync");
                  refresh();
                })
              }
            >
              <Icon name="RefreshCw" className="size-4" /> Sync
            </Button>
            {identity.member.role === "owner" && (
              <Button
                size="sm"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    setInvitation(await rpc.call("invite"));
                    setCopied(false);
                  })
                }
              >
                Invite teammate
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmDisconnect(!confirmDisconnect)}
            >
              Disconnect
            </Button>
          </div>
        </section>
        {(error || action.error || data.error) && (
          <Notice error>{action.error ?? error ?? data.error}</Notice>
        )}
        {confirmDisconnect && (
          <Notice>
            <p className="mb-3">
              Disconnect stops future sharing and clears this BB's cache.
              Already published content remains on the team server; it does not
              revoke your credential.
            </p>
            <Button
              variant="destructive"
              size="sm"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await rpc.call("disconnect");
                  setInvitation(null);
                  refresh();
                })
              }
            >
              Disconnect and clear local cache
            </Button>
          </Notice>
        )}
        {invitation && (
          <section className="space-y-3 rounded-lg border border-border p-4">
            <p className="text-sm">
              One-use invitation · expires {when(invitation.expiresAt)}. Send
              privately to your teammate together with the server URL.
            </p>
            <Input
              readOnly
              type="password"
              value={invitation.code}
              aria-label="Invitation code"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void experimental_copyToClipboard({
                    text: invitation.code,
                  }).then(setCopied)
                }
              >
                {copied ? "Copied" : "Copy invitation"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setInvitation(null)}
              >
                Hide
              </Button>
            </div>
          </section>
        )}
        <section>
          <h3 className="mb-3 text-sm font-semibold">People</h3>
          <div className="flex flex-wrap gap-3">
            {identity.members.map((member) => {
              const online =
                data.online &&
                !member.revoked &&
                Date.now() - member.lastSeenAt < 15_000;
              return (
                <div
                  key={member.id}
                  className="flex items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <div className="flex size-8 items-center justify-center rounded-full bg-muted text-sm font-medium">
                    {member.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {member.name}
                      {member.id === identity.member.id ? " (you)" : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {member.revoked
                        ? "Access revoked"
                        : online
                          ? "● Online"
                          : `○ Last seen ${when(member.lastSeenAt)}`}
                    </p>
                  </div>
                  {identity.member.role === "owner" &&
                    member.id !== identity.member.id &&
                    !member.revoked && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setRevokeId(member.id)}
                      >
                        Revoke
                      </Button>
                    )}
                </div>
              );
            })}
          </div>
        </section>
        {revokeId && (
          <Notice>
            <p className="mb-3">
              Revoke this member's access? Copies they already received cannot
              be recalled.
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    await rpc.call("revoke", { memberId: revokeId });
                    setRevokeId(null);
                    refresh();
                  })
                }
              >
                Revoke access
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRevokeId(null)}
              >
                Cancel
              </Button>
            </div>
          </Notice>
        )}
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Team threads</h3>
            <span className="text-xs text-muted-foreground">
              Only explicitly shared conversations
            </span>
          </div>
          {data.threads.length === 0 ? (
            <Notice>
              Open a local thread → click the floating Team button → enable
              sharing. Your teammates' conversations will appear here
              automatically.
            </Notice>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {data.threads.map((thread) => {
                const member = identity.members.find(
                  (m) => m.id === thread.ownerId,
                );
                const fresh =
                  data.online &&
                  member &&
                  !member.revoked &&
                  Date.now() - member.lastSeenAt < 15_000;
                return (
                  <button
                    key={thread.id}
                    onClick={() =>
                      navigate.toPluginPanel("team", {
                        subPath: `thread/${thread.id}`,
                      })
                    }
                    className="flex w-full items-center gap-4 bg-card p-4 text-left hover:bg-muted focus-visible:outline focus-visible:outline-2"
                  >
                    <Icon
                      name="MessageSquare"
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {thread.title}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {member?.name ?? "Teammate"} · {when(thread.updatedAt)}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {!fresh ? `Last known: ${thread.status}` : thread.status}
                      {thread.localId && !thread.sharing
                        ? " · sharing paused"
                        : ""}
                    </span>
                    <Icon
                      name="ChevronRight"
                      className="size-4 text-muted-foreground"
                    />
                  </button>
                );
              })}
            </div>
          )}
          {data.threadsTruncated && (
            <p className="mt-2 text-xs text-muted-foreground">
              Showing the latest 200 team threads in this prototype.
            </p>
          )}
        </section>
        <p className="text-xs text-muted-foreground">
          Conversations and comments are shared. Your agent sessions, tools,
          terminals and provider keys stay on your BB.
        </p>
      </div>
    </div>
  );
}

function ThreadDetail({
  id,
  status,
  localThreadId,
  initialMessageId,
  initialQuote,
  onFeedback,
  inline = false,
  discussionTarget,
}: {
  id: string;
  status: Pick<Status, "identity" | "online">;
  localThreadId?: string;
  initialMessageId?: string;
  initialQuote?: string;
  onFeedback?: (text: string) => void;
  inline?: boolean;
  discussionTarget?: DiscussionTarget | null;
}) {
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate(),
    action = useAction();
  const load = useCallback(() => rpc.call("thread", { id }), [rpc, id]);
  const { data, error, refresh } = useLoad(load);
  const [selected, setSelected] = useState<string[]>([]),
    [body, setBody] = useState("");
  const [anchor, setAnchor] = useState<Anchor | null>(null),
    [parentId, setParentId] = useState<string | null>(null);
  const attempt = useRef<{ key: string; id: string } | null>(null),
    appliedInitial = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const appliedTarget = useRef<number | null>(null);
  useEffect(() => {
    if (
      !data ||
      action.busy ||
      !discussionTarget ||
      appliedTarget.current === discussionTarget.requestId
    )
      return;
    const message = data.thread.messages.find(
      (m) => m.id === discussionTarget.messageId,
    );
    if (!message?.text) {
      setNotice(
        "This message is not in the shared preview yet. Wait for sync and try again; no comment target was changed.",
      );
      return;
    }
    appliedTarget.current = discussionTarget.requestId;
    const quote = discussionTarget.quote || message.text.slice(0, 2000);
    if (quote.length > 2000 || !message.text.includes(quote)) {
      setNotice(
        "Selected text has changed or exceeds 2,000 characters. Select it again in the original message.",
      );
      return;
    }
    setParentId(null);
    setAnchor({ messageId: message.id, version: message.version, quote });
    setNotice(null);
    inputRef.current?.focus();
  }, [data, discussionTarget, action.busy]);
  useEffect(() => {
    if (!data || appliedInitial.current) return;
    appliedInitial.current = true;
    const message = data.thread.messages.find((m) => m.id === initialMessageId);
    if (message?.text) {
      const quote = initialQuote || message.text.slice(0, 2000);
      if (quote.length <= 2000 && message.text.includes(quote))
        setAnchor({ messageId: message.id, version: message.version, quote });
      else
        setNotice(
          "Selected text has changed or exceeds 2,000 characters. Select it again in the shared message.",
        );
    }
  }, [data, initialMessageId, initialQuote]);
  if (!data)
    return (
      <Notice error={Boolean(error)}>
        {error ?? "Waiting for shared thread to sync…"}
      </Notice>
    );
  const identity = status.identity;
  const author = (memberId: string) =>
    identity?.members.find((m) => m.id === memberId)?.name ?? "Teammate";
  const mine = Boolean(
    localThreadId &&
    data.localId === localThreadId &&
    data.thread.ownerId === identity?.member.id,
  );
  function submit(event: FormEvent) {
    event.preventDefault();
    event.stopPropagation();
    if (!body.trim() || !status.online || action.busy) return;
    void action.run(async () => {
      const fields = { threadId: id, body: body.trim(), parentId, anchor };
      const key = JSON.stringify(fields);
      if (attempt.current?.key !== key)
        attempt.current = { key, id: crypto.randomUUID() };
      const input: NewComment = { ...fields, id: attempt.current.id };
      await rpc.call("addComment", input);
      attempt.current = null;
      setBody("");
      setAnchor(null);
      setParentId(null);
      refresh();
    });
  }
  function quoteMessage(
    message: Detail["thread"]["messages"][number],
    text: string,
  ) {
    if (!text || action.busy) return;
    setParentId(null);
    setAnchor({
      messageId: message.id,
      version: message.version,
      quote: text.slice(0, 2000),
    });
  }
  const comments = data.comments;
  const discussions = groupDiscussions(comments);
  const replyRoot = discussions.find(
    (discussion) => discussion.id === parentId,
  )?.root;
  return (
    <div className={inline ? "multiplayer-widget-thread" : "space-y-5"}>
      {!inline && (
        <header>
          <h2 className="text-lg font-semibold">{data.thread.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {author(data.thread.ownerId)} · published{" "}
            {when(data.thread.updatedAt)} · last reported: {data.thread.status}
          </p>
          {!localThreadId && data.localId && (
            <Button
              className="mt-2"
              size="sm"
              variant="outline"
              onClick={() => navigate.toThread(data.localId!)}
            >
              Open my local thread
            </Button>
          )}
        </header>
      )}
      {!status.online && (
        <Notice>
          Offline view. Published context is cached; new comments require a
          connection.
        </Notice>
      )}
      {!inline && data.thread.historyTruncated && (
        <Notice>
          Bounded preview: up to 100 recent messages / timeline segments. Older
          history is not included.
        </Notice>
      )}
      {!inline && (
        <section className="space-y-3" aria-label="Shared messages">
          {data.thread.messages.map((message) => (
            <article
              key={message.id}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {message.role === "user"
                    ? author(data.thread.ownerId)
                    : "Assistant"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!message.text || action.busy}
                  onClick={() =>
                    quoteMessage(message, message.text.slice(0, 2000))
                  }
                >
                  Comment
                </Button>
              </div>
              <div
                className="whitespace-pre-wrap break-words text-sm"
                onMouseUp={(event) => {
                  const selection = window.getSelection();
                  if (
                    selection?.anchorNode &&
                    selection.focusNode &&
                    event.currentTarget.contains(selection.anchorNode) &&
                    event.currentTarget.contains(selection.focusNode)
                  ) {
                    const text = selection.toString();
                    if (text && message.text.includes(text))
                      quoteMessage(message, text);
                  }
                }}
              >
                {message.text}
              </div>
              {message.truncated && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Message truncated at 16,000 characters.
                </p>
              )}
            </article>
          ))}
        </section>
      )}
      {!inline &&
        data.localId === null &&
        identity &&
        data.thread.ownerId !== identity.member.id && (
          <MessageRequestComposer
            key={id}
            sharedId={id}
            ownerName={author(data.thread.ownerId)}
          />
        )}
      <section
        className={inline ? "multiplayer-widget-discussions" : "space-y-3"}
        aria-label="Discussions"
      >
        <div className="flex min-h-7 shrink-0 items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            Discussions ·{" "}
            {
              discussions.filter(
                (discussion) => discussion.root && !discussion.root.resolved,
              ).length
            }{" "}
            open
          </h3>
          {mine && onFeedback && (
            <IconAction
              label={
                selected.length
                  ? `Add ${selected.length} to agent draft`
                  : "Add selected to agent draft"
              }
              hint={
                selected.length
                  ? `Add ${selected.length} selected ${selected.length === 1 ? "comment" : "comments"} to agent draft — does not send`
                  : "Select comments to add to the agent draft — does not send"
              }
              disabled={!selected.length || action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await rpc.call("feedback", {
                    threadId: localThreadId!,
                    commentIds: selected,
                  });
                  onFeedback(result.text);
                  setSelected([]);
                  setNotice(
                    "Feedback added to your draft. Review it and press Send when ready; no agent was started.",
                  );
                })
              }
            >
              <MessageToDraftGlyph />
            </IconAction>
          )}
        </div>
        {comments.length === 0 && (
          <Notice>
            {inline
              ? "Use Discuss with team on a message, or start a discussion below. "
              : "Discuss the plan or select text above to leave a contextual comment. "}
            Comments never start an agent.
          </Notice>
        )}
        <div
          className={
            inline ? "multiplayer-widget-comments space-y-3" : "space-y-3"
          }
        >
          <DiscussionList
            discussions={discussions}
            messages={data.thread.messages}
            identity={identity}
            ownerId={data.thread.ownerId}
            selected={selected}
            busy={action.busy}
            activeRootId={parentId}
            onSelect={
              mine && onFeedback
                ? (commentId, checked) =>
                    setSelected((old) =>
                      checked
                        ? [...new Set([...old, commentId])].slice(0, 20)
                        : old.filter((id) => id !== commentId),
                    )
                : undefined
            }
            onReply={(root) => {
              setParentId(root.id);
              setAnchor(null);
              inputRef.current?.focus();
            }}
            onResolve={(root) =>
              void action.run(async () => {
                await rpc.call("resolve", {
                  id: root.id,
                  version: root.version,
                  resolved: !root.resolved,
                });
                refresh();
              })
            }
          />
        </div>
        {data.commentsTruncated && (
          <Notice>
            Showing a limited preview of up to 200 comments, grouped by
            discussion. Roots are included with their replies; some replies or
            discussions may be outside this preview.
          </Notice>
        )}
      </section>
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          // Keep host composer shortcuts out of the team input. Plain Enter is
          // a newline; Cmd/Ctrl+Enter posts only to the relay, never the agent.
          if (event.target instanceof HTMLTextAreaElement) {
            if (event.key !== "Escape") event.stopPropagation();
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (body.trim() && status.online && !action.busy)
                event.currentTarget.requestSubmit();
            }
          }
        }}
        className={cn(
          "space-y-3 rounded-lg border border-border bg-card p-4",
          inline && "multiplayer-widget-composer",
        )}
      >
        <label htmlFor={`comment-${id}`} className="text-sm font-medium">
          {parentId
            ? "Reply to discussion"
            : anchor
              ? "Comment on selected text"
              : "New discussion"}
        </label>
        {(parentId || anchor) && (
          <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
            <blockquote className="whitespace-pre-wrap">
              {anchor?.quote ??
                (replyRoot
                  ? `${author(replyRoot.authorId)}: ${replyRoot.body.slice(0, 240)}`
                  : "Replying to an existing discussion")}
            </blockquote>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={action.busy}
              onClick={() => {
                setAnchor(null);
                setParentId(null);
              }}
            >
              Clear
            </Button>
          </div>
        )}
        <div className="relative" data-team-comment-composer="">
          <textarea
            ref={inputRef}
            id={`comment-${id}`}
            className="block min-h-24 w-full resize-y rounded-md border border-border bg-background p-3 pb-12 pr-14 text-sm focus-visible:outline focus-visible:outline-2"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Discuss with your team, not with the agent…"
            maxLength={4000}
            disabled={action.busy}
            required
          />
          <div className="absolute bottom-3 right-3">
            <IconAction
              type="submit"
              label="Post comment"
              hint={
                action.busy
                  ? "Posting comment…"
                  : !status.online
                    ? "Connect to the relay to post a comment"
                    : !body.trim()
                      ? "Write a comment to send to your team"
                      : "Post comment to team (⌘/Ctrl+Enter) — does not run the agent"
              }
              variant="default"
              className="size-8 rounded-full text-background hover:text-background"
              disabled={action.busy || !body.trim() || !status.online}
            >
              <PostCommentGlyph />
            </IconAction>
          </div>
        </div>
      </form>
      {(action.error || error) && (
        <Notice error>{action.error ?? error}</Notice>
      )}
      {notice && <Notice>{notice}</Notice>}
    </div>
  );
}

function TeamDiscussionOverlay() {
  const context = useBbContext();
  const layout = useSidebarSplitLayout();
  const composers = useComposers();
  const request = useDiscussionRequest();
  const focusedThreadId = layout
    ? (layout.panes.find((pane) => pane.isFocused)?.threadId ?? null)
    : context.threadId;
  const [selection, setSelection] = useState<{
    focusAtOpen: string | null;
    request: DiscussionRequest;
  } | null>(null);
  useEffect(() => {
    if (request) {
      setSelection({ focusAtOpen: focusedThreadId, request });
      consumeDiscussionRequest(request.requestId);
    } else {
      setSelection((old) =>
        old?.focusAtOpen === focusedThreadId ? old : null,
      );
    }
  }, [request, focusedThreadId]);
  const activeRequest =
    request ??
    (selection?.focusAtOpen === focusedThreadId ? selection.request : null);
  const threadId = activeRequest?.threadId ?? focusedThreadId;
  // No widget on settings, plugin pages or new-thread compose unless explicitly
  // opened by a thread action. Never infer identity from app-shell DOM.
  if (!threadId) return null;
  const matches = composers.filter(
    (c) => c.scope.kind === "thread" && c.scope.threadId === threadId,
  );
  const composer = activeRequest?.composerKey
    ? (matches.find((c) => c.key === activeRequest.composerKey) ?? null)
    : matches.length === 1
      ? matches[0]
      : null;
  return (
    <FloatingThreadDiscussion
      key={threadId}
      threadId={threadId}
      composer={composer}
      request={activeRequest}
    />
  );
}

function FloatingThreadDiscussion({
  threadId,
  composer,
  request,
}: {
  threadId: string;
  composer: PluginComposerApi | null;
  request: DiscussionRequest | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const action = useAction();
  const load = useCallback(
    () => rpc.call("discussionContext", { threadId }),
    [rpc, threadId],
  );
  const { data, error, refresh } = useLoad(load);
  const [expanded, setExpanded] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [target, setTarget] = useState<DiscussionTarget | null>(null);
  const appliedRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!request || appliedRequest.current === request.requestId) return;
    appliedRequest.current = request.requestId;
    setExpanded(true);
    setHasOpened(true);
    setTarget(request.target);
  }, [request]);
  if (!data && !request && !error) return null;
  if (data && !data.connectedProject && !expanded) return null;
  const status = {
    identity: data?.identity ?? null,
    online: data?.online ?? false,
  };
  return (
    <FloatingDiscussion
      title={data?.threadTitle ?? "Team discussion"}
      subtitle={
        data
          ? `${data.sharing ? "Shared" : data.sharedId ? "Sharing paused" : "Private"} · ${data.online ? "Online" : "Offline"}`
          : "Loading thread…"
      }
      badge={data?.commentCount ?? 0}
      headerActions={
        data?.connectedProject ? (
          <IconAction
            label="Sharing settings"
            hint="Sharing settings"
            aria-expanded={!data.sharedId || settingsOpen}
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <SharingSettingsGlyph />
          </IconAction>
        ) : undefined
      }
      open={expanded}
      onOpenChange={(open) => {
        setExpanded(open);
        if (open) setHasOpened(true);
      }}
    >
      <div className="multiplayer-widget-content">
        {!data ? (
          <Notice error={Boolean(error)}>
            {error ?? "Loading team discussion…"}
          </Notice>
        ) : !data.connectedProject ? (
          <div className="space-y-2">
            <Notice>
              Connect this local project on the Multiplayer page first. Nothing
              has been shared.
            </Notice>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate.toPluginPanel("team")}
            >
              Open Multiplayer setup
            </Button>
          </div>
        ) : (
          <>
            {(!data.sharedId || settingsOpen) && (
              <div className="multiplayer-widget-sharing space-y-3 rounded-lg border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  Sharing publishes the title, status and recent human/assistant
                  message text. Review it for secrets first. Pausing stops
                  future updates, not already published context.
                </p>
                {data.sharing ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={action.busy}
                    onClick={() =>
                      void action.run(async () => {
                        await rpc.call("pause", { threadId });
                        refresh();
                      })
                    }
                  >
                    Pause future sharing
                  </Button>
                ) : (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={consent}
                        onCheckedChange={(value) => setConsent(value === true)}
                      />
                      I reviewed the conversation and want to share its text.
                    </label>
                    <Button
                      size="sm"
                      disabled={!consent || action.busy}
                      onClick={() =>
                        void action.run(async () => {
                          await rpc.call("share", {
                            threadId,
                            confirmed: true,
                          });
                          setConsent(false);
                          setSettingsOpen(false);
                          refresh();
                        })
                      }
                    >
                      Enable team sharing
                    </Button>
                  </>
                )}
              </div>
            )}
            {data.sharedId && hasOpened && (
              <ThreadDetail
                key={data.sharedId}
                id={data.sharedId}
                status={status}
                localThreadId={threadId}
                inline
                discussionTarget={target}
                onFeedback={
                  composer
                    ? (text) => {
                        if (
                          composer.scope.kind !== "thread" ||
                          composer.scope.threadId !== threadId
                        )
                          throw new Error(
                            "The matching agent composer is no longer available. Open the original thread and try again.",
                          );
                        composer.insert(text, { at: "end", block: true });
                        composer.focus();
                      }
                    : undefined
                }
              />
            )}
            {action.error && <Notice error>{action.error}</Notice>}
          </>
        )}
      </div>
    </FloatingDiscussion>
  );
}

function ThreadPanel({
  threadId,
  params,
}: {
  threadId: string;
  params: JsonValue | null;
}) {
  const rpc = useRpc<typeof rpcContract>(),
    composer = useComposer(),
    action = useAction();
  const [consent, setConsent] = useState(false);
  const load = useCallback(
    async () => ({
      status: await rpc.call("status"),
      local: await rpc.call("localThread", { threadId }),
    }),
    [rpc, threadId],
  );
  const { data, error, refresh } = useLoad(load);
  if (!data)
    return <Notice error={Boolean(error)}>{error ?? "Loading…"}</Notice>;
  const { status, local } = data;
  if (!local.connectedProject)
    return (
      <Notice>Connect this local project on the Multiplayer page first.</Notice>
    );
  const values =
    params && typeof params === "object" && !Array.isArray(params)
      ? params
      : {};
  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">
          {local.sharing ? "Sharing with your team" : "Thread sharing is off"}
        </h3>
        <p className="text-xs text-muted-foreground">
          Sharing publishes the title, status and up to 100 recent
          human/assistant messages, then keeps them updated. Text can contain
          secrets: review it first. Tool output, files and attachments are
          excluded. Pausing does not erase already published context.
        </p>
        {local.sharing ? (
          <Button
            variant="outline"
            size="sm"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await rpc.call("pause", { threadId });
                refresh();
              })
            }
          >
            Pause future sharing
          </Button>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={consent}
                onCheckedChange={(value) => setConsent(value === true)}
              />
              I reviewed the conversation and want to share its text.
            </label>
            <Button
              size="sm"
              disabled={!consent || action.busy}
              onClick={() =>
                void action.run(async () => {
                  await rpc.call("share", { threadId, confirmed: true });
                  setConsent(false);
                  refresh();
                })
              }
            >
              Enable team sharing
            </Button>
          </>
        )}
      </section>
      {action.error && <Notice error>{action.error}</Notice>}
      {local.sharedId && (
        <ThreadDetail
          key={local.sharedId}
          id={local.sharedId}
          status={status}
          localThreadId={threadId}
          initialMessageId={
            typeof values.messageId === "string" ? values.messageId : undefined
          }
          initialQuote={
            typeof values.quote === "string" ? values.quote : undefined
          }
          onFeedback={(text) => {
            composer.insert(text, { at: "end", block: true });
            composer.focus();
          }}
        />
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "team",
    title: "Multiplayer",
    icon: "multiplayer/people",
    path: "team",
    component: TeamPage,
  });
  app.slots.experimental_threadList({
    id: "team-threads",
    title: "Multiplayer threads",
    description: "Local and shared team threads grouped by project",
    component: TeamThreadList,
  });
  app.slots.experimental_appOverlay({
    id: "message-request-inbox",
    component: OwnerRequestInbox,
  });
  app.composer.customize({
    id: "message-request-review",
    scopes: ["thread"],
    banners: [
      { id: "owner-requests", chrome: "bare", component: OwnerRequestBanner },
    ],
  });
  // Keep saved legacy tabs usable; all new local interactions use the overlay.
  registerThreadPanel(app, ThreadPanel);
  app.slots.experimental_appOverlay({
    id: "team-discussion",
    component: TeamDiscussionOverlay,
  });
  app.composer.customize({
    id: "team-discussion",
    scopes: ["thread"],
    plusMenu: [
      {
        id: "open-team-discussion",
        label: "Team discussion",
        icon: "multiplayer/people",
        description:
          "Discuss with your teammates in this thread without running the agent",
        run: ({ composer }) => {
          if (composer.scope.kind === "thread")
            requestDiscussion(composer.scope.threadId, composer.key);
        },
      },
    ],
  });
  app.slots.messageAction({
    id: "comment",
    title: "Discuss with team",
    icon: "MessageSquare",
    run({ message, selectedText, composer }) {
      const composerKey =
        composer?.scope.kind === "thread" &&
        composer.scope.threadId === message.threadId
          ? composer.key
          : null;
      requestDiscussion(message.threadId, composerKey, {
        messageId: message.id,
        quote: selectedText ?? "",
      });
    },
  });
});
