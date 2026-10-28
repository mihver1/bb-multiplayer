# Multiplayer for BB · Experimental

**Independent BB installations. Shared project contexts, kept separate.**

A working first slice of team collaboration: opt-in live conversation previews,
contextual comments, replies, resolution, presence and deliberate handoff of
feedback to the local agent's draft. No remote control of someone else's agent.

## New in v0.4.2: native views and automatic synchronization

Opening a shared conversation now opens its native BB view by default. Existing
mirrors are reused; a new view uses the only machine automatically or asks you to
choose if several are available. Your own shared conversations open the original
local thread. **Open source & discussions** keeps the read-only preview accessible.

Open native views check for updates every **2 seconds**, using existing BB realtime
signals as well. Unchanged snapshots create no refresh turns. Checks pause in hidden
browser tabs or while the BB socket reconnects, and stop when the view closes.
No relay update is needed. A saved `nativeMirrors: false` setting is respected.

## Introduced in v0.4.1: appoint administrators

A room owner can appoint or remove administrators in **Multiplayer → Team project
→ Administrators**, with explicit confirmation. Appointed teammates can use their
existing membership to create and connect rooms for other local projects. The
owner no longer needs to create every room for them. Update both relay and plugin
to use administrator controls; older versions keep normal collaboration working.

## Introduced in v0.4.0: create rooms from Multiplayer

Owners can now create a room for another local project from the UI, without SSH
or copying a new token. Both the plugin and relay need this update; older relays
keep existing sync working and show an upgrade message for room creation.

## Introduced in v0.3.1: a room per local project

One BB installation can now keep multiple projects connected at once, each to its
own room on the same relay or on different relays. Select **Team project** on the
Multiplayer page to connect or manage that project's room. The sidebar groups
shared threads under their local projects; thread discussions use the thread's
own project automatically.

Connections, secret credentials, sharing links, caches, event cursors, presence
and errors are project-scoped. Disconnecting or losing membership in one project
does not clear another. Existing single-project plugin data and its secret are
migrated automatically on first use; do not disconnect or rerun relay `init` to
upgrade. Back up plugin storage and secret settings together before upgrading;
the local SQLite migration is forward-only (an older plugin needs its matching
backup). Existing v0.3.0 native mirrors and import ledgers are retained and mirror
operations use their own project's connection. The relay wire protocol remains v1.

## Introduced in v0.3.0

- **Native thread view:** opt-in Multiplayer Mirror provider, no model or code
  execution. Open a teammate's shared view → **Open native view**, select a machine,
  and use the native composer to propose text to its owner.
- Durable import receipts prevent normal reconnect/retry duplication. Uncertain
  partial imports fail closed; source edits append explicitly labelled versions.
- **Sidebar project actions restored:** settings, rename, and confirmed removal
  from hover, keyboard and context menus. Local child-thread grouping and compact
  archive controls from v0.2.1 are retained.
- Matching host/provider artifact, relay packaging and regression tests ship in
  this release. Relay APIs remain compatible with v0.2.0 clients.

Native mirrors are now enabled by default. If previously disabled explicitly,
enable **Enable experimental native thread mirrors** in Multiplayer settings (or
`bb plugin config multiplayer set nativeMirrors true`). This enables the native
view, not automatic sharing, agent execution, attachments, or provider switching.
See the limitations below.

## Introduced in v0.2.1

- Compact archive/archive-off glyphs beside search, with hover/focus tooltips.
- A consistent background across the thread list and search toolbar.
- Project-header chevrons that indicate expanded/collapsed state.
- Local child threads grouped beneath their parents with nested indentation.

This is a UI-only update; relay v0.2.0 remains compatible.

## Introduced in v0.2.0

The **Multiplayer thread-list replacement** and **message proposals to thread
owners** require plugin and relay v0.2.0 or later for the full workflow.

- Connected projects include remote shared rows with the Multiplayer glyph.
  Local rows use native navigation, menus, draft/status and split controls.
- Remote rows now open a native **Multiplayer Mirror** by default. The plugin-owned
  **read-only shared conversation** remains the source/discussion view and fallback.
  Both proposal composers send a request to the owner, not an agent instruction.
