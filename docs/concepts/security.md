# Review security boundaries

People who operate Nanasa can use these boundaries to decide where the product
fits and where stronger isolation is required.

## Local network authority

The daemon binds to loopback by default. HTTP and WebSocket requests enforce
Host and Origin policy. A one-use portal URL is exchanged for an HttpOnly,
SameSite session and cross-site request forgery protection. Supported remote
portal access stays inside an OpenSSH local forward.

When MCP is enabled, keep the listener on loopback. Publish only the MCP path
through a trusted TLS reverse proxy when remote MCP is required. Do not expose
the portal, REST, events, or terminal routes directly.

## Provider credentials

Provider CLIs store login state in private homes beneath
`.nanasa/integrations/`. Nanasa does not copy credentials into generated MCP,
prompt, hook, or reporter files. Broker profiles live in the owner's user config
directory, not in the repository, and must use owner-only permissions.

Membership, integration, and custom provider state control sharing. Membership
isolates provider homes by configured agent. Integration state and shared custom
paths let agents affect the same provider-owned settings and sessions.

## Terminal authority

Only the current controller lease can send input, paste, focus, resize, or
approve terminal effects. Observers are read-only. Nanasa rejects malformed and
unsupported terminal control strings. Clipboard writes remain in memory until a
controller approves or they expire. Payloads do not enter normal logs, events,
terminal history, or durable state.

Message delivery means the text reached the agent's terminal input. It is not
proof that a model understood or completed the task.

## MCP authority

An agent MCP capability is bound to its group, member, run, and generation. It
can read coordination state, report progress, and send messages. It cannot edit
configuration, install extensions, approve permissions, or send unrestricted
raw keys. Operator MCP requires a separate strong bearer token.

## Package and extension integrity

Provider extensions are data-only, signature and digest checked, permission
planned, and ledger owned. Release artifacts carry exact commit metadata and an
SPDX software bill of materials. The npm package excludes credentials, provider
state, databases, terminal data, tests, source maps, and private registry
settings.

Checkpoint deletion verifies the persisted digest and open file identity before
truncation and audit. Nanasa does not promise physical block overwrite on modern
filesystems.

## Isolation limit

All agents run as the same operating-system user as Nanasa. Provider read-only
policies are not a hostile-code sandbox. Use separate users, virtual machines,
or containers when agents must not read or affect each other's operating-system
resources. Public multi-user tenancy and distributed runners are unsupported.
