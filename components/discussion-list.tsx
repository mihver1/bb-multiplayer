import { useId, useState } from "react";
import type { ReactNode } from "react";
import type { Discussion } from "../shared/discussions";
import type { Comment, Identity, SharedThread } from "../shared/protocol";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { cn } from "../lib/utils";

type Props = {
  discussions: Discussion[];
  messages: SharedThread["messages"];
  identity: Identity | null;
  ownerId: string;
  selected: readonly string[];
  onSelect?: (commentId: string, checked: boolean) => void;
  onReply: (root: Comment) => void;
  onResolve: (root: Comment) => void;
  busy: boolean;
  activeRootId: string | null;
};

export function DiscussionList(props: Props) {
  return (
    <div className="space-y-3" aria-label="Discussion threads">
      {props.discussions.map((discussion) => (
        <DiscussionBranch
          key={`${discussion.threadId}/${discussion.id}`}
          discussion={discussion}
          {...props}
        />
      ))}
    </div>
  );
}

function DiscussionBranch({
  discussion,
  messages,
  identity,
  ownerId,
  selected,
  onSelect,
  onReply,
  onResolve,
  busy,
  activeRootId,
}: Props & { discussion: Discussion }) {
  const repliesId = useId();
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);
  const { root, replies } = discussion;
  const author = (memberId: string) =>
    identity?.members.find((member) => member.id === memberId)?.name ??
    "Teammate";
  const resolved = root?.resolved ?? false;
  // Reopening is always expanded. Resolving collapses replies by default; an
  // active reply or selected feedback stays visible until the user clears it.
  const expanded =
    !resolved ||
    expandedVersion === root?.version ||
    activeRootId === discussion.id ||
    replies.some((reply) => selected.includes(reply.id));
  const canResolve =
    root &&
    (root.authorId === identity?.member.id ||
      ownerId === identity?.member.id ||
      identity?.member.role === "owner");

  function renderComment(comment: Comment): ReactNode {
    const message = messages.find((m) => m.id === comment.anchor?.messageId);
    const stale = comment.anchor && message?.version !== comment.anchor.version;
    return (
      <article
        key={comment.id}
        data-comment-id={comment.id}
        className="multiplayer-comment min-w-0 space-y-2"
      >
        <div className="flex flex-wrap items-center gap-2">
          {onSelect && (
            <Checkbox
              checked={selected.includes(comment.id)}
              disabled={busy}
              aria-label={`Select comment by ${author(comment.authorId)}`}
              onCheckedChange={(checked) =>
                onSelect(comment.id, checked === true)
              }
            />
          )}
          <span className="text-sm font-medium">
            {author(comment.authorId)}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(comment.createdAt).toLocaleString()}
          </span>
          {comment.parentId === null && (
            <span className="rounded-full border border-border px-2 text-xs text-muted-foreground">
              {resolved ? "Resolved" : "Open"}
            </span>
          )}
        </div>
        {comment.anchor && (
          <blockquote className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
            {comment.anchor.quote}
            {stale && (
              <p className="mt-1 font-medium">
                Original version — message has changed or is outside the current
                preview.
              </p>
            )}
          </blockquote>
        )}
        <p className="whitespace-pre-wrap break-words text-sm">
          {comment.body}
        </p>
        <div className="multiplayer-comment-actions flex min-h-6 gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-muted-foreground"
            disabled={busy || !root}
            onClick={() => {
              if (root) onReply(root);
            }}
          >
            Reply
          </Button>
          {comment.parentId === null && canResolve && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-muted-foreground"
              disabled={busy}
              onClick={() => onResolve(comment)}
            >
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
        </div>
      </article>
    );
  }

  return (
    <section
      data-discussion-id={discussion.id}
      aria-label={`Discussion by ${author(root?.authorId ?? "")}`}
      className={cn(
        "rounded-lg border border-border p-3",
        resolved && "bg-muted",
        activeRootId === discussion.id && "ring-1 ring-ring",
      )}
    >
      {root ? (
        renderComment(root)
      ) : (
        <p role="status" className="text-xs text-muted-foreground">
          Original comment is not available yet. These replies belong to one
          discussion; waiting for its root to sync.
        </p>
      )}
      {replies.length > 0 && (
        <>
          {resolved ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-controls={repliesId}
              onClick={() =>
                setExpandedVersion(expanded ? null : (root?.version ?? null))
              }
              disabled={
                activeRootId === discussion.id ||
                replies.some((reply) => selected.includes(reply.id))
              }
            >
              {expanded ? "Hide" : "Show"} {replies.length}{" "}
              {replies.length === 1 ? "reply" : "replies"}
            </Button>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              {replies.length} {replies.length === 1 ? "reply" : "replies"}
            </p>
          )}
          <div
            id={repliesId}
            hidden={!expanded}
            className="ml-2 mt-2 space-y-3 border-l-2 border-border pl-3"
          >
            {replies.map(renderComment)}
          </div>
        </>
      )}
    </section>
  );
}
