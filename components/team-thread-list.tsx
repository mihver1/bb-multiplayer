import { useCallback, useState } from "react";
import {
  experimental_useSidebarThreads,
  experimental_useSidebarThreadSplit,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  ThreadTitle,
  useBbNavigate,
  useRpc,
  useSidebarThreadDraft,
  useSidebarThreadRowStatus,
  useSidebarThreadShortcut,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginThreadListProps,
  PluginSidebarThread,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { useTeamQuery } from "../hooks/use-team-query";
import { Icon } from "./ui/icon";
import { IconAction } from "./icon-action";
import { ProjectHeader } from "./project-header";
import { cn } from "../lib/utils";

/** Keep each family's rows together, preserving the supplied sibling order. */
function nestThreadRows(threads: PluginSidebarThread[]) {
  const ids = new Set(threads.map((thread) => thread.id));
  const children = new Map<string | null, PluginSidebarThread[]>();
  for (const thread of threads) {
    const parentId =
      thread.parentThreadId && ids.has(thread.parentThreadId)
        ? thread.parentThreadId
        : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(thread);
    children.set(parentId, siblings);
  }
  const rows: { thread: PluginSidebarThread; depth: number }[] = [];
  const visited = new Set<string>();
  function appendTree(thread: PluginSidebarThread) {
    const stack = [{ thread, depth: 0 }];
    while (stack.length) {
      const row = stack.pop()!;
      if (visited.has(row.thread.id)) continue;
      visited.add(row.thread.id);
      rows.push(row);
      const descendants = children.get(row.thread.id) ?? [];
      for (let i = descendants.length - 1; i >= 0; i--)
        stack.push({ thread: descendants[i], depth: row.depth + 1 });
    }
  }
  for (const root of children.get(null) ?? []) appendTree(root);
  // Missing/filtered parents become roots; malformed cycles must not hide rows.
  for (const thread of threads) if (!visited.has(thread.id)) appendTree(thread);
  return rows;
}

function LocalRow({
  thread,
  depth,
  active,
  shared,
  onNavigate,
}: {
  thread: PluginSidebarThread;
  depth: number;
  active: boolean;
  shared: boolean;
  onNavigate: () => void;
}) {
  const navigate = useBbNavigate(),
    draft = useSidebarThreadDraft(thread.id),
    rowStatus = useSidebarThreadRowStatus(thread.id),
    shortcut = useSidebarThreadShortcut(thread.id);
  const { splitProps } = experimental_useSidebarThreadSplit(thread.id);
  const target: PluginThreadActionTarget = {
    ...thread,
    environment: thread.environment?.id
      ? { id: thread.environment.id, path: thread.environment.path }
      : null,
  };
  return (
    <ThreadActionsContextMenu thread={target}>
      <div
        className={cn(
          "group flex items-center rounded-md px-2 hover:bg-muted",
          active && "bg-muted",
        )}
        // Bound the visual indent so deeply nested threads still have room for a title.
        style={{ paddingInlineStart: `${0.5 + Math.min(depth, 6)}rem` }}
      >
        <a
          href={thread.href}
          data-sidebar-thread-shortcut-target=""
          data-sidebar-thread-id={thread.id}
          {...splitProps}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 text-sm"
          aria-current={active ? "page" : undefined}
          onClick={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            navigate.toThread(thread.id);
            onNavigate();
          }}
        >
          {shared && (
            <Icon name="multiplayer/people" className="size-4 shrink-0" />
          )}
          <ThreadStatusGlyph
            indicator={thread.indicator}
            archived={thread.isArchived}
            rowStatus={rowStatus}
            size="compact"
          />
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              thread.isUnread && "font-semibold",
            )}
          >
            <ThreadTitle threadId={thread.id} />
          </span>
          {draft.hasUnsubmittedDraft && (
            <span
              className="text-xs text-muted-foreground"
              aria-label="Unsent draft"
            >
              •
            </span>
          )}
          {shortcut && (
            <kbd className="text-xs text-muted-foreground">
              {shortcut.label}
            </kbd>
          )}
        </a>
        <ThreadActionsMenu
          thread={target}
          trigger={(props) => (
            <button
              {...props}
              aria-label={`Actions for ${thread.displayTitle}`}
              className={cn(
                props.className,
                "rounded p-1 text-muted-foreground opacity-100 sm:opacity-0 focus:opacity-100 group-hover:opacity-100",
              )}
            >
              <Icon name="MoreHorizontal" className="size-4" />
            </button>
          )}
        />
      </div>
    </ThreadActionsContextMenu>
  );
}

/** Opt-in replacement: preserves native local navigation/menus, and adds
 * remote read-only conversations only under their explicitly connected project.
 */
