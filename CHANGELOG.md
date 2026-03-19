# Changelog

## 0.0.1 - Unreleased

- Initialized the codapter workspace, packages, transport layer, and build tooling.
- Added a real Pi subprocess backend with opaque session tracking and JSONL RPC bridging.
- Implemented thread lifecycle, turn streaming, native `command/exec`, and Pi-backed elicitation.
- Added architecture, API mapping, and integration documentation.
- Added smoke-test coverage and dist build verification.
- Added SIGINT/SIGTERM signal handlers to dispose Pi child processes on shutdown.
- Added `CODAPTER_PI_COMMAND` and `CODAPTER_PI_ARGS` env vars for Pi launch configurability.
- Added idle timeout for Pi processes (default 5 min, configurable via `CODAPTER_PI_IDLE_TIMEOUT_MS`).
- Increased SIGTERM→SIGKILL grace period from 1s to 5s.
- Removed unused declarations in pi-process.ts (parseModelKey, toImageContent, currentModelId, unnecessary async/await).
- Extended per-thread state machine (`starting → ready → turn_active → forking → terminating`) with request buffering during `starting`, rejection during `forking`/`terminating`, and debug-level state transition logging.
- Added smoke test coverage for all 11 design-spec scenarios (bash tool, file edit, multi-turn, model switching, thinking, session persistence, interrupt, fork, standalone shell, thread listing).
- Fixed authentication: return synthetic `chatgpt` auth state with `planType: "pro"` so the Codex Desktop GUI unlocks the model picker and full UI (previously returned null/apiKey which left the GUI in unauthenticated state).
- Fixed `getAuthStatus` to return `authMethod: "chatgpt"` (not `"chatgptAuthTokens"`) and `requiresOpenaiAuth: true`, matching the real codex app-server wire format.
- Send `account/login/completed` and `account/updated` notifications after the `initialized` handshake so the GUI updates its auth context immediately.
- Fixed `setModel`: was a no-op that discarded the model ID. Now resolves the `provider/modelId` format and calls Pi's `set_model` RPC so model selection from the GUI actually takes effect.
- Added `model/list` response to debug log output for troubleshooting.
- Added `scripts/stdio-tap.mjs` for intercepting and logging raw JSON-RPC stdio traffic between the GUI and CLI.
- Added Debugging section to README covering stdio tap, debug log, and Codex Desktop build flavor flags (`BUILD_FLAVOR`, `CODEX_SPARKLE_ENABLED`).
