# Assign Git worktrees

Package users can place agents in separate Git worktrees while Nanasa keeps
repository and checkout identity explicit.

## Understand checkout identity

Nanasa distinguishes the common Git repository from each checkout. It supports
normal, linked, bare, packed-reference, and reftable layouts. Every run records
its checkout identity and working directory.

List known repositories and checkouts through the portal or CLI. Create a
managed worktree by supplying the required JSON body to
`npx nanasa worktree create --body <json>`, then assign its checkout to a stopped
agent. The [CLI registry](../reference/cli.json) is the exact command and body
inventory for the installed version.

## Remove a managed worktree safely

Nanasa validates branch, base, target path, operation generation, and conflicts
before invoking Git without a shell. It records managed provenance before it
gains deletion authority.

Before removal:

1. Stop every run bound to the checkout.
2. Reassign every agent that uses the checkout.
3. Review dirty files and confirm force removal only when they may be lost.
4. Remove the worktree by its recorded ID and expected operation generation.

Nanasa checks the `.git` relationship and identity again before removal. Branch
deletion is a separate action. Do not delete or move a managed path behind
Nanasa while an operation is active.
