# Backend Interface

`packages/core/src/backend.ts` defines the adapter-to-backend contract.

## Scope

- `IBackend` owns model/session lifecycle and turn streaming.
- `command/exec` is adapter-native and intentionally excluded.
- Session identifiers are opaque backend-owned values. The adapter stores them as metadata but does not derive meaning from them.

## Lifecycle

- `initialize()`: prepare backend resources once during adapter startup.
- `dispose()`: release backend resources on shutdown.
- `isAlive()`: health check for routing and shutdown decisions.

## Session Methods

- `createSession()`: start a new backend session.
- `resumeSession(sessionId)`: reconnect to an existing backend session.
- `forkSession(sessionId)`: clone an existing session and return a new opaque session id.
- `disposeSession(sessionId)`: release backend-side session state.
- `readSessionHistory(sessionId)`: return persisted messages for `thread/read` hydration.
- `setSessionName(sessionId, name)`: persist a user-visible session name.

## Turn Methods

- `prompt(sessionId, turnId, text, images?)`: start a turn for a session.
- `abort(sessionId)`: interrupt the active turn for a session.
- `respondToElicitation(sessionId, requestId, response)`: resolve a prior `elicitation_request` event.

## Model / Capability Methods

- `listModels()`: returns backend models for `model/list`.
- `setModel(sessionId, modelId)`: change the active model for a session.
- `getCapabilities()`: stable feature flags used by the adapter when shaping requests or events.

## Event Contract

Every `BackendEvent` carries:
- `sessionId`
- `turnId`

Correlation fields required by specific variants:
- `tool_start`, `tool_update`, `tool_end`: `toolCallId`
- `tool_update`: `isCumulative`
- `elicitation_request`: `requestId`
- `token_usage`: `usage`

Terminal semantics:
- `message_end` marks the end of streamed assistant output for a turn.
- `tool_end` marks the terminal state for one tool call.
- `error` is terminal for the current backend action unless the backend documents otherwise.

Delta semantics:
- `text_delta` and `thinking_delta` are append-only deltas.
- `tool_update.isCumulative = true` means the payload is the full tool output so far and the adapter must diff it before emitting protocol deltas.
- `tool_update.isCumulative = false` means the payload is already a pure delta.

## Adapter Expectations

- Backends must not emit events for the wrong `turnId`; the adapter uses `turnId` for stale-event gating.
- Backends must keep `toolCallId` stable for the life of a tool invocation.
- Backends must not require file-path knowledge from the adapter; all resume/fork operations use opaque ids.
