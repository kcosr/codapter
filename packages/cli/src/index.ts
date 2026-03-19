import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createPiBackend } from "@codapter/backend-pi";
import {
  AppServerConnection,
  type IBackend,
  failure,
  parseNdjsonLine,
  serializeNdjsonLine,
} from "@codapter/core";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

const VERSION = "0.0.1";
const ANALYTICS_FLAG = "--analytics-default-enabled";

export interface CliEnvironment {
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly env?: NodeJS.ProcessEnv;
  readonly shutdownSignal?: AbortSignal;
}

export interface CliRunResult {
  readonly exitCode: number;
}

export interface AppServerArgs {
  readonly listenTargets: readonly string[];
  readonly analyticsDefaultEnabledSeen: boolean;
}

export interface ListenerHandle {
  readonly address: string;
  close(): Promise<void>;
}

export interface ListenerSet {
  readonly listeners: readonly ListenerHandle[];
  readonly addresses: readonly string[];
  close(): Promise<void>;
}

export interface ListenerOptions {
  readonly backend: IBackend;
}

type ParsedListenTarget =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "unix"; socketPath: string };

const defaultEnvironment: Required<Pick<CliEnvironment, "stdin" | "stdout" | "stderr" | "env">> = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
};

export function parseListenTargets(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): AppServerArgs {
  const listenTargets: string[] = [];
  let analyticsDefaultEnabledSeen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === ANALYTICS_FLAG) {
      analyticsDefaultEnabledSeen = true;
      continue;
    }

    if (arg.startsWith("--listen=")) {
      const value = arg.slice("--listen=".length).trim();
      if (!value) {
        throw new Error("Missing value for --listen");
      }
      listenTargets.push(value);
      continue;
    }

    if (arg === "--listen") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("Missing value for --listen");
      }
      listenTargets.push(value.trim());
      index += 1;
      continue;
    }

    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (listenTargets.length === 0) {
    const fallback = env.CODAPTER_LISTEN ?? "";
    for (const entry of fallback.split(",")) {
      const value = entry.trim();
      if (value) {
        listenTargets.push(value);
      }
    }
  }

  return {
    listenTargets,
    analyticsDefaultEnabledSeen,
  };
}

export async function runCli(
  args: readonly string[],
  environment: CliEnvironment = {}
): Promise<CliRunResult> {
  const stdin = environment.stdin ?? defaultEnvironment.stdin;
  const stdout = environment.stdout ?? defaultEnvironment.stdout;
  const stderr = environment.stderr ?? defaultEnvironment.stderr;
  const env = environment.env ?? defaultEnvironment.env;

  if (args.includes("--version")) {
    stdout.write(`${VERSION}\n`);
    return { exitCode: 0 };
  }

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    writeHelp(stdout);
    return { exitCode: 0 };
  }

  const [command, ...commandArgs] = args;
  if (command !== "app-server") {
    stderr.write(`Unknown command: ${command}\n`);
    return { exitCode: 1 };
  }

  try {
    const parsed = parseListenTargets(commandArgs, env);
    const piCommand = env.CODAPTER_PI_COMMAND;
    const piArgsRaw = env.CODAPTER_PI_ARGS;
    let piArgs: string[] | undefined;
    if (piArgsRaw) {
      const parsed = JSON.parse(piArgsRaw);
      if (!Array.isArray(parsed)) {
        throw new Error("CODAPTER_PI_ARGS must be a JSON array of strings");
      }
      piArgs = parsed;
    }
    const piIdleTimeoutRaw = env.CODAPTER_PI_IDLE_TIMEOUT_MS;
    const piIdleTimeoutMs =
      piIdleTimeoutRaw && Number.isFinite(Number(piIdleTimeoutRaw))
        ? Number(piIdleTimeoutRaw)
        : undefined;
    const backend = createPiBackend({
      ...(piCommand ? { command: piCommand } : {}),
      ...(piArgs ? { args: piArgs } : {}),
      ...(piIdleTimeoutMs !== undefined ? { idleTimeoutMs: piIdleTimeoutMs } : {}),
    });
    await backend.initialize();

    const signalCodes: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };
    const cleanup = async (signal: string) => {
      await backend.dispose();
      process.exit(signalCodes[signal] ?? 1);
    };
    process.on("SIGINT", () => cleanup("SIGINT"));
    process.on("SIGTERM", () => cleanup("SIGTERM"));

    try {
      if (parsed.listenTargets.length === 0) {
        await runStdioAppServer(stdin, stdout, backend);
        return { exitCode: 0 };
      }

      const listeners = await startAppServerListeners(parsed.listenTargets, { backend });
      stderr.write(`Listening on ${listeners.addresses.join(", ")}\n`);

      try {
        await waitForShutdown(environment.shutdownSignal);
      } finally {
        await listeners.close();
      }

      return { exitCode: 0 };
    } finally {
      await backend.dispose();
    }
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "Invalid CLI arguments"}\n`);
    return { exitCode: 1 };
  }
}

export async function startAppServerListeners(
  listenTargets: readonly string[],
  options: ListenerOptions
): Promise<ListenerSet> {
  const listeners: ListenerHandle[] = [];

  try {
    for (const target of listenTargets) {
      listeners.push(await startAppServerListener(target, options));
    }
  } catch (error) {
    await Promise.allSettled(listeners.map(async (listener) => listener.close()));
    throw error;
  }

  return {
    listeners,
    addresses: listeners.map((listener) => listener.address),
    async close() {
      await Promise.all(listeners.map(async (listener) => listener.close()));
    },
  };
}

async function runStdioAppServer(
  stdin: NodeJS.ReadableStream,
  stdout: NodeJS.WritableStream,
  backend: IBackend
): Promise<void> {
  const connection = new AppServerConnection({
    backend,
    onMessage(message) {
      stdout.write(serializeNdjsonLine(message));
    },
  });
  const readline = createInterface({
    input: stdin,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  try {
    for await (const line of readline) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }

      try {
        const message = parseNdjsonLine(trimmed);
        const response = await connection.handleMessage(message);
        if (response) {
          stdout.write(serializeNdjsonLine(response));
        }
      } catch {
        stdout.write(serializeNdjsonLine(failure(null, -32700, "Parse error")));
      }
    }
  } finally {
    readline.close();
    await connection.dispose();
  }
}

async function startAppServerListener(
  rawTarget: string,
  options: ListenerOptions
): Promise<ListenerHandle> {
  const target = parseListenTarget(rawTarget);

  if (target.kind === "unix") {
    return startUnixListener(target.socketPath, options);
  }

  return startTcpListener(target.host, target.port, options);
}

function parseListenTarget(rawTarget: string): ParsedListenTarget {
  if (rawTarget.startsWith("unix://")) {
    const socketPath = rawTarget.slice("unix://".length);
    if (!socketPath.startsWith("/")) {
      throw new Error(`Invalid unix listen target: ${rawTarget}`);
    }
    return { kind: "unix", socketPath };
  }

  const url = new URL(rawTarget);
  if (url.protocol !== "ws:") {
    throw new Error(`Unsupported listen target: ${rawTarget}`);
  }

  if (url.pathname !== "/") {
    throw new Error(`Unsupported WebSocket path in listen target: ${rawTarget}`);
  }

  if (url.port.length === 0) {
    throw new Error(`Missing WebSocket port in listen target: ${rawTarget}`);
  }

  const host = url.hostname || "127.0.0.1";
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid WebSocket port in listen target: ${rawTarget}`);
  }

  return { kind: "tcp", host, port };
}

