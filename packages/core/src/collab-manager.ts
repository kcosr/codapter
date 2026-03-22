import { randomUUID } from "node:crypto";
import type { BackendEvent, BackendSessionLaunchConfig, Disposable, IBackend } from "./backend.js";
import { AGENT_NICKNAMES } from "./collab-nicknames.js";
import type {
  CollabAgent,
  CollabAgentState,
  CollabAgentStatus,
  CollabAgentTool,
  CollabAgentToolCallItem,
  CollabCloseRequest,
  CollabCloseResponse,
  CollabConfig,
  CollabResumeRequest,
  CollabResumeResponse,
  CollabSendInputRequest,
  CollabSendInputResponse,
  CollabSpawnRequest,
  CollabSpawnResponse,
  CollabWaitRequest,
  CollabWaitResponse,
} from "./collab-types.js";

const DEFAULT_CONFIG: CollabConfig = {
  maxAgents: 10,
  maxDepth: 3,
  defaultTimeoutMs: 30_000,
  minTimeoutMs: 10_000,
  maxTimeoutMs: 3_600_000,
};

interface CollabAgentRuntime {
  subscription: Disposable | null;
  activeTurnId: string | null;
  lastAssistantText: string;
}

interface CollabWaiter {
  ids: readonly string[];
  resolve: (response: CollabWaitResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface CollabManagerNotificationSink {
  notify(method: string, params: unknown, threadId?: string): Promise<void>;
}

export interface CollabManagerCreateChildThreadInput {
  agentId: string;
  nickname: string;
  role: string | null;
  parentThreadId: string;
  threadId: string;
  sessionId: string;
  depth: number;
  preview: string;
}

export interface CollabManagerOptions {
  backend: IBackend;
  notifySink: CollabManagerNotificationSink;
  resolveParentTurnId(parentThreadId: string): string;
  resolveThreadSessionId(threadId: string): string;
  createSessionLaunchConfig?(threadId: string): BackendSessionLaunchConfig;
  createChildThread(input: CollabManagerCreateChildThreadInput): Promise<void>;
  startChildTurn?(input: { agent: CollabAgent; message: string }): string | Promise<string>;
  onChildAgentEvent?(input: {
    agent: CollabAgent;
    event: BackendEvent;
  }): void | Promise<void>;
  onChildAgentStatusChanged?(input: {
    agent: CollabAgent;
  }): void | Promise<void>;
  config?: Partial<CollabConfig>;
}

function collabStateFromAgent(
  agent: Pick<CollabAgent, "status" | "completionMessage">
): CollabAgentState {
  return {
    status: agent.status,
    message: agent.completionMessage,
  };
}

export class CollabManager {
  private readonly agents = new Map<string, CollabAgent>();
  private readonly agentRuntimes = new Map<string, CollabAgentRuntime>();
  private readonly nicknames = new Set<string>();
  private readonly waiters = new Map<string, CollabWaiter>();
  private readonly shuttingDownAgentIds = new Set<string>();
  private readonly config: CollabConfig;
  private readonly backend: IBackend;
  private readonly notifySink: CollabManagerNotificationSink;
  private readonly resolveParentTurnId: (parentThreadId: string) => string;
  private readonly resolveThreadSessionId: (threadId: string) => string;
  private readonly createSessionLaunchConfig: (threadId: string) => BackendSessionLaunchConfig;
  private readonly createChildThread: CollabManagerOptions["createChildThread"];
  private readonly startChildTurn: CollabManagerOptions["startChildTurn"];
  private readonly onChildAgentEvent: CollabManagerOptions["onChildAgentEvent"];
  private readonly onChildAgentStatusChanged: CollabManagerOptions["onChildAgentStatusChanged"];
  private nicknameCounter = 0;

  constructor(options: CollabManagerOptions) {
    this.backend = options.backend;
    this.notifySink = options.notifySink;
    this.resolveParentTurnId = options.resolveParentTurnId;
    this.resolveThreadSessionId = options.resolveThreadSessionId;
    this.createSessionLaunchConfig = options.createSessionLaunchConfig ?? (() => ({}));
    this.createChildThread = options.createChildThread;
    this.startChildTurn = options.startChildTurn;
    this.onChildAgentEvent = options.onChildAgentEvent;
    this.onChildAgentStatusChanged = options.onChildAgentStatusChanged;
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
    };
  }

  async spawn(req: CollabSpawnRequest): Promise<CollabSpawnResponse> {
    this.assertSpawnLimits(req.parentThreadId);
    const agentId = randomUUID();
    const nickname = this.assignNickname();
    const role = req.agentType ?? "default";
    const depth = this.depthForParent(req.parentThreadId) + 1;
    const threadId = randomUUID();
    const sessionLaunchConfig = this.createSessionLaunchConfig(threadId);
    const sessionId = req.forkContext
      ? await this.backend.forkSession(
          this.resolveThreadSessionId(req.parentThreadId),
          sessionLaunchConfig
        )
      : await this.backend.createSession(sessionLaunchConfig);

    try {
      if (req.model) {
        await this.backend.setModel(sessionId, req.model);
      }

      await this.createChildThread({
        agentId,
        nickname,
        role,
        parentThreadId: req.parentThreadId,
        threadId,
        sessionId,
        depth,
        preview: req.message.slice(0, 120),
      });

      const agent: CollabAgent = {
        agentId,
        nickname,
        role,
        threadId,
        sessionId,
        parentThreadId: req.parentThreadId,
        depth,
        status: "pendingInit",
        completionMessage: null,
      };
      this.agents.set(agentId, agent);
      this.subscribeToAgent(agent);

      const startedItem = this.createToolItem(req.parentThreadId, "spawnAgent", {
        receiverThreadIds: [],
        prompt: req.message,
        model: req.model ?? null,
        reasoningEffort: req.reasoningEffort ?? null,
      });
      await this.emitToolItem("item/started", req.parentThreadId, startedItem);

      await this.beginAgentTurn(agent, req.message);

      startedItem.status = "completed";
      startedItem.receiverThreadIds = [agent.threadId];
      startedItem.agentsStates = this.collectAgentStates([agentId]);
      await this.emitToolItem("item/completed", req.parentThreadId, startedItem);

      this.transitionAgent(agentId, "running", null);
      void this.startPrompt(agentId, req.message);

      return {
        agent_id: agentId,
        nickname,
      };
    } catch (error) {
      this.agents.delete(agentId);
      this.agentRuntimes.delete(agentId);
      await this.backend.disposeSession(sessionId).catch(() => {});
      throw error;
    }
  }

  async sendInput(req: CollabSendInputRequest): Promise<CollabSendInputResponse> {
    const agent = this.requireOwnedAgent(req.parentThreadId, req.id);
    const runtime = this.agentRuntimes.get(agent.agentId);
    if (agent.status === "shutdown") {
      throw new Error(`Agent ${req.id} is shutdown and must be resumed before sending input`);
    }
    if (agent.status === "errored") {
      throw new Error(`Agent ${req.id} is errored and must be resumed before sending input`);
    }
    if (runtime?.activeTurnId && !req.interrupt) {
      throw new Error(
        `Agent ${req.id} is already running; wait for it to finish or use interrupt=true`
      );
    }

    const item = this.createToolItem(req.parentThreadId, "sendInput", {
      receiverThreadIds: [agent.threadId],
      prompt: req.message,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    if (req.interrupt) {
      await this.backend.abort(agent.sessionId);
      this.transitionAgent(agent.agentId, "interrupted", agent.completionMessage);
    }

    const submissionId = randomUUID();
    await this.beginAgentTurn(agent, req.message);
    this.transitionAgent(agent.agentId, "running", null);
    void this.startPrompt(agent.agentId, req.message);

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return {
      submission_id: submissionId,
    };
  }

  async wait(req: CollabWaitRequest): Promise<CollabWaitResponse> {
    if (req.ids.length === 0) {
      return { status: {}, timed_out: false };
    }

    for (const agentId of req.ids) {
      this.validateParentOwnership(req.parentThreadId, agentId);
    }

    const item = this.createToolItem(req.parentThreadId, "wait", {
      receiverThreadIds: this.collectReceiverThreadIds(req.ids),
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const immediate = this.collectFinalStatuses(req.ids);
    if (Object.keys(immediate).length > 0) {
      item.status = "completed";
      item.agentsStates = this.collectAgentStates(req.ids);
      await this.emitToolItem("item/completed", req.parentThreadId, item);
      return { status: immediate, timed_out: false };
    }

    const response = await new Promise<CollabWaitResponse>((resolve) => {
      const waiterId = randomUUID();
      const timeoutMs = this.normalizeTimeout(req.timeout_ms);
      const waiter: CollabWaiter = {
        ids: [...req.ids],
        resolve: (result) => {
          if (waiter.timer) {
            clearTimeout(waiter.timer);
          }
          this.waiters.delete(waiterId);
          resolve(result);
        },
        timer: setTimeout(() => {
          waiter.resolve({
            status: this.collectFinalStatuses(req.ids),
            timed_out: true,
          });
        }, timeoutMs),
      };
      this.waiters.set(waiterId, waiter);
    });

    item.status = "completed";
    item.agentsStates = this.collectAgentStates(req.ids);
    await this.emitToolItem("item/completed", req.parentThreadId, item);
    return response;
  }

  async close(req: CollabCloseRequest): Promise<CollabCloseResponse> {
    const agent = this.getOwnedAgent(req.parentThreadId, req.id);
    if (!agent) {
      return { previous_status: "notFound" };
    }

    const item = this.createToolItem(req.parentThreadId, "closeAgent", {
      receiverThreadIds: [agent.threadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const previousStatus = agent.status;
    if (agent.status !== "shutdown") {
      await this.shutdownAgent(agent.agentId);
    }

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return {
      previous_status: previousStatus,
    };
  }

  async resume(req: CollabResumeRequest): Promise<CollabResumeResponse> {
    const agent = this.getOwnedAgent(req.parentThreadId, req.id);
    if (!agent) {
      return { status: "notFound" };
    }
    if (agent.status === "running" || agent.status === "pendingInit") {
      throw new Error(`Agent ${req.id} is already active`);
    }

    const item = this.createToolItem(req.parentThreadId, "resumeAgent", {
      receiverThreadIds: [agent.threadId],
      prompt: null,
      model: null,
      reasoningEffort: null,
    });
    await this.emitToolItem("item/started", req.parentThreadId, item);

    const runtime = this.agentRuntimes.get(agent.agentId);
    runtime?.subscription?.dispose();
    let sessionId = agent.sessionId;
    try {
      sessionId = await this.backend.resumeSession(
        agent.sessionId,
        this.createSessionLaunchConfig(agent.threadId)
      );
    } catch {
      sessionId = await this.backend.createSession(this.createSessionLaunchConfig(agent.threadId));
    }

    agent.sessionId = sessionId;
    this.subscribeToAgent(agent);
    this.transitionAgent(agent.agentId, "running", agent.completionMessage);

    item.status = "completed";
    item.agentsStates = this.collectAgentStates([agent.agentId]);
    await this.emitToolItem("item/completed", req.parentThreadId, item);

    return { status: agent.status };
  }

  async shutdownByParent(parentThreadId: string): Promise<void> {
    const agents = [...this.agents.values()].filter(
      (agent) => agent.parentThreadId === parentThreadId
    );
    await Promise.all(
      agents.map((agent) => this.close({ parentThreadId, id: agent.agentId }).then(() => {}))
    );
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.agents.values()].map((agent) => this.shutdownAgent(agent.agentId)));

    for (const waiter of this.waiters.values()) {
      waiter.resolve({
        status: {},
        timed_out: true,
      });
    }
    this.waiters.clear();
  }

  private assignNickname(): string {
    for (const nickname of AGENT_NICKNAMES) {
      if (!this.nicknames.has(nickname)) {
        this.nicknames.add(nickname);
        return nickname;
      }
    }

    this.nicknameCounter += 1;
    const fallback = `Agent${this.nicknameCounter}`;
    this.nicknames.add(fallback);
    return fallback;
  }

  private assertSpawnLimits(parentThreadId: string): void {
    const activeAgentCount = [...this.agents.values()].filter(
      (agent) => agent.status !== "shutdown"
    ).length;
    if (activeAgentCount >= this.config.maxAgents) {
      throw new Error(`Maximum collab agent count reached (${this.config.maxAgents})`);
    }

    const nextDepth = this.depthForParent(parentThreadId) + 1;
    if (nextDepth > this.config.maxDepth) {
      throw new Error(`Maximum collab depth reached (${this.config.maxDepth})`);
    }
  }

  private depthForParent(parentThreadId: string): number {
    const parentAgent = [...this.agents.values()].find(
      (agent) => agent.threadId === parentThreadId
    );
    return parentAgent?.depth ?? 0;
  }

  private validateParentOwnership(parentThreadId: string, agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    if (agent.parentThreadId !== parentThreadId) {
      throw new Error(`Agent ${agentId} does not belong to parent thread ${parentThreadId}`);
    }
  }

  private getOwnedAgent(parentThreadId: string, agentId: string): CollabAgent | null {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }
    if (agent.parentThreadId !== parentThreadId) {
      throw new Error(`Agent ${agentId} does not belong to parent thread ${parentThreadId}`);
    }
    return agent;
  }

  private requireOwnedAgent(parentThreadId: string, agentId: string): CollabAgent {
    const agent = this.getOwnedAgent(parentThreadId, agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return agent;
  }

  private subscribeToAgent(agent: CollabAgent): void {
    const existing = this.agentRuntimes.get(agent.agentId);
    existing?.subscription?.dispose();
    const runtime: CollabAgentRuntime = existing ?? {
      subscription: null,
      activeTurnId: null,
      lastAssistantText: "",
    };
    runtime.subscription = this.backend.onEvent(agent.sessionId, (event) => {
      void this.handleChildEvent(agent.agentId, event);
    });
    this.agentRuntimes.set(agent.agentId, runtime);
  }

  getAgentByThreadId(threadId: string): CollabAgent | null {
    return [...this.agents.values()].find((agent) => agent.threadId === threadId) ?? null;
  }

  syncExternalResume(threadId: string, sessionId: string): void {
    const agent = this.getAgentByThreadId(threadId);
    if (!agent) {
      return;
    }
    agent.sessionId = sessionId;
    this.subscribeToAgent(agent);
    this.transitionAgent(agent.agentId, "running", agent.completionMessage);
  }

  syncExternalTurnStart(threadId: string, turnId: string): void {
    const agent = this.getAgentByThreadId(threadId);
    const runtime = agent ? this.agentRuntimes.get(agent.agentId) : null;
    if (!agent || !runtime) {
      return;
    }

    runtime.activeTurnId = turnId;
    runtime.lastAssistantText = "";
    this.transitionAgent(agent.agentId, "running", null);
  }

  syncExternalTurnInterrupt(threadId: string): void {
    const agent = this.getAgentByThreadId(threadId);
    const runtime = agent ? this.agentRuntimes.get(agent.agentId) : null;
    if (!agent || !runtime) {
      return;
    }

    runtime.activeTurnId = null;
    runtime.lastAssistantText = "";
    this.transitionAgent(agent.agentId, "interrupted", null);
  }

  private async beginAgentTurn(agent: CollabAgent, message: string): Promise<string> {
    const runtime = this.agentRuntimes.get(agent.agentId);
    if (!runtime) {
      throw new Error(`Missing runtime for agent ${agent.agentId}`);
    }
    const turnId = this.startChildTurn
      ? await this.startChildTurn({ agent: structuredClone(agent), message })
      : randomUUID();
    runtime.activeTurnId = turnId;
    runtime.lastAssistantText = "";
    return turnId;
  }

  private async startPrompt(agentId: string, message: string): Promise<void> {
    const agent = this.agents.get(agentId);
    const runtime = this.agentRuntimes.get(agentId);
    if (!agent || !runtime || !runtime.activeTurnId) {
      return;
    }

    try {
      await this.backend.prompt(agent.sessionId, runtime.activeTurnId, message);
    } catch (error) {
      this.transitionAgent(
        agentId,
        "errored",
        error instanceof Error ? error.message : String(error)
      );
      this.resolveWaiters(agentId);
    }
  }

  private async handleChildEvent(agentId: string, event: BackendEvent): Promise<void> {
    const agent = this.agents.get(agentId);
    const runtime = this.agentRuntimes.get(agentId);
    if (!agent || !runtime) {
      return;
    }

    await this.onChildAgentEvent?.({ agent: structuredClone(agent), event });

    if (runtime.activeTurnId !== event.turnId) {
      return;
    }

    switch (event.type) {
      case "text_delta":
        runtime.lastAssistantText += event.delta;
        break;
      case "message_end":
        runtime.activeTurnId = null;
        if (typeof event.text === "string") {
          runtime.lastAssistantText = event.text;
        }
        this.transitionAgent(agentId, "completed", runtime.lastAssistantText || null);
        this.resolveWaiters(agentId);
        break;
      case "error":
        runtime.activeTurnId = null;
        this.transitionAgent(agentId, "errored", event.message);
        this.resolveWaiters(agentId);
        break;
      default:
        break;
    }
  }

  private transitionAgent(
    agentId: string,
    status: CollabAgentStatus,
    message: string | null
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }
    agent.status = status;
    agent.completionMessage = message;
    void this.onChildAgentStatusChanged?.({ agent: structuredClone(agent) });
  }

  private async shutdownAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.status === "shutdown" || this.shuttingDownAgentIds.has(agentId)) {
      return;
    }
    this.shuttingDownAgentIds.add(agentId);

    try {
      await this.shutdownByParent(agent.threadId);

      const runtime = this.agentRuntimes.get(agent.agentId);
      await this.backend.abort(agent.sessionId).catch(() => {});
      runtime?.subscription?.dispose();
      if (runtime) {
        runtime.subscription = null;
        runtime.activeTurnId = null;
        runtime.lastAssistantText = "";
      }
      await this.backend.disposeSession(agent.sessionId).catch(() => {});
      this.transitionAgent(agent.agentId, "shutdown", agent.completionMessage);
      this.resolveWaiters(agent.agentId);
    } finally {
      this.shuttingDownAgentIds.delete(agentId);
    }
  }

  private resolveWaiters(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !this.isFinalStatus(agent.status)) {
      return;
    }

    for (const waiter of this.waiters.values()) {
      if (!waiter.ids.includes(agentId)) {
        continue;
      }
      waiter.resolve({
        status: this.collectFinalStatuses(waiter.ids),
        timed_out: false,
      });
    }
  }

  private isFinalStatus(status: CollabAgentStatus): boolean {
    return (
      status === "completed" ||
      status === "errored" ||
      status === "shutdown" ||
      status === "notFound"
    );
  }

  private normalizeTimeout(timeoutMs: number | undefined): number {
    const requested = timeoutMs ?? this.config.defaultTimeoutMs;
    return Math.min(this.config.maxTimeoutMs, Math.max(this.config.minTimeoutMs, requested));
  }

  private createToolItem(
    parentThreadId: string,
    tool: CollabAgentTool,
    options: {
      receiverThreadIds: string[];
      prompt: string | null;
      model: string | null;
      reasoningEffort: string | null;
    }
  ): CollabAgentToolCallItem {
    return {
      type: "collabAgentToolCall",
      id: randomUUID(),
      tool,
      status: "inProgress",
      senderThreadId: parentThreadId,
      receiverThreadIds: options.receiverThreadIds,
      prompt: options.prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      agentsStates: {},
    };
  }

  private async emitToolItem(
    method: "item/started" | "item/completed",
    parentThreadId: string,
    item: CollabAgentToolCallItem
  ): Promise<void> {
    await this.notifySink.notify(
      method,
      {
        item: structuredClone(item),
        threadId: parentThreadId,
        turnId: this.resolveParentTurnId(parentThreadId),
      },
      parentThreadId
    );
  }

  private collectReceiverThreadIds(agentIds: readonly string[]): string[] {
    return agentIds.flatMap((agentId) => {
      const agent = this.agents.get(agentId);
      return agent ? [agent.threadId] : [];
    });
  }

  private collectAgentStates(agentIds: readonly string[]): Record<string, CollabAgentState> {
    const states: Record<string, CollabAgentState> = {};
    for (const agentId of agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        continue;
      }
      states[agent.threadId] = collabStateFromAgent(agent);
    }
    return states;
  }

  private collectFinalStatuses(agentIds: readonly string[]): Record<string, CollabAgentStatus> {
    const states: Record<string, CollabAgentStatus> = {};
    for (const agentId of agentIds) {
      const agent = this.agents.get(agentId);
      if (!agent) {
        states[agentId] = "notFound";
        continue;
      }
      if (this.isFinalStatus(agent.status)) {
        states[agentId] = agent.status;
      }
    }
    return states;
  }
}
