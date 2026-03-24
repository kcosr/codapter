# Backend Interface

`packages/core/src/backend.ts` defines the adapter-to-backend contract.

## Scope

- `IBackend` owns backend-thread lifecycle and turn streaming.
- `BackendRouter` owns model-id routing across multiple backends.
- `command/exec` is adapter-native and intentionally excluded.
- Backend thread handles are opaque backend-owned values. The adapter stores them as metadata but does not derive meaning from them.

## Lifecycle

- `initialize()`: prepare backend resources once during adapter startup.
- `dispose()`: release backend resources on shutdown.
- `isAlive()`: health check for routing and shutdown decisions.

## Model Routing

- Adapter-facing model ids are backend-routed. Pi models use `"<backendType>::<rawModelId>"`, while Codex is treated as native and uses raw model ids like `"gpt-5.4"`. Legacy `codex::...` ids remain accepted on input.
- `parseBackendModelId()` parses routed ids; `encodeBackendModelId()` writes them.
- `BackendRouter.listModels()` aggregates healthy backend model lists and exposes a single aggregated default model.
- `BackendRouter.resolveModelSelection()` resolves the owning backend and raw backend model id.

## Thread Methods

- `threadStart(input)`: create a backend thread handle for a new adapter thread.
- `threadResume(input)`: reconnect an adapter thread to an existing backend handle.
- `threadFork(input)`: fork from a source backend handle and return a new backend handle.
- `threadRead(input)`: return backend-normalized `Turn[]` for adapter `thread/read`.
- `threadArchive(input)`: archive backend state for the thread.
- `threadSetName(input)`: persist backend thread name.

## Turn Methods

- `turnStart(input)`: begin a turn for a thread handle.
- `turnInterrupt(input)`: interrupt the active turn for a thread handle.
- `resolveServerRequest(input)`: send a response for an outstanding backend-originated server request.

## App-Server Event Contract

`IBackend.onEvent(threadHandle, listener)` emits `BackendAppServerEvent` values:

- `notification`: backend thread notification (`method`, `params`).
- `serverRequest`: backend-originated server request (`requestId`, `method`, `params`).
- `error`: non-fatal backend/proxy error (`code`, `message`, `retryable`).
- `disconnect`: backend transport/thread disconnect.

`BackendThreadEventBuffer` in `backend.ts` provides queue-before-subscribe semantics so early backend events are not dropped while runtime listeners are being bound.

## Legacy Pi Turn-Event Types

`backend.ts` still exports `BackendEvent` (`text_delta`, `thinking_delta`, `tool_*`, `message_end`, etc.) for Pi normalization helpers. This is separate from the routed `BackendAppServerEvent` contract above.

## Adapter Expectations

- Backends must route all events by the exact `threadHandle` associated with that runtime.
- Backends must support deterministic failure for invalid handles/models.
- Backends must treat `threadHandle` as opaque and avoid adapter-specific assumptions.
