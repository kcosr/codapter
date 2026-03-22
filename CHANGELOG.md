# Changelog

## [Unreleased]

### Breaking Changes

### Added

- Added `CODAPTER_COLLAB` env var as an alternative to `--collab` for enabling collab sub-agent support. ([#4](https://github.com/kcosr/codapter/pull/4))
- Added checked-in `scripts/pi.sh` and `scripts/codex.sh` launchers plus AGENTS onboarding notes for Codex Desktop GUI debugging with Chrome DevTools MCP. ([#4](https://github.com/kcosr/codapter/pull/4))

### Changed

### Fixed

- Fixed Pi-backed forked sub-agent turns to emit their live user prompt and keep the active child turn alive until the final `message_end`, so Codex Desktop no longer reorders the child prompt above follow-up output or leaves the child thread stuck showing Thinking. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed resumed sub-agent threads to fall back to direct backend event subscriptions when no live collab agent runtime exists, so follow-up child commands like `pwd` stream tool output and clear Thinking in Codex Desktop. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed live command-execution completions to avoid re-sending already streamed stdout in the final `item/completed` payload, so shell output like `pwd` no longer appears twice in Codex Desktop. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed `write`/`edit` tool rendering to synthesize structured file-change items and final output deltas, so Codex Desktop shows created/edited files in the chat UI instead of dropping or emptying those tool results. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed thread resume to preserve the loaded live turn id for the latest turn, so reopening a sub-agent thread no longer duplicates the assistant reply above the hydrated user/assistant turn. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed sub-agent thread hydration so reopening a live child thread keeps the active user prompt and assistant/tool bubbles in the correct order instead of splitting the same prompt across duplicated turns. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed collab sub-agent payloads to keep `spawnAgent` item ids stable across start/completion notifications and propagate sub-agent thread preview/role metadata so the Codex Desktop UI renders created agents correctly. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed `scripts/stdio-tap.mjs` to preserve `CODAPTER_DEBUG_LOG_FILE` so debug JSONL logs can be generated when using the tap wrapper. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed thread payloads to include the real backend session file path and return collab child threads as `idle` after native `thread/resume`, matching Codex Desktop's native sub-agent reopen flow more closely. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed collab tool guidance so Pi-backed agents are not encouraged to close subagents immediately after a successful result, which broke direct follow-up from the child thread in Codex Desktop. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed ephemeral helper threads to stay hidden and omit persistent paths, so Codex Desktop no longer switches the main view into internal title-generator conversations. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed duplicate text streaming for Pi-backed subagent threads by preventing child-thread turns from subscribing to backend events twice. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed `wait_agent` tool results to include sub-agent completion messages, so parent agents can read the child output instead of guessing or claiming it was missing. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed live model switching so `turn/start` honors the GUI-selected model even when the desktop app omits `params.model` and only sends the selection through collaboration/config state. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed the Codapter config store to persist selected model and reasoning effort to disk, so the Codex Desktop picker survives restart and resumed Pi threads inherit the configured model. ([#4](https://github.com/kcosr/codapter/pull/4))
- Fixed Pi-backed threads to persist their own model and reasoning effort, so reopening an Opus sub-agent no longer resets it to the parent/default GPT model in Codex Desktop. ([#4](https://github.com/kcosr/codapter/pull/4))

### Removed

## [0.0.1] - 2026-03-21

### Breaking Changes

### Added

- Support `--listen stdio` alongside other transports (TCP WebSocket, UDS). ([#3](https://github.com/kcosr/codapter/pull/3))
- Add release script with integrated version bump and GitHub release creation. ([#3](https://github.com/kcosr/codapter/pull/3))
- Add `AGENTS.md` for agent onboarding. ([#3](https://github.com/kcosr/codapter/pull/3))

### Changed

- Restructure `CHANGELOG.md` to use `[Unreleased]` section format. ([#3](https://github.com/kcosr/codapter/pull/3))

### Fixed

### Removed

## [0.0.1] - 2026-03-20

### Added

- Initialized the codapter workspace, packages, transport layer, and build tooling.
- Added a real Pi subprocess backend with opaque session tracking and JSONL RPC bridging.
- Implemented thread lifecycle, turn streaming, native `command/exec`, and Pi-backed elicitation.
- Added architecture, API mapping, and integration documentation.
- Added smoke-test coverage and dist build verification.
- Added SIGINT/SIGTERM signal handlers to dispose Pi child processes on shutdown.
- Added `CODAPTER_PI_COMMAND` and `CODAPTER_PI_ARGS` env vars for Pi launch configurability.
- Added idle timeout for Pi processes (default 5 min, configurable via `CODAPTER_PI_IDLE_TIMEOUT_MS`).
- Extended per-thread state machine (`starting -> ready -> turn_active -> forking -> terminating`) with request buffering during `starting`, rejection during `forking`/`terminating`, and debug-level state transition logging.
- Added smoke test coverage for all 11 design-spec scenarios (bash tool, file edit, multi-turn, model switching, thinking, session persistence, interrupt, fork, standalone shell, thread listing).
- Added `scripts/stdio-tap.mjs` for intercepting and logging raw JSON-RPC stdio traffic between the GUI and CLI.
- Added Debugging section to README covering stdio tap, debug log, and Codex Desktop build flavor flags.

### Changed

- Increased SIGTERM->SIGKILL grace period from 1s to 5s.
- Send `account/login/completed` and `account/updated` notifications after the `initialized` handshake so the GUI updates its auth context immediately.

### Fixed

- Fixed authentication: return synthetic `chatgpt` auth state with `planType: "pro"` so the Codex Desktop GUI unlocks the model picker and full UI.
- Fixed `getAuthStatus` to return `authMethod: "chatgpt"` (not `"chatgptAuthTokens"`) and `requiresOpenaiAuth: true`, matching the real codex app-server wire format.
- Fixed `setModel`: was a no-op that discarded the model ID. Now resolves the `provider/modelId` format and calls Pi's `set_model` RPC so model selection from the GUI actually takes effect.

### Removed

- Removed unused declarations in pi-process.ts (parseModelKey, toImageContent, currentModelId, unnecessary async/await).
