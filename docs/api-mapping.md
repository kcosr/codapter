# Codex API Mapping

This document maps Codex app-server concepts to the current codapter implementation.

Scope:
- `packages/core`
- `packages/backend-pi`
- `packages/backend-codex`
- `packages/cli`

Status:
- `turn/start`, `turn/interrupt`, thread lifecycle RPCs, and adapter-native `command/exec` are implemented.
- Routed model selection across multiple backends is implemented through `BackendRouter`.
- Pi and Codex backends are both wired behind the shared `IBackend` contract.
- Pi-backed elicitation is implemented through app-server server-request round-trips.
- Worktree RPCs are not implemented and currently fall through to `Method not found`.

## Transport And Handshake

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `initialize` request | `AppServerConnection.handleMessage()` in `packages/core/src/app-server.ts` | Accepts `clientInfo` and `capabilities`, validates client identity, and returns `InitializeResponse` with `userAgent`, `platformFamily`, and `platformOs`. |
| `initialized` notification | `AppServerConnection.handleMessage()` notification path | Marks the connection as initialized. |
| `optOutNotificationMethods` | `AppServerConnection.emitNotification()` | Exact-match filtering for outgoing notifications. |
| stdio transport | `packages/cli/src/index.ts` | Default when `app-server` runs without `--listen`. |
| WebSocket transport | `packages/cli/src/index.ts` | Supports `ws://` and `unix://` listener targets. |
| `/healthz` and `/readyz` | CLI listener HTTP endpoints | Exposed on the WebSocket listener port. |

## Config And Identity

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `config/read` | `InMemoryConfigStore.read()` via `AppServerConnection` | Returns the typed `{ config, origins, layers }` shape. All writes are persisted to `~/.config/codapter/config.toml`. |
| `config/value/write` | `InMemoryConfigStore.writeValue()` | Returns typed `ConfigWriteResponse`. |
| `config/batchWrite` | `InMemoryConfigStore.writeBatch()` | Returns typed `ConfigWriteResponse`. |
| `configRequirements/read` | `AppServerConnection.handleConfigRequirementsRead()` | Returns `{ requirements: null }`. |
| `account/read` | `AppServerConnection.handleAccountRead()` | Uses adapter identity and backend auth state. |
| `getAuthStatus` | `AppServerConnection.handleGetAuthStatus()` | Supported for compatibility. |
| `skills/list` | `AppServerConnection.handleSkillsList()` | Currently returns an empty payload unless the backend provides data. |
| `plugin/list` | `AppServerConnection.handlePluginList()` | Currently returns an empty payload unless the backend provides data. |
| Adapter identity | `packages/core/src/app-server.ts` | Derived from env/TOML override or `codapter/<ADAPTER_VERSION>` (source constant), with platform detection. |

## Threads

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `thread/start` | `AppServerConnection.handleThreadStart()` + `BackendRouter.resolveModelSelection()` | Resolves backend ownership from the selected model and creates a backend thread handle. |
| `thread/resume` | `AppServerConnection.handleThreadResume()` | Reattaches using the registry's `{ backendType, backendSessionId }`. |
| `thread/fork` | `AppServerConnection.handleThreadFork()` | Forks through the owning backend and creates a new registry thread entry. |
| `thread/read` | `AppServerConnection.handleThreadRead()` | Delegates to backend-owned `threadRead()`; adapter no longer rebuilds backend history itself. |
| `thread/list` | `ThreadRegistry` in `packages/core/src/thread-registry.ts` | Registry is authoritative; entries retain backend ownership metadata. |
| `thread/loaded/list` | `AppServerConnection.handleThreadLoadedList()` | Returns currently loaded thread ids only. |
| `thread/name/set` | `AppServerConnection.handleThreadSetName()` | Updates backend thread name and registry metadata. |
| `thread/archive` / `thread/unarchive` | Registry metadata updates | Archive state lives in the adapter registry. |
| `thread/metadata/update` | Registry metadata updates | Used for cwd and git info. |
| `thread/unsubscribe` | Connection-local notification filter | Stops notifications for the thread on that connection. |
| `thread/status/changed` | Published from `AppServerConnection` | Reflects thread state transitions such as `idle` and `turn_active`. |
| `thread/tokenUsage/updated` | Published from backend token stats | Emitted from Pi session stats on turn completion or update. |

