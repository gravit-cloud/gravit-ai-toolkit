import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { stableJson } from "./json.mjs";
import {
  assertRegistryName,
  canonicalPath,
  pathIsInside,
  pathIsStrictlyInside,
  pathsOverlap,
} from "./path-safety.mjs";

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(label + " must be a plain object");
  return value;
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertNoPrototypeKeys(value, label) {
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      throw new Error("prototype key is not allowed in " + label + ": " + key);
    }
  }
}

function assertJsonValue(value, stack = new WeakSet()) {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (typeof value !== "object") {
    throw new Error("inline component must contain only JSON values");
  }
  if (stack.has(value)) throw new Error("inline component must not be cyclic");
  stack.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error("inline component must contain only JSON values");
    }
    const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
    if (
      keys.some((key) => typeof key !== "string" || !/^(?:0|[1-9]\d*)$/.test(key))
      || keys.length !== value.length
    ) {
      throw new Error("inline component must contain only JSON values");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error("inline component must contain only JSON values");
      }
      assertJsonValue(value[index], stack);
    }
  } else {
    if (!isPlainObject(value)) {
      throw new Error("inline component must contain only JSON values");
    }
    assertNoPrototypeKeys(value, "inline component");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new Error("inline component must contain only JSON values");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("inline component must contain only JSON values");
      }
      assertJsonValue(descriptor.value, stack);
    }
  }
  stack.delete(value);
}

function assertRealBundleDirectory(bundleRoot) {
  if (typeof bundleRoot !== "string" || bundleRoot.length === 0) {
    throw new Error("bundle root must be an existing real directory");
  }
  const stats = lstatIfPresent(bundleRoot);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("bundle root must be an existing real directory: " + bundleRoot);
  }
  return realpathSync(bundleRoot);
}

function assertLexicalDestinationContainment({ bundleRoot, neutralRoot, destination }) {
  if (
    typeof neutralRoot !== "string"
    || !pathIsStrictlyInside(bundleRoot, neutralRoot)
    || !pathIsInside(neutralRoot, destination)
  ) {
    throw new Error("neutral root escapes bundle root: " + String(neutralRoot));
  }
}

function assertCanonicalDestinationContainment({
  canonicalBundleRoot,
  neutralRoot,
  destination,
}) {
  const canonicalNeutralRoot = canonicalPath(neutralRoot);
  const canonicalDestination = canonicalPath(destination);
  if (
    !pathIsStrictlyInside(canonicalBundleRoot, canonicalNeutralRoot)
    || !pathIsInside(canonicalNeutralRoot, canonicalDestination)
  ) {
    throw new Error("neutral root escapes bundle root: " + neutralRoot);
  }
}

function assertNoDestinationSymlinks(bundleRoot, destination) {
  const nested = relative(resolve(bundleRoot), resolve(destination));
  if (nested === "" || nested.startsWith("..")) {
    throw new Error("component destination escapes bundle root: " + destination);
  }
  let current = resolve(bundleRoot);
  const segments = nested.split(/[\\/]/);
  for (const segment of segments.slice(0, -1)) {
    current = resolve(current, segment);
    const stats = lstatIfPresent(current);
    if (stats?.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in component destination: " + current);
    }
    if (stats && !stats.isDirectory()) {
      throw new Error("component destination parent must be a directory: " + current);
    }
  }
}

function assertSafeSource(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.length === 0) {
    throw new Error("path component requires an own sourcePath string");
  }
  const stats = lstatIfPresent(sourcePath);
  if (!stats) throw new Error("component source does not exist: " + sourcePath);
  if (stats.isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in component source: " + sourcePath);
  }
  if (stats.isFile()) return;
  if (!stats.isDirectory()) {
    throw new Error("component source must be a regular file or directory: " + sourcePath);
  }
  for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
    const entryPath = resolve(sourcePath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("symbolic links are not allowed in component source: " + entryPath);
    }
    if (entry.isDirectory()) assertSafeSource(entryPath);
    else if (!entry.isFile()) {
      throw new Error("component source must contain only regular files: " + entryPath);
    }
  }
}

function validateComponent(component) {
  assertPlainObject(component, "component");
  assertNoPrototypeKeys(component, "component");
  if (
    !Object.hasOwn(component, "id")
    || !Object.hasOwn(component, "type")
    || !Object.hasOwn(component, "sourceFormat")
  ) {
    throw new Error("component must have own id, type, and sourceFormat properties");
  }
  assertRegistryName(component.id, "component id");
  assertRegistryName(component.type, "component type");
  if (component.sourceFormat !== "path" && component.sourceFormat !== "inline") {
    throw new Error("component sourceFormat must be path or inline");
  }
  if (component.sourceFormat === "path") {
    if (!Object.hasOwn(component, "sourcePath")) {
      throw new Error("path component requires an own sourcePath string");
    }
    assertSafeSource(component.sourcePath);
  } else {
    if (!Object.hasOwn(component, "inline")) {
      throw new Error("inline component requires an own inline property");
    }
    if (!isPlainObject(component.inline)) {
      throw new Error("inline component must contain only JSON values");
    }
    assertJsonValue(component.inline);
  }
}

export function copyComponent(input) {
  assertPlainObject(input, "copyComponent input");
  assertNoPrototypeKeys(input, "copyComponent input");
  for (const field of ["component", "bundleRoot", "neutralRoot"]) {
    if (!Object.hasOwn(input, field)) throw new Error("copyComponent input requires " + field);
  }
  const { component, bundleRoot, neutralRoot } = input;
  validateComponent(component);
  const canonicalBundleRoot = assertRealBundleDirectory(bundleRoot);
  const destination = resolve(neutralRoot, component.type, component.id);
  assertLexicalDestinationContainment({
    bundleRoot,
    neutralRoot,
    destination,
  });
  if (lstatIfPresent(destination)) {
    throw new Error("component destination already exists: " + destination);
  }
  assertNoDestinationSymlinks(bundleRoot, destination);
  assertCanonicalDestinationContainment({
    canonicalBundleRoot,
    neutralRoot,
    destination,
  });

  if (component.sourceFormat === "path") {
    const canonicalSource = realpathSync(component.sourcePath);
    if (pathsOverlap(canonicalSource, canonicalPath(destination))) {
      throw new Error("component source overlaps destination: " + component.sourcePath);
    }
  }

  mkdirSync(dirname(destination), { recursive: true });
  assertNoDestinationSymlinks(bundleRoot, destination);
  if (lstatIfPresent(destination)) {
    throw new Error("component destination already exists: " + destination);
  }
  if (component.sourceFormat === "inline") {
    mkdirSync(destination);
    writeFileSync(resolve(destination, "component.json"), stableJson(component.inline));
  } else {
    cpSync(component.sourcePath, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  }
  return destination;
}
