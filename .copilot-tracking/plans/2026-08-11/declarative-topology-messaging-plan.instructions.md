<!-- markdownlint-disable-file -->
---
description: Implement YAML-owned topology and bounded paginated message history
applyTo: '**'
---

## User requests

* Persist profiles, groups, and memberships in config files where possible.
* Keep transactional and ephemeral state in SQLite.
* Enforce helpful oversized-message errors for MCP and portal callers.
* Bound message retention and delete authoritative history from the portal.
* Render the latest 20 messages first, lazy-load older pages, and start at the
  bottom.
* Apply alpha-quality migration, validation, and recovery behavior.

## Implementation checklist

### Phase 1: Contracts and configuration
<!-- parallelizable: false -->

* [x] Add declarative profile/group/member schemas and retention policy.
* [x] Add shared message byte limits and page/clear/state contracts.
* [x] Update template and active config with stable topology IDs.

### Phase 2: Config repository and topology projection
<!-- parallelizable: false -->

* [x] Add serialized atomic config mutation support.
* [x] Reconcile YAML topology into SQLite on startup and after API writes.
* [x] Route topology CRUD through the config-backed service.
* [x] Import existing topology only when YAML topology sections are absent.

### Phase 3: Message persistence and transport
<!-- parallelizable: false -->

* [x] Add schema version 3 high-water and idempotency invalidation fields.
* [x] Enforce UTF-8 body and request limits across REST and MCP.
* [x] Apply retention transactionally and redact persisted event bodies.
* [x] Add paged list and server-side clear endpoints.

### Phase 4: Portal history
<!-- parallelizable: false -->

* [x] Remove full messages and deliveries from HTTP snapshots.
* [x] Add per-group page loading and clear APIs.
* [x] Load latest 20, prepend older pages, and preserve viewport position.
* [x] Default initial history to the bottom and handle live refreshes.
* [x] Remove browser message-body history and enforce byte limits in composer.

### Phase 5: Migration, documentation, and validation
<!-- parallelizable: false -->

* [x] Update README and alpha migration notes.
* [x] Add focused contract, store, server, portal, package, and acceptance tests.
* [x] Run complete typecheck, tests, lint, format, and diff checks.

## Success criteria

* Config topology survives deletion of the SQLite file and is projected on next
  startup.
* Config writes are atomic and stable IDs remain unchanged.
* SQLite contains no message body beyond configured retention or clear.
* Message sequence numbers never reset after retention or clear.
* Oversized REST and MCP calls receive consistent actionable errors.
* Portal initial render contains at most 20 latest messages and lazy loading does
  not jump the viewport.
