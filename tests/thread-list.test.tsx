// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { TeamThreadList } from "../components/team-thread-list";
const shared = "11111111-1111-4111-8111-111111111111";
const local: PluginSidebarThread = {
  id: "thr_local",
  projectId: "proj_a",
  title: "Local task",
  titleFallback: null,
  displayTitle: "Local task",
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  sectionId: null,
  originKind: null,
  originPluginId: null,
  providerId: "pi",
  status: "idle",
  runtimeStatus: "idle",
  queuedWork: "none",
  hasPendingInteraction: false,
  activity: {
    workflows: 0,
    backgroundAgents: 0,
    backgroundCommands: 0,
    planMode: 0,
    goals: 0,
  },
  indicator: "none",
  indicatorLabel: null,
  isUnread: false,
  isPinned: false,
  pinnedAt: null,
  pinSortKey: null,
  isArchived: false,
  archivedAt: null,
  href: "/projects/proj_a/threads/thr_local",
  isHidden: false,
  environment: null,
  host: null,
  createdAt: 1,
  updatedAt: 1,
  lastReadAt: null,
  latestAttentionAt: 1,
};
const team = () => ({
  projectId: "proj_a",
  online: false,
  identity: null,
  truncated: false,
  threads: [
    {
      id: shared,
      title: "Remote task",
      status: "active",
      ownerId: "22222222-2222-4222-8222-222222222222",
      revision: 1,
      updatedAt: 1,
      historyTruncated: false,
      localId: null,
      sharing: false,
    },
  ],
});
const props = {
  activeThreadId: "thr_local",
  activeProjectId: "proj_a",
  isCompactViewport: false,
  onNavigate: vi.fn(),
  searchQuery: "",
};
const sidebar = {
  status: "ready" as const,
  threads: [local],
  projects: [
    {
      id: "proj_a",
      name: "Project A",
      isPersonal: false,
      href: "/projects/proj_a",
      settingsHref: "/projects/proj_a/settings",
    },
    {
      id: "proj_b",
      name: "Other",
      isPersonal: false,
      href: "/projects/proj_b",
      settingsHref: "/projects/proj_b/settings",
    },
  ],
  sections: [],
};
afterEach(cleanup);
it("shows local + remote rows in the connected project, native local navigation and safe remote view", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: sidebar,
    rpc: { teamThreads: team },
  });
  const remote = await slot.findByRole("button", {
    name: "Open shared thread Remote task",
  });
  expect(remote.closest("section")?.getAttribute("aria-label")).toBe(
    "Project A",
  );
  expect(slot.getByText("Teammate · last known: active")).toBeTruthy();
  fireEvent.click(remote);
  expect(slot.inspection.navigateCalls[0]).toEqual({
    method: "toPluginPanel",
    path: "team",
    options: { subPath: `thread/${shared}` },
  });
  const anchor = slot.container.querySelector(
    "[data-sidebar-thread-id=thr_local]",
  )!;
  fireEvent.click(anchor);
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({
    method: "toThread",
    threadId: "thr_local",
  });
  expect(props.onNavigate).toHaveBeenCalled();
});
it("does not duplicate shared local threads or expose hidden local threads as remote", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: { ...sidebar, threads: [{ ...local, isHidden: true }] },
    rpc: {
      teamThreads: () => ({
        ...team(),
        threads: team().threads.map((t) => ({ ...t, localId: "thr_local" })),
      }),
    },
  });
  await slot.findByText("Project A · Team");
  expect(
    slot.queryByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeNull();
  expect(
    slot.container.querySelector("[data-sidebar-thread-id=thr_local]"),
  ).toBeNull();
});
it("filters remote rows along with local search without spawning agents", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: sidebar,
    rpc: { teamThreads: team },
  });
  await slot.findByRole("button", { name: "Open shared thread Remote task" });
  fireEvent.change(slot.getByLabelText("Search threads"), {
    target: { value: "missing" },
  });
  expect(
    slot.queryByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeNull();
  expect(slot.inspection.sdkCalls).toEqual([]);
});
