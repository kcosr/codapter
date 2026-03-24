# Backend Routing And Codex Proxy Schema Proposal

Status: Locked

## Goal

Lock the internal contract changes needed to support one routed backend surface with:

1. backend-prefixed model ids,
2. backend-owned thread handles,
3. generic backend-originated notifications and server requests.

This document does not redefine the external Codex app-server protocol. It locks codapter's internal backend contract and the adapter-owned persisted metadata semantics that execution work will rely on.

## Example Request / Response Payloads

### Aggregated model list entry

```json
{
  "id": "codex::gpt-5.4",
  "model": "codex::gpt-5.4",
  "displayName": "codex / GPT-5.4",
  "description": "Codex upstream model",
  "hidden": false,
  "isDefault": false,
  "inputModalities": ["text", "image"],
  "supportedReasoningEfforts": [
    { "reasoningEffort": "low", "description": "Fast responses with lighter reasoning" },
    { "reasoningEffort": "medium", "description": "Balanced reasoning depth and latency" },
    { "reasoningEffort": "high", "description": "Greater reasoning depth for complex problems" }
  ],
  "defaultReasoningEffort": "medium",
  "supportsPersonality": true
}
```

Pi example:

```json
{
  "id": "pi::anthropic/claude-opus-4-6",
  "model": "pi::anthropic/claude-opus-4-6",
  "displayName": "pi / Opus 4.6",
  "description": "Pi-backed Anthropic model",
  "hidden": false,
  "isDefault": true,
  "inputModalities": ["text", "image"],
  "supportedReasoningEfforts": [
    { "reasoningEffort": "minimal", "description": "Fast responses with lighter reasoning" },
    { "reasoningEffort": "medium", "description": "Balanced reasoning depth and latency" },
    { "reasoningEffort": "high", "description": "Greater reasoning depth for complex problems" }
  ],
  "defaultReasoningEffort": "medium",
  "supportsPersonality": false
}
```

### Parsed model selection

```json
{
  "backendType": "codex",
  "rawModelId": "gpt-5.4"
}
```

### Persisted thread registry semantics

Existing storage field names remain:

```json
{
  "threadId": "thr_123",
  "backendType": "codex",
  "backendSessionId": "upstream-thread-handle-or-id",
  "model": "codex::gpt-5.4",
  "modelProvider": "codex",
  "reasoningEffort": "medium"
}
```

`backendSessionId` is semantically reinterpreted as an opaque backend-owned thread handle.

Thread-handle update rule:

```json
{
  "threadHandle": "new-opaque-backend-handle-if-changed",
  "previousThreadHandle": "old-opaque-backend-handle"
}
```

If `threadResume` or `threadFork` returns a new handle, codapter must persist the new value immediately.

### Backend thread-read result

```json
{
  "threadHandle": "opaque-thread-handle",
  "threadId": "thr_123",
  "title": "Thread title",
  "model": "codex::gpt-5.4",
  "turns": [
    {
      "turnId": "turn_123",
      "status": "completed",
      "items": [
        {
          "type": "message",
          "role": "assistant",
          "text": "ok"
        }
      ]
    }
  ]
}
```

This result is already normalized to codapter's outward `thread/read` semantics.

### Backend server-request resolution mapping

```json
{
  "outerRequestId": "req_outer_123",
  "backendRequestId": "req_inner_987",
  "threadHandle": "opaque-thread-handle",
  "backendType": "codex"
}
```

Codapter owns this mapping for proxied backends so concurrent upstream server requests cannot collide.

### Generic backend-originated server request

```json
{
  "kind": "serverRequest",
  "threadHandle": "opaque-thread-handle",
  "requestId": "req_123",
  "method": "item/tool/requestUserInput",
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_123",
    "itemId": "call_123",
    "questions": [
      {
        "id": "confirm_path",
        "header": "Confirm",
        "question": "Use this path?",
        "isOther": false,
        "isSecret": false,
        "options": [
          { "label": "Yes", "description": "Use the path" },
          { "label": "No", "description": "Decline the path" }
        ]
      }
    ]
  }
}
```

### Generic backend-originated error event

```json
{
  "kind": "error",
  "threadHandle": "opaque-thread-handle",
  "code": "UPSTREAM_PROTOCOL_ERROR",
  "message": "Codex backend returned an invalid notification payload",
  "retryable": false
}
```

### Generic backend-originated notification

```json
{
  "kind": "notification",
  "threadHandle": "opaque-thread-handle",
  "method": "item/agentMessage/delta",
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_123",
    "itemId": "msg_123",
    "delta": "ok"
  }
}
```

