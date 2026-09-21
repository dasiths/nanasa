# Send messages and use MCP

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
For `nanasa.report_progress`, omit `blocker` when there is no blocker. Explicit
`null`, empty or whitespace-only text, and the exact case-insensitive literal
`"none"` also clear a previous blocker. Other strings retain their meaning and
continue to signal input is required.

## Verify a static browser candidate

Read-only team reviewers without native browser or shell tools can call
`nanasa.verify_browser_candidate`. It is advertised only to agent principals,
not Foreman or operator principals. The caller must be a current member of the
approved delegation's team and runtime. The delegation must be accepted,
working, or blocked, its assignment must still be current, and its goal must
remain running within its authorized grant and time limit. Authorization and
the candidate digest are checked again after the observations. A changed
candidate or assignment invalidates the evidence; this tool never writes a
review, marks readiness, or approves a goal.

Paths are relative to the assigned checkout root, not the member's current
directory or the goal's nested request directory:

```json
{
	"delegationId": "delegation-from-team_delegations",
	"candidatePath": "examples/multi-coding-agents/src",
	"entry": "index.html",
	"actions": [
		{ "type": "click", "selector": "#pause" },
		{ "type": "select", "selector": "#planet", "value": "earth" },
		{ "type": "slider", "selector": "#speed", "value": 2 }
	]
}
```

The defaults are fresh desktop 1440x900, fresh mobile 390x844, and a
desktop-to-mobile resize of the desktop page. Optional `viewports` contains two
to four `{ "width": 1440, "height": 900 }` objects, each 320-1920 pixels wide
and 240-1200 high; the first must be wider than the second. Every fresh page
runs the same actions; resize retains the desktop interaction state. At most
10 strict action objects are accepted. `click` accepts buttons and local input
controls; `select` accepts native select controls; `fill` accepts text, search,
number and textarea controls; `slider` accepts native range inputs. Each CSS
selector must resolve to exactly one control. There is no arbitrary script,
shell command, URL, file upload, or application-server command input.

The result includes before/after digests, accessibility snapshots, control
states, action results, per-viewport horizontal overflow, page errors, blocked
or failed network requests, and two viewport screenshots sampled 150ms apart.
Pixel samples describe the viewport and up to four visible canvas/SVG regions.
Nonuniform colors suggest nonblank rendering; changed samples suggest motion,
but neither proves that the requested rendering or behavior is correct. Small
or slow animations can be missed. Action success means the action executed;
reviewers must inspect observed state changes and compare source and evidence
with the requested outcome. No errors is not automatic approval. Unrun,
unsupported or failed required checks still prevent an approved review.

The server serves an in-memory snapshot of the exact digest, with no filesystem
writes or command execution in the candidate. Candidates are limited to 512
files, 4 MiB per file and 16 MiB total. Traversal, symlinks, hidden files,
repository metadata and dependency directories are rejected. Only static HTML,
CSS, JavaScript, JSON, SVG, common raster images, icons and WOFF fonts are
served. A new credential-free browser context is used for each fresh viewport;
network requests are restricted to that candidate's loopback origin. External
assets, other local services, frames, workers, downloads, non-GET/HEAD requests
and navigation away from the entry are blocked. CDN-backed or server-rendered
applications may therefore require another permitted verification method.

One verification runs at a time, with a 45-second browser deadline and bounded
requests and bytes served. Structured results are capped at 128 KiB; MCP also
includes the same evidence as text for clients that ignore structured content.
Snapshots are capped at 4096 UTF-8 bytes, controls at 40 and each page/network
error list at 16. Screenshot references are relative to the daemon host's OS
temporary directory, not the checkout or a remote client's filesystem. Files
are owner-only under a private `nanasa-browser-*` directory, at most 16 MiB per
run. The last four successful runs are retained for at most one hour; an
in-progress run can add another 16 MiB. Failed-run artifacts are removed.
After a daemon crash, ordinary host temporary-directory cleanup is required.
Screenshots can contain candidate content; they are not published over HTTP.

The production package includes Playwright, but not its browser binaries or
host libraries. The daemon uses headless Chromium (the matching headless shell)
from `PLAYWRIGHT_BROWSERS_PATH`, or the OS account's original home cache at
`.cache/ms-playwright`, not a provider's private HOME. Missing binaries or host
libraries produce `browser_unavailable` with a concrete reason. The tool never
installs packages, browsers or system dependencies, uses sudo, or changes
provider permissions. The operator must provision a compatible runtime outside
this tool; no provider restart is performed by verification.

This is a local trusted-runtime capability, not an OS sandbox for hostile
repositories. Candidate JavaScript executes in Chromium; request routing, CSP,
a fresh context and sanitized browser environment reduce exposure but do not
replace host isolation or resource controls. Browser bugs, same-user processes,
and host policy are outside this boundary. Only approved scoped candidates
should be verified. Foreman consumes the assigned reviewer's evidence rather
than impersonating a member or calling this agent-only tool.

## Use the default MCP endpoint

Start the installed package:

```bash
npx nanasa start
```

Authenticated loopback MCP is enabled by default because managed teams use it to
coordinate. Nanasa registers its MCP endpoint in each supported provider home and injects
short-lived `NANASA_MCP_URL` and `NANASA_MCP_TOKEN` values into each run. It also
injects `NANASA_STATUS_URL` for lifecycle reporting. Generated provider files
refer to the token by environment variable and do not contain the capability.

Use `npx nanasa start --no-mcp` only for a deliberate diagnostic or single-agent
session that does not need Nanasa coordination tools. The equivalent automation setting
is `NANASA_MCP_ENABLED=false`.

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
