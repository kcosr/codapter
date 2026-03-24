import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createCodexBackend } from "../src/index.js";

async function createMockCodexScript(
  rootDir: string
): Promise<{ scriptPath: string; requestsPath: string }> {
  const scriptPath = join(rootDir, "mock-codex-app-server.mjs");
  const requestsPath = join(rootDir, "requests.jsonl");
  const script = [
    "import { appendFileSync } from 'node:fs';",
    "import { StringDecoder } from 'node:string_decoder';",
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    `const requestsPath = ${JSON.stringify(requestsPath)};`,
    "",
    "function write(value) {",
    "  process.stdout.write(JSON.stringify(value) + '\\n');",
    "}",
    "",
    "function record(payload) {",
    "  appendFileSync(requestsPath, JSON.stringify(payload) + '\\n');",
    "}",
    "",
    "function handleMessage(payload) {",
    "  record(payload);",
    "  if (payload.method === 'initialize') {",
    "    write({ id: payload.id, result: { userAgent: 'mock-codex', platformFamily: 'unix', platformOs: 'linux' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'model/list') {",
    "    write({ id: payload.id, result: { data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', description: 'mock', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', supportsPersonality: true }] } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/start') {",
    "    write({ id: payload.id, result: { thread: { id: 'thr_mock', path: '/tmp/thr_mock.jsonl', turns: [] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/resume') {",
    "    write({ id: payload.id, result: { thread: { id: payload.params.threadId, path: '/tmp/' + payload.params.threadId + '.jsonl', turns: [] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/fork') {",
    "    const forkId = payload.params.threadId + '_fork';",
    "    write({ id: payload.id, result: { thread: { id: forkId, path: '/tmp/' + forkId + '.jsonl', turns: [] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/read') {",
    "    write({ id: payload.id, result: { thread: { id: payload.params.threadId, path: '/tmp/' + payload.params.threadId + '.jsonl', turns: [{ id: 'turn_hist_1', items: [{ type: 'agentMessage', id: 'msg_hist_1', text: 'history', phase: null }], status: 'completed', error: null }] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/archive' || payload.method === 'thread/name/set') {",
    "    write({ id: payload.id, result: {} });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/interrupt') {",
    "    write({ id: payload.id, result: {} });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/start') {",
    "    write({ id: payload.id, result: { turn: { id: 'turn_1', items: [], status: 'inProgress', error: null } } });",
    "    setTimeout(() => {",
    "      write({ method: 'turn/started', params: { threadId: payload.params.threadId, turn: { id: 'turn_1', items: [], status: 'inProgress', error: null } } });",
    "      write({ id: 'srv_1', method: 'item/tool/requestUserInput', params: { threadId: payload.params.threadId, turnId: 'turn_1', itemId: 'item_1', questions: [{ id: 'answer', header: 'Answer', question: 'Continue?', isOther: false, isSecret: false, options: [{ label: 'Yes', description: 'continue' }] }] } });",
    "      write({ method: 'item/agentMessage/delta', params: { threadId: payload.params.threadId, turnId: 'turn_1', itemId: 'msg_1', delta: 'done' } });",
    "      write({ method: 'turn/completed', params: { threadId: payload.params.threadId, turn: { id: 'turn_1', items: [], status: 'completed', error: null } } });",
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
    "    if ('method' in parsed) {",
    "      handleMessage(parsed);",
    "    }",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return { scriptPath, requestsPath };
}

async function createExitOnTurnStartScript(rootDir: string): Promise<string> {
  const scriptPath = join(rootDir, "mock-codex-exit-on-turn.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "",
    "function write(value) {",
    "  process.stdout.write(JSON.stringify(value) + '\\n');",
    "}",
    "",
    "function handleMessage(payload) {",
    "  if (payload.method === 'initialize') {",
    "    write({ id: payload.id, result: { userAgent: 'mock-codex', platformFamily: 'unix', platformOs: 'linux' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'model/list') {",
    "    write({ id: payload.id, result: { data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', description: 'mock', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', supportsPersonality: true }] } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/start') {",
    "    write({ id: payload.id, result: { thread: { id: 'thr_exit', path: '/tmp/thr_exit.jsonl', turns: [] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/start') {",
    "    write({ id: payload.id, result: { turn: { id: 'turn_exit', items: [], status: 'inProgress', error: null } } });",
    "    setTimeout(() => process.exit(0), 10);",
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
    "    if ('method' in parsed) {",
    "      handleMessage(parsed);",
    "    }",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function createStderrExitScript(rootDir: string): Promise<string> {
  const scriptPath = join(rootDir, "mock-codex-stderr-exit.mjs");
  const script = [
    "process.stderr.write('codex child failed to boot\\n');",
    "setTimeout(() => process.exit(1), 10);",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

describe("CodexBackend", () => {
  it("proxies stdio app-server requests and relays notifications/server requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-test-"));
    const { scriptPath: mockScript } = await createMockCodexScript(root);
    const backend = createCodexBackend({
      command: "node",
      args: [mockScript],
    });
    await backend.initialize();

    const models = await backend.listModels();
    expect(models[0]?.id).toBe("gpt-5.4");

    const started = await backend.threadStart({
      threadId: "thr_local",
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      launchConfig: {},
    });
    expect(started.threadHandle).toBe("thr_mock");

    const events: Array<{ kind: string; method?: string }> = [];
    const subscription = backend.onEvent(started.threadHandle, (event) => {
      events.push({ kind: event.kind, method: "method" in event ? event.method : undefined });
      if (event.kind === "serverRequest") {
        void backend.resolveServerRequest({
          threadId: "thr_local",
          threadHandle: started.threadHandle,
          requestId: event.requestId,
          response: { result: { answers: { answer: { answers: ["Yes"] } } } },
        });
      }
    });

    await backend.turnStart({
      threadId: "thr_local",
      threadHandle: started.threadHandle,
      turnId: "turn_local",
      cwd: process.cwd(),
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });

    await waitFor(() => events.some((event) => event.kind === "serverRequest"));
    await waitFor(() => events.some((event) => event.method === "turn/completed"));
    expect(events.some((event) => event.method === "turn/completed")).toBe(true);

    subscription.dispose();
    await backend.dispose();
  });

  it("forwards desktop thread and turn settings to native Codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-test-"));
    const { scriptPath: mockScript, requestsPath } = await createMockCodexScript(root);
    const backend = createCodexBackend({
      command: "node",
      args: [mockScript],
    });
    await backend.initialize();

    const started = await backend.threadStart({
      threadId: "thr_local",
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: {
        features: {
          personality: true,
        },
      },
      serviceTier: "auto",
      serviceName: "codex_desktop",
      baseInstructions: "base instructions",
      developerInstructions: "developer instructions",
      personality: "friendly",
      experimentalRawEvents: true,
      persistExtendedHistory: true,
      launchConfig: {},
    });

    await backend.turnStart({
      threadId: "thr_local",
      threadHandle: started.threadHandle,
      turnId: "turn_local",
      cwd: process.cwd(),
      input: [{ type: "text", text: "hello", text_elements: [] }],
      model: "gpt-5.4",
      reasoningEffort: "medium",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      serviceTier: "auto",
      summary: "none",
      personality: "friendly",
      outputSchema: {
        type: "object",
      },
      collaborationMode: {
        mode: "default",
      },
    });

    const requests = (await readFile(requestsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    const threadStartRequest = requests.find((entry) => entry.method === "thread/start");
    const turnStartRequest = requests.find((entry) => entry.method === "turn/start");

    expect(threadStartRequest?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      config: {
        features: {
          personality: true,
        },
        model_reasoning_effort: "medium",
      },
      serviceTier: "auto",
      serviceName: "codex_desktop",
      baseInstructions: "base instructions",
      developerInstructions: "developer instructions",
      personality: "friendly",
      experimentalRawEvents: true,
      persistExtendedHistory: true,
    });
    expect(turnStartRequest?.params).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      serviceTier: "auto",
      effort: "medium",
      summary: "none",
      personality: "friendly",
      outputSchema: {
        type: "object",
      },
      collaborationMode: {
        mode: "default",
      },
    });

    await backend.dispose();
  });

  it("rejects websocket mode deterministically", async () => {
    const backend = createCodexBackend({
      transport: "websocket",
      websocketUrl: "ws://127.0.0.1:9234",
    });
    await expect(backend.initialize()).rejects.toThrow("deferred");
    await expect(backend.initialize()).rejects.toThrow("ws://127.0.0.1:9234");
    expect(backend.isAlive()).toBe(false);
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it("rejects websocket mode without URL deterministically", async () => {
    const backend = createCodexBackend({
      transport: "websocket",
    });
    await expect(backend.initialize()).rejects.toThrow(
      "Codex websocket transport is deferred in this implementation"
    );
    expect(backend.isAlive()).toBe(false);
  });

  it("supports codex thread lifecycle relay methods", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-test-"));
    const { scriptPath: mockScript } = await createMockCodexScript(root);
    const backend = createCodexBackend({
      command: "node",
      args: [mockScript],
    });
    await backend.initialize();

    const started = await backend.threadStart({
      threadId: "thr_local",
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      launchConfig: {},
    });
    expect(started.threadHandle).toBe("thr_mock");

    await expect(
      backend.threadSetName({
        threadId: "thr_local",
        threadHandle: started.threadHandle,
        name: "Renamed",
      })
    ).resolves.toBeUndefined();

    const resumed = await backend.threadResume({
      threadId: "thr_local",
      threadHandle: started.threadHandle,
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      launchConfig: {},
    });
    expect(resumed.threadHandle).toBe("thr_mock");

    const forked = await backend.threadFork({
      threadId: "thr_fork",
      sourceThreadId: "thr_local",
      sourceThreadHandle: started.threadHandle,
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      launchConfig: {},
    });
    expect(forked.threadHandle).toBe("thr_mock_fork");

    const read = await backend.threadRead({
      threadId: "thr_local",
      threadHandle: started.threadHandle,
      includeTurns: true,
      cwd: process.cwd(),
    });
    expect(read.turns).toHaveLength(1);

    await expect(
      backend.threadArchive({
        threadId: "thr_local",
        threadHandle: started.threadHandle,
      })
    ).resolves.toBeUndefined();

    await backend.dispose();
  });

  it("emits disconnect events when the codex subprocess exits unexpectedly", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-test-"));
    const mockScript = await createExitOnTurnStartScript(root);
    const backend = createCodexBackend({
      command: "node",
      args: [mockScript],
    });
    await backend.initialize();

    const started = await backend.threadStart({
      threadId: "thr_local",
      cwd: process.cwd(),
      model: "gpt-5.4",
      reasoningEffort: "medium",
      launchConfig: {},
    });

    const events: Array<{ kind: string; message?: string }> = [];
    const subscription = backend.onEvent(started.threadHandle, (event) => {
      if (event.kind === "disconnect") {
        events.push({ kind: event.kind, message: event.message });
      }
    });

    await backend.turnStart({
      threadId: "thr_local",
      threadHandle: started.threadHandle,
      turnId: "turn_local",
      cwd: process.cwd(),
      input: [{ type: "text", text: "trigger exit", text_elements: [] }],
      model: "gpt-5.4",
      reasoningEffort: "medium",
    });

    await waitFor(() => events.some((event) => event.kind === "disconnect"));
    expect(events.some((event) => event.message?.includes("exited"))).toBe(true);

    subscription.dispose();
    await backend.dispose();
  });

  it("surfaces missing executable spawn failures clearly", async () => {
    const backend = createCodexBackend({
      command: "definitely-not-a-real-codex-command",
    });

    await expect(backend.initialize()).rejects.toThrow("Failed to spawn Codex app-server process");
    expect(backend.isAlive()).toBe(false);
    await expect(backend.dispose()).resolves.toBeUndefined();
  });

  it("drains child stderr and includes it in initialization failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "codapter-codex-test-"));
    const stderr = new PassThrough();
    const stderrChunks: string[] = [];
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const scriptPath = await createStderrExitScript(root);
    const backend = createCodexBackend({
      command: "node",
      args: [scriptPath],
      stderr,
    });

    try {
      await expect(backend.initialize()).rejects.toThrow("codex child failed to boot");
      expect(stderrChunks.join("")).toContain("codex child failed to boot");
      expect(backend.isAlive()).toBe(false);
    } finally {
      await backend.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
