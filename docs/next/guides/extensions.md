# Manage provider extensions

People who operate Nanasa can add declarative provider packages without allowing
packages to run arbitrary plugin code.

## Know the boundary

Provider extensions contain strict data and reviewed assets. They select closed
Nanasa-owned strategies. They cannot contain JavaScript, shell callbacks,
builds, startup hooks, event hooks, or portal code.

## Review before installation

Inspect an extension, preview its permission plan, and trust only the exact plan
and digest you reviewed. Installation verifies paths, links, device files,
archive budgets, digests, signatures, compatibility, requested grants, namespace
claims, and repository trust.

The operational command family includes:

```text
npx nanasa extension list
npx nanasa extension inspect <extension-id>
npx nanasa extension plan <extension-id>
npx nanasa extension trust <extension-id>
npx nanasa extension install <extension-id>
npx nanasa extension health <extension-id>
```

Commands that mutate state require the JSON body fields listed by the installed
CLI. Use the [generated CLI registry](../reference/cli.json) as the exact
versioned inventory.

## Repair, roll back, or remove

Health distinguishes current, outdated, drifted, incompatible, untrusted,
unavailable, and not installed state. Repair and removal touch only files and
keys owned by the extension ledger. Rollback returns to a verified prior
activation. Active runs retain their immutable adapter snapshot until replaced.

Provider compilation defaults to manual mode. Compile packages outside Nanasa
and import resolved signed packages. Enable sandboxed compilation only on a host
where the Bubblewrap isolation startup probe passes.
