# Connect from another computer

People who operate Nanasa can reach a remote repository through an OpenSSH local
forward without exposing the portal listener.

## Prepare the remote repository

Install and configure Nanasa on the remote Linux host. Start its project-local
user service and confirm readiness:

```bash
npx nanasa service start
npx nanasa service wait-ready
```

Nanasa keeps the daemon bound to remote loopback. OpenSSH remains the authority
for user authentication and host trust.

## Open the tunnel

From the local checkout or package context, run:

```bash
npx nanasa remote connect user@example-host --repo /absolute/remote/repository
```

Nanasa validates the SSH target and absolute repository path, discovers the
remote repository, instance, build, protocol, and service identity, then prints
or opens a local loopback URL. The tunnel uses forward-failure checks,
keepalives, and batch authentication. Nanasa does not collect SSH passwords or
private keys.

Use `npx nanasa remote start` or `remote restart` with the SSH target and remote
repository options when the service must be controlled remotely. Inspect
`npx nanasa remote describe` locally when checking exact identity.

## Recover a lost tunnel

Tunnel loss means the transport is offline. It does not prove that the remote
daemon or agent processes stopped. Run OpenSSH directly to check host access,
check the remote service, then rerun the reconnect command printed by Nanasa.
Reload the portal and let it take a fresh snapshot.

Direct public portal exposure, multi-user tenancy, and distributed runners are
not supported. See [Terminal and remote troubleshooting](../troubleshooting/terminals-and-remote-access.md).
