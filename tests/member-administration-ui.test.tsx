// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { MemberAdministration } from "../components/member-administration";
import type { Identity } from "../shared/protocol";

const ownerId = "11111111-1111-4111-8111-111111111111",
  memberId = "22222222-2222-4222-8222-222222222222";
function identity(): Identity {
  const owner = {
    id: ownerId,
    role: "owner" as const,
    name: "Alice",
    lastSeenAt: Date.now(),
    revoked: false,
  };
  return {
    room: { id: "33333333-3333-4333-8333-333333333333", name: "Team" },
    member: owner,
    members: [
      owner,
      {
        id: memberId,
        role: "member",
        admin: false,
        name: "Bob",
        lastSeenAt: Date.now(),
        revoked: false,
      },
    ],
    capabilities: { memberAdministration: true },
  };
}
afterEach(cleanup);

it.each([false, true])(
  "confirms explicit appointment/removal with project scope (currently admin=%s)",
  async (admin) => {
    const value = identity();
    value.members[1].admin = admin;
    const refresh = vi.fn();
    const slot = renderSlot(
      { component: MemberAdministration },
      {
        projectId: "proj_a",
        identity: value,
        online: true,
        onChanged: refresh,
      },
      {
        rpc: { setMemberAdmin: () => ({ ok: true }) },
      },
    );
    fireEvent.click(
      slot.getByRole("button", {
        name: admin
          ? "Remove administrator rights from Bob"
          : "Make administrator: Bob",
      }),
    );
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(slot.getByText(/They own rooms they create/)).toBeTruthy();
    fireEvent.click(
      slot.getByRole("button", {
        name: admin ? "Confirm removal" : "Confirm appointment",
      }),
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(slot.inspection.rpcCalls).toEqual([
      {
        method: "setMemberAdmin",
        input: { projectId: "proj_a", memberId, admin: !admin },
      },
    ]);
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.sdkCalls).toEqual([]);
  },
);
it("sends only one mutation while an administrator change is in flight", async () => {
  let finish!: (value: { ok: boolean }) => void;
  const call = vi.fn(
    () =>
      new Promise<{ ok: boolean }>((resolve) => {
        finish = resolve;
      }),
  );
  const slot = renderSlot(
    { component: MemberAdministration },
    {
      projectId: "proj_a",
      identity: identity(),
      online: true,
      onChanged: vi.fn(),
    },
    { rpc: { setMemberAdmin: call } },
  );
  fireEvent.click(
    slot.getByRole("button", { name: "Make administrator: Bob" }),
  );
  const confirm = slot.getByText("Confirm appointment");
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await waitFor(() => expect(call).toHaveBeenCalledOnce());
  expect((confirm as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish({ ok: true }));
});

it("does not grant on cancel, and retains confirmation/error for safe retry", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("Lost acknowledgement"))
    .mockResolvedValue({ ok: true });
  const slot = renderSlot(
    { component: MemberAdministration },
    {
      projectId: "proj_a",
      identity: identity(),
      online: true,
      onChanged: vi.fn(),
    },
    { rpc: { setMemberAdmin: call } },
  );
  fireEvent.click(
    slot.getByRole("button", { name: "Make administrator: Bob" }),
  );
  fireEvent.click(slot.getByText("Cancel"));
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(
    slot.getByRole("button", { name: "Make administrator: Bob" }),
  );
  fireEvent.click(slot.getByText("Confirm appointment"));
  await slot.findByText("Lost acknowledgement");
  fireEvent.click(slot.getByText("Confirm appointment"));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  expect(call.mock.calls[0][0]).toEqual(call.mock.calls[1][0]);
});
it.each(["member", "admin", "revoked-owner"])(
  "hides management for %s",
  (role) => {
    const value = identity();
    value.member =
      role === "revoked-owner"
        ? { ...value.member, revoked: true }
        : { ...value.members[1], admin: role === "admin" };
    const slot = renderSlot(
      { component: MemberAdministration },
      {
        projectId: "proj_a",
        identity: value,
        online: true,
        onChanged: vi.fn(),
      },
    );
    expect(
      slot.queryByRole("region", { name: "Administrator management" }),
    ).toBeNull();
    expect(slot.inspection.rpcCalls).toEqual([]);
  },
);
it("protects owners/revoked members, disables offline actions and explains older relay support", () => {
  const value = identity();
  value.members[1].revoked = true;
  const slot = renderSlot(
    { component: MemberAdministration },
    { projectId: "proj_a", identity: value, online: true, onChanged: vi.fn() },
  );
  expect(slot.queryByRole("button")).toBeNull();
  slot.lifecycle.unmount();
  const offline = renderSlot(
    { component: MemberAdministration },
    {
      projectId: "proj_a",
      identity: identity(),
      online: false,
      onChanged: vi.fn(),
    },
  );
  expect(
    (
      offline.getByRole("button", {
        name: "Make administrator: Bob",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  offline.lifecycle.unmount();
  const old = identity();
  delete old.capabilities;
  const legacy = renderSlot(
    { component: MemberAdministration },
    { projectId: "proj_a", identity: old, online: true, onChanged: vi.fn() },
  );
  expect(legacy.getByText(/Upgrade the relay/)).toBeTruthy();
  expect(legacy.queryByRole("button")).toBeNull();
});
it("shows an administrator badge and integrates owner controls on the Multiplayer page", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const value = identity();
  value.members[1].admin = true;
  const connection = {
    projectId: "proj_a",
    url: "https://relay.example",
    roomId: value.room.id,
    memberId: ownerId,
  };
  const slot = renderSlot(
    app.navPanels[0],
    { subPath: "project/proj_a" },
    {
      rpc: {
        status: () => ({
          projectId: "proj_a",
          connection,
          connections: [connection],
          identity: value,
          projects: [{ id: "proj_a", name: "A" }],
          threads: [],
          threadsTruncated: false,
          online: true,
          error: null,
          lastSyncAt: Date.now(),
        }),
      },
    },
  );
  await slot.findByText("Administrator");
  expect(
    slot.getByRole("button", { name: "Remove administrator rights from Bob" }),
  ).toBeTruthy();
});
