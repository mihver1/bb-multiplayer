# Multiplayer for BB · Experimental

**Independent BB installations. One shared project context.**

A working first slice of team collaboration: opt-in live conversation previews,
contextual comments, replies, resolution, presence and deliberate handoff of
feedback to the local agent's draft. No remote control of someone else's agent.

## What works

- **Multiplayer page:** connect a local project to a team server, see members,
  last-seen presence and shared conversations from other BB installations.
- **Floating Team widget:** a compact comment-count button in thread views opens
  discussion above the app without occupying the side panel. Drag its handle to
  move it, use arrow keys on the handle, double-click to reset, or Escape to
  minimize. It fits narrow screens and keeps its input when minimized. Height
  grows with visible content up to the available viewport, rather than a fixed
  pixel cap. Once full, the comment list scrolls while the composer stays below
  it. Short discussions stay compact. Very short viewports use a single body
  scroller so all controls remain reachable.
- **Sharing settings:** use the sliders glyph in the compact widget header to
  explicitly enable/pause sharing for an individual thread. Saved legacy
  Multiplayer tabs still work.
- **Message action:** “Discuss with team” opens the floating widget with the
  message reference and selected quotation; no side panel or composer banner.
- **Comments:** separate discussion branches, not one chronological feed. Each
  root comment keeps its replies directly underneath it; new replies do not move
  the branch. Replies within a branch are chronological. Replying to a reply stays
  in that same root discussion (one reply level). Resolved branches keep their
  root visible and collapse replies, with a Show/Hide control. The reply composer
  previews the root comment so its target is explicit. Reply/Resolve appear on
  comment hover or keyboard focus; touch/coarse-pointer devices always show them.
  Post with the arrow glyph inside the lower-right corner of the team input (or
  Cmd/Ctrl+Enter). It sends only to the team, never to the native agent composer.
  A quotation retains its original text and content hash when the message changes.
