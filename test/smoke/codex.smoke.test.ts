import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCodexBackend } from "../../packages/backend-codex/src/index.js";
import { AppServerConnection } from "../../packages/core/src/app-server.js";
import { BackendRouter } from "../../packages/core/src/backend-router.js";
import type {
  BackendAppServerEvent,
  BackendModelSummary,
  IBackend,
  ParsedBackendSelection,
} from "../../packages/core/src/backend.js";
import { BackendThreadEventBuffer, parseBackendModelId } from "../../packages/core/src/backend.js";

const describeIfCodexSmoke = process.env.CODEX_SMOKE_TEST === "1" ? describe : describe.skip;

class SmokePiBackend implements IBackend {
  public readonly backendType = "pi";
  private readonly events = new BackendThreadEventBuffer();

  async initialize() {}
  async dispose() {}
  isAlive() {
    return true;
  }

  parseModelSelection(model: string | null | undefined): ParsedBackendSelection | null {
    if (!model) {
      return null;
    }
    const parsed = parseBackendModelId(model);
    if (!parsed || parsed.backendType !== this.backendType) {
      return null;
    }
    return parsed;
  }

  async listModels(): Promise<readonly BackendModelSummary[]> {
    return [
      {
        id: "mock-default",
        model: "mock-default",
        displayName: "PI Mock",
        description: "PI smoke model",
        hidden: false,
        isDefault: true,
        inputModalities: ["text"],
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
        defaultReasoningEffort: "medium",
        supportsPersonality: true,
      },
    ];
  }

  async threadStart(input: {
    threadId: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    return {
      threadHandle: `pi_${input.threadId}`,
      path: null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadResume(input: {
    threadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    return {
      threadHandle: input.threadHandle,
      path: null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadFork(input: {
    sourceThreadHandle: string;
    model: string | null;
    reasoningEffort: string | null;
  }) {
    return {
      threadHandle: `${input.sourceThreadHandle}_fork`,
      path: null,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  async threadRead(input: { threadHandle: string }) {
    return {
      threadHandle: input.threadHandle,
      title: null,
      model: null,
      turns: [],
    };
  }

  async threadArchive() {}
  async threadSetName() {}

  async turnStart(input: { threadId: string; threadHandle: string; turnId: string }) {
    queueMicrotask(() => {
      this.events.emit(input.threadHandle, {
        kind: "notification",
        threadHandle: input.threadHandle,
        method: "turn/started",
        params: {
          threadId: input.threadId,
          turnId: input.turnId,
          turn: { id: input.turnId, items: [], status: "inProgress", error: null },
        },
      });
      this.events.emit(input.threadHandle, {
        kind: "notification",
        threadHandle: input.threadHandle,
        method: "turn/completed",
        params: {
          threadId: input.threadId,
          turnId: input.turnId,
          turn: { id: input.turnId, items: [], status: "completed", error: null },
        },
      });
    });
    return { accepted: true as const };
  }

  async turnInterrupt() {}
  async resolveServerRequest() {}

  onEvent(threadHandle: string, listener: (event: BackendAppServerEvent) => void) {
    return this.events.subscribe(threadHandle, listener);
  }
}

async function createMockCodexScript(rootDir: string): Promise<string> {
  const scriptPath = join(rootDir, "mock-codex-smoke.mjs");
  const script = [
    "import { StringDecoder } from 'node:string_decoder';",
    "const decoder = new StringDecoder('utf8');",
    "let buffer = '';",
    "",
    "function write(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }",
    "",
    "function handleMessage(payload) {",
    "  if (payload.method === 'initialize') {",
    "    write({ id: payload.id, result: { userAgent: 'mock-codex', platformFamily: 'unix', platformOs: 'linux' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'model/list') {",
    "    write({ id: payload.id, result: { data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', description: 'Codex smoke model', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium', supportsPersonality: true }] } });",
    "    return;",
    "  }",
    "  if (payload.method === 'thread/start') {",
    "    write({ id: payload.id, result: { thread: { id: 'codex_thr_1', path: '/tmp/codex_thr_1.jsonl', turns: [] }, model: payload.params.model ?? 'gpt-5.4', reasoningEffort: 'medium' } });",
    "    return;",
    "  }",
    "  if (payload.method === 'turn/start') {",
    "    write({ id: payload.id, result: { turn: { id: 'codex_turn_1', items: [], status: 'inProgress', error: null } } });",
    "    setTimeout(() => {",
    "      write({ method: 'turn/started', params: { threadId: payload.params.threadId, turnId: 'codex_turn_1', turn: { id: 'codex_turn_1', items: [], status: 'inProgress', error: null } } });",
    "      write({ method: 'item/agentMessage/delta', params: { threadId: payload.params.threadId, turnId: 'codex_turn_1', itemId: 'msg_1', delta: 'codex smoke reply' } });",
    "      write({ method: 'turn/completed', params: { threadId: payload.params.threadId, turnId: 'codex_turn_1', turn: { id: 'codex_turn_1', items: [], status: 'completed', error: null } } });",
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
    "    if ('method' in parsed) { handleMessage(parsed); }",
    "  }",
    "});",
  ].join("\n");
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

type NotificationMessage = { method: string; params?: Record<string, unknown> };

async function initConnection(
  backendRouter: BackendRouter,
  notifications: NotificationMessage[]
): Promise<AppServerConnection> {
  const connection = new AppServerConnection({
    backendRouter,
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
      clientInfo: { name: "codapter-codex-smoke", title: null, version: "0.0.1" },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    },
  });
  return connection;
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

describeIfCodexSmoke("codex smoke", () => {
  it("aggregates pi and codex models in one picker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-smoke-"));
    const mockScript = await createMockCodexScript(directory);
    const piBackend = new SmokePiBackend();
    const codexBackend = createCodexBackend({ command: "node", args: [mockScript] });
    await piBackend.initialize();
    await codexBackend.initialize();

    const connection = await initConnection(new BackendRouter([piBackend, codexBackend]), []);

    try {
      const response = (await connection.handleMessage({
        id: 2,
        method: "model/list",
        params: {},
      })) as { result: { data: Array<{ id: string }> } };
      const ids = response.result.data.map((entry) => entry.id);
      expect(ids.some((id) => id.startsWith("pi::"))).toBe(true);
      expect(ids).toContain("gpt-5.4");
      expect(ids.some((id) => id.startsWith("codex::"))).toBe(false);
    } finally {
      await connection.dispose();
      await codexBackend.dispose();
      await piBackend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("routes codex-selected threads and turns through codex backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-codex-smoke-"));
    const mockScript = await createMockCodexScript(directory);
    const notifications: NotificationMessage[] = [];
    const piBackend = new SmokePiBackend();
    const codexBackend = createCodexBackend({ command: "node", args: [mockScript] });
    await piBackend.initialize();
    await codexBackend.initialize();

    const connection = await initConnection(
      new BackendRouter([piBackend, codexBackend]),
      notifications
    );

    try {
      const started = (await connection.handleMessage({
        id: 2,
        method: "thread/start",
        params: {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
          cwd: "/repo",
          modelProvider: "codex",
          model: "gpt-5.4",
        },
      })) as { result: { thread: { id: string } } };
      expect(started.result.thread.id).toBeTruthy();

      await connection.handleMessage({
        id: 3,
        method: "turn/start",
        params: {
          threadId: started.result.thread.id,
          input: [{ type: "text", text: "hello from smoke", text_elements: [] }],
          model: "gpt-5.4",
        },
      });

      await waitFor(() =>
        notifications.some(
          (entry) =>
            entry.method === "item/agentMessage/delta" &&
            entry.params?.delta === "codex smoke reply"
        )
      );
      await waitFor(() => notifications.some((entry) => entry.method === "turn/completed"));
    } finally {
      await connection.dispose();
      await codexBackend.dispose();
      await piBackend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
