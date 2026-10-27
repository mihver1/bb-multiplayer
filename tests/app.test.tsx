// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { z } from "zod";
import type { rpcContract } from "../server";
import {
  consumeDiscussionRequest,
  useDiscussionRequest,
  type DiscussionRequest,
} from "../lib/discussion-target";

const roomId = "11111111-1111-4111-8111-111111111111",
  memberId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333",
  commentId = "44444444-4444-4444-8444-444444444444";
function status(): z.infer<typeof rpcContract.status.output> {
  const member = {
    id: memberId,
    name: "Alice",
    role: "owner" as const,
    lastSeenAt: Date.now(),
    revoked: false,
  };
  return {
    connection: {
      url: "http://127.0.0.1:4789",
      roomId,
      memberId,
      projectId: "proj_a",
    },
    identity: { room: { id: roomId, name: "Team" }, member, members: [member] },
    projects: [{ id: "proj_a", name: "App" }],
    threads: [],
    threadsTruncated: false,
    online: true,
    error: null,
    lastSyncAt: Date.now(),
  };
}
afterEach(cleanup);
describe("BB UI contracts", () => {
  it("registers team, legacy panel and a message action that targets the overlay", async () => {
    const app = await loadPluginApp(() => import("../app"));
    expect(app.navPanels[0].id).toBe("team");
    expect(app.messageActions[0].id).toBe("comment");
    const calls: unknown[] = [];
    await app.messageActions[0].run({
      threadId: "thr_a",
      message: {
        id: "msg_1",
        threadId: "thr_a",
        role: "assistant",
        text: "Plan",
        sourceSeqEnd: 1,
        experimental_messageSeq: 1,
      },
      composer: null,
      selectedText: "Plan",
      openPanel: (input) => {
        calls.push(input);
        return true;
      },
    });
    expect(calls).toEqual([]);
    let observed: DiscussionRequest | null = null;
    function InspectRequest() {
      observed = useDiscussionRequest();
      return null;
    }
    const inspector = renderSlot({ component: InspectRequest }, {});
    expect(observed).toMatchObject({
      threadId: "thr_a",
      target: { quote: "Plan" },
    });
    await act(async () => consumeDiscussionRequest(observed!.requestId));
    expect(inspector.inspection.navigateCalls).toEqual([]);
    inspector.lifecycle.unmount();
  });
  it("shows explicit opt-in onboarding and keeps credentials out of navigation state", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          status: () => ({ ...status(), connection: null, identity: null }),
          connect: () => ({ ok: true }),
        },
      },
    );
    await slot.findByText("Your own BB. One team context.");
    fireEvent.change(slot.getByLabelText("Your name"), {
      target: { value: "Bob" },
    });
    fireEvent.change(slot.getByLabelText("Invitation code"), {
      target: { value: "one-use-test-invite" },
    });
    fireEvent.click(slot.getByText("Connect project"));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "connect")).toBe(
        true,
      ),
    );
    expect(slot.inspection.navigateCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("adds selected feedback to the local composer without submitting it", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.threadPanelActions[0],
      { threadId: "thr_a", params: null },
      {
        context: { threadId: "thr_a", projectId: "proj_a" },
        rpc: {
          status,
          localThread: () => ({
            sharedId: threadId,
            sharing: true,
            connectedProject: true,
          }),
          thread: () => ({
            thread: {
              id: threadId,
              revision: 1,
              title: "Local shared plan",
              status: "idle",
              ownerId: memberId,
              updatedAt: 1,
              historyTruncated: false,
              messages: [],
            },
            comments: [
              {
                id: commentId,
                threadId,
                authorId: memberId,
                parentId: null,
                anchor: null,
                body: "Add tests",
                createdAt: 2,
                resolved: false,
                version: 1,
              },
            ],
            commentsTruncated: false,
            localId: "thr_a",
            sharing: true,
          }),
          feedback: () => ({ text: "Review team feedback: Add tests" }),
        },
      },
    );
    await slot.findByText("Add tests");
    fireEvent.click(slot.getByLabelText("Select comment by Alice"));
    fireEvent.click(slot.getByRole("button", { name: "Add 1 to agent draft" }));
    await slot.findByText(
      "Feedback added to your draft. Review it and press Send when ready; no agent was started.",
    );
    expect(slot.inspection.composer.text).toContain("Add tests");
    expect(slot.inspection.sdkCalls).toEqual([]);
    slot.lifecycle.unmount();
  });
  it("renders a shared remote thread as read-only and comments as plain text", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: `thread/${threadId}` },
      {
        rpc: {
          status,
          thread: () => ({
            thread: {
              id: threadId,
              revision: 1,
              title: "Shared plan",
              status: "idle",
              ownerId: memberId,
              updatedAt: 1,
              historyTruncated: false,
              messages: [
                {
                  id: "msg_1",
                  role: "assistant",
                  text: "<script>alert('no')</script>",
                  version: "a".repeat(64),
                  createdAt: 1,
                  truncated: false,
                },
              ],
            },
            comments: [],
            commentsTruncated: false,
            localId: null,
            sharing: false,
          }),
        },
      },
    );
    await slot.findByText("Shared plan");
    expect(slot.getByText("<script>alert('no')</script>")).toBeTruthy();
    expect(
      slot.queryByRole("button", { name: /Add .* to agent draft/ }),
    ).toBeNull();
    expect(slot.queryByText("Open my local thread")).toBeNull();
    slot.lifecycle.unmount();
  });
});
