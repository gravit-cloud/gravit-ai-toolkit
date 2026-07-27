import { readdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export function assertInside(root, candidate, label) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const nested = relative(absoluteRoot, absoluteCandidate);
  if (nested === "" || (!nested.startsWith("..") && !isAbsolute(nested))) {
    return absoluteCandidate;
  }
  throw new Error(label + " escapes source root: " + candidate);
}

export function assertRealInside(root, candidate, label) {
  return assertInside(realpathSync(root), realpathSync(candidate), label);
}

export function walkFiles(root, result = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in staged components: " + path);
    }
    if (entry.isDirectory()) walkFiles(path, result);
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}
