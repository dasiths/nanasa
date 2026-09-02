# Fix terminals and remote access

Portal users and people who operate Nanasa can recover from lease changes,
clipboard failures, terminal resets, and lost SSH tunnels.

## The terminal became read-only

Another browser may hold the controller lease, the lease may have expired, or a
new run generation may have replaced the attachment.

Run:

```bash
npx nanasa terminal status <run-id>
```

Compare the run generation and controller state with the portal. Choose **Take
control** to revoke an old controller, or reconnect to the current generation.
Resnapshot before retrying input.

Do not assume a lease change stopped the owner pane. See
[State and recovery](../concepts/state-and-recovery.md).

## The terminal reset or disconnected

A generation replacement, controller takeover, slow-consumer closure, planned
restart, or daemon reconnect can replace the disposable attachment.

Run:

```bash
npx nanasa run get <run-id>
```

If the current run is alive, reopen its terminal and accept the new bounded
baseline. If recovery failed, use the portal's retry action after reading the
failure. Do not send input to an old generation.

## TUI copy does not update the clipboard

The terminal user interface may own its highlight instead of creating a browser
selection.

First activate the TUI's copy command. If Nanasa shows a clipboard request,
activate **Copy** and grant browser permission. A denied request remains
available until expiry. On tmux 3.2, wrapped OSC 52 is unavailable; use
Shift+drag on Linux or Windows, Option+drag on macOS, or open **Transcript**.

Do not paste clipboard payloads into logs while diagnosing. See
[Accessibility](../concepts/accessibility.md).

## The remote portal stopped updating

The OpenSSH tunnel may be gone while the remote service and tmux agents remain
alive.

Run OpenSSH directly to verify host authentication, then run the remote Nanasa
service status on the host. Recreate the loopback tunnel with the reconnect
command printed by `npx nanasa remote connect`, reload the portal, and take a
fresh snapshot.

Do not restart agents because a local tunnel disappeared. Do not expose the
remote portal listener publicly. See [Remote access](../guides/remote-access.md).
