#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

function usage() {
  console.error(`Usage:
  node scripts/gui-audit.mjs collect --scenario <name> --artifact-dir <dir> --stdio-log <path> [--debug-log <path>] [--snapshot <path>] [--screenshot <path>] [--session-log <path> ...]
  node scripts/gui-audit.mjs compare --baseline <summary.json> --candidate <summary.json>`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command) {
    usage();
  }

  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      usage();
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      usage();
    }
    const key = arg.slice(2);
    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      flags[key] = [existing, value];
    }
    index += 1;
  }

  return { command, flags };
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function readOptionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalStrings(value) {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => typeof entry === "string" && entry.length > 0);
  }
  return [];
}

const INTERNAL_TITLE_THREAD_PROMPT_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt, and your job is to provide a short title for a task";
const INTERNAL_TITLE_THREAD_PROMPT_MARKER = "Generate a concise UI title";

function isInternalTitlePrompt(text) {
  const normalized = text.trim();
  return (
    normalized.startsWith(INTERNAL_TITLE_THREAD_PROMPT_PREFIX) &&
    normalized.includes(INTERNAL_TITLE_THREAD_PROMPT_MARKER)
  );
}

function inputContainsInternalTitlePrompt(input) {
  if (!Array.isArray(input)) {
    return false;
  }
  return input.some((entry) =>
    isRecord(entry) && entry.type === "text" && typeof entry.text === "string"
      ? isInternalTitlePrompt(entry.text)
      : false
  );
}

function createNormalizer() {
  const uuidMap = new Map();
  const pathMap = new Map();
  const numberMap = new Map();
  const uuidCounter = 0;
  const pathCounter = 0;
  const numberCounter = 0;

  const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
  const PATH_RE =
    /\b(?:\/Users\/[^\s"]+|\/var\/folders\/[^\s"]+|\/private\/tmp\/[^\s"]+|\/tmp\/[^\s"]+)\b/g;
  const LARGE_NUMBER_RE = /\b\d{10,}\b/g;

  const mapValue = (source, table, nextLabel) => {
    if (!table.has(source)) {
      table.set(source, nextLabel(table.size + 1));
    }
    return table.get(source);
  };

  const normalizeString = (value) =>
    value
      .replace(ISO_RE, "<timestamp>")
      .replace(UUID_RE, (match) => mapValue(match, uuidMap, (index) => `<id:${index}>`))
      .replace(PATH_RE, (match) => {
        const filename = basename(match);
        return mapValue(match, pathMap, (index) => `<path:${index}:${filename || "value"}>`);
      })
      .replace(LARGE_NUMBER_RE, (match) => {
        if (match.length < 13) {
          return match;
        }
        return mapValue(match, numberMap, (index) => `<n:${index}>`);
      });

  const normalize = (value) => {
    if (typeof value === "string") {
      return normalizeString(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => normalize(entry));
    }
    if (!isRecord(value)) {
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry)]));
  };

  return normalize;
}

function parseTapEntries(raw) {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^\[(.+?)\] (GUI→CLI|CLI→GUI|CLI\.err): (.+)$/);
      if (!match) {
        return { timestamp: null, direction: "unknown", raw: line, parsed: null };
      }
      const [, timestamp, direction, payload] = match;
      try {
        return {
          timestamp,
          direction,
          raw: payload,
          parsed: JSON.parse(payload),
        };
      } catch {
        return {
          timestamp,
          direction,
          raw: payload,
          parsed: null,
        };
      }
    });
}

