import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, relative } from "node:path";
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
