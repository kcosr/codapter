import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryConfigStore } from "../src/config-store.js";

describe("InMemoryConfigStore", () => {
  it("persists config values to disk across instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-config-store-"));
    const filePath = join(directory, "config.toml");

    try {
      const first = new InMemoryConfigStore(filePath);
      first.writeBatch({
        edits: [
          {
            keyPath: "model",
            value: "openai-codex/gpt-5.4",
            mergeStrategy: "upsert",
          },
          {
            keyPath: "model_reasoning_effort",
            value: "medium",
            mergeStrategy: "upsert",
          },
        ],
        filePath: null,
        expectedVersion: null,
      });

      const raw = await readFile(filePath, "utf8");
      expect(raw).toContain('model = "openai-codex/gpt-5.4"');
      expect(raw).toContain('model_reasoning_effort = "medium"');

      const second = new InMemoryConfigStore(filePath);
      expect(second.read({ includeLayers: false, cwd: null }).config).toMatchObject({
        model: "openai-codex/gpt-5.4",
        model_reasoning_effort: "medium",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
