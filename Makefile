.DEFAULT_GOAL := help

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

COMPOSE_PROJECT := $(or $(shell docker inspect "$(shell hostname)" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null),nanasa)
COMPOSE := docker compose --project-name $(COMPOSE_PROJECT) --file .devcontainer/compose.yaml
LITELLM_URL := http://litellm:4000
LITELLM_KEY := sk-local-litellm
COPILOT_MODEL := claude-sonnet-5
PORTAL_URL ?= http://127.0.0.1:3210
DEV_PORTAL_URL ?= http://127.0.0.1:5173
export PORTAL_URL DEV_PORTAL_URL

define run_with_registry_env
set -a; \
if [ -f .devcontainer/.env ]; then \
	. ./.devcontainer/.env || exit $$?; \
fi; \
set +a; \
$(1)
endef

define open_url
url="$${$(1)}"; \
if [ -n "$$BROWSER" ]; then \
	"$$BROWSER" "$$url"; \
elif command -v xdg-open >/dev/null 2>&1; then \
	"$$(command -v xdg-open)" "$$url"; \
else \
	printf '%s\n' "Unable to open $$url: set BROWSER to a browser command or install xdg-open." >&2; \
	exit 1; \
fi
endef

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

.PHONY: help

help:
	@printf '%s\n' \
		'Application lifecycle:' \
		'  make install       Install the frozen pnpm dependency graph' \
		'  make init          Initialize repository configuration when absent' \
		'  make reset-alpha   Back up and destructively replace stale alpha state' \
		'  make setup         Prepare repository-local integration homes' \
		'  make doctor        Check configuration, commands, and integration homes' \
		'  make build         Build every workspace package' \
		'  make package       Build the packaged CLI, daemon, and portal assets' \
		'  make start         Build and run Nanasa in the foreground (Ctrl+C to stop)' \
		'  make run           Alias for make start' \
		'  make first-run     Install, initialize, set up, diagnose, and start in order' \
		'  make dev           Run daemon and portal development watchers (Ctrl+C to stop)' \
		'  make portal        Open the production base URL for an authenticated session' \
		'  make portal-auth   Mint and open a one-use production portal login URL' \
		'  make portal-dev    Open the development base URL for an authenticated session' \
		'' \
		'  First start prints an exact one-use URL containing a #fragment; open it exactly.' \
		'  The portal targets open only a base URL for an already authenticated browser.' \
		'' \
		'Validation:' \
		'  make test          Run the full local test suite' \
		'  make check         Run formatting, lint, and type checks' \
		'  make static        Alias for make check' \
		'  make validate      Run static checks, tests, and a production build' \
		'' \
		'Authentication targets:' \
		'  make auth          Authenticate every CLI in sequence' \
		'  make auth-github   Authenticate GitHub CLI' \
		'  make auth-copilot  Authenticate GitHub Copilot CLI' \
		'  make auth-pi       Authenticate Pi with GitHub Copilot' \
		'  make auth-opencode Authenticate OpenCode with GitHub Copilot' \
		'  make auth-litellm  Authenticate the local proxy with GitHub Copilot' \
		'  make auth-status   Show available authentication statuses' \
		'' \
		'LiteLLM proxy through GitHub Copilot:' \
		'  make proxy-start   Start the local LiteLLM proxy' \
		'  make proxy-stop    Stop the local LiteLLM proxy' \
		'  make proxy-logs    Follow proxy logs' \
		'  make proxy-status  Check proxy health and models' \
		'' \
		'Claude Code launcher:' \
		'  make claude-copilot Start another Claude Code instance through the running proxy' \
		'' \
		'Variables:' \
		'  PORTAL_URL=$(PORTAL_URL)' \
		'  DEV_PORTAL_URL=$(DEV_PORTAL_URL)' \
		'  BROWSER=<command>  Browser helper used by portal targets before xdg-open' \
		'  CLAUDE_ARGS=<args> Additional arguments for claude-copilot'

# -----------------------------------------------------------------------------
# Application lifecycle
# -----------------------------------------------------------------------------

.PHONY: install init reset-alpha setup doctor build package start run first-run dev portal portal-auth portal-dev

install:
	@$(call run_with_registry_env,pnpm install --frozen-lockfile)

init:
	node bin/nanasa.js init

reset-alpha: package
	node bin/nanasa.js reset --from-alpha --confirm "$(CURDIR)"

setup: package
	node bin/nanasa.js setup

doctor: package
	node bin/nanasa.js doctor

build:
	@$(call run_with_registry_env,pnpm build)

package:
	@$(call run_with_registry_env,pnpm package:build)

