# Changelog

## [Unreleased]

### Breaking Changes

### Added

### Changed

### Fixed

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

- Added manifest-driven vendored type generation via `npm run vendor-types` with pinned Codex and Pi upstream commits.
- Added build preflight checks so missing vendored output fails with a clear bootstrap error.
- Adopted vendored Codex `GitInfo` in `packages/core` with compile-time compatibility checks.
- Adopted targeted vendored Pi `ImageContent`, `RpcExtensionUIRequest`, and `RpcExtensionUIResponse` types only inside `packages/backend-pi`.
- Added vendoring-script validation coverage, PI helper unit tests, and documented vendored-type bootstrap policy.
- Replaced local core `SessionSource`, `ThreadStatus`, `UserInput`, `ThreadItem`, `TurnStatus`, `TurnError`, `Turn`, and `Thread` protocol types with vendored Codex declarations and aligned adapter output to the upstream-required shapes.
- Centralized tool-kind classification across historical and live turn reconstruction and expanded direct `TurnStateMachine` lifecycle coverage.
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
