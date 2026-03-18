import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppServerConnection } from "../../packages/core/src/app-server.js";
import type { BackendEvent, IBackend } from "../../packages/core/src/backend.js";
import { ThreadRegistry } from "../../packages/core/src/thread-registry.js";

const describeIfSmoke = process.env.PI_SMOKE_TEST === "1" ? describe : describe.skip;

class SmokeBackend implements IBackend {
  private readonly listeners = new Map<string, Set<(event: BackendEvent) => void>>();
  private readonly activeTurns = new Map<string, string>();
  private sessionCounter = 0;

  async initialize() {}
  async dispose() {}

  isAlive() {
    return true;
  }

  async createSession() {
    this.sessionCounter += 1;
    return `smoke_session_${this.sessionCounter}`;
  }

  async resumeSession(sessionId: string) {
    return sessionId;
  }

  async forkSession(sessionId: string) {
    this.sessionCounter += 1;
    return `${sessionId}_fork_${this.sessionCounter}`;
  }

  async disposeSession() {}
  async readSessionHistory() {
    return [];
  }
  async setSessionName() {}
  async setModel() {}

  async prompt(sessionId: string, turnId: string, _text: string) {
    this.activeTurns.set(sessionId, turnId);
    queueMicrotask(() => {
      this.emit(sessionId, {
        type: "thinking_delta",
        sessionId,
        turnId,
        delta: "thinking",
      });
      this.emit(sessionId, {
        type: "text_delta",
        sessionId,
        turnId,
        delta: "hello from smoke",
      });
      this.emit(sessionId, {
        type: "elicitation_request",
        sessionId,
        turnId,
        requestId: "smoke-elicit-1",
        payload: {
          type: "extension_ui_request",
          id: "smoke-elicit-1",
          method: "confirm",
          title: "Confirm",
          message: "Proceed?",
        },
      });
    });
  }

  async abort(sessionId: string) {
    const turnId = this.activeTurns.get(sessionId) ?? "unknown";
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId,
    });
  }

  async listModels() {
    return [
      {
        id: "pi/mock-default",
        model: "mock-default",
        displayName: "Mock Default",
        description: "Smoke model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: ["medium"],
        defaultReasoningEffort: "medium",
        supportsPersonality: true,
      },
    ];
  }

  async getCapabilities() {
    return {
      requiresAuth: false,
      supportsImages: false,
      supportsThinking: true,
      supportsParallelTools: false,
      supportedToolTypes: [],
    };
  }

  async respondToElicitation(sessionId: string, _requestId: string, _response: unknown) {
    const turnId = this.activeTurns.get(sessionId) ?? "unknown";
    this.emit(sessionId, {
      type: "token_usage",
      sessionId,
      turnId,
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
    });
    this.emit(sessionId, {
      type: "message_end",
      sessionId,
      turnId,
    });
  }

  onEvent(sessionId: string, listener: (event: BackendEvent) => void) {
    const listeners = this.listeners.get(sessionId) ?? new Set<(event: BackendEvent) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  }

  private emit(sessionId: string, event: BackendEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }
}

describeIfSmoke("codapter smoke", () => {
  it("completes a prompted turn with elicitation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-smoke-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const outgoing: Array<{ id?: string | number; method: string; params?: unknown }> = [];
    const connection = new AppServerConnection({
      backend: new SmokeBackend(),
      threadRegistry,
      onMessage(message) {
        if ("method" in message) {
          outgoing.push(message);
        }
      },
    });

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-smoke", title: null, version: "0.1.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const threadStart = (await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "pi",
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: threadStart.result.thread.id,
          input: [{ type: "text", text: "hello", text_elements: [] }],
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      const request = outgoing.find((message) => message.method === "item/tool/requestUserInput") as
        | { id: string | number; params: { questions: Array<{ id: string }> } }
        | undefined;
      expect(request).toBeDefined();

      await connection.handleMessage({
        id: request?.id ?? "missing",
        result: {
          answers: {
            confirmed: {
              answers: ["Yes"],
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(outgoing.some((message) => message.method === "turn/started")).toBe(true);
      expect(outgoing.some((message) => message.method === "serverRequest/resolved")).toBe(true);
      expect(outgoing.some((message) => message.method === "turn/completed")).toBe(true);
      expect(outgoing.some((message) => message.method === "thread/tokenUsage/updated")).toBe(true);
    } finally {
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes adapter-native commands", async () => {
    const connection = new AppServerConnection();

    try {
      await connection.handleMessage({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "codapter-smoke", title: null, version: "0.1.0" },
          capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
        },
      });

      const response = await connection.handleMessage({
        id: 2,
        method: "command/exec",
        params: {
          command: ["bash", "-lc", "printf smoke"],
        },
      });

      expect(response).toEqual({
        id: 2,
        result: {
          exitCode: 0,
          stdout: "smoke",
          stderr: "",
        },
      });
    } finally {
      await connection.dispose();
    }
  });
});
