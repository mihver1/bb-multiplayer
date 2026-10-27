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
    projectId: "proj_a",
    connections: [
      { url: "http://127.0.0.1:4789", roomId, memberId, projectId: "proj_a" },
    ],
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
          status: () => ({
            ...status(),
            connections: [],
            connection: null,
            identity: null,
          }),
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
  it("creates a new room from the UI using the saved owner connection without exposing credentials", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const base = status();
    let connected = false;
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "project/proj_b" },
      {
        rpc: {
          status: () => ({
            ...base,
            projectId: "proj_b",
            projects: [...base.projects, { id: "proj_b", name: "Billing" }],
            connection: connected
              ? { ...base.connection!, projectId: "proj_b" }
              : null,
            identity: connected
              ? {
                  ...base.identity!,
                  room: { id: roomId, name: "Billing team" },
                }
              : null,
          }),
          roomCreationOptions: () => ({
            pending: null,
            sources: [
              {
                projectId: "proj_a",
                url: "https://relay.example",
                roomName: "Existing team",
                ownerName: "Alice",
              },
            ],
          }),
          createRoom: () => {
            connected = true;
            return { ok: true };
          },
        },
      },
    );
    fireEvent.click(await slot.findByText("Create new room"));
    const roomName = await slot.findByLabelText("Room name");
    expect((roomName as HTMLInputElement).value).toBe("Billing");
    expect(slot.queryByLabelText("Invitation code")).toBeNull();
    expect(slot.queryByLabelText("Member credential")).toBeNull();
    fireEvent.change(roomName, { target: { value: "Billing team" } });
    fireEvent.click(slot.getByText("Create room and connect"));
    await slot.findByText("Billing team");
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "createRoom")?.input,
    ).toEqual({
      projectId: "proj_b",
      sourceProjectId: "proj_a",
      name: "Billing team",
    });
    expect(
      slot.inspection.rpcCalls.some((c) =>
        ["connect", "share", "disconnect"].includes(c.method),
      ),
    ).toBe(false);
  });

  it("does not submit duplicate creation requests or switch credential mode while creating", async () => {
    const app = await loadPluginApp(() => import("../app"));
    let finish!: (value: { ok: boolean }) => void;
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          status: () => ({ ...status(), connection: null, identity: null }),
          roomCreationOptions: () => ({
            pending: null,
            sources: [
              {
                projectId: "proj_source",
                url: "https://relay.example",
                roomName: "Original",
                ownerName: "Alice",
              },
            ],
          }),
          createRoom: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
      },
    );
    fireEvent.click(await slot.findByText("Create new room"));
    const form = await slot.findByRole("form", {
      name: "Create a project room",
    });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((c) => c.method === "createRoom"),
      ).toHaveLength(1),
    );
    expect(
      (slot.getByText("Use member credential") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (slot.getByLabelText("Room name") as HTMLInputElement).disabled,
    ).toBe(true);
    await act(async () => finish({ ok: true }));
  });

  it("recovers a pending creation after opening the page and preserves the original input", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const base = status();
    const pending = {
      requestId: threadId,
      sourceProjectId: "proj_a",
      sourceMemberId: memberId,
      sourceRoomId: roomId,
      url: "https://relay.example",
      name: "Saved creation",
    };
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "project/proj_b" },
      {
        rpc: {
          status: () => ({
            ...base,
            connection: null,
            identity: null,
            projects: [...base.projects, { id: "proj_b", name: "Billing" }],
          }),
          roomCreationOptions: () => ({
            pending,
            sources: [
              {
                projectId: "proj_a",
                url: pending.url,
                roomName: "Original",
                ownerName: "Alice",
              },
            ],
          }),
          createRoom: () => {
            throw new Error("Network unavailable");
          },
        },
      },
    );
    const retry = await slot.findByText("Retry room creation");
    expect(
      (slot.getByLabelText("Room name") as HTMLInputElement).disabled,
    ).toBe(true);
    expect((slot.getByLabelText("Room name") as HTMLInputElement).value).toBe(
      "Saved creation",
    );
    expect(
      (slot.getByText("Use member credential") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(retry);
    await slot.findByText("Network unavailable");
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "createRoom")?.input,
    ).toEqual({
      projectId: "proj_b",
      sourceProjectId: "proj_a",
      name: "Saved creation",
    });
  });

  it("explains that a room owner connection is required instead of offering anonymous creation", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        rpc: {
          status: () => ({
            ...status(),
            connection: null,
            identity: null,
            connections: [],
          }),
          roomCreationOptions: () => ({ pending: null, sources: [] }),
        },
      },
    );
    fireEvent.click(await slot.findByText("Create new room"));
    await slot.findByText(/Connect as a room owner first/);
    expect(slot.queryByText("Create room and connect")).toBeNull();
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "createRoom"),
    ).toBe(false);
  });

  it("switches project rooms and scopes every administrative action to the selection", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const base = status();
    const connections = [
      base.connection!,
      {
        ...base.connection!,
        projectId: "proj_b",
        roomId: "55555555-5555-4555-8555-555555555555",
      },
    ];
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "" },
      {
        context: { projectId: "proj_a", threadId: null },
        rpc: {
          status: (input) => {
            const projectId =
              (input as { projectId?: string } | null)?.projectId ?? "proj_a";
            const connection =
              connections.find((c) => c.projectId === projectId) ?? null;
            return {
              ...base,
              projectId,
              connection,
              connections: [...connections],
              projects: [
                { id: "proj_a", name: "App" },
                { id: "proj_b", name: "Billing" },
              ],
              identity: connection
                ? {
                    ...base.identity!,
                    room: {
                      id: connection.roomId,
                      name: projectId === "proj_a" ? "Room A" : "Room B",
                    },
                  }
                : null,
            };
          },
          invite: () => ({
            code: "test-invitation-only",
            expiresAt: Date.now() + 1000,
          }),
          disconnect: (input) => {
            connections.splice(
              connections.findIndex(
                (c) =>
                  c.projectId === (input as { projectId: string }).projectId,
              ),
              1,
            );
            return { ok: true };
          },
        },
      },
    );
    await slot.findByText("Room A");
    fireEvent.click(slot.getByText("Invite teammate"));
    await slot.findByLabelText("Invitation code");
    fireEvent.change(slot.getByLabelText("Team project"), {
      target: { value: "proj_b" },
    });
    await slot.findByText("Room B");
    expect(slot.queryByLabelText("Invitation code")).toBeNull();
    fireEvent.click(slot.getByText("Invite teammate"));
    await slot.findByLabelText("Invitation code");
    expect(
      slot.inspection.rpcCalls
        .filter((c) => c.method === "invite")
        .map((c) => c.input),
    ).toEqual([{ projectId: "proj_a" }, { projectId: "proj_b" }]);
    fireEvent.click(slot.getByText("Disconnect"));
    fireEvent.click(await slot.findByText("Disconnect and clear local cache"));
    await slot.findByText("Connect project");
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "disconnect")?.input,
    ).toEqual({ projectId: "proj_b" });
    expect(connections.map((c) => c.projectId)).toEqual(["proj_a"]);
    expect(
      slot.queryByLabelText("Invitation code")?.getAttribute("value"),
    ).not.toBe("test-invitation-only");
  });

  it("connects a second project from the selector without disconnecting the first", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const base = status();
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: "project/proj_a" },
      {
        rpc: {
          status: (input) => {
            const selected = (input as { projectId?: string } | null)
              ?.projectId;
            return {
              ...base,
              projects: [
                { id: "proj_a", name: "App" },
                { id: "proj_b", name: "Billing" },
              ],
              ...(selected === "proj_b"
                ? { projectId: "proj_b", connection: null, identity: null }
                : {}),
            };
          },
          connect: () => ({ ok: true }),
        },
      },
    );
    await slot.findByText("Team");
    fireEvent.change(slot.getByLabelText("Team project"), {
      target: { value: "proj_b" },
    });
    fireEvent.change(await slot.findByLabelText("Your name"), {
      target: { value: "Billing teammate" },
    });
    fireEvent.change(slot.getByLabelText("Invitation code"), {
      target: { value: "test-only-invitation" },
    });
    fireEvent.click(slot.getByText("Connect project"));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.some((c) => c.method === "connect")).toBe(
        true,
      ),
    );
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "connect")?.input,
    ).toMatchObject({ projectId: "proj_b", displayName: "Billing teammate" });
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "disconnect"),
    ).toBe(false);
  });

  it("opens project-qualified remote links and refuses ambiguous legacy links", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const base = status();
    const multi = {
      ...base,
      connections: [
        base.connection!,
        { ...base.connection!, projectId: "proj_b" },
      ],
    };
    const legacy = renderSlot(
      app.navPanels[0],
      { subPath: `thread/${threadId}` },
      { rpc: { status: () => multi } },
    );
    await legacy.findByText(/Select the project and open/);
    expect(legacy.inspection.rpcCalls.some((c) => c.method === "thread")).toBe(
      false,
    );
    legacy.lifecycle.unmount();
    const slot = renderSlot(
      app.navPanels[0],
      { subPath: `project/proj_b/thread/${threadId}` },
      {
        rpc: {
          status: () => multi,
          thread: () => ({
            thread: {
              id: threadId,
              revision: 1,
              title: "B scoped",
              status: "idle",
              ownerId: memberId,
              updatedAt: 1,
              historyTruncated: false,
              messages: [],
            },
            comments: [],
            commentsTruncated: false,
            localId: null,
            sharing: false,
          }),
        },
      },
    );
    await slot.findByText("B scoped");
    expect(
      slot.inspection.rpcCalls.find((c) => c.method === "thread")?.input,
    ).toEqual({ id: threadId, projectId: "proj_b" });
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
          discussionContext: () => ({
            ...status(),
            threadTitle: "Local shared plan",
            commentCount: 1,
            openCount: 1,
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
