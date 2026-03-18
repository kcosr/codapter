# Codapter Architecture

Codapter is a protocol adapter. It exposes the Codex app-server JSON-RPC surface on the GUI side and translates that traffic to a backend-specific RPC/process model on the other side.

## Runtime Layout

- `packages/cli` owns process startup, `app-server` dispatch, and transport listeners.
- `packages/core` owns JSON-RPC handling, thread registry state, turn streaming, and adapter-native command execution.
- `packages/backend-pi` owns the Pi backend implementation and the subprocess bridge that speaks Pi RPC over JSONL.

## Request Flow

1. The client connects over stdio, WebSocket over TCP, or WebSocket over Unix domain socket.
2. The client sends `initialize`, then `initialized`.
3. The adapter serves config/auth/model/thread RPCs from `AppServerConnection`.
4. Thread RPCs create or attach backend sessions through `IBackend`.
5. `turn/start` submits a prompt to the backend and streams backend events back as Codex `thread/*`, `turn/*`, and `item/*` notifications.
6. `command/exec` runs locally in the adapter process through Node child processes or PTYs, not through the backend.

## Core Contracts

### `IBackend`

`packages/core/src/backend.ts` defines the adapter-to-backend contract.

- Session lifecycle is opaque. The adapter stores session ids but does not infer file paths or backend internals from them.
- Turn streaming is event-driven. Backend events always carry `sessionId` and `turnId`.
- Parallel tool correlation uses `toolCallId`.
- Elicitation resolution uses `requestId`.
- Token accounting uses `token_usage` events.

### `AppServerConnection`

`packages/core/src/app-server.ts` is the JSON-RPC router and state machine for one connection.

- Enforces initialize-before-use.
- Filters notifications by `optOutNotificationMethods`.
- Maintains per-connection thread runtime state.
- Translates thread lifecycle methods into registry and backend calls.
- Owns turn streaming orchestration and final turn completion.
- Owns `thread/unsubscribe` filtering for the connection.

### Thread Registry

The adapter-owned registry is the source of truth for thread metadata.

- Thread identity, name, cwd, preview, archive state, and model provider live in registry storage.
- Backend session ids are stored as internal metadata only.
- `thread/list` reads the registry, not the backend.
- Registry writes are atomic temp-file-plus-rename writes.

### Turn Streaming

`packages/core/src/turn-state.ts` normalizes backend events into Codex item notifications.

- `text_delta` maps to `item/agentMessage/delta`.
- `thinking_delta` maps to `item/reasoning/textDelta`.
- Tool events map to `commandExecution`, `fileChange`, or `agentMessage` items based on the tool name.
- `tool_update.isCumulative` is diffed before emitting deltas when the backend provides cumulative output.
- `message_end` and `error` terminate the active turn.

### Command Execution

`packages/core/src/command-exec.ts` implements adapter-native shell execution.

- Buffered execution uses `child_process.spawn`.
- PTY execution uses `node-pty`.
- Output is streamed as base64 `command/exec/outputDelta` notifications.
- Process ids are connection-scoped.
- Closing the connection terminates any tracked command processes.

## Backend-Pi

`packages/backend-pi` is a process-backed Pi adapter.

- It spawns Pi RPC subprocesses.
- It uses JSONL framing on stdin/stdout.
- It persists opaque adapter session ids in local state.
- It translates Pi runtime events into `BackendEvent` values for the core state machine.

## Current Limitations

- Pi-backed elicitation is wired through outbound `item/tool/requestUserInput` server requests, but MCP server elicitation is still unsupported.
- Tool translation is heuristic-based for non-command/file-change tools.
- The implementation is intentionally backend-specific to Pi for now.
- Remote/Desktop end-to-end validation is still a separate integration step.
