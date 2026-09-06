.DEFAULT_GOAL := help

EXAMPLE_ROOT := $(patsubst %/,%,$(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
PRODUCT_ROOT := $(abspath $(EXAMPLE_ROOT)/../..)
NANASA := node $(PRODUCT_ROOT)/bin/nanasa.js
COMPOSE_PROJECT := $(or $(shell docker inspect "$(shell hostname)" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null),nanasa)
COMPOSE := docker compose --project-name $(COMPOSE_PROJECT) --file $(PRODUCT_ROOT)/.devcontainer/compose.yaml
LITELLM_URL ?= http://litellm:4000
LITELLM_KEY ?= sk-local-litellm
COPILOT_MODEL ?= claude-sonnet-5
PORTAL_URL ?= http://127.0.0.1:3210
DEV_PORTAL_URL ?= http://127.0.0.1:5173
NANASA_ALLOW_AUTONOMOUS ?= true
NANASA_ALLOW_PROVIDER_FILES ?= true
export LITELLM_URL LITELLM_KEY COPILOT_MODEL PORTAL_URL DEV_PORTAL_URL
export NANASA_ALLOW_AUTONOMOUS NANASA_ALLOW_PROVIDER_FILES

define run_with_registry_env
set -a; \
if [ -f "$(PRODUCT_ROOT)/.devcontainer/.env" ]; then \
	. "$(PRODUCT_ROOT)/.devcontainer/.env" || exit $$?; \
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

.PHONY: help

help:
	@printf '%s\n' \
		'Multi-coding-agents example lifecycle:' \
		'  make install        Install Nanasa workspace dependencies' \
		'  make init           Confirm the checked-in example configuration' \
		'  make setup          Prepare private provider homes' \
		'  make doctor         Validate the example and provider commands' \
		'  make start          Build and run the example with MCP enabled' \
		'  make run            Alias for make start' \
		'  make first-run      Install, prepare, diagnose, and print next steps' \
		'  make dev            Run daemon and portal source watchers' \
		'  make reset-alpha    Back up and replace stale alpha state' \
		'' \
		'Portal:' \
		'  make portal         Open the production portal URL' \
		'  make portal-auth    Mint and open a one-use portal login URL' \
		'  make portal-dev     Open the development portal URL' \
		'' \
		'Provider authentication:' \
		'  make auth            Authenticate the configured agent providers' \
		'  make auth-frontend   Authenticate both Frontend Team agent homes' \
		'  make auth-frontend-pi        Authenticate the frontend implementor' \
		'  make auth-frontend-opencode  Authenticate the frontend reviewer' \
		'  make auth-copilot    Authenticate the project manager home' \
		'  make auth-pi         Authenticate the Pi implementor home' \
		'  make auth-opencode   Authenticate the reviewer home' \
		'  make auth-litellm    Authenticate the Claude gateway' \
		'' \
		'Claude gateway:' \
		'  make proxy-start     Start the local LiteLLM proxy' \
		'  make proxy-stop      Stop the local LiteLLM proxy' \
		'  make proxy-logs      Follow proxy logs' \
		'  make proxy-status    Check proxy health and models'

.PHONY: install package init reset-alpha setup doctor start run first-run dev

install:
	@$(MAKE) -C $(PRODUCT_ROOT) --no-print-directory install

package:
	@$(MAKE) -C $(PRODUCT_ROOT) --no-print-directory package

init:
	$(NANASA) init

reset-alpha: package
	$(NANASA) reset --from-alpha --confirm "$(EXAMPLE_ROOT)"

setup: package
	$(NANASA) setup

doctor: package
	sh -n $(EXAMPLE_ROOT)/bin/claude-copilot
	$(NANASA) doctor

start: package
	$(NANASA) start --mcp

run: start

first-run:
	@$(MAKE) --no-print-directory install
	@$(MAKE) --no-print-directory init
	@$(MAKE) --no-print-directory setup
	@$(MAKE) --no-print-directory doctor
	@printf '%s\n' \
		'' \
		'Preparation complete. Authenticate each provider before starting agents:' \
		'  make auth' \
		'  make proxy-start' \
		'  make start'

dev:
	@$(call run_with_registry_env,cd "$(PRODUCT_ROOT)" && NANASA_REPO_ROOT="$(EXAMPLE_ROOT)" NANASA_MCP_ENABLED=true pnpm dev)

.PHONY: portal portal-auth portal-dev

portal:
	@$(call open_url,PORTAL_URL)

portal-auth: package
	@url="$$( $(NANASA) auth portal --output text )" || exit $$?; \
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

.PHONY: auth auth-copilot auth-pi auth-opencode auth-litellm auth-frontend auth-frontend-pi auth-frontend-opencode

auth:
	@$(MAKE) --no-print-directory auth-copilot
	@$(MAKE) --no-print-directory auth-pi
	@$(MAKE) --no-print-directory auth-opencode
	@$(MAKE) --no-print-directory auth-litellm
	@$(MAKE) --no-print-directory auth-frontend

auth-frontend:
	@$(MAKE) --no-print-directory auth-frontend-pi
	@$(MAKE) --no-print-directory auth-frontend-opencode

auth-frontend-pi: setup
	$(NANASA) auth login pi --agent frontend-builder

auth-frontend-opencode: setup
	$(NANASA) auth login opencode --agent frontend-reviewer

auth-copilot: setup
	$(NANASA) auth login copilot --agent agent_318f514e-2347-4d87-8c64-aef0752e7bfb

auth-pi: setup
	$(NANASA) auth login pi --agent agent_0ae65cd2-985d-498c-9399-0978bae77827

auth-opencode: setup
	$(NANASA) auth login opencode --agent agent_9e2cdefb-cc96-4b4e-865f-b4ac17f6c4f9

auth-litellm: proxy-build
	$(COMPOSE) run --rm --entrypoint python litellm -c 'from litellm.llms.github_copilot.authenticator import Authenticator; Authenticator().get_access_token(); print("LiteLLM GitHub Copilot authentication saved.")'

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