## JSON Schema Skeleton

### Parsed backend selection

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["backendType", "rawModelId"],
  "properties": {
    "backendType": { "type": "string", "minLength": 1 },
    "rawModelId": { "type": "string", "minLength": 1 }
  }
}
```

### Generic backend app-server event

```json
{
  "oneOf": [
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "threadHandle", "method", "params"],
      "properties": {
        "kind": { "const": "notification" },
        "threadHandle": { "type": "string", "minLength": 1 },
        "method": { "type": "string", "minLength": 1 },
        "params": {}
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "threadHandle", "requestId", "method", "params"],
      "properties": {
        "kind": { "const": "serverRequest" },
        "threadHandle": { "type": "string", "minLength": 1 },
        "requestId": { "type": ["string", "number"] },
        "method": { "type": "string", "minLength": 1 },
        "params": {}
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "threadHandle", "code", "message", "retryable"],
      "properties": {
        "kind": { "const": "error" },
        "threadHandle": { "type": "string", "minLength": 1 },
        "code": { "type": "string", "minLength": 1 },
        "message": { "type": "string", "minLength": 1 },
        "retryable": { "type": "boolean" }
      }
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["kind", "threadHandle", "message"],
      "properties": {
        "kind": { "const": "disconnect" },
        "threadHandle": { "type": "string", "minLength": 1 },
        "message": { "type": "string", "minLength": 1 }
      }
    }
  ]
}
```

### Backend model summary

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id",
    "model",
    "displayName",
    "description",
    "hidden",
    "isDefault",
    "inputModalities",
    "supportedReasoningEfforts",
    "defaultReasoningEffort",
    "supportsPersonality"
  ],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9-]+::.+$" },
    "model": { "type": "string", "pattern": "^[a-z0-9-]+::.+$" },
    "displayName": { "type": "string", "minLength": 1 },
    "description": { "type": "string" },
    "hidden": { "type": "boolean" },
    "isDefault": { "type": "boolean" },
    "inputModalities": { "type": "array", "items": { "type": "string" } },
    "supportedReasoningEfforts": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["reasoningEffort", "description"],
        "properties": {
          "reasoningEffort": { "type": "string" },
          "description": { "type": "string" }
        }
      }
    },
    "defaultReasoningEffort": { "type": "string" },
    "supportsPersonality": { "type": "boolean" }
  }
}
```

Parsing rule:

1. `backendType` may contain only lowercase letters, digits, and `-`,
2. routing parses on the first `::`,
3. raw model ids may contain any remaining text after the first delimiter,
4. the aggregated router exposes at most one model with `isDefault: true`.

## Endpoint / Contract Lock

Locked decisions:

1. `IBackend` becomes the single high-level backend contract used by `AppServerConnection`.
2. Model ids exposed to the client are backend-prefixed stable ids using `backendType::rawModelId`.
3. `backendType` persisted in thread registry is authoritative for backend routing on resume/fork/collab.
4. `backendSessionId` remains the persisted field name for now, but its contract is "opaque backend-owned thread handle".
5. Generic backend-originated notifications and server requests are first-class contract members.
6. Generic backend-originated non-fatal errors are first-class contract members.
7. `thread/read` results returned by backends are already normalized to codapter's outward thread-read contract.
8. Codapter owns outer-request-id to backend-request-id mapping for proxied backends.
9. Codex backend is protocol-preserving by default and must not pass through `TurnStateMachine`.

Deferred but not blocked:

1. dynamic tool request support,
2. MCP server elicitation passthrough,
3. Codex -> Pi child-agent spawning.

## Deterministic Reject / Status Lock

The implementation must reject deterministically for:

1. unknown backend prefix in model id,
2. missing raw model id after prefix parse,
3. attempt to resume/fork a thread whose `backendType` has no registered backend,
4. attempt to start a collab child on a backend that is unavailable or uninitialized,
5. attempt to reinterpret a stored thread as another backend type without an explicit migration path,
6. attempt to fork a thread onto a different backend type than the source thread,
7. attempt to route a request through an unavailable backend.

Status semantics for design scope:

1. this document is `Draft` until reviews are triaged,
2. once reviews are incorporated, status changes to `Locked`,
3. if superseded by a later design, status must change to `Superseded` rather than silently edited in place.

## Notes

1. This schema proposal is intentionally internal-facing. It exists to lock execution semantics before code refactoring begins.
2. The external Codex app-server JSON-RPC surface remains unchanged.
3. Websocket support for Codex backend remains optional in the phase plan, but the contract leaves room for either stdio or websocket transport under the same `CodexBackend`.
