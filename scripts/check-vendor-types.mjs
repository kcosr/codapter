#!/usr/bin/env node
import { access } from "node:fs/promises";
import path from "node:path";

const REQUIRED_OUTPUTS = ["types/codex/_provenance.json", "types/pi/_provenance.json"];

try {
  await Promise.all(
    REQUIRED_OUTPUTS.map(async (relativePath) => {
      await access(path.resolve(process.cwd(), relativePath));
    })
  );
} catch {
  console.error("Vendored types are missing. Run `npm run vendor-types` before building.");
  process.exitCode = 1;
}
