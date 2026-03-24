# Codapter Architecture

Codapter is a protocol adapter. It exposes the Codex app-server JSON-RPC surface on the client side and routes requests to one or more backend implementations.

## Runtime Layout

- `packages/cli` owns startup, transport listeners, and backend registration.
- `packages/core` owns JSON-RPC dispatch, backend routing, thread registry state, and turn/event orchestration.
- `packages/backend-pi` owns Pi process integration.
- `packages/backend-codex` owns Codex app-server proxying over stdio.

## Request Flow

1. The client connects over stdio, WebSocket/TCP, or WebSocket/UDS.
2. The client sends `initialize`, then `initialized`.
3. `AppServerConnection` handles config/auth/model/thread/turn RPC methods.
4. `BackendRouter` aggregates `model/list` and resolves backend-prefixed model ids (`<backendType>::<rawModelId>`).
5. Thread methods (`thread/start`, `thread/resume`, `thread/fork`, `thread/read`, `thread/archive`, `thread/name/set`) route to the owning backend through `IBackend`.
6. Turn methods (`turn/start`, `turn/interrupt`) run on the owning backend thread handle.
7. Backend-originated notifications/server-requests/errors/disconnects are published as Codex app-server notifications.
8. `command/exec` remains adapter-native and does not route through backends.

## Core Contracts

### `IBackend`

Defined in `packages/core/src/backend.ts`.

- Lifecycle: `initialize()`, `dispose()`, `isAlive()`.
- Models: `listModels()`, `parseModelSelection()`.
- Thread lifecycle: `threadStart()`, `threadResume()`, `threadFork()`, `threadRead()`, `threadArchive()`, `threadSetName()`.
- Turn lifecycle: `turnStart()`, `turnInterrupt()`.
- Server-request responses: `resolveServerRequest()`.
- Event stream: `onEvent(threadHandle, listener)` emits `BackendAppServerEvent`.

### `BackendRouter`

Defined in `packages/core/src/backend-router.ts`.

- Registers backends by `backendType`.
- Aggregates healthy backend model lists into one picker surface.
- Enforces one aggregated default model.
- Resolves routed model ids to `{ backendType, rawModelId }` + backend instance.

### Thread Registry

Thread metadata is adapter-owned and persisted by `packages/core/src/thread-registry.ts`.

- Stores thread metadata (`name`, `cwd`, preview, archive, model fields).
- Stores backend ownership metadata (`backendType`, opaque `backendSessionId` thread handle).
- `thread/list` reads registry state; it does not scan backend history.

### Event Buffering

`BackendThreadEventBuffer` (in `backend.ts`) buffers backend events per thread handle until a runtime listener is attached, preventing early event loss during start/resume/fork races.

## Backends

### Pi Backend (`packages/backend-pi`)

- Spawns and communicates with Pi over JSONL stdio.
- Converts Pi stream data to backend-neutral app-server events.
- Implements backend-owned `thread/read` hydration for Pi threads.

### Codex Backend (`packages/backend-codex`)

- Spawns `codex app-server` over stdio.
- Relays JSON-RPC requests/responses/notifications and server requests.
- Rewrites model ids between routed (`codex::...`) and upstream raw model ids.
- Emits backend error/disconnect events for proxy failures.
- Websocket transport is currently deferred and rejected deterministically.

## Collaboration Routing

With collaboration enabled, `CollabManager` routes child-agent operations (`spawn`, `sendInput`, `wait`, `resume`, `close`) through each child thread's owning backend. This enables Pi parent threads to spawn and operate Codex child threads.

## Current Limitations

- Codex websocket transport is deferred.
- Pi-backed threads can spawn Codex sub-agents, but Codex-backed threads cannot spawn Pi sub-agents.
- `command/exec` PTY mode is not implemented (`tty: true` rejected).
- MCP server elicitation remains unsupported.
