#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const SCRIPT_NAME = "scripts/vendor-types.mjs";
const DEFAULT_MANIFEST_PATH = "vendor-types.manifest.json";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(process.cwd(), options.manifestPath);
  const manifest = await readManifest(manifestPath);
  const targetEntries = Object.entries(manifest.targets);

  for (const [targetName, target] of targetEntries) {
    await generateTarget({
      targetName,
      target,
      manifestPath,
      repoRoot: process.cwd(),
    });
  }
}

function parseArgs(args) {
  let manifestPath = DEFAULT_MANIFEST_PATH;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Missing value for --manifest");
      }
      manifestPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { manifestPath };
}

async function readManifest(manifestPath) {
  let rawManifest;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read manifest at ${manifestPath}: ${toErrorMessage(error)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawManifest);
  } catch (error) {
    throw new Error(`Manifest is not valid JSON: ${toErrorMessage(error)}`);
  }

  validateManifest(parsed);
  return parsed;
}

function validateManifest(manifest) {
  if (!isRecord(manifest)) {
    throw new Error("Manifest must be an object");
  }

  if (manifest.version !== 1) {
    throw new Error("Manifest version must be 1");
  }

  if (!isRecord(manifest.targets) || Object.keys(manifest.targets).length === 0) {
    throw new Error("Manifest must define at least one target");
  }

  for (const [targetName, target] of Object.entries(manifest.targets)) {
    if (!isRecord(target)) {
      throw new Error(`Target ${targetName} must be an object`);
    }
    requireNonEmptyString(targetName, target.repo, "repo");
    requireNonEmptyString(targetName, target.commit, "commit");
    requireNonEmptyString(targetName, target.outputRoot, "outputRoot");

    if (!Array.isArray(target.entrypoints) || target.entrypoints.length === 0) {
      throw new Error(`Target ${targetName} must define at least one entrypoint`);
    }

    for (const entrypoint of target.entrypoints) {
      if (!isRecord(entrypoint)) {
        throw new Error(`Target ${targetName} has a malformed entrypoint`);
      }

      requireNonEmptyString(targetName, entrypoint.source, "entrypoints[].source");
      if (entrypoint.mode !== "copy" && entrypoint.mode !== "extract") {
        throw new Error(
          `Target ${targetName} entrypoint ${entrypoint.source} must use mode copy or extract`
        );
      }

      if (entrypoint.mode === "extract") {
        if (!Array.isArray(entrypoint.exports) || entrypoint.exports.length === 0) {
          throw new Error(
            `Target ${targetName} entrypoint ${entrypoint.source} must list exports for extract mode`
          );
        }
        for (const exportName of entrypoint.exports) {
          if (typeof exportName !== "string" || exportName.length === 0) {
            throw new Error(
              `Target ${targetName} entrypoint ${entrypoint.source} has an invalid extract export name`
            );
          }
        }
      }
    }
  }
}

