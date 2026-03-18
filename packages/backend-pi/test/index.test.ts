import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiBackend, createPiBackend } from "../src/index.js";

async function createMockPiScript(rootDir: string): Promise<string> {
  const scriptPath = join(rootDir, "mock-pi-rpc.mjs");
  const script = [
    "import { randomUUID } from 'node:crypto';",
    "import { StringDecoder } from 'node:string_decoder';",
    "import { join } from 'node:path';",
    "",
    "const sessionDir = process.argv[2] ?? process.cwd();",
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "let promptCounter = 0;",
    "",
    "const state = {",
    "  sessionId: 'mock-session',",
    "  sessionFile: undefined,",
    "  sessionName: undefined,",
    "  model: { provider: 'pi', id: 'mock-default', name: 'Mock Default', reasoning: true, input: ['text', 'image'] },",
    "  history: [],",
    "  lastElicitationResponse: undefined,",
    "  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },",
    "};",
    "",
    "const availableModels = [",
    "  { provider: 'pi', id: 'mock-default', name: 'Mock Default', reasoning: true, input: ['text', 'image'] },",
    "  { provider: 'pi', id: 'mock-fast', name: 'Mock Fast', reasoning: false, input: ['text'] },",
    "  { provider: 'openai-codex', id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true, input: ['text', 'image'] },",
    "];",
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
    "  const assistantMessage = {",
    "    id: 'assistant-' + turnId,",
    "    role: 'assistant',",
    "    content: [{ type: 'text', text: 'response-' + turnId }],",
    "    timestamp: Date.now(),",
    "  };",
    "",
    "  state.history.push({",
    "    id: 'user-' + turnId,",
    "    role: 'user',",
    "    content: { text: message },",
    "    timestamp: Date.now(),",
    "  });",
    "",
    "  setTimeout(() => {",
    "    write({ type: 'turn_start' });",
    "    write({",
    "      type: 'message_update',",
    "      message: assistantMessage,",
    "      assistantMessageEvent: { type: 'text_delta', delta: 'hello from pi' },",
    "    });",
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
    "    write({ type: 'message_end', message: assistantMessage });",
    "    write({ type: 'turn_end', message: assistantMessage, toolResults: [] });",
    "    state.history.push(assistantMessage);",
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
      env: {
        ...process.env,
        CODAPTER_PI_LOG_FILE: logFilePath,
      },
    });

    await backend.initialize();

    const models = await backend.listModels();
    expect(models).toHaveLength(3);
    expect(models[0]?.isDefault).toBe(true);
    expect(models[0]?.id).toBe("pi/mock-default");

    const capabilities = await backend.getCapabilities();
    expect(capabilities).toEqual({
      requiresAuth: false,
      supportsImages: true,
      supportsThinking: true,
      supportsParallelTools: true,
      supportedToolTypes: [],
    });

    const sessionId = await backend.createSession();
    expect(sessionId.startsWith("pi_session_")).toBe(true);

    const events: Array<{ type: string; requestId?: string }> = [];
    const subscription = backend.onEvent(sessionId, (event) => {
      events.push(event);
    });

    const selectedModel = models.at(1);
    if (!selectedModel) {
      throw new Error("Expected a second mock model");
    }

    await backend.setSessionName(sessionId, "Primary session");
    await backend.setModel(sessionId, selectedModel.id);
    await backend.setModel(sessionId, "gpt-5.3-codex");
    await backend.prompt(sessionId, "turn_1", "hello world", [
      {
        type: "image",
        data: Buffer.from("image payload").toString("base64"),
        mimeType: "image/png",
      },
    ]);

    const elicitation = await waitFor(
      () =>
        events.find((event) => event.type === "elicitation_request") as
          | { requestId: string }
          | undefined
    );
    expect(elicitation).toBeDefined();

    await backend.respondToElicitation(sessionId, elicitation.requestId, { confirmed: true });
    await waitFor(() => events.find((event) => event.type === "token_usage"));

    expect(events.some((event) => event.type === "text_delta")).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_update")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(events.some((event) => event.type === "message_end")).toBe(true);

    const history = await backend.readSessionHistory(sessionId);
    expect(history.some((message) => message.role === "user")).toBe(true);
    expect(history.some((message) => message.role === "assistant")).toBe(true);
    expect(history.some((message) => message.role === "system")).toBe(true);

    const forkedSessionId = await backend.forkSession(sessionId);
    expect(forkedSessionId).not.toBe(sessionId);
    const forkedHistory = await backend.readSessionHistory(forkedSessionId);
    expect(forkedHistory).toEqual(expect.any(Array));

    subscription.dispose();
    const eventCount = events.length;
    await backend.prompt(sessionId, "turn_2", "follow-up prompt");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events.length).toBe(eventCount);

    await backend.disposeSession(sessionId);
    await backend.dispose();

    const logRecords = (await readFile(logFilePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; raw: string });
    expect(
      logRecords.some((record) => record.kind === "stdin" && record.raw.includes('"type":"prompt"'))
    ).toBe(true);
    expect(
      logRecords.some(
        (record) => record.kind === "stdout" && record.raw.includes('"type":"message_update"')
      )
    ).toBe(true);

    const reopened = createPiBackend({
      sessionDir,
      command: process.execPath,
      args: [scriptPath, sessionDir],
    });
    await reopened.initialize();
    await expect(reopened.resumeSession(sessionId)).resolves.toBe(sessionId);
    const resumedHistory = await reopened.readSessionHistory(sessionId);
    expect(resumedHistory).toEqual(expect.any(Array));
    await reopened.dispose();
  });
});
