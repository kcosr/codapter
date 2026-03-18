import { randomUUID } from "node:crypto";
import type { BackendEvent, BackendTokenUsage } from "./backend.js";
import type { ThreadItem, ThreadTokenUsage, Turn, TurnError } from "./protocol.js";

export interface TurnStateNotificationSink {
  notify(method: string, params: unknown): Promise<void>;
}

interface ToolState {
  readonly toolCallId: string;
  readonly item: ThreadItem;
  previousOutput: string;
  startedAt: number;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  return JSON.stringify(value);
}

function inferCommand(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  if (!input || typeof input !== "object") {
    return "";
  }
  const record = input as Record<string, unknown>;
  if (Array.isArray(record.command)) {
    return record.command.filter((value): value is string => typeof value === "string").join(" ");
  }
  if (typeof record.command === "string") {
    return record.command;
  }
  return "";
}

function toolOutputText(output: unknown): string {
  if (!output || typeof output !== "object") {
    return textFromUnknown(output);
  }

  const record = output as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return textFromUnknown(entry);
        }
        const typed = entry as Record<string, unknown>;
        if (typed.type === "text" && typeof typed.text === "string") {
          return typed.text;
        }
        return textFromUnknown(entry);
      })
      .join("");
  }

  return textFromUnknown(output);
}

function toolItemKind(toolName: string): "commandExecution" | "fileChange" | "agentMessage" {
  if (/bash|shell|command/i.test(toolName)) {
    return "commandExecution";
  }
  if (/edit|write|patch|file/i.test(toolName)) {
    return "fileChange";
  }
  return "agentMessage";
}

export class TurnStateMachine {
  private readonly turn: Turn;
  private readonly items = new Map<string, ThreadItem>();
  private readonly toolStates = new Map<string, ToolState>();
  private agentMessageItemId: string | null = null;
  private reasoningItemId: string | null = null;
  private finalized = false;

  constructor(
    private readonly threadId: string,
    turnId: string,
    private readonly cwd: string,
    private readonly sink: TurnStateNotificationSink
  ) {
    this.turn = {
      id: turnId,
      items: [],
      status: "inProgress",
      error: null,
    };
  }

  get snapshot(): Turn {
    return structuredClone(this.turn);
  }

  async emitStarted(): Promise<void> {
    await this.sink.notify("turn/started", {
      threadId: this.threadId,
      turn: this.snapshot,
    });
  }

  async handleEvent(event: BackendEvent): Promise<Turn | null> {
    if (this.finalized) {
      return null;
    }

    switch (event.type) {
      case "text_delta":
        await this.handleTextDelta(event.delta);
        return null;
      case "thinking_delta":
        await this.handleThinkingDelta(event.delta);
        return null;
      case "tool_start":
        await this.handleToolStart(event.toolCallId, event.toolName, event.input);
        return null;
      case "tool_update":
        await this.handleToolUpdate(
          event.toolCallId,
          event.toolName,
          event.output,
          event.isCumulative
        );
        return null;
      case "tool_end":
        await this.handleToolEnd(event.toolCallId, event.output, event.isError);
        return null;
      case "message_end":
        return await this.complete("completed", null);
      case "error":
        return await this.complete("failed", {
          message: event.message,
          codexErrorInfo: null,
          additionalDetails: null,
        });
      case "elicitation_request":
      case "token_usage":
        return null;
    }
  }

  async interrupt(): Promise<Turn> {
    return await this.complete("interrupted", null);
  }

  private async handleTextDelta(delta: string): Promise<void> {
    const itemId = this.agentMessageItemId ?? (await this.startAgentMessageItem());
    const item = this.items.get(itemId);
    if (!item || item.type !== "agentMessage") {
      throw new Error(`Agent message item missing for ${itemId}`);
    }
    item.text += delta;
    await this.sink.notify("item/agentMessage/delta", {
      threadId: this.threadId,
      turnId: this.turn.id,
      itemId,
      delta,
    });
  }

  private async handleThinkingDelta(delta: string): Promise<void> {
    const itemId = this.reasoningItemId ?? (await this.startReasoningItem());
    const item = this.items.get(itemId);
    if (!item || item.type !== "reasoning") {
      throw new Error(`Reasoning item missing for ${itemId}`);
    }
    if (item.summary.length === 0) {
      item.summary.push("");
    }
    item.summary[0] += delta;
    await this.sink.notify("item/reasoning/summaryTextDelta", {
      threadId: this.threadId,
      turnId: this.turn.id,
      itemId,
      delta,
      summaryIndex: 0,
    });
  }

  private async handleToolStart(
    toolCallId: string,
    toolName: string,
    input: unknown
  ): Promise<void> {
    const id = randomUUID();
    const kind = toolItemKind(toolName);
    const item: ThreadItem =
      kind === "commandExecution"
        ? {
            type: "commandExecution",
            id,
            command: inferCommand(input),
            cwd: this.cwd,
            processId: null,
            status: "inProgress",
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          }
        : kind === "fileChange"
          ? {
              type: "fileChange",
              id,
              changes: [],
              status: "inProgress",
            }
          : {
              type: "agentMessage",
              id,
              text: "",
              phase: null,
            };

    await this.storeItem(item);
    this.toolStates.set(toolCallId, {
      toolCallId,
      item,
      previousOutput: "",
      startedAt: Date.now(),
    });
  }