## Turns And Items

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `turn/start` | `AppServerConnection.handleTurnStart()` | Validates thread runtime, normalizes `UserInput[]`, and calls backend `turnStart()`. |
| `turn/interrupt` | `AppServerConnection.handleTurnInterrupt()` | Calls backend `turnInterrupt()` and finalizes active turn state. |
| Backend notifications | `BackendAppServerEvent.kind === "notification"` | Relayed as app-server notifications (`thread/*`, `turn/*`, `item/*`). |
| Backend server requests | `BackendAppServerEvent.kind === "serverRequest"` | Relayed to GUI with adapter-owned request ids, resolved back via `resolveServerRequest()`. |
| Backend errors/disconnects | `BackendAppServerEvent.kind` is `error` or `disconnect` | Published as explicit `backend/error` and `backend/disconnect`. |

## Input Mapping

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `UserInput.type: "text"` | Concatenated into prompt text | Text inputs are joined in order. |
| `UserInput.type: "image"` | Passed through as backend image input | `url` is mapped to the backend image input contract. |
| `UserInput.type: "localImage"` | Passed through as backend image input | `path` is mapped to the backend image input contract. |
| `UserInput.type: "skill"` | Rejected by `turn/start` | Unsupported in the current implementation. |
| `UserInput.type: "mention"` | Rejected by `turn/start` | Unsupported in the current implementation. |

## Model And Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `model/list` | `BackendRouter.listModels()` via `AppServerConnection` | Aggregated across healthy backends with backend-prefixed ids. |
| `turn/start` model selection | `BackendRouter.resolveModelSelection()` + backend `turnStart()` | Routed ids resolve to backend ownership and raw backend model id. |
| `BackendRouter` default model | Router-owned arbitration | At most one aggregated `isDefault: true` is exposed. |
| Backend request/response relay | `AppServerConnection` + backend `resolveServerRequest()` | Supports backend-originated server requests independently of backend type. |

## `command/exec`

`command/exec` is adapter-native in codapter and is not routed through Pi or Codex backends.

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `command/exec` | `CommandExecManager.execute()` in `packages/core/src/command-exec.ts` | Uses `child_process.spawn` for buffered and streamed pipe mode. |
| `command/exec/write` | `CommandExecManager.write()` | Writes stdin to the tracked process. |
| `command/exec/resize` | `CommandExecManager.resize()` | Returns an unsupported error in v0.1 because PTY mode is not implemented. |
| `command/exec/terminate` | `CommandExecManager.terminate()` | Terminates the tracked process. |
| `command/exec/outputDelta` | Published by `CommandExecManager` | Base64 chunks are emitted per stream and process. |

Behavior notes:
- Buffered execution returns a final `{ exitCode, stdout, stderr }`.
- Streaming execution returns the final response after the process exits, while output deltas are published during execution.
- `processId` is required for streaming modes.
- `tty: true` is rejected in v0.1.

## Pi Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `IBackend` | `packages/core/src/backend.ts` | Codapter’s backend contract is the adapter-facing abstraction. |
| `PiBackend` | `packages/backend-pi/src/index.ts` | Real subprocess-backed backend implementation. |
| Thread handle identity | Opaque backend `threadHandle` values | Stored in registry as internal metadata. |
| `thread/read` | Backend-owned hydration in `PiBackend.threadRead()` | Returns backend-neutral `Turn[]`. |
| Event stream | Pi notifications mapped to `BackendAppServerEvent` | Routed through `AppServerConnection` publish path. |

## Codex Backend

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `CodexBackend` | `packages/backend-codex/src/index.ts` | Proxies upstream `codex app-server` over stdio. |
| Model id rewrite | Routed `<backend>::<raw>` ids | Rewrites inbound/outbound model ids between adapter and upstream Codex. |
| Server-request relay | Upstream JSON-RPC request/response mapping | Request ids are tracked and resolved through adapter relay. |
| Websocket transport | Deterministic defer/reject path | Websocket mode is explicitly deferred in this topic. |

## Unsupported Or Partially Implemented Areas

| Codex concept | Current state | Notes |
| --- | --- | --- |
| Worktree RPCs (`create-worktree`, `delete-worktree`, `resolve-worktree-for-thread`, `worktree-cleanup-inputs`) | Not implemented | They currently return `Method not found`. |
| Elicitation server requests (`item/tool/requestUserInput`, `mcpServer/elicitation/request`) | Pi-backed elicitation implemented | `item/tool/requestUserInput` is wired as a server-request round-trip; MCP server elicitation is unsupported. |
| Codex websocket transport | Deferred | Explicit deterministic rejection path is implemented. |
| Legacy `codex/event/*` compatibility | Not implemented as a public surface | The current implementation targets the typed app-server surface instead. |
| Remote deployment flow | Supported only through the CLI listener transport | There is no separate remote orchestration layer in codapter. |

## Current Gaps

The implementation is usable for routed Pi/Codex thread operations, turns, and standalone commands. The main remaining gaps are:

1. Worktree RPCs are still unsupported.
2. Codex websocket transport is deferred.
3. Remote tunnel orchestration is still external to codapter.
