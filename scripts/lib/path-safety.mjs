import { lstatSync, readlinkSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { compareCodePoints } from "./ordering.mjs";

const REGISTRY_NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SYMBOLIC_LINKS = 40;

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
  const candidatePath = isAbsolute(candidate)
    ? candidate
    : process.cwd() + sep + candidate;
  const candidateRoot = parse(candidatePath).root;
  let current = candidateRoot;
  let pending = candidatePath
    .slice(candidateRoot.length)
    .split(sep)
    .filter(Boolean);
  let followedLinks = 0;

  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = resolve(current, segment);
    let stats;
    try {
      stats = lstatSync(next);
    } catch (error) {
      if (error.code === "ENOENT") return resolve(next, ...pending);
      throw new Error(
        "cannot resolve canonical path: " + candidate + " (" + error.code + ")",
        { cause: error },
      );
    }
    if (!stats.isSymbolicLink()) {
      current = next;
      continue;
    }

    followedLinks += 1;
    if (followedLinks > MAX_SYMBOLIC_LINKS) {
      throw new Error(
        "cannot resolve canonical path: " + candidate + " (symbolic link loop)",
      );
    }
    let target;
    try {
      target = readlinkSync(next);
    } catch (error) {
      throw new Error(
        "cannot resolve canonical path: " + candidate + " (" + error.code + ")",
        { cause: error },
      );
    }
    const targetRoot = parse(target).root;
    current = targetRoot || dirname(next);
    pending = [
      ...target.slice(targetRoot.length).split(sep).filter(Boolean),
      ...pending,
    ];
  }
  return current;
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
