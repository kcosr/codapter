import { randomUUID } from "node:crypto";
import net from "node:net";
import { Type } from "@sinclair/typebox";

const FAST_TIMEOUT_MS = 30_000;
const WAIT_TIMEOUT_MS = 3_660_000;

const SPAWN_AGENT_DESCRIPTION = `Only use spawn_agent if and only if the user explicitly asks for sub-agents, delegation, or parallel agent work. Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission to spawn.

Spawn a sub-agent for a well-scoped task. Returns metadata for exactly one spawned agent: the canonical agent_id and, when available, a user-facing nickname for that same agent. Do not treat agent_id and nickname as separate agents.

{available_models_description}

### When to delegate vs. do the subtask yourself
- First, quickly analyze the overall user task and form a succinct high-level plan. Identify which tasks are immediate blockers on the critical path, and which tasks are sidecar tasks that can run in parallel without blocking the next local step.
- Use the smaller subagent when a subtask is easy enough for it to handle and can run in parallel with your local work. Prefer delegating concrete, bounded sidecar tasks that materially advance the main task.
- Do not delegate urgent blocking work when your immediate next step depends on that result.
- Keep work local when the subtask is tightly coupled, urgent, or likely to block your immediate next step.

### Designing delegated subtasks
- Subtasks must be concrete, well-defined, and self-contained.
- Do not duplicate work between the main rollout and delegated subtasks.
- Narrow the delegated ask to the concrete output you need next.
- For coding tasks, prefer delegating concrete code-change worker subtasks.
- For code-edit subtasks, decompose work so each delegated task has a disjoint write set.

### After you delegate
- Call wait_agent very sparingly. Only call wait_agent when you need the result immediately for the next critical-path step.
- Do not redo delegated subagent tasks yourself; focus on integrating results or tackling non-overlapping work.
- While the subagent is running, do meaningful non-overlapping work immediately.
- Do not repeatedly wait by reflex.
- After a subagent finishes successfully, prefer leaving it available for likely follow-up work instead of closing it immediately.
- Only close a subagent when the user explicitly asks to close it, or when you are confident the work is fully done and the agent is unlikely to be reused.

### Parallel delegation patterns
- Run multiple independent subtasks in parallel when you have distinct questions.
- Split implementation into disjoint codebase slices and spawn multiple agents.
- The key is to find opportunities to spawn multiple independent subtasks in parallel within the same round.`;

const SpawnAgentParams = Type.Object({
  message: Type.String(),
  agent_type: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  reasoning_effort: Type.Optional(Type.String()),
  fork_context: Type.Optional(Type.Boolean()),
});

const SendInputParams = Type.Object({
  id: Type.String(),
  message: Type.String(),
  interrupt: Type.Optional(Type.Boolean()),
});

const WaitAgentParams = Type.Object({
  ids: Type.Array(Type.String()),
  timeout_ms: Type.Optional(Type.Number()),
});

const CloseAgentParams = Type.Object({
  id: Type.String(),
});

const ResumeAgentParams = Type.Object({
  id: Type.String(),
});

type JsonRpcSuccess<T> = {
  id: string;
  result: T;
};

type JsonRpcFailure = {
  id: string;
  error: {
    code?: string | number;
    message?: string;
  };
};

type ExtensionApi = {
  registerTool?(definition: Record<string, unknown>): void;
  listModels?(): Promise<unknown>;
  backend?: {
    listModels?(): Promise<unknown>;
  };
  models?: {
    list?(): Promise<unknown>;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createCollabError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class CollabClient {
  constructor(private readonly socketPath: string) {}

  async call<T>(
    method: string,
    params: unknown,
    options: {
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {}
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? FAST_TIMEOUT_MS;

    return await new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      let buffer = "";

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", handleAbort);
        socket.removeAllListeners();
        if (!socket.destroyed) {
          socket.end();
        }
      };

      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        cleanup();
        reject(error);
      };

      const finish = (value: T) => {
        if (settled) {
          return;
        }
        cleanup();
        resolve(value);
      };

      const handleAbort = () => {
        fail(createCollabError("aborted", "Collab request was aborted"));
        socket.destroy();
      };

      const timeout = setTimeout(() => {
        fail(createCollabError("timeout", `Collab request timed out after ${timeoutMs}ms`));
        socket.destroy();
      }, timeoutMs);

      options.signal?.addEventListener("abort", handleAbort, { once: true });

      socket.setEncoding("utf8");
      socket.on("error", (error) => {
        fail(createCollabError("collab_unavailable", error.message));
      });
      socket.on("close", () => {
        if (!settled) {
          fail(createCollabError("collab_unavailable", "Collab socket closed before a response"));
        }
      });
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          let parsed: JsonRpcSuccess<T> | JsonRpcFailure;
          try {
            parsed = JSON.parse(line) as JsonRpcSuccess<T> | JsonRpcFailure;
          } catch {
            fail(createCollabError("invalid_response", "Collab socket returned invalid JSON"));
            return;
          }

          if (isRecord(parsed) && "error" in parsed && isRecord(parsed.error)) {
            fail(
              createCollabError(
                typeof parsed.error.code === "string" ? parsed.error.code : "jsonrpc_error",
                typeof parsed.error.message === "string"
                  ? parsed.error.message
                  : "Collab request failed"
              )
            );
            return;
          }

          if (isRecord(parsed) && "result" in parsed) {
            finish(parsed.result as T);
            return;
          }
        }
      });
    });
  }
}

