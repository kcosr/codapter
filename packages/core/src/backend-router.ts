import type { BackendModelSummary, IBackend, ParsedBackendSelection } from "./backend.js";
import { encodeBackendModelId, parseBackendModelId } from "./backend.js";

const NATIVE_BACKEND_TYPE = "codex";
const PI_BACKEND_TYPE = "pi";

interface AggregatedModelEntry extends BackendModelSummary {
  readonly backendType: string;
}

interface IndexedAggregatedModelEntry extends AggregatedModelEntry {
  readonly sourceIndex: number;
}

function cloneModel(model: BackendModelSummary): BackendModelSummary {
  return {
    ...model,
    inputModalities: [...model.inputModalities],
    supportedReasoningEfforts: [...model.supportedReasoningEfforts],
  };
}

function cloneModelListResult(result: BackendModelListResult): BackendModelListResult {
  return {
    models: result.models.map(cloneModel),
    diagnostics: result.diagnostics.map((entry) => ({ ...entry })),
    totalDurationMs: result.totalDurationMs,
  };
}

function humanizeProvider(provider: string): string {
  switch (provider.toLowerCase()) {
    case "openai-codex":
      return "OpenAI Codex";
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "google":
      return "Google";
    case "xai":
      return "xAI";
    case "openrouter":
      return "OpenRouter";
    case "ollama":
      return "Ollama";
    case "github-copilot":
      return "GitHub Copilot";
    case "pi":
      return "Pi";
    default:
      return provider
        .split(/[-_]/g)
        .filter((part) => part.length > 0)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function formatPiDisplayName(model: BackendModelSummary): string {
  const separatorIndex = model.model.indexOf("/");
  const provider = separatorIndex > 0 ? model.model.slice(0, separatorIndex) : null;
  const providerLabel = provider ? ` (${humanizeProvider(provider)})` : "";
  return `pi / ${model.displayName}${providerLabel}`;
}

function toAggregatedModel(backendType: string, model: BackendModelSummary): AggregatedModelEntry {
  const exposedId =
    backendType === NATIVE_BACKEND_TYPE ? model.id : encodeBackendModelId(backendType, model.id);
  const exposedModel =
    backendType === NATIVE_BACKEND_TYPE
      ? model.model
      : encodeBackendModelId(backendType, model.model);
  return {
    ...cloneModel(model),
    id: exposedId,
    model: exposedModel,
    displayName:
      backendType === NATIVE_BACKEND_TYPE
        ? model.displayName
        : backendType === PI_BACKEND_TYPE
          ? formatPiDisplayName(model)
          : `${backendType} / ${model.displayName}`,
    isDefault: model.isDefault,
    backendType,
  };
}

export interface RoutedBackendSelection {
  readonly backend: IBackend;
  readonly selection: ParsedBackendSelection;
}

export interface BackendModelListDiagnostic {
  readonly backendType: string;
  readonly status: "ok" | "skipped" | "error";
  readonly durationMs: number;
  readonly modelCount: number;
  readonly error: string | null;
}

export interface BackendModelListResult {
  readonly models: BackendModelSummary[];
  readonly diagnostics: BackendModelListDiagnostic[];
  readonly totalDurationMs: number;
}

function getPreferredDefaultModel(
  candidates: readonly AggregatedModelEntry[]
): AggregatedModelEntry | null {
  return (
    candidates.find((model) => model.backendType === NATIVE_BACKEND_TYPE && model.isDefault) ??
    candidates.find((model) => model.backendType === NATIVE_BACKEND_TYPE && !model.hidden) ??
    candidates.find((model) => model.isDefault) ??
    candidates.find((model) => !model.hidden) ??
    null
  );
}

function sortAggregatedModels(
  candidates: readonly AggregatedModelEntry[]
): readonly AggregatedModelEntry[] {
  return candidates
    .map(
      (model, sourceIndex): IndexedAggregatedModelEntry => ({
        ...model,
        sourceIndex,
      })
    )
    .sort((left, right) => {
      const leftBackendPriority = left.backendType === NATIVE_BACKEND_TYPE ? 0 : 1;
      const rightBackendPriority = right.backendType === NATIVE_BACKEND_TYPE ? 0 : 1;
      if (leftBackendPriority !== rightBackendPriority) {
        return leftBackendPriority - rightBackendPriority;
      }
      if (left.hidden !== right.hidden) {
        return left.hidden ? 1 : -1;
      }
      return left.sourceIndex - right.sourceIndex;
    })
    .map(({ sourceIndex: _sourceIndex, ...model }) => model);
}

export class BackendRouter {
  private readonly backends = new Map<string, IBackend>();
  private readonly backendOrder: string[] = [];
  private modelListPromise: Promise<BackendModelListResult> | null = null;
  private modelListCache: BackendModelListResult | null = null;

  constructor(backends: readonly IBackend[] = []) {
    for (const backend of backends) {
      this.register(backend);
    }
  }

  register(backend: IBackend): void {
    if (this.backends.has(backend.backendType)) {
      throw new Error(`Duplicate backend type: ${backend.backendType}`);
    }
    this.backends.set(backend.backendType, backend);
    this.backendOrder.push(backend.backendType);
  }

  listBackendTypes(): readonly string[] {
    return [...this.backendOrder];
  }

  getBackend(backendType: string): IBackend | null {
    return this.backends.get(backendType) ?? null;
  }

  requireBackend(backendType: string): IBackend {
    const backend = this.getBackend(backendType);
    if (!backend) {
      throw new Error(`Unknown backend type: ${backendType}`);
    }
    return backend;
  }

  parseModelSelection(model: string | null | undefined): RoutedBackendSelection | null {
    if (!model) {
      return null;
    }

    const prefixed = parseBackendModelId(model);
    if (!prefixed) {
      const codexBackend = this.getBackend(NATIVE_BACKEND_TYPE);
      if (!codexBackend) {
        return null;
      }
      const parsed = codexBackend.parseModelSelection(model);
      if (!parsed) {
        return null;
      }
      return {
        backend: codexBackend,
        selection: parsed,
      };
    }

    const backend = this.getBackend(prefixed.backendType);
    if (!backend) {
      return null;
    }

    const parsed = backend.parseModelSelection(model);
    if (!parsed) {
      return null;
    }

    return {
      backend,
      selection: parsed,
    };
  }

  toClientModelId(backendType: string, rawModelId: string): string {
    return backendType === NATIVE_BACKEND_TYPE
      ? rawModelId
      : encodeBackendModelId(backendType, rawModelId);
  }

  canonicalizeModelSelection(model: string | null | undefined): string | null {
    if (!model) {
      return null;
    }
    const parsed = this.parseModelSelection(model);
    if (!parsed) {
      return model;
    }
    return this.toClientModelId(parsed.selection.backendType, parsed.selection.rawModelId);
  }

  async listModelsDetailed(): Promise<BackendModelListResult> {
    if (this.modelListCache) {
      return cloneModelListResult(this.modelListCache);
    }
    if (this.modelListPromise) {
      return cloneModelListResult(await this.modelListPromise);
    }

    this.modelListPromise = this.loadModelsDetailed();
    try {
      const result = await this.modelListPromise;
      this.modelListCache = result;
      return cloneModelListResult(result);
    } finally {
      this.modelListPromise = null;
    }
  }

  private async loadModelsDetailed(): Promise<BackendModelListResult> {
    const startedAt = Date.now();
    const candidates: AggregatedModelEntry[] = [];
    const diagnostics: BackendModelListDiagnostic[] = [];

    for (const backendType of this.backendOrder) {
      const backend = this.backends.get(backendType);
      if (!backend) {
        diagnostics.push({
          backendType,
          status: "skipped",
          durationMs: 0,
          modelCount: 0,
          error: "Backend not registered",
        });
        continue;
      }
      if (!backend.isAlive()) {
        diagnostics.push({
          backendType,
          status: "skipped",
          durationMs: 0,
          modelCount: 0,
          error: "Backend unavailable",
        });
        continue;
      }
      const backendStartedAt = Date.now();
      let models: readonly BackendModelSummary[];
      try {
        models = await backend.listModels();
      } catch (error) {
        diagnostics.push({
          backendType,
          status: "error",
          durationMs: Date.now() - backendStartedAt,
          modelCount: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      diagnostics.push({
        backendType,
        status: "ok",
        durationMs: Date.now() - backendStartedAt,
        modelCount: models.length,
        error: null,
      });
      for (const model of models) {
        candidates.push(toAggregatedModel(backend.backendType, model));
      }
    }

    const preferredDefault = getPreferredDefaultModel(candidates);
    const defaultId = preferredDefault?.id ?? null;
    const orderedModels = sortAggregatedModels(candidates);

    return {
      models: orderedModels.map((model) => ({
        ...model,
        isDefault: defaultId !== null && model.id === defaultId,
      })),
      diagnostics,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  async listModels(): Promise<BackendModelSummary[]> {
    return (await this.listModelsDetailed()).models;
  }

  private async resolveDefaultModelSelection(
    preferredBackendType?: string | null
  ): Promise<RoutedBackendSelection> {
    const models = (await this.listModelsDetailed())
      .models as unknown as readonly AggregatedModelEntry[];
    const defaultModel =
      (preferredBackendType
        ? (models.find((entry) => entry.backendType === preferredBackendType && entry.isDefault) ??
          models.find((entry) => entry.backendType === preferredBackendType && !entry.hidden))
        : null) ??
      models.find((entry) => entry.isDefault) ??
      null;
    if (!defaultModel) {
      throw new Error("No healthy backend models available");
    }

    const parsed =
      this.parseModelSelection(defaultModel.model) ?? this.parseModelSelection(defaultModel.id);
    if (parsed) {
      return parsed;
    }

    if (preferredBackendType && defaultModel.backendType === preferredBackendType) {
      const backend = this.backends.get(preferredBackendType) ?? null;
      if (backend?.isAlive()) {
        return {
          backend,
          selection: {
            backendType: preferredBackendType,
            rawModelId: defaultModel.model,
          },
        };
      }
    }

    throw new Error(
      `Failed to parse default model selection: ${defaultModel.model} (${defaultModel.id})`
    );
  }

  async resolveModelSelection(
    model: string | null | undefined,
    preferredBackendType?: string | null
  ): Promise<RoutedBackendSelection> {
    if (model) {
      const parsed = this.parseModelSelection(model);
      if (!parsed) {
        const prefixed = parseBackendModelId(model);
        if (!prefixed) {
          throw new Error(`Model id is not backend-prefixed: ${model}`);
        }
        if (!this.backends.has(prefixed.backendType)) {
          throw new Error(`Unknown backend prefix: ${prefixed.backendType}`);
        }
        throw new Error(`Invalid backend model id: ${model}`);
      }
      if (!parsed.backend.isAlive()) {
        throw new Error(`Backend ${parsed.selection.backendType} is unavailable`);
      }
      return parsed;
    }

    return await this.resolveDefaultModelSelection(preferredBackendType);
  }
}
