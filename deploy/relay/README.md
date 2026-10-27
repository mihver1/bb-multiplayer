# Self-hosted playground deployment

## v0.3.0 release

The v0.3.0 relay is API/schema-compatible with v0.2.0. Native mirrors run inside
BB's plugin/host artifact; no model or native agent process runs on this relay.
Upgrade only the `relay` Compose service after making a consistent database
backup, preserve the existing data directory, and keep the previous image/source
for rollback. Version-specific deployment evidence belongs in the private
`/opt/bb-multiplayer-playground/releases/v0.3.0` directory, not Git. No nginx or
firewall changes are needed.

## Existing protocol / upgrade history

The v0.2.0 relay adds owner message requests (additive SQLite tables and
`/v1/message-requests`, `/v1/message-request`, `/v1/review-request`,
`/v1/request-events`). The image includes `shared/requests.ts`. Before deploying,
back up SQLite consistently and recreate only the relay service. Old clients
remain compatible because request events do not enter the v1 conversation feed.
The release image is `bb-multiplayer-relay:0.3.0`; retain the previous image and
source backup for rollback. Never rerun `init` or replace the existing data directory.

## Live deployment

- Origin: **https://multiplayer.selfhost.ru**
- Host: `91.218.247.96` (`bulker`), Debian, existing Docker + nginx.
- Deployment root: `/opt/bb-multiplayer-playground`.
- Source root: `/opt/bb-multiplayer-playground/source`.
- Compose file: `source/deploy/relay/compose.yaml`.
- Container: `bb-multiplayer-playground-relay-1`.
- Data: `source/deploy/relay/data/` (directory `0700`, DB/credential `0600`).
- Private owner credential: `source/deploy/relay/data/owner-credential.json`.
- New vhost only: `/etc/nginx/sites-available/multiplayer.selfhost.ru`, linked
  from `sites-enabled`. Existing vhost files were not edited.
- TLS reuses the existing managed `*.selfhost.ru` wildcard, not a copied key.
  Certificate observed during deployment expires **2026-11-24**; the existing
  renewal mechanism must continue to maintain it. No renewal config was changed.

The public root is a connection/help page, **not a standalone collaboration UI**.
Use the Multiplayer plugin in each person's own BB. Public API requires each
member's credential; only health and invitation redemption are unauthenticated.

## Isolation

Pinned official Node image + separate locked runtime dependencies. SQLite uses
an upstream Linux prebuild for the pinned Node ABI. No host Node installation,
apt installation, firewall changes, Docker daemon changes or existing container
restarts were needed. Docker creates only this Compose project's bridge network
and loopback port mapping.

Runtime: UID/GID 1000, all capabilities dropped, no-new-privileges, read-only root,
32 MiB tmpfs, 384 MiB RAM / 0.5 CPU / 96 PIDs, bounded Docker logs, restart policy
`unless-stopped`. Only `127.0.0.1:4789` is published. nginx exposes HTTPS 443 and
redirects HTTP 80, with per-IP request/connection limits and an 8 MiB body limit.
The relay does not trust forwarded headers; its additional limiter sees the
proxy as a single source. This is adequate for a small pilot, not a large team.

No new automated backups or disk quotas have been configured. SQLite and the
change log can grow; keep this deployment for pilot data until retention, backups
and operational monitoring are agreed. Authentication is not E2EE: the server
operator can read published content. No real project conversation was published
as part of deployment verification.

## Connect the owner

1. Open Multiplayer in BB, enter `https://multiplayer.selfhost.ru`, and choose the
   intended local project.
2. Choose **Use member credential**. Retrieve the private file over SSH/SCP and
   copy only its `token` field into the UI yourself. Do not paste it into an agent
   conversation or put it in command arguments. The owner is named `Mikhail` and
   the room `Multiplayer Playground`.
3. Invite other members through **Invite teammate**, sharing their one-use codes
   privately. Never share the owner credential.
4. Thread sharing remains off until explicitly enabled in each thread's Team widget.

For example, download to a private, ignored local directory without displaying
its contents:

```sh
umask 077
mkdir -p .multiplayer
scp root@91.218.247.96:/opt/bb-multiplayer-playground/source/deploy/relay/data/owner-credential.json \
  .multiplayer/playground-owner-credential.json
chmod 600 .multiplayer/playground-owner-credential.json
```

DNS may remain cached briefly. Public resolvers `1.1.1.1` and `8.8.8.8` resolved
the host to `91.218.247.96` at deployment. Do not use plain HTTP or disable TLS
verification to bypass a stale DNS cache.

## Inspection (read-only)

On the server:

```sh
cd /opt/bb-multiplayer-playground/source
C=deploy/relay/compose.yaml
docker compose -f "$C" ps
docker compose -f "$C" logs --tail=50 relay
curl --fail http://127.0.0.1:4789/health
curl --fail https://multiplayer.selfhost.ru/health
nginx -t
```

Public diagnostic while a local resolver is stale, still validating TLS:

```sh
curl --resolve multiplayer.selfhost.ru:443:91.218.247.96 \
  --fail https://multiplayer.selfhost.ru/health
```

## Stop / start / update

These commands affect only the playground, never run unscoped Docker prune,
`compose down -v`, or restart nginx/Docker to manage it.

```sh
cd /opt/bb-multiplayer-playground/source
C=deploy/relay/compose.yaml
# Stop the relay, retaining image, data and config:
docker compose -f "$C" stop relay
# Start only this service and wait for health:
docker compose -f "$C" up -d --no-build --wait --wait-timeout 60 relay
```

Before updating, make a consistent SQLite backup and record the current image
ID. Copy only the source files; **do not replace or delete `deploy/relay/data`**.
Rebuild this service, test, then recreate only `relay`. Pin/record the previous
image for rollback. Never rerun `init` for the existing database.

## Remove public routing without deleting data

Only after operator approval:

```sh
unlink /etc/nginx/sites-enabled/multiplayer.selfhost.ru
nginx -t && systemctl reload nginx
cd /opt/bb-multiplayer-playground/source
docker compose -f deploy/relay/compose.yaml stop relay
```

The available vhost file, private data, source and image remain for recovery.
Do not remove any other nginx symlink or change the wildcard certificate.

## Deployment verification / pre-existing issues

Baseline and final non-secret evidence is saved on the host:
`/opt/bb-multiplayer-playground/baseline.json`, `verification.json`,
`nginx-test.log`, and build logs. Existing nginx config hashes matched after the
change. nginx master PID stayed unchanged (graceful reload). All 7 original
containers retained the same start timestamps and remained running.

Before and after deployment:

- `vw.selfhost.ru`, `nui-bulker.selfhost.ru`, `dns-b.selfhost.ru`: HTTPS 200.
- `copy.selfhost.ru`: HTTPS 502 **already present before deployment**; untouched.
- nginx warning about duplicate `dns-b.selfhost.ru` on 80/443 **already present**;
  untouched.

For v0.2.0, the upgrade's baseline, consistent database backup, old source/image
reference, and verification records live in the private release directory
`/opt/bb-multiplayer-playground/releases/v0.2.0`. The deployment does not require
an nginx reload or firewall changes. Preserve backups; they contain private data.

Health/readiness and unauthenticated rejection were checked over public HTTPS
with certificate verification. Initial immediate request during graceful reload
hit the previous nginx worker routing; subsequent HTTPS health checks returned
200, with an empty new-vhost error log.
