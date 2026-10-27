import { useId, useRef, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

const menuClassName =
  "z-[70] min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md";
const itemClassName =
  "flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none focus:bg-state-hover data-[highlighted]:bg-state-hover";

/** Project actions are not exposed as a host component in the public SDK. */
function ProjectMenuItems({
  surface,
  settingsHref,
  onNavigate,
  onRename,
  onRemove,
}: {
  surface: "context" | "dropdown";
  settingsHref: string;
  onNavigate: () => void;
  onRename: () => void;
  onRemove: () => void;
}) {
  const Item = surface === "context" ? ContextMenu.Item : DropdownMenu.Item;
  const Separator =
    surface === "context" ? ContextMenu.Separator : DropdownMenu.Separator;
  return (
    <>
      <Item asChild className={itemClassName}>
        <a href={settingsHref} onClick={onNavigate}>
          <Icon name="Settings" aria-hidden="true" className="size-4" />
          Project settings
        </a>
      </Item>
      <Item className={itemClassName} onSelect={onRename}>
        <Icon name="Edit" aria-hidden="true" className="size-4" />
        Rename
      </Item>
      <Separator className="-mx-1 my-1 h-px bg-border" />
      <Item
        className={cn(
          itemClassName,
          "text-destructive focus:bg-destructive/15 data-[highlighted]:bg-destructive/15",
        )}
        onSelect={onRemove}
      >
        <Icon name="Trash2" aria-hidden="true" className="size-4" />
        Remove
      </Item>
    </>
  );
}

export function ProjectHeader({
  project,
  shared,
  collapsed,
  active,
  onToggle,
  onNavigate,
}: {
  project: PluginSidebarProject;
  shared: boolean;
  collapsed: boolean;
  active: boolean;
  onToggle: () => void;
  onNavigate: () => void;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const portalScope = usePortalScopeProps();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "remove" | null>(null);
  const [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const dialogRequested = useRef(false);
  const actionsButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const inputId = useId();
  // Personal/fallback groups are not removable projects in bb's own list.
  const canManage = !project.isPersonal && Boolean(project.settingsHref);

  function openDialog(next: "rename" | "remove") {
    dialogRequested.current = true;
    setName(project.name);
    setError(null);
    setDialog(next);
  }
  function closeMenu(event: Event) {
    // Let the dialog own focus rather than returning it behind the overlay.
    if (dialogRequested.current) event.preventDefault();
  }
  async function submit() {
    if (!canManage || !dialog || submitting.current) return;
    const nextName = name.trim();
    if (dialog === "rename" && !nextName) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      if (dialog === "rename") {
        if (nextName !== project.name)
          await sdk.projects.update({ projectId: project.id, name: nextName });
      } else {
        await sdk.projects.delete({ projectId: project.id });
        if (active) {
          navigate.toCompose();
          onNavigate();
        }
      }
      setDialog(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not update project.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const items = {
    settingsHref: project.settingsHref,
    onNavigate,
    onRename: () => openDialog("rename"),
    onRemove: () => openDialog("remove"),
  };
  const header = (
    <div
      className="flex items-center gap-1 px-2"
      data-sidebar-project-id={project.id}
      data-actions-open={dropdownOpen || contextOpen ? "" : undefined}
      onKeyDown={(event) => {
        if (
          canManage &&
          (event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10"))
        ) {
          event.preventDefault();
          setDropdownOpen(true);
        }
      }}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded py-2 text-left text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <Icon
          name={collapsed ? "ChevronRight" : "ChevronDown"}
          aria-hidden="true"
          className="size-3.5 shrink-0"
        />
        <span className="min-w-0 truncate">
          {project.name}
          {shared ? " · Team" : ""}
        </span>
      </button>
      {canManage && (
        <DropdownMenu.Root open={dropdownOpen} onOpenChange={setDropdownOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              ref={actionsButton}
              type="button"
              aria-label={`Actions for project ${project.name}`}
              className="multiplayer-project-actions rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <Icon
                name="MoreHorizontal"
                aria-hidden="true"
                className="size-4"
              />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              {...portalScope}
              aria-label={`${project.name} actions`}
              aria-labelledby={undefined}
              className={menuClassName}
              align="end"
              sideOffset={4}
              collisionPadding={8}
              onCloseAutoFocus={closeMenu}
              onClick={(event) => event.stopPropagation()}
            >
              <ProjectMenuItems surface="dropdown" {...items} />
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <button
        type="button"
        aria-label={`New thread in ${project.name}`}
        className="rounded p-1 text-muted-foreground"
        onClick={() => {
          navigate.toCompose({ projectId: project.id, focusPrompt: true });
          onNavigate();
        }}
      >
        <Icon name="Plus" aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
  return (
    <>
      {canManage ? (
        <ContextMenu.Root onOpenChange={setContextOpen}>
          <ContextMenu.Trigger asChild>{header}</ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content
              {...portalScope}
              aria-label={`${project.name} actions`}
              className={menuClassName}
              collisionPadding={8}
              onCloseAutoFocus={closeMenu}
              onClick={(event) => event.stopPropagation()}
              onPointerUpCapture={(event) => {
                if (event.button !== 0) event.preventDefault();
              }}
            >
              <ProjectMenuItems surface="context" {...items} />
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
      ) : (
        header
      )}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !submitting.current) setDialog(null);
        }}
      >
        <DialogContent
          hideCloseButton={pending}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (dialog === "rename") {
              nameInput.current?.focus();
              nameInput.current?.select();
            } else cancelButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onAfterCloseAutoFocus={() => {
            dialogRequested.current = false;
            actionsButton.current?.focus();
          }}
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {dialog === "rename"
                  ? `Rename ${project.name}`
                  : `Remove ${project.name}?`}
              </DialogTitle>
              <DialogDescription>
                {dialog === "rename"
                  ? "Choose a new name for this project."
                  : "The project and its threads are removed from bb. This cannot be undone."}
              </DialogDescription>
            </DialogHeader>
            {dialog === "rename" && (
              <div className="space-y-2">
                <label htmlFor={inputId} className="text-sm">
                  Project name
                </label>
                <Input
                  ref={nameInput}
                  id={inputId}
                  value={name}
                  disabled={pending}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                ref={cancelButton}
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => setDialog(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant={dialog === "remove" ? "destructive" : "default"}
                disabled={pending || (dialog === "rename" && !name.trim())}
              >
                {dialog === "rename"
                  ? pending
                    ? "Saving…"
                    : "Save"
                  : pending
                    ? "Removing…"
                    : "Remove project"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
