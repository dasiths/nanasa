#!/usr/bin/env bash

set -euo pipefail

readonly PNPM_VERSION="10.34.5"
readonly SCRIPT_DIRECTORY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# shellcheck source=ci-registry-env.sh
source "${SCRIPT_DIRECTORY}/ci-registry-env.sh"

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

corepack_command="corepack"
npm_command="npm"
install_root="${RUNNER_TEMP:-${XDG_DATA_HOME:-${HOME}/.local/share}}/nanasa-pnpm/${PNPM_VERSION}"

if [[ "${NANASA_PNPM_SETUP_TEST_MODE:-false}" == "true" ]]; then
  corepack_command="${NANASA_PNPM_TEST_COREPACK_COMMAND:?Test Corepack command is required}"
  npm_command="${NANASA_PNPM_TEST_NPM_COMMAND:?Test npm command is required}"
  install_root="${NANASA_PNPM_TEST_INSTALL_ROOT:?Test install root is required}"
fi

if [[ "${install_root}" == *$'\n'* || "${install_root}" == *$'\r'* ]]; then
  fail "The pnpm install path must be single-line"
fi

umask 077
command_log="$(mktemp "${TMPDIR:-/tmp}/nanasa-pnpm-setup.XXXXXX")"
trap 'rm -f "${command_log}"' EXIT

install_with_npm() {
  command -v "${npm_command}" >/dev/null 2>&1 ||
    fail "npm is required to install the pinned pnpm version"
  local npm_prefix="${install_root}/npm"
  mkdir -p -- "${npm_prefix}"
  if ! "${npm_command}" install --global --prefix "${npm_prefix}" --ignore-scripts \
    --no-audit --no-fund --no-update-notifier --progress=false --loglevel=error \
    --package-lock=false "pnpm@${PNPM_VERSION}" >"${command_log}" 2>&1; then
    fail "npm could not install the pinned pnpm version"
  fi
  pnpm_directory="${npm_prefix}/bin"
  pnpm_command="${pnpm_directory}/pnpm"
}

corepack_directory="${install_root}/corepack-bin"
mkdir -p -- "${corepack_directory}"
[[ -w "${corepack_directory}" ]] || fail "The pnpm shim directory is not writable"

if command -v "${corepack_command}" >/dev/null 2>&1; then
  if COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${corepack_command}" enable \
    --install-directory "${corepack_directory}" pnpm >"${command_log}" 2>&1; then
    if ! COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "${corepack_command}" prepare \
      "pnpm@${PNPM_VERSION}" --activate >"${command_log}" 2>&1; then
      fail "Corepack could not activate the pinned pnpm version"
    fi
    pnpm_directory="${corepack_directory}"
    pnpm_command="${corepack_directory}/pnpm"
  else
    install_with_npm
  fi
else
  install_with_npm
fi

export PATH="${pnpm_directory}:${PATH}"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "${pnpm_directory}" >>"${GITHUB_PATH}"
fi

actual_version="$("${pnpm_command}" --version 2>"${command_log}")" ||
  fail "The pinned pnpm executable could not be verified"
if [[ "${actual_version}" != "${PNPM_VERSION}" ]]; then
  fail "The pnpm executable does not match the required version"
fi

printf 'Pinned pnpm %s is ready\n' "${PNPM_VERSION}"