# fanbox-level-manager

Tools for managing Sayosomi Lab's FANBOX supporter lottery entry counts.

The product consists of a Mac-local admin web application and a supporter-facing
Cloudflare page for viewing current entry counts and entry-count history. Both
paths are implemented and in production use.

## Normal production startup

From the repository root, build after pulling or changing source:

```sh
npm run build
```

Then start the Mac-local admin:

```sh
npm run admin:production
```

If prompted, the Human enters the production portal sync token directly into
the hidden terminal prompt. Open:

```text
http://127.0.0.1:4310
```

For routine restarts with an already-current build, `npm run admin:production`
is sufficient. Normal admin startup does not deploy the Cloudflare Worker or
run D1 migrations.

Never paste the production sync token or a personal supporter portal URL into
ChatGPT, Luna, GitHub, documentation, logs, screenshots, or another agent
session.

See [docs/PRODUCTION.md](docs/PRODUCTION.md) for the full production operator
runbook, including restart, health checks, Worker deployment, and D1 migration
rules.

## Documentation

Durable product behavior is defined by [docs/SPEC.md](docs/SPEC.md). Current
work and implementation contracts are tracked in this repository's
[GitHub Issues](https://github.com/sayosomi/fanbox-level-manager/issues).

Development authority and shared workflow routing are defined by the fixed
[fanbox-level-manager project context](https://github.com/sayosomi/dev-context/blob/main/projects/fanbox-level-manager/README.md).

## Development

Use Node.js 24 and install the locked dependencies:

```sh
npm ci
```

The repository checks are available from the root:

```sh
npm run build
npm run lint
npm run typecheck
npm test
```
