import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { GitInfo, SessionSource } from "./protocol.js";

type StoredSessionSource = Exclude<SessionSource, "appServer"> | { type: "appServer" };

export interface ThreadRegistryLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface ThreadRegistryEntry {
  readonly threadId: string;
  readonly backendSessionId: string;
  readonly backendType: string;
  readonly ephemeral: boolean;
  readonly hidden: boolean;
  readonly name: string | null;
  readonly path: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
  readonly cwd: string | null;
  readonly preview: string | null;
  readonly modelProvider: string | null;
  readonly source: StoredSessionSource;
  readonly agentNickname: string | null;
  readonly agentRole: string | null;
  readonly gitInfo: GitInfo | null;
}

export interface CreateThreadRegistryEntry {
  readonly threadId?: string;
  readonly backendSessionId: string;
  readonly backendType: string;
  readonly ephemeral?: boolean;
  readonly hidden?: boolean;
  readonly name?: string | null;
  readonly path?: string | null;
  readonly archived?: boolean;
  readonly cwd?: string | null;
  readonly preview?: string | null;
  readonly modelProvider?: string | null;
  readonly source?: StoredSessionSource;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly gitInfo?: GitInfo | null;
}

export interface UpdateThreadRegistryEntry {
  readonly backendSessionId?: string;
  readonly backendType?: string;
  readonly ephemeral?: boolean;
  readonly hidden?: boolean;
  readonly name?: string | null;
  readonly path?: string | null;
  readonly updatedAt?: string;
  readonly archived?: boolean;
  readonly cwd?: string | null;
  readonly preview?: string | null;
  readonly modelProvider?: string | null;
  readonly source?: StoredSessionSource;
  readonly agentNickname?: string | null;
  readonly agentRole?: string | null;
  readonly gitInfo?: GitInfo | null;
}

interface ThreadRegistryFile {
  readonly threads: ThreadRegistryEntry[];
}

function defaultLogger(): ThreadRegistryLogger {
  return {
    warn(message, context) {
      if (context) {
        console.warn(message, context);
        return;
      }
      console.warn(message);
    },
  };
}

function defaultStateFilePath(): string {
  return resolve(homedir(), ".local", "share", "codapter", "threads.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isThreadRegistryEntry(value: unknown): value is ThreadRegistryEntry {
  if (!isRecord(value)) {
    return false;
  }

  const source = value.source;
  const validSource =
    source === undefined ||
    source === null ||
    source === "appServer" ||
    (isRecord(source) && source.type === "appServer") ||
    (isRecord(source) &&
      isRecord(source.subAgent) &&
      isRecord(source.subAgent.thread_spawn) &&
      typeof source.subAgent.thread_spawn.parent_thread_id === "string" &&
      typeof source.subAgent.thread_spawn.depth === "number" &&
      (typeof source.subAgent.thread_spawn.agent_nickname === "string" ||
        source.subAgent.thread_spawn.agent_nickname === null ||
        source.subAgent.thread_spawn.agent_nickname === undefined) &&
      (typeof source.subAgent.thread_spawn.agent_role === "string" ||
        source.subAgent.thread_spawn.agent_role === null ||
        source.subAgent.thread_spawn.agent_role === undefined));

  return (
    typeof value.threadId === "string" &&
    typeof value.backendSessionId === "string" &&
    typeof value.backendType === "string" &&
    (typeof value.ephemeral === "boolean" || value.ephemeral === undefined) &&
    (typeof value.hidden === "boolean" || value.hidden === undefined) &&
    (typeof value.name === "string" || value.name === null) &&
    (typeof value.path === "string" || value.path === null || value.path === undefined) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.archived === "boolean" &&
    (typeof value.cwd === "string" || value.cwd === null) &&
    (typeof value.preview === "string" || value.preview === null) &&
    (typeof value.modelProvider === "string" || value.modelProvider === null) &&
    validSource &&
    (typeof value.agentNickname === "string" ||
      value.agentNickname === null ||
      value.agentNickname === undefined) &&
    (typeof value.agentRole === "string" ||
      value.agentRole === null ||
      value.agentRole === undefined) &&
    (isRecord(value.gitInfo) || value.gitInfo === null)
  );
}

export class ThreadRegistry {
  private readonly filePath: string;
  private readonly logger: ThreadRegistryLogger;
  private readonly entries = new Map<string, ThreadRegistryEntry>();
  private loaded = false;

  constructor(filePath = defaultStateFilePath(), logger: ThreadRegistryLogger = defaultLogger()) {
    this.filePath = filePath;
    this.logger = logger;
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.loaded = true;
        return;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn("Failed to parse thread registry; starting with an empty registry", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      this.loaded = true;
      return;
    }

    if (!isRecord(parsed) || !Array.isArray(parsed.threads)) {
      this.logger.warn("Invalid thread registry root; starting with an empty registry", {
        filePath: this.filePath,
      });
      this.loaded = true;
      return;
    }

    for (const entry of parsed.threads) {
      if (!isThreadRegistryEntry(entry)) {
        this.logger.warn("Skipping invalid thread registry entry", {
          filePath: this.filePath,
        });
        continue;
      }
      const rawSource = (entry as { source?: unknown }).source;
      this.entries.set(entry.threadId, {
        ...entry,
        ephemeral: entry.ephemeral ?? false,
        hidden: entry.hidden ?? false,
        path: entry.path ?? null,
        source:
          rawSource === "appServer" || rawSource === undefined || rawSource === null
            ? { type: "appServer" }
            : entry.source,
        agentNickname: entry.agentNickname ?? null,
        agentRole: entry.agentRole ?? null,
      });
    }

    this.loaded = true;
  }

  async list(): Promise<ThreadRegistryEntry[]> {
    await this.load();
    return [...this.entries.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  async get(threadId: string): Promise<ThreadRegistryEntry | null> {
    await this.load();
    return this.entries.get(threadId) ?? null;
  }

  async create(input: CreateThreadRegistryEntry): Promise<ThreadRegistryEntry> {
    await this.load();

    const now = new Date().toISOString();
    const entry: ThreadRegistryEntry = {
      threadId: input.threadId ?? randomUUID(),
      backendSessionId: input.backendSessionId,
      backendType: input.backendType,
      ephemeral: input.ephemeral ?? false,
      hidden: input.hidden ?? false,
      name: input.name ?? null,
      path: input.path ?? null,
      createdAt: now,
      updatedAt: now,
      archived: input.archived ?? false,
      cwd: input.cwd ?? null,
      preview: input.preview ?? null,
      modelProvider: input.modelProvider ?? null,
      source: input.source ?? { type: "appServer" },
      agentNickname: input.agentNickname ?? null,
      agentRole: input.agentRole ?? null,
      gitInfo: input.gitInfo ?? null,
    };

    this.entries.set(entry.threadId, entry);
    await this.persist();
    return entry;
  }

  async update(threadId: string, patch: UpdateThreadRegistryEntry): Promise<ThreadRegistryEntry> {
    await this.load();

    const current = this.entries.get(threadId);
    if (!current) {
      throw new Error(`Unknown thread: ${threadId}`);
    }

    const updated: ThreadRegistryEntry = {
      ...current,
      ...patch,
      threadId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };

    this.entries.set(threadId, updated);
    await this.persist();
    return updated;
  }

  async delete(threadId: string): Promise<void> {
    await this.load();
    this.entries.delete(threadId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload: ThreadRegistryFile = {
      threads: [...this.entries.values()],
    };

    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, this.filePath);

    try {
      await rm(tempPath, { force: true });
    } catch {
      // rename already moved the temp file; ignore cleanup races
    }
  }
}
