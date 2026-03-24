import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexBackend } from "../../packages/backend-codex/src/index.js";
import { createPiBackend } from "../../packages/backend-pi/src/index.js";
import { AppServerConnection } from "../../packages/core/src/app-server.js";
import { BackendRouter } from "../../packages/core/src/backend-router.js";
import { ThreadRegistry } from "../../packages/core/src/thread-registry.js";

type NotificationMessage = { method: string; params?: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function initConnection(
  backendRouter: BackendRouter,
  threadRegistry: ThreadRegistry,
  notifications: NotificationMessage[]
): Promise<AppServerConnection> {
  const connection = new AppServerConnection({
    backendRouter,
    threadRegistry,
    onMessage(message) {
      if ("method" in message) {
        notifications.push(message as NotificationMessage);
      }
    },
  });
  await connection.handleMessage({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "codapter-client-payloads", title: null, version: "0.0.1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  });
  return connection;
}

async function createMockPiTranscriptScript(
  rootDir: string
): Promise<{ scriptPath: string; sessionDir: string }> {
  const sessionDir = join(rootDir, "pi-sessions");
  await mkdir(sessionDir, { recursive: true });
  const scriptPath = join(rootDir, "mock-pi-transcript.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    "import { join } from 'node:path';",
    "",
    "const decoder = new StringDecoder('utf8');",
    "const sessionDir = process.argv[2] ?? process.cwd();",
    "let buffer = '';",
    "let promptCounter = 0;",
    "const sessionFile = join(sessionDir, 'pi-session.jsonl');",
    "const availableModels = [",
    "  { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, input: ['text'], contextWindow: 200000 },",
    "];",
    "const state = { model: availableModels[0], history: [], sessionId: 'pi-session', sessionFile };",
    "",
    "function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "function response(id, command, data) { write({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) }); }",
    "",
    "function emitPrompt(message) {",
    "  promptCounter += 1;",
    "  const suffix = String(promptCounter);",
    "  const userMessage = { id: 'user-' + suffix, role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() };",
    "  const toolCallMessage = { id: 'assistant-tool-' + suffix, role: 'assistant', content: [{ type: 'toolCall', id: 'tool-' + suffix, name: 'bash', arguments: { command: 'pwd' } }], stopReason: 'toolUse', timestamp: Date.now() };",
    "  const toolResultMessage = { id: 'tool-result-' + suffix, role: 'toolResult', toolCallId: 'tool-' + suffix, toolName: 'bash', content: [{ type: 'text', text: '/Users/kcassidy/codapter\\n' }], isError: false, timestamp: Date.now() };",
    "  const assistantMessage = { id: 'assistant-' + suffix, role: 'assistant', content: [{ type: 'text', text: 'The working directory is /Users/kcassidy/codapter.' }], stopReason: 'stop', timestamp: Date.now() };",
    "  state.history.push(userMessage, toolCallMessage, toolResultMessage, assistantMessage);",
    "  setTimeout(() => {",
    "    write({ type: 'turn_start' });",
    "    write({ type: 'message_start', message: userMessage });",
    "    write({ type: 'message_end', message: userMessage });",
    "    write({ type: 'message_start', message: toolCallMessage });",
    "    write({ type: 'message_end', message: toolCallMessage });",
    "    write({ type: 'tool_execution_start', toolCallId: 'tool-' + suffix, toolName: 'bash', args: { command: 'pwd' } });",
    "    write({ type: 'tool_execution_end', toolCallId: 'tool-' + suffix, toolName: 'bash', result: { content: [{ type: 'text', text: '/Users/kcassidy/codapter\\n' }], details: { exitCode: 0 } }, isError: false });",
    "    write({ type: 'message_start', message: toolResultMessage });",
    "    write({ type: 'message_end', message: toolResultMessage });",
    "    write({ type: 'turn_end', message: toolCallMessage, toolResults: [toolResultMessage] });",
    "    write({ type: 'turn_start' });",
    "    write({ type: 'message_start', message: assistantMessage });",
    "    write({ type: 'message_update', message: assistantMessage, assistantMessageEvent: { type: 'text_delta', delta: 'The working directory is /Users/kcassidy/codapter.' } });",
    "    write({ type: 'message_end', message: assistantMessage });",
    "    write({ type: 'turn_end', message: assistantMessage, toolResults: [] });",
    "  }, 10);",
    "}",
    "",
    "function handle(payload) {",
    "  if (payload.type === 'get_state') { response(payload.id, 'get_state', { sessionId: state.sessionId, sessionFile: state.sessionFile, model: state.model }); return; }",
    "  if (payload.type === 'new_session') { response(payload.id, 'new_session', { cancelled: false }); return; }",
    "  if (payload.type === 'switch_session') { response(payload.id, 'switch_session', { cancelled: false }); return; }",
    "  if (payload.type === 'set_model') { response(payload.id, 'set_model', { model: state.model }); return; }",
    "  if (payload.type === 'get_available_models') { response(payload.id, 'get_available_models', { models: availableModels }); return; }",
    "  if (payload.type === 'get_messages') { response(payload.id, 'get_messages', { messages: state.history }); return; }",
    "  if (payload.type === 'get_session_stats') { response(payload.id, 'get_session_stats', { sessionId: state.sessionId, sessionFile: state.sessionFile, userMessages: 1, assistantMessages: 2, toolCalls: 1, toolResults: 1, totalMessages: state.history.length, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }); return; }",
    "  if (payload.type === 'prompt') { response(payload.id, 'prompt'); emitPrompt(payload.message); return; }",
    "  if (payload.type === 'abort') { response(payload.id, 'abort'); return; }",
    "  if (payload.type === 'extension_ui_response') { response(payload.id, 'extension_ui_response'); return; }",
    "}",
    "",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += decoder.write(chunk);",
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() ?? '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    handle(JSON.parse(line));",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return { scriptPath, sessionDir };
}

async function createMockPiActiveResumeScript(
  rootDir: string
): Promise<{ scriptPath: string; sessionDir: string }> {
  const sessionDir = join(rootDir, "pi-active-sessions");
  await mkdir(sessionDir, { recursive: true });
  const scriptPath = join(rootDir, "mock-pi-active-resume.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    "import { join } from 'node:path';",
    "",
    "const decoder = new StringDecoder('utf8');",
    "const sessionDir = process.argv[2] ?? process.cwd();",
    "let buffer = '';",
    "let promptCounter = 0;",
    "const sessionFile = join(sessionDir, 'pi-active-session.jsonl');",
    "const availableModels = [",
    "  { provider: 'anthropic', id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, input: ['text'], contextWindow: 200000 },",
    "];",
    "const state = { model: availableModels[0], history: [], sessionId: 'pi-active-session', sessionFile };",
    "",
    "function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "function response(id, command, data) { write({ id, type: 'response', command, success: true, ...(data === undefined ? {} : { data }) }); }",
    "",
    "function emitPrompt(message) {",
    "  promptCounter += 1;",
    "  const suffix = String(promptCounter);",
    "  const userMessage = { id: 'user-' + suffix, role: 'user', content: [{ type: 'text', text: message }], timestamp: Date.now() };",
    "  state.history.push(userMessage);",
    "}",
    "",
    "function handle(payload) {",
    "  if (payload.type === 'get_state') { response(payload.id, 'get_state', { sessionId: state.sessionId, sessionFile: state.sessionFile, model: state.model }); return; }",
    "  if (payload.type === 'new_session') { response(payload.id, 'new_session', { cancelled: false }); return; }",
    "  if (payload.type === 'switch_session') { response(payload.id, 'switch_session', { cancelled: false }); return; }",
    "  if (payload.type === 'set_model') { response(payload.id, 'set_model', { model: state.model }); return; }",
    "  if (payload.type === 'get_available_models') { response(payload.id, 'get_available_models', { models: availableModels }); return; }",
    "  if (payload.type === 'get_messages') { response(payload.id, 'get_messages', { messages: state.history }); return; }",
    "  if (payload.type === 'get_session_stats') { response(payload.id, 'get_session_stats', { sessionId: state.sessionId, sessionFile: state.sessionFile, userMessages: state.history.length, assistantMessages: 0, toolCalls: 0, toolResults: 0, totalMessages: state.history.length, tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 }, cost: 0 }); return; }",
    "  if (payload.type === 'prompt') { response(payload.id, 'prompt'); emitPrompt(payload.message); return; }",
    "  if (payload.type === 'abort') { response(payload.id, 'abort'); return; }",
    "  if (payload.type === 'extension_ui_response') { response(payload.id, 'extension_ui_response'); return; }",
    "}",
    "",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += decoder.write(chunk);",
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() ?? '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    handle(JSON.parse(line));",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return { scriptPath, sessionDir };
}

async function createMockCodexSubagentScript(rootDir: string): Promise<string> {
  const sessionPath = join(rootDir, "codex-parent.jsonl");
  await writeFile(
    sessionPath,
    `${JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_spawn_1",
        output: JSON.stringify({
          agent_id: "child_backend",
          nickname: "Averroes",
        }),
      },
    })}\n`,
    "utf8"
  );
  const scriptPath = join(rootDir, "mock-codex-subagent.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    `const sessionPath = ${JSON.stringify(sessionPath)};`,
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "",
    "function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "function response(id, result) { write({ id, result }); }",
    "",
    "function handle(payload) {",
    "  if (payload.method === 'initialize') {",
    "    response(payload.id, { userAgent: 'mock-codex', platformFamily: 'unix', platformOs: 'macos' });",
    "    return;",
    "  }",
    "  if (payload.method === 'model/list') {",
    "    response(payload.id, { data: [{ id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: 'Codex smoke model', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', supportsPersonality: true }] });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/start') {",
    "    response(payload.id, { thread: { id: 'parent_backend', path: sessionPath, turns: [] }, model: payload.params.model ?? 'gpt-5.4-mini', reasoningEffort: 'medium' });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/read') {",
    "    response(payload.id, { thread: { id: payload.params.threadId, path: sessionPath, turns: [], model: 'gpt-5.4-mini' }, reasoningEffort: 'medium' });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/start') {",
    "    response(payload.id, { turn: { id: 'turn_backend', items: [], status: 'inProgress', error: null } });",
    "    setTimeout(() => {",
    "      write({ method: 'turn/started', params: { threadId: payload.params.threadId, turnId: 'turn_backend', turn: { id: 'turn_backend', items: [], status: 'inProgress', error: null } } });",
    "      write({ method: 'item/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', item: { type: 'collabAgentToolCall', id: 'call_spawn_1', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent_backend', receiverThreadIds: ['child_backend'], prompt: 'Run `date` and report back.', model: payload.params.model ?? 'gpt-5.4-mini', reasoningEffort: 'medium', agentsStates: { child_backend: { status: 'pendingInit', message: null } } } } });",
    "      write({ method: 'item/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', item: { type: 'collabAgentToolCall', id: 'call_wait_1', tool: 'wait', status: 'completed', senderThreadId: 'parent_backend', receiverThreadIds: ['child_backend'], prompt: null, model: null, reasoningEffort: null, agentsStates: { child_backend: { status: 'completed', message: 'Done' } } } } });",
    "      write({ method: 'turn/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', turn: { id: 'turn_backend', items: [], status: 'completed', error: null } } });",
    "    }, 10);",
    "    return;",
    "  }",
    "}",
    "",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += decoder.write(chunk);",
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() ?? '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    const parsed = JSON.parse(line);",
    "    if ('method' in parsed) { handle(parsed); }",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function createMockCodexSubagentReadBackfillScript(rootDir: string): Promise<string> {
  const parentSessionPath = join(rootDir, "codex-parent-no-nickname.jsonl");
  const childSessionPath = join(rootDir, "codex-child-backfill.jsonl");
  await writeFile(parentSessionPath, "", "utf8");
  await writeFile(
    childSessionPath,
    `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: "child_backend",
        agent_nickname: "Euler",
        agent_role: "default",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "parent_backend",
              depth: 1,
              agent_nickname: "Euler",
              agent_role: "default",
            },
          },
        },
      },
    })}\n`,
    "utf8"
  );
  const scriptPath = join(rootDir, "mock-codex-subagent-read-backfill.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    `const parentSessionPath = ${JSON.stringify(parentSessionPath)};`,
    `const childSessionPath = ${JSON.stringify(childSessionPath)};`,
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "",
    "function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "function response(id, result) { write({ id, result }); }",
    "",
    "function handle(payload) {",
    "  if (payload.method === 'initialize') {",
    "    response(payload.id, { userAgent: 'mock-codex', platformFamily: 'unix', platformOs: 'macos' });",
    "    return;",
    "  }",
    "  if (payload.method === 'model/list') {",
    "    response(payload.id, { data: [{ id: 'gpt-5.4-mini', model: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: 'Codex smoke model', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', supportsPersonality: true }] });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/start') {",
    "    response(payload.id, { thread: { id: 'parent_backend', path: parentSessionPath, turns: [] }, model: payload.params.model ?? 'gpt-5.4-mini', reasoningEffort: 'medium' });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/read') {",
    "    if (payload.params.threadId === 'child_backend') {",
    "      response(payload.id, { thread: { id: 'child_backend', path: childSessionPath, cwd: '/Users/kcassidy/codapter', turns: [], model: 'gpt-5.4-mini' }, reasoningEffort: 'medium' });",
    "      return;",
    "    }",
    "    response(payload.id, { thread: { id: payload.params.threadId, path: parentSessionPath, turns: [], model: 'gpt-5.4-mini' }, reasoningEffort: 'medium' });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/start') {",
    "    response(payload.id, { turn: { id: 'turn_backend', items: [], status: 'inProgress', error: null } });",
    "    setTimeout(() => {",
    "      write({ method: 'turn/started', params: { threadId: payload.params.threadId, turnId: 'turn_backend', turn: { id: 'turn_backend', items: [], status: 'inProgress', error: null } } });",
    "      write({ method: 'item/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', item: { type: 'collabAgentToolCall', id: 'call_spawn_1', tool: 'spawnAgent', status: 'completed', senderThreadId: 'parent_backend', receiverThreadIds: ['child_backend'], prompt: 'Run `date` and report back.', model: payload.params.model ?? 'gpt-5.4-mini', reasoningEffort: 'medium', agentsStates: { child_backend: { status: 'pendingInit', message: null } } } } });",
    "      write({ method: 'item/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', item: { type: 'collabAgentToolCall', id: 'call_wait_1', tool: 'wait', status: 'completed', senderThreadId: 'parent_backend', receiverThreadIds: ['child_backend'], prompt: null, model: null, reasoningEffort: null, agentsStates: { child_backend: { status: 'completed', message: 'Done' } } } } });",
    "      write({ method: 'turn/completed', params: { threadId: payload.params.threadId, turnId: 'turn_backend', turn: { id: 'turn_backend', items: [], status: 'completed', error: null } } });",
    "    }, 10);",
    "    return;",
    "  }",
    "}",
    "",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += decoder.write(chunk);",
    "  const lines = buffer.split('\\n');",
    "  buffer = lines.pop() ?? '';",
    "  for (const line of lines) {",
    "    if (!line.trim()) continue;",
    "    const parsed = JSON.parse(line);",
    "    if ('method' in parsed) { handle(parsed); }",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

describe("client payload smoke", () => {
  it("normalizes Pi command turns into structured client items without raw tool JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-client-pi-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const { scriptPath, sessionDir } = await createMockPiTranscriptScript(directory);
    const backend = createPiBackend({
      command: "node",
      args: [scriptPath, sessionDir],
      sessionDir,
    });
    await backend.initialize();
    const connection = await initConnection(
      new BackendRouter([backend]),
      threadRegistry,
      notifications
    );

    try {
      const started = (await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/Users/kcassidy/codapter",
          modelProvider: "pi",
          model: "pi::anthropic/claude-opus-4-6",
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "Run pwd", text_elements: [] }],
        },
      });

      await waitFor(() =>
        notifications.some(
          (entry) =>
            entry.method === "item/completed" &&
            isRecord(entry.params?.item) &&
            entry.params.item.type === "commandExecution"
        )
      );
      await waitFor(() => notifications.some((entry) => entry.method === "turn/completed"));

      const command = notifications.findLast(
        (entry) =>
          entry.method === "item/completed" &&
          isRecord(entry.params?.item) &&
          entry.params.item.type === "commandExecution"
      );
      expect(command?.params?.item).toMatchObject({
        type: "commandExecution",
        command: "pwd",
      });

      const resumed = (await connection.handleMessage({
        id: 4,
        method: "thread/resume",
        params: {
          threadId: started.result.thread.id,
          persistExtendedHistory: false,
        },
      })) as {
        result: {
          thread: {
            turns: Array<{ items: Array<{ type: string; text?: string }> }>;
          };
        };
      };

      const resumedTurn = resumed.result.thread.turns[0];
      expect(resumedTurn.items.map((item) => item.type)).toEqual([
        "userMessage",
        "commandExecution",
        "agentMessage",
      ]);
      const resumedAgentMessages = resumedTurn.items
        .filter((item) => item.type === "agentMessage")
        .map((item) => item.text ?? "");
      expect(resumedAgentMessages.join("\n")).toContain(
        "The working directory is /Users/kcassidy/codapter."
      );
      expect(JSON.stringify(resumedTurn)).not.toContain('"role":"toolResult"');
      expect(JSON.stringify(resumedTurn)).not.toContain('"type":"toolCall"');
    } finally {
      await connection.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("dedupes the visible child prompt when Pi thread resume happens mid-turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-client-pi-active-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const { scriptPath, sessionDir } = await createMockPiActiveResumeScript(directory);
    const backend = createPiBackend({
      command: "node",
      args: [scriptPath, sessionDir],
      sessionDir,
    });
    await backend.initialize();
    const connection = await initConnection(
      new BackendRouter([backend]),
      threadRegistry,
      notifications
    );

    try {
      const started = (await connection.handleMessage({
        id: 20,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/Users/kcassidy/codapter",
          modelProvider: "pi",
          model: "pi::anthropic/claude-opus-4-6",
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 21,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [
            {
              type: "text",
              text: "Run the `date` command and report the output.",
              text_elements: [],
            },
          ],
        },
      });

      const resumed = (await connection.handleMessage({
        id: 22,
        method: "thread/resume",
        params: {
          threadId: started.result.thread.id,
          persistExtendedHistory: false,
        },
      })) as {
        result: {
          thread: {
            turns: Array<{
              status: string;
              items: Array<{ type: string; content?: unknown }>;
            }>;
          };
        };
      };

      expect(resumed.result.thread.turns).toHaveLength(1);
      expect(resumed.result.thread.turns[0]?.status).toBe("inProgress");
      const resumedUserMessages = resumed.result.thread.turns[0]?.items.filter(
        (item) =>
          item.type === "userMessage" &&
          JSON.stringify(item.content) ===
            JSON.stringify([
              { type: "text", text: "Run the `date` command and report the output." },
            ])
      );
      expect(resumedUserMessages).toHaveLength(1);
    } finally {
      await connection.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rewrites native Codex sub-agent payloads to local thread ids and raw model ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-client-codex-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const scriptPath = await createMockCodexSubagentScript(directory);
    const backend = createCodexBackend({ command: "node", args: [scriptPath] });
    await backend.initialize();
    const connection = await initConnection(
      new BackendRouter([backend]),
      threadRegistry,
      notifications
    );

    try {
      const started = (await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/Users/kcassidy/codapter",
          modelProvider: "codex",
          model: "gpt-5.4-mini",
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "spawn a child", text_elements: [] }],
          model: "gpt-5.4-mini",
        },
      });

      await waitFor(() =>
        notifications.some(
          (entry) =>
            entry.method === "item/completed" &&
            isRecord(entry.params?.item) &&
            entry.params.item.type === "collabAgentToolCall"
        )
      );

      await waitFor(() =>
        notifications.some(
          (entry) =>
            entry.method === "thread/started" &&
            isRecord(entry.params?.thread) &&
            isRecord(entry.params.thread.source) &&
            "subAgent" in entry.params.thread.source
        )
      );

      const childStarted = notifications.find(
        (entry) =>
          entry.method === "thread/started" &&
          isRecord(entry.params?.thread) &&
          isRecord(entry.params.thread.source) &&
          "subAgent" in entry.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBe("Averroes");

      const completed = notifications.find(
        (entry) =>
          entry.method === "item/completed" &&
          isRecord(entry.params?.item) &&
          entry.params.item.type === "collabAgentToolCall"
      );
      expect(completed?.params?.item).toMatchObject({
        type: "collabAgentToolCall",
        model: "gpt-5.4-mini",
        receiverThreadIds: [childThreadId],
        agentsStates: {
          [childThreadId]: {
            status: "pendingInit",
            message: null,
          },
        },
      });
      expect(JSON.stringify(completed)).not.toContain("codex::");

      const waitCompleted = notifications.findLast(
        (entry) =>
          entry.method === "item/completed" &&
          isRecord(entry.params?.item) &&
          entry.params.item.type === "collabAgentToolCall" &&
          entry.params.item.tool === "wait"
      );
      expect(waitCompleted?.params?.item).toMatchObject({
        type: "collabAgentToolCall",
        senderThreadId: started.result.thread.id,
        receiverThreadIds: [childThreadId],
        agentsStates: {
          [childThreadId]: {
            status: "completed",
            message: "Done",
          },
        },
      });

      await expect(
        connection.handleMessage({
          id: 4,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 4,
        result: {
          thread: {
            id: childThreadId,
            agentNickname: "Averroes",
            modelProvider: "codex",
          },
        },
      });
    } finally {
      await connection.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("backfills routed Codex child nickname from thread/read when spawn output had no nickname", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-client-codex-read-backfill-"));
    const threadRegistry = new ThreadRegistry(join(directory, "threads.json"));
    const notifications: NotificationMessage[] = [];
    const scriptPath = await createMockCodexSubagentReadBackfillScript(directory);
    const backend = createCodexBackend({ command: "node", args: [scriptPath] });
    await backend.initialize();
    const connection = await initConnection(
      new BackendRouter([backend]),
      threadRegistry,
      notifications
    );

    try {
      const started = (await connection.handleMessage({
        id: 10,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/Users/kcassidy/codapter",
          modelProvider: "codex",
          model: "gpt-5.4-mini",
        },
      })) as { result: { thread: { id: string } } };

      await connection.handleMessage({
        id: 11,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "spawn a child", text_elements: [] }],
          model: "gpt-5.4-mini",
        },
      });

      await waitFor(() =>
        notifications.some(
          (entry) =>
            entry.method === "thread/started" &&
            isRecord(entry.params?.thread) &&
            isRecord(entry.params.thread.source) &&
            "subAgent" in entry.params.thread.source
        )
      );

      const childStarted = notifications.find(
        (entry) =>
          entry.method === "thread/started" &&
          isRecord(entry.params?.thread) &&
          isRecord(entry.params.thread.source) &&
          "subAgent" in entry.params.thread.source
      ) as { params: { thread: { id: string; agentNickname: string | null } } } | undefined;
      const childThreadId = childStarted?.params.thread.id ?? "";
      expect(childThreadId).toBeTruthy();
      expect(childStarted?.params.thread.agentNickname).toBeNull();

      await expect(
        connection.handleMessage({
          id: 12,
          method: "thread/read",
          params: {
            threadId: childThreadId,
            includeTurns: false,
          },
        })
      ).resolves.toMatchObject({
        id: 12,
        result: {
          thread: {
            id: childThreadId,
            path: expect.stringContaining("codex-child-backfill.jsonl"),
            agentNickname: "Euler",
            agentRole: "default",
            name: null,
            modelProvider: "codex",
          },
        },
      });
    } finally {
      await connection.dispose();
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