- Owners receive a BB toast and a review banner in the owning local thread:
  **Add to my draft** or **Dismiss**, never automatic agent submission.
- The relay must be upgraded for proposals. Older relays keep conversation/comment
  sync working and show proposal submission as unavailable. Requests use a
  separate event feed and are visible only to their author and thread owner.
- The list groups local parent/child threads under projects; builtin section and
  environment organization is not yet replicated. Enabling it may select it;
  **Settings → Appearance → Sidebar** can pin the builtin list instead.

## Experimental native thread view

The native **Multiplayer Mirror** provider bridge is enabled by the `nativeMirrors`
setting (on by default, saved opt-outs respected). Opening a teammate's shared
conversation creates or reuses an isolated local BB thread. With multiple machines,
choose one; with a sole machine, it is selected automatically. Open views import
new observed message versions automatically; native composer text becomes an owner
proposal, never an agent execution. Credentials stay server-side.

Imports are acknowledged only after canonical BB events persist; reconnects
reconcile the pending batch rather than duplicate it. Partial/uncertain writes
stop safely for recovery. Source edits append labelled versions, and remote
bodies are plaintext-quoted to prevent local rendering of active directives/images.
Native provider-observed user rows may be collapsed by BB. This is a bounded
preview, not a full agent-session replica. Only open, visible views poll; closed
mirrors do not import in the background. Token streaming and native message-anchor
mapping are not yet implemented.

The native provider was verified using a separate temporary provider/plugin and
synthetic loopback relay, then cleaned up. See [docs/native-mirror.md](docs/native-mirror.md)
for setup, recovery semantics, safeguards, and remaining two-machine verification.

## Collaboration features

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
- **Self-hosted relay:** multiple isolated project rooms on one server and SQLite
  database, per-room owner/member credentials, one-use invitations (24-hour expiry)
  and revocation.
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

Install the pinned release on another BB installation:

```sh
bb plugin install git:https://github.com/mihver1/bb-multiplayer.git@v0.4.1
```

If Multiplayer is already installed from a local path or a different tracked
source, do not remove its stored data to switch versions. Update that source or
checkout and reload the plugin. Select **Multiplayer threads** in **Settings →
Appearance → Sidebar** if another list provider is pinned. Join with a new
invitation so each laptop has its own member identity; do not reuse the owner's
credential on the second machine to simulate a teammate.

For source development:

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
through `bb plugin rpc` for diagnostics. `status` without input returns the
connection inventory; use `{ "projectId": "proj_..." }` for one project's status,
invite, disconnect or sync. Unscoped `sync` checks all projects; unscoped room
mutations/read-detail calls are rejected when multiple connections exist. Remote
thread/comment/request RPC inputs accept `projectId`; local thread actions derive
it from the BB thread. New navigation links include `project/<id>/thread/<id>`;
legacy `thread/<id>` links require a single unambiguous connection.

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
| `MULTIPLAYER_ROOM_NAME`  | `Our project`  | Name for `init` / `create-room`                       |
| `MULTIPLAYER_OWNER_NAME` | `Owner`        | Owner name for `init` / `create-room`                  |

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

### Multiple projects on one relay

Each project is a separate **room** with its own owner, members, invitations,
threads, comments and owner-request feed. All rooms use the **same relay origin**,
process and SQLite database. The member credential (or invitation during joining)
selects the room; clients cannot select another room by passing its ID.

#### Create from the UI (recommended after initial setup)

1. On **Multiplayer → Team project**, select an unconnected local project.
2. Choose **Create new room**.
3. Select an existing **owner or administrator connection**. Its relay URL is used automatically;
   it is not necessary to paste credentials or change the source project.
4. Enter a room name and press **Create room and connect**.

The new room has its own owner identity and credential; the display name is
inherited from the selected creator. Other members, comments and threads are **not
copied**, and no conversation is published automatically. The selected target
project connects to the new room; other project connections are unchanged.

