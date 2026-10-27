# Changelog

## v0.3.1

- Host multiple isolated project rooms on one relay origin and SQLite database.
- Add local-only `relay:create-room` and paginated `relay:list-rooms` commands;
  retain one-time `relay:init` and the original owner's credential file.
- Save each new room's owner credential to a separate `0600` file without printing
  tokens; roll back room creation when the file cannot be written.
- Support one independent room connection per local project in a single BB, on
  the same or different relays; preserve protocol v1 compatibility.
- Migrate legacy plugin state and credentials automatically. Scope caches, links,
  cursors, requests, secrets, disconnect and revocation by local project.
- Add a project selector, project-qualified shared links, multi-project sidebar
  rows and owner-request notifications; derive local widget scope from the thread.
- Preserve v0.3.0 native mirrors, import ledgers and sidebar actions; route mirror
  operations through their own project and disconnect only that project's mirrors.
- Fail closed for ambiguous unscoped operations and old links; prevent moved local
  threads from continuing publication to their former project's room.
- Test cross-project access control, independent feeds and membership limits,
  existing database recovery, CLI provisioning and client compatibility.

## v0.3.0

- Add the opt-in Multiplayer Mirror provider and isolated host workspace for native
  BB thread views; no ACP shim, model, shell, or agent execution.
- Import bounded shared previews on open/Refresh with durable per-source version
  tracking and canonical-event receipts; block uncertain partial replays.
- Append labelled remote revisions, quote active Markdown as plain text, and
  keep already imported history explicit after disconnection/revocation.
- Route native composer text into idempotent owner-review requests. Reject
  attachments, mentions, agent-origin proposals, provider switching and mirror
  re-publication. Keep ordinary agent tools/skills unchanged.
- Restore sidebar project settings, rename and confirmation-based removal via
  hover/dropdown/context menus, with keyboard and touch access.
- Preserve v0.2.1 child-thread grouping, archived paging and compact controls.
- Add bridge conformance, import-recovery, safety, sidebar and native-view UI tests.
- Ship relay image v0.3.0 with the existing backward-compatible v0.2 request API.

## v0.2.1

- Replace the archive text selector with compact archive/archive-off glyphs beside
  search, keeping accessible labels and hover/focus tooltips.
- Use a consistent sidebar background for the thread list and search toolbar.
- Show expanded/collapsed chevrons in project headers.
- Group local child threads beneath their parents with depth-based indentation,
  preserving sibling ordering, search, archive filtering and pagination.
- Keep children visible when their parent is unavailable and guard against cyclic
  parent links and excessive indentation.
- No relay changes; compatible with relay v0.2.0.

## v0.2.0

- Add a project-grouped Multiplayer thread list with local/shared glyphs, native
  local navigation and menus, split dragging, search and archived paging.
- Open remote shared threads in the existing read-only conversation view; native
  agent mirrors remain an unregistered experiment.
- Propose a message to a remote thread's owner, without dispatching an agent turn.
- Notify owners with BB toasts and an in-thread review banner. Owners can append
  the proposal to their draft or dismiss it; never auto-submit it.
- Persist requests with authenticated author/owner identities, idempotent IDs,
  participant-scoped reads, versioned decisions and a separate event feed.
- Keep v1 conversation/comment sync compatible with older clients and relays.
- Document native-mirror boundaries and maintain a public-SDK projection test.

## v0.1.0

- Opt-in shared conversation previews across independent BB installations.
- Self-hosted HTTPS relay with SQLite, per-member credentials and invitations.
- Floating Team widget with contextual discussion branches, replies and resolution.
- Deliberate feedback-to-agent-draft handoff, reconnect recovery and revocation.
