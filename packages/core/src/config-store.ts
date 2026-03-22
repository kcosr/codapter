import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type {
  Config,
  ConfigBatchWriteParams,
  ConfigEdit,
  ConfigLayer,
  ConfigLayerMetadata,
  ConfigReadParams,
  ConfigReadResponse,
  ConfigValueWriteParams,
  ConfigWriteResponse,
  JsonValue,
  WriteStatus,
} from "./protocol.js";

function createDefaultConfig(): Config {
  return {
    model: null,
    review_model: null,
    model_context_window: null,
    model_auto_compact_token_limit: null,
    model_provider: null,
    approval_policy: null,
    approvals_reviewer: null,
    sandbox_mode: null,
    sandbox_workspace_write: null,
    forced_chatgpt_workspace_id: null,
    forced_login_method: null,
    web_search: null,
    tools: null,
    profile: null,
    profiles: {},
    instructions: null,
    developer_instructions: null,
    compact_prompt: null,
    model_reasoning_effort: null,
    model_reasoning_summary: null,
    model_verbosity: null,
    service_tier: null,
    analytics: null,
  };
}

function isJsonObject(
  value: JsonValue | undefined
): value is { [key: string]: JsonValue | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureContainer(root: { [key: string]: JsonValue | undefined }, key: string) {
  const current = root[key];
  if (isJsonObject(current)) {
    return current;
  }

  const next: { [key: string]: JsonValue | undefined } = {};
  root[key] = next;
  return next;
}

function applyEdit(config: Config, edit: ConfigEdit | ConfigValueWriteParams): void {
  const segments = edit.keyPath.split(".").filter(Boolean);
  if (segments.length === 0) {
    return;
  }

  let cursor: { [key: string]: JsonValue | undefined } = config;
  for (const segment of segments.slice(0, -1)) {
    cursor = ensureContainer(cursor, segment);
  }

  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    return;
  }

  if (edit.mergeStrategy === "upsert") {
    const current = cursor[finalSegment];
    if (isJsonObject(current) && isJsonObject(edit.value)) {
      cursor[finalSegment] = {
        ...current,
        ...edit.value,
      };
      return;
    }
  }

  cursor[finalSegment] = edit.value;
}

function setConfigValue(config: Config, keyPath: string, value: JsonValue): void {
  applyEdit(config, {
    keyPath,
    value,
    mergeStrategy: "replace",
  });
}

function parseTomlScalar(raw: string): JsonValue | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  if (value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\\\/g, "\\")
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }

  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) {
      return [];
    }
    return inner
      .split(",")
      .map((entry) => parseTomlScalar(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  return undefined;
}

function loadConfigFromDisk(filePath: string): Config {
  const config = createDefaultConfig();
  if (!existsSync(filePath)) {
    return config;
  }

  const raw = readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const keyPath = trimmed.slice(0, separator).trim();
    const value = parseTomlScalar(trimmed.slice(separator + 1));
    if (!keyPath || value === undefined) {
      continue;
    }

    setConfigValue(config, keyPath, value);
  }

  return config;
}

function escapeTomlString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function formatTomlValue(value: JsonValue): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return `"${escapeTomlString(value)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const formatted = value
      .map((entry) => formatTomlValue(entry))
      .filter((entry): entry is string => entry !== null);
    return `[${formatted.join(", ")}]`;
  }
  return null;
}

function collectTomlLines(value: JsonValue | undefined, keyPath = ""): string[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (Array.isArray(value) || typeof value !== "object") {
    const formatted = formatTomlValue(value);
    return keyPath && formatted ? [`${keyPath} = ${formatted}`] : [];
  }

  return Object.entries(value).flatMap(([key, child]) =>
    collectTomlLines(child, keyPath ? `${keyPath}.${key}` : key)
  );
}

export class InMemoryConfigStore {
  private readonly filePath: string;
  private versionCounter = 1;
  private readonly config: Config;

  constructor(filePath = resolve(homedir(), ".config", "codapter", "config.toml")) {
    this.filePath = filePath;
    this.config = loadConfigFromDisk(filePath);
  }

  read(params: ConfigReadParams): ConfigReadResponse {
    const layerMetadata: ConfigLayerMetadata = {
      name: { type: "user", file: this.filePath },
      version: this.version,
    };

    const layer: ConfigLayer = {
      name: layerMetadata.name,
      version: layerMetadata.version,
      config: this.config,
      disabledReason: null,
    };

    return {
      config: this.config,
      origins: {},
      layers: params.includeLayers ? [layer] : null,
    };
  }

  writeValue(params: ConfigValueWriteParams): ConfigWriteResponse {
    this.assertVersion(params.expectedVersion ?? null);
    applyEdit(this.config, params);
    this.persist();
    this.versionCounter += 1;
    return this.createWriteResponse("ok");
  }

  writeBatch(params: ConfigBatchWriteParams): ConfigWriteResponse {
    this.assertVersion(params.expectedVersion ?? null);
    for (const edit of params.edits) {
      applyEdit(this.config, edit);
    }
    this.persist();
    this.versionCounter += 1;
    return this.createWriteResponse("ok");
  }

  get version(): string {
    return String(this.versionCounter);
  }

  private assertVersion(expectedVersion: string | null): void {
    if (expectedVersion !== null && expectedVersion !== this.version) {
      throw new Error(`Config version mismatch: expected ${expectedVersion}, got ${this.version}`);
    }
  }

  private createWriteResponse(status: WriteStatus): ConfigWriteResponse {
    return {
      status,
      version: this.version,
      filePath: this.filePath,
      overriddenMetadata: null,
    };
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const lines = collectTomlLines(this.config);
    const output = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    writeFileSync(this.filePath, output, "utf8");
  }
}
