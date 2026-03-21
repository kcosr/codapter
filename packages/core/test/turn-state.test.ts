import { describe, expect, it } from "vitest";
import type { BackendEvent } from "../src/backend.js";
import { TurnStateMachine } from "../src/turn-state.js";

function createMachine() {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const machine = new TurnStateMachine("thread-1", "turn-1", "/repo", {
    async notify(method, params) {
      notifications.push({ method, params });
    },
  });

  return { machine, notifications };
}

describe("TurnStateMachine", () => {
  it("suppresses collab tool notifications", async () => {
    const { machine, notifications } = createMachine();

    const events: BackendEvent[] = [
      {
        type: "tool_start",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "spawn_agent",
        input: { message: "delegate" },
      },
      {
        type: "tool_update",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "spawn_agent",
        output: { content: [{ type: "text", text: "running" }] },
        isCumulative: true,
      },
      {
        type: "tool_end",
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tool-1",
        toolName: "spawn_agent",
        output: { content: [{ type: "text", text: "done" }] },
        isError: false,
      },
      {
        type: "message_end",
        sessionId: "session-1",
        turnId: "turn-1",
      },
    ];

    for (const event of events) {
      await machine.handleEvent(event);
    }

    expect(notifications.some((notification) => notification.method === "item/started")).toBe(
      false
    );
    expect(notifications.some((notification) => notification.method === "item/completed")).toBe(
      false
    );
    expect(
      notifications.find((notification) => notification.method === "turn/completed")
    ).toBeTruthy();
  });

  it("keeps non-collab tool notifications intact", async () => {
    const { machine, notifications } = createMachine();

    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: ["echo", "hi"] },
    });
    await machine.handleEvent({
      type: "tool_update",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
      output: { content: [{ type: "text", text: "hi" }] },
      isCumulative: true,
    });
    await machine.handleEvent({
      type: "tool_end",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tool-1",
      toolName: "bash",
      output: { content: [{ type: "text", text: "hi" }] },
      isError: false,
    });

    expect(notifications.find((notification) => notification.method === "item/started")).toEqual(
      expect.objectContaining({
        method: "item/started",
      })
    );
    expect(notifications.find((notification) => notification.method === "item/completed")).toEqual(
      expect.objectContaining({
        method: "item/completed",
      })
    );
  });

  it("creates a final agent message item from message_end text when no deltas arrived", async () => {
    const { machine, notifications } = createMachine();

    await machine.handleEvent({
      type: "message_end",
      sessionId: "session-1",
      turnId: "turn-1",
      text: "final response",
    });

    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: "item/started",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "agentMessage",
            text: "final response",
          }),
        }),
      })
    );
    expect(notifications).toContainEqual(
      expect.objectContaining({
        method: "item/completed",
        params: expect.objectContaining({
          item: expect.objectContaining({
            type: "agentMessage",
            text: "final response",
          }),
        }),
      })
    );
  });
});
