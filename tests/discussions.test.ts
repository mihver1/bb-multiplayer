import { describe, expect, it } from "vitest";
import { commentPreview, groupDiscussions } from "../shared/discussions";
import type { Comment } from "../shared/protocol";

function comment(
  id: string,
  createdAt: number,
  parentId: string | null = null,
  threadId = "thread",
): Comment {
  return {
    id,
    createdAt,
    parentId,
    threadId,
    authorId: "author",
    anchor: null,
    body: id,
    resolved: false,
    version: 1,
  };
}
const flatten = (comments: readonly Comment[]) =>
  groupDiscussions(comments).flatMap((group) => [
    group.root?.id,
    ...group.replies.map((c) => c.id),
  ]);

describe("discussion grouping", () => {
  it("places interleaved replies directly after their own root, regardless of arrival order", () => {
    const data = [
      comment("a", 1),
      comment("b", 2),
      comment("b1", 3, "b"),
      comment("a1", 4, "a"),
      comment("c", 5),
      comment("a2", 6, "a"),
    ];
    expect(flatten(data)).toEqual(["a", "a1", "a2", "b", "b1", "c"]);
    expect(flatten([...data].reverse())).toEqual(flatten(data));
    expect(data.map((c) => c.id)).toEqual(["a", "b", "b1", "a1", "c", "a2"]);
  });
  it("does not move a root when it gets another reply or is resolved", () => {
    const data = [comment("a", 1), comment("b", 2), comment("c", 3)];
    expect(
      groupDiscussions([...data, comment("a1", 1000, "a")]).map((g) => g.id),
    ).toEqual(["a", "b", "c"]);
    expect(
      groupDiscussions([{ ...data[0], resolved: true }, ...data.slice(1)]).map(
        (g) => g.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });
  it("breaks equal timestamps deterministically and never mutates the inputs", () => {
    const a = Object.freeze(comment("a", 1)),
      b = Object.freeze(comment("b", 1));
    const input = Object.freeze([
      b,
      a,
      Object.freeze(comment("a2", 2, "a")),
      Object.freeze(comment("a1", 2, "a")),
    ]);
    expect(flatten(input)).toEqual(["a", "a1", "a2", "b"]);
  });
  it("keeps missing-parent replies in one placeholder group until the parent arrives", () => {
    const replies = [comment("a2", 3, "a"), comment("a1", 2, "a")];
    const group = groupDiscussions(replies)[0];
    expect(group.root).toBeNull();
    expect(group.id).toBe("a");
    expect(group.replies.map((c) => c.id)).toEqual(["a1", "a2"]);
    expect(flatten([...replies, comment("a", 1)])).toEqual(["a", "a1", "a2"]);
  });
  it("never merges discussion roots from different shared threads", () => {
    const groups = groupDiscussions([
      comment("a", 1, null, "one"),
      comment("reply", 2, "a", "two"),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.threadId === "one")?.replies).toEqual([]);
    expect(groups.find((g) => g.threadId === "two")?.root).toBeNull();
  });
  it("accepts an empty list", () => {
    expect(groupDiscussions([])).toEqual([]);
  });
});

describe("bounded threaded previews", () => {
  it("includes an older root for a recent reply instead of orphaning the reply", () => {
    const old = comment("old", 0);
    const newer = Array.from({ length: 205 }, (_, i) =>
      comment(`root_${i}`, i + 1),
    );
    const result = commentPreview([
      old,
      ...newer,
      comment("late_reply", 999, "old"),
    ]);
    expect(result).toHaveLength(200);
    expect(result[0].id).toBe("old");
    expect(result[1].id).toBe("late_reply");
    expect(result.filter((c) => c.id === "old")).toHaveLength(1);
    expect(result.map((c) => c.id)).toContain("root_204");
  });
  it("keeps a root and the latest replies of an oversized discussion within the cap", () => {
    const comments = [
      comment("a", 0),
      ...Array.from({ length: 250 }, (_, i) =>
        comment(`reply_${i}`, i + 1, "a"),
      ),
    ];
    const result = commentPreview(comments);
    expect(result).toHaveLength(200);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("reply_51");
    expect(result.at(-1)?.id).toBe("reply_249");
  });
  it("reserves root capacity at the boundary, handles missing roots and never exceeds the limit", () => {
    const input = [
      comment("a", 0),
      comment("b", 1),
      comment("a1", 2, "a"),
      comment("missing1", 3, "missing"),
    ];
    for (const limit of [0, 1, 2, 3, 4, 5, 200]) {
      const result = commentPreview(input, limit);
      expect(result.length).toBeLessThanOrEqual(limit);
      if (result.some((c) => c.id === "a1"))
        expect(result.some((c) => c.id === "a")).toBe(true);
      expect(new Set(result.map((c) => c.id)).size).toBe(result.length);
    }
    expect(commentPreview(input, 0)).toEqual([]);
  });
  it("rejects invalid limits", () => {
    for (const n of [-1, NaN, 1.5, Infinity])
      expect(() => commentPreview([], n)).toThrow("Invalid");
  });
});
