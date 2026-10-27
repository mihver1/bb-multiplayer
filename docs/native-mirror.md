# Native Multiplayer thread view — implementation boundary

## Implemented in v0.2.0

- `components/team-thread-list.tsx`: public `experimental_threadList`, local
  navigation/menus and remote shared rows grouped by the explicitly connected
  local project. Shared rows use the Multiplayer glyph. Local shared threads are
  not duplicated. Hidden local threads remain hidden. Lists are rendered in
  bounded batches; archived paging uses BB's hook.
- Remote rows currently open **the plugin-owned read-only conversation view**,
  not a native executable BB thread. A clearly labelled proposal composer sends
  only a durable owner-review request.
- `shared/requests.ts`: request IDs, authenticated author/actual thread owner,
  pending/drafted/dismissed states and optimistic version checks.
- Separate `/v1/request-events` feed so existing protocol-1 clients do not fail
  on a new conversation event kind. Older relays disable proposals but continue
  normal conversation/comment sync.
- Owner notification + local composer banner, explicit Add to my draft/Dismiss.
  Existing drafts are appended to, never replaced or submitted. The request's
  body is JSON-quoted as untrusted teammate data.

## What the provider experiment demonstrates

`provider/mirror-projection.ts` and its assembler test use the installed public
SDK (0.6.49), not private imports. Grammar v3 supports `input.provider` for an
externally observed user message and `agentMessage` items for the answer. A
native mirror does **not** need a pretend ACP process: a BB provider bridge is
sufficient. No provider or host entry is registered in this slice.

Relevant upstream contracts, checked before implementation:

- https://github.com/get-bb/bb/blob/main/docs/provider-plugin-api.md
- https://github.com/get-bb/bb/blob/main/docs/provider-bridge-protocol.md
- https://github.com/get-bb/bb/tree/main/examples/plugins/echo-provider

The public assembler owns and mints turn/item IDs. `session.reset` resets its ID
space; it does not replace the persisted BB timeline. Replaying the same remote
snapshot after a fresh session construction creates more history. The current
relay protocol stores only a bounded current snapshot (100 messages, some text
truncated), not a durable remote event log suitable for exactly-once imports.
There is no public plugin operation to replace arbitrary canonical thread history.

## Required before activating a native mirror provider

1. **Durable mirror identity**: server-owned mapping of room/member/sharedThread
   to local BB thread, environment and import cursor. Metadata is not an auth
   boundary. Create on explicit open, recover interrupted creation without duplicates.
2. **Canonical import semantics**: stable remote message/version IDs and a
   host-supported history-upsert/import surface (or an explicitly append-only
   remote history with revisions displayed as such). Resume must never replay
   already imported items. Do not claim current snapshots are complete history.
3. **Live updates**: owner edits, deletes, stops sharing, archive and member
   revocation need defined handling, including already cached native content.
   A provider lifetime cannot silently keep importing after release/stop.
4. **No execution**: disable tools, file/terminal access, compaction/fork/goals;
   server admission hook must reject provider switching on a mapped mirror and
   prevent mirrors from being published back into the same room (sync loops).
5. **Submit → proposal**: route the mirror's text submission to the existing
   owner-request API, using client request IDs for retry deduplication. Do not
   silently upload local attachments or resolve mentions into private file data.
   Owner acceptance is only draft insertion, not an agent turn.
6. **Secure bridge transport**: relay/member credentials must never go in
   `deriveProviderOptions` or environment diagnostics. Prefer BB-authenticated
   host RPC/dynamic-tool calls narrowly gated by the mirror's actual provider,
   mapping and membership. Provider options may contain only non-secret IDs.
7. **Conformance and real two-instance verification**: history replay, disconnect,
   double-open, edit races, runtime restart, revoke, provider switch, request
   duplicate prevention, drafts and split-pane targeting. Verify on separate BB
   servers, not just two browser windows of one BB.

## Pilot limits of the implemented UI slice

The list is a simplified alternative, not a fork of every builtin sidebar feature:
project grouping, pinned-first order, search, native menus, draft/status markers,
split drag and archived loading are present; arbitrary section/tree/environment
organization is not yet reproduced. Installing/enabling a thread-list slot can
select it automatically; announce the change before enabling it in an ongoing BB
session. Appearance settings can pin the builtin list instead.

Notifications are local BB toasts/banner, not OS push. A mounted banner deduplicates
insertion after a lost review acknowledgement; a page reload between insertion
and acknowledgement is not exactly-once (draft and relay are separate stores).
The user must inspect the draft in that case. Attachments, automatic owner sends
and native mirror activation are intentionally not shipped yet.