function requireNonEmptyString(targetName, value, fieldName) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Target ${targetName} must define a non-empty ${fieldName}`);
  }
}

async function generateTarget({ targetName, target, manifestPath, repoRoot }) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), `codapter-vendor-${targetName}-`));
  const checkoutDir = path.join(tempRoot, "checkout");
  const outputRoot = path.resolve(repoRoot, target.outputRoot);

  try {
    await checkoutRepo(target.repo, target.commit, checkoutDir);
    await rm(outputRoot, { recursive: true, force: true });

    const copiedFiles = new Set();
    const copiedOutputFiles = [];

    for (const entrypoint of target.entrypoints) {
      if (entrypoint.mode === "copy") {
        await copyEntrypoint({
          checkoutDir,
          entrypoint,
          outputRoot,
          targetName,
          copiedFiles,
          copiedOutputFiles,
        });
        continue;
      }

      if (entrypoint.mode === "extract") {
        const outputPath = await extractEntrypoint({
          checkoutDir,
          entrypoint,
          outputRoot,
          targetName,
        });
        copiedOutputFiles.push(path.relative(outputRoot, outputPath));
      }
    }

    await writeProvenanceFile({
      outputRoot,
      targetName,
      target,
      manifestPath,
      outputFiles: copiedOutputFiles.sort(),
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function checkoutRepo(repo, commit, checkoutDir) {
  await mkdir(checkoutDir, { recursive: true });
  await runCommand("git", ["init", "--quiet"], { cwd: checkoutDir });
  await runCommand("git", ["remote", "add", "origin", repo], { cwd: checkoutDir });
  await runCommand("git", ["fetch", "--depth", "1", "origin", commit], { cwd: checkoutDir });
  await runCommand("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: checkoutDir });
}

async function copyEntrypoint({
  checkoutDir,
  entrypoint,
  outputRoot,
  targetName,
  copiedFiles,
  copiedOutputFiles,
}) {
  const pending = [normalizeSourcePath(entrypoint.source)];

  while (pending.length > 0) {
    const relativeSourcePath = pending.pop();
    if (!relativeSourcePath || copiedFiles.has(relativeSourcePath)) {
      continue;
    }

    copiedFiles.add(relativeSourcePath);
    const sourcePath = path.join(checkoutDir, relativeSourcePath);
    const sourceText = await readRequiredFile(sourcePath, targetName, relativeSourcePath);
    const rewrittenSource = rewriteRelativeImports(sourceText, sourcePath);
    const outputPath = toDeclarationOutputPath(outputRoot, relativeSourcePath);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rewrittenSource, "utf8");
    copiedOutputFiles.push(path.relative(outputRoot, outputPath));

    for (const dependency of collectRelativeDependencies(sourceText, sourcePath)) {
      pending.push(path.relative(checkoutDir, dependency));
    }
  }
}

async function extractEntrypoint({ checkoutDir, entrypoint, outputRoot, targetName }) {
  const relativeSourcePath = normalizeSourcePath(entrypoint.source);
  const sourcePath = path.join(checkoutDir, relativeSourcePath);
  const sourceText = await readRequiredFile(sourcePath, targetName, relativeSourcePath);
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const declarations = [];

  for (const exportName of entrypoint.exports) {
    const declaration = findExportedDeclaration(sourceFile, exportName);
    if (!declaration) {
      throw new Error(
        `Target ${targetName} entrypoint ${relativeSourcePath} does not export ${exportName}`
      );
    }
    declarations.push(declaration.getFullText(sourceFile).trim());
  }

  const outputPath = toDeclarationOutputPath(outputRoot, relativeSourcePath);
  const fileHeader = [
    "// Vendored by codapter. Do not edit by hand.",
    `// Source: ${relativeSourcePath}`,
    "",
  ].join("\n");
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${fileHeader}${declarations.join("\n\n")}\n`, "utf8");
  return outputPath;
}

function findExportedDeclaration(sourceFile, exportName) {
  for (const statement of sourceFile.statements) {
    if (!hasExportModifier(statement) || !statement.name || statement.name.text !== exportName) {
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      return statement;
    }
  }

  return null;
}

function hasExportModifier(statement) {
  return Boolean(
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function collectRelativeDependencies(sourceText, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const dependencies = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }

    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      continue;
    }

    dependencies.push(resolveRelativeModulePath(sourcePath, specifier));
  }

  return dependencies;
}

function rewriteRelativeImports(sourceText, sourcePath) {
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const edits = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      continue;
    }

    if (!statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) {
      continue;
    }

    edits.push({
      start: statement.moduleSpecifier.getStart(sourceFile) + 1,
      end: statement.moduleSpecifier.getEnd() - 1,
      text: toNodeNextDeclarationSpecifier(specifier),
    });
  }

  if (edits.length === 0) {
    return sourceText;
  }

  let rewritten = sourceText;
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    rewritten = `${rewritten.slice(0, edit.start)}${edit.text}${rewritten.slice(edit.end)}`;
  }

  return rewritten;
}

function resolveRelativeModulePath(sourcePath, specifier) {
  const candidate = path.resolve(path.dirname(sourcePath), specifier);
  const extensions = [".ts", ".tsx", ".d.ts"];

  for (const extension of extensions) {
    const withExtension = `${candidate}${extension}`;
    if (ts.sys.fileExists(withExtension)) {
      return withExtension;
    }
  }

  for (const extension of extensions) {
    const indexPath = path.join(candidate, `index${extension}`);
    if (ts.sys.fileExists(indexPath)) {
      return indexPath;
    }
  }

  throw new Error(`Unable to resolve relative import ${specifier} from ${sourcePath}`);
}

function toNodeNextDeclarationSpecifier(specifier) {
  if (specifier.endsWith(".js")) {
    return specifier;
  }

  if (specifier.endsWith(".d.ts")) {
    return `${specifier.slice(0, -5)}.js`;
  }

  if (specifier.endsWith(".ts") || specifier.endsWith(".tsx") || specifier.endsWith(".mts")) {
    return `${specifier.replace(/\.(?:[cm]?ts|tsx)$/u, "")}.js`;
  }

  return `${specifier}.js`;
}

function toDeclarationOutputPath(outputRoot, relativeSourcePath) {
  return path.join(outputRoot, relativeSourcePath.replace(/\.(?:[cm]?ts|tsx)$/u, ".d.ts"));
}

async function writeProvenanceFile({ outputRoot, targetName, target, manifestPath, outputFiles }) {
  await mkdir(outputRoot, { recursive: true });
  const provenancePath = path.join(outputRoot, "_provenance.json");
  const provenance = {
    target: targetName,
    repo: target.repo,
    commit: target.commit,
    manifestPath: path.relative(process.cwd(), manifestPath),
    generatedBy: SCRIPT_NAME,
    outputFormat: "dts",
    outputFiles,
    entrypoints: target.entrypoints,
    license: target.license ?? null,
  };
  const temporaryProvenancePath = `${provenancePath}.tmp`;
  await writeFile(temporaryProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  await rename(temporaryProvenancePath, provenancePath);
}

async function readRequiredFile(sourcePath, targetName, relativeSourcePath) {
  try {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
      throw new Error("not a file");
    }
    return await readFile(sourcePath, "utf8");
  } catch (error) {
    throw new Error(
      `Target ${targetName} could not read ${relativeSourcePath}: ${toErrorMessage(error)}`
    );
  }
}

function normalizeSourcePath(sourcePath) {
  return sourcePath.split("/").join(path.sep);
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      reject(error);
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new Error(
          `${command} ${args.join(" ")} failed with exit code ${code}${
            stderr ? `: ${stderr.trim()}` : stdout ? `: ${stdout.trim()}` : ""
          }`
        )
      );
    });
  });
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