  private async handleToolUpdate(
    toolCallId: string,
    toolName: string,
    output: unknown,
    isCumulative: boolean
  ): Promise<void> {
    const state = this.toolStates.get(toolCallId);
    if (!state) {
      await this.handleToolStart(toolCallId, toolName, {});
      return this.handleToolUpdate(toolCallId, toolName, output, isCumulative);
    }

    const next = toolOutputText(output);
    const delta =
      isCumulative && next.startsWith(state.previousOutput)
        ? next.slice(state.previousOutput.length)
        : next;
    state.previousOutput = isCumulative ? next : `${state.previousOutput}${delta}`;

    if (state.item.type === "commandExecution") {
      state.item.aggregatedOutput = (state.item.aggregatedOutput ?? "") + delta;
      await this.sink.notify("item/commandExecution/outputDelta", {
        threadId: this.threadId,
        turnId: this.turn.id,
        itemId: state.item.id,
        delta,
      });
      return;
    }

    if (state.item.type === "fileChange") {
      await this.sink.notify("item/fileChange/outputDelta", {
        threadId: this.threadId,
        turnId: this.turn.id,
        itemId: state.item.id,
        delta,
      });
      return;
    }

    if (state.item.type !== "agentMessage") {
      throw new Error(`Unsupported tool item type for delta updates: ${state.item.type}`);
    }

    state.item.text += delta;
    await this.sink.notify("item/agentMessage/delta", {
      threadId: this.threadId,
      turnId: this.turn.id,
      itemId: state.item.id,
      delta,
    });
  }

  private async handleToolEnd(
    toolCallId: string,
    output: unknown,
    isError: boolean
  ): Promise<void> {
    const state = this.toolStates.get(toolCallId);
    if (!state) {
      return;
    }

    if (state.item.type === "commandExecution") {
      const outputText = toolOutputText(output);
      if (outputText && !state.item.aggregatedOutput) {
        state.item.aggregatedOutput = outputText;
      }
      state.item.status = isError ? "failed" : "completed";
      state.item.exitCode = isError ? 1 : 0;
      state.item.durationMs = Date.now() - state.startedAt;
    }

    if (state.item.type === "fileChange") {
      state.item.status = isError ? "failed" : "completed";
    }

    await this.completeItem(state.item.id);
    this.toolStates.delete(toolCallId);
  }

  private async startAgentMessageItem(): Promise<string> {
    const item: ThreadItem = {
      type: "agentMessage",
      id: randomUUID(),
      text: "",
      phase: null,
    };
    this.agentMessageItemId = item.id;
    await this.storeItem(item);
    return item.id;
  }

  private async startReasoningItem(): Promise<string> {
    const item: ThreadItem = {
      type: "reasoning",
      id: randomUUID(),
      summary: [],
      content: [],
    };
    this.reasoningItemId = item.id;
    await this.storeItem(item);
    return item.id;
  }

  private async storeItem(item: ThreadItem): Promise<void> {
    this.items.set(item.id, item);
    this.turn.items.push(item);
    await this.sink.notify("item/started", {
      item: structuredClone(item),
      threadId: this.threadId,
      turnId: this.turn.id,
    });
  }

  private async completeItem(itemId: string): Promise<void> {
    const item = this.items.get(itemId);
    if (!item) {
      return;
    }
    await this.sink.notify("item/completed", {
      item: structuredClone(item),
      threadId: this.threadId,
      turnId: this.turn.id,
    });
    if (this.agentMessageItemId === itemId) {
      this.agentMessageItemId = null;
    }
    if (this.reasoningItemId === itemId) {
      this.reasoningItemId = null;
    }
  }

  private async complete(status: Turn["status"], error: TurnError | null): Promise<Turn> {
    if (this.finalized) {
      return this.snapshot;
    }
    this.finalized = true;

    if (this.agentMessageItemId) {
      await this.completeItem(this.agentMessageItemId);
    }
    if (this.reasoningItemId) {
      await this.completeItem(this.reasoningItemId);
    }
    for (const [toolCallId, state] of this.toolStates) {
      if (state.item.type === "commandExecution") {
        state.item.status = status === "interrupted" ? "interrupted" : state.item.status;
        state.item.durationMs = Date.now() - state.startedAt;
      }
      if (state.item.type === "fileChange" && status === "interrupted") {
        state.item.status = "interrupted";
      }
      await this.completeItem(state.item.id);
      this.toolStates.delete(toolCallId);
    }

    this.turn.status = status;
    this.turn.error = error;
    await this.sink.notify("turn/completed", {
      threadId: this.threadId,
      turn: this.snapshot,
    });
    if (error) {
      await this.sink.notify("error", {
        error,
        willRetry: false,
        threadId: this.threadId,
        turnId: this.turn.id,
      });
    }
    return this.snapshot;
  }
}

export function toThreadTokenUsage(usage: BackendTokenUsage): ThreadTokenUsage {
  return {
    modelContextWindow: usage.modelContextWindow,
    last: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cachedInputTokens: usage.cacheRead,
      cachedOutputTokens: usage.cacheWrite,
      totalTokens: usage.total,
    },
  };
}
