import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { walkFiles } from "./path-safety.mjs";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function treeHash(root) {
  const records = walkFiles(root)
    .map((filePath) => {
      const path = relative(root, filePath).replaceAll("\\", "/");
      return path + "\0" + sha256(readFileSync(filePath));
    })
    .sort();
  return sha256(records.join("\n"));
}
