// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { ProjectHeader } from "../components/project-header";

const project = {
  id: "proj_a",
  name: "Project A",
  isPersonal: false,
  href: "/projects/proj_a",
  settingsHref: "/projects/proj_a/settings",
};
function setup(
  options: {
    active?: boolean;
    collapsed?: boolean;
    personal?: boolean;
    settingsHref?: string;
    remove?: () => Promise<{ ok: true }>;
    update?: PluginBrowserBbSdk["projects"]["update"];
  } = {},
) {
  const onToggle = vi.fn();
  const onNavigate = vi.fn();
  const slot = renderSlot(
    { component: ProjectHeader },
    {
      project: {
        ...project,
        isPersonal: options.personal ?? false,
        settingsHref: options.settingsHref ?? project.settingsHref,
      },
      shared: true,
      active: options.active ?? true,
      collapsed: options.collapsed ?? false,
      onToggle,
      onNavigate,
    },
    {
      sdk: {
        projects: {
          update: options.update,
          delete: options.remove ?? (async () => ({ ok: true as const })),
        },
      },
    },
  );
  return { slot, onToggle, onNavigate };
}
function openContext(slot: ReturnType<typeof setup>["slot"]) {
  fireEvent.contextMenu(
    slot.getByRole("button", { name: "Project A · Team" }),
    {
      button: 2,
      clientX: 80,
      clientY: 100,
    },
  );
  return slot.findByRole("menu", { name: "Project A actions" });
}
afterEach(cleanup);

it.each([false, true])(
  "opens the project context menu without toggling the group (collapsed: %s)",
  async (collapsed) => {
    const { slot, onToggle, onNavigate } = setup({ collapsed });
    const menu = await openContext(slot);
    const settings = within(menu).getByRole("menuitem", {
      name: "Project settings",
    });
    expect(settings.tagName).toBe("A");
    expect(settings.getAttribute("href")).toBe(project.settingsHref);
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "Remove" })).toBeTruthy();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(slot.inspection.sdkCalls).toEqual([]);
  },
);

