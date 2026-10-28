// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  OpenNativeMirror,
  NativeMirrorBanner,
} from "../components/native-mirror";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("requires machine selection when opening a native view manually", async () => {
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b" },
    {
      rpc: {
        nativeMirrorOptions: () => ({ enabled: true, mirrors: [] }),
        openNativeMirror: () => ({ threadId: "thr_native" }),
      },
      sdk: {
        hosts: {
          list: async () =>
            [
              { id: "host_a", name: "Laptop A" },
              { id: "host_b", name: "Laptop B" },
            ] as never,
        },
      },
    },
  );
  await slot.findByText("Laptop A");
  expect(
    (slot.getByText("Open native view") as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(slot.getByLabelText("Machine for native mirror"), {
    target: { value: "host_b" },
  });
  fireEvent.click(slot.getByText("Open native view"));
  await waitFor(() =>
    expect(slot.inspection.navigateCalls).toContainEqual({
      method: "toThread",
      threadId: "thr_native",
    }),
  );
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "openNativeMirror")
      ?.input,
  ).toEqual({ sharedId: "shared", hostId: "host_b", projectId: "proj_b" });
});
it("opens an existing mirror without waiting for a refresh or duplicating it", async () => {
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b" },
    {
      rpc: {
        nativeMirrorOptions: () => ({
          enabled: true,
          mirrors: [
            { sharedId: "shared", localId: "thr_native", active: true },
          ],
        }),
        refreshNativeMirror: () => ({ ok: true }),
      },
      sdk: { hosts: { list: async () => [] } },
    },
  );
  fireEvent.click(await slot.findByText("Open native view"));
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  expect(
    slot.inspection.rpcCalls.some((c) =>
      ["openNativeMirror", "refreshNativeMirror"].includes(c.method),
    ),
  ).toBe(false);
});
it("does not activate a mirror when the feature is disabled", async () => {
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b", autoOpen: true },
    { rpc: { nativeMirrorOptions: () => ({ enabled: false, mirrors: [] }) } },
  );
  await slot.findByText(/Native view is disabled/);
  expect(slot.inspection.sdkCalls).toEqual([]);
  expect(slot.queryByText("Open native view")).toBeNull();
});
it("labels the native composer as an owner proposal and never sends from a banner action", async () => {
  const slot = renderSlot(
    { component: NativeMirrorBanner },
    {},
    {
      composer: {
        scope: { kind: "thread", threadId: "thr_native" },
        text: "Keep draft",
      },
      rpc: {
        nativeMirrorState: () => ({
          enabled: true,
          isMirror: true,
          connected: true,
          sharedId: "shared",
          projectId: "proj_b",
          localId: "thr_native",
          ownerName: "Alice",
        }),
        refreshNativeMirror: () => ({ ok: true }),
      },
    },
  );
  await slot.findByText(/Sending proposes your text to the owner/);
  fireEvent.click(slot.getByText("Refresh shared preview"));
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.some((c) => c.method === "refreshNativeMirror"),
    ).toBe(true),
  );
  expect(slot.inspection.composer.text).toBe("Keep draft");
  expect(slot.inspection.composer.submits).toEqual([]);
  fireEvent.click(slot.getByText("Open source & discussions"));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel",
    path: "team",
    options: { subPath: "project/proj_b/thread/shared/source" },
  });
});

it("auto-opens the native view once with a single machine and reuses an existing mirror", async () => {
  for (const existing of [false, true]) {
    const slot = renderSlot(
      { component: OpenNativeMirror },
      { sharedId: "shared", projectId: "proj_b", autoOpen: true },
      {
        rpc: {
          nativeMirrorOptions: () => ({
            enabled: true,
            mirrors: existing
              ? [{ sharedId: "shared", localId: "thr_native", active: true }]
              : [],
          }),
          openNativeMirror: () => ({ threadId: "thr_native" }),
        },
        sdk: {
          hosts: {
            list: async () => [{ id: "host_a", name: "Laptop" }] as never,
          },
        },
      },
    );
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "toThread", threadId: "thr_native" },
      ]),
    );
    await slot.behavior.emitRealtime("changed", null);
    expect(slot.inspection.navigateCalls).toHaveLength(1);
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "openNativeMirror"),
    ).toHaveLength(existing ? 0 : 1);
    slot.lifecycle.unmount();
  }
});

it("waits for a machine choice when there are several, then auto-opens", async () => {
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b", autoOpen: true },
    {
      rpc: {
        nativeMirrorOptions: () => ({ enabled: true, mirrors: [] }),
        openNativeMirror: () => ({ threadId: "thr_native" }),
      },
      sdk: {
        hosts: {
          list: async () =>
            [
              { id: "host_a", name: "Laptop A" },
              { id: "host_b", name: "Laptop B" },
            ] as never,
        },
      },
    },
  );
  await slot.findByText("Laptop B");
  expect(slot.inspection.navigateCalls).toEqual([]);
  expect(
    slot.inspection.rpcCalls.some((c) => c.method === "openNativeMirror"),
  ).toBe(false);
  fireEvent.change(slot.getByLabelText("Machine for native mirror"), {
    target: { value: "host_b" },
  });
  await waitFor(() => expect(slot.inspection.navigateCalls).toHaveLength(1));
  expect(
    slot.inspection.rpcCalls.find((c) => c.method === "openNativeMirror")
      ?.input,
  ).toEqual({ sharedId: "shared", projectId: "proj_b", hostId: "host_b" });
});

