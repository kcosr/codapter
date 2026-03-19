#!/usr/bin/env node
// stdio-tap.mjs — sit between the GUI and the real CLI, logging both directions.
//
// Usage:  CODEX_CLI_PATH=./scripts/stdio-tap.mjs /Applications/Codex.app/Contents/MacOS/Codex
//
// Set TAP_TARGET to the real CLI binary (default: codapter.mjs in same dir)
// Set TAP_LOG to the log file path (default: /tmp/stdio-tap.log)

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createInterface } from "node:readline";

const target = process.env.TAP_TARGET || "/usr/local/bin/codapter.mjs";
const logPath = process.env.TAP_LOG || "/tmp/stdio-tap.log";

const log = createWriteStream(logPath, { flags: "a" });

function ts() {
  return new Date().toISOString();
}

// Spawn the real CLI, passing through args and env
const child = spawn(target, process.argv.slice(2), {
  env: { ...process.env, CODAPTER_DEBUG_LOG_FILE: undefined },
  stdio: ["pipe", "pipe", "pipe"],
});

// GUI stdin → log + child stdin
const rlIn = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
rlIn.on("line", (line) => {
  log.write(`[${ts()}] GUI→CLI: ${line}\n`);
  child.stdin.write(`${line}\n`);
});
rlIn.on("close", () => {
  child.stdin.end();
});

// child stdout → log + GUI stdout
const rlOut = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
rlOut.on("line", (line) => {
  log.write(`[${ts()}] CLI→GUI: ${line}\n`);
  process.stdout.write(`${line}\n`);
});

// child stderr → log
const rlErr = createInterface({ input: child.stderr, crlfDelay: Number.POSITIVE_INFINITY });
rlErr.on("line", (line) => {
  log.write(`[${ts()}] CLI.err: ${line}\n`);
});

child.on("exit", (code, signal) => {
  log.write(`[${ts()}] CLI exited code=${code} signal=${signal}\n`);
  log.end(() => process.exit(code ?? 1));
});

process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
