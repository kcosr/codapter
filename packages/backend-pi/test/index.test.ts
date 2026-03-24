import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiBackend, createPiBackend } from "../src/index.js";

async function createMockPiScript(rootDir: string): Promise<string> {
  const scriptPath = join(rootDir, "mock-pi-rpc.mjs");
  const script = [
    "import { randomUUID } from 'node:crypto';",
    "import { writeFile } from 'node:fs/promises';",
    "import { StringDecoder } from 'node:string_decoder';",
    "import { join } from 'node:path';",
    "",
    "const sessionDir = process.argv[2] ?? process.cwd();",
    "const capturePath = process.env.CODAPTER_CAPTURE_PROCESS_PATH;",
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "let promptCounter = 0;",
    "",
    "const state = {",
    "  sessionId: 'mock-session',",
    "  sessionFile: undefined,",
    "  sessionName: undefined,",
    "  model: { provider: 'pi', id: 'mock-default', name: 'Mock Default', reasoning: true, input: ['text', 'image'], contextWindow: 128000 },",
    "  history: [],",
    "  lastElicitationResponse: undefined,",
    "  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },",
    "};",
    "",
    "const availableModels = [",
    "  { provider: 'pi', id: 'mock-default', name: 'Mock Default', reasoning: true, input: ['text', 'image'], contextWindow: 128000 },",
    "  { provider: 'pi', id: 'mock-fast', name: 'Mock Fast', reasoning: false, input: ['text'], contextWindow: 64000 },",
    "  { provider: 'openai-codex', id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true, input: ['text', 'image'], contextWindow: 272000 },",
    "  { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, input: ['text', 'image'], contextWindow: 1000000 },",
    "];",
    "",
    "if (capturePath) {",
    "  await writeFile(capturePath, JSON.stringify({",
    "    argv: process.argv.slice(2),",
    "    collabSocketPath: process.env.CODAPTER_COLLAB_UDS ?? null,",
    "    parentThreadId: process.env.CODAPTER_COLLAB_PARENT_THREAD ?? null,",
    "    availableModelsDescription: process.env.CODAPTER_COLLAB_AVAILABLE_MODELS_DESCRIPTION ?? null,",
    "  }), 'utf8');",
    "}",
    "",
    "function write(value) {",
    "  process.stdout.write(JSON.stringify(value) + '\\n');",
    "}",
    "",
    "function response(id, command, data) {",
    "  write({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) });",
    "}",
    "",
    "function error(id, command, message) {",
    "  write({ id, type: 'response', command, success: false, error: message });",
    "}",
    "",
    "function clone(value) {",
    "  return JSON.parse(JSON.stringify(value));",
    "}",
    "",
    "function ensureSessionFile() {",
    "  if (!state.sessionFile) {",
    "    state.sessionFile = join(sessionDir, state.sessionId + '.jsonl');",
    "  }",
    "  return state.sessionFile;",
    "}",
    "",
    "function emitPromptTurn(message) {",
    "  const turnId = ++promptCounter;",
    "  const assistantToolMessage = {",
    "    id: 'assistant-tool-' + turnId,",
    "    role: 'assistant',",
    "    content: [{ type: 'toolCall', id: 'tool-' + turnId, name: 'bash', arguments: { command: 'echo hi' } }],",
    "    stopReason: 'toolUse',",
    "    timestamp: Date.now(),",
    "  };",
    "  const toolResultMessage = {",
    "    id: 'tool-result-' + turnId,",
    "    role: 'toolResult',",
    "    toolCallId: 'tool-' + turnId,",
    "    toolName: 'bash',",
    "    content: [{ type: 'text', text: 'hi' }],",
    "    isError: false,",
    "    timestamp: Date.now(),",
    "  };",
    "  const assistantFinalMessage = {",
    "    id: 'assistant-' + turnId,",
    "    role: 'assistant',",
    "    content: [{ type: 'text', text: 'response-' + turnId }],",
    "    stopReason: 'stop',",
    "    timestamp: Date.now(),",
    "  };",
    "  const userMessage = {",
    "    id: 'user-' + turnId,",
    "    role: 'user',",
    "    content: [{ type: 'text', text: message }],",
    "    timestamp: Date.now(),",
    "  };",
    "",
    "  state.history.push(userMessage);",
    "",
    "  setTimeout(() => {",
    "    write({ type: 'turn_start' });",
    "    write({ type: 'message_start', message: userMessage });",
    "    write({ type: 'message_end', message: userMessage });",
    "    write({ type: 'message_start', message: assistantToolMessage });",
    "    write({ type: 'message_end', message: assistantToolMessage });",
    "    write({",
    "      type: 'tool_execution_start',",
    "      toolCallId: 'tool-' + turnId,",
    "      toolName: 'bash',",
    "      args: { command: 'echo hi' },",
    "    });",
    "    write({",
    "      type: 'tool_execution_update',",
    "      toolCallId: 'tool-' + turnId,",
    "      toolName: 'bash',",
    "      args: { command: 'echo hi' },",
    "      partialResult: { content: [{ type: 'text', text: 'hi' }], details: { chunk: 1 } },",
    "    });",
    "    write({",
    "      type: 'tool_execution_end',",
    "      toolCallId: 'tool-' + turnId,",
    "      toolName: 'bash',",
    "      result: { content: [{ type: 'text', text: 'hi' }], details: { exitCode: 0 } },",
    "      isError: false,",
    "    });",
    "    write({",
    "      type: 'extension_ui_request',",
    "      id: 'elicitation-' + turnId,",
    "      method: 'confirm',",
    "      title: 'Confirm',",
    "      message: 'Proceed?',",
    "    });",
    "    write({ type: 'message_start', message: toolResultMessage });",
    "    write({ type: 'message_end', message: toolResultMessage });",
    "    write({ type: 'turn_end', message: assistantToolMessage, toolResults: [toolResultMessage] });",
    "    write({ type: 'turn_start' });",
    "    write({ type: 'message_start', message: assistantFinalMessage });",
    "    write({",
    "      type: 'message_update',",
    "      message: assistantFinalMessage,",
    "      assistantMessageEvent: { type: 'text_delta', delta: 'response-' + turnId },",
    "    });",
    "    write({ type: 'message_end', message: assistantFinalMessage });",
    "    write({ type: 'turn_end', message: assistantFinalMessage, toolResults: [] });",
    "    state.history.push(assistantToolMessage);",
    "    state.history.push(toolResultMessage);",
    "    state.history.push(assistantFinalMessage);",
    "    state.tokens = { input: 5, output: 7, cacheRead: 0, cacheWrite: 0, total: 12 };",
    "  }, 15);",
    "}",
    "",
    "function handleCommand(command) {",
    "  const { id, type } = command;",
    "",
    "  if (type === 'get_state') {",
    "    response(id, 'get_state', {",
    "      sessionId: state.sessionId,",
    "      sessionFile: state.sessionFile,",
    "      sessionName: state.sessionName,",
    "      model: state.model,",
    "    });",
    "    return;",
    "  }",
    "",
    "  if (type === 'new_session') {",
    "    state.sessionId = 'mock-' + randomUUID();",
    "    state.sessionFile = join(sessionDir, state.sessionId + '.jsonl');",
    "    response(id, 'new_session', { cancelled: false });",
    "    return;",
    "  }",
    "",
    "  if (type === 'switch_session') {",
    "    state.sessionFile = command.sessionPath;",
    "    response(id, 'switch_session', { cancelled: false });",
    "    return;",
    "  }",
    "",
    "  if (type === 'fork') {",
    "    state.sessionId = 'mock-' + randomUUID();",
    "    state.sessionFile = (state.sessionFile ?? join(sessionDir, 'forked.jsonl')) + '.fork';",
    "    response(id, 'fork', { text: 'Forked', cancelled: false });",
    "    return;",
    "  }",
    "",
    "  if (type === 'get_fork_messages') {",
    "    const anchor = state.history.filter((message) => message.role === 'user').at(-1);",
    "    response(id, 'get_fork_messages', {",
    "      messages: [{ entryId: anchor?.id ?? 'entry-1', text: anchor?.content?.text ?? 'anchor' }],",
    "    });",
    "    return;",
    "  }",
    "",
    "  if (type === 'set_session_name') {",
    "    state.sessionName = command.name;",
    "    response(id, 'set_session_name');",
    "    return;",
    "  }",
    "",
    "  if (type === 'set_model') {",
    "    const nextModel = availableModels.find((model) => model.provider === command.provider && model.id === command.modelId);",
    "    if (!nextModel) {",
    "      error(id, 'set_model', 'Model not found: ' + command.provider + '/' + command.modelId);",
    "      return;",
    "    }",
    "    state.model = nextModel;",
    "    response(id, 'set_model', { model: nextModel });",
    "    return;",
    "  }",
    "",
    "  if (type === 'get_available_models') {",
    "    response(id, 'get_available_models', { models: availableModels });",
    "    return;",
    "  }",
    "",
    "  if (type === 'get_messages') {",
    "    response(id, 'get_messages', { messages: clone(state.history) });",
    "    return;",
    "  }",
    "",
    "  if (type === 'get_session_stats') {",
    "    response(id, 'get_session_stats', {",
    "      sessionFile: state.sessionFile,",
    "      sessionId: state.sessionId,",
    "      userMessages: state.history.filter((message) => message.role === 'user').length,",
    "      assistantMessages: state.history.filter((message) => message.role === 'assistant').length,",
    "      toolCalls: 1,",
    "      toolResults: 1,",
    "      totalMessages: state.history.length,",
    "      tokens: state.tokens,",
    "      cost: 0,",
    "    });",
    "    return;",
    "  }",
    "",
    "  if (type === 'prompt') {",
    "    response(id, 'prompt');",
    "    emitPromptTurn(command.message);",
    "    return;",
    "  }",
    "",
    "  if (type === 'abort') {",
    "    response(id, 'abort');",
    "    return;",
    "  }",
    "",
    "  if (type === 'extension_ui_response') {",
    "    state.lastElicitationResponse = command;",
    "    state.history.push({",
    "      id: 'elicitation-response-' + Date.now(),",
    "      role: 'system',",
    "      content: clone(command),",
    "      timestamp: Date.now(),",
    "    });",
    "    return;",
    "  }",
    "",
    "  error(id, type, 'Unsupported command: ' + type);",
    "}",
    "",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  while (true) {",
    "    const newlineIndex = buffer.indexOf('\\n');",
    "    if (newlineIndex === -1) {",
    "      break;",
    "    }",
    "",
    "    const line = buffer.slice(0, newlineIndex).trim();",
    "    buffer = buffer.slice(newlineIndex + 1);",
    "    if (!line) {",
    "      continue;",
    "    }",
    "",
    "    try {",
    "      handleCommand(JSON.parse(line));",
    "    } catch (error) {",
    "      write({ type: 'response', command: 'unknown', success: false, error: error instanceof Error ? error.message : String(error) });",
    "    }",
    "  }",
    "});",
  ].join("\n");

  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 3000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for condition");
}

describe("PiBackend", () => {
  it("requires initialize before use", async () => {
    const backend = new PiBackend();
    await expect(backend.createSession()).rejects.toThrow(
      "Pi backend must be initialized before use"
    );
  });

  it("integrates with a real JSONL subprocess", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-"));
    const sessionDir = join(rootDir, "sessions");
    const logFilePath = join(rootDir, "pi-transport.jsonl");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      debugLogFilePath: logFilePath,
    });

    await backend.initialize();

    const models = await backend.listModels();
    expect(models).toHaveLength(4);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.id).toBe("pi/mock-default");
    expect(models.some((model) => model.id === "anthropic/claude-opus-4-6")).toBe(true);

    const capabilities = await backend.getCapabilities();
    expect(capabilities).toEqual({
      requiresAuth: false,
      supportsImages: true,
      supportsThinking: true,
      supportsParallelTools: true,
      supportedToolTypes: [],
    });

    const selectedModel = models.at(1);
    if (!selectedModel) {
      throw new Error("Expected a second mock model");
    }

    const threadId = "thread-pi-1";
    const started = await backend.threadStart({
      threadId,
      cwd: sessionDir,
      model: selectedModel.id,
      reasoningEffort: "medium",
    });
    const threadHandle = started.threadHandle;
    expect(threadHandle.startsWith("pi_session_")).toBe(true);

    const notifications: Array<{ method: string; params: unknown }> = [];
    const serverRequests: Array<{ requestId: string | number; method: string; params: unknown }> =
      [];
    const subscription = backend.onEvent(threadHandle, (event) => {
      if (event.kind === "notification") {
        notifications.push({ method: event.method, params: event.params });
        return;
      }
      if (event.kind === "serverRequest") {
        serverRequests.push({
          requestId: event.requestId,
          method: event.method,
          params: event.params,
        });
      }
    });

    await backend.threadSetName({ threadId, threadHandle, name: "Primary session" });
    await backend.setModel(threadHandle, selectedModel.id);
    await backend.setModel(threadHandle, "gpt-5.3-codex");
    await backend.turnStart({
      threadId,
      threadHandle,
      turnId: "turn_1",
      cwd: sessionDir,
      input: [{ type: "text", text: "hello world", text_elements: [] }],
      model: null,
      reasoningEffort: "medium",
    });

    const elicitation = await waitFor(() =>
      serverRequests.find((event) => event.method === "item/tool/requestUserInput")
    );
    expect(elicitation).toBeDefined();

    await backend.resolveServerRequest({
      threadId,
      threadHandle,
      requestId: elicitation.requestId,
      response: { result: { confirmed: true } },
    });
    const tokenUsageEvent = await waitFor(
      () =>
        notifications.find((event) => event.method === "thread/tokenUsage/updated") as
          | {
              params?: {
                tokenUsage?: { modelContextWindow: number | null; last?: { totalTokens?: number } };
              };
            }
          | undefined
    );

    expect(notifications.some((event) => event.method === "item/agentMessage/delta")).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/started" &&
          (event.params as { item?: { type?: string } }).item?.type === "userMessage"
      )
    ).toBe(false);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/completed" &&
          (event.params as { item?: { type?: string } }).item?.type === "userMessage"
      )
    ).toBe(false);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/started" &&
          (event.params as { item?: { type?: string } }).item?.type === "commandExecution"
      )
    ).toBe(true);
    expect(
      notifications.some((event) => event.method === "item/commandExecution/outputDelta")
    ).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "item/completed" &&
          (event.params as { item?: { type?: string } }).item?.type === "commandExecution"
      )
    ).toBe(true);
    expect(
      notifications.some(
        (event) =>
          event.method === "turn/completed" &&
          (event.params as { turn?: { status?: string } }).turn?.status === "completed"
      )
    ).toBe(true);
    expect(
      (
        tokenUsageEvent.params as {
          tokenUsage: { modelContextWindow: number | null; last: { totalTokens: number } };
        }
      ).tokenUsage
    ).toMatchObject({
      modelContextWindow: 272000,
      last: {
        totalTokens: 12,
      },
    });

    const history = await backend.readSessionHistory(threadHandle);
    expect(history.some((message) => message.role === "user")).toBe(true);
    expect(history.some((message) => message.role === "assistant")).toBe(true);
    expect(history).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        content: expect.objectContaining({
          toolCallId: "tool-1",
          toolName: "bash",
          isError: false,
          content: [{ type: "text", text: "hi" }],
        }),
      })
    );
    expect(history.some((message) => message.role === "system")).toBe(true);
    const threadRead = await backend.threadRead({
      threadId,
      threadHandle,
      includeTurns: true,
      cwd: sessionDir,
    });
    expect(threadRead.threadHandle).toBe(threadHandle);
    expect(threadRead.turns[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "userMessage",
          content: [{ type: "text", text: "hello world" }],
        }),
        expect.objectContaining({
          type: "commandExecution",
          command: "echo hi",
          status: "completed",
          aggregatedOutput: "hi",
          exitCode: 0,
        }),
        expect.objectContaining({
          type: "agentMessage",
          text: "response-1",
        }),
      ])
    );
    expect(
      threadRead.turns[0]?.items.filter(
        (item) =>
          item.type === "agentMessage" &&
          typeof item.text === "string" &&
          (item.text.includes('"toolCallId"') || item.text.includes('"type":"toolCall"'))
      )
    ).toEqual([]);

    const forked = await backend.threadFork({
      threadId: "thread-pi-fork",
      sourceThreadId: threadId,
      sourceThreadHandle: threadHandle,
      cwd: sessionDir,
      model: null,
      reasoningEffort: null,
    });
    expect(forked.threadHandle).not.toBe(threadHandle);
    const forkedHistory = await backend.readSessionHistory(forked.threadHandle);
    expect(forkedHistory).toEqual(expect.any(Array));

    subscription.dispose();
    const eventCount = notifications.length + serverRequests.length;
    await backend.turnStart({
      threadId,
      threadHandle,
      turnId: "turn_2",
      cwd: sessionDir,
      input: [{ type: "text", text: "follow-up prompt", text_elements: [] }],
      model: null,
      reasoningEffort: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(notifications.length + serverRequests.length).toBe(eventCount);

    await backend.threadArchive({
      threadId,
      threadHandle,
    });
    await backend.dispose();

    const logRecords = (await readFile(logFilePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; raw: string });
    expect(
      logRecords.some((record) => record.kind === "stdin" && record.raw.includes('"type":"prompt"'))
    ).toBe(true);
    const setModelLines = logRecords.filter(
      (record) => record.kind === "stdin" && record.raw.includes('"type":"set_model"')
    );
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes(`"provider":"${selectedModel.id.split("/")[0]}"`) &&
          record.raw.includes(`"modelId":"${selectedModel.id.split("/").slice(1).join("/")}"`)
      )
    ).toBe(true);
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes('"provider":"pi"') && record.raw.includes('"modelId":"mock-fast"')
      )
    ).toBe(true);
    expect(
      setModelLines.some(
        (record) =>
          record.raw.includes('"provider":"openai-codex"') &&
          record.raw.includes('"modelId":"gpt-5.3-codex"')
      )
    ).toBe(true);
    expect(
      logRecords.some(
        (record) => record.kind === "stdout" && record.raw.includes('"type":"message_update"')
      )
    ).toBe(true);
    expect(
      logRecords.some(
        (record) =>
          record.kind === "parsed-event" &&
          record.raw.includes('"assistantMessageEvent":{"type":"text_delta"')
      )
    ).toBe(true);
    expect(logRecords.some((record) => record.kind === "startup")).toBe(true);
    expect(logRecords.some((record) => record.kind === "shutdown")).toBe(true);

    const reopened = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
    });
    await reopened.initialize();
    await expect(
      reopened.threadResume({
        threadId,
        threadHandle,
        cwd: sessionDir,
        model: null,
        reasoningEffort: null,
      })
    ).resolves.toMatchObject({
      threadHandle,
    });
    const resumedHistory = await reopened.readSessionHistory(threadHandle);
    expect(resumedHistory).toEqual(expect.any(Array));
    await reopened.dispose();
  });

  it("passes collab launch config and extension path to child processes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "codapter-backend-pi-collab-"));
    const sessionDir = join(rootDir, "sessions");
    const capturePath = join(rootDir, "launch.json");
    const extensionPath = join(rootDir, "collab-extension.js");
    await mkdir(sessionDir, { recursive: true });
    const scriptPath = await createMockPiScript(rootDir);

    const backend = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
      env: {
        ...process.env,
        CODAPTER_CAPTURE_PROCESS_PATH: capturePath,
      },
      collabExtensionPath: extensionPath,
    });

    await backend.initialize();

    try {
      await backend.createSession({
        threadId: "thread-parent-123",
        collabSocketPath: "/tmp/codapter-collab-test.sock",
        availableModelsDescription:
          "Available models (use the model id exactly as shown):\n- pi::anthropic/claude-opus-4-6: medium\n- gpt-5.4: medium",
      });
    } finally {
      await backend.dispose();
    }

    const launch = JSON.parse(await readFile(capturePath, "utf8")) as {
      argv: string[];
      collabSocketPath: string | null;
      parentThreadId: string | null;
      availableModelsDescription: string | null;
    };
    expect(launch.collabSocketPath).toBe("/tmp/codapter-collab-test.sock");
    expect(launch.parentThreadId).toBe("thread-parent-123");
    expect(launch.availableModelsDescription).toContain("pi::anthropic/claude-opus-4-6");
    expect(launch.availableModelsDescription).toContain("gpt-5.4");
    expect(launch.argv).toContain("--extension");
    expect(launch.argv).toContain(extensionPath);
  });
});
