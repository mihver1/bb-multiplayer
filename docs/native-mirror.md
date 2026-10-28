# Native Multiplayer thread view · Experimental

Version 0.3.0 adds a native BB provider bridge, **Multiplayer Mirror**. It is
not an ACP shim and never calls a model, shell, filesystem tools or another
agent. Shared conversations now open in the native view by default when the user
opens their link. The read-only shared view remains available through **Open source
& discussions**. Opening a view does not enable sharing or run an agent.

## Try after building/installing this version

1. Open a teammate's shared conversation from the sidebar or Multiplayer page.
   Native mirrors are enabled by default; an explicitly saved `nativeMirrors: false`
   is respected and keeps the read-only view.
2. An existing mirror opens immediately. For a new mirror, the sole machine is
   selected automatically; with multiple machines, choose one. The plugin creates
   an isolated empty directory under its host data, not a worktree or the user's
   project checkout. Your own shared conversations open their original local thread.
3. The created BB thread uses `multiplayer-mirror`. Its preview synchronizes
   automatically while open; **Refresh shared preview** remains a manual retry.
   Native composer text creates an owner proposal; the owner still reviews and
   sends their own draft separately.

No relay deployment is required: this uses the existing v0.2 request API. The
provider may be visible in pickers, but arbitrary creation is rejected; open a
shared conversation instead. Archived remote threads keep the source view. A mirror cannot
become a regular agent through provider switching/forking, and cannot be shared
back to the room. These checks run on the server dispatch boundary, not just UI.

## Architecture and ownership

- `host.ts`: isolated empty-workspace RPC plus the provider bridge export.
- `provider/bridge.ts`: grammar-v3 lifecycle, native text, one internal dynamic
  tool transport, cancellation, explicit proposal result. No network or code
  execution in the bridge; all other injected tools are ignored.
- `provider/service.ts`: provider/environment registration, connection/ownership
  checks, local thread mapping, import confirmation and proposal routing.
- `provider/mirror-store.ts`: durable mappings and per-source version ledger.
- `provider/mirror-projection.ts`: bounded batches, safe plaintext projection,
  and verification against canonical persisted BB events.
- `components/native-mirror.tsx`: default native navigation/machine selection,
  a native composer safety banner, and visibility-scoped automatic synchronization.

The real member credential stays in the BB backend. It never enters provider
options, env or bridge IPC. The bridge calls only `multiplayer_mirror_io` through
BB's authenticated provider tool channel. Its handler checks the calling thread's
server-owned mapping, actual provider, project, connection identity and lifecycle.
Mutable plugin metadata is not an authorization boundary. Ordinary agents do not
receive this tool; forged direct calls without a mapped mirror fail.

The mapping is reserved before spawning. The first dispatch binds it only when
the plugin origin, dedicated environment ID, UUID and selected host agree. A lost
creation acknowledgement does not create a second local thread. An unbound
ambiguous reservation fails closed and requires operator recovery.

## Multiproject support in v0.3.1

Native mirrors retain their original local project. Opening a mirror uses an
explicit project connection; provider refresh/proposal calls derive it from the
server-owned mapping. The source/discussion link includes that project ID.
Disconnecting or revoking one project does not stop mirrors in another project.
Existing v0.3.0 mappings, pending imports and version ledgers survive the local
project-scoping migration; the shipped migration indices are unchanged.

## Persistence / reconnect contract

The server prepares one batch of at most four source messages and durably records
it **before** giving it to the bridge. The bridge emits the native messages and a
suppressed extension receipt in the same turn. A commit is accepted only after
BB's public events API shows the receipt **and every expected message**, in order,
in that same turn. Reads use the live API's maximum of 100 events per page.

Only then does the local version ledger advance. On reconnect or a lost commit,
the pending batch is checked against BB persistence again:

- persisted batch → acknowledge it, do not re-emit;
- partial/uncertain batch → stop with an error, **never replay automatically**.

This intentionally prefers a visible recovery requirement to duplicated or
silently missing messages. It is not a claim of transactional exactly-once writes
across two independent storage systems. Import recovery is bounded to 10,000
completed-item events; very long mirrors need a future checkpoint implementation.

`session.reset` starts fresh assembler IDs but **does not clear BB history**. The
ledger prevents re-import on normal resume; a new mirror is never seeded by
replaying the whole snapshot without checking it.

## Open-view synchronization

