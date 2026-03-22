import { describe, expect, it, vi } from "vitest";
import type { BackendEvent, IBackend } from "../src/backend.js";
import { CollabManager } from "../src/collab-manager.js";
import type { CollabManagerNotificationSink } from "../src/collab-manager.js";
import type { CollabManagerCreateChildThreadInput } from "../src/collab-manager.js";

class TestBackend implements IBackend {
  private readonly listeners = new Map<string, Set<(event: BackendEvent) => void>>();
  private sessionCounter = 0;
  public prompts: Array<{ sessionId: string; turnId: string; text: string }> = [];
  public abortedSessionIds: string[] = [];
  public disposedSessionIds: string[] = [];

  async initialize() {}
  async dispose() {}
  isAlive() {
    return true;
  }
  async createSession() {
    this.sessionCounter += 1;
    return `session_${this.sessionCounter}`;
  }
  async resumeSession(sessionId: string) {
    return sessionId;
  }
  async forkSession(sessionId: string) {
    this.sessionCounter += 1;
    return `${sessionId}_fork_${this.sessionCounter}`;
  }
  async disposeSession(sessionId: string) {
    this.disposedSessionIds.push(sessionId);
  }
  async readSessionHistory() {
    return [];
  }
  async setSessionName() {}
  async getSessionPath(sessionId: string) {
    return `/sessions/${sessionId}.jsonl`;
  }
  async prompt(sessionId: string, turnId: string, text: string) {
    this.prompts.push({ sessionId, turnId, text });
  }
  async abort(sessionId: string) {
    this.abortedSessionIds.push(sessionId);
  }
  async listModels() {
    return [];
  }
  async setModel() {}
  async getCapabilities() {
    return {
      requiresAuth: false,
      supportsImages: false,
      supportsThinking: true,
      supportsParallelTools: false,
      supportedToolTypes: [],
    };
  }
  async respondToElicitation() {}
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

  emit(sessionId: string, event: BackendEvent) {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      listener(event);
    }
  }
}

function createManager(options: {
  backend?: TestBackend;
  parentThreadId?: string;
  config?: ConstructorParameters<typeof CollabManager>[0]["config"];
  notifySink?: CollabManagerNotificationSink;
}) {
  const backend = options.backend ?? new TestBackend();
  const parentThreadId = options.parentThreadId ?? "parent-thread";

  const notifications: Array<{ method: string; params: unknown; threadId?: string }> = [];
  const statusChanges: string[] = [];
  const childThreadIds: string[] = [];
  const childThreadInputs: CollabManagerCreateChildThreadInput[] = [];

  const manager = new CollabManager({
    backend,
    notifySink:
      options.notifySink ??
      ({
        async notify(method, params, threadId) {
          notifications.push({ method, params, threadId });
        },
      } satisfies CollabManagerNotificationSink),
    resolveParentTurnId(threadId) {
      return `turn:${threadId}`;
    },
    resolveThreadSessionId(threadId) {
      return `session:${threadId}`;
    },
    async createChildThread(input) {
      childThreadIds.push(input.threadId);
      childThreadInputs.push(input);
    },
    onChildAgentStatusChanged({ agent }) {
      statusChanges.push(agent.status);
    },
    config: options.config,
  });

  return {
    backend,
    manager,
    notifications,
    parentThreadId,
    statusChanges,
    childThreadIds,
    childThreadInputs,
  };
}

async function spawnAgent(manager: CollabManager, parentThreadId: string, message = "do work") {
  return await manager.spawn({
    parentThreadId,
    message,
  });
}