Only authenticated, non-revoked **owners or appointed administrators** can create
rooms; ordinary members and anonymous callers cannot. Owning a room does not grant access to other rooms or
the server-wide room inventory. Remote creation is capped at 100 total rooms per
relay (including rooms provisioned locally), with a separate 10-requests/minute
per-source-IP limit; behind a proxy that IP may be shared by the whole team.
The local operator can still provision rooms above this remote cap.

The plugin generates and saves the new credential in **BB secret settings before
requesting creation**. Only its hash is sent in the creation body; the response
contains IDs, not a token. The relay stores an idempotent creation record. A lost
response or plugin reload leaves a saved **Retry room creation** action, which
finishes the same operation instead of making a duplicate. Keep the original
creator connection and the target project's secret settings while retrying. A
pending target cannot be connected to another room or cleared via Disconnect,
and its original creator connection cannot be disconnected until creation finishes;
uncertain failures need retry/recovery, not discarded credentials. Newly created
credentials live in BB, not a new credential file on the relay: include secret
settings in backups.

A **fresh relay** still needs its initial `relay:init` and owner connection once;
there is deliberately no public anonymous room-creation endpoint.

#### Delegate room creation to a teammate

1. Invite the teammate and wait for them to join the room.
2. As that room's owner, open **Multiplayer → Team project → Administrators**.
3. Choose **Make administrator** beside the teammate, then **Confirm appointment**.
4. After their next sync, they can select an unconnected project and use **Create
   new room**, with their existing administrator connection. No replacement token
   or server access is needed.

**Remove administrator → Confirm removal** withdraws creation rights for that
membership immediately at the relay. A stale client cache cannot authorize a new
room. Assignment is scoped to a membership/credential, not every account with the
same display name or every installation belonging to that person.

| Permission in the source room | Owner | Administrator | Member |
| --- | --- | --- | --- |
| Create/connect a new project room on this relay | Yes | Yes | No |
| Appoint/remove administrators | Yes | No | No |
| Invite or revoke source-room members | Yes | No | No |
| Read another member's private owner requests | No | No | No |
| Browse/access unrelated rooms | No | No | No |

Existing publication, comment and owner-request rules are unchanged: administrator
status does not confer ownership of someone else's threads or agent control.
Administrators **own the new rooms they create**. Removing their source-room
administrator flag or membership does not retract those rooms or credentials;
they retain the normal owner rights of those new rooms, including room creation.
Grant this capability only to trusted teammates. This is not a global account
ban or an organizational super-admin role.

An in-flight creation whose acknowledgement was lost retains its token and request
ID. If its creator is demoted before retry, an owner must restore that membership's
creation rights to complete recovery; do not clear pending state or issue a second
creation. The retry returns the same room rather than creating a duplicate.

For protocol compatibility, v1 `role` remains `owner`/`member`. A new optional
`admin` flag and `capabilities.memberAdministration` describe the extension;
old clients ignore them and continue syncing. The relay adds `member_admins`
without changing existing membership rows. No one is promoted automatically.

#### Local operator alternative

`init` remains a one-time bootstrap and still refuses an existing database.
To provision another project locally, run this **on the relay host**, pointing at
the same `MULTIPLAYER_DATA_DIR` used by the running service:

```sh
MULTIPLAYER_ROOM_NAME="Billing" MULTIPLAYER_OWNER_NAME="Bob" npm run relay:create-room
npm run relay:list-rooms
# For another page, pass the non-secret nextCursor returned by list-rooms:
npm run relay:list-rooms -- <nextCursor>
```

- `create-room` can run while the relay is serving. It writes a new private
  `owner-credential-<roomId>.json` (mode `0600`) in the data directory, without
  printing the token or overwriting the original `owner-credential.json`.
  If the credential file cannot be written, creation is rolled back.
- Each invocation intentionally creates a new room and owner credential, even
  if the display names match. Names are labels, not access-control identities.
- `list-rooms` returns at most 50 room IDs/names and a nullable `nextCursor`.
  It never returns member credentials. The server-wide inventory remains
  **local operator only**; the authenticated `POST /v1/rooms` endpoint creates
  new rooms but cannot enumerate or administer someone else's rooms.
