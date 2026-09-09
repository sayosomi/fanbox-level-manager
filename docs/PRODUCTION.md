# Production operations

This runbook separates three concerns:

1. reviewed repository source;
2. external Cloudflare bootstrap and provisioning; and
3. later Mac-local admin launch configuration.

## Safety

Production operations begin from a clean, reviewed, merged `main`. Before any
external mutation, verify that Wrangler is authenticated to the intended
Cloudflare account. Never commit secrets or account credentials. Never place the
sync credential in Git, URLs, Issues, documentation, or logs. Keep `.dev.vars*`
and `.env*` uncommitted.

Use the same logical credential for the Worker `SYNC_API_TOKEN` and the Mac
admin `FANBOX_PORTAL_SYNC_API_TOKEN`. Do not make a permanent plaintext secret
file the long-term storage policy. This slice does not define a Mac Keychain
contract.

## Reviewed repository source

Review and merge the Worker source and configuration from `main`. The committed
Worker configuration keeps the `DB` binding ID-less, declares the `migrations`
directory, and names `SYNC_API_TOKEN` as required without containing a secret
value or account-specific resource identifier.

The portal-worker package exposes explicit operator commands for deployment and
remote migration. They do not authenticate, create or generate secrets, combine
migration with deployment, create temporary files, or modify Mac configuration.
From the repository root, use `npm run deploy --workspace=@sayosomi/portal-worker`
for deployment and `npm run migrate:remote --workspace=@sayosomi/portal-worker`
for the later remote migration step.

## First production bootstrap

Perform the following later, as an external operator action, in this order:

1. Verify Wrangler is authenticated to the intended Cloudflare account.
2. Prepare a strong `SYNC_API_TOKEN` without committing or logging it.
3. Deploy the reviewed Worker source while supplying the required secret.
4. Allow Wrangler automatic provisioning to create or link the `DB` D1 resource
   from the ID-less committed binding.
5. Apply the repository D1 migrations remotely to binding `DB`.
6. Verify the deployed `/level` page.
7. Verify privacy-safe failure behavior at the admin-auth boundary without
   inserting real supporter data.
8. Inspect any account-specific mutation Wrangler wrote into the working-tree
   Wrangler configuration.
9. Treat any resulting real D1 resource ID change as a separate, reviewable
   repository change; do not silently mix it with other edits.
10. Later configure the Mac-local admin with the deployed portal origin and the
    same sync credential.

Automatic provisioning may write a real D1 resource ID into the operator's
working-tree Wrangler configuration during the later first deployment. That
account-specific mutation is not part of Issue #100.

## Mac admin production launch

After the portal is verified, start the Mac-local admin from a clean, reviewed,
merged `main` checkout:

1. Run `npm run build`.
2. Run `npm run admin:production`.
3. If prompted, paste the KeePass-held production token. Input is hidden.
4. Use `http://127.0.0.1:4310`.

The live database defaults to
`~/Library/Application Support/fanbox-level-manager/admin.sqlite3` and remains
local to the Mac. Encrypted backups continue using the existing configured
backup destination. The launcher never stores the token. Set
`FANBOX_ADMIN_DB_PATH`, `FANBOX_PORTAL_ORIGIN`, `FANBOX_ADMIN_PORT`, or
`FANBOX_PORTAL_SYNC_API_TOKEN` explicitly when an override is needed.

## Ongoing deployment order

For subsequent production changes, preserve this order:

1. Review and merge the source.
2. Apply required remote D1 migrations before relying on code that requires
   them.
3. Deploy with all required secrets configured.
4. Verify the supporter page and authenticated-admin boundaries.

There is no automatic CI/CD deployment.
