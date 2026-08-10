---
title: Nanasa agent instructions
description: Repository-wide instructions for coding agents and delegated subagents
---

## Package Registry

The public npm registry is blocked in some development environments. Treat the
registry URLs in `.devcontainer/.env` as authoritative for every package-manager
operation.

Before running `npm`, `npx`, `pnpm`, or Corepack commands, load the environment
when the file exists:

```bash
set -a
source .devcontainer/.env
set +a
```

Follow these requirements:

* Preserve `NPM_CONFIG_REGISTRY` and `COREPACK_NPM_REGISTRY` from the environment
* Do not hardcode `https://registry.npmjs.org/` in commands or configuration
* Do not pass a public `--registry` override or reset npm/pnpm registry settings
* Do not overwrite, regenerate, commit, or print the contents of
  `.devcontainer/.env`
* Keep `.devcontainer/.env.example` as a public fallback template only; it must
  not override an existing local `.devcontainer/.env`
* When diagnosing package access, report resolved registry hostnames without
  exposing credentials embedded in URLs

These rules apply to every delegated research, planning, implementation, and
validation subagent.