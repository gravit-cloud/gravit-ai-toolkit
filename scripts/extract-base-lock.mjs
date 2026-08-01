#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "usage: node scripts/extract-base-lock.mjs --base-sha <full-sha> --output <path>";
const lockPath = "registry/lock.json";
const emptyBase = Buffer.from('{"plugins":{}}\n', "utf8");
const maxGitOutput = 4 * 1024 * 1024;

export function parseExtractArguments(args) {
  if (
    !Array.isArray(args)
    || args.length !== 4
    || args[0] !== "--base-sha"
    || typeof args[1] !== "string"
    || args[1].length === 0
    || args[2] !== "--output"
    || typeof args[3] !== "string"
    || args[3].length === 0
  ) {
    throw new Error(usage);
  }
  return { baseSha: args[1], outputPath: args[3] };
}

function boundedDetail(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 400);
}

function runGit(args, repositoryRoot, { binary = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: binary ? undefined : "utf8",
    maxBuffer: maxGitOutput,
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  if (result.status !== 0 || result.error) {
    const detail = boundedDetail(result.stderr || result.error?.message);
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return binary ? result.stdout : String(result.stdout);
}

function objectId(value, length, label) {
  if (
    typeof value !== "string"
    || value.length !== length
    || !/^[a-f0-9]+$/u.test(value)
  ) {
    throw new Error(`${label} did not resolve to a full hexadecimal Git object id`);
  }
  return value;
}

function runnerOutput(outputPath, runnerTemp) {
  if (typeof runnerTemp !== "string" || runnerTemp.length === 0) {
    throw new Error("RUNNER_TEMP must name an existing real directory");
  }
  const temporaryRoot = resolve(runnerTemp);
  let stats;
  try {
    stats = lstatSync(temporaryRoot);
  } catch {
    throw new Error("RUNNER_TEMP must name an existing real directory");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("RUNNER_TEMP must name an existing real directory");
  }
  const expected = resolve(temporaryRoot, "gravit-base-lock.json");
  if (resolve(outputPath) !== expected || dirname(resolve(outputPath)) !== temporaryRoot) {
    throw new Error("output must be the direct RUNNER_TEMP base-lock path");
  }
  try {
    lstatSync(expected);
    throw new Error("output must not already exist");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return {
    path: expected,
    parent: {
      canonical: realpathSync(temporaryRoot),
      dev: stats.dev,
      ino: stats.ino,
    },
  };
}

function revalidateOutputParent(output) {
  const stats = lstatSync(dirname(output.path));
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== output.parent.dev
    || stats.ino !== output.parent.ino
    || realpathSync(dirname(output.path)) !== output.parent.canonical
  ) {
    throw new Error("RUNNER_TEMP identity changed before output creation");
  }
}

function writeExclusive(output, bytes) {
  revalidateOutputParent(output);
  let descriptor;
  try {
    descriptor = openSync(output.path, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("output must not already exist");
    throw error;
  }
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function extractBaseLock({
  baseSha,
  outputPath,
  repositoryRoot = process.cwd(),
  runnerTemp = process.env.RUNNER_TEMP,
}) {
  if (typeof baseSha !== "string" || !/^[a-fA-F0-9]+$/u.test(baseSha)) {
    throw new Error("BASE_SHA must be a full hexadecimal Git object id");
  }
  const output = runnerOutput(outputPath, runnerTemp);
  const format = runGit(["rev-parse", "--show-object-format"], repositoryRoot).trim();
  const objectIdLength = format === "sha1" ? 40 : format === "sha256" ? 64 : undefined;
  if (objectIdLength === undefined || baseSha.length !== objectIdLength) {
    throw new Error("BASE_SHA must be a full hexadecimal Git object id");
  }
  const baseCommit = objectId(
    runGit([
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${baseSha}^{commit}`,
    ], repositoryRoot).trim(),
    objectIdLength,
    "base commit",
  );
  const mergeBase = objectId(
    runGit(["merge-base", "--", "HEAD", baseCommit], repositoryRoot).trim(),
    objectIdLength,
    "merge base",
  );
  const treeEntry = runGit(["ls-tree", mergeBase, "--", lockPath], repositoryRoot).trimEnd();
  let bytes;
  if (treeEntry.length === 0) {
    const history = runGit([
      "rev-list",
      "--max-count=1",
      "--full-history",
      mergeBase,
      "--",
      lockPath,
    ], repositoryRoot).trim();
    if (history.length !== 0) {
      objectId(history, objectIdLength, "lock history commit");
      throw new Error("registry/lock.json existed in merge-base history and is now absent");
    }
    bytes = emptyBase;
  } else {
    const match = /^(\d{6}) ([a-z]+) ([a-f0-9]+)\tregistry\/lock\.json$/u.exec(treeEntry);
    if (!match || match[1] !== "100644" || match[2] !== "blob") {
      throw new Error("merge-base registry lock must be a regular non-executable file");
    }
    const blobId = objectId(match[3], objectIdLength, "registry lock blob");
    bytes = runGit(["cat-file", "blob", blobId], repositoryRoot, { binary: true });
  }
  writeExclusive(output, bytes);
  return { mergeBase, outputPath: output.path };
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseExtractArguments(args);
    extractBaseLock(options);
    return 0;
  } catch (error) {
    console.error(boundedDetail(error instanceof Error ? error.message : error));
    return 1;
  }
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
