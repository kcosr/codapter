import { describe, expect, it } from "vitest";
import {
  isAssistantMessageEvent,
  isElicitationRequest,
  isRpcExtensionUIRequest,
  isToolExecutionEndEvent,
  isToolExecutionStartEvent,
  isToolExecutionUpdateEvent,
  mapBackendMessages,
  normalizeElicitationResponse,
} from "../src/pi-process.js";

describe("pi-process vendored PI helpers", () => {
  const assistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  it("accepts typed extension UI requests and narrows elicitation variants", () => {
    const request = {
      type: "extension_ui_request",
      id: "req-1",
      method: "select",
      title: "Choose",
      options: ["a", "b"],
    };

    expect(isRpcExtensionUIRequest(request)).toBe(true);
    expect(isElicitationRequest(request)).toBe(true);
  });

  it("rejects malformed extension UI requests", () => {
    expect(
      isRpcExtensionUIRequest({
        type: "extension_ui_request",
        id: "req-1",
        method: "select",
        options: ["a", "b"],
      })
    ).toBe(false);

    expect(
      isRpcExtensionUIRequest({
        type: "extension_ui_request",
        id: "req-2",
        method: "setStatus",
      })
    ).toBe(false);

    expect(
      isRpcExtensionUIRequest({ type: "extension_ui_request", id: 3, method: "confirm" })
    ).toBe(false);
  });

  it("normalizes supported elicitation responses", () => {
    expect(normalizeElicitationResponse("req-1", "value")).toEqual({
      type: "extension_ui_response",
      id: "req-1",
      value: "value",
    });

    expect(normalizeElicitationResponse("req-2", { confirmed: true })).toEqual({
      type: "extension_ui_response",
      id: "req-2",
      confirmed: true,
    });

    expect(normalizeElicitationResponse("req-3", { cancelled: true })).toEqual({
      type: "extension_ui_response",
      id: "req-3",
      cancelled: true,
    });
  });

  it("rejects unsupported elicitation response shapes", () => {
    expect(() => normalizeElicitationResponse("req-1", 123)).toThrow(
      "Unsupported Pi elicitation response shape"
    );
  });

  it("accepts vendored tool execution events", () => {
    expect(
      isToolExecutionStartEvent({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
      })
    ).toBe(true);
    expect(
      isToolExecutionUpdateEvent({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" },
        partialResult: { content: [{ type: "text", text: "/repo" }] },
      })
    ).toBe(true);
    expect(
      isToolExecutionEndEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "/repo" }] },
        isError: false,
      })
    ).toBe(true);
  });

  it("accepts vendored assistant message events", () => {
    expect(
      isAssistantMessageEvent({
        type: "start",
        partial: assistantMessage,
      })
    ).toBe(true);
    expect(
      isAssistantMessageEvent({
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: assistantMessage,
      })
    ).toBe(true);
    expect(
      isAssistantMessageEvent({
        type: "done",
        reason: "stop",
        message: assistantMessage,
      })
    ).toBe(true);
    expect(
      isAssistantMessageEvent({
        type: "thinking_end",
        contentIndex: 0,
        content: "done thinking",
        partial: assistantMessage,
      })
    ).toBe(true);
    expect(
      isAssistantMessageEvent({
        type: "error",
        reason: "aborted",
        error: {
          ...assistantMessage,
          stopReason: "error",
          errorMessage: "nested failure",
        },
      })
    ).toBe(true);
  });

  it("rejects malformed tool execution events", () => {
    expect(
      isToolExecutionStartEvent({
        type: "tool_execution_start",
        toolCallId: 1,
        toolName: "bash",
      })
    ).toBe(false);
    expect(
      isToolExecutionUpdateEvent({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "bash",
      })
    ).toBe(false);
    expect(
      isToolExecutionEndEvent({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: {},
        isError: "no",
      })
    ).toBe(false);
    expect(
      isAssistantMessageEvent({
        type: "error",
        reason: "error",
      })
    ).toBe(false);
    expect(
      isAssistantMessageEvent({
        type: "error",
        reason: "error",
        error: null,
      })
    ).toBe(false);
    expect(
      isAssistantMessageEvent({
        type: "start",
        partial: null,
      })
    ).toBe(false);
    expect(
      isAssistantMessageEvent({
        type: "done",
        reason: "stop",
        message: "not-a-message",
      })
    ).toBe(false);
    expect(
      isAssistantMessageEvent({
        type: "unknown_event",
        partial: assistantMessage,
      })
    ).toBe(false);
  });

  it("preserves assistant stop reasons and error messages in normalized history", () => {
    expect(
      mapBackendMessages([
        {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "failed" }],
          stopReason: "error",
          errorMessage: "prompt is too long",
          timestamp: Date.now(),
        },
      ])
    ).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        stopReason: "error",
        errorMessage: "prompt is too long",
      }),
    ]);
  });
});
