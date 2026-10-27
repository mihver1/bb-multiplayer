// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { useComposer } from "@get-bb/plugin-sdk/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { rpcContract } from "../server";
import { requestDiscussion } from "../lib/discussion-target";
import { clampWidgetPosition } from "../components/floating-discussion";

const memberId = "22222222-2222-4222-8222-222222222222";
const sharedId = "33333333-3333-4333-8333-333333333333";
const commentId = "44444444-4444-4444-8444-444444444444";
function context(): z.infer<typeof rpcContract.discussionContext.output> {
  const member = {
    id: memberId,
    name: "Alice",
    role: "owner" as const,
    lastSeenAt: Date.now(),
    revoked: false,
  };
  return {
    threadTitle: "Migration thread",
    connectedProject: true,
    sharedId,
    sharing: true,
    online: true,
    identity: {
      room: { id: "11111111-1111-4111-8111-111111111111", name: "Team" },
      member,
      members: [member],
    },
    commentCount: 1,
    openCount: 1,
  };
}
function detail(): z.infer<typeof rpcContract.thread.output> {
  return {
    thread: {
      id: sharedId,
      revision: 1,
      title: "Do not repeat the whole conversation",
      status: "idle",
      ownerId: memberId,
      updatedAt: 1,
      historyTruncated: false,
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          text: "Plan: add tests",
          version: "a".repeat(64),
          createdAt: 1,
          truncated: false,
        },
        {
          id: "msg_2",
          role: "user",
          text: "Check rollback",
          version: "b".repeat(64),
          createdAt: 2,
          truncated: false,
        },
      ],
    },
    comments: [
      {
        id: commentId,
        threadId: sharedId,
        authorId: memberId,
        body: "Add a rollback test",
        parentId: null,
        anchor: null,
        resolved: false,
        createdAt: 2,
        version: 1,
      },
    ],
    commentsTruncated: false,
    localId: "thr_a",
    sharing: true,
  };
}
async function setup(
  overrides: {
    context?: () => ReturnType<typeof context>;
    detail?: () => ReturnType<typeof detail>;
    resolve?: (input: unknown) => unknown | Promise<unknown>;
    add?: (input: unknown) => unknown | Promise<unknown>;
    localThreadId?: string;
    routeThreadId?: string | null;
  } = {},
) {
  const app = await loadPluginApp(() => import("../app"));
  const registration = app.appOverlays.find((c) => c.id === "team-discussion")!;
  const Overlay = registration.component;
  let composer!: PluginComposerApi;
  function Mount() {
    composer = useComposer();
    return <Overlay />;
  }
  const added = vi.fn(overrides.add ?? (() => detail().comments[0]));
  const slot = renderSlot(
    { component: Mount },
    {},
    {
      context: {
        threadId:
          overrides.routeThreadId === undefined
            ? "thr_a"
            : overrides.routeThreadId,
        projectId: "proj_a",
      },
      composer: {
        scope: { kind: "thread", threadId: overrides.localThreadId ?? "thr_a" },
        text: "Private unfinished agent prompt",
      },
      rpc: {
        discussionContext: overrides.context ?? context,
        thread: overrides.detail ?? detail,
        addComment: added,
        feedback: () => ({ text: "Selected feedback for agent draft" }),
        resolve: overrides.resolve ?? (() => detail().comments[0]),
      },
    },
  );
  return { app, registration, slot, added, composer: () => composer };
}
afterEach(cleanup);

