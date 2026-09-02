.DEFAULT_GOAL := help

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

EXAMPLE_DIR := examples/multi-coding-agents

define run_with_registry_env
set -a; \
if [ -f .devcontainer/.env ]; then \
	. ./.devcontainer/.env || exit $$?; \
fi; \
set +a; \
$(1)
endef

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

.PHONY: help

help:
	@printf '%s\n' \
		'Nanasa product development:' \
		'  make install       Install the frozen pnpm dependency graph' \
		'  make build         Build every workspace package' \
		'  make package       Build the packaged CLI, daemon, and portal assets' \
		'  make test          Run the full local test suite' \
		'  make check         Run formatting, lint, and type checks' \
		'  make static        Alias for make check' \
		'  make validate      Run static checks, tests, and a production build' \
		'  make docs-generate Generate checked-in documentation references' \
		'  make docs-check    Validate generated references and documentation links' \
		'  make auth-github   Authenticate GitHub CLI for repository work' \
		'' \
		'Runnable multi-coding-agents example:' \
		'  make example-help        Show all example commands' \
		'  make example-setup       Prepare the example provider homes' \
		'  make example-doctor      Validate the example configuration' \
		'  make example-start       Run the packaged example and portal' \
		'  make example-dev         Run source development watchers for the example' \
		'  make example-portal-auth Mint and open a one-use portal login URL'

# -----------------------------------------------------------------------------
# Product development
# -----------------------------------------------------------------------------

.PHONY: install build package auth-github

install:
	@$(call run_with_registry_env,pnpm install --frozen-lockfile)

build:
	@$(call run_with_registry_env,pnpm build)

package:
	@$(call run_with_registry_env,pnpm package:build)

auth-github:
	gh auth login --hostname github.com --git-protocol https --web

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------

.PHONY: test check static validate docs-generate docs-check

test:
	@$(call run_with_registry_env,pnpm test)

check:
	@$(call run_with_registry_env,pnpm check:static)

static: check

validate:
	@$(call run_with_registry_env,pnpm check:static && pnpm test && pnpm build)

docs-generate:
	@$(call run_with_registry_env,pnpm docs:generate)

docs-check:
	@$(call run_with_registry_env,pnpm docs:check)

# -----------------------------------------------------------------------------
# Runnable example delegates
# -----------------------------------------------------------------------------

.PHONY: example-help example-setup example-doctor example-start example-dev example-portal-auth

example-help:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory help

example-setup:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory setup

example-doctor:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory doctor

example-start:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory start

example-dev:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory dev

example-portal-auth:
	@$(MAKE) -C $(EXAMPLE_DIR) --no-print-directory portal-auth