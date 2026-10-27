// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  MessageRequestComposer,
  OwnerRequestBanner,
  OwnerRequestInbox,
} from "../components/message-requests";
import { toast } from "sonner";
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));
const id = "11111111-1111-4111-8111-111111111111",
  threadId = "22222222-2222-4222-8222-222222222222",
  ownerId = "33333333-3333-4333-8333-333333333333",
  authorId = "44444444-4444-4444-8444-444444444444";
const request = {
  id,
  threadId,
  ownerId,
  authorId,
  body: "Add tests",
  status: "pending",
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  localThreadId: "thr_owner",
  threadTitle: "Task",
};
const state = () => ({
  projectId: "proj_a",
  supported: true,
  online: true,
  memberId: ownerId,
  members: [
    {
      id: authorId,
      name: "Bob",
      role: "member",
      revoked: false,
      lastSeenAt: 1,
    },
  ],
  requests: [request],
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("adds a reviewed request only to the matching owner draft; does not submit", async () => {
  const review = vi.fn(() => ({ ...request, status: "drafted" }));
  const slot = renderSlot(
    { component: OwnerRequestBanner },
    {},
    {
      composer: {
        scope: { kind: "thread", threadId: "thr_owner" },
        text: "Existing draft",
      },
      rpc: {
        requestState: state,
        requestDraft: () => ({
          threadId: "thr_owner",
          text: "Untrusted proposal: Add tests",
          version: 1,
        }),
        reviewRequest: review,
      },
    },
  );
  fireEvent.click(await slot.findByText("Add to my draft"));
  await waitFor(() => expect(review).toHaveBeenCalledOnce());
  expect(slot.inspection.composer.text).toContain("Existing draft");
  expect(slot.inspection.composer.text).toContain("Add tests");
  expect(slot.inspection.composer.submits).toEqual([]);
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "requestState")?.input,
  ).toEqual({ threadId: "thr_owner" });
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "requestDraft")?.input,
  ).toEqual({ id, projectId: "proj_a" });
});
it("rejects a draft response targeting another composer", async () => {
  const review = vi.fn();
  const slot = renderSlot(
    { component: OwnerRequestBanner },
    {},
    {
      composer: {
        scope: { kind: "thread", threadId: "thr_owner" },
        text: "Untouched",
      },
      rpc: {
        requestState: state,
        requestDraft: () => ({
          threadId: "thr_other",
          text: "Wrong",
          version: 1,
        }),
        reviewRequest: review,
      },
    },
  );
  fireEvent.click(await slot.findByText("Add to my draft"));
  await slot.findByText(/owning composer changed/);
  expect(review).not.toHaveBeenCalled();
  expect(slot.inspection.composer.text).toBe("Untouched");
});
it("does not insert twice after a review acknowledgement failure in the mounted composer", async () => {
  let n = 0;
  const slot = renderSlot(
    { component: OwnerRequestBanner },
    {},
    {
      composer: { scope: { kind: "thread", threadId: "thr_owner" } },
      rpc: {
        requestState: state,
        requestDraft: () => ({
          threadId: "thr_owner",
          text: "Unique proposal",
          version: 1,
        }),
        reviewRequest: () => {
          if (!n++) throw new Error("Lost acknowledgement");
          return { ...request, status: "drafted" };
        },
      },
    },
  );
  fireEvent.click(await slot.findByText("Add to my draft"));
  await slot.findByText("Lost acknowledgement");
  fireEvent.click(slot.getByText("Confirm added to draft"));
  await waitFor(() => expect(n).toBe(2));
  expect(slot.inspection.composer.text.match(/Unique proposal/g)).toHaveLength(
    1,
  );
});
it("notifies for requests in every project, even with identical remote IDs", async () => {
  let requests: {
    projectId: string;
    memberId: string;
    id: string;
    authorName: string;
    threadTitle: string;
    localThreadId: string;
  }[] = [];
  const slot = renderSlot(
    { component: OwnerRequestInbox },
    {},
    { rpc: { requestInbox: () => ({ requests }) } },
  );
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "requestInbox"),
    ).toBe(true),
  );
  requests = ["a", "b"].map((suffix) => ({
    projectId: `proj_${suffix}`,
    memberId: ownerId,
    id,
    authorName: `Author ${suffix}`,
    threadTitle: `Task ${suffix}`,
    localThreadId: `thr_${suffix}`,
  }));
  await slot.behavior.emitRealtime("changed", null);
  await waitFor(() => expect(toast.info).toHaveBeenCalledTimes(2));
  const notices = vi.mocked(toast.info).mock.calls;
  expect(notices.map((call) => call[0])).toEqual([
    "Author a proposes a message in Task a",
    "Author b proposes a message in Task b",
  ]);
  const action = notices[1][1]?.action;
  if (!action || typeof action !== "object" || !("onClick" in action))
    throw new Error("Missing review action");
  action.onClick({} as never);
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({
    method: "toThread",
    threadId: "thr_b",
  });
  await slot.behavior.emitRealtime("changed", null);
  expect(toast.info).toHaveBeenCalledTimes(2);
});

it("sends a remote proposal, not a native agent message", async () => {
  const propose = vi.fn((_input: unknown) => request);
  const slot = renderSlot(
    { component: MessageRequestComposer },
    { sharedId: threadId, projectId: "proj_a", ownerName: "Alice" },
    {
      rpc: {
        requestState: () => ({ ...state(), memberId: authorId, requests: [] }),
        proposeMessage: propose,
      },
    },
  );
  await waitFor(() =>
    expect(
      (slot.getByText("Request owner's review") as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  fireEvent.change(slot.getByLabelText("Proposed message"), {
    target: { value: "Please add tests" },
  });
  await waitFor(() =>
    expect(
      (slot.getByText("Request owner's review") as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(slot.getByText("Request owner's review"));
  await waitFor(() => expect(propose).toHaveBeenCalledOnce());
  expect(propose.mock.calls[0][0]).toMatchObject({
    threadId,
    projectId: "proj_a",
    body: "Please add tests",
  });
  expect(slot.inspection.sdkCalls).toEqual([]);
  expect(slot.inspection.composer.submits).toEqual([]);
});
