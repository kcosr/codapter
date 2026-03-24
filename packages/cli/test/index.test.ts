import { stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { createPiBackend } from "@codapter/backend-pi";
import { AppServerConnection, BackendRouter } from "@codapter/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createUnixSocketPath,
  getSocketMode,
  getTcpListenerPort,
  parseListenTargets,
  resolveCollabExtensionPath,
  runCli,
  startAppServerListeners,
} from "../src/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function httpGet(url: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function connectWebSocket(
  address: string,
  init?: { headers?: Record<string, string> }
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const websocket = new WebSocket(address, {
      headers: init?.headers,
    });

    websocket.once("open", () => resolve(websocket));
    websocket.once("error", reject);
  });
}

function waitForWebSocketMessage(websocket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    websocket.once("message", (payload) => {
      try {
        resolve(JSON.parse(payload.toString("utf8")) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    websocket.once("error", reject);
  });
}

async function startListeners(listenTargets: readonly string[]) {
  const backend = createPiBackend();
  await backend.initialize();
  const listeners = await startAppServerListeners(listenTargets, {
    backendRouter: new BackendRouter([backend]),
  });
  return {
    listeners,
    async close() {
      await listeners.close();
      await backend.dispose();
    },
  };
}

function createNdjsonCollector(stream: PassThrough) {
  const messages = new Map<string | number, unknown>();
  const waiters = new Map<string | number, (message: unknown) => void>();
  let buffer = "";

  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const message = JSON.parse(line) as { id?: string | number };
        if (message.id !== undefined) {
          messages.set(message.id, message);
          const waiter = waiters.get(message.id);
          if (waiter) {
            waiters.delete(message.id);
            waiter(message);
          }
        }
      }
      newlineIndex = buffer.indexOf("\n");
    }
  });

  return {
    waitFor(id: string | number): Promise<unknown> {
      const existing = messages.get(id);
      if (existing !== undefined) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        waiters.set(id, resolve);
      });
    },
  };
}