export function TeamThreadList(props: PluginThreadListProps) {
  const [archived, setArchived] = useState(false),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(100);
  const native = experimental_useSidebarThreads({
    experimental_lifecycles: archived ? ["archived"] : ["active"],
  });
  const rpc = useRpc<typeof rpcContract>(),
    navigate = useBbNavigate();
  const load = useCallback(() => rpc.call("teamThreads"), [rpc]);
  const { data: team, error } = useTeamQuery(load);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const needle = query.trim().toLocaleLowerCase();
  const local = native.threads.filter(
    (t) =>
      !t.isHidden &&
      t.isArchived === archived &&
      (!needle || t.displayTitle.toLocaleLowerCase().includes(needle)),
  );
  // Never resurrect a hidden/archived local thread as a remote duplicate.
  const teams = team?.projects ?? [];
  const allThreads = teams.flatMap((project) =>
    project.threads.map((thread) => ({
      ...thread,
      projectId: project.projectId,
    })),
  );
  const remote = allThreads
    .filter((t) => t.localId === null)
    .filter((t) =>
      archived
        ? t.status === "archived"
        : t.status !== "archived" && t.status !== "deleted",
    )
    .filter((t) => !needle || t.title.toLocaleLowerCase().includes(needle));
  const sharedLocal = new Set(
    allThreads.filter((t) => t.localId).map((t) => t.localId),
  );
  const projects = [...native.projects];
  // The default host query may omit its personal-project record; never lose
  // visible local threads solely because their project metadata is not loaded.
  for (const thread of local) {
    if (!projects.some((project) => project.id === thread.projectId))
      projects.push({
        id: thread.projectId,
        name: "Other threads",
        isPersonal: true,
        href: "",
        settingsHref: "",
      });
  }
  for (const teamProject of teams) {
    if (!projects.some((project) => project.id === teamProject.projectId))
      projects.push({
        id: teamProject.projectId,
        name: teamProject.identity?.room.name ?? "Team project",
        isPersonal: false,
        href: "",
        settingsHref: "",
      });
  }
  let remaining = limit;
  return (
    <div
      className="h-full overflow-y-auto bg-sidebar px-2 pb-4"
      aria-label="Multiplayer thread list"
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 bg-sidebar py-2">
        <input
          aria-label="Search threads"
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          placeholder="Search threads"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(100);
          }}
        />
        <IconAction
          label={archived ? "Show active threads" : "Show archived threads"}
          className="size-8"
          onClick={() => {
            setArchived((v) => !v);
            setLimit(100);
          }}
        >
          <span aria-hidden="true" className="relative size-4">
            <Icon name="Archive" className="size-4" />
            {archived && (
              <svg
                data-glyph="archive-off"
                focusable="false"
                viewBox="0 0 24 24"
                className="absolute inset-0 size-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              >
                {/* Separate the slash from the archive's strokes. */}
                <path d="m3 3 18 18" stroke="var(--sidebar)" strokeWidth="5" />
                <path d="m3 3 18 18" />
              </svg>
            )}
          </span>
        </IconAction>
      </div>
      {native.status === "loading" && (
        <p role="status" className="p-2 text-xs">
          Loading threads…
        </p>
      )}
      {(native.status === "error" || error) && (
        <p role="alert" className="p-2 text-xs text-destructive">
          {error ?? "Could not load local threads"}
        </p>
      )}
      {projects.map((project) => {
        const locals = local
          .filter((t) => t.projectId === project.id)
          .sort(
            (a, b) =>
              Number(b.isPinned) - Number(a.isPinned) ||
              (a.isPinned && b.isPinned
                ? (a.pinSortKey ?? "").localeCompare(b.pinSortKey ?? "")
                : 0) ||
              b.updatedAt - a.updatedAt,
          );
        const projectTeam = teams.find((t) => t.projectId === project.id);
        const remotes = remote.filter((t) => t.projectId === project.id);
        if (!locals.length && !remotes.length && needle) return null;
        const projectRows = collapsed.has(project.id)
          ? []
          : nestThreadRows(locals).slice(0, remaining);
        remaining -= projectRows.length;
        const remoteRows = collapsed.has(project.id)
          ? []
          : remotes.slice(0, remaining);
        remaining -= remoteRows.length;
        return (
          <section key={project.id} className="mt-2" aria-label={project.name}>
            <ProjectHeader
              project={project}
              shared={Boolean(projectTeam)}
              collapsed={collapsed.has(project.id)}
              active={props.activeProjectId === project.id}
              onToggle={() =>
                setCollapsed((old) => {
                  const next = new Set(old);
                  next.has(project.id)
                    ? next.delete(project.id)
                    : next.add(project.id);
                  return next;
                })
              }
              onNavigate={props.onNavigate}
            />
            {!collapsed.has(project.id) && (
              <>
                {projectRows.map(({ thread, depth }) => (
                  <LocalRow
                    key={thread.id}
                    thread={thread}
                    depth={depth}
                    active={thread.id === props.activeThreadId}
                    shared={sharedLocal.has(thread.id)}
                    onNavigate={props.onNavigate}
                  />
                ))}
                {remoteRows.map((thread) => {
                  const owner = projectTeam?.identity?.members.find(
                    (m) => m.id === thread.ownerId,
                  );
                  const fresh = Boolean(
                    projectTeam?.online &&
                    owner &&
                    !owner.revoked &&
                    Date.now() - owner.lastSeenAt < 15000,
                  );
                  return (
                    <button
                      key={thread.id}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                      aria-label={`Open shared thread ${thread.title}`}
                      onClick={() => {
                        navigate.toPluginPanel("team", {
                          subPath: `project/${project.id}/thread/${thread.id}`,
                        });
                        props.onNavigate();
                      }}
                    >
                      <Icon
                        name="multiplayer/people"
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{thread.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {owner?.name ?? "Teammate"} ·{" "}
                          {fresh
                            ? thread.status
                            : `last known: ${thread.status}`}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </section>
        );
      })}
      {local.length + remote.length > limit && (
        <button
          className="w-full p-2 text-xs"
          onClick={() => setLimit((n) => n + 100)}
        >
          Show more threads
        </button>
      )}
      {teams.some((t) => t.truncated) && (
        <p className="p-2 text-xs text-muted-foreground">
          Latest 200 team threads per project shown.
        </p>
      )}
      {native.experimental_archived?.hasNextPage && (
        <button
          className="w-full p-2 text-xs"
          disabled={native.experimental_archived.isFetchingNextPage}
          onClick={() => void native.experimental_archived?.fetchNextPage()}
        >
          Load older archived threads
        </button>
      )}
    </div>
  );
}
