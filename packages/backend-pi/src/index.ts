import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BackendCapabilities,
  BackendEvent,
  BackendImageInput,
  BackendMessage,
  BackendModelSummary,
  Disposable,
  IBackend,
} from "@codapter/core";
import {
  type PiProcessLaunchOptions,
  PiProcessSession,
  type PiSessionStateSnapshot,
  mapAvailableModelsToSummaries,
  mapSessionRecordFromSnapshot,
} from "./pi-process.js";
import { type PiBackendSessionRecord, PiBackendStateStore } from "./state-store.js";

export interface PiBackendOptions {
  readonly sessionDir?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly debugLogFilePath?: string | null;
}

interface ManagedSession {
  readonly process: PiProcessSession;
  record: PiBackendSessionRecord;
}

const DEFAULT_CAPABILITIES: BackendCapabilities = {
  requiresAuth: false,
  supportsImages: true,
  supportsThinking: true,
  supportsParallelTools: true,
  supportedToolTypes: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function defaultSessionDir(): string {
  return join(homedir(), ".local", "share", "codapter", "backend-pi");
}

function cloneMessage(message: BackendMessage): BackendMessage {
  return {
    ...message,
    content: structuredClone(message.content),
  };
}

function cloneMessages(messages: readonly BackendMessage[]): BackendMessage[] {
  return messages.map(cloneMessage);
}

function cloneModels(models: readonly BackendModelSummary[]): BackendModelSummary[] {
  return models.map((model) => ({
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  }));
}

function cloneCapabilities(capabilities: BackendCapabilities): BackendCapabilities {
  return {
    ...capabilities,
    supportedToolTypes: [...capabilities.supportedToolTypes],
  };
}

function opaqueSessionId(): string {
  return `pi_session_${randomUUID()}`;
}

function toRequestedModelCandidates(modelId: string): string[] {
  if (modelId.includes("/")) {
    return [modelId];
  }

  return [modelId, `openai-codex/${modelId}`];
}

export class PiBackend implements IBackend {
  public readonly sessionDir: string;

  private readonly launchOptions: {
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  };
  private readonly stateStore: PiBackendStateStore;
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly modelCache = new Map<string, BackendModelSummary>();
  private initialized = false;
  private disposed = false;
  private capabilities: BackendCapabilities | null = null;

  constructor(options: PiBackendOptions = {}) {
    this.sessionDir = options.sessionDir ?? defaultSessionDir();
    const launchOptions: {
      command?: string;
      args?: readonly string[];
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    } = {};
    if (options.command !== undefined) {
      launchOptions.command = options.command;
    }
    if (options.args !== undefined) {
      launchOptions.args = options.args;
    }
    if (options.env !== undefined) {
      launchOptions.env = options.env;
    }
    if (options.cwd !== undefined) {
      launchOptions.cwd = options.cwd;
    }
    if (options.debugLogFilePath !== undefined) {
      launchOptions.env = {
        ...(launchOptions.env ?? {}),
        CODAPTER_DEBUG_LOG_FILE: options.debugLogFilePath ?? "",
      };
    }
    this.launchOptions = launchOptions;
    this.stateStore = new PiBackendStateStore(this.sessionDir);
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();
    await this.stateStore.load();
    this.initialized = true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    const disposals = Array.from(this.sessions.values(), async (session) => {
      await session.process.dispose().catch(() => {});
    });
    await Promise.all(disposals);

    this.sessions.clear();
    this.modelCache.clear();
  }

  isAlive(): boolean {
    return this.initialized && !this.disposed;
  }

  async createSession(): Promise<string> {
    this.assertReady();
    const sessionId = opaqueSessionId();
    const process = this.createProcess(sessionId);
    const snapshot = await process.startFresh();
    const record = await this.persistSnapshot(sessionId, snapshot);
    this.sessions.set(sessionId, { process, record });
    return sessionId;
  }

  async resumeSession(sessionId: string): Promise<string> {
    this.assertReady();
    await this.ensureActiveSession(sessionId);
    return sessionId;
  }

  async forkSession(sessionId: string): Promise<string> {
    this.assertReady();
    const source = await this.ensureActiveSession(sessionId);
    if (!source.record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const forkedSessionId = opaqueSessionId();
    const process = this.createProcess(forkedSessionId);
    await process.attachSession(source.record.sessionFile);

    const anchors = await process.getForkMessages();
    const entryId = anchors.at(-1)?.entryId;
    if (!entryId) {
      throw new Error(`Pi session has no fork anchor: ${sessionId}`);
    }

    const forkResult = await process.forkSession(entryId);
    if (forkResult.cancelled) {
      throw new Error(`Pi fork was cancelled for session ${sessionId}`);
    }

    const snapshot = await process.getState();
    const record = await this.persistSnapshot(forkedSessionId, snapshot, source.record.createdAt);
    this.sessions.set(forkedSessionId, { process, record });
    return forkedSessionId;
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.assertReady();
    await this.requireRecord(sessionId);

    const session = this.sessions.get(sessionId);
    if (session) {
      await session.process.dispose().catch(() => {});
      this.sessions.delete(sessionId);
    }
  }

  async readSessionHistory(sessionId: string): Promise<BackendMessage[]> {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session?.process.isRunning()) {
      return cloneMessages(await session.process.getMessages());
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const reader = this.createProcess(`read:${sessionId}`);
    try {
      await reader.attachSession(record.sessionFile);
      return cloneMessages(await reader.getMessages());
    } finally {
      await reader.dispose().catch(() => {});
    }
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.setSessionName(name);
    session.record = await this.updateRecord(sessionId, {
      sessionName: name,
      updatedAt: nowIso(),
    });
  }

  async prompt(
    sessionId: string,
    turnId: string,
    text: string,
    images?: readonly BackendImageInput[]
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.prompt(turnId, text, images);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async abort(sessionId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.abort();
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  async listModels(): Promise<BackendModelSummary[]> {
    this.assertReady();
    if (this.modelCache.size > 0) {
      return cloneModels([...this.modelCache.values()]);
    }

    const probe = this.createProcess(`models:${randomUUID()}`);
    try {
      const models = await probe.getAvailableModels();
      const summaries = mapAvailableModelsToSummaries(models);
      this.modelCache.clear();
      for (const model of summaries) {
        this.modelCache.set(model.id, model);
      }
      return cloneModels(summaries);
    } finally {
      await probe.dispose().catch(() => {});
    }
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    const model = await this.resolveModel(modelId);
    await session.process.setModel(model.provider, model.modelId);
    session.record = await this.updateRecord(sessionId, {
      modelId: model.id,
      updatedAt: nowIso(),
    });
  }

  async getCapabilities(): Promise<BackendCapabilities> {
    this.assertReady();
    if (!this.capabilities) {
      this.capabilities = cloneCapabilities(DEFAULT_CAPABILITIES);
    }
    return cloneCapabilities(this.capabilities);
  }

  async respondToElicitation(
    sessionId: string,
    requestId: string,
    response: unknown
  ): Promise<void> {
    this.assertReady();
    const session = await this.ensureActiveSession(sessionId);
    await session.process.respondToElicitation(requestId, response);
    session.record = await this.updateRecord(sessionId, {
      updatedAt: nowIso(),
    });
  }

  onEvent(sessionId: string, listener: (event: BackendEvent) => void): Disposable {
    this.assertReady();
    const session = this.sessions.get(sessionId);
    if (session?.process.isRunning()) {
      return session.process.addListener(listener);
    }

    let disposed = false;
    let listenerDisposable: Disposable | null = null;
    const disposable: Disposable = {
      dispose(): void {
        disposed = true;
        listenerDisposable?.dispose();
      },
    };

    void this.ensureActiveSession(sessionId).then((active) => {
      if (!disposed) {
        listenerDisposable = active.process.addListener(listener);
      } else {
        listenerDisposable?.dispose();
      }
    });

    return disposable;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("Pi backend has been disposed");
    }
  }

  private assertReady(): void {
    this.assertNotDisposed();
    if (!this.initialized) {
      throw new Error("Pi backend must be initialized before use");
    }
  }

  private createProcess(sessionId: string): PiProcessSession {
    return new PiProcessSession({
      sessionDir: this.sessionDir,
      opaqueSessionId: sessionId,
      ...this.launchOptions,
    });
  }

  private async ensureActiveSession(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing?.process.isRunning()) {
      return existing;
    }

    if (existing) {
      await existing.process.dispose().catch(() => {});
      this.sessions.delete(sessionId);
    }

    const record = await this.requireRecord(sessionId);
    if (!record.sessionFile) {
      throw new Error(`Pi session has no session file: ${sessionId}`);
    }

    const process = this.createProcess(sessionId);
    await process.attachSession(record.sessionFile);
    const snapshot = await process.getState();
    const nextRecord = await this.persistSnapshot(sessionId, snapshot, record.createdAt);
    const session = { process, record: nextRecord };
    this.sessions.set(sessionId, session);
    return session;
  }

  private async requireRecord(sessionId: string): Promise<PiBackendSessionRecord> {
    const record = await this.stateStore.get(sessionId);
    if (!record) {
      throw new Error(`Unknown Pi session: ${sessionId}`);
    }
    return record;
  }

  private async persistSnapshot(
    sessionId: string,
    snapshot: PiSessionStateSnapshot,
    createdAt?: string
  ): Promise<PiBackendSessionRecord> {
    const record = mapSessionRecordFromSnapshot(sessionId, snapshot, createdAt ?? nowIso());
    await this.stateStore.upsert(record);
    return record;
  }

  private async updateRecord(
    sessionId: string,
    patch: Partial<Omit<PiBackendSessionRecord, "opaqueSessionId" | "createdAt">>
  ): Promise<PiBackendSessionRecord> {
    return await this.stateStore.update(sessionId, patch);
  }

  private async resolveModel(
    modelId: string
  ): Promise<{ id: string; provider: string; modelId: string }> {
    if (this.modelCache.size === 0) {
      await this.listModels();
    }

    const model = toRequestedModelCandidates(modelId)
      .map((candidate) => this.modelCache.get(candidate))
      .find((candidate) => candidate !== undefined);
    if (!model) {
      throw new Error(`Unknown Pi model: ${modelId}`);
    }

    const provider = model.model.split("/")[0] ?? "";
    const rawModelId = model.model.split("/")[1] ?? model.model;
    return {
      id: model.id,
      provider,
      modelId: rawModelId,
    };
  }
}

export function createPiBackend(options: PiBackendOptions = {}): PiBackend {
  return new PiBackend(options);
}
