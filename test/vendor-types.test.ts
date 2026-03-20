import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = path.resolve("scripts/vendor-types.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Codapter Tests",
  GIT_AUTHOR_EMAIL: "tests@example.com",
  GIT_COMMITTER_NAME: "Codapter Tests",
  GIT_COMMITTER_EMAIL: "tests@example.com",
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await runCommand("rm", ["-rf", dir], process.cwd());
    })
  );
});

describe("vendor-types script", () => {
  it("generates deterministic vendored output for copy and extract entrypoints", async () => {
    const rootDir = await createTempDir();
    const repoDir = path.join(rootDir, "fixture-repo");
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(
      path.join(repoDir, "src", "entry.ts"),
      [
        'import type { Helper } from "./helper";',
        "",
        "export interface Entry {",
        "  helper: Helper;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repoDir, "src", "helper.ts"),
      ["export interface Helper {", "  value: string;", "}", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repoDir, "src", "rpc-types.ts"),
      [
        "export interface ImageContent {",
        '  type: "image";',
        "  data: string;",
        "  mimeType: string;",
        "}",
        "",
        "export type RpcExtensionUIResponse =",
        '  | { type: "extension_ui_response"; id: string; value: string }',
        '  | { type: "extension_ui_response"; id: string; confirmed: boolean };',
        "",
        'export type Status = "ok" | "error";',
        "",
        "export interface Message {",
        "  status: Status;",
        "  image: ImageContent;",
        "}",
        "",
        "export type MessageEvent =",
        '  | { type: "delta"; partial: Message }',
        '  | { type: "done"; message: Message };',
        "",
        "export interface CycleA {",
        "  next?: CycleB;",
        "}",
        "",
        "export interface CycleB {",
        "  next?: CycleA;",
        "}",
        "",
        "export type CycleEvent = { cycle: CycleA };",
        "",
      ].join("\n"),
      "utf8"
    );

    const commit = await createGitCommit(repoDir);
    const manifestPath = path.join(rootDir, "vendor-types.manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          targets: {
            fixtureCopy: {
              repo: toFileRepoUrl(repoDir),
              commit,
              outputRoot: "generated/copy",
              entrypoints: [{ source: "src/entry.ts", mode: "copy" }],
            },
            fixtureExtract: {
              repo: toFileRepoUrl(repoDir),
              commit,
              outputRoot: "generated/extract",
              entrypoints: [
                {
                  source: "src/rpc-types.ts",
                  mode: "extract",
                  exports: ["ImageContent", "RpcExtensionUIResponse", "MessageEvent", "CycleEvent"],
                },
              ],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const firstRun = await runNodeScript(["--manifest", manifestPath], rootDir);
    expect(firstRun.exitCode).toBe(0);

    const copiedEntry = await readFile(
      path.join(rootDir, "generated", "copy", "src", "entry.d.ts"),
      "utf8"
    );
    const copiedHelper = await readFile(
      path.join(rootDir, "generated", "copy", "src", "helper.d.ts"),
      "utf8"
    );
    const extractedTypes = await readFile(
      path.join(rootDir, "generated", "extract", "src", "rpc-types.d.ts"),
      "utf8"
    );
    const provenance = JSON.parse(
      await readFile(path.join(rootDir, "generated", "copy", "_provenance.json"), "utf8")
    ) as { outputFiles: string[] };

    expect(copiedEntry).toContain('from "./helper.js"');
    expect(copiedHelper).toContain("export interface Helper");
    expect(extractedTypes).toContain("export interface ImageContent");
    expect(extractedTypes).toContain("export type RpcExtensionUIResponse");
    expect(extractedTypes).toContain('export type Status = "ok" | "error";');
    expect(extractedTypes).toContain("export interface Message {");
    expect(extractedTypes).toContain("export type MessageEvent =");
    expect(extractedTypes).toContain("export interface CycleA {");
    expect(extractedTypes).toContain("export interface CycleB {");
    expect(extractedTypes).toContain("export type CycleEvent = { cycle: CycleA };");
    expect(extractedTypes).not.toContain("import ");
    expect(extractedTypes.indexOf('export type Status = "ok" | "error";')).toBeLessThan(
      extractedTypes.indexOf("export interface Message {")
    );
    expect(extractedTypes.indexOf("export interface Message {")).toBeLessThan(
      extractedTypes.indexOf("export type MessageEvent =")
    );
    expect(provenance.outputFiles).toEqual(["src/entry.d.ts", "src/helper.d.ts"]);

    const beforeSecondRun = await readFile(
      path.join(rootDir, "generated", "copy", "src", "entry.d.ts"),
      "utf8"
    );
    const secondRun = await runNodeScript(["--manifest", manifestPath], rootDir);
    expect(secondRun.exitCode).toBe(0);
    const afterSecondRun = await readFile(
      path.join(rootDir, "generated", "copy", "src", "entry.d.ts"),
      "utf8"
    );

    expect(afterSecondRun).toBe(beforeSecondRun);
  });

  it("fails loudly on malformed manifests", async () => {
    const rootDir = await createTempDir();
    const manifestPath = path.join(rootDir, "vendor-types.manifest.json");
    await writeFile(manifestPath, JSON.stringify({ version: 1, targets: {} }, null, 2), "utf8");

    const result = await runNodeScript(["--manifest", manifestPath], rootDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Manifest must define at least one target");
  });

  it("fails loudly when an upstream file is missing", async () => {
    const rootDir = await createTempDir();
    const repoDir = path.join(rootDir, "fixture-repo");
    await mkdir(repoDir, { recursive: true });
    await writeFile(path.join(repoDir, "README.md"), "fixture\n", "utf8");

    const commit = await createGitCommit(repoDir);
    const manifestPath = path.join(rootDir, "vendor-types.manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          targets: {
            fixture: {
              repo: toFileRepoUrl(repoDir),
              commit,
              outputRoot: "generated/types",
              entrypoints: [{ source: "src/missing.ts", mode: "copy" }],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runNodeScript(["--manifest", manifestPath], rootDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("could not read src/missing.ts");
  });

  it("fails loudly when extract mode depends on imported types", async () => {
    const rootDir = await createTempDir();
    const repoDir = path.join(rootDir, "fixture-repo");
    await mkdir(path.join(repoDir, "src"), { recursive: true });
    await writeFile(
      path.join(repoDir, "src", "shared.ts"),
      ["export interface Shared {", "  value: string;", "}", ""].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(repoDir, "src", "types.ts"),
      [
        'import type { Shared } from "./shared";',
        "",
        "export interface NeedsShared {",
        "  shared: Shared;",
        "}",
        "",
      ].join("\n"),
      "utf8"
    );

    const commit = await createGitCommit(repoDir);
    const manifestPath = path.join(rootDir, "vendor-types.manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          targets: {
            fixture: {
              repo: toFileRepoUrl(repoDir),
              commit,
              outputRoot: "generated/extract",
              entrypoints: [
                {
                  source: "src/types.ts",
                  mode: "extract",
                  exports: ["NeedsShared"],
                },
              ],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runNodeScript(["--manifest", manifestPath], rootDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Target fixture entrypoint src/types.ts extract mode references imported types: Shared from ./shared"
    );
  });

  it("fails loudly when the upstream repo is unreachable", async () => {
    const rootDir = await createTempDir();
    const manifestPath = path.join(rootDir, "vendor-types.manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          targets: {
            fixture: {
              repo: "file:///definitely/missing/repo.git",
              commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
              outputRoot: "generated/types",
              entrypoints: [{ source: "src/entry.ts", mode: "copy" }],
            },
          },
        },
        null,
        2
      ),
      "utf8"
    );

    const result = await runNodeScript(["--manifest", manifestPath], rootDir);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "git fetch --depth 1 origin deadbeefdeadbeefdeadbeefdeadbeefdeadbeef failed"
    );
  });
});

async function createTempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "codapter-vendor-types-"));
  tempDirs.push(dir);
  return dir;
}

async function createGitCommit(repoDir: string) {
  await runCommand("git", ["init", "--quiet"], repoDir, GIT_ENV);
  await runCommand("git", ["add", "."], repoDir, GIT_ENV);
  await runCommand("git", ["commit", "-m", "fixture"], repoDir, GIT_ENV);
  const revision = await runCommand("git", ["rev-parse", "HEAD"], repoDir, GIT_ENV);
  return revision.stdout.trim();
}

function toFileRepoUrl(repoDir: string) {
  return new URL(`file://${repoDir}`).toString();
}

async function runNodeScript(args: string[], cwd: string) {
  return await runCommand(process.execPath, [SCRIPT_PATH, ...args], cwd);
}

async function runCommand(command: string, args: string[], cwd: string, env = process.env) {
  return await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 1 });
    });
  });
}