The mounted native banner checks immediately, then every **2 seconds after the
previous check completes**. Existing BB realtime `changed` signals feed the same
throttled check; polling recovers missed signals. Hidden browser tabs and a
reconnecting BB socket pause checks, and visibility/reconnect resumes them.
Unmounting or changing threads disposes timers/listeners. No closed mirror is
polled, and neither the local draft nor an owner's composer is submitted.

`refreshNativeMirror({ threadId, onlyIfChanged: true })` validates the current
mapping, membership and native runtime. It compares source message versions/roles
against the import ledger and starts an import only when something changed.
Concurrent calls for one mirror are coalesced. Busy, provisioning, offline-host
or queued-proposal states are skipped rather than accumulating refresh turns;
runtime errors require a manual retry. Pending imports still reconcile against
persisted BB events and uncertain batches never replay automatically. Connection,
setting and lifecycle checks run again before sending a refresh.

Source/discussion links end in `/source` to bypass native navigation and avoid
redirect loops. Source links, disabled native views and failed creation retain
the read-only preview. Failed creation is not automatically retried by realtime
signals; an ambiguous reservation continues to fail closed.

## Deliberate preview semantics and limits

- This is near-live polling, not token-by-token streaming. Native runtime status
  reflects importing/proposing, not the remote agent's run.
- Current relay snapshots contain at most 100 recent messages, sometimes truncated.
  This is an observed preview, not a full history import or a replica of an agent
  session. Intermediate edits not observed at refresh are not recoverable.
- Existing source messages edited later append **labelled new versions**, never
  silently replace earlier local content. Missing items are not considered deleted
  because a bounded window can legitimately omit them.
- Imported bodies are fenced plain text to stop remote Markdown images, links,
  plugin directives and executable fence renderers from activating locally.
  Native owner messages are provider-observed (`initiator: system`); BB may show
  them collapsed by default. Rendering and timestamps are BB's, not copied ids.
- Each actual import turn/manual refresh currently leaves a `/multiplayer-refresh`
  input row. Automatic checks with unchanged content create no turn or input row.
- Native message IDs differ from remote message IDs. Use **Open source & discussions**
  for anchored comments; mapping a local message action back to the remote anchor
  is not implemented yet. The floating widget can still show thread discussions.
- Attachments/mentions are rejected, not uploaded/resolved. Only human text can
  create proposals; automated agent-origin sends are refused. `/multiplayer-refresh`
  is a control command, never a proposal. A stable derived request UUID deduplicates
  proposal retries.
- Disconnect/revocation blocks only that project's mirrors; disabling the global
  native-mirrors setting blocks all mirrors and stops their runtime. No new
  remote data is fetched without membership checks. Revocation prevents future
  refresh/proposals; already imported native text remains in the local BB history.
- No destructive history purge, live withdrawal signal, mirror mapping repair UI,
  restore-after-disable workflow or automatic workspace cleanup yet. Empty plugin
  workspace directories are retained, not silently deleted. The generic BB terminal
  is still a local user capability; the provider never invokes it or exposes a
  teammate's terminal.

## Verification completed

- Official public bridge conformance: handshake, hygiene, start/stop/release,
  resume, turn lifecycle, native event schemas, presentation and zero-work turns.
- Unit/integration checks: per-member mapping, concurrent double-open, pending
  batch recovery, partial import fail-closed, actual event-page cap, source edits,
  remote Markdown quoting, attachment/provider-switch/fork/republish rejection,
  disconnect blocking and proposal idempotency.
- Default/source navigation, saved opt-out, machine selection, open-view polling,
  visibility/reconnect/unmount cleanup, concurrency, unchanged previews, source
  edits and fail-closed pending imports are covered by regression tests.
- Actual BB runtime smoke under a **separate temporary plugin ID**, with a loopback
  in-memory synthetic relay: native provider thread created, user and assistant
  rows persisted and visible through native timeline; failed confirmation recovered
  without duplication, then stop/resume confirmed one copy of each source message.
  Agent-origin proposal attempt was refused as intended. No model ran and no real
  team content or credentials were used. Smoke thread was stopped/archived and the
  temporary plugin and relay were removed/stopped afterward.

Still required for broader production validation: two-machine real-user composer
proposal and owner-review verification, revocation while an import is in flight,
long-history load testing, and a less noisy import UI. Native views are now on by
default; a saved opt-out can be changed with
`bb plugin config multiplayer set nativeMirrors true`.
