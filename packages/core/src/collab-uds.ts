import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import type { CollabManager } from "./collab-manager.js";
import { type JsonRpcRequest, failure, isJsonRpcRequest, success } from "./jsonrpc.js";

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface CollabUdsListenerOptions {
  readonly collabManager: CollabManager;
  validateParentThread(parentThreadId: string): void;
  readonly socketPath?: string;
}

export class CollabUdsListener {
  private readonly server: net.Server;
  readonly socketPath: string;

  constructor(private readonly options: CollabUdsListenerOptions) {
    this.socketPath =
      options.socketPath ??
      `/tmp/codapter-collab-${randomUUID().replace(/-/g, "").slice(0, 8)}.sock`;
    this.server = net.createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          void this.handleLine(line, socket);
        }
      });
    });
  }

  async start(): Promise<void> {
    await mkdir(dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await rm(this.socketPath, { force: true });

    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => resolve());
    });
    await chmod(this.socketPath, 0o600);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }).catch(() => {});
    await rm(this.socketPath, { force: true }).catch(() => {});
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.write(`${JSON.stringify(failure(null, JSON_RPC_PARSE_ERROR, "Parse error"))}\n`);
      return;
    }

    if (!isJsonRpcRequest(parsed)) {
      socket.write(
        `${JSON.stringify(failure(null, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC request"))}\n`
      );
      return;
    }

    try {
      const result = await this.routeRequest(parsed);
      socket.write(`${JSON.stringify(success(parsed.id, result))}\n`);
    } catch (error) {
      socket.write(
        `${JSON.stringify(
          failure(
            parsed.id,
            JSON_RPC_INTERNAL_ERROR,
            error instanceof Error ? error.message : String(error)
          )
        )}\n`
      );
    }
  }

  private async routeRequest(request: JsonRpcRequest): Promise<unknown> {
    if (!isRecord(request.params)) {
      throw new Error("Missing collab request params");
    }

    const parentThreadId = this.requireString(request.params.parentThreadId, "parentThreadId");
    this.options.validateParentThread(parentThreadId);

    switch (request.method) {
      case "collab/spawn":
        return await this.options.collabManager.spawn({
          parentThreadId,
          message: this.requireString(request.params.message, "message"),
          ...(typeof request.params.agent_type === "string"
            ? { agentType: request.params.agent_type }
            : {}),
          ...(typeof request.params.model === "string" ? { model: request.params.model } : {}),
          ...(typeof request.params.reasoning_effort === "string"
            ? { reasoningEffort: request.params.reasoning_effort }
            : {}),
          ...(typeof request.params.fork_context === "boolean"
            ? { forkContext: request.params.fork_context }
            : {}),
        });
      case "collab/sendInput":
        return await this.options.collabManager.sendInput({
          parentThreadId,
          id: this.requireString(request.params.id, "id"),
          message: this.requireString(request.params.message, "message"),
          ...(typeof request.params.interrupt === "boolean"
            ? { interrupt: request.params.interrupt }
            : {}),
        });
      case "collab/wait":
        return await this.options.collabManager.wait({
          parentThreadId,
          ids: this.requireStringArray(request.params.ids, "ids"),
          ...(typeof request.params.timeout_ms === "number"
            ? { timeout_ms: request.params.timeout_ms }
            : {}),
        });
      case "collab/close":
        return await this.options.collabManager.close({
          parentThreadId,
          id: this.requireString(request.params.id, "id"),
        });
      case "collab/resume":
        return await this.options.collabManager.resume({
          parentThreadId,
          id: this.requireString(request.params.id, "id"),
        });
      default:
        throw Object.assign(new Error(`Method not found: ${request.method}`), {
          code: JSON_RPC_METHOD_NOT_FOUND,
        });
    }
  }

  private requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw Object.assign(new Error(`Invalid collab request field: ${field}`), {
        code: JSON_RPC_INVALID_PARAMS,
      });
    }
    return value;
  }

  private requireStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw Object.assign(new Error(`Invalid collab request field: ${field}`), {
        code: JSON_RPC_INVALID_PARAMS,
      });
    }
    return [...value];
  }
}