- **Feedback:** select comments in your own thread's widget and use the
  **message-bubble → arrow** glyph (**Add to agent draft**, available when that
  thread's composer is mounted). Icon controls have hover/focus tooltips. The
  prompt is editable; pressing Send is a separate human action. Remote comments do not dispatch messages, tools or agents.
- **Self-hosted relay:** durable SQLite state, per-member credentials, one-use
  invitations (24-hour expiry), owner/member roles and revocation.
- **Recovery:** persisted outbound snapshots, monotonic per-thread revisions,
  idempotent replay and a durable event cursor. One broken local thread does not
  prevent other threads or incoming comments from syncing.

## Requirements and install

- BB server **0.46.1+**, SDK **0.6.49+ within 0.6.x**.
- Node **22.22.2+, 24.15+ or 26+**, npm and a supported `better-sqlite3` platform for the relay/tests.
- The plugin SDK is pinned to the live server's 0.6.49 baseline. A small adapter
  uses the newer `experimental_tab` API when present, otherwise the baseline's
  `threadPanelAction`. A newer `bb` CLI may print a migration warning; do not
  blindly repin types to the CLI version when the running server is older.

```sh
npm ci --include=dev
npm run typecheck
npm test
npm run build
bb plugin install .
```

A path installation remains linked to this directory. After code changes:

```sh
npm run build
bb plugin reload multiplayer
```

There is no `bb multiplayer` command or automatically enabled agent tool in this
version. Setup and collaboration use the UI; the public RPC contract is available
through `bb plugin rpc` for diagnostics.

## Start a team server

For the isolated Docker + nginx playground and its operating/rollback commands,
see [deploy/relay/README.md](deploy/relay/README.md). The deployed origin is
**https://multiplayer.selfhost.ru**; the UI remains in each participant's BB.

On a trusted server, from this checkout:

```sh
# Optional non-secret names; initialization is allowed only once per database.
export MULTIPLAYER_ROOM_NAME="Payments"
export MULTIPLAYER_OWNER_NAME="Alice"
npm run relay:init
npm run relay:start
```

Defaults:

| Variable                 | Default        | Purpose                                              |
| ------------------------ | -------------- | ---------------------------------------------------- |
| `MULTIPLAYER_DATA_DIR`   | `.multiplayer` | SQLite database and initial private owner credential |
| `MULTIPLAYER_HOST`       | `127.0.0.1`    | Bind address                                         |
| `MULTIPLAYER_PORT`       | `4789`         | HTTP port                                            |
| `MULTIPLAYER_ROOM_NAME`  | `Our project`  | Used only during init                                |
| `MULTIPLAYER_OWNER_NAME` | `Owner`        | Used only during init                                |

Initialization writes `.multiplayer/owner-credential.json` with mode `0600`; it
**never prints the credential**. The directory and credential files are ignored
by Git. Keep the owner credential securely; this prototype has no recovery/rotation
workflow for a lost owner credential. Do not put credentials in CLI arguments,
logs, agent prompts or screenshots.

For teammates on different machines, put the relay behind a **TLS reverse proxy**
and configure a dedicated HTTPS origin, e.g. `https://multiplayer.example.com`.
Only loopback HTTP is accepted by the plugin. The URL must be an origin, not a
subpath. A local URL alone will not connect colleagues on other machines.

The relay intentionally has no browser CORS surface and rejects Origin headers;
BB's plugin backend makes the requests. Do not expose the BB API, its plugin
HTTP token, or your local BB server to teammates. Configure proxy rate limits,
a body limit of 8 MiB, timeouts, no Authorization/body logging, filesystem access
controls and backups before deploying beyond a trusted pilot team. Run the relay
under a service manager for persistent hosting; SIGINT/SIGTERM shut it down.

### Connect the owner

1. Open **Multiplayer** in BB navigation.
2. Enter the relay URL and explicitly select the local project.
3. Choose **Use member credential** and paste the `token` field from the private
   credential file yourself. Do not send that file to teammates.
4. Connect. No thread is published just by connecting the project.

### Connection troubleshooting

The plugin checks `/health` without sending a credential or invitation before
connecting. This catches a wrong virtual host or stale DNS record; it does not
replace TLS authentication. HTTP/HTML errors now show their status and a DNS/VPN
hint rather than a generic “Invalid relay response”. Response bodies are never
included in errors.

If connection returns `HTTP 502 (HTML)` after changing DNS:

- Compare the OS/VPN resolver's answer with the domain's authoritative DNS.
  Public resolvers may already have the new record while a VPN resolver retains
  the old address until its TTL expires.
- Wait for that resolver's TTL or ask its operator to flush this domain. Flushing
  only the local OS cache cannot clear an upstream resolver's stale cache.
- Do not disable TLS, switch to an insecure IP URL, or change global DNS/VPN
  configuration just to bypass the problem. Any temporary hosts-file override
  should be explicitly approved and removed after DNS converges.
- Paste only the `token` string, not the entire owner credential JSON file.
  Whitespace around the token is trimmed; JSON/quoted credentials are rejected
  before any network request.

### Connect a teammate

1. Owner selects **Invite teammate**, copies the one-use code and privately sends
   it and the relay URL to the intended person.
2. Teammate installs the plugin in their own BB.
3. On Multiplayer, they select their own local checkout/project, enter their name
   and invitation code, then connect.
4. A new member-specific credential is stored in that BB's **secret settings**.
   Only its SHA-256 hash is stored by the relay. Treat the invitation as a bearer
   credential: whoever redeems it first becomes the member.

Use a separate membership per BB installation in this prototype. Restoring a
credential on another BB restores reading/commenting access, not ownership of
local agent session processes or the original installation's sharing links.

### First collaboration

1. In a local thread, click the floating **Team** button (or composer `+` →
   **Team discussion**).
2. Review the conversation, tick the sharing consent checkbox and enable sharing.
3. The other participant sees it on their Multiplayer page after the next sync.
4. They select text or click **Comment**, post, and optionally reply/resolve.
   Locally, the native message action **Discuss with team** opens the widget with
   the selected quotation.
5. The local owner sees the comment in the widget, selects it and adds it to the
   agent's draft, reviews that draft, then sends it when ready.

The widget is a non-modal public SDK `experimental_appOverlay`, not injected DOM
under timeline rows. It follows the focused thread; explicit message actions
carry their own thread ID. The header names that thread. On switching threads,
unsent widget drafts are cleared, never transferred to another discussion.
Minimizing/reopening within the same thread preserves the draft. Reloading the
page/plugin discards it. Plain Enter adds a newline; Cmd/Ctrl+Enter posts only the
team comment. The native agent composer is never replaced, locked or submitted.
The badge is the total comment count, not an unread counter.

## Data and trust boundaries

```text
Local BB + plugin ── outbound HTTPS ── shared relay ── outbound HTTPS ── colleague's BB
   local agent / keys                    published context                 local agent / keys
```

- One connection maps **one local project** to **one team room** per BB instance.
  Membership, not a matching Git remote, grants access.
- Local SQLite: connection metadata, sharing links, pending snapshots, cursor,
  cached team threads/comments. Credential: BB secret settings, not SQLite or
  frontend storage.
- Relay SQLite: room, membership/token hashes, invitation hashes, current shared
  snapshots, comments and an append-only change-reference log. Every operation
  checks membership; only a thread's publishing member may update its snapshot.
- A shared snapshot contains **title, status and a bounded preview of human and
  assistant message text**. Tool results, reasoning/tool rows, internal agent
  messages, attachments, files, host paths and provider credentials are not
  deliberately exported. **Message text itself can contain secrets or paths.**
  There is no automatic redaction: review before enabling sharing.
- Other members' comments and transcript text are untrusted data. UI renders plain
  text (no remote HTML, Markdown image fetches or model directives). Feedback is
  labeled and JSON-quoted in a draft; this is not a guarantee against prompt
  injection, so the owner must review it.
- “Pause” stops future publication and discards pending unsent snapshots.
  **It does not retract data already received by the relay or teammates.**
- “Disconnect” clears this installation's connection/cache/sharing links and
  secret setting. It does not revoke the server credential or remove published
  content. Reconnecting requires a saved credential or a new invitation.
- Revocation blocks future authenticated requests and the plugin clears its cache
  upon the next 401. Already downloaded data cannot be recalled, and an offline
  or modified client can retain it.
- The relay operator can read shared data. **No end-to-end encryption**, SSO, or
  third-party identity verification. Member names are self-chosen labels.
- Code remains in Git. Local worktrees, terminal access and execution state are
  not synchronized.

## Current limits / intentionally not shipped

This is a pilot, not a production-hardened multi-tenant service.

- Near-live **2-second polling**, not WebSocket/token-by-token streaming.
  Event-triggered local reads; no lifecycle state polling. Reconnect/startup
  reconciles opted-in threads, and cache updates + cursor commit atomically.
- Presence means “this BB recently contacted the relay,” **not human activity**.
  Offline members' agent statuses are explicitly labeled last known.
- Up to 100 recent messages/timeline segments per shared snapshot, 16,000
  characters per message; older context is not a complete mirrored history.
  The UI shows truncation. Hashes/quotes keep discussion anchors meaningful.
- UI shows latest 200 shared threads and a preview of up to 200 comments per
  thread. Recent replies reserve space for their root, so the preview never
  drops an available root while showing its replies. Missing roots during sync
  appear as explicit placeholder branches. Some older replies/branches can be
  outside the preview. Relay list/event APIs are paginated. Max 100 memberships
  (including revoked accounts) per room.
- Outbound snapshots retry after disconnection. Comment form text remains mounted
  after an error and an unchanged retry reuses its request ID. There is **no
  durable offline comment outbox**; reload can lose an unsent draft.
- Single-process SQLite relay, no event-log compaction, quotas per member,
  production load/security audit, distributed deployment or turnkey hosting.
- No mention inbox, push notifications, diff-line comments, “continue locally,”
  session transfer, file sync, E2EE, content deletion or owner recovery UI yet.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

Tests exercise the real HTTP relay and SQLite with two independent official BB
fake plugin hosts, including opt-in export, stable message IDs, contextual
comments, safe draft-only handoff, access control, invitation expiry/reuse,
revocation, replay after a lost acknowledgement, reload/cursor recovery, stale
anchors, CAS resolution, bounded pagination, deleted/unavailable threads, shutdown
cancellation and frontend registration/rendering. Live BB install/onboarding is
checked separately; no real team conversation is shared during those checks.

## Source map

- `server.ts` — plugin RPC, events, sync service, authorization of local sharing.
- `app.tsx` — onboarding, team page, floating discussion, feedback-to-draft UI.
- `components/floating-discussion.tsx` — movable, keyboard-accessible widget chrome.
- `components/discussion-list.tsx` — grouped roots/replies and resolved branches.
- `shared/discussions.ts` — deterministic grouping and parent-preserving previews.
- `lib/discussion-target.ts` — ephemeral thread-scoped message-action targets.
- `plugin/` — relay client, local persistence, allowlisted message projection.
- `shared/protocol.ts` — runtime-validated wire schemas.
- `relay/` — standalone HTTP service, authentication and persistence.
- `tests/` — protocol, two-BB integration and UI contract tests.
