import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";
import { walkFiles } from "./path-safety.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function treeHash(root) {
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in staged components: " + root);
  }
  if (stats.isFile()) {
    return sha256(basename(root) + "\0" + sha256(readFileSync(root)));
  }
  if (!stats.isDirectory()) {
    throw new Error("tree hash root must be a file or directory: " + root);
  }
  const records = walkFiles(root)
    .map((filePath) => {
      const path = relative(root, filePath).replaceAll("\\", "/");
      return path + "\0" + sha256(readFileSync(filePath));
    })
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
