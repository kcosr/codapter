import { describe, expect, it } from "vitest";
import { TurnStateMachine } from "../src/turn-state.js";

class TestSink {
  public readonly notifications: Array<{ method: string; params: unknown }> = [];

  async notify(method: string, params: unknown): Promise<void> {
    this.notifications.push({ method, params });
  }
}

describe("TurnStateMachine", () => {
  it("streams reasoning and assistant text into vendored items", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "thinking_delta",
      sessionId: "session_1",
      turnId: "turn_1",
      delta: "plan",
    });
    await machine.handleEvent({
      type: "thinking_delta",
      sessionId: "session_1",
      turnId: "turn_1",
      delta: " more",
    });
    await machine.handleEvent({
      type: "text_delta",
      sessionId: "session_1",
      turnId: "turn_1",
      delta: "hello",
    });
    await machine.handleEvent({
      type: "text_delta",
      sessionId: "session_1",
      turnId: "turn_1",
      delta: " world",
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
          type: "reasoning",
          summary: ["plan more"],
          content: [],
        },
        {
          type: "agentMessage",
          text: "hello world",
          phase: null,
          memoryCitation: null,
        },
      ],
    });
  });

  it("streams command execution output and completes with vendored fields", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_cmd",
      toolName: "bash",
      input: { command: ["pwd"] },
    });
    await machine.handleEvent({
      type: "tool_update",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_cmd",
      toolName: "bash",
      output: { content: [{ type: "text", text: "/repo" }] },
      isCumulative: false,
    });
    await machine.handleEvent({
      type: "tool_end",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_cmd",
      toolName: "bash",
      output: { content: [{ type: "text", text: "/repo\n" }] },
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
          type: "commandExecution",
          command: "pwd",
          cwd: "/repo",
          source: "agent",
          status: "completed",
          aggregatedOutput: "/repo",
          exitCode: 0,
        },
      ],
    });
    expect(
      sink.notifications.some(
        (notification) => notification.method === "item/commandExecution/outputDelta"
      )
    ).toBe(true);
  });

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

  it("falls back to agentMessage for unknown tools", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "tool_start",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_unknown",
      toolName: "search_web",
      input: {},
    });
    await machine.handleEvent({
      type: "tool_update",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_unknown",
      toolName: "search_web",
      output: { content: [{ type: "text", text: "result" }] },
      isCumulative: false,
    });
    await machine.handleEvent({
      type: "tool_end",
      sessionId: "session_1",
      turnId: "turn_1",
      toolCallId: "tool_unknown",
      toolName: "search_web",
      output: { content: [{ type: "text", text: "result" }] },
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
          type: "agentMessage",
          text: "result",
          memoryCitation: null,
        },
      ],
    });
  });

  it("completes the turn as failed on backend error events", async () => {
    const sink = new TestSink();
    const machine = new TurnStateMachine("thread_1", "turn_1", "/repo", sink);

    await machine.emitStarted();
    await machine.handleEvent({
      type: "text_delta",
      sessionId: "session_1",
      turnId: "turn_1",
      delta: "partial",
    });

    const completed = await machine.handleEvent({
      type: "error",
      sessionId: "session_1",
      turnId: "turn_1",
      message: "backend failed",
    });

    expect(completed).toMatchObject({
      status: "failed",
      error: {
        message: "backend failed",
        codexErrorInfo: null,
        additionalDetails: null,
      },
      items: [
        {
          type: "agentMessage",
          text: "partial",
        },
      ],
    });
    expect(sink.notifications.some((notification) => notification.method === "error")).toBe(true);
  });
});
