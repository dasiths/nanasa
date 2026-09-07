# Manage team workspaces

Each team has one active workspace. Every agent in that team launches from the
same primary or linked checkout, while each run retains the checkout identity
and resolved working directory it started with.

## Understand checkout identity

Nanasa distinguishes the common Git repository from each checkout. It supports
normal, linked, bare, packed-reference, and reftable layouts. Every run records
its checkout identity and working directory.

Workspace selection is machine-local runtime state. Do not add checkout IDs or
absolute worktree paths to `.nanasa/config.yaml`. The primary checkout is the
default when a team has no explicit binding.

Linked checkouts are exclusive to one team. Multiple teams may share the
primary checkout. Use the **Team workspaces** portal destination to compare team
bindings and available checkouts.

## Create or attach a workspace

Create a managed worktree with the portal or
`npx nanasa worktree create --body <json>`. Managed worktrees use relative Git
administrative links so the repository and its worktree root can move together.
Git must advertise `worktree add --relative-paths`; upgrade Git when Nanasa
reports `git_relative_worktrees_unsupported`.

Opening an existing worktree registers it as an external checkout. Creation and
opening can optionally activate a selected team when the request includes the
team ID, its current checkout revision, and a switch policy. Selecting a team in
the portal does not activate it until **Activate after creation** or
**Activate after opening** is checked.

## Switch a running team

Changing a team workspace validates every agent's mapped working directory
before stopping a process. Choose one policy:

* `require-stopped` rejects the change while any team member is running
* `stop-and-switch` stops running members and leaves the team stopped
* `stop-switch-restart` stops running members, changes the binding, and starts
	only the members that were running before the change

The command must include `expectedCheckoutRevision`. A stale revision is
rejected instead of overwriting a newer operator choice. Restart failures are
reported per member and do not roll the team back to its previous checkout.

```bash
npx nanasa checkout assign <group-id> --body '{
	"checkoutId":"checkout_feature",
	"expectedCheckoutRevision":2,
	"switchPolicy":"stop-switch-restart"
}'
```

Refresh a checkout to read staged, modified, untracked, ahead, and behind counts:

```bash
npx nanasa checkout refresh <checkout-id>
```

## Remove a managed worktree safely

Nanasa validates branch, base, target path, operation generation, and conflicts
before invoking Git without a shell. It records managed provenance before it
gains deletion authority.

Before removal:

1. Stop every run bound to the checkout.
2. Reassign every team that uses the checkout.
3. Review dirty files and confirm force removal only when they may be lost.
4. Remove the worktree by its recorded ID and expected operation generation.

Nanasa checks the `.git` relationship and identity again before removal. Branch
deletion is a separate action. Do not delete or move a managed path behind
Nanasa while an operation is active. Removed worktrees remain in audit history
but disappear from the active checkout inventory.