function summarizeThread(thread, normalize) {
  if (!isRecord(thread)) {
    return normalize(thread);
  }
  const source =
    typeof thread.source === "string"
      ? thread.source
      : isRecord(thread.source) &&
          isRecord(thread.source.subAgent) &&
          isRecord(thread.source.subAgent.thread_spawn)
        ? {
            type: "subAgent",
            parentThreadId: normalize(thread.source.subAgent.thread_spawn.parent_thread_id ?? null),
            depth: normalize(thread.source.subAgent.thread_spawn.depth ?? null),
            agentNickname: normalize(thread.source.subAgent.thread_spawn.agent_nickname ?? null),
            agentRole: normalize(thread.source.subAgent.thread_spawn.agent_role ?? null),
          }
        : normalize(thread.source);
  return {
    id: normalize(thread.id ?? null),
    preview: normalize(readOptionalString(thread.preview) ?? ""),
    source,
    agentNickname: normalize(readOptionalString(thread.agentNickname) ?? null),
    modelProvider: normalize(readOptionalString(thread.modelProvider) ?? null),
    path: typeof thread.path === "string" ? "<present>" : thread.path,
  };
}

function summarizeItem(item, normalize) {
  if (!isRecord(item)) {
    return normalize(item);
  }

  const type = readOptionalString(item.type) ?? "unknown";
  switch (type) {
    case "userMessage":
      return {
        type,
        content: normalize(item.content ?? null),
      };
    case "agentMessage":
      return {
        type,
        text: normalize(readOptionalString(item.text) ?? ""),
      };
    case "commandExecution":
      return {
        type,
        command: normalize(readOptionalString(item.command) ?? ""),
        status: normalize(readOptionalString(item.status) ?? null),
        aggregatedOutput: normalize(readOptionalString(item.aggregatedOutput) ?? null),
        exitCode: normalize(item.exitCode ?? null),
      };
    case "fileChange":
      return {
        type,
        status: normalize(readOptionalString(item.status) ?? null),
        changes: normalize(item.changes ?? []),
      };
    case "collabAgentToolCall":
      return {
        type,
        tool: normalize(readOptionalString(item.tool) ?? null),
        status: normalize(readOptionalString(item.status) ?? null),
        senderThreadId: normalize(readOptionalString(item.senderThreadId) ?? null),
        receiverThreadIds: normalize(item.receiverThreadIds ?? []),
        model: normalize(readOptionalString(item.model) ?? null),
        agentsStates: normalize(item.agentsStates ?? null),
      };
    default:
      return normalize(item);
  }
}

