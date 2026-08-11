.DEFAULT_GOAL := help

# -----------------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------------

COMPOSE_PROJECT := $(or $(shell docker inspect "$(shell hostname)" --format '{{ index .Config.Labels "com.docker.compose.project" }}' 2>/dev/null),nanasa)
COMPOSE := docker compose --project-name $(COMPOSE_PROJECT) --file .devcontainer/compose.yaml
LITELLM_URL := http://litellm:4000
LITELLM_KEY := sk-local-litellm
COPILOT_MODEL := claude-sonnet-5

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

.PHONY: help

help:
	@printf '%s\n' \
		'Authentication targets:' \
		'  make auth          Authenticate every CLI in sequence' \
		'  make auth-github   Authenticate GitHub CLI' \
		'  make auth-copilot  Authenticate GitHub Copilot CLI' \
		'  make auth-pi       Authenticate Pi with GitHub Copilot' \
		'  make auth-opencode Authenticate OpenCode with GitHub Copilot' \
		'  make auth-litellm  Authenticate the local proxy with GitHub Copilot' \
		'  make auth-status   Show available authentication statuses' \
		'' \
		'Claude Code through GitHub Copilot:' \
		'  make proxy-start   Start the local LiteLLM proxy' \
		'  make proxy-stop    Stop the local LiteLLM proxy' \
		'  make proxy-logs    Follow proxy logs' \
		'  make proxy-status  Check proxy health and models' \
		'  make claude-copilot Start another Claude Code instance through the running proxy'

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
	ANTHROPIC_BASE_URL=$(LITELLM_URL) \
	ANTHROPIC_AUTH_TOKEN=$(LITELLM_KEY) \
	ANTHROPIC_MODEL=$(COPILOT_MODEL) \
	ANTHROPIC_DEFAULT_SONNET_MODEL=$(COPILOT_MODEL) \
	ANTHROPIC_DEFAULT_HAIKU_MODEL=$(COPILOT_MODEL) \
	CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 \
	claude $(CLAUDE_ARGS)