import { stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  createUnixSocketPath,
  getSocketMode,
  getTcpListenerPort,
  parseListenTargets,
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
    const websocket = new WebSocket(`${address}/rpc`, {
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

describe("parseListenTargets", () => {
  it("collects repeated listen flags", () => {
    expect(
      parseListenTargets(["--listen", "ws://127.0.0.1:8080", "--listen=unix:///tmp/codapter.sock"])
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      analyticsDefaultEnabledSeen: false,
    });
  });

  it("falls back to CODAPTER_LISTEN when no explicit listen flags are present", () => {
    expect(
      parseListenTargets([], { CODAPTER_LISTEN: "ws://127.0.0.1:8080, unix:///tmp/codapter.sock" })
    ).toEqual({
      listenTargets: ["ws://127.0.0.1:8080", "unix:///tmp/codapter.sock"],
      analyticsDefaultEnabledSeen: false,
    });
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
          clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
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
      env: {},
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
});

describe("startAppServerListeners", () => {
  it("serves initialize over TCP WebSocket and health probes over HTTP", async () => {
    const listeners = await startAppServerListeners(["ws://127.0.0.1:0"]);

    try {
      const address = listeners.addresses[0];
      const websocket = await connectWebSocket(address);
      websocket.send(
        JSON.stringify({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "codapter-test", title: null, version: "0.1.0" },
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
      await listeners.close();
    }
  });

  it("rejects websocket upgrades with an Origin header", async () => {
    const listeners = await startAppServerListeners(["ws://127.0.0.1:0"]);

    try {
      const address = listeners.addresses[0];
      await expect(
        connectWebSocket(address, { headers: { Origin: "https://example.com" } })
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await listeners.close();
    }
  });

  it("creates UDS listeners with secure permissions and removes them on shutdown", async () => {
    const socketPath = await createUnixSocketPath();
    const listeners = await startAppServerListeners([`unix://${socketPath}`]);

    const stats = await stat(socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(getSocketMode(stats.mode)).toBe(0o600);

    await listeners.close();
    await expect(stat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects replacing a non-socket UDS path", async () => {
    const socketPath = await createUnixSocketPath();
    await writeFile(socketPath, "not-a-socket", "utf8");

    await expect(startAppServerListeners([`unix://${socketPath}`])).rejects.toThrow(
      `Refusing to replace non-socket path: ${socketPath}`
    );
  });
});