it("opens the same actions with the explicit menu button and supports Escape", async () => {
  const { slot, onToggle } = setup();
  const trigger = slot.getByRole("button", {
    name: "Actions for project Project A",
  });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const menu = await slot.findByRole("menu", { name: "Project A actions" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual(["Project settings", "Rename", "Remove"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
  expect(onToggle).not.toHaveBeenCalled();
});

it.each([{ key: "F10", shiftKey: true }, { key: "ContextMenu" }])(
  "opens project actions from the keyboard: %j",
  async (event) => {
    const { slot, onToggle } = setup();
    fireEvent.keyDown(
      slot.getByRole("button", { name: "Project A · Team" }),
      event,
    );
    expect(
      await slot.findByRole("menu", { name: "Project A actions" }),
    ).toBeTruthy();
    expect(onToggle).not.toHaveBeenCalled();
  },
);

it("keeps collapse and new-thread actions separate from project management", () => {
  const { slot, onToggle, onNavigate } = setup();
  fireEvent.click(slot.getByRole("button", { name: "Project A · Team" }));
  expect(onToggle).toHaveBeenCalledOnce();
  expect(slot.queryByRole("menu")).toBeNull();
  fireEvent.click(
    slot.getByRole("button", { name: "New thread in Project A" }),
  );
  expect(onToggle).toHaveBeenCalledOnce();
  expect(slot.inspection.navigateCalls).toEqual([
    {
      method: "toCompose",
      options: { projectId: "proj_a", focusPrompt: true },
    },
  ]);
  expect(onNavigate).toHaveBeenCalledOnce();
});

it("renames via the SDK, trims whitespace and retains the dialog on failure", async () => {
  const update = vi.fn(async () => {
    throw new Error("Rename denied");
  });
  const { slot } = setup({ update });
  fireEvent.click(
    within(await openContext(slot)).getByRole("menuitem", { name: "Rename" }),
  );
  const dialog = await slot.findByRole("dialog", { name: "Rename Project A" });
  const input = within(dialog).getByRole("textbox", { name: "Project name" });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect((input as HTMLInputElement).value).toBe("Project A");
  fireEvent.change(input, { target: { value: "   " } });
  expect(
    (within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "  Renamed project  " } });
  fireEvent.submit(input.closest("form")!);
  expect(await slot.findByRole("alert")).toHaveProperty(
    "textContent",
    "Rename denied",
  );
  expect(update).toHaveBeenCalledWith({
    projectId: "proj_a",
    name: "Renamed project",
  });
  expect(slot.getByRole("dialog", { name: "Rename Project A" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.navigateCalls).toEqual([]);
});

it("closes a successful rename and restores focus to project actions", async () => {
  const update = vi.fn<PluginBrowserBbSdk["projects"]["update"]>(async () => ({
    id: project.id,
    name: "Next name",
    kind: "standard",
    sources: [],
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 2,
  }));
  const { slot } = setup({ update });
  fireEvent.click(
    within(await openContext(slot)).getByRole("menuitem", { name: "Rename" }),
  );
  const dialog = await slot.findByRole("dialog", { name: "Rename Project A" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Project name" }),
    { target: { value: "Next name" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(update).toHaveBeenCalledWith({
    projectId: "proj_a",
    name: "Next name",
  });
  expect(document.activeElement).toBe(
    slot.getByRole("button", { name: "Actions for project Project A" }),
  );
});

it("does not remove a project until confirmation and allows cancelling safely", async () => {
  const { slot } = setup();
  fireEvent.click(
    within(await openContext(slot)).getByRole("menuitem", { name: "Remove" }),
  );
  const dialog = await slot.findByRole("dialog", { name: "Remove Project A?" });
  expect(
    within(dialog).getByText(
      "The project and its threads are removed from bb. This cannot be undone.",
    ),
  ).toBeTruthy();
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ),
  );
  expect(slot.inspection.sdkCalls).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  expect(slot.inspection.sdkCalls).toEqual([]);
});

it.each([false, true])(
  "removes only the selected project and leaves another project's route alone (active: %s)",
  async (active) => {
    const { slot, onNavigate } = setup({ active });
    fireEvent.click(
      within(await openContext(slot)).getByRole("menuitem", { name: "Remove" }),
    );
    const dialog = await slot.findByRole("dialog", {
      name: "Remove Project A?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove project" }),
    );
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(slot.inspection.sdkCalls).toEqual([
      { method: "projects.delete", args: [{ projectId: "proj_a" }] },
    ]);
    expect(slot.inspection.navigateCalls).toEqual(
      active ? [{ method: "toCompose", options: undefined }] : [],
    );
    expect(onNavigate).toHaveBeenCalledTimes(active ? 1 : 0);
  },
);

it("keeps a failed removal retryable and does not navigate or dispatch agents", async () => {
  const remove = vi.fn(async () => {
    throw new Error("Removal denied");
  });
  const { slot, onNavigate } = setup({ remove });
  fireEvent.click(
    within(await openContext(slot)).getByRole("menuitem", { name: "Remove" }),
  );
  const dialog = await slot.findByRole("dialog", { name: "Remove Project A?" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove project" }),
  );
  expect(await slot.findByRole("alert")).toHaveProperty(
    "textContent",
    "Removal denied",
  );
  expect(slot.getByRole("dialog", { name: "Remove Project A?" })).toBeTruthy();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Remove project",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  expect(remove).toHaveBeenCalledOnce();
  expect(slot.inspection.navigateCalls).toEqual([]);
  expect(onNavigate).not.toHaveBeenCalled();
});

it("ignores duplicate submissions and keeps confirmation open while removal is pending", async () => {
  let finish!: (result: { ok: true }) => void;
  const remove = vi.fn(
    () =>
      new Promise<{ ok: true }>((resolve) => {
        finish = resolve;
      }),
  );
  const { slot } = setup({ remove });
  fireEvent.click(
    within(await openContext(slot)).getByRole("menuitem", { name: "Remove" }),
  );
  const dialog = await slot.findByRole("dialog", { name: "Remove Project A?" });
  fireEvent.click(
    within(dialog).getByRole("button", { name: "Remove project" }),
  );
  fireEvent.submit(dialog.querySelector("form")!);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(remove).toHaveBeenCalledOnce();
  expect(slot.getByRole("dialog", { name: "Remove Project A?" })).toBeTruthy();
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Cancel",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await act(async () => finish({ ok: true }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
});

it.each([{ personal: true }, { settingsHref: "" }])(
  "does not expose destructive project actions for personal or fallback groups: %j",
  (options) => {
    const { slot } = setup(options);
    expect(
      slot.queryByRole("button", { name: "Actions for project Project A" }),
    ).toBeNull();
    fireEvent.contextMenu(
      slot.getByRole("button", { name: "Project A · Team" }),
    );
    expect(slot.queryByRole("menu")).toBeNull();
  },
);