start:
	@$(call run_with_registry_env,pnpm start)

run: start

first-run:
	@$(MAKE) --no-print-directory install
	@$(MAKE) --no-print-directory init
	@$(MAKE) --no-print-directory package
	node bin/nanasa.js setup
	node bin/nanasa.js doctor
	@$(MAKE) --no-print-directory start

dev:
	@$(call run_with_registry_env,pnpm dev)

portal:
	@$(call open_url,PORTAL_URL)

portal-auth: package
	@url="$$(node bin/nanasa.js auth portal --output text)" || exit $$?; \
	if [ -n "$$BROWSER" ]; then \
		"$$BROWSER" "$$url"; \
	elif command -v xdg-open >/dev/null 2>&1; then \
		"$$(command -v xdg-open)" "$$url"; \
	else \
		printf '%s\n' "Unable to open portal login URL: set BROWSER or install xdg-open." >&2; \
		exit 1; \
	fi

portal-dev:
	@$(call open_url,DEV_PORTAL_URL)

# -----------------------------------------------------------------------------
# Validation
# -----------------------------------------------------------------------------

.PHONY: test check static validate

test:
	@$(call run_with_registry_env,pnpm test)

check:
	@$(call run_with_registry_env,pnpm check:static)

static: check

validate:
	@$(call run_with_registry_env,pnpm check:static && pnpm test && pnpm build)

# -----------------------------------------------------------------------------
# Authentication
# -----------------------------------------------------------------------------

.PHONY: auth auth-github auth-copilot auth-pi auth-opencode auth-litellm auth-status

auth:
	@$(MAKE) auth-github
	@$(MAKE) auth-copilot
	@$(MAKE) auth-pi
	@$(MAKE) auth-opencode
	@$(MAKE) auth-litellm

auth-github:
	gh auth login --hostname github.com --git-protocol https --web

auth-copilot:
	copilot login --device-code

auth-pi:
	@printf '%s\n' 'Enter /login, select GitHub Copilot, then press Enter for github.com.'
	pi

auth-opencode:
	@printf '%s\n' 'Select GitHub Copilot when prompted.'
	opencode providers login

auth-litellm: proxy-build
	$(COMPOSE) run --rm --entrypoint python litellm -c 'from litellm.llms.github_copilot.authenticator import Authenticator; Authenticator().get_access_token(); print("LiteLLM GitHub Copilot authentication saved.")'

auth-status:
	@printf '%s\n' '==> GitHub CLI'
	@gh auth status || true
	@printf '\n%s\n' '==> OpenCode'
	@opencode providers list || true
	@printf '\n%s\n' '==> LiteLLM proxy'
	@$(MAKE) --no-print-directory proxy-status || true
	@printf '\n%s\n' 'Copilot and Pi do not expose standalone authentication status commands.'

# -----------------------------------------------------------------------------
# LiteLLM proxy
# -----------------------------------------------------------------------------

.PHONY: proxy-build proxy-start proxy-stop proxy-logs proxy-status

proxy-build:
	$(COMPOSE) build litellm

proxy-start: auth-litellm
	$(COMPOSE) up --detach --wait --wait-timeout 120 litellm

proxy-stop:
	$(COMPOSE) stop litellm

proxy-logs:
	$(COMPOSE) logs --follow litellm

proxy-status:
	@curl --fail --silent --show-error -H 'Authorization: Bearer $(LITELLM_KEY)' $(LITELLM_URL)/health/liveliness
	@printf '\n'
	@curl --fail --silent --show-error -H 'Authorization: Bearer $(LITELLM_KEY)' $(LITELLM_URL)/v1/models
	@printf '\n'

# -----------------------------------------------------------------------------
# Claude Code launcher
# -----------------------------------------------------------------------------

.PHONY: claude-copilot

claude-copilot:
	@curl --fail --silent --show-error -H 'Authorization: Bearer $(LITELLM_KEY)' $(LITELLM_URL)/health/liveliness >/dev/null || \
		{ printf '%s\n' 'LiteLLM is not ready. Run make proxy-start first.' >&2; exit 1; }
	@node scripts/prepare-claude-gateway-state.mjs
	ANTHROPIC_BASE_URL=$(LITELLM_URL) \
	ANTHROPIC_AUTH_TOKEN=$(LITELLM_KEY) \
	ANTHROPIC_MODEL=$(COPILOT_MODEL) \
	ANTHROPIC_DEFAULT_SONNET_MODEL=$(COPILOT_MODEL) \
	ANTHROPIC_DEFAULT_HAIKU_MODEL=$(COPILOT_MODEL) \
	CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
	claude $(CLAUDE_ARGS)