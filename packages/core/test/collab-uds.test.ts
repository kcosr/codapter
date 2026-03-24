import { stat } from "node:fs/promises";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CollabManager } from "../src/collab-manager.js";
import { CollabUdsListener } from "../src/collab-uds.js";

function callSocket(socketPath: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      const line = lines.find((entry) => entry.trim().length > 0);
      if (!line) {
        return;
      }
      socket.end();
      resolve(JSON.parse(line) as unknown);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
}

const listeners: CollabUdsListener[] = [];

afterEach(async () => {
  await Promise.all(listeners.splice(0).map(async (listener) => listener.close()));
});

describe("CollabUdsListener", () => {
  it("routes collab/spawn and maps snake_case params", async () => {
    let captured: unknown;
    const listener = new CollabUdsListener({
      collabManager: {
        async spawn(request) {
          captured = request;
          return { agent_id: "agent-1", nickname: "Robie" };
        },
      } as unknown as CollabManager,
      validateParentThread(parentThreadId) {
        expect(parentThreadId).toBe("thread-1");
      },
    });
    listeners.push(listener);
    await listener.start();

    const response = await callSocket(listener.socketPath, {
      id: 1,
      method: "collab/spawn",
      params: {
        parentThreadId: "thread-1",
        message: "delegate",
        agent_type: "worker",
        model: "gpt-5.4-mini",
        reasoning_effort: "medium",
        fork_context: true,
      },
    });

    expect(response).toEqual({
      id: 1,
      result: {
        agent_id: "agent-1",
        nickname: "Robie",
      },
    });
    expect(captured).toEqual({
      parentThreadId: "thread-1",
      message: "delegate",
      agentType: "worker",
      model: "gpt-5.4-mini",
      reasoningEffort: "medium",
      forkContext: true,
    });
  });

  it("normalizes collab/spawn items into a prompt and keeps structured inputs", async () => {
    let captured: unknown;
    const listener = new CollabUdsListener({
      collabManager: {
        async spawn(request) {
          captured = request;
          return { agent_id: "agent-1", nickname: "Robie" };
        },
      } as unknown as CollabManager,
      validateParentThread() {},
    });
    listeners.push(listener);
    await listener.start();

    const response = await callSocket(listener.socketPath, {
      id: 3,
      method: "collab/spawn",
      params: {
        parentThreadId: "thread-1",
        items: [
          {
            type: "text",
            text: "delegate",
          },
        ],
      },
    });

    expect(response).toEqual({
      id: 3,
      result: {
        agent_id: "agent-1",
        nickname: "Robie",
      },
    });
    expect(captured).toEqual({
      parentThreadId: "thread-1",
      message: "delegate",
      items: [
        {
          type: "text",
          text: "delegate",
          text_elements: [],
        },
      ],
    });
  });

  it("prefers message text when both message and items are provided", async () => {
    let captured: unknown;
    const listener = new CollabUdsListener({
      collabManager: {
        async sendInput(request) {
          captured = request;
          return { submission_id: "submission-1" };
        },
      } as unknown as CollabManager,
      validateParentThread() {},
    });
    listeners.push(listener);
    await listener.start();

    const response = await callSocket(listener.socketPath, {
      id: 4,
      method: "collab/sendInput",
      params: {
        parentThreadId: "thread-1",
        id: "agent-1",
        message: "follow up",
        items: [
          {
            type: "text",
            text: "follow up",
          },
        ],
      },
    });

    expect(response).toEqual({
      id: 4,
      result: {
        submission_id: "submission-1",
      },
    });
    expect(captured).toEqual({
      parentThreadId: "thread-1",
      id: "agent-1",
      message: "follow up",
      items: [
        {
          type: "text",
          text: "follow up",
          text_elements: [],
        },
      ],
    });
  });

  it("rejects invalid parentThreadId bindings", async () => {
    const listener = new CollabUdsListener({
      collabManager: {} as CollabManager,
      validateParentThread() {
        throw new Error("Thread thread-2 is not loaded");
      },
    });
    listeners.push(listener);
    await listener.start();

    const response = (await callSocket(listener.socketPath, {
      id: 2,
      method: "collab/close",
      params: {
        parentThreadId: "thread-2",
        id: "agent-1",
      },
    })) as { error: { message: string } };

    expect(response.error.message).toContain("thread-2");
  });

  it("creates the UDS with 0600 permissions", async () => {
    const listener = new CollabUdsListener({
      collabManager: {} as CollabManager,
      validateParentThread() {},
    });
    listeners.push(listener);
    await listener.start();

    const stats = await stat(listener.socketPath);
    expect(stats.isSocket()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
