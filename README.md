# Codapter

> **WIP / Prototype** — This project is an early-stage proof of concept. APIs, configuration, and behavior may change without notice. Not recommended for production use.

A protocol adapter that lets the [Codex Desktop](https://developers.openai.com/codex/app) GUI work with alternative AI backends. Set `CODEX_CLI_PATH` to point at codapter, launch Codex Desktop, and your conversations are powered by the backend of your choice.

![Codapter running inside Codex Desktop](docs/images/codex-desktop-example.png)

*Codex Desktop connected through codapter to a Pi-backed remote session.*

**First supported backend**: [Pi](https://github.com/badlogic/pi-mono) (`@mariozechner/pi-coding-agent`) with multi-provider LLM support (Anthropic, OpenAI, Google, Mistral, and more).

## How It Works

Codapter implements the Codex app-server JSON-RPC protocol — the same wire protocol the Codex Desktop Electron app uses to talk to the official Codex CLI. The GUI connects to codapter over stdio (local) or WebSocket (remote), and codapter translates every request into the target backend's native protocol.

```mermaid
graph TB
    GUI["Codex Desktop GUI<br/>(unmodified Electron app)"]

    subgraph Codapter
        Transport["Transport Layer<br/>stdio / WebSocket TCP / WebSocket UDS"]
        AppServer["App Server<br/>JSON-RPC protocol handler"]
        Registry["Thread Registry<br/>persistent thread metadata"]
        ConfigStore["Config Store<br/>persistent settings"]
        CmdExec["Command Exec<br/>adapter-native shell"]
        TurnSM["Turn State Machine<br/>event decomposition"]
    end

    subgraph Backend["Backend (Pi)"]
        PiBackend["Pi Backend<br/>IBackend implementation"]
        PiProc1["Pi Process 1<br/>Thread A"]
        PiProc2["Pi Process 2<br/>Thread B"]
    end

    GUI -->|"JSON-RPC<br/>NDJSON / WebSocket"| Transport
    Transport --> AppServer
    AppServer --> Registry
    AppServer --> ConfigStore
    AppServer --> CmdExec
    AppServer --> TurnSM
    TurnSM --> PiBackend
    PiBackend --> PiProc1
    PiBackend --> PiProc2
```

## Quick Start

### Prerequisites

- **Node.js 22+** ([download](https://nodejs.org/))
- **Codex Desktop** installed ([download](https://developers.openai.com/codex/app))
- **[Pi coding agent](https://github.com/badlogic/pi-mono)** installed and configured with at least one LLM provider (see Pi documentation for setup)

### 1. Install & Build Codapter

```bash
git clone <repo-url> codapter
cd codapter
npm install
npm run build:dist
```

### 2. Run Locally

Point Codex Desktop at codapter:

```bash
export CODEX_CLI_PATH="$(pwd)/dist/codapter.mjs"
# Launch Codex Desktop — it will use codapter instead of the official CLI
```

Or run codapter directly for testing:

```bash
# Stdio mode (how Codex Desktop spawns it)
node dist/codapter.mjs app-server

# Stdio mode with collab sub-agent support enabled via env var
CODAPTER_COLLAB=1 node dist/codapter.mjs app-server

# WebSocket mode (for remote connections)
node dist/codapter.mjs app-server --listen ws://127.0.0.1:9234

# Unix domain socket mode (for containerized environments)
node dist/codapter.mjs app-server --listen unix:///tmp/codapter.sock

# Multiple listeners simultaneously
node dist/codapter.mjs app-server \
  --listen ws://127.0.0.1:9234 \
  --listen unix://$HOME/.codex/adapter.sock
```

### Build Distribution Binary

```bash
npm run build:dist
# Builds all packages and creates dist/codapter.mjs
```

## Architecture

### Transport Layer

Codapter supports three transport modes, all serving the same JSON-RPC protocol:

| Mode | Flag | Use Case |
|------|------|----------|
| **stdio** | *(default, no flag)* | Local mode — Codex Desktop spawns codapter as a child process |
| **WebSocket/TCP** | `--listen ws://host:port` | Remote mode — SSH tunnel to this endpoint |
| **WebSocket/UDS** | `--listen unix:///path/to/sock` | Container mode — SSH streamlocal forwarding |

The `CODAPTER_LISTEN` environment variable can be used instead of `--listen` flags (comma-separated for multiple listeners).

All WebSocket listeners serve the root `/` endpoint. Health checks are available at `/healthz` and `/readyz`.

### Request Lifecycle

```mermaid
sequenceDiagram
    participant GUI as Codex Desktop
    participant Adapter as Codapter
    participant Registry as Thread Registry
    participant Backend as Pi Backend
    participant Pi as Pi Process

    GUI->>Adapter: initialize {clientInfo, capabilities}
    Adapter->>GUI: {userAgent, platformFamily, platformOs}
    GUI->>Adapter: initialized (notification)

    Note over GUI,Adapter: Connection ready

    GUI->>Adapter: thread/start {model, cwd}
    Adapter->>Backend: createSession(cwd)
    Backend->>Pi: spawn pi-coding-agent --mode rpc
    Pi-->>Backend: process ready
    Adapter->>Registry: store thread metadata
    Adapter->>GUI: {thread: {id, status, cwd, ...}}

    GUI->>Adapter: turn/start {threadId, input}
    Adapter->>Backend: prompt(sessionId, turnId, text)
    Backend->>Pi: {"type":"prompt","message":"..."}

    loop Streaming Events
        Pi-->>Backend: text_delta / tool_start / tool_end / ...
        Backend-->>Adapter: BackendEvent
        Adapter->>Adapter: TurnStateMachine processes event
        Adapter-->>GUI: item/agentMessage/delta
        Adapter-->>GUI: item/started (commandExecution)
        Adapter-->>GUI: item/commandExecution/outputDelta
        Adapter-->>GUI: item/completed
    end

    Pi-->>Backend: message_end
    Backend-->>Adapter: {type: "message_end"}
    Adapter-->>GUI: turn/completed {status: "completed"}
```

### Thread & Session Model

Codapter maintains a **thread registry** as the single source of truth for all thread identity and metadata. Each thread maps to a backend session through an opaque session ID.

```mermaid
graph LR
    subgraph "Thread Registry (persistent)"
        T1["Thread abc-123<br/>name: 'Fix login bug'<br/>archived: false<br/>cwd: /home/user/project"]
        T2["Thread def-456<br/>name: 'Add tests'<br/>archived: false<br/>cwd: /home/user/project"]
        T3["Thread ghi-789<br/>name: 'Old thread'<br/>archived: true"]
    end

    subgraph "Backend Sessions"
        S1["Pi Session pi_session_aaa<br/>(process running)"]
        S2["Pi Session pi_session_bbb<br/>(process idle)"]
        S3["Pi Session pi_session_ccc<br/>(no process)"]
    end

    T1 -->|backendSessionId| S1
    T2 -->|backendSessionId| S2
    T3 -->|backendSessionId| S3
```

**Storage**: `~/.local/share/codapter/threads.json` (atomic writes via temp file + rename)

**Key behaviors**:
- `thread/list` reads exclusively from the registry — never from the backend
- `thread/start` creates both a registry entry and a backend session
- `thread/resume` spawns a new backend process and reattaches to the existing session
- `thread/fork` creates a new registry entry and clones the backend session
- `thread/archive` marks the thread in the registry and disposes the backend process

### Turn State Machine

Each active turn runs a state machine that decomposes backend events into Codex GUI notifications:

```mermaid
stateDiagram-v2
    [*] --> Idle: thread created
    Idle --> TurnActive: turn/start
    TurnActive --> TurnActive: text_delta → item/agentMessage/delta
    TurnActive --> TurnActive: thinking_delta → item/reasoning/summaryTextDelta
    TurnActive --> TurnActive: tool_start → item/started
    TurnActive --> TurnActive: tool_update → item/outputDelta
    TurnActive --> TurnActive: tool_end → item/completed
    TurnActive --> Idle: message_end → turn/completed(completed)
    TurnActive --> Idle: error → turn/completed(failed)
    TurnActive --> Idle: turn/interrupt → turn/completed(interrupted)
```

**Tool classification** is heuristic — based on the tool name:
- Names matching `bash`, `shell`, `command` → `commandExecution` item
- Names matching `edit`, `write`, `patch`, `file` → `fileChange` item
- Everything else → `agentMessage` item (tool output rendered as text)

**Cumulative output handling**: Pi's `tool_execution_update` sends cumulative (full) output, not deltas. The state machine diffs against previous output to extract the true delta for Codex streaming.

### Command Execution

Standalone shell commands (`command/exec`) are handled **natively by the adapter** using Node.js `child_process`, not routed through the backend. This avoids blocking the backend's single-threaded session.

| Method | Description |
|--------|-------------|
| `command/exec` | Spawn process, buffer or stream output |
| `command/exec/write` | Write to process stdin (base64 encoded) |
| `command/exec/terminate` | Kill process with SIGTERM |

Output is capped at 1MB per stream by default (configurable via `outputBytesCap`). Streaming mode (`streamStdoutStderr: true`) sends `command/exec/outputDelta` notifications as data arrives.

> **Note**: PTY/TTY mode (`tty: true`) is not supported. The Codex Desktop GUI does not appear to use this mode.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CODEX_CLI_PATH` | Set this to codapter's path so Codex Desktop uses it | — |
| `CODAPTER_LISTEN` | Comma-separated listener URIs (alternative to `--listen`) | *(stdio)* |
| `CODAPTER_COLLAB` | Enable collab sub-agent support (alternative to `--collab`) | *(disabled)* |
| `CODAPTER_PI_COMMAND` | Override the command used to launch Pi | `npx` |
| `CODAPTER_PI_ARGS` | Override Pi launch args (JSON array string); `--session-dir` is always appended | `["--yes","@mariozechner/pi-coding-agent","--mode","rpc"]` |
| `CODAPTER_PI_IDLE_TIMEOUT_MS` | Idle timeout before Pi processes are gracefully stopped (ms; 0 disables) | `300000` (5 min) |
| `CODAPTER_EMULATE_CODEX_IDENTITY` | User agent string returned in `initialize` | `codex-app-server` |
| `CODAPTER_COLLAB_EXTENSION_PATH` | Override path to the collab extension script | *(built-in)* |
| `CODAPTER_DEBUG_LOG_FILE` | Path to JSONL debug log file | *(disabled)* |

### Config Store

The adapter maintains a config store that responds to `config/read` and `config/value/write` RPCs. Values are persisted to `~/.config/codapter/config.toml`, so settings like model selection and reasoning effort survive adapter restarts.

### Pi Backend Configuration

The Pi backend uses its own configuration at `~/.pi/agent/`:
- **API keys**: `~/.pi/agent/auth.json`
- **Sessions**: managed under `~/.local/share/codapter/backend-pi/`
- **Model selection**: all models configured in Pi are exposed through `model/list`

## Supported Codex RPC Methods

### Fully Implemented

| Method | Description |
|--------|-------------|
| `initialize` | Connection handshake with capabilities negotiation |
| `thread/start` | Create new conversation thread |
| `thread/resume` | Reconnect to existing thread |
| `thread/fork` | Clone thread at current state |
| `thread/read` | Read thread metadata and turn history |
| `thread/list` | List threads with filtering and pagination |
| `thread/loaded/list` | List currently loaded (active process) threads |
| `thread/name/set` | Rename a thread |
| `thread/archive` / `thread/unarchive` | Archive management |
| `thread/metadata/update` | Update git info |
| `thread/unsubscribe` | Stop notifications for a thread |
| `turn/start` | Send user message, stream response |
| `turn/interrupt` | Cancel in-progress turn |
| `model/list` | List available models from backend |
| `config/read` | Read adapter configuration |
| `config/value/write` / `config/batchWrite` | Write configuration (persisted to disk) |
| `configRequirements/read` | Returns null (no requirements) |
| `getAuthStatus` / `account/read` | Returns synthetic auth state (chatgpt/pro) |
| `command/exec` | Execute shell commands (adapter-native) |
| `command/exec/write` | Write to process stdin |
| `command/exec/terminate` | Kill running process |
| `command/exec/resize` | Resize terminal (returns unsupported error without PTY) |
| `account/login/start` | API key or ChatGPT token login |
| `account/login/cancel` | Cancel login flow |
| `account/logout` | Logout and clear auth state |
| `account/rateLimits/read` | Rate limit snapshot |
| `skills/list` | Returns empty list |
| `plugin/list` | Returns empty list |
| `app/list` | Returns empty list |

### Stubbed (Return Empty/Default)

| Method | Response |
|--------|----------|
| `collaborationMode/list` | Empty list |
| `experimentalFeature/list` | Empty list |
| `mcpServerStatus/list` | Empty list |

### Not Supported

Any unrecognized method returns JSON-RPC error `-32601 Method not found`. This allows the GUI to gracefully degrade for features that don't have backend equivalents (sub-agents, MCP tools, worktrees, realtime voice, etc.).

## Streaming Events

Notifications emitted to the GUI during turns:

| Notification | When |
|-------------|------|
| `thread/started` | New thread created |
| `thread/status/changed` | Thread state transition |
| `thread/name/updated` | Thread renamed |
| `turn/started` | Turn begins |
| `turn/completed` | Turn ends (completed / interrupted / failed) |
| `item/started` | New ThreadItem begins (message, command, file change) |
| `item/completed` | ThreadItem finished |
| `item/agentMessage/delta` | Streamed text content |
| `item/reasoning/summaryTextDelta` | Streamed thinking/reasoning content |
| `item/commandExecution/outputDelta` | Streamed command output |
| `item/fileChange/outputDelta` | Streamed file change content |
| `command/exec/outputDelta` | Standalone shell output (not turn-related) |
| `thread/tokenUsage/updated` | Token usage statistics |

## Remote Setup

### SSH Tunnel (WebSocket/TCP)

If `codapter.mjs` is on the remote host's `PATH`, you can sanity-check the remote binary directly:

```bash
ssh user@remote-host 'codapter.mjs app-server'
```

For an actual remote desktop connection, start a listener on the remote host and forward it locally:

```bash
# On remote host:
node /path/to/codapter.mjs app-server --listen ws://127.0.0.1:9234

# From local machine:
ssh -N -L 9234:127.0.0.1:9234 user@remote-host

# Codex Desktop connects to ws://127.0.0.1:9234/
```

### SSH Tunnel (Unix Domain Socket)

For containerized environments where port publishing is impractical:

```bash
# In container:
node /path/to/codapter.mjs app-server --listen unix://$HOME/.codex/adapter.sock

# From local machine (streamlocal forward):
ssh -N -L 127.0.0.1:9234:/home/user/workspace/.codex/adapter.sock user@host

# Codex Desktop connects to ws://127.0.0.1:9234/
```

### Persistent Remote Mode

Run with `nohup` so the adapter survives SSH disconnects:

```bash
nohup node /path/to/codapter.mjs app-server \
  --listen ws://127.0.0.1:9234 \
  > /tmp/codapter.log 2>&1 &
```

The adapter stays alive with backend processes managed by idle timeouts. When Codex Desktop reconnects, it sends `thread/resume` and gets full history from the persistent session files.

## Backend Interface

Codapter is designed to support multiple backends through the `IBackend` interface. Pi is the first implementation.

```mermaid
classDiagram
    class IBackend {
        <<interface>>
        +initialize(options) Promise~void~
        +dispose() Promise~void~
        +isAlive() boolean
        +createSession(cwd) Promise~BackendSession~
        +resumeSession(sessionId, cwd) Promise~BackendSession~
        +forkSession(sessionId) Promise~BackendSession~
        +disposeSession(sessionId) Promise~void~
        +readSessionHistory(sessionId) Promise~BackendMessage[]~
        +setSessionName(sessionId, name) Promise~void~
        +prompt(sessionId, turnId, text, images?) Promise~void~
        +abort(sessionId) Promise~void~
        +listModels() Promise~BackendModelSummary[]~
        +setModel(sessionId, modelId) Promise~void~
        +onEvent(sessionId, listener) Disposable
    }

    class PiBackend {
        -processes: Map
        -stateStore: PiStateStore
        +initialize(options)
        +createSession(cwd)
        +prompt(sessionId, turnId, text)
        ...
    }

    IBackend <|.. PiBackend
```

To add a new backend, implement `IBackend` and register it in the CLI entry point. The core adapter handles all protocol translation, thread management, and streaming — the backend only needs to manage sessions and emit events.

## Project Structure

```
codapter/
├── packages/
│   ├── core/                  # Protocol handling, state machines, transport
│   ├── backend-pi/            # Pi backend implementation
│   ├── collab-extension/      # Pi extension for sub-agent collaboration
│   └── cli/                   # CLI entry point & transports
├── dist/                      # Single-file ESM bundle (codapter.mjs)
├── docs/                      # Architecture, API mapping, integration guide
├── scripts/                   # Build, debug, and launcher scripts
└── test/                      # Smoke / integration tests
```

See [docs/architecture.md](docs/architecture.md) for details on how the packages relate.

## Development

```bash
# Install dependencies
npm install

# Build all packages (TypeScript outputs only)
npm run build

# Build the runnable single-file bundle
npm run build:dist

# Run tests
npm run test

# Lint
npm run lint

# Full check (build + lint + test)
npm run check

# Run smoke tests (requires Pi with API keys)
PI_SMOKE_TEST=1 npm run test:smoke
```

## Debugging

### Codapter Debug Log

Enable debug logging to see backend events and Pi process I/O:

```bash
export CODAPTER_DEBUG_LOG_FILE=/tmp/codapter-debug.jsonl
node dist/codapter.mjs app-server
```

The debug log captures backend events with timestamps, Pi process stdin/stdout traffic, and token usage parsing traces.

### Stdio Tap

To inspect the raw JSON-RPC traffic between Codex Desktop and the CLI process, use the stdio tap script. It sits between the GUI and the real CLI, logging every line in both directions:

```bash
# Tap codapter to see what it sends/receives:
CODEX_CLI_PATH=./scripts/stdio-tap.mjs /Applications/Codex.app/Contents/MacOS/Codex

# Tap the real codex CLI for comparison:
TAP_TARGET=/Applications/Codex.app/Contents/Resources/codex \
  CODEX_CLI_PATH=./scripts/stdio-tap.mjs /Applications/Codex.app/Contents/MacOS/Codex
```

Log output goes to `/tmp/stdio-tap.log` (override with `TAP_LOG`). Each line is prefixed with direction (`GUI→CLI` or `CLI→GUI`) and a timestamp.

| Variable | Description | Default |
|----------|-------------|---------|
| `TAP_TARGET` | Path to the real CLI binary to wrap | `/usr/local/bin/codapter.mjs` |
| `TAP_LOG` | Path to the tap log file | `/tmp/stdio-tap.log` |

### Codex Desktop Debug Flags

The Codex Desktop Electron app supports build flavor overrides that enable DevTools and a debug menu:

```bash
# DevTools + debug menu, Sparkle updates still enabled (recommended):
BUILD_FLAVOR=internal-alpha /Applications/Codex.app/Contents/MacOS/Codex

# DevTools + debug menu + inspect element, Sparkle updates disabled:
BUILD_FLAVOR=dev /Applications/Codex.app/Contents/MacOS/Codex
```

These flags are pure functions of `buildFlavor` and cannot be toggled individually. Sparkle (auto-update on macOS) has one additional override:

```bash
# Disable Sparkle regardless of build flavor:
CODEX_SPARKLE_ENABLED=false /Applications/Codex.app/Contents/MacOS/Codex
```

## Limitations

- **Collab requires adapter support**: collab/sub-agent workflows require starting codapter with `--collab` or `CODAPTER_COLLAB=1`
- **No MCP tools**: MCP server integration is not available through Pi
- **No realtime/voice**: Pi has no voice API
- **No worktree management**: Git worktree RPCs return method-not-found (planned as future adapter-native feature)
- **No PTY mode**: `command/exec` with `tty: true` is rejected
- **Single instance per state directory**: Multi-window concurrent writes to the thread registry are not locked in v0.1
- **Config store class name**: The class is still named `InMemoryConfigStore` but all writes are persisted to `~/.config/codapter/config.toml`; the name is a vestige of the original design

## Roadmap

- Support additional backends, including Codex
- Support additional upstream clients and protocols beyond the current Codex Desktop app-server flow
- Align adapter types with upstream Codex and `pi-mono` definitions instead of maintaining local copies

## License

See [LICENSE](LICENSE) for details.
