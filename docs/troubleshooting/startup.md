# Fix startup and portal login

Package users can diagnose configuration, repository ownership, service
readiness, and expired portal sessions without deleting valid state.

## `doctor` reports a missing provider command

This means `.nanasa/config.yaml` contains an integration whose first command is
not executable in the configured working directory.

Run:

```bash
npx nanasa doctor
```

Read every `ERROR <integration>: command not found` line. The generated template
defines Copilot, Pi, OpenCode, and Claude Code. If you use only one, remove the
other integration blocks before running `doctor`. Otherwise, install the missing
CLI and keep the command on `PATH`.

Run `npx nanasa setup`, then `doctor` again. Do not create fake executables or
disable checks for integrations you do not use. See
[Configuration](../guides/configuration.md).

## Startup says another daemon owns the repository

This means the repository leadership lock points to a live matching process.

Run:

```bash
npx nanasa daemon status
```

If a daemon is ready, use it or stop its service cleanly. Nanasa distinguishes a
Linux zombie from a live owner by process start identity and state. A verified
zombie does not block startup.

Do not remove `daemon.lock` manually while a live owner exists. If no owner is
live, run `npx nanasa doctor` and start again. See
[State and recovery](../concepts/state-and-recovery.md).

## The service is not ready

This means systemd started no matching ready daemon for this repository.

Run:

```bash
npx nanasa service status
npx nanasa service logs
```

Check the repository path, package path, configuration error, port conflict, and
reported identity. Keep the repository-local package installed. After fixing
the first error, run `npx nanasa service restart` and
`npx nanasa service wait-ready`.

Do not repeatedly reinstall the unit before reading logs. See
[Services](../guides/services.md).

## The database schema is refused

This means the database is older or newer than the running package. Nanasa does
not upgrade schemas in place.

Read the startup error and compare its package and schema identity with the
expected release. Restore the matching package or a verified backup. Use
`npx nanasa reset --from-alpha --confirm <repository-root>` only after preserving
a verified backup and accepting loss of current alpha runtime state.

Do not open a newer database with older code. See
[Release and rollback](../development/release.md).

## The portal asks for an operator session

The browser has no valid session, or its prior session expired.

Run:

```bash
npx nanasa auth portal
```

Open the new one-use URL in the intended browser. A new portal URL does not
revoke other current sessions. Provider login does not sign into the portal.

Do not bookmark or share the one-use URL. See
[Authentication](../guides/authentication.md).
