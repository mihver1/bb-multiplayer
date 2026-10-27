// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
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
function makeThread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    ...local,
    id,
    title: id,
    displayTitle: id,
    href: `/projects/proj_a/threads/${id}`,
    ...overrides,
  };
}
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
it("switches local and remote archive views with an icon-only action and preserves search", async () => {
  const archivedLocal = {
    ...local,
    id: "thr_archived",
    title: "Archived local task",
    displayTitle: "Archived local task",
    isArchived: true,
    archivedAt: 2,
    href: "/projects/proj_a/threads/thr_archived",
  };
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: { ...sidebar, threads: [local, archivedLocal] },
    rpc: {
      teamThreads: () => ({
        ...team(),
        threads: [
          ...team().threads,
          {
            ...team().threads[0],
            id: "33333333-3333-4333-8333-333333333333",
            title: "Archived remote task",
            status: "archived",
          },
        ],
      }),
    },
  });
  await slot.findByRole("button", { name: "Open shared thread Remote task" });
  const search = slot.getByRole("textbox", { name: "Search threads" });
  fireEvent.change(search, { target: { value: "task" } });
  const toggle = slot.getByRole("button", { name: "Show archived threads" });
  expect(toggle.textContent).toBe("");
  expect(toggle.getAttribute("type")).toBe("button");
  expect(toggle.querySelector('[data-icon="Archive"]')).toBeTruthy();
  expect(toggle.querySelector('[data-glyph="archive-off"]')).toBeNull();
  expect(slot.getByRole("link", { name: "Local task" })).toBeTruthy();
  expect(slot.queryByRole("link", { name: "Archived local task" })).toBeNull();
  expect(
    slot.queryByRole("button", {
      name: "Open shared thread Archived remote task",
    }),
  ).toBeNull();

  fireEvent.click(toggle);
  const back = slot.getByRole("button", { name: "Show active threads" });
  expect(back.textContent).toBe("");
  expect(
    back
      .querySelector('[data-glyph="archive-off"]')
      ?.closest('[aria-hidden="true"]'),
  ).toBeTruthy();
  expect(slot.getByRole("link", { name: "Archived local task" })).toBeTruthy();
  expect(
    slot.getByRole("button", {
      name: "Open shared thread Archived remote task",
    }),
  ).toBeTruthy();
  expect(slot.queryByRole("link", { name: "Local task" })).toBeNull();
  expect(
    slot.queryByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeNull();
  expect((search as HTMLInputElement).value).toBe("task");

  fireEvent.click(back);
  expect(slot.getByRole("button", { name: "Show archived threads" })).toBe(
    toggle,
  );
  expect(toggle.querySelector('[data-glyph="archive-off"]')).toBeNull();
  expect(slot.getByRole("link", { name: "Local task" })).toBeTruthy();
  expect(
    slot.getByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeTruthy();
  expect(slot.queryByRole("link", { name: "Archived local task" })).toBeNull();
  expect(
    slot.queryByRole("button", {
      name: "Open shared thread Archived remote task",
    }),
  ).toBeNull();
  expect((search as HTMLInputElement).value).toBe("task");
  expect(slot.inspection.sdkCalls).toEqual([]);
  expect(slot.inspection.navigateCalls).toEqual([]);
});
it("keeps the compact search toolbar on the sidebar surface and explains the glyph on focus", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: sidebar,
    rpc: { teamThreads: team },
  });
  await slot.findByText("Project A · Team");
  const list = slot.getByLabelText("Multiplayer thread list");
  const search = slot.getByRole("textbox", { name: "Search threads" });
  const toolbar = search.parentElement!;
  const toggle = slot.getByRole("button", { name: "Show archived threads" });
  expect(list.classList.contains("bg-sidebar")).toBe(true);
  expect(toolbar.classList.contains("bg-sidebar")).toBe(true);
  expect(toolbar.classList.contains("flex")).toBe(true);
  expect(search.classList.contains("bg-transparent")).toBe(true);
  expect(toolbar.contains(toggle)).toBe(true);
  fireEvent.focus(toggle);
  expect(
    await slot.findByRole("tooltip", { name: "Show archived threads" }),
  ).toBeTruthy();
});
it("changes the project chevron when collapsing and expanding only that project's rows", async () => {
  const onNavigate = vi.fn();
  const slot = renderSlot(
    { component: TeamThreadList },
    { ...props, onNavigate },
    {
      sidebarThreads: {
        ...sidebar,
        threads: [local, makeThread("Other task", { projectId: "proj_b" })],
      },
      rpc: { teamThreads: team },
    },
  );
  const project = await slot.findByRole("button", { name: "Project A · Team" });
  expect(project.getAttribute("aria-expanded")).toBe("true");
  expect(
    project
      .querySelector('[data-icon="ChevronDown"]')
      ?.getAttribute("aria-hidden"),
  ).toBe("true");
  fireEvent.click(project);
  expect(project.getAttribute("aria-expanded")).toBe("false");
  expect(project.querySelector('[data-icon="ChevronRight"]')).toBeTruthy();
  expect(slot.queryByRole("link", { name: "Local task" })).toBeNull();
  expect(
    slot.queryByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeNull();
  expect(slot.getByRole("link", { name: "Other task" })).toBeTruthy();
  expect(
    slot.getByRole("button", { name: "New thread in Project A" }),
  ).toBeTruthy();
  fireEvent.click(project);
  expect(project.getAttribute("aria-expanded")).toBe("true");
  expect(project.querySelector('[data-icon="ChevronDown"]')).toBeTruthy();
  expect(slot.getByRole("link", { name: "Local task" })).toBeTruthy();
  expect(
    slot.getByRole("button", { name: "Open shared thread Remote task" }),
  ).toBeTruthy();
  expect(onNavigate).not.toHaveBeenCalled();
  expect(slot.inspection.navigateCalls).toEqual([]);
});
it("exposes project actions in the thread list without collapsing or navigating on right-click", async () => {
  const onNavigate = vi.fn();
  const slot = renderSlot(
    { component: TeamThreadList },
    { ...props, onNavigate },
    { sidebarThreads: sidebar, rpc: { teamThreads: team } },
  );
  const project = await slot.findByRole("button", { name: "Project A · Team" });
  fireEvent.contextMenu(project, { button: 2, clientX: 80, clientY: 100 });
  const menu = await slot.findByRole("menu", { name: "Project A actions" });
  expect(
    within(menu)
      .getByRole("menuitem", { name: "Project settings" })
      .getAttribute("href"),
  ).toBe("/projects/proj_a/settings");
  expect(project.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
  expect(slot.getByRole("link", { name: "Local task" })).toBeTruthy();
  expect(
    slot.getByRole("button", { name: "Actions for project Project A" }),
  ).toBeTruthy();
  expect(slot.inspection.sdkCalls).toEqual([]);
  expect(onNavigate).not.toHaveBeenCalled();
});
it.each([false, true])(
  "groups children beneath their parents with increasing indentation (archived: %s)",
  async (archived) => {
    const onNavigate = vi.fn();
    const threads = [
      makeThread("grandchild", { parentThreadId: "child", updatedAt: 100 }),
      makeThread("child", { parentThreadId: "parent", updatedAt: 20 }),
      makeThread("older-child", { parentThreadId: "parent", updatedAt: 10 }),
      makeThread("pinned-child", { parentThreadId: "parent", isPinned: true }),
      makeThread("other-root", { updatedAt: 2 }),
      makeThread("parent"),
      makeThread("pinned-root", { isPinned: true }),
    ].map((thread) => ({
      ...thread,
      isArchived: archived,
      archivedAt: archived ? 1 : null,
    }));
    const slot = renderSlot(
      { component: TeamThreadList },
      { ...props, onNavigate },
      {
        sidebarThreads: { ...sidebar, threads },
        rpc: { teamThreads: team },
      },
    );
    await slot.findByText("Project A · Team");
    if (archived)
      fireEvent.click(
        slot.getByRole("button", { name: "Show archived threads" }),
      );
    const rows = () =>
      Array.from(
        slot.container.querySelectorAll<HTMLElement>(
          "[data-sidebar-thread-id]",
        ),
      );
    expect(
      rows().map((row) => [
        row.dataset.sidebarThreadId,
        row.parentElement!.style.paddingInlineStart,
      ]),
    ).toEqual([
      ["pinned-root", "0.5rem"],
      ["other-root", "0.5rem"],
      ["parent", "0.5rem"],
      ["pinned-child", "1.5rem"],
      ["child", "1.5rem"],
      ["grandchild", "2.5rem"],
      ["older-child", "1.5rem"],
    ]);
    fireEvent.click(slot.getByRole("button", { name: "Project A · Team" }));
    expect(rows()).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Project A · Team" }));
    expect(rows()).toHaveLength(7);
    fireEvent.click(slot.getByRole("link", { name: "grandchild" }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "grandchild" },
    ]);
    expect(onNavigate).toHaveBeenCalledOnce();
  },
);
it("keeps children visible as roots when their parent is hidden, archived, missing or in another project", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: {
      ...sidebar,
      threads: [
        makeThread("hidden-parent", { isHidden: true }),
        makeThread("archived-parent", { isArchived: true }),
        makeThread("other-parent", { projectId: "proj_b" }),
        makeThread("hidden-child", { parentThreadId: "hidden-parent" }),
        makeThread("archived-child", { parentThreadId: "archived-parent" }),
        makeThread("missing-child", { parentThreadId: "missing-parent" }),
        makeThread("other-child", { parentThreadId: "other-parent" }),
      ],
    },
    rpc: { teamThreads: team },
  });
  await slot.findByText("Project A · Team");
  const project = slot.getByRole("region", { name: "Project A" });
  const rows = Array.from(
    project.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
  );
  expect(rows.map((row) => row.dataset.sidebarThreadId)).toEqual([
    "hidden-child",
    "archived-child",
    "missing-child",
    "other-child",
  ]);
  expect(
    rows.every(
      (row) => row.parentElement!.style.paddingInlineStart === "0.5rem",
    ),
  ).toBe(true);
});
it("does not lose matching descendants when search excludes their parent", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: {
      ...sidebar,
      threads: [
        makeThread("parent"),
        makeThread("child", { parentThreadId: "parent" }),
        makeThread("grandchild", { parentThreadId: "child" }),
      ],
    },
    rpc: { teamThreads: team },
  });
  await slot.findByText("Project A · Team");
  fireEvent.change(slot.getByRole("textbox", { name: "Search threads" }), {
    target: { value: "child" },
  });
  expect(slot.queryByRole("link", { name: "parent" })).toBeNull();
  expect(
    slot.getByRole("link", { name: "child" }).parentElement!.style
      .paddingInlineStart,
  ).toBe("0.5rem");
  expect(
    slot.getByRole("link", { name: "grandchild" }).parentElement!.style
      .paddingInlineStart,
  ).toBe("1.5rem");
  fireEvent.change(slot.getByRole("textbox", { name: "Search threads" }), {
    target: { value: "" },
  });
  expect(
    slot.getByRole("link", { name: "child" }).parentElement!.style
      .paddingInlineStart,
  ).toBe("1.5rem");
  expect(
    slot.getByRole("link", { name: "grandchild" }).parentElement!.style
      .paddingInlineStart,
  ).toBe("2.5rem");
});
it("applies pagination after nesting so a newer child never precedes its parent", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: {
      ...sidebar,
      threads: [
        makeThread("parent", { updatedAt: 0 }),
        ...Array.from({ length: 105 }, (_, i) =>
          makeThread(`child-${i}`, {
            parentThreadId: "parent",
            updatedAt: i + 1,
          }),
        ),
      ],
    },
    rpc: { teamThreads: () => ({ ...team(), threads: [] }) },
  });
  await slot.findByText("Project A · Team");
  const rows = () =>
    Array.from(
      slot.container.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
    );
  expect(rows()).toHaveLength(100);
  expect(rows()[0].dataset.sidebarThreadId).toBe("parent");
  expect(rows()[1].dataset.sidebarThreadId).toBe("child-104");
  fireEvent.click(slot.getByRole("button", { name: "Show more threads" }));
  expect(rows()).toHaveLength(106);
  expect(rows().at(-1)?.dataset.sidebarThreadId).toBe("child-0");
  expect(
    rows()
      .slice(1)
      .every((row) => row.parentElement!.style.paddingInlineStart === "1.5rem"),
  ).toBe(true);
});
it("renders cyclic parent links only once and bounds deep indentation", async () => {
  const slot = renderSlot({ component: TeamThreadList }, props, {
    sidebarThreads: {
      ...sidebar,
      threads: [
        makeThread("cycle-a", { parentThreadId: "cycle-b" }),
        makeThread("cycle-b", { parentThreadId: "cycle-a" }),
        makeThread("self", { parentThreadId: "self" }),
        ...Array.from({ length: 20 }, (_, i) =>
          makeThread(`level-${i}`, {
            parentThreadId: i === 0 ? null : `level-${i - 1}`,
          }),
        ),
      ],
    },
    rpc: { teamThreads: team },
  });
  await slot.findByText("Project A · Team");
  const rows = Array.from(
    slot.container.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"),
  );
  expect(rows).toHaveLength(23);
  expect(new Set(rows.map((row) => row.dataset.sidebarThreadId)).size).toBe(23);
  expect(
    slot.getByRole("link", { name: "level-19" }).parentElement!.style
      .paddingInlineStart,
  ).toBe("6.5rem");
});
