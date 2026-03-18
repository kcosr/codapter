import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRegistry } from "../src/thread-registry.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createRegistry() {
  const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
  tempDirs.push(directory);
  return new ThreadRegistry(join(directory, "threads.json"));
}

describe("ThreadRegistry", () => {
  it("creates, reads, updates, lists, and deletes entries", async () => {
    const registry = await createRegistry();
    const created = await registry.create({
      backendSessionId: "session_1",
      backendType: "pi",
      cwd: "/repo",
      preview: "hello",
      gitInfo: null,
    });

    expect(created.threadId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    expect(await registry.get(created.threadId)).toMatchObject({
      backendSessionId: "session_1",
      backendType: "pi",
      hidden: false,
      cwd: "/repo",
      preview: "hello",
      archived: false,
    });

    const updated = await registry.update(created.threadId, {
      archived: true,
      name: "Renamed",
      modelProvider: "openai",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
    });
    expect(updated).toMatchObject({
      archived: true,
      name: "Renamed",
      modelProvider: "openai",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
    });

    expect(await registry.list()).toHaveLength(1);

    await registry.delete(created.threadId);
    expect(await registry.get(created.threadId)).toBeNull();
    expect(await registry.list()).toHaveLength(0);
  });

  it("recovers from a corrupt registry file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
    tempDirs.push(directory);

    const filePath = join(directory, "threads.json");
    await writeFile(filePath, "{not-json", "utf8");

    const warn = vi.fn();
    const registry = new ThreadRegistry(filePath, { warn });

    expect(await registry.list()).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips invalid entries and keeps valid entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codapter-thread-registry-"));
    tempDirs.push(directory);

    const filePath = join(directory, "threads.json");
    await writeFile(
      filePath,
      JSON.stringify({
        threads: [
          {
            threadId: "thread_valid",
            backendSessionId: "session_valid",
            backendType: "pi",
            name: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            archived: false,
            cwd: null,
            preview: null,
            modelProvider: null,
            gitInfo: null,
          },
          {
            threadId: 123,
          },
        ],
      }),
      "utf8"
    );

    const warn = vi.fn();
    const registry = new ThreadRegistry(filePath, { warn });

    expect(await registry.list()).toHaveLength(1);
    expect(await registry.get("thread_valid")).toMatchObject({
      backendSessionId: "session_valid",
      hidden: false,
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("persists atomically to disk", async () => {
    const registry = await createRegistry();
    const created = await registry.create({
      backendSessionId: "session_2",
      backendType: "pi",
    });

    const payload = JSON.parse(await readFile(registry.path, "utf8")) as {
      threads: Array<{ threadId: string }>;
    };

    expect(payload.threads.map((entry) => entry.threadId)).toContain(created.threadId);
  });
});