function safeParseJsonString(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function summarizeFunctionArguments(raw, normalize) {
  const parsed = safeParseJsonString(raw);
  return normalize(parsed ?? raw);
}

function summarizeFunctionOutput(name, raw, normalize) {
  const parsed = safeParseJsonString(raw);
  if (parsed !== null) {
    return normalize(parsed);
  }

  if (typeof raw !== "string") {
    return normalize(raw);
  }

  if (name === "exec_command") {
    const stdoutMatch = raw.match(/\nOutput:\n([\s\S]*)$/);
    const exitCodeMatch = raw.match(/Process exited with code (\d+)/);
    return {
      exitCode: exitCodeMatch ? Number(exitCodeMatch[1]) : null,
      stdout: normalize(stdoutMatch ? stdoutMatch[1] : raw),
    };
  }

  return normalize(raw);
}

function summarizeSessionMeta(payload, normalize) {
  const source =
    isRecord(payload?.source) &&
    isRecord(payload.source.subagent) &&
    isRecord(payload.source.subagent.thread_spawn)
      ? {
          type: "subAgent",
          parentThreadId: normalize(payload.source.subagent.thread_spawn.parent_thread_id ?? null),
          depth: normalize(payload.source.subagent.thread_spawn.depth ?? null),
          agentNickname: normalize(payload.source.subagent.thread_spawn.agent_nickname ?? null),
          agentRole: normalize(payload.source.subagent.thread_spawn.agent_role ?? null),
        }
      : normalize(payload?.source ?? null);

  return {
    id: normalize(payload?.id ?? null),
    agentNickname: normalize(payload?.agent_nickname ?? null),
    agentRole: normalize(payload?.agent_role ?? null),
    modelProvider: normalize(payload?.model_provider ?? null),
    cwd: normalize(payload?.cwd ?? null),
    source,
  };
}

function summarizeCodexSessionLog(raw) {
  const normalize = createNormalizer();
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    });

  const functionCalls = [];
  const functionOutputs = [];
  const taskCompletions = [];
  const finalAgentMessages = [];
  const turnContexts = [];
  let session = null;
  let lastEventType = null;

  for (const entry of lines) {
    if (!isRecord(entry)) {
      continue;
    }

    if (entry.type === "session_meta" && isRecord(entry.payload)) {
      session = summarizeSessionMeta(entry.payload, normalize);
      lastEventType = "session_meta";
      continue;
    }

    if (entry.type === "turn_context" && isRecord(entry.payload)) {
      turnContexts.push({
        turnId: normalize(entry.payload.turn_id ?? null),
        model: normalize(entry.payload.model ?? null),
        effort: normalize(entry.payload.effort ?? null),
        summary: normalize(entry.payload.summary ?? null),
        collaborationMode: normalize(entry.payload.collaboration_mode ?? null),
      });
      lastEventType = "turn_context";
      continue;
    }

    if (
      entry.type === "response_item" &&
      isRecord(entry.payload) &&
      entry.payload.type === "function_call"
    ) {
      functionCalls.push({
        name: normalize(entry.payload.name ?? null),
        callId: normalize(entry.payload.call_id ?? null),
        arguments: summarizeFunctionArguments(entry.payload.arguments ?? null, normalize),
      });
      lastEventType = `function_call:${String(entry.payload.name ?? "unknown")}`;
      continue;
    }

    if (
      entry.type === "response_item" &&
      isRecord(entry.payload) &&
      entry.payload.type === "function_call_output"
    ) {
      const matchingCall = [...functionCalls]
        .reverse()
        .find((call) => call.callId === normalize(entry.payload.call_id ?? null));
      const functionName =
        typeof matchingCall?.name === "string" && matchingCall.name.length > 0
          ? matchingCall.name
          : "unknown";
      functionOutputs.push({
        name: functionName,
        callId: normalize(entry.payload.call_id ?? null),
        output: summarizeFunctionOutput(functionName, entry.payload.output ?? null, normalize),
      });
      lastEventType = `function_call_output:${functionName}`;
      continue;
    }

    if (
      entry.type === "event_msg" &&
      isRecord(entry.payload) &&
      entry.payload.type === "agent_message"
    ) {
      if (entry.payload.phase === "final_answer") {
        finalAgentMessages.push({
          message: normalize(entry.payload.message ?? null),
        });
      }
      lastEventType = `agent_message:${String(entry.payload.phase ?? "unknown")}`;
      continue;
    }

    if (
      entry.type === "event_msg" &&
      isRecord(entry.payload) &&
      entry.payload.type === "task_complete"
    ) {
      taskCompletions.push({
        turnId: normalize(entry.payload.turn_id ?? null),
        lastAgentMessage: normalize(entry.payload.last_agent_message ?? null),
      });
      lastEventType = "task_complete";
    }
  }

  return {
    session,
    turnContexts,
    functionCalls,
    functionOutputs,
    finalAgentMessages,
    taskCompletions,
    lastEventType,
    endedWithoutCompletion:
      functionCalls.some((call) => call.name === "exec_command") &&
      finalAgentMessages.length === 0 &&
      taskCompletions.length === 0,
  };
}

function summarizeResponse(method, result, normalize) {
  switch (method) {
    case "model/list":
      return {
        method,
        models: Array.isArray(result?.data)
          ? result.data.map((entry) => ({
              id: normalize(entry.id ?? null),
              displayName: normalize(entry.displayName ?? null),
            }))
          : [],
      };
    case "thread/start":
    case "thread/resume":
    case "thread/read":
      return {
        method,
        thread: summarizeThread(result?.thread ?? null, normalize),
        model: normalize(result?.model ?? null),
        reasoningEffort: normalize(result?.reasoningEffort ?? null),
      };
    case "turn/start":
      return {
        method,
        turnId: normalize(result?.turn?.id ?? null),
      };
    default:
      return {
        method,
        result: normalize(result),
      };
  }
}