it("does not auto-retry failed creation on signals or navigate after leaving the view", async () => {
  let finish!: (value: { threadId: string }) => void;
  let fail = true;
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b", autoOpen: true },
    {
      rpc: {
        nativeMirrorOptions: () => ({ enabled: true, mirrors: [] }),
        openNativeMirror: () => {
          if (fail) throw new Error("Mirror creation needs recovery");
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      sdk: {
        hosts: {
          list: async () => [{ id: "host_a", name: "Laptop" }] as never,
        },
      },
    },
  );
  await slot.findByRole("alert");
  await slot.behavior.emitRealtime("changed", null);
  expect(
    slot.inspection.rpcCalls.filter((c) => c.method === "openNativeMirror"),
  ).toHaveLength(1);
  fail = false;
  fireEvent.click(slot.getByText("Open native view"));
  slot.lifecycle.unmount();
  await act(async () => finish({ threadId: "thr_late" }));
  expect(slot.inspection.navigateCalls).toEqual([]);
});

const mirrorState = {
  enabled: true,
  isMirror: true,
  connected: true,
  sharedId: "shared",
  projectId: "proj_b",
  localId: "thr_native",
  ownerName: "Alice",
};
function renderBanner(
  refresh: () => unknown = () => ({ ok: true }),
  state = () => mirrorState,
) {
  return renderSlot(
    { component: NativeMirrorBanner },
    {},
    {
      composer: {
        scope: { kind: "thread", threadId: "thr_native" },
        text: "Keep draft",
      },
      rpc: { nativeMirrorState: state, refreshNativeMirror: refresh },
    },
  );
}
const syncCalls = (slot: ReturnType<typeof renderBanner>) =>
  slot.inspection.rpcCalls.filter((c) => c.method === "refreshNativeMirror");

it("syncs on mount and every two seconds, coalesces realtime signals, and stops on unmount", async () => {
  vi.useFakeTimers();
  const slot = renderBanner();
  await act(async () => {});
  expect(syncCalls(slot).map((c) => c.input)).toEqual([
    { threadId: "thr_native", onlyIfChanged: true },
  ]);
  await slot.behavior.emitRealtime("changed", null);
  await slot.behavior.emitRealtime("changed", null);
  expect(syncCalls(slot)).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(syncCalls(slot)).toHaveLength(2);
  expect(slot.inspection.composer.text).toBe("Keep draft");
  expect(slot.inspection.composer.submits).toEqual([]);
  slot.lifecycle.unmount();
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(syncCalls(slot)).toHaveLength(2);
});

it("stops polling immediately when the current mirror is disabled or disconnected", async () => {
  vi.useFakeTimers();
  let connected = true;
  const slot = renderBanner(undefined, () => ({ ...mirrorState, connected }));
  await act(async () => {});
  expect(syncCalls(slot)).toHaveLength(1);
  connected = false;
  await slot.behavior.emitRealtime("changed", null);
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(syncCalls(slot)).toHaveLength(1);
  connected = true;
  await slot.behavior.emitRealtime("changed", null);
  expect(syncCalls(slot)).toHaveLength(2);
});

it("never overlaps sync requests and recovers after a failed request", async () => {
  vi.useFakeTimers();
  let finish!: (value: { ok: boolean }) => void;
  let slow = true;
  const slot = renderBanner(() => {
    if (slow)
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw new Error("Temporarily offline");
  });
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  await slot.behavior.emitRealtime("changed", null);
  expect(syncCalls(slot)).toHaveLength(1);
  slow = false;
  await act(async () => finish({ ok: true }));
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(slot.getByRole("alert").textContent).toBe("Temporarily offline");
  expect(syncCalls(slot)).toHaveLength(2);
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(syncCalls(slot)).toHaveLength(3);
});

it("pauses hidden or disconnected views and syncs immediately on visibility/reconnect", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const slot = renderBanner();
  await act(async () => {});
  hidden.mockReturnValue(true);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(syncCalls(slot)).toHaveLength(1);
  hidden.mockReturnValue(false);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {});
  expect(syncCalls(slot)).toHaveLength(2);
  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(syncCalls(slot)).toHaveLength(2);
  await slot.behavior.setRealtimeConnectionState("connected");
  expect(syncCalls(slot)).toHaveLength(3);
});

it.each(["enabled", "connected", "isMirror"] as const)(
  "does not sync when %s is false",
  async (field) => {
    vi.useFakeTimers();
    const slot = renderBanner(undefined, () => ({
      ...mirrorState,
      [field]: false,
    }));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    await slot.behavior.emitRealtime("changed", null);
    expect(syncCalls(slot)).toEqual([]);
  },
);

it("stops the old thread's polling when the composer scope changes", async () => {
  vi.useFakeTimers();
  const slot = renderBanner();
  await act(async () => {});
  await slot.behavior.setComposerScope({
    kind: "thread",
    threadId: "thr_other",
  });
  await act(async () => vi.advanceTimersByTimeAsync(4000));
  expect(
    syncCalls(slot).filter(
      (c) => (c.input as { threadId: string }).threadId === "thr_native",
    ),
  ).toHaveLength(1);
  expect(syncCalls(slot).at(-1)?.input).toEqual({
    threadId: "thr_other",
    onlyIfChanged: true,
  });
});
