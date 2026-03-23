# Integration Guide

This document covers how to run codapter locally, how the main transport options work, and what is currently supported.

## Prerequisites

- Node.js 22 or newer.
- `npm` workspaces enabled.
- The repo checked out with the `packages/*` workspace layout intact.

## Build And Test

- `npm run build` compiles all TypeScript projects.
- `npm run lint` checks formatting and static quality with Biome.
- `npm run test` runs the Vitest suite.
- `npm run check` runs build, lint, and tests in sequence.

## CLI Entry Point

The main command is:

```bash
codapter app-server
```

Without `--listen`, codapter serves the app-server protocol over stdio.

### Listener Flags

- `--listen ws://host:port` starts a WebSocket listener over TCP.
- `--listen unix:///path/to/socket` starts a WebSocket listener over a Unix domain socket.
- Multiple `--listen` flags are supported.
- `CODAPTER_LISTEN` can provide a comma-separated fallback list of listeners.

### Other Flags

- `--collab` enables sub-agent collaboration support (creates an internal UDS listener). Also available via `CODAPTER_COLLAB=1`.
- `--analytics-default-enabled` is accepted and ignored.
- `--version` prints the package version.
- `--help` prints usage.

## Desktop Integration

To use Codex Desktop with codapter, point `CODEX_CLI_PATH` at the codapter binary.

Typical flow:

1. Build the workspace.
2. Point `CODEX_CLI_PATH` at the built `codapter` executable.
3. Launch Codex Desktop.
4. Let Desktop connect to codapter as its app-server implementation.

The current code supports the GUI-facing handshake, config reads/writes, model listing, thread lifecycle RPCs, turn streaming, and standalone command execution.

## Configuration

codapter reads `codapter.toml` from the current working directory when present.

Supported current override:

- `emulateCodexIdentity = "..."` sets the reported user agent identity.

Environment override:

- `CODAPTER_EMULATE_CODEX_IDENTITY` takes precedence over the TOML value.

## Transport Notes

- Stdio uses NDJSON line framing.
- WebSocket transport serves the same JSON-RPC surface on the root `/` endpoint.
- WebSocket listeners also expose `/healthz` and `/readyz`.
- Unix domain socket listeners create parent directories as needed and remove stale sockets on startup.
- Incoming WebSocket connections with an `Origin` header are rejected.

## Backend Notes

The current backend implementation is Pi-backed.

- Session ids are opaque adapter ids.
- Session state is persisted under `~/.local/share/codapter/backend-pi/` by default.
- Pi subprocesses are spawned on demand and shut down with the adapter.
- `turn/start` streams backend events into Codex notifications.
- `command/exec` runs locally in the adapter, not through Pi.

## Current Limitations

- Pi-backed elicitation is supported through `item/tool/requestUserInput`. MCP server elicitation is still unsupported.
- Remote tunnel orchestration is not automated by codapter. Use your own SSH or port-forward setup if you want to connect to a WebSocket listener remotely.
- The current backend implementation is Pi-specific.