function summarizeNotification(method, params, normalize) {
  switch (method) {
    case "thread/started":
      return {
        method,
        thread: summarizeThread(params?.thread ?? null, normalize),
      };
    case "thread/status/changed":
      return {
        method,
        threadId: normalize(params?.threadId ?? null),
        status: normalize(params?.status ?? null),
      };
    case "turn/started":
    case "turn/completed":
      return {
        method,
        threadId: normalize(params?.threadId ?? null),
        turnId: normalize(params?.turnId ?? null),
        status: normalize(params?.turn?.status ?? null),
      };
    case "item/started":
    case "item/completed":
      return {
        method,
        threadId: normalize(params?.threadId ?? null),
        turnId: normalize(params?.turnId ?? null),
        item: summarizeItem(params?.item ?? null, normalize),
      };
    case "item/agentMessage/delta":
    case "item/reasoning/summaryTextDelta":
      return {
        method,
        threadId: normalize(params?.threadId ?? null),
        turnId: normalize(params?.turnId ?? null),
        itemId: normalize(params?.itemId ?? null),
        delta: normalize(params?.delta ?? null),
      };
    default:
      return {
        method,
        params: normalize(params),
      };
  }
}

function summarizeTapLog(raw) {
  const normalize = createNormalizer();
  const requestMethods = new Map();
  const internalThreadIds = new Set();
  const entries = parseTapEntries(raw);
  const requests = [];
  const responses = [];
  const notifications = [];
  const stderr = [];

  for (const entry of entries) {
    if (
      entry.direction === "GUI→CLI" &&
      isRecord(entry.parsed) &&
      typeof entry.parsed.method === "string"
    ) {
      requestMethods.set(entry.parsed.id ?? `${requests.length}`, entry.parsed.method);
      if (
        entry.parsed.method === "turn/start" &&
        isRecord(entry.parsed.params) &&
        typeof entry.parsed.params.threadId === "string" &&
        inputContainsInternalTitlePrompt(entry.parsed.params.input)
      ) {
        internalThreadIds.add(entry.parsed.params.threadId);
      }
      requests.push({
        method: entry.parsed.method,
        params: normalize(entry.parsed.params ?? null),
      });
      continue;
    }

    if (
      entry.direction === "CLI→GUI" &&
      isRecord(entry.parsed) &&
      typeof entry.parsed.method === "string"
    ) {
      notifications.push(
        summarizeNotification(entry.parsed.method, entry.parsed.params ?? null, normalize)
      );
      continue;
    }

    if (entry.direction === "CLI→GUI" && isRecord(entry.parsed) && "id" in entry.parsed) {
      const method = requestMethods.get(entry.parsed.id ?? null) ?? "<unknown>";
      responses.push(summarizeResponse(method, entry.parsed.result ?? null, normalize));
      continue;
    }

    if (entry.direction === "CLI.err") {
      stderr.push(normalize(entry.raw));
    }
  }

  return {
    requestCount: requests.length,
    responseCount: responses.length,
    notificationCount: notifications.length,
    internalThreadIds: [...internalThreadIds].map((threadId) => normalize(threadId)),
    requests,
    responses,
    notifications,
    stderr,
  };
}

function extractThreadIdsFromValue(value, threadIds = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("<id:")) {
      threadIds.add(value);
    }
    return threadIds;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      extractThreadIdsFromValue(entry, threadIds);
    }
    return threadIds;
  }
  if (!isRecord(value)) {
    return threadIds;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "threadId" ||
        key === "id" ||
        key === "senderThreadId" ||
        key === "parentThreadId") &&
      typeof entry === "string" &&
      entry.startsWith("<id:")
    ) {
      threadIds.add(entry);
    }
    extractThreadIdsFromValue(entry, threadIds);
  }
  return threadIds;
}

