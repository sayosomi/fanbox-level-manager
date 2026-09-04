# Development instructions

Route all development work through and read this repository's `README.md` and the fixed
[fanbox-level-manager project context](https://github.com/sayosomi/dev-context/blob/main/projects/fanbox-level-manager/README.md).
Load the shared documents routed from that entrypoint when their topics apply:

- `shared/DEVELOPMENT.md` for the common development workflow and loading rules;
- `shared/GIT-WORKFLOW.md` for remote state, checkout, branch, commit, push, and review work;
- other shared owners routed by the entrypoint as needed.

## Authority

- The latest remote `sayosomi/fanbox-level-manager` repository is authoritative for implemented repository facts.
- This repository's GitHub Issues are the primary Work and current implementation-contract authority.
- Versioned repository documents, including [`docs/SPEC.md`](docs/SPEC.md), are the durable product-requirements and design authority.
- Do not treat past chats, local copies, or dev-context project notes as current implemented facts when they conflict with the latest remote repository.

Route reusable development mechanics to the shared dev-context owners instead of
duplicating them here. Do not import nuinuiCAD-specific Linear workflow,
declared-lane semantics, E2E policy, or other nuinuiCAD product policy into this
repository.
