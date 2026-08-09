#!/usr/bin/env bash
set -euo pipefail

# Dev container setup must never wait for input from VS Code's configuration terminal.
exec </dev/null
export CI=true

# Use the registry injected by the devcontainer, or npm's public registry when
# this script is run directly without an environment file.
readonly PACKAGE_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/}"
export NPM_CONFIG_REGISTRY="${PACKAGE_REGISTRY}"
export COREPACK_NPM_REGISTRY="${COREPACK_NPM_REGISTRY:-${PACKAGE_REGISTRY}}"
export PATH="${HOME}/.local/bin:${HOME}/.opencode/bin:${PNPM_HOME:-${HOME}/.local/share/pnpm}:${PATH}"

# pnpm's "latest" dist-tag currently points at a 12.x prerelease, so pin a version
# unless package.json declares one.
readonly PNPM_DEFAULT_VERSION="10.34.5"

echo "==> Configuring git"
git config --global --add safe.directory "${PWD}"

echo "==> Pointing every npm client at the package registry"
# npm's builtin npmrc is read by npm, npx and pnpm for every user, including root
# via sudo, which strips NPM_CONFIG_REGISTRY from the environment.
sudo touch /usr/local/etc/npmrc
sudo sed -i '/^registry=/d' /usr/local/etc/npmrc
sudo tee -a /usr/local/etc/npmrc >/dev/null <<<"registry=${PACKAGE_REGISTRY}"

echo "==> Installing pnpm"
# corepack cannot be used here: it resolves package managers via npm's per-version
# manifest endpoint (/<pkg>/<version>), which the feed proxy does not serve.
pnpm_spec="pnpm@${PNPM_DEFAULT_VERSION}"
if [ -f package.json ]; then
  pinned="$(node -p "(require('./package.json').packageManager ?? '').split('+')[0]" 2>/dev/null || true)"
  case "${pinned}" in
    pnpm@*) pnpm_spec="${pinned}" ;;
  esac
fi
npm install -g "${pnpm_spec}"

echo "==> Installing GitHub Copilot CLI"
curl -fsSL https://gh.io/copilot-install | bash

echo "==> Installing Pi"
npm install -g --ignore-scripts @earendil-works/pi-coding-agent

echo "==> Installing OpenCode"
curl -fsSL https://opencode.ai/install | bash

echo "==> Installing Claude Code"
npm install -g @anthropic-ai/claude-code

hash -r

if [ -f pnpm-lock.yaml ]; then
  echo "==> Installing workspace dependencies"
  pnpm install --frozen-lockfile
elif [ -f package.json ]; then
  echo "==> Installing workspace dependencies"
  pnpm install
fi

echo "==> Verifying the package registry"
for client in "npm:$(npm config get registry)" \
              "pnpm:$(pnpm config get registry)" \
              "npm-as-root:$(sudo npm config get registry)"; do
  echo "    ${client%%:*} -> ${client#*:}"
  case "${client#*:}" in
    "${PACKAGE_REGISTRY}"*) ;;
    *) echo "ERROR: ${client%%:*} resolves a different package registry" >&2; exit 1 ;;
  esac
done

echo "==> Versions"
node --version
pnpm --version
docker --version || echo "docker socket not mounted"
gh --version | head -1
copilot --version
pi --version
opencode --version
claude --version

cat <<'EOF'

==> GitHub authentication
Run the following command, then follow the prompts to sign in to GitHub:

  gh auth login

Choose GitHub.com, select HTTPS, and complete the browser-based login. Verify it with:

  gh auth status

To use GitHub Copilot models in Pi, start `pi`, run `/login`, select GitHub Copilot,
and press Enter for github.com. In OpenCode, run `/connect` and select GitHub Copilot.
EOF