function buildFocusedThreadFlow(tapSummary) {
  const internalThreadIds = new Set(tapSummary.internalThreadIds ?? []);
  const latestThreadStart = [...tapSummary.responses]
    .reverse()
    .find(
      (entry) =>
        entry.method === "thread/start" &&
        typeof entry.thread?.id === "string" &&
        !internalThreadIds.has(entry.thread.id)
    );
  const rootThreadId = latestThreadStart?.thread?.id ?? null;
  if (!rootThreadId) {
    return null;
  }

  const threadIds = new Set([rootThreadId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const notification of tapSummary.notifications) {
      if (
        notification.method === "thread/started" &&
        isRecord(notification.thread?.source) &&
        notification.thread.source.type === "subAgent" &&
        typeof notification.thread?.id === "string" &&
        typeof notification.thread.source.parentThreadId === "string" &&
        threadIds.has(notification.thread.source.parentThreadId) &&
        !threadIds.has(notification.thread.id)
      ) {
        threadIds.add(notification.thread.id);
        changed = true;
      }
      if (
        notification.method === "item/completed" &&
        isRecord(notification.item) &&
        notification.item.type === "collabAgentToolCall" &&
        typeof notification.threadId === "string" &&
        threadIds.has(notification.threadId)
      ) {
        for (const childId of notification.item.receiverThreadIds ?? []) {
          if (typeof childId === "string" && !threadIds.has(childId)) {
            threadIds.add(childId);
            changed = true;
          }
        }
      }
    }
  }

  const responses = tapSummary.responses.filter((entry) => {
    if (typeof entry.thread?.id === "string" && internalThreadIds.has(entry.thread.id)) {
      return false;
    }
    if (entry.method === "thread/start") {
      return true;
    }
    const ids = extractThreadIdsFromValue(entry);
    return [...ids].some((id) => threadIds.has(id) && !internalThreadIds.has(id));
  });
  const notifications = tapSummary.notifications.filter((entry) => {
    const ids = extractThreadIdsFromValue(entry);
    return [...ids].some((id) => threadIds.has(id) && !internalThreadIds.has(id));
  });

  return {
    rootThreadId,
    threadIds: [...threadIds],
    internalThreadIds: [...internalThreadIds],
    responses,
    notifications,
  };
}

function summarizeDebugLog(raw) {
  const normalize = createNormalizer();
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
    .map((entry) => {
      if (!isRecord(entry)) {
        return normalize(entry);
      }
      if (entry.kind === "notification") {
        return {
          component: normalize(entry.component ?? null),
          kind: "notification",
          method: normalize(entry.method ?? null),
          payload:
            entry.method === "thread/started"
              ? { thread: summarizeThread(entry.payload?.thread ?? null, normalize) }
              : entry.method === "item/completed" || entry.method === "item/started"
                ? {
                    threadId: normalize(entry.payload?.threadId ?? null),
                    turnId: normalize(entry.payload?.turnId ?? null),
                    item: summarizeItem(entry.payload?.item ?? null, normalize),
                  }
                : normalize(entry.payload ?? null),
        };
      }
      if (entry.kind === "backend-event") {
        return {
          component: normalize(entry.component ?? null),
          kind: "backend-event",
          method: normalize(entry.method ?? null),
          payload:
            entry.payload?.method === "item/completed" || entry.payload?.method === "item/started"
              ? {
                  method: normalize(entry.payload.method ?? null),
                  item: summarizeItem(entry.payload.params?.item ?? null, normalize),
                }
              : normalize(entry.payload ?? null),
        };
      }
      return normalize(entry);
    });
}

function diffJson(path, baseline, candidate, differences) {
  if (Object.is(baseline, candidate)) {
    return;
  }

  if (Array.isArray(baseline) && Array.isArray(candidate)) {
    if (baseline.length !== candidate.length) {
      differences.push(`${path}: length ${baseline.length} != ${candidate.length}`);
    }
    const limit = Math.max(baseline.length, candidate.length);
    for (let index = 0; index < limit; index += 1) {
      diffJson(`${path}[${index}]`, baseline[index], candidate[index], differences);
      if (differences.length >= 50) {
        return;
      }
    }
    return;
  }

  if (isRecord(baseline) && isRecord(candidate)) {
    const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
    for (const key of [...keys].sort()) {
      diffJson(path ? `${path}.${key}` : key, baseline[key], candidate[key], differences);
      if (differences.length >= 50) {
        return;
      }
    }
    return;
  }

  differences.push(`${path}: ${JSON.stringify(baseline)} != ${JSON.stringify(candidate)}`);
}

