# Send messages and enable MCP

Package users can send tasks from the portal and let active agents coordinate
through the Model Context Protocol (MCP).

## Send a human task

Open a group's **Messages** view, compose a message, and choose an audience. Send
to one agent for a direct task, select several agents for a multicast, or choose
the group for a broadcast. Message text can contain up to 1 MiB of UTF-8.

For larger content, place a file in the shared repository and send its
repository-relative path. Nanasa does not open paths automatically. A path on a
remote MCP client's computer is not visible until its content reaches the
shared checkout.

A delivery record tracks transport into each terminal. Delivery does not mean
that an agent accepted or completed the request.

## Let agents coordinate

When MCP is enabled, an authenticated agent can:

* List active members and their roles
* Read compact agent status and attention
* Report progress, next steps, blockers, and final outcomes
* Send a direct message to one other member
* Send a multicast to at least two other members
* Broadcast to its group, excluding itself

Direct and multicast recipients use stable `memberId` values. This differs from
provider login, where `--agent` uses the configured agent map key. Nanasa adds a
trusted sender envelope to terminal input, so an MCP caller cannot forge the
stored sender identity.

Agents should report progress when work starts or changes stage, report a clear
blocker when input is needed, and publish a final outcome when work ends. A
recipient can reply in the same conversation or report progress independently.

## Enable MCP

Start the installed package with MCP enabled:

```bash
npx nanasa start --mcp
```

Nanasa registers its MCP endpoint in each supported provider home and injects
short-lived `NANASA_MCP_URL` and `NANASA_MCP_TOKEN` values into each run. It also
injects `NANASA_STATUS_URL` for lifecycle reporting. Generated provider files
refer to the token by environment variable and do not contain the capability.

This Nanasa-owned server is separate from consumer MCP files selected through
`providerFiles.mcp`. Consumer files use the provider's native JSON format and
are composed by its adapter. Integration files apply to every assigned agent;
an agent selection can append, replace, or disable inherited consumer files.
The generated `nanasa` server is reserved and cannot be replaced by a consumer
file.

The signing key lives in `.nanasa/state/mcp-secret` as an owner-only file. A
capability is bound to one group, member, run, and generation. Stopping,
replacing, or removing the run causes later requests to be rejected.

## Use an operator MCP client

Agent capabilities are created automatically. A separate operator client needs
`NANASA_MCP_OPERATOR_TOKEN` with at least 32 characters. Send it only as a
Bearer authorization header, never in a URL query. Operator calls must identify
the target group where the tool requires it.

The endpoint allows 30 requests per minute for each principal. MCP can send
messages and read coordination state. It cannot change topology, install
extensions, approve provider permissions, or send unrestricted terminal keys.

## Keep remote MCP narrow

When MCP is enabled, the Nanasa listener must remain on loopback. For remote MCP,
place a trusted Transport Layer Security (TLS) reverse proxy in front of only
the exact MCP path, `/mcp` by default. Set `NANASA_MCP_URL` to the external HTTPS
URL and configure a strong operator token. Preserve the advertised Host header
and restrict origins. Never publish the portal, REST API, events, or terminal
routes through that proxy.

For generated tool fields and protocol details, see the
[MCP tool registry](../reference/mcp-tools.json) and
[protocol reference](../reference/protocols.md).
