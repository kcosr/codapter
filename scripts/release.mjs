#!/usr/bin/env node
/**
 * Release script for codapter
 *
 * Usage: node scripts/release.mjs <major|minor|patch>
 *
 * Steps:
 * 1. Check for uncommitted changes
 * 2. Bump version in package.json + package-lock.json
 * 3. Update CHANGELOG.md: [Unreleased] -> [version] - date
 * 4. Commit and tag
 * 5. Push to remote
 * 6. Create GitHub release with notes from CHANGELOG
 * 7. Add new [Unreleased] section
 * 8. Commit and push
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const bumpType = process.argv[2];
const releaseBranch = "main";

if (!["major", "minor", "patch"].includes(bumpType)) {
  console.error("Usage: node scripts/release.mjs <major|minor|patch>");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(command, options = {}) {
  console.log(`$ ${command}`);
  try {
    return execSync(command, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
      cwd: root,
      ...options,
    });
  } catch (error) {
    if (!options.ignoreError) {
      console.error(`Command failed: ${command}`);
      process.exit(1);
    }
    return null;
  }
}

function getRepoUrl() {
  const remote = run("git remote get-url origin", { silent: true, ignoreError: true });
  if (!remote) {
    return null;
  }
  const url = remote.trim();
  const sshMatch = url.match(/^git@github.com:(.+?)(\.git)?$/);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }
  const httpsMatch = url.match(/^https?:\/\/github.com\/(.+?)(\.git)?$/);
  if (httpsMatch) {
    return `https://github.com/${httpsMatch[1]}`;
  }
  return null;
}

function getCurrentBranch() {
  const branch = run("git rev-parse --abbrev-ref HEAD", { silent: true });
  return branch.trim();
}

// ---------------------------------------------------------------------------
// Version bump
// ---------------------------------------------------------------------------

function bumpVersion(type) {
  const packageJsonPath = join(root, "package.json");
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const current = pkg.version || "0.0.0";

  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    console.error(`Current version "${current}" is not valid semver (X.Y.Z)`);
    process.exit(1);
  }

  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);

  switch (type) {
    case "major":
      major += 1;
      minor = 0;
      patch = 0;
      break;
    case "minor":
      minor += 1;
      patch = 0;
      break;
    case "patch":
      patch += 1;
      break;
  }

  const newVersion = `${major}.${minor}.${patch}`;

  pkg.version = newVersion;
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");

  const lockPath = join(root, "package-lock.json");
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.version = newVersion;
    if (lock.packages?.[""]?.version) {
      lock.packages[""].version = newVersion;
    }
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  }

  // Update the VERSION constant in the CLI source
  const cliIndexPath = join(root, "packages", "cli", "src", "index.ts");
  if (existsSync(cliIndexPath)) {
    const cliSource = readFileSync(cliIndexPath, "utf8");
    const updated = cliSource.replace(
      /^const VERSION = ".*";$/m,
      `const VERSION = "${newVersion}";`
    );
    if (updated !== cliSource) {
      writeFileSync(cliIndexPath, updated, "utf8");
      console.log("  Updated VERSION in packages/cli/src/index.ts");
    }
  }

  console.log(`  Version: ${current} -> ${newVersion}`);
  return newVersion;
}

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

function updateChangelogForRelease(version) {
  const changelogPath = join(root, "CHANGELOG.md");
  const date = new Date().toISOString().split("T")[0];
  let content = readFileSync(changelogPath, "utf-8");

  if (!content.includes("## [Unreleased]")) {
    console.error("Error: No [Unreleased] section found in CHANGELOG.md");
    process.exit(1);
  }

  const releaseHeading = `## [${version}] - ${date}`;
  content = content.replace(/## \[Unreleased\]\n\n_No unreleased changes\._/, releaseHeading);
  content = content.replace(/## \[Unreleased\]/, releaseHeading);

  writeFileSync(changelogPath, content);
  console.log(`  Updated CHANGELOG.md: [Unreleased] -> [${version}] - ${date}`);
}

function extractReleaseNotes(version) {
  const changelogPath = join(root, "CHANGELOG.md");
  const content = readFileSync(changelogPath, "utf-8");

  const versionEscaped = version.replace(/\./g, "\\.");
  const regex = new RegExp(`## \\[${versionEscaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`);
  const match = content.match(regex);

  if (!match) {
    console.error(`Error: Could not extract release notes for v${version}`);
    process.exit(1);
  }

  return match[1].trim();
}

function addUnreleasedSection() {
  const changelogPath = join(root, "CHANGELOG.md");
  let content = readFileSync(changelogPath, "utf-8");

  const unreleasedSection = [
    "## [Unreleased]",
    "",
    "### Breaking Changes",
    "",
    "### Added",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
    "### Removed",
    "",
    "",
  ].join("\n");

  content = content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`);

  writeFileSync(changelogPath, content);
  console.log("  Added [Unreleased] section to CHANGELOG.md");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("\n=== Release Script ===\n");

console.log("Checking for uncommitted changes...");
const status = run("git status --porcelain", { silent: true });
if (status?.trim()) {
  console.error("Error: Uncommitted changes detected. Commit or stash first.");
  console.error(status);
  process.exit(1);
}
console.log("  Working directory clean\n");

const currentBranch = getCurrentBranch();
if (currentBranch !== releaseBranch) {
  console.error(
    `Error: Release must run from ${releaseBranch} (current branch: ${currentBranch}).`
  );
  process.exit(1);
}

console.log(`Bumping version (${bumpType})...`);
const version = bumpVersion(bumpType);
console.log();

console.log("Updating CHANGELOG.md...");
updateChangelogForRelease(version);
console.log();

console.log("Committing and tagging...");
run("git add CHANGELOG.md package.json package-lock.json packages/cli/src/index.ts");
run(`git commit -m "Release v${version}"`);
run(`git tag v${version}`);
console.log();

console.log("Pushing to remote...");
run(`git push origin ${releaseBranch}`);
run(`git push origin v${version}`);
console.log();

console.log("Creating GitHub release...");
const releaseNotes = extractReleaseNotes(version);
const notesFile = join(root, ".release-notes-tmp.md");
writeFileSync(notesFile, releaseNotes);
run(`gh release create v${version} --prerelease --title "v${version}" --notes-file "${notesFile}"`);
run(`rm "${notesFile}"`);
console.log();

console.log("Adding [Unreleased] section for next cycle...");
addUnreleasedSection();
console.log();

console.log("Committing changelog update...");
run("git add CHANGELOG.md");
run('git commit -m "Prepare for next release"');
run(`git push origin ${releaseBranch}`);
console.log();

const repoUrl = getRepoUrl();
if (repoUrl) {
  console.log(`=== Released v${version} ===`);
  console.log(`${repoUrl}/releases/tag/v${version}`);
} else {
  console.log(`=== Released v${version} ===`);
}
