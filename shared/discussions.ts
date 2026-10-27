import type { Comment } from "./protocol";

export type Discussion = {
  id: string;
  threadId: string;
  root: Comment | null;
  replies: Comment[];
};

const key = (threadId: string, id: string) => `${threadId}\0${id}`;
const byCreation = (a: Comment, b: Comment) =>
  a.createdAt - b.createdAt || a.id.localeCompare(b.id);

/** The relay supports one reply level: every reply refers to a root comment.
 * Keep roots in creation order, not last-reply order, and replies within their
 * own branch. A missing parent during catch-up gets its own placeholder group.
 * Never attach a reply to an identically named root from another shared thread.
 */
export function groupDiscussions(comments: readonly Comment[]): Discussion[] {
  const groups = new Map<string, Discussion>();
  for (const comment of comments) {
    const rootId = comment.parentId ?? comment.id;
    const groupKey = key(comment.threadId, rootId);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        id: rootId,
        threadId: comment.threadId,
        root: null,
        replies: [],
      };
      groups.set(groupKey, group);
    }
    if (comment.parentId === null) group.root = comment;
    else group.replies.push(comment);
  }
  for (const group of groups.values()) group.replies.sort(byCreation);
  return [...groups.values()].sort(
    (a, b) =>
      byCreation(a.root ?? a.replies[0], b.root ?? b.replies[0]) ||
      a.threadId.localeCompare(b.threadId),
  );
}

/** Bound the local RPC preview without cutting a visible reply off from its
 * available root. Recency chooses the preview window only; display order is
 * always root → its replies. The existing wire schema stays capped at 200.
 */
export function commentPreview(
  comments: readonly Comment[],
  limit = 200,
): Comment[] {
  if (!Number.isInteger(limit) || limit < 0)
    throw new Error("Invalid comment preview limit");
  const sorted = [...comments].sort(byCreation);
  const byId = new Map(
    sorted.map((comment) => [key(comment.threadId, comment.id), comment]),
  );
  const selected = new Set<string>();
  for (let i = sorted.length - 1; i >= 0 && selected.size < limit; i--) {
    const comment = sorted[i];
    const parent = comment.parentId
      ? byId.get(key(comment.threadId, comment.parentId))
      : undefined;
    const required = [comment];
    if (parent?.parentId === null) required.unshift(parent);
    const missing = required
      .map((item) => key(item.threadId, item.id))
      .filter((id) => !selected.has(id));
    if (selected.size + missing.length <= limit)
      missing.forEach((id) => selected.add(id));
  }
  return groupDiscussions(
    sorted.filter((comment) => selected.has(key(comment.threadId, comment.id))),
  ).flatMap((group) =>
    group.root ? [group.root, ...group.replies] : group.replies,
  );
}