async function startTcpListener(
  host: string,
  port: number,
  options: ListenerOptions
): Promise<ListenerHandle> {
  const { server, websocketServer } = createRpcServer(options);
  server.listen(port, host);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a TCP listener address");
  }

  const handle = createServerHandle(server, websocketServer, `ws://${host}:${address.port}`);
  return handle;
}

async function startUnixListener(
  socketPath: string,
  options: ListenerOptions
): Promise<ListenerHandle> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeExistingSocket(socketPath);

  const { server, websocketServer } = createRpcServer(options);
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);

  const handle = createServerHandle(server, websocketServer, `unix://${socketPath}`, socketPath);
  return handle;
}

function createRpcServer(options: ListenerOptions): {
  server: ReturnType<typeof createServer>;
  websocketServer: WebSocketServer;
} {
  const websocketServer = new WebSocketServer({ noServer: true });

  websocketServer.on("connection", (socket: WebSocket) => {
    const connection = new AppServerConnection({
      backend: options.backend,
      onMessage(message) {
        socket.send(JSON.stringify(message));
      },
    });
    let queue = Promise.resolve();

    socket.on("message", (payload: RawData) => {
      const text = typeof payload === "string" ? payload : payload.toString("utf8");

      queue = queue.then(async () => {
        try {
          const response = await connection.handleMessage(JSON.parse(text) as unknown);
          if (response) {
            socket.send(JSON.stringify(response));
          }
        } catch {
          socket.send(JSON.stringify(failure(null, -32700, "Parse error")));
        }
      });
    });

    socket.on("close", () => {
      void connection.dispose();
    });
  });

  const server = createServer((request, response) => {
    handleHttpRequest(request, response);
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.headers.origin) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    if (request.url !== "/") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    websocketServer.handleUpgrade(request, socket, head, (websocket: WebSocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  return { server, websocketServer };
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  if (request.url === "/healthz" || request.url === "/readyz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
}

function createServerHandle(
  server: ReturnType<typeof createServer>,
  websocketServer: WebSocketServer,
  address: string,
  socketPath?: string
): ListenerHandle {
  return {
    address,
    async close() {
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          websocketServer.close((error?: Error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
        new Promise<void>((resolve, reject) => {
          server.close((error?: Error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
      ]);

      if (socketPath) {
        await rm(socketPath, { force: true });
      }
    },
  };
}

async function removeExistingSocket(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error(`Refusing to replace non-socket path: ${socketPath}`);
    }
    await rm(socketPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function waitForShutdown(signal?: AbortSignal): Promise<void> {
  if (signal) {
    if (signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return;
  }

  await new Promise<void>((resolve) => {
    const handleSignal = () => {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      resolve();
    };

    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  });
}

function writeHelp(stdout: NodeJS.WritableStream): void {
  stdout.write(`codapter ${VERSION}\n`);
  stdout.write("Usage: codapter [--version|--help] | codapter app-server [--listen <url>]...\n");
  stdout.write("Options:\n");
  stdout.write("  --listen <url>                 Add a stdio, TCP WebSocket, or UDS listener\n");
  stdout.write("  --analytics-default-enabled    Accepted and ignored\n");
}

export async function createUnixSocketPath(prefix = "codapter"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-${randomUUID()}-`));
  return join(directory, "adapter.sock");
}

export function getTcpListenerPort(address: string): number {
  const parsed = new URL(address);
  return Number(parsed.port);
}

export function getSocketMode(mode: number): number {
  return mode & 0o777;
}
