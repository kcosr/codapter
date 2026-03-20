import { describe, expect, it } from "vitest";
import { TurnStateMachine } from "../src/turn-state.js";

class TestSink {
  public readonly notifications: Array<{ method: string; params: unknown }> = [];

  async notify(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }
}

describe("TurnStateMachine", () => {
  it("marks in-flight tool items as failed when the turn is interrupted", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_cmd",
      toolName: "bash",
      input: { command: "pwd" },
    });
    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_file",
      toolName: "file_edit",
      input: { path: "main.ts" },
    });

    const completed = await machine.interrupt();
    const commandItem = completed.items.find((item) => item.type === "commandExecution");
    const fileItem = completed.items.find((item) => item.type === "fileChange");

    expect(completed.status).toBe("interrupted");
    expect(commandItem).toMatchObject({
      type: "commandExecution",
      source: "agent",
      status: "failed",
    });
    expect(fileItem).toMatchObject({
      type: "fileChange",
      status: "failed",
    });
  });

  it("captures vendored file changes from tool output", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_file",
      toolName: "file_edit",
      input: { path: "main.ts" },
    });
    await machine.handleEvent({
      type: "tool_end",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_file",
      toolName: "file_edit",
      output: {
        content: [
          {
            path: "main.ts",
            kind: { type: "update", move_path: null },
            diff: "@@ -1 +1 @@\n-old\n+new\n",
          },
        ],
      },
      isError: false,
    });

    const completed = await machine.handleEvent({
      type: "message_end",
      sessionId: "session_1",
      turnId: "turn_1",
    });

    expect(completed).toMatchObject({
      status: "completed",
      items: [
        {
          type: "fileChange",
          status: "completed",
          changes: [
            {
              path: "main.ts",
              kind: { type: "update", move_path: null },
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
        },
      ],
    });
  });
});