describe("floating team discussion", () => {
  it("registers an app overlay, not a composer banner, and does not duplicate the conversation", async () => {
    const { app, registration, slot } = await setup();
    expect(registration.id).toBe("team-discussion");
    expect(
      app.composerCustomizations.find((c) => c.id === "team-discussion")
        ?.banners,
    ).toBeUndefined();
    const toggle = await slot.findByRole("button", { name: /Team discussion/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(slot.inspection.rpcCalls.some((c) => c.method === "thread")).toBe(
      false,
    );
    fireEvent.click(toggle);
    await slot.findByText("Add a rollback test");
    expect(slot.queryByLabelText("Shared messages")).toBeNull();
    expect(slot.queryByText("Do not repeat the whole conversation")).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([]);
  });
  it("posts only a team comment and preserves the native agent draft and attachments", async () => {
    const { slot, added } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const input = await slot.findByLabelText("New discussion");
    fireEvent.change(input, { target: { value: "For humans only" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(added).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(added).toHaveBeenCalledOnce());
    expect(added.mock.calls[0][0]).toMatchObject({
      body: "For humans only",
      threadId: sharedId,
      parentId: null,
      anchor: null,
    });
    expect(slot.inspection.composer.text).toBe(
      "Private unfinished agent prompt",
    );
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.inputLockCalls).toEqual([]);
    expect(slot.inspection.sdkCalls).toEqual([]);
  });
  it("retries a failed send using the same comment ID and keeps the text across collapse", async () => {
    let count = 0;
    const { slot, added } = await setup({
      add: () => {
        if (++count === 1) throw new Error("Offline");
        return detail().comments[0];
      },
    });
    const toggle = await slot.findByRole("button", { name: /Team discussion/ });
    fireEvent.click(toggle);
    const input = (await slot.findByLabelText(
      "New discussion",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Keep my draft" } });
    fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
    await slot.findByText("Offline");
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(input.value).toBe("Keep my draft");
    fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(added).toHaveBeenCalledTimes(2));
    expect(added.mock.calls[0][0]).toEqual(added.mock.calls[1][0]);
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("routes message actions to the widget, updates quotes and never opens a panel", async () => {
    const { app, slot, composer } = await setup();
    await slot.findByRole("button", { name: /Team discussion/ });
    const openPanel = vi.fn(() => true);
    const actOnMessage = async (messageId: string, text: string) => {
      await act(async () =>
        app.messageActions[0].run({
          threadId: "thr_a",
          message: {
            id: messageId,
            threadId: "thr_a",
            role: "assistant",
            text,
            sourceSeqEnd: 1,
            experimental_messageSeq: 1,
          },
          composer: composer(),
          selectedText: text,
          openPanel,
        }),
      );
    };
    await actOnMessage("msg_1", "add tests");
    const input = await slot.findByLabelText("Comment on selected text");
    expect(slot.getByText("add tests")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Already typing" } });
    await actOnMessage("msg_2", "rollback");
    expect(slot.getByText("rollback")).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("Already typing");
    expect(openPanel).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.find((c) => c.method === "addComment")?.input,
      ).toMatchObject({
        anchor: {
          messageId: "msg_2",
          version: "b".repeat(64),
          quote: "rollback",
        },
      }),
    );
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("lets selected feedback append to the existing agent draft without submitting", async () => {
    const { slot } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    fireEvent.click(await slot.findByLabelText("Select comment by Alice"));
    fireEvent.click(slot.getByRole("button", { name: "Add 1 to agent draft" }));
    await slot.findByText(
      "Feedback added to your draft. Review it and press Send when ready; no agent was started.",
    );
    expect(slot.inspection.composer.text).toContain(
      "Private unfinished agent prompt",
    );
    expect(slot.inspection.composer.text).toContain(
      "Selected feedback for agent draft",
    );
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("shows sharing consent before ever publishing an unshared thread", async () => {
    const { slot } = await setup({
      context: () => ({
        ...context(),
        sharedId: null,
        sharing: false,
        commentCount: 0,
        openCount: 0,
      }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    expect(
      (slot.getByText("Enable team sharing") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(slot.inspection.rpcCalls.some((c) => c.method === "share")).toBe(
      false,
    );
  });
  it("does not send offline even when the form submit event is forced", async () => {
    const { slot, added } = await setup({
      context: () => ({ ...context(), online: false }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const input = await slot.findByLabelText("New discussion");
    fireEvent.change(input, { target: { value: "Offline draft" } });
    fireEvent.submit(input.closest("form")!);
    expect(added).not.toHaveBeenCalled();
  });
  it("isolates targets and drafts when explicitly opening another thread", async () => {
    const { slot } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    fireEvent.change(await slot.findByLabelText("New discussion"), {
      target: { value: "Thread A only" },
    });
    await act(async () => requestDiscussion("thr_b"));
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.some(
          (c) =>
            c.method === "discussionContext" &&
            (c.input as { threadId: string }).threadId === "thr_b",
        ),
      ).toBe(true),
    );
    expect(
      ((await slot.findByLabelText("New discussion")) as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(
      slot.queryByRole("button", { name: /Add .* to agent draft/ }),
    ).toBeNull();
    expect(slot.inspection.composer.text).toBe(
      "Private unfinished agent prompt",
    );
  });
  it("focuses the comment input when an anchored message action opens the widget", async () => {
    const { app, slot, composer } = await setup();
    await slot.findByRole("button", { name: /Team discussion/ });
    await act(async () =>
      app.messageActions[0].run({
        threadId: "thr_a",
        message: {
          id: "msg_1",
          threadId: "thr_a",
          role: "assistant",
          text: "Plan: add tests",
          sourceSeqEnd: 1,
          experimental_messageSeq: 1,
        },
        composer: composer(),
        selectedText: "add tests",
        openPanel: () => {
          throw new Error("Must not open a panel");
        },
      }),
    );
    const input = await slot.findByLabelText("Comment on selected text");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
  it("minimizes with Escape, preserves the draft, and restores focus to the launcher", async () => {
    const { slot } = await setup();
    const toggle = await slot.findByRole("button", { name: /Team discussion/ });
    fireEvent.click(toggle);
    const input = (await slot.findByLabelText(
      "New discussion",
    )) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Keep on minimize" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(slot.queryByRole("dialog")).toBeNull();
    fireEvent.click(toggle);
    expect(
      (slot.getByLabelText("New discussion") as HTMLTextAreaElement).value,
    ).toBe("Keep on minimize");
  });
  it("does not create a widget on non-thread pages without an explicit request", async () => {
    const { slot } = await setup({ routeThreadId: null });
    expect(slot.queryByRole("button", { name: /Team discussion/ })).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  });
  it("keeps interleaved replies in their branch and targets its root even when replying to a reply", async () => {
    const a = { ...detail().comments[0], body: "Topic A", createdAt: 1 };
    const b = {
      ...a,
      id: "55555555-5555-4555-8555-555555555555",
      body: "Topic B",
      createdAt: 2,
    };
    const a1 = {
      ...a,
      id: "66666666-6666-4666-8666-666666666666",
      parentId: a.id,
      body: "Answer A",
      createdAt: 3,
    };
    const b1 = {
      ...b,
      id: "77777777-7777-4777-8777-777777777777",
      parentId: b.id,
      body: "Answer B",
      createdAt: 4,
    };
    const data = { ...detail(), comments: [a, b, a1, b1] };
    const { slot, added } = await setup({ detail: () => data });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const rootBody = await slot.findByText("Topic A");
    const branchA = rootBody.closest("[data-discussion-id]")! as HTMLElement;
    const list = slot.getByLabelText("Discussion threads");
    expect(
      Array.from(list.querySelectorAll("[data-comment-id]"), (e) =>
        e.getAttribute("data-comment-id"),
      ),
    ).toEqual([a.id, a1.id, b.id, b1.id]);
    expect(within(branchA).getByText("Answer A")).toBeTruthy();
    expect(within(branchA).queryByText("Answer B")).toBeNull();
    fireEvent.click(within(branchA).getAllByText("Reply")[1]);
    expect(slot.getByText("Alice: Topic A")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Reply to discussion"), {
      target: { value: "Next A answer" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Post comment" }));
    await waitFor(() => expect(added).toHaveBeenCalledOnce());
    expect(added.mock.calls[0][0]).toMatchObject({
      parentId: a.id,
      anchor: null,
      body: "Next A answer",
    });
    expect(slot.inspection.composer.submits).toEqual([]);
    // A later reply still belongs to A and never moves A behind B.
    const a2 = {
      ...a1,
      id: "88888888-8888-4888-8888-888888888888",
      body: "Late A",
      createdAt: 9,
    };
    data.comments.push(a2);
    await slot.behavior.emitRealtime("changed", null);
    await slot.findByText("Late A");
    expect(
      Array.from(list.querySelectorAll("[data-comment-id]"), (e) =>
        e.getAttribute("data-comment-id"),
      ),
    ).toEqual([a.id, a1.id, a2.id, b.id, b1.id]);
  });
  it("collapses replies of resolved discussions, expands on demand and reopens the same branch", async () => {
    const root = {
      ...detail().comments[0],
      body: "Resolved topic",
      resolved: true,
    };
    const reply = {
      ...root,
      id: "55555555-5555-4555-8555-555555555555",
      parentId: root.id,
      body: "Resolved answer",
      resolved: false,
      createdAt: 3,
    };
    const data = { ...detail(), comments: [root, reply] };
    const { slot } = await setup({
      detail: () => data,
      resolve: () => {
        data.comments[0] = { ...root, resolved: false, version: 2 };
        return data.comments[0];
      },
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    await slot.findByText("Resolved topic");
    const toggle = slot.getByRole("button", { name: "Show 1 reply" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(slot.queryAllByRole("article")).toHaveLength(1);
    fireEvent.click(toggle);
    expect(slot.queryAllByRole("article")).toHaveLength(2);
    fireEvent.click(slot.getByText("Reopen"));
    await slot.findByText("Resolve");
    expect(slot.queryByRole("button", { name: /Show 1 reply/ })).toBeNull();
    expect(slot.queryAllByRole("article")).toHaveLength(2);
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "resolve")?.input,
    ).toEqual({ id: root.id, version: 1, resolved: false });
  });
  it("keeps selected reply feedback visible inside a resolved branch", async () => {
    const root = { ...detail().comments[0], resolved: true };
    const reply = {
      ...root,
      id: "55555555-5555-4555-8555-555555555555",
      parentId: root.id,
      body: "Chosen reply",
      resolved: false,
    };
    const { slot } = await setup({
      detail: () => ({ ...detail(), comments: [root, reply] }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Show 1 reply" }));
    fireEvent.click(
      slot.getAllByRole("checkbox", { name: "Select comment by Alice" })[1],
    );
    expect(
      (slot.getByRole("button", { name: "Hide 1 reply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: "Add 1 to agent draft" }));
    await slot.findByText(
      "Feedback added to your draft. Review it and press Send when ready; no agent was started.",
    );
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "feedback")?.input,
    ).toEqual({ threadId: "thr_a", commentIds: [reply.id] });
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("groups missing-root replies explicitly and disables replying until the root is available", async () => {
    const reply = {
      ...detail().comments[0],
      parentId: "55555555-5555-4555-8555-555555555555",
      body: "Waiting for root",
    };
    const { slot } = await setup({
      detail: () => ({ ...detail(), comments: [reply] }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    await slot.findByText("Waiting for root");
    expect(
      slot.getByText(/Original comment is not available yet/),
    ).toBeTruthy();
    expect(
      (slot.getByRole("button", { name: "Reply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("uses compact header glyphs without the team-only row, and keeps sharing settings accessible", async () => {
    const { slot } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    await slot.findByText("Add a rollback test");
    expect(slot.queryByText(/Team only/)).toBeNull();
    const settings = slot.getByRole("button", { name: "Sharing settings" });
    expect(settings.textContent).toBe("");
    expect(
      settings.querySelector('[data-glyph="sharing-settings"]'),
    ).not.toBeNull();
    expect(settings.closest("header")).not.toBeNull();
    expect(settings.getAttribute("aria-expanded")).toBe("false");
    const feedback = slot.getByRole("button", {
      name: "Add selected to agent draft",
    });
    expect(feedback.textContent).toBe("");
    expect(
      feedback.querySelector('[data-glyph="message-to-draft"]'),
    ).not.toBeNull();
    expect((feedback as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(settings);
    expect(settings.getAttribute("aria-expanded")).toBe("true");
    expect(
      slot.getByRole("button", { name: "Pause future sharing" }),
    ).toBeTruthy();
    fireEvent.click(settings);
    expect(
      slot.queryByRole("button", { name: "Pause future sharing" }),
    ).toBeNull();
    expect(
      slot.inspection.rpcCalls.some(
        (c) => c.method === "share" || c.method === "pause",
      ),
    ).toBe(false);
  });
  it("keeps comment actions focusable within each comment for hover and keyboard reveal", async () => {
    const { slot } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    await slot.findByText("Add a rollback test");
    const reply = slot.getByRole("button", { name: "Reply" });
    const resolve = slot.getByRole("button", { name: "Resolve" });
    const actions = reply.closest(".multiplayer-comment-actions");
    expect(
      actions?.parentElement?.classList.contains("multiplayer-comment"),
    ).toBe(true);
    expect(resolve.closest(".multiplayer-comment-actions")).toBe(actions);
    await act(async () => reply.focus());
    expect(document.activeElement).toBe(reply);
    expect(reply.tabIndex).toBe(0);
    fireEvent.click(reply);
    expect(slot.getByLabelText("Reply to discussion")).toBeTruthy();
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("overlays an accessible send glyph inside the team composer and disables it for empty text", async () => {
    const { slot, added } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const input = (await slot.findByLabelText(
      "New discussion",
    )) as HTMLTextAreaElement;
    const post = slot.getByRole("button", {
      name: "Post comment",
    }) as HTMLButtonElement;
    expect(post.type).toBe("submit");
    expect(post.textContent).toBe("");
    expect(post.querySelector('[data-glyph="post-comment"]')).not.toBeNull();
    expect(post.closest("[data-team-comment-composer]")).toBe(
      input.parentElement,
    );
    expect(input.classList.contains("pb-12")).toBe(true);
    expect(input.classList.contains("pr-14")).toBe(true);
    expect(post.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "  " } });
    expect(post.disabled).toBe(true);
    fireEvent.click(post);
    expect(added).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "Ready to send" } });
    expect(post.disabled).toBe(false);
  });
  it("keeps Cmd/Ctrl+Enter scoped to the team form after replacing the send button", async () => {
    const { slot, added } = await setup();
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const input = await slot.findByLabelText("New discussion");
    fireEvent.change(input, { target: { value: "Shortcut comment" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(added).toHaveBeenCalledOnce());
    expect(added.mock.calls[0][0]).toMatchObject({ body: "Shortcut comment" });
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.text).toBe(
      "Private unfinished agent prompt",
    );
  });
  it("lets the widget grow with discussions and keeps the composer outside the list scroller", async () => {
    const data = detail();
    const { slot } = await setup({ detail: () => data });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    const input = await slot.findByLabelText("New discussion");
    const dialog = slot.getByRole("dialog");
    const list = slot.getByLabelText("Discussion threads");
    const scroller = list.parentElement!;
    const composer = input.closest("form")!;
    expect(dialog.classList.contains("multiplayer-widget-dialog")).toBe(true);
    expect(dialog.className).not.toContain("640px");
    expect(scroller.classList.contains("multiplayer-widget-comments")).toBe(
      true,
    );
    expect(scroller.className).not.toContain("max-h-56");
    expect(scroller.contains(composer)).toBe(false);
    expect(composer.classList.contains("multiplayer-widget-composer")).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "Keep while content grows" } });
    data.comments.push({
      ...data.comments[0],
      id: "99999999-9999-4999-8999-999999999999",
      body: "A newly synced discussion",
      createdAt: 100,
    });
    await slot.behavior.emitRealtime("changed", null);
    await slot.findByText("A newly synced discussion");
    expect(slot.getByLabelText("New discussion")).toBe(input);
    expect((input as HTMLTextAreaElement).value).toBe(
      "Keep while content grows",
    );
    expect(slot.inspection.composer.submits).toEqual([]);
  });
  it("uses the same content-sized layout for an empty discussion without forcing a height", async () => {
    const { slot } = await setup({
      detail: () => ({ ...detail(), comments: [] }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: /Team discussion/ }),
    );
    await slot.findByLabelText("New discussion");
    expect(slot.getByRole("dialog").style.height).toBe("");
    expect(slot.getByText(/Use Discuss with team on a message/)).toBeTruthy();
    expect(slot.getByLabelText("Discussion threads").children).toHaveLength(0);
  });
  it("clamps dragged widget bounds to the viewport", () => {
    expect(
      clampWidgetPosition(
        { x: -40, y: 1000 },
        { width: 420, height: 640 },
        { width: 1200, height: 800 },
      ),
    ).toEqual({ x: 8, y: 152 });
    expect(
      clampWidgetPosition(
        { x: 900, y: -100 },
        { width: 420, height: 640 },
        { width: 360, height: 500 },
      ),
    ).toEqual({ x: 8, y: 8 });
  });
});
