# fanbox-level-manager

Tools for managing Sayosomi Lab's FANBOX supporter lottery entry counts.

The product consists of a Mac-local admin web application and a supporter-facing
Cloudflare page for viewing current entry counts and entry-count history.

## Current status

The repository now contains the implemented Mac-local admin product path and the
supporter-facing Cloudflare Worker/portal product path. Production launch
configuration and provisioning remain separate work. Durable product behavior is
defined by [docs/SPEC.md](docs/SPEC.md), and current implementation contracts
are tracked by GitHub Issues.

Production deployment readiness guidance is documented in
[docs/PRODUCTION.md](docs/PRODUCTION.md).

Read the [product specification](docs/SPEC.md) for durable requirements. Current
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
