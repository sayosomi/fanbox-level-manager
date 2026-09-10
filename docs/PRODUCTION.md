# Production operations

This is the operator runbook for the production fanbox-level-manager setup.
The production system consists of the Mac-local admin application and the
supporter-facing Cloudflare Worker.

## Safety

Use a clean, reviewed `main` when updating production code. Never commit or
publish production secrets, account credentials, personal supporter portal
URLs/tokens, supporter identity mappings, or private production data.

Only the Human supplies the production portal sync token. When the local admin
prompts for it, enter it directly into that local hidden terminal prompt. Never
paste the token into ChatGPT, Luna, GitHub, Issues, documentation, logs,
screenshots, or another agent session. Do not ask an agent to wait for or
receive the Human token in its terminal/session.

The launcher supports `FANBOX_PORTAL_SYNC_API_TOKEN` as an environment override,
but persistent plaintext token storage is not the normal workflow.

## Normal Mac admin startup

Run from the repository root.

After pulling or changing source, build first:

```sh
npm run build
```

Start the production admin:

```sh
npm run admin:production
```

If prompted, enter the production portal sync token directly into the hidden
prompt. Then open:

```text
http://127.0.0.1:4310
```

For a routine restart when the checked-out source and build are already current,
`npm run admin:production` is sufficient.

Normal Mac admin startup does **not** deploy the Cloudflare Worker and does
**not** run D1 migrations.

## Stop and restart

The admin runs as a foreground process. Stop it normally in its terminal, for
example with Ctrl-C.

Restart with:

```sh
npm run admin:production
```

Enter the production portal sync token privately again if prompted. Do not
introduce a plaintext token file merely to avoid the prompt.

## Health check

With the admin running, check its local health endpoint:

```sh
curl -fsS http://127.0.0.1:4310/api/health
```

Expected successful response:

```json
{"status":"ok"}
```

## Local production state

The default production SQLite database is:

```text
~/Library/Application Support/fanbox-level-manager/admin.sqlite3
```

Encrypted backups use the backup destination configured through the existing
admin backup workflow.

Supporter/admin production data remains local to the Mac except for the
privacy-minimized supporter portal state intentionally synchronized to
Cloudflare. Do not place personal portal URLs, raw tokens, supporter identity
mappings, or backup key material in repository documentation or logs.

The default supporter portal origin used by the launcher is:

```text
https://fanbox-level-portal.sayosomi.workers.dev
```

The launcher also supports these explicit overrides when needed:

- `FANBOX_ADMIN_DB_PATH`
- `FANBOX_PORTAL_ORIGIN`
- `FANBOX_ADMIN_PORT`
- `FANBOX_PORTAL_SYNC_API_TOKEN`

Do not treat the token override as a recommendation to persist plaintext
secrets.

## After repository source updates

Before using newly reviewed code in production:

1. Update the local checkout safely to the intended reviewed `main`.
2. Confirm the worktree is clean and contains only the intended merged source.
3. Run `npm run build`.
4. Restart the local admin if the admin-side code changed.
5. Deploy the Worker only if the reviewed change affects the Worker and needs to
   be made live.
6. Run a D1 migration only when the reviewed change explicitly requires one.

A local-admin-only change does not require a Worker deployment. A Worker
presentation/copy-only change does not require a D1 migration. Do not treat
"source changed" as meaning every production operation must run.

## Worker redeploy

For a reviewed Worker change that needs to be made live, build from the intended
reviewed source and deploy the portal-worker workspace:

```sh
npm run build
npm run deploy --workspace=@sayosomi/portal-worker
```

After deployment, verify the public supporter page responds successfully, for
example by checking `/level` on the production portal origin.

There is no automatic production CI/CD deployment; merging a change does not by
itself deploy the Worker.

Worker redeployment is separate from ordinary Mac admin startup. Do not start
the local admin merely to deploy the Worker, and do not use a personal
supporter URL/token for a public deployment smoke check.

## D1 migrations

Run a remote D1 migration only when the reviewed change includes or requires a
checked-in D1 migration:

```sh
npm run migrate:remote --workspace=@sayosomi/portal-worker
```

Do not run this command for ordinary admin startup, routine restart, or a
Worker-only presentation/copy change. Do not compose or run ad hoc production
SQL.

When a reviewed release requires both a D1 migration and Worker deployment,
follow the operation order required by that specific reviewed change rather
than assuming a generic migration is always needed.

## Production operational boundaries

The production environment is already provisioned and operational. Routine use
is therefore normally just the Mac admin startup described above.

Supporter portal-link issuance and delivery are separate Human operations. They
are not part of startup, restart, Worker deployment, or D1 migration. Do not
issue, reissue, send, or mark supporter links sent merely as part of an
application startup or deployment check.
