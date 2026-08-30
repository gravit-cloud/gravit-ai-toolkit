import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";
import { walkFiles } from "./path-safety.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeExclusions(root, files, exclude) {
  if (!Array.isArray(exclude)) throw new Error("tree hash exclusions must be an array");
  const exclusions = new Set();
  for (const value of exclude) {
    if (
      typeof value !== "string"
      || value.length === 0
      || value.startsWith("/")
      || value.includes("\\")
      || /[\u0000-\u001f]/u.test(value)
      || value.split("/").some((segment) => (
        segment.length === 0 || segment === "." || segment === ".."
      ))
      || exclusions.has(value)
    ) {
      throw new Error("unsafe tree hash exclusion: " + String(value));
    }
    exclusions.add(value);
  }
  const filePaths = new Set(files.map((filePath) => (
    relative(root, filePath).replaceAll("\\", "/")
  )));
  for (const value of exclusions) {
    if (!filePaths.has(value)) {
      throw new Error("tree hash exclusion must name an existing regular file: " + value);
    }
  }
  return exclusions;
}

function modeRecord(stats) {
  return (stats.mode & 0o7777).toString(8).padStart(4, "0");
}

function modeAwareTreeHash(root, exclusions) {
  const records = [];

  function visit(path, relativePath) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in staged components: " + path);
    }
    if (stats.isFile()) {
      if (!exclusions.has(relativePath)) {
        records.push(relativePath + "\0file\0" + modeRecord(stats) + "\0" + sha256(readFileSync(path)));
      }
      return;
    }
    if (!stats.isDirectory()) {
      throw new Error("special filesystem entries are not allowed in staged components: " + path);
    }
    records.push(relativePath + "\0directory\0" + modeRecord(stats));
    for (const name of readdirSync(path).sort(compareCodePoints)) {
      visit(resolve(path, name), relativePath === "." ? name : relativePath + "/" + name);
    }
  }

  visit(root, ".");
  return sha256("gravit-ai-toolkit/tree-hash/mode-aware/v1\0" + records.join("\n"));
}

export function treeHash(root, { exclude = [], includeModes = false } = {}) {
  if (!Array.isArray(exclude)) throw new Error("tree hash exclusions must be an array");
  if (typeof includeModes !== "boolean") {
    throw new Error("tree hash includeModes must be a boolean");
  }
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in staged components: " + root);
  }
  if (stats.isFile()) {
    if (exclude.length > 0) throw new Error("tree hash exclusions require a directory root");
    if (includeModes) {
      return sha256(
        "gravit-ai-toolkit/tree-hash/mode-aware/v1\0"
          + basename(root) + "\0file\0" + modeRecord(stats) + "\0" + sha256(readFileSync(root)),
      );
    }
    return sha256(basename(root) + "\0" + sha256(readFileSync(root)));
  }
  if (!stats.isDirectory()) {
    throw new Error("tree hash root must be a file or directory: " + root);
  }
  const files = walkFiles(root);
  const exclusions = safeExclusions(root, files, exclude);
  if (includeModes) return modeAwareTreeHash(root, exclusions);
  const records = files
    .map((filePath) => ({
      filePath,
      path: relative(root, filePath).replaceAll("\\", "/"),
    }))
    .filter((record) => !exclusions.has(record.path))
    .map((record) => record.path + "\0" + sha256(readFileSync(record.filePath)))
    .sort(compareCodePoints);
  return sha256(records.join("\n"));
}

// Versioned domain separator for source-only catalog context. Any record-format
// change requires a new version and regeneration of every catalog digest.
const SOURCE_CONTEXT_HASH_PREFIX = "gravit-ai-toolkit/source-context-hash/v1\0";

export function sourceContextHash(root) {
  const absoluteRoot = resolve(root);
  const records = [];

  function visit(path) {
    const stats = lstatSync(path);
    const relativePath = path === absoluteRoot
      ? "."
      : relative(absoluteRoot, path).replaceAll("\\", "/");
    if (stats.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in source context hash: " + path);
    }
    if (stats.isFile()) {
      records.push([
        relativePath,
        "file",
        (stats.mode & 0o111) === 0 ? "regular" : "executable",
        sha256(readFileSync(path)),
      ]);
      return;
    }
    if (!stats.isDirectory()) {
      throw new Error("special filesystem entries are not allowed in source context hash: " + path);
    }
    records.push([relativePath, "directory"]);
    for (const name of readdirSync(path).sort(compareCodePoints)) {
      visit(resolve(path, name));
    }
  }

  visit(absoluteRoot);
  return sha256(SOURCE_CONTEXT_HASH_PREFIX + JSON.stringify(records));
}
