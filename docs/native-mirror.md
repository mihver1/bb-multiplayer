# Native Multiplayer thread view · Experimental, opt-in

Version 0.3.0 adds a native BB provider bridge, **Multiplayer Mirror**. It is
not an ACP shim and never calls a model, shell, filesystem tools or another
agent. The existing read-only shared view remains available; native mirrors
require explicit enablement and opening by the user.

## Try after building/installing this version

1. Enable **Enable experimental native thread mirrors** in Multiplayer settings.
2. Open a teammate's shared conversation and choose **Open native view**.
3. Select a machine explicitly. The plugin creates an isolated empty directory
   under its host data, not a worktree or the user's project checkout.
4. The created BB thread uses `multiplayer-mirror`. **Refresh shared preview**
   imports new observed message versions. Native composer text creates an owner
   proposal; the owner still reviews and sends their own draft separately.

No relay deployment is required: this uses the v0.2 request API. Native mirrors
start disabled. The provider may be visible in pickers, but arbitrary creation
is rejected; use the shared conversation's explicit open action. A mirror cannot
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
- `components/native-mirror.tsx`: explicit open/machine selection and a native
  composer banner explaining the non-executing owner-proposal behavior.

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

## Deliberate preview semantics and limits

- Refresh on explicit open/Refresh, not background continuous native streaming.
  Native runtime status reflects importing/proposing, not the remote agent's run.
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
- Each explicit refresh currently leaves a `/multiplayer-refresh` input row.
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
- Actual BB runtime smoke under a **separate temporary plugin ID**, with a loopback
  in-memory synthetic relay: native provider thread created, user and assistant
  rows persisted and visible through native timeline; failed confirmation recovered
  without duplication, then stop/resume confirmed one copy of each source message.
  Agent-origin proposal attempt was refused as intended. No model ran and no real
  team content or credentials were used. Smoke thread was stopped/archived and the
  temporary plugin and relay were removed/stopped afterward.

Still required before broad enablement: two-machine real-user composer proposal
and owner-review verification, revocation while an import is in flight, long-history
load testing, and a less noisy refresh UI. It is off by default on a new install;
the operator can enable it with `bb plugin config multiplayer set nativeMirrors true`.
