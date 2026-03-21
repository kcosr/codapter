import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import collabExtension, { CollabClient } from "../src/index.js";

const originalCollabUds = process.env.CODAPTER_COLLAB_UDS;
const originalParentThread = process.env.CODAPTER_COLLAB_PARENT_THREAD;

function restoreEnv(
  name: "CODAPTER_COLLAB_UDS" | "CODAPTER_COLLAB_PARENT_THREAD",
  value: string | undefined
) {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
    return;
  }

  process.env[name] = value;
}

async function createSocketServer(
  handler: (request: Record<string, unknown>, socket: net.Socket) => void | Promise<void>
) {
  const dir = await mkdtemp(join(tmpdir(), "collab-extension-"));
  const socketPath = join(dir, "collab.sock");
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        await handler(JSON.parse(line) as Record<string, unknown>, socket);
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  restoreEnv("CODAPTER_COLLAB_UDS", originalCollabUds);
  restoreEnv("CODAPTER_COLLAB_PARENT_THREAD", originalParentThread);
});

describe("CollabClient", () => {
  it("sends JSON-RPC over the UDS and parses the response", async () => {
    const server = await createSocketServer((request, socket) => {
      expect(request.method).toBe("collab/spawn");
      socket.write(`${JSON.stringify({ id: request.id, result: { ok: true } })}\n`);
    });

    try {
      const client = new CollabClient(server.socketPath);
      await expect(client.call("collab/spawn", { parentThreadId: "thread-1" })).resolves.toEqual({
        ok: true,
      });
    } finally {
      await server.close();
    }
  });

  it("returns a structured collab_unavailable error on connection failure", async () => {
    const client = new CollabClient("/tmp/does-not-exist-collab.sock");

    await expect(client.call("collab/spawn", {})).rejects.toMatchObject({
      code: "collab_unavailable",
    });
  });

  it("respects AbortSignal", async () => {
    const server = await createSocketServer(() => {
      // Intentionally never respond.
    });

    try {
      const client = new CollabClient(server.socketPath);
      const controller = new AbortController();
      const promise = client.call(
        "collab/wait",
        {},
        { timeoutMs: 1000, signal: controller.signal }
      );
      controller.abort();

      await expect(promise).rejects.toMatchObject({
        code: "aborted",
      });
    } finally {
      await server.close();
    }
  });
});

describe("collabExtension", () => {
  it("no-ops when required env vars are missing", async () => {
    const registerTool = vi.fn();
    Reflect.deleteProperty(process.env, "CODAPTER_COLLAB_UDS");
    Reflect.deleteProperty(process.env, "CODAPTER_COLLAB_PARENT_THREAD");

    await collabExtension({ registerTool });

    expect(registerTool).not.toHaveBeenCalled();
  });

  it("registers the collab tools and wraps execute results", async () => {
    const server = await createSocketServer((request, socket) => {
      socket.write(`${JSON.stringify({ id: request.id, result: { echoed: request.method } })}\n`);
    });
    process.env.CODAPTER_COLLAB_UDS = server.socketPath;
    process.env.CODAPTER_COLLAB_PARENT_THREAD = "thread-1";

    const tools: Array<Record<string, unknown>> = [];

    try {
      await collabExtension({
        registerTool(tool) {
          tools.push(tool);
        },
        async listModels() {
          return [
            {
              model: "gpt-5.4-mini",
              supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            },
          ];
        },
      });

      expect(tools).toHaveLength(5);
      const spawnTool = tools.find((tool) => tool.name === "spawn_agent");
      expect(spawnTool).toBeDefined();
      const execute = spawnTool?.execute as
        | ((toolCallId: string, params: Record<string, unknown>) => Promise<unknown>)
        | undefined;
      await expect(execute?.("call-1", { message: "hi" })).resolves.toMatchObject({
        details: { echoed: "collab/spawn" },
      });
    } finally {
      await server.close();
    }
  });
});
