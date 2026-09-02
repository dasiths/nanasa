# Configuration reference

Advanced package users can use these field rules when editing the version 2
`.nanasa/config.yaml` authoring format.

## File rules

The file must contain `version: 2` and can contain only the documented top-level
keys. It is limited to 256 KiB, a depth of 20, and 10,000 YAML nodes. Duplicate
keys, aliases, anchors, merge keys, custom tags, and NUL characters are rejected.
Repository paths must stay beneath the repository root.

## Top-level fields

| Field          | Purpose                                                |
|----------------|--------------------------------------------------------|
| `version`      | Required configuration version, currently `2`         |
| `repository`   | Repository path and current or worktree checkout       |
| `terminal`     | Previous-output checkpoint policy                      |
| `instructions` | Global instruction Markdown paths                      |
| `integrations` | Provider commands, state, credentials, and recovery    |
| `extensions`   | Pinned declarative provider extension versions         |
| `roles`        | Reusable work, prompt, permission, and presentation    |
| `groups`       | Ordered groups and configured agents                   |
| `messages`     | Per-group message retention                            |

## Integration fields

An integration map key is its authored ID. Do not add a nested `id`; Nanasa adds
that field after parsing. Required authored fields are `name`, `kind`, and a
non-empty `command` array. `kind` is `copilot`, `claude-code`, `pi`, or
`opencode`.

Optional fields include `cwd`, `providerState`, `credentials`, `model`,
`nativeRecovery`, `extensions`, and `environment`. State scope is `membership`,
`integration`, or `custom`. Credential kind is `provider-managed` or
`broker-profile`. A broker profile also needs `profileId`.

Environment names use shell variable syntax. Values can contain at most 16 KiB.
`NODE_OPTIONS`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are forbidden. Do not
use environment fields for secrets committed to Git.

## Role and presentation fields

A role needs `name`. It may have a description up to 500 characters, up to 32
instruction paths, and `permissionPolicy` set to `inherit` or `read-only`.

Presentation colors are `amber`, `blue`, `cyan`, `rose`, `slate`, `teal`, and
`violet`. Icons are `briefcase-business`, `clipboard-list`, `code`, `hammer`,
`scan-search`, `shield-check`, `waypoints`, and `wrench`. `shortName` is limited
to 24 characters.

## Group and agent fields

A group map key is its stable ID. A group needs `name` and may set zero-based
`order`, up to 32 instruction paths, and an `agents` map.

Each agent map key must be unique across the repository. The object needs a
`memberId`, `name`, and existing `integrationId`. Optional fields are `roleId`,
`checkoutId`, `desiredModel`, `instructions`, and zero-based `order`.
`memberId` must be unique within its group. The agent map key, not `memberId`, is
used by provider login and topology commands.

`model.model` sets the desired model for every agent using an integration.
`desiredModel` overrides it for one agent. Both values are provider-specific
model IDs of up to 256 characters with no whitespace. Nanasa passes the value
to the provider's model option. Check the installed provider CLI for available
model IDs.

`model.resumePolicy` is `preserve-session` or `enforce-configured`.
`preserve-session` keeps the model from a resumed provider session.
`enforce-configured` reapplies the configured model when Nanasa resumes that
session.

## Instruction limits

Paths must be repository-relative, use `/`, end in `.md`, and contain no upward
traversal. Every referenced file must be a regular owner-owned UTF-8 file. A
single file is limited to 64 KiB. One path cannot be referenced twice anywhere
in configuration. The effective built-in and user prompt is limited to 256 KiB.

## Terminal and message limits

Checkpoint line count ranges from 1 to 100,000. Byte count ranges from 1 to
16,777,216. Retention ranges from 60 seconds to one year. Sensitivity is
`repository-private` or `encrypted`.

`messages.retentionPerGroup` ranges from 1 to 100,000 and defaults to 1,000.
Message bodies can contain at most 1 MiB of UTF-8.

## Generated schema

The generated [configuration schema](config.schema.json) describes the authored
YAML shape. It can check fields, types, and basic limits. It cannot check files,
directory ownership, repository boundaries, or every cross-reference. Use
`npx nanasa setup` or `npx nanasa doctor` for the complete product validation.
