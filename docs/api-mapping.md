# Codex API Mapping

This document maps Codex app-server concepts to the current codapter implementation.

Scope:
- `packages/core`
- `packages/backend-pi`
- `packages/cli`

Status:
- `turn/start`, `turn/interrupt`, thread lifecycle RPCs, and adapter-native `command/exec` are implemented.
- Pi session lifecycle, prompt/abort, model listing, and token usage reporting are implemented in `backend-pi`.
- Pi-backed elicitation is fully implemented: the adapter sends `item/tool/requestUserInput` server-requests to the GUI and resolves responses through the backend.
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
| Adapter identity | `packages/core/src/app-server.ts` | Derived from env/TOML override or `codapter/0.0.1` (`ADAPTER_VERSION` in source), with platform detection. |

## Threads

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `thread/start` | `AppServerConnection.handleThreadStart()` | Creates a backend session, registers the thread, and returns a typed `Thread` snapshot. |
| `thread/resume` | `AppServerConnection.handleThreadResume()` | Reattaches to the opaque backend session id stored in the adapter registry. |
| `thread/fork` | `AppServerConnection.handleThreadFork()` | Forks from the backend session, creates a new thread entry, and returns the new thread snapshot. |
| `thread/read` | `AppServerConnection.handleThreadRead()` | Reads history from the backend and translates it into Codex `Turn`/`ThreadItem` data. |
| `thread/list` | `ThreadRegistry` in `packages/core/src/thread-registry.ts` | Registry is authoritative. Backend session scans are not used for the list response. |
| `thread/loaded/list` | `AppServerConnection.handleThreadLoadedList()` | Returns currently loaded thread ids only. |
| `thread/name/set` | `AppServerConnection.handleThreadSetName()` | Updates backend session name and registry metadata. |
| `thread/archive` / `thread/unarchive` | Registry metadata updates | Archive state lives in the adapter registry. |
| `thread/metadata/update` | Registry metadata updates | Used for cwd and git info. |
| `thread/unsubscribe` | Connection-local notification filter | Stops notifications for the thread on that connection. |
| `thread/status/changed` | Published from `AppServerConnection` | Reflects thread state transitions such as `idle` and `turn_active`. |
| `thread/tokenUsage/updated` | Published from backend token stats | Emitted from Pi session stats on turn completion or update. |

## Turns And Items

| Codex concept | Current codapter mapping | Notes |
| --- | --- | --- |
| `turn/start` | `AppServerConnection.handleTurnStart()` | Validates the thread is ready, normalizes `UserInput[]`, calls `backend.prompt()`, and returns the initial `Turn`. |
| `turn/interrupt` | `AppServerConnection.handleTurnInterrupt()` | Calls `backend.abort()` and finalizes the turn as interrupted. |
| `turn/started` | `TurnStateMachine.emitStarted()` | Emitted before streamed deltas. |
| `turn/completed` | `TurnStateMachine.complete()` | Finalizes the turn after backend completion, interrupt, or error. |
| `item/started` | `TurnStateMachine.storeItem()` | Emitted when a new agent message, reasoning block, command execution item, or file change item opens. |
| `item/completed` | `TurnStateMachine.completeItem()` | Emitted when an item is closed. |
| `item/agentMessage/delta` | `TurnStateMachine.handleTextDelta()` and tool fallback path | Used for assistant text and generic tool output that is not recognized as a command/file change. |
| `item/reasoning/summaryTextDelta` | `TurnStateMachine.handleThinkingDelta()` | Reasoning text is accumulated into a reasoning item. |
| `item/commandExecution/outputDelta` | `TurnStateMachine.handleToolUpdate()` | Used for bash/shell/command-like tool calls. |
| `item/fileChange/outputDelta` | `TurnStateMachine.handleToolUpdate()` | Used for edit/write/patch/file-like tool calls. |

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
| `model/list` | `backend.listModels()` via `AppServerConnection` | Translated from Pi model summaries to Codex model shapes. |
| `turn/start` model selection | `backend.setModel()` | If a model is requested, it is set before prompting. |
| `backend.getCapabilities()` | `backend-pi` capability snapshot | Currently reports image, thinking, and parallel tool support. |
| `backend.respondToElicitation()` | `backend-pi` process bridge | Wired through outbound `item/tool/requestUserInput` server requests and inbound JSON-RPC responses. |

## `command/exec`

`command/exec` is adapter-native in codapter and is not routed through Pi.

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
| Session identity | Opaque `sessionId` values | The adapter stores opaque ids and does not expose Pi session file paths. |
| Session history | Pi JSONL session files | Reconstructed through the backend session store. |
| Prompt events | `text_delta`, `thinking_delta`, `tool_start`, `tool_update`, `tool_end`, `message_end`, `token_usage`, `elicitation_request` | These are bridged into `BackendEvent` and then into Codex notifications. |

## Unsupported Or Partially Implemented Areas

| Codex concept | Current state | Notes |
| --- | --- | --- |
| Worktree RPCs (`create-worktree`, `delete-worktree`, `resolve-worktree-for-thread`, `worktree-cleanup-inputs`) | Not implemented | They currently return `Method not found`. |
| Elicitation server requests (`item/tool/requestUserInput`, `mcpServer/elicitation/request`) | Pi-backed elicitation implemented | `item/tool/requestUserInput` is fully wired as a server-request round-trip. MCP server elicitation is still unsupported. |
| Legacy `codex/event/*` compatibility | Not implemented as a public surface | The current implementation targets the typed app-server surface instead. |
| Remote deployment flow | Supported only through the CLI listener transport | There is no separate remote orchestration layer in codapter. |

## Current Gaps

The implementation is usable for threads, turns, Pi-backed replies, standalone commands, and Pi-backed user-input prompts. The main remaining gaps are:

1. Worktree RPCs are still unsupported.
2. Turn-level diff/plan notifications are not emitted.
3. Remote tunnel orchestration is still external to codapter.
