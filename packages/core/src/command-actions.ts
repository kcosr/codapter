import type { CommandAction } from "../../../types/codex/codex-rs/app-server-protocol/schema/typescript/v2/CommandAction.js";

const READ_COMMANDS = new Set(["awk", "bat", "cat", "head", "less", "more", "sed", "tail"]);
const LIST_COMMANDS = new Set(["fd", "find", "ls", "tree"]);
const SEARCH_COMMANDS = new Set(["ack", "ag", "grep", "rg", "ripgrep"]);

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      current += char;
      quote = char;
      continue;
    }

    if (
      char === ";" ||
      (char === "|" && next !== "|") ||
      (char === "|" && next === "|") ||
      (char === "&" && next === "&")
    ) {
      if (current.trim().length > 0) {
        segments.push(current.trim());
      }
      current = "";
      if ((char === "|" && next === "|") || (char === "&" && next === "&")) {
        index += 1;
      }
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    segments.push(current.trim());
  }

  return segments;
}

function tokenizeShell(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function positionalArguments(tokens: readonly string[]): string[] {
  return tokens.filter((token) => !token.startsWith("-"));
}

function inferReadAction(command: string, tokens: readonly string[]): CommandAction {
  const args = positionalArguments(tokens.slice(1));
  const path = args.at(-1) ?? "";
  return {
    type: "read",
    command,
    name: tokens[0] ?? "read",
    path,
  };
}

function inferListFilesAction(command: string, tokens: readonly string[]): CommandAction {
  const args = positionalArguments(tokens.slice(1));
  return {
    type: "listFiles",
    command,
    path: args[0] ?? null,
  };
}

function inferSearchAction(command: string, tokens: readonly string[]): CommandAction {
  const args = positionalArguments(tokens.slice(1));
  return {
    type: "search",
    command,
    query: args[0] ?? null,
    path: args[1] ?? null,
  };
}

function inferActionForSegment(segment: string): CommandAction {
  const tokens = tokenizeShell(segment);
  if (tokens.length === 0) {
    return { type: "unknown", command: segment };
  }

  const name = tokens[0].toLowerCase();
  if (READ_COMMANDS.has(name)) {
    return inferReadAction(segment, tokens);
  }
  if (LIST_COMMANDS.has(name)) {
    return inferListFilesAction(segment, tokens);
  }
  if (SEARCH_COMMANDS.has(name)) {
    return inferSearchAction(segment, tokens);
  }

  return {
    type: "unknown",
    command: segment,
  };
}

export function inferCommandActions(command: string): CommandAction[] {
  if (command.trim().length === 0) {
    return [];
  }

  return splitCommandSegments(command).map(inferActionForSegment);
}
