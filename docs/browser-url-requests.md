# Agent browser URL requests

## Open an agent request

When an agent requests a browser, Nanasa adds an Attention item naming the
agent and destination origin. The existing in-app notification opens that item;
desktop notifications and sound follow your notification preferences. Browser
requests are enabled by default in each agent's Attention subscriptions.

Choose **Full URL** to inspect the destination, then **Open URL** or **Dismiss**.
Opening creates a tab from your click, rechecks the request with the daemon, and
navigates without an opener or referrer. Opening does not confirm that login or
any other remote action completed.

Requests work even when their terminal is not visible. They remain in Attention
after the toast disappears, expire after ten minutes, and become unavailable
when the run stops or changes generation. Pending requests return on reload
without replaying initial notification popups. Dismissals are stored for the
operator; opening a request also dismisses it. Dismissal does not notify the
requesting application or remove its request for other operators.

## Submit from a managed run

Managed runs receive a `BROWSER` helper and a PATH-scoped `xdg-open` wrapper:

```bash
"$BROWSER" 'https://example.com/login'
xdg-open 'https://example.com/login'
```

The installed CLI also supports `nanasa open-url <url>` inside a managed run.
Restart existing agents to receive the new environment. Applications that use
an absolute OS opener path or ignore `BROWSER` and `PATH` are not intercepted.
The helper's success means the request was accepted, not that a browser opened.
The wrapper supports URLs, not opening local files or directories.

Printed terminal URL clicks continue opening directly. Nanasa does not forward
ports, proxy traffic, or rewrite URLs: `localhost` refers to the machine running
your browser.

## Privacy and limits

Only absolute HTTP and HTTPS URLs without embedded credentials are accepted.
URLs are limited to 8,192 characters. Each run can have ten outstanding requests,
with a repository-wide limit of 500; repeated requests for the same URL reuse
the pending item until expiry. Opening or dismissing does not reset these limits.

URLs are stored in local daemon state but excluded from event payloads and
notification previews. Treat that state as sensitive. The new request table and
subscription support are installed by the schema 15-to-16 migration, preserving
existing Attention overrides.

## Protocol

Managed processes submit `{ "url": "https://example.com" }` to
`POST /api/v1/agent-url-requests` using their run-bound bearer credential.
The daemon derives group, member, run, and generation from that credential;
the caller cannot supply another identity. This endpoint is available even
when the MCP transport is disabled and accepts at most 16 KiB per body.

A successful submission returns HTTP 202 with `requestId`. The durable
`url-open.requested` event contains request and run identifiers, never the URL.
Operators read pending requests through `GET /api/v1/url-open-requests` and
revalidate one through `GET /api/v1/url-open-requests/:requestId`. These reads
require operator authentication. A no-longer-active request returns HTTP 410.
The portal uses ordinary Attention dismissals and the `url-open-request`
subscription, not terminal effects.

## Troubleshooting

If the browser blocks the new tab, allow popups for the portal and retry before
the request expires. If no item appears, check the agent's **Requests a browser**
subscription. Restart agents launched before browser-request support was
installed so they receive the managed environment.

A stopped run or changed generation invalidates its requests. Ask the current
agent to retry. A helper exit status of zero only means Nanasa accepted the
request. See the [portal guide](guides/portal.md) for general Attention use.