async function fetchAvailableModelsDescription(pi: ExtensionApi): Promise<string> {
  const sources = [
    pi.listModels?.bind(pi),
    pi.backend?.listModels?.bind(pi.backend),
    pi.models?.list?.bind(pi.models),
  ];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    try {
      const result = await source();
      const entries = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result.data)
          ? result.data
          : [];
      if (entries.length === 0) {
        continue;
      }

      const formatted = entries
        .flatMap((entry) => {
          if (!isRecord(entry)) {
            return [];
          }

          const name =
            typeof entry.model === "string"
              ? entry.model
              : typeof entry.id === "string"
                ? entry.id
                : null;
          if (!name) {
            return [];
          }

          const efforts = Array.isArray(entry.supportedReasoningEfforts)
            ? entry.supportedReasoningEfforts
                .flatMap((value) =>
                  isRecord(value) && typeof value.reasoningEffort === "string"
                    ? [value.reasoningEffort]
                    : []
                )
                .join(", ")
            : "";
          return [`- ${name}${efforts ? `: ${efforts}` : ""}`];
        })
        .join("\n");

      if (formatted) {
        return `Available models:\n${formatted}`;
      }
    } catch {
      // Fall through to the next model source.
    }
  }

  return "Available models are determined by the active backend session.";
}

function toToolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
  };
}

function toToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "collab_error";

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: code, message }),
      },
    ],
    details: { error: true, code, message },
  };
}

export default async function collabExtension(pi: ExtensionApi): Promise<void> {
  const socketPath = process.env.CODAPTER_COLLAB_UDS;
  const parentThreadId = process.env.CODAPTER_COLLAB_PARENT_THREAD;
  if (!socketPath || !parentThreadId || !pi.registerTool) {
    return;
  }

  const client = new CollabClient(socketPath);
  const modelsDescription = await fetchAvailableModelsDescription(pi);

  const collabCall = async (
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ) => {
    try {
      const callOptions: { timeoutMs: number; signal?: AbortSignal } = { timeoutMs };
      if (signal) {
        callOptions.signal = signal;
      }

      const result = await client.call(method, { parentThreadId, ...params }, callOptions);
      return toToolResult(result);
    } catch (error) {
      return toToolError(error);
    }
  };

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: SPAWN_AGENT_DESCRIPTION.replace(
      "{available_models_description}",
      modelsDescription
    ),
    promptSnippet: "spawn_agent: Spawn a sub-agent for parallel or delegated work",
    parameters: SpawnAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/spawn", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "send_input",
    label: "Send Input",
    description:
      "Send a message to an existing agent. Use interrupt=true to redirect work immediately. You should reuse the agent by send_input if you believe your assigned task is highly dependent on the context of a previous task.",
    parameters: SendInputParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/sendInput", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "wait_agent",
    label: "Wait Agent",
    description:
      "Wait for agents to reach a final status. Read the agent's final output from messages[agent_id] when status[agent_id] is completed. Returns empty status/messages when timed out. Pass multiple ids to wait for whichever finishes first. Prefer longer waits (minutes) to avoid busy polling.",
    parameters: WaitAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/wait", params, WAIT_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "close_agent",
    label: "Close Agent",
    description:
      "Close an agent when it is no longer needed and return its previous status before shutdown was requested. Prefer leaving recently used agents open for likely follow-up work. Use this mainly when the user explicitly wants the agent closed or you are confident it will not be reused.",
    parameters: CloseAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/close", params, FAST_TIMEOUT_MS, signal),
  });

  pi.registerTool({
    name: "resume_agent",
    label: "Resume Agent",
    description:
      "Resume a previously closed agent by id so it can receive send_input and wait_agent calls.",
    parameters: ResumeAgentParams,
    execute: (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) =>
      collabCall("collab/resume", params, FAST_TIMEOUT_MS, signal),
  });
}
