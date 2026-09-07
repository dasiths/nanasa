# Run Nanasa as a user service

People who operate Nanasa can keep one repository daemon running through a
project-local systemd user service.

## Install and start the service

Run these commands from the configured repository:

```bash
npx nanasa service install
npx nanasa service start
npx nanasa service wait-ready
```

The installed unit is tied to this repository and package location. Readiness
requires the expected repository identity and a ready daemon lifecycle. Agents
continue to belong to the private tmux server rather than the browser.

## Inspect and stop it

```bash
npx nanasa service status
npx nanasa service logs
npx nanasa service stop
```

Use `restart` for an intentional daemon restart. The daemon stops independently
while matching tmux-owned agent processes can be adopted after startup. Browser
WebSockets and disposable terminal attachments reconnect and resnapshot; they
are not handed directly to the new daemon.

## Upgrade with rollback

`npx nanasa service upgrade <candidate-package-root>` stages a verified package
and matching state, stops only the daemon, switches the package pointer last,
and waits for readiness. It preserves tmux-owned processes. Failed readiness
restores the previous package pointer and exact state artifacts before the old
service restarts.

Use `npx nanasa service rollback <backup-id>` to restore a verified backup.
Release activation does not migrate database schemas. A future or older schema
is refused. Follow the explicit alpha reset procedure only after a verified
backup and only when loss of current runtime state is acceptable.

Remove the service with `npx nanasa service remove` before deleting the package
or repository. For failures, see [Startup troubleshooting](../troubleshooting/startup.md).
