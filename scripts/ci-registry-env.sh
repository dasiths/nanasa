#!/usr/bin/env bash

# Source this file immediately before every package-manager or Corepack operation.
if [[ -f .devcontainer/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .devcontainer/.env
  set +a
elif [[ -n "${NPM_CONFIG_REGISTRY:-}" || -n "${COREPACK_NPM_REGISTRY:-}" ]]; then
  if [[ -z "${NPM_CONFIG_REGISTRY:-}" ]]; then
    printf -v NPM_CONFIG_REGISTRY "%s" "$COREPACK_NPM_REGISTRY"
    export NPM_CONFIG_REGISTRY
  fi
  if [[ -z "${COREPACK_NPM_REGISTRY:-}" ]]; then
    printf -v COREPACK_NPM_REGISTRY "%s" "$NPM_CONFIG_REGISTRY"
    export COREPACK_NPM_REGISTRY
  fi
elif [[ "${NANASA_ALLOW_PUBLIC_REGISTRY_FALLBACK:-false}" == "true" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .devcontainer/.env.example
  set +a
else
  echo "Package registry configuration is required" >&2
  return 1 2>/dev/null || exit 1
fi

if [[ -z "${NPM_CONFIG_REGISTRY:-}" || -z "${COREPACK_NPM_REGISTRY:-}" ]]; then
  echo "Both package registry variables must be configured" >&2
  return 1 2>/dev/null || exit 1
fi

if [[ "${NPM_CONFIG_REGISTRY}" == *$'\n'* || "${NPM_CONFIG_REGISTRY}" == *$'\r'* ||
  "${COREPACK_NPM_REGISTRY}" == *$'\n'* || "${COREPACK_NPM_REGISTRY}" == *$'\r'* ]]; then
  echo "Package registry configuration must be single-line" >&2
  return 1 2>/dev/null || exit 1
fi

export NPM_CONFIG_REGISTRY COREPACK_NPM_REGISTRY

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    printf '%s=%s\n' "NPM_CONFIG_REGISTRY" "${NPM_CONFIG_REGISTRY}"
    printf '%s=%s\n' "COREPACK_NPM_REGISTRY" "${COREPACK_NPM_REGISTRY}"
  } >>"${GITHUB_ENV}"
fi
