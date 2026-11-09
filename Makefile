# Thin wrapper around pnpm scripts. `make help` lists targets.
PNPM ?= pnpm
.DEFAULT_GOAL := help
.PHONY: help install fresh demo demo-ci demo-testnet demo-live export test typecheck build contracts contracts-test secrets hooks sandbox clean

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  make %-15s %s\n", $$1, $$2}'

install: ## pnpm install
	$(PNPM) install

demo: install ## Offline demo (no keys): sandbox → contracts → flow → server + web on :5173
	$(PNPM) demo

demo-ci: install ## Run the full flow headless, assert outputs, exit 0/1
	$(PNPM) demo --ci

demo-testnet: install ## Use testnet deployment from .env
	$(PNPM) demo testnet

demo-live: install ## testnet + real NEAR AI / Claude / Intents APIs (keys in .env)
	$(PNPM) demo live

fresh: install ## Back up, then wipe ALL local data (training DB, sessions…) and run the demo
	$(PNPM) demo --fresh

export: install ## Static snapshot → apps/web/public/snapshot.json + build web
	$(PNPM) demo:export

test: ## pnpm test, PLUS cargo contract tests when cargo is installed (slower, needs network once)
	$(PNPM) test
	@if command -v cargo >/dev/null 2>&1; then $(MAKE) contracts-test; else echo "(cargo 不在 PATH，跳过合约测试)"; fi

typecheck: ## tsc --noEmit across the workspace
	$(PNPM) typecheck

build: ## Build all packages
	$(PNPM) build

contracts: ## Rebuild contracts/*/res/*.wasm (needs Rust + cargo-near)
	$(PNPM) contracts:build

contracts-test: ## cargo test for contracts (needs Rust)
	$(PNPM) contracts:test

secrets: ## Scan the working tree for secrets + check no source file is git-ignored
	$(PNPM) check-secrets
	$(PNPM) check-ignored

hooks: ## Install the pre-commit secret scan
	$(PNPM) hooks:install

sandbox: ## Pre-download and smoke-test the local NEAR sandbox binary
	$(PNPM) sandbox:fetch

clean: ## Remove build output (local data: use `make fresh`)
	rm -rf apps/*/dist packages/*/dist
