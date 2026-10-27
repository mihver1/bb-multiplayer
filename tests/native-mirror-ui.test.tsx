// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  OpenNativeMirror,
  NativeMirrorBanner,
} from "../components/native-mirror";

afterEach(cleanup);
it("requires explicit enablement and machine selection before creating a native view", async () => {
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
it("refreshes an existing mirror rather than duplicating it", async () => {
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
    slot.inspection.rpcCalls.some((c) => c.method === "openNativeMirror"),
  ).toBe(false);
});
it("does not activate a mirror when the feature is disabled", async () => {
  const slot = renderSlot(
    { component: OpenNativeMirror },
    { sharedId: "shared", projectId: "proj_b" },
    { rpc: { nativeMirrorOptions: () => ({ enabled: false, mirrors: [] }) } },
  );
  await slot.findByText(/Native view is experimental/);
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
    options: { subPath: "project/proj_b/thread/shared" },
  });
});
