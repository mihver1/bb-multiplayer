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
import { cn } from "../lib/utils";

function LocalRow({
  thread,
  active,
  shared,
  onNavigate,
}: {
  thread: PluginSidebarThread;
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
  const remote = (team?.threads ?? [])
    .filter((t) => t.localId === null)
    .filter((t) =>
      archived
        ? t.status === "archived"
        : t.status !== "archived" && t.status !== "deleted",
    )
    .filter((t) => !needle || t.title.toLocaleLowerCase().includes(needle));
  const sharedLocal = new Set(
    team?.threads.filter((t) => t.localId).map((t) => t.localId),
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
  let remaining = limit;
  return (
    <div
      className="h-full overflow-y-auto px-2 pb-4"
      aria-label="Multiplayer thread list"
    >
      <div className="sticky top-0 z-10 space-y-2 bg-background py-2">
        <input
          aria-label="Search threads"
          className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
          placeholder="Search threads"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setLimit(100);
          }}
        />
        <button
          className="text-xs text-muted-foreground"
          onClick={() => {
            setArchived((v) => !v);
            setLimit(100);
          }}
        >
          {archived ? "Show active threads" : "Show archived threads"}
        </button>
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
        const remotes = team?.projectId === project.id ? remote : [];
        if (!locals.length && !remotes.length && needle) return null;
        const projectRows = collapsed.has(project.id)
          ? []
          : locals.slice(0, remaining);
        remaining -= projectRows.length;
        const remoteRows = collapsed.has(project.id)
          ? []
          : remotes.slice(0, remaining);
        remaining -= remoteRows.length;
        return (
          <section key={project.id} className="mt-2" aria-label={project.name}>
            <div className="flex items-center gap-1 px-2">
              <button
                className="min-w-0 flex-1 truncate py-2 text-left text-xs font-semibold text-muted-foreground"
                aria-expanded={!collapsed.has(project.id)}
                onClick={() =>
                  setCollapsed((old) => {
                    const next = new Set(old);
                    next.has(project.id)
                      ? next.delete(project.id)
                      : next.add(project.id);
                    return next;
                  })
                }
              >
                {project.name}
                {team?.projectId === project.id ? " · Team" : ""}
              </button>
              <button
                aria-label={`New thread in ${project.name}`}
                className="rounded p-1 text-muted-foreground"
                onClick={() => {
                  navigate.toCompose({
                    projectId: project.id,
                    focusPrompt: true,
                  });
                  props.onNavigate();
                }}
              >
                <Icon name="Plus" className="size-4" />
              </button>
            </div>
            {!collapsed.has(project.id) && (
              <>
                {projectRows.map((thread) => (
                  <LocalRow
                    key={thread.id}
                    thread={thread}
                    active={thread.id === props.activeThreadId}
                    shared={sharedLocal.has(thread.id)}
                    onNavigate={props.onNavigate}
                  />
                ))}
                {remoteRows.map((thread) => {
                  const owner = team?.identity?.members.find(
                    (m) => m.id === thread.ownerId,
                  );
                  const fresh = Boolean(
                    team?.online &&
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
                          subPath: `thread/${thread.id}`,
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
      {team?.truncated && (
        <p className="p-2 text-xs text-muted-foreground">
          Latest 200 team threads shown.
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