describe("parseListenTargets", () => {
  it("collects repeated listen flags", () => {
    expect(
      parseListenTargets(["--listen", "ws://127.0.0.1:8080", "--listen=unix:///tmp/codapter.sock"])
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("accepts stdio as a listen target", () => {
    expect(parseListenTargets(["--listen", "stdio"])).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("accepts stdio alongside other listen targets", () => {
    expect(parseListenTargets(["--listen", "stdio", "--listen", "ws://127.0.0.1:8080"])).toEqual({
      listenTargets: ["stdio", "ws://127.0.0.1:8080"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("falls back to CODAPTER_LISTEN when no explicit listen flags are present", () => {
    expect(
      parseListenTargets([], { CODAPTER_LISTEN: "ws://127.0.0.1:8080, unix:///tmp/codapter.sock" })
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("parses --collab alongside listen targets", () => {
    expect(parseListenTargets(["--collab", "--listen", "stdio"])).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: true,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("enables collab via CODAPTER_COLLAB", () => {
    expect(parseListenTargets(["--listen", "stdio"], { CODAPTER_COLLAB: "1" })).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: true,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("treats falsy CODAPTER_COLLAB values as disabled", () => {
    expect(parseListenTargets(["--listen", "stdio"], { CODAPTER_COLLAB: "0" })).toEqual({
      listenTargets: ["stdio"],
      collabEnabled: false,
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("rejects non-root websocket listen paths", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["ws://127.0.0.1:0/rpc"], {
          backendRouter: new BackendRouter([backend]),
        })
      ).rejects.toThrow("Unsupported WebSocket path in listen target: ws://127.0.0.1:0/rpc");
    } finally {
      await backend.dispose();
    }
  });
});

describe("resolveCollabExtensionPath", () => {
  it("uses CODAPTER_COLLAB_EXTENSION_PATH when provided", () => {
    expect(
      resolveCollabExtensionPath({
        CODAPTER_COLLAB_EXTENSION_PATH: "/tmp/collab-extension/dist/index.js",
      })
    ).toBe("/tmp/collab-extension/dist/index.js");
  });

  it("falls back to the repo-built extension path", () => {
    expect(resolveCollabExtensionPath({})).toContain("/packages/collab-extension/dist/index.js");
  });
});

describe("runCli", () => {
  it("runs the stdio app-server path by default", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdin = Readable.from([
      JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      }),
      "\n",
    ]);

    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const result = await runCli(["app-server"], {
      stdin,
      stdout,
      stderr,
      env: {
        CODAPTER_CODEX_DISABLE: "1",
      },
    });

    expect(result).toEqual({ exitCode: 0 });
    expect(stderrChunks.join("")).toBe("");
    expect(JSON.parse(stdoutChunks.join(""))).toMatchObject({
      id: 1,
      result: {
        userAgent: expect.any(String),
        platformFamily: expect.any(String),
        platformOs: expect.any(String),
      },
    });
  });

  it("fails fast on invalid CODAPTER_CODEX_TRANSPORT", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const result = await runCli(["app-server"], {
      stdin: Readable.from([]),
      stdout,
      stderr,
      env: {
        CODAPTER_PI_DISABLE: "1",
        CODAPTER_CODEX_TRANSPORT: "banana",
      },
    });

    expect(result).toEqual({ exitCode: 1 });
    expect(stderrChunks.join("")).toContain("Invalid CODAPTER_CODEX_TRANSPORT: banana");
  });

  it("does not block later stdio requests behind a slow request", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const collector = createNdjsonCollector(stdout);
    let releaseResume: (() => void) | null = null;

    const originalHandleMessage = AppServerConnection.prototype.handleMessage;
    const handleMessageSpy = vi
      .spyOn(AppServerConnection.prototype, "handleMessage")
      .mockImplementation(function (message: unknown) {
        if (
          typeof message === "object" &&
          message !== null &&
          "method" in message &&
          (message as { method?: unknown }).method === "thread/resume"
        ) {
          return new Promise((resolve) => {
            releaseResume = () => {
              resolve({
                id: (message as { id?: string | number }).id ?? null,
                result: { thread: { id: "stalled-thread" } },
              });
            };
          });
        }
        return originalHandleMessage.call(this, message);
      });

    try {
      const resultPromise = runCli(["app-server"], {
        stdin,
        stdout,
        stderr,
        env: {
          CODAPTER_CODEX_DISABLE: "1",
        },
      });

      stdin.write(
        `${JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        })}\n`
      );
      expect(await collector.waitFor(1)).toMatchObject({
        id: 1,
        result: { userAgent: expect.any(String) },
      });

      stdin.write(`${JSON.stringify({ id: 2, method: "thread/resume", params: {} })}\n`);
      stdin.write(
        `${JSON.stringify({
          id: 3,
          method: "account/read",
          params: { refreshToken: false },
        })}\n`
      );

      await expect(collector.waitFor(3)).resolves.toMatchObject({
        id: 3,
        result: {
          account: null,
          requiresOpenaiAuth: false,
        },
      });

      releaseResume?.();
      expect(await collector.waitFor(2)).toMatchObject({
        id: 2,
        result: { thread: { id: "stalled-thread" } },
      });

      stdin.end();
      expect(await resultPromise).toEqual({ exitCode: 0 });
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it("runs stdio via --listen stdio with shutdown signal", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    stdout.setEncoding("utf8");
    stderr.setEncoding("utf8");
    stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    stderr.on("data", (chunk) => stderrChunks.push(chunk));

    const abortController = new AbortController();

    const resultPromise = runCli(["app-server", "--listen", "stdio"], {
      stdin,
      stdout,
      stderr,
      env: {},
      shutdownSignal: abortController.signal,
    });

    // Wait for the "Listening on" message on stderr
    await new Promise<void>((resolve) => {
      const check = () => {
        if (stderrChunks.join("").includes("Listening on")) {
          resolve();
        }
      };
      stderr.on("data", check);
      check();
    });

    expect(stderrChunks.join("")).toContain("stdio");

    // Send an initialize request over stdio
    const responsePromise = new Promise<unknown>((resolve) => {
      stdout.once("data", (chunk: string) => {
        resolve(JSON.parse(chunk));
      });
    });

    stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      })}\n`
    );

    expect(await responsePromise).toMatchObject({
      id: 1,
      result: { userAgent: expect.any(String) },
    });

    // Shut down cleanly
    abortController.abort();
    const result = await resultPromise;
    expect(result).toEqual({ exitCode: 0 });
  });
});

describe("startAppServerListeners", () => {
  it("serves initialize over TCP WebSocket and health probes over HTTP", async () => {
    const runtime = await startListeners(["ws://127.0.0.1:0"]);

    try {
      const address = runtime.listeners.addresses[0];
      const websocket = await connectWebSocket(address);
      websocket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
          },
        })
      );

      expect(await waitForWebSocketMessage(websocket)).toMatchObject({
        id: 1,
        result: {
          userAgent: expect.any(String),
        },
      });

      websocket.close();

      const port = getTcpListenerPort(address);
      await expect(httpGet(`http://127.0.0.1:${port}/healthz`)).resolves.toEqual({
        statusCode: 200,
        body: "ok",
      });
      await expect(httpGet(`http://127.0.0.1:${port}/readyz`)).resolves.toEqual({
        statusCode: 200,
        body: "ok",
      });
    } finally {
      await runtime.close();
    }
  });

  it("rejects websocket upgrades with an Origin header", async () => {
    const runtime = await startListeners(["ws://127.0.0.1:0"]);

    try {
      const address = runtime.listeners.addresses[0];
      await expect(
        connectWebSocket(address, { headers: { Origin: "https://example.com" } })
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await runtime.close();
    }
  });

  it("creates UDS listeners with secure permissions and removes them on shutdown", async () => {
    const socketPath = await createUnixSocketPath();
    const runtime = await startListeners([`unix://${socketPath}`]);

    const stats = await stat(socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(getSocketMode(stats.mode)).toBe(0o600);

    await runtime.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves initialize over stdio alongside TCP WebSocket", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.setEncoding("utf8");

    const backend = createPiBackend();
    await backend.initialize();

    try {
      const listeners = await startAppServerListeners(["stdio", "ws://127.0.0.1:0"], {
        backend,
        stdin,
        stdout,
      });

      try {
        // Test stdio listener
        const stdioResponse = new Promise<unknown>((resolve) => {
          stdout.once("data", (chunk: string) => {
            resolve(JSON.parse(chunk));
          });
        });

        stdin.write(
          `${JSON.stringify({
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "codapter-test", title: null, version: "0.0.1" },
              capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
            },
          })}\n`
        );

        expect(await stdioResponse).toMatchObject({
          id: 1,
          result: { userAgent: expect.any(String) },
        });

        // Test TCP WebSocket listener concurrently
        const wsAddress = listeners.addresses.find((a) => a.startsWith("ws://"));
        expect(wsAddress).toBeDefined();
        // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
        const websocket = await connectWebSocket(wsAddress!);
        websocket.send(
          JSON.stringify({
            id: 2,
            method: "initialize",
            params: {
              clientInfo: { name: "codapter-test-ws", title: null, version: "0.0.1" },
              capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
            },
          })
        );

        expect(await waitForWebSocketMessage(websocket)).toMatchObject({
          id: 2,
          result: { userAgent: expect.any(String) },
        });

        websocket.close();
      } finally {
        stdin.end();
        await listeners.close();
      }
    } finally {
      await backend.dispose();
    }
  });

  it("rejects duplicate stdio listeners", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["stdio", "stdio"], {
          backend,
          stdin: new PassThrough(),
          stdout: new PassThrough(),
        })
      ).rejects.toThrow("Only one stdio listener is allowed");
    } finally {
      await backend.dispose();
    }
  });

  it("rejects stdio listener without stdin/stdout streams", async () => {
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners(["stdio"], { backendRouter: new BackendRouter([backend]) })
      ).rejects.toThrow("stdio listener requires stdin and stdout streams");
    } finally {
      await backend.dispose();
    }
  });

  it("rejects replacing a non-socket UDS path", async () => {
    const socketPath = await createUnixSocketPath();
    await writeFile(socketPath, "not-a-socket", "utf8");
    const backend = createPiBackend();
    await backend.initialize();

    try {
      await expect(
        startAppServerListeners([`unix://${socketPath}`], {
          backendRouter: new BackendRouter([backend]),
        })
      ).rejects.toThrow(`Refusing to replace non-socket path: ${socketPath}`);
    } finally {
      await backend.dispose();
    }
  });
});
