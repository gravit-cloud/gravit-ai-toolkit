import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";

const REGISTRY_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function assertRegistryName(value, label = "registry name") {
  if (typeof value !== "string" || !REGISTRY_NAME.test(value)) {
    throw new Error(
      label + " must match ^[a-z0-9][a-z0-9-]*$: " + String(value),
    );
  }
  return value;
}

export function pathIsInside(root, candidate) {
  const nested = relative(resolve(root), resolve(candidate));
  return nested === "" || (!nested.startsWith("..") && !isAbsolute(nested));
}

export function pathIsStrictlyInside(root, candidate) {
  return resolve(root) !== resolve(candidate) && pathIsInside(root, candidate);
}

export function pathsOverlap(left, right) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

export function canonicalPath(candidate) {
  const remainder = [];
  let existing = resolve(candidate);
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      throw new Error("cannot resolve canonical path: " + candidate);
    }
    remainder.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...remainder);
}

export function assertInside(root, candidate, label) {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  if (pathIsInside(absoluteRoot, absoluteCandidate)) return absoluteCandidate;
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
  return result.sort(compareCodePoints);
}