- Give the new room's owner their credential privately. They connect using the
  same server URL and invite only their own teammates. The 100-membership limit
  and revocation apply independently to each room.

Existing single-room databases need **no manual migration or reinitialization**:
the relay adds its creation-record and administrator-grant tables automatically. Old credentials,
invitations, history and cursors remain valid. Protocol v1 and
existing clients are unchanged. The updated plugin supports **one room connection
per local project**, with multiple projects connected simultaneously, including
rooms on different relays. Older plugin releases still support only one connection
per installation. No existing sharing is enabled.

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

Use a separate membership per project connection and BB installation. Restoring a
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

- Each local project maps to **one team room**, independently of other projects
  in the same BB instance. A relay can host multiple rooms at the same URL; projects
  can also use different relays. Credentials and invitations are room-specific;
  membership, not a matching Git remote or room name, grants access.
- Local SQLite: project-scoped connection metadata, sharing links, pending snapshots,
  cursors and cached team threads/comments/requests. Credentials: a project-keyed
  map in BB secret settings, never SQLite or frontend storage. Remote IDs are scoped
  by local project so identical IDs from different relays cannot mix.
- Relay SQLite: rooms, membership/token hashes, invitation hashes, current shared
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
- “Disconnect” clears **only the selected project's** connection/cache/sharing
  links and credential. Other projects keep syncing. It does not revoke the server
  credential or remove published content. Reconnecting requires a saved credential
  or a new invitation; sharing must be enabled again explicitly.
- Revocation blocks future authenticated requests and the plugin clears only that
  project's cache and connection upon the next 401. Already downloaded data cannot be recalled, and an offline
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
- UI shows latest 200 shared threads per connected project and a preview of up to 200 comments per
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
  Native mirrors sync while open and append revisions; they do not import hidden
  model state or erase already downloaded history. Manual Refresh remains available
  for retry; uncertain partial imports still require recovery.

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
cancellation and frontend registration/rendering. Multiproject tests cover real
cross-room HTTP denials, isolated feeds and pagination, per-room membership limits,
legacy database reopening, private credential creation/rollback, local CLI commands
and simultaneous plugin connections to one or multiple origins. Plugin tests cover
legacy migration and retry after secret-store failure, identical IDs across relays,
project-scoped disconnect/revocation, moved local threads, UI selection and links.
Room creation tests cover owner/admin HTTP authorization, streamed-body revocation,
rate/room caps, secret-store failures, lost acknowledgements, durable retries,
no automatic sharing and UI onboarding without token copying. Administrator tests
cover appointment/removal, stale permissions, cross-room and self-promotion denials,
non-delegation, legacy client/schema compatibility, persistence and confirmed UI actions.
Live BB install/onboarding is
checked separately; no real team conversation is shared during those checks.

## Source map

- `server.ts` — plugin RPC, events, sync service, authorization of local sharing.
- `app.tsx` — onboarding, team page, floating discussion, feedback-to-draft UI.
- `components/floating-discussion.tsx` — movable, keyboard-accessible widget chrome.
- `components/team-thread-list.tsx` — local/team sidebar replacement.
- `components/message-requests.tsx` — proposal composer, inbox toast and owner review.
- `shared/requests.ts` — separate request protocol and schemas.
- `provider/` and `host.ts` — native mirror provider, isolation and durable import ledger.
- `components/discussion-list.tsx` — grouped roots/replies and resolved branches.
- `shared/discussions.ts` — deterministic grouping and parent-preserving previews.
- `lib/discussion-target.ts` — ephemeral thread-scoped message-action targets.
- `plugin/` — relay client, local persistence, allowlisted message projection.
- `components/create-room.tsx` — owner/admin-authorized room creation and retry UI.
- `components/member-administration.tsx` — owner-only appointment/removal UI.
- `plugin/room-creation.ts` — non-secret pending-creation metadata.
- `shared/rooms.ts` — room-creation wire schemas.
- `shared/protocol.ts` — runtime-validated wire schemas.
- `relay/` — standalone HTTP service, authentication and persistence.
- `relay/admin.ts` — local-only room provisioning with private credential files.
- `tests/` — protocol, two-BB integration and UI contract tests.
