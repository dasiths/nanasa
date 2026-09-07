# Support matrix

Package users, contributors, and maintainers can use this boundary when deciding
whether a host or deployment is covered.

## Supported hosts and clients

Nanasa supports Linux with glibc on x64 and arm64. Tested distributions are
Ubuntu 22.04, Ubuntu 24.04, and Debian 12. Supported Node.js majors are 22 and
24. tmux 3.2 or later, Git, and OpenSSH are required.

Foreground startup and repository-local systemd user services are supported.
Current Chromium, Firefox, and WebKit browser engines are supported after their
matrix jobs pass. GitHub Copilot CLI, Claude Code, Pi, and OpenCode use closed
built-in provider adapters at the versions certified by a release.

Terminal display, input, paste, and portal selection work on tmux 3.2.
tmux-wrapped OSC 52 clipboard requests need tmux 3.3 or later.

## Preview support

WSL2 is preview. Provider-native authentication and resume depend on supported
provider versions and accounts. A release claim applies only after its declared
external certification runner passes.

## Unsupported deployment models

Native macOS and Windows runtime hosts are unsupported. Containers can be useful
for disposable tests but do not provide the supported continuity-sensitive host
boundary.

Direct public portal exposure, public control-plane reverse proxies, multi-user
tenancy, distributed runners, executable provider plugins, and automatic
self-update are unsupported. Remote portal access uses OpenSSH loopback
forwarding. Remote MCP may expose only its exact path through a trusted TLS proxy.

Provider processes run as the same operating-system user. Nanasa provider
policies do not isolate hostile code. Use a stronger operating-system boundary
when that risk is in scope.