async function collect(flags) {
  const scenario = readOptionalString(flags.scenario);
  const artifactDir = readOptionalString(flags["artifact-dir"]);
  const stdioLog = readOptionalString(flags["stdio-log"]);
  if (!scenario || !artifactDir || !stdioLog) {
    usage();
  }

  const scenarioDir = resolve(
    artifactDir,
    `${scenario}-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  const rawDir = join(scenarioDir, "raw");
  await mkdir(rawDir, { recursive: true });

  const stdioTarget = join(rawDir, basename(stdioLog));
  await copyFile(resolve(stdioLog), stdioTarget);

  let debugSummary = null;
  const debugLog = readOptionalString(flags["debug-log"]);
  if (debugLog) {
    const debugTarget = join(rawDir, basename(debugLog));
    await copyFile(resolve(debugLog), debugTarget);
    debugSummary = summarizeDebugLog(await readFile(resolve(debugLog), "utf8"));
  }

  const sessionLogs = readOptionalStrings(flags["session-log"]);
  const sessionSummaries = [];
  for (const sessionLog of sessionLogs) {
    const sessionTarget = join(rawDir, basename(sessionLog));
    await copyFile(resolve(sessionLog), sessionTarget);
    sessionSummaries.push(summarizeCodexSessionLog(await readFile(resolve(sessionLog), "utf8")));
  }

  const snapshot = readOptionalString(flags.snapshot);
  if (snapshot) {
    await copyFile(resolve(snapshot), join(rawDir, basename(snapshot)));
  }
  const screenshot = readOptionalString(flags.screenshot);
  if (screenshot) {
    await copyFile(resolve(screenshot), join(rawDir, basename(screenshot)));
  }

  const summary = {
    scenario,
    createdAt: new Date().toISOString(),
    tap: summarizeTapLog(await readFile(resolve(stdioLog), "utf8")),
    debug: debugSummary,
    sessions: sessionSummaries,
  };
  summary.focus = buildFocusedThreadFlow(summary.tap);

  await writeFile(
    join(scenarioDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    join(scenarioDir, "metadata.json"),
    `${JSON.stringify(
      {
        scenario,
        stdioLog: basename(stdioLog),
        debugLog: debugLog ? basename(debugLog) : null,
        sessionLogs: sessionLogs.map((entry) => basename(entry)),
        snapshot: snapshot ? basename(snapshot) : null,
        screenshot: screenshot ? basename(screenshot) : null,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(scenarioDir);
}

async function compare(flags) {
  const baselinePath = readOptionalString(flags.baseline);
  const candidatePath = readOptionalString(flags.candidate);
  if (!baselinePath || !candidatePath) {
    usage();
  }

  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
  const candidate = JSON.parse(await readFile(resolve(candidatePath), "utf8"));
  const differences = [];
  const baselineResponses = baseline.focus?.responses ?? baseline.tap?.responses ?? [];
  const candidateResponses = candidate.focus?.responses ?? candidate.tap?.responses ?? [];
  const baselineNotifications = baseline.focus?.notifications ?? baseline.tap?.notifications ?? [];
  const candidateNotifications =
    candidate.focus?.notifications ?? candidate.tap?.notifications ?? [];
  const baselineSessions = baseline.sessions ?? [];
  const candidateSessions = candidate.sessions ?? [];
  diffJson("responses", baselineResponses, candidateResponses, differences);
  diffJson("notifications", baselineNotifications, candidateNotifications, differences);
  diffJson("sessions", baselineSessions, candidateSessions, differences);

  if (differences.length === 0) {
    console.log("No normalized GUI protocol differences detected.");
    return;
  }

  console.error("Normalized GUI protocol differences:");
  for (const difference of differences) {
    console.error(`- ${difference}`);
  }
  process.exit(1);
}

const { command, flags } = parseArgs(process.argv.slice(2));

switch (command) {
  case "collect":
    await collect(flags);
    break;
  case "compare":
    await compare(flags);
    break;
  default:
    usage();
}