describe("CollabManager", () => {
  it("transitions pendingInit to running to completed", async () => {
    const { backend, manager, parentThreadId, statusChanges } = createManager({
      config: { minTimeoutMs: 1, defaultTimeoutMs: 5, maxTimeoutMs: 10 },
    });

    const spawned = await spawnAgent(manager, parentThreadId);
    const prompt = backend.prompts.at(-1);
    expect(prompt).toBeDefined();
    backend.emit(prompt?.sessionId ?? "", {
      type: "text_delta",
      sessionId: prompt?.sessionId ?? "",
      turnId: prompt?.turnId ?? "",
      delta: "done",
    });
    backend.emit(prompt?.sessionId ?? "", {
      type: "message_end",
      sessionId: prompt?.sessionId ?? "",
      turnId: prompt?.turnId ?? "",
    });

    const waited = await manager.wait({
      parentThreadId,
      ids: [spawned.agent_id],
      timeout_ms: 5,
    });

    expect(waited).toEqual({
      status: {
        [spawned.agent_id]: "completed",
      },
      messages: {
        [spawned.agent_id]: "done",
      },
      timed_out: false,
    });
    expect(statusChanges).toEqual(["running", "completed"]);
  });

  it("transitions pendingInit to running to errored", async () => {
    const { backend, manager, parentThreadId } = createManager({
      config: { minTimeoutMs: 1, defaultTimeoutMs: 5, maxTimeoutMs: 10 },
    });

    const spawned = await spawnAgent(manager, parentThreadId);
    const prompt = backend.prompts.at(-1);
    expect(prompt).toBeDefined();
    backend.emit(prompt?.sessionId ?? "", {
      type: "error",
      sessionId: prompt?.sessionId ?? "",
      turnId: prompt?.turnId ?? "",
      message: "boom",
    });

    await expect(
      manager.wait({
        parentThreadId,
        ids: [spawned.agent_id],
        timeout_ms: 5,
      })
    ).resolves.toEqual({
      status: {
        [spawned.agent_id]: "errored",
      },
      messages: {
        [spawned.agent_id]: "boom",
      },
      timed_out: false,
    });
  });

  it("rejects spawns when maxAgents is reached", async () => {
    const { manager, parentThreadId } = createManager({
      config: { maxAgents: 1 },
    });
    await spawnAgent(manager, parentThreadId);

    await expect(
      manager.spawn({
        parentThreadId,
        message: "second",
      })
    ).rejects.toThrow("Maximum collab agent count reached");
  });

  it("rejects spawns when maxDepth is reached", async () => {
    const { manager, parentThreadId, childThreadIds } = createManager({
      config: { maxDepth: 1 },
    });
    await spawnAgent(manager, parentThreadId);
    const childThreadId = childThreadIds[0];
    expect(childThreadId).toEqual(expect.any(String));

    await expect(
      manager.spawn({
        parentThreadId: childThreadId ?? "",
        message: "delegate again",
      })
    ).rejects.toThrow("Maximum collab depth reached");
  });

  it("returns immediately from wait when an agent is already final", async () => {
    const { backend, manager, parentThreadId } = createManager({
      config: { minTimeoutMs: 1, defaultTimeoutMs: 5, maxTimeoutMs: 10 },
    });
    const spawned = await spawnAgent(manager, parentThreadId);
    const prompt = backend.prompts.at(-1);
    backend.emit(prompt?.sessionId ?? "", {
      type: "message_end",
      sessionId: prompt?.sessionId ?? "",
      turnId: prompt?.turnId ?? "",
    });

    await expect(
      manager.wait({
        parentThreadId,
        ids: [spawned.agent_id],
        timeout_ms: 5,
      })
    ).resolves.toEqual({
      status: {
        [spawned.agent_id]: "completed",
      },
      messages: {
        [spawned.agent_id]: null,
      },
      timed_out: false,
    });
  });

  it("times out wait_agent when no agent reaches a final state", async () => {
    vi.useFakeTimers();
    try {
      const { manager, parentThreadId } = createManager({
        config: { minTimeoutMs: 5, defaultTimeoutMs: 5, maxTimeoutMs: 5 },
      });
      const spawned = await spawnAgent(manager, parentThreadId);
      const waitPromise = manager.wait({
        parentThreadId,
        ids: [spawned.agent_id],
        timeout_ms: 5,
      });

      await vi.advanceTimersByTimeAsync(5);

      await expect(waitPromise).resolves.toEqual({
        status: {},
        messages: {},
        timed_out: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses wait-any semantics for multiple ids", async () => {
    const { backend, manager, parentThreadId } = createManager({
      config: { minTimeoutMs: 1, defaultTimeoutMs: 50, maxTimeoutMs: 50 },
    });
    const first = await spawnAgent(manager, parentThreadId, "first");
    const second = await spawnAgent(manager, parentThreadId, "second");
    const firstPrompt = backend.prompts[0];

    const waitPromise = manager.wait({
      parentThreadId,
      ids: [first.agent_id, second.agent_id],
      timeout_ms: 50,
    });

    backend.emit(firstPrompt?.sessionId ?? "", {
      type: "message_end",
      sessionId: firstPrompt?.sessionId ?? "",
      turnId: firstPrompt?.turnId ?? "",
    });

    await expect(waitPromise).resolves.toEqual({
      status: {
        [first.agent_id]: "completed",
      },
      messages: {
        [first.agent_id]: null,
      },
      timed_out: false,
    });
  });

  it("captures the child final message from message_end text without deltas", async () => {
    const { backend, manager, parentThreadId, childThreadIds } = createManager({
      config: { minTimeoutMs: 1, defaultTimeoutMs: 5, maxTimeoutMs: 10 },
    });

    const spawned = await spawnAgent(manager, parentThreadId);
    const prompt = backend.prompts.at(-1);
    expect(prompt).toBeDefined();

    backend.emit(prompt?.sessionId ?? "", {
      type: "message_end",
      sessionId: prompt?.sessionId ?? "",
      turnId: prompt?.turnId ?? "",
      text: "child output",
    });

    await expect(
      manager.wait({
        parentThreadId,
        ids: [spawned.agent_id],
        timeout_ms: 5,
      })
    ).resolves.toEqual({
      status: {
        [spawned.agent_id]: "completed",
      },
      messages: {
        [spawned.agent_id]: "child output",
      },
      timed_out: false,
    });

    const child = manager.getAgentByThreadId(childThreadIds[0] ?? "");
    expect(child?.completionMessage).toBe("child output");
  });

  it("transitions to shutdown on close", async () => {
    const { backend, manager, parentThreadId, statusChanges } = createManager({});
    const spawned = await spawnAgent(manager, parentThreadId);

    await expect(
      manager.close({
        parentThreadId,
        id: spawned.agent_id,
      })
    ).resolves.toEqual({
      previous_status: "running",
    });

    expect(backend.abortedSessionIds).toHaveLength(1);
    expect(backend.disposedSessionIds).toHaveLength(1);
    expect(statusChanges.at(-1)).toBe("shutdown");
  });

  it("resumes a shutdown agent back to running", async () => {
    const { manager, parentThreadId, statusChanges } = createManager({});
    const spawned = await spawnAgent(manager, parentThreadId);
    await manager.close({ parentThreadId, id: spawned.agent_id });

    await expect(
      manager.resume({
        parentThreadId,
        id: spawned.agent_id,
      })
    ).resolves.toEqual({
      status: "running",
    });

    expect(statusChanges.slice(-2)).toEqual(["shutdown", "running"]);
  });

  it("rejects resume for running agents", async () => {
    const { manager, parentThreadId } = createManager({});
    const spawned = await spawnAgent(manager, parentThreadId);

    await expect(
      manager.resume({
        parentThreadId,
        id: spawned.agent_id,
      })
    ).rejects.toThrow("already active");
  });

  it("cascades shutdown by parent", async () => {
    const { backend, manager, parentThreadId } = createManager({});
    await spawnAgent(manager, parentThreadId, "first");
    await spawnAgent(manager, parentThreadId, "second");

    await manager.shutdownByParent(parentThreadId);

    expect(backend.disposedSessionIds).toHaveLength(2);
  });

  it("assigns unique nicknames across concurrent spawns", async () => {
    const { manager, parentThreadId } = createManager({});

    const results = await Promise.all([
      spawnAgent(manager, parentThreadId, "one"),
      spawnAgent(manager, parentThreadId, "two"),
      spawnAgent(manager, parentThreadId, "three"),
      spawnAgent(manager, parentThreadId, "four"),
    ]);

    expect(new Set(results.map((result) => result.nickname)).size).toBe(results.length);
  });

  it("rejects cross-parent sendInput access", async () => {
    const { manager } = createManager({});
    const spawned = await manager.spawn({
      parentThreadId: "parent-a",
      message: "work",
    });

    await expect(
      manager.sendInput({
        parentThreadId: "parent-b",
        id: spawned.agent_id,
        message: "follow-up",
      })
    ).rejects.toThrow("does not belong to parent thread");
  });

  it("rejects sendInput while an agent is already running unless interrupted", async () => {
    const { manager, parentThreadId } = createManager({});
    const spawned = await spawnAgent(manager, parentThreadId);

    await expect(
      manager.sendInput({
        parentThreadId,
        id: spawned.agent_id,
        message: "follow-up",
      })
    ).rejects.toThrow("already running");
  });

  it("recursively shuts down descendant agents", async () => {
    const { backend, manager, parentThreadId, childThreadIds } = createManager({});
    const parentAgent = await spawnAgent(manager, parentThreadId, "parent");
    const childThreadId = childThreadIds[0];
    expect(childThreadId).toEqual(expect.any(String));

    const childAgent = await manager.spawn({
      parentThreadId: childThreadId ?? "",
      message: "child",
    });

    await manager.close({
      parentThreadId,
      id: parentAgent.agent_id,
    });

    await expect(
      manager.wait({
        parentThreadId: childThreadId ?? "",
        ids: [childAgent.agent_id],
        timeout_ms: 5,
      })
    ).resolves.toEqual({
      status: {
        [childAgent.agent_id]: "shutdown",
      },
      messages: {
        [childAgent.agent_id]: null,
      },
      timed_out: false,
    });
    expect(backend.disposedSessionIds).toHaveLength(2);
  });

  it("emits collab item notifications for tool calls", async () => {
    const notifications: Array<{ method: string; params: unknown; threadId?: string }> = [];
    const { manager, parentThreadId } = createManager({
      notifySink: {
        async notify(method, params, threadId) {
          notifications.push({ method, params, threadId });
        },
      },
    });

    const spawned = await spawnAgent(manager, parentThreadId);
    await manager.close({ parentThreadId, id: spawned.agent_id });

    expect(notifications.map((entry) => entry.method)).toEqual([
      "item/started",
      "item/completed",
      "item/started",
      "item/completed",
    ]);
  });

  it("emits native-codex collab spawn item shapes", async () => {
    const notifications: Array<{ method: string; params: unknown; threadId?: string }> = [];
    const { manager, parentThreadId, childThreadIds, childThreadInputs } = createManager({
      notifySink: {
        async notify(method, params, threadId) {
          notifications.push({ method, params, threadId });
        },
      },
    });

    await spawnAgent(manager, parentThreadId, "run date");

    const started = notifications[0]?.params as {
      item: {
        id: string;
        receiverThreadIds: string[];
        agentsStates: Record<string, { status: string; message: string | null }>;
      };
    };
    expect(started.item.receiverThreadIds).toEqual([]);
    expect(started.item.agentsStates).toEqual({});

    const completed = notifications[1]?.params as {
      item: {
        id: string;
        receiverThreadIds: string[];
        agentsStates: Record<string, { status: string; message: string | null }>;
      };
    };
    const childThreadId = childThreadIds[0] ?? "";
    expect(completed.item.id).toBe(started.item.id);
    expect(completed.item.receiverThreadIds).toEqual([childThreadId]);
    expect(completed.item.agentsStates).toEqual({
      [childThreadId]: {
        status: "pendingInit",
        message: null,
      },
    });
    expect(childThreadInputs).toEqual([
      expect.objectContaining({
        role: "default",
        preview: "run date",
      }),
    ]);
  });
});
