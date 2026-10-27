# Changelog

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
