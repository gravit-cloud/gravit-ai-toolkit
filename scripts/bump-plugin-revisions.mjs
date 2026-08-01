#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, writeJson } from "./lib/json.mjs";

const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const DISTRIBUTION_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-gravit\.(\d+)$/;

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(label + " must be an object");
}

function assertExactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(label + " has unexpected property: " + key);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new Error(label + " is missing property: " + key);
  }
}

function assertSafeRelativePath(value, label, { allowDot = false } = {}) {
  const valid = typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001f\\]/.test(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:/.test(value)
    && (allowDot && value === "." || value.split("/").every((part) => (
      part.length > 0 && part !== "." && part !== ".."
    )));
  if (!valid) throw new Error(label + " must be a safe relative path");
}

function validateSource(source, label) {
  assertRecord(source, label);
  if (source.type === "github") {
    assertExactKeys(source, ["type", "repo", "ref", "sha"], ["root"], label);
    if (
      typeof source.repo !== "string"
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)
      || source.repo.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error(label + ".repo must be owner/repository");
    }
    if (
      typeof source.ref !== "string"
      || source.ref.length === 0
      || /[\u0000-\u001f]/.test(source.ref)
    ) {
      throw new Error(label + ".ref must be a non-empty string without control characters");
    }
    if (!COMMIT_SHA.test(source.sha)) {
      throw new Error(label + ".sha must be a full lowercase commit SHA");
    }
  } else if (source.type === "local") {
    assertExactKeys(source, ["type", "path"], ["root"], label);
    assertSafeRelativePath(source.path, label + ".path");
  } else {
    throw new Error(label + ".type must be github or local");
  }
  if (Object.hasOwn(source, "root")) {
    assertSafeRelativePath(source.root, label + ".root", { allowDot: true });
  }
}

function sameSourceIdentity(left, right) {
  if (left.type !== right.type) return false;
  const fields = left.type === "github" ? ["repo", "ref", "sha"] : ["path"];
  for (const field of fields) {
    if (left[field] !== right[field]) return false;
  }
  const leftHasRoot = Object.hasOwn(left, "root");
  const rightHasRoot = Object.hasOwn(right, "root");
  return leftHasRoot === rightHasRoot && (!leftHasRoot || left.root === right.root);
}

function parseRevision(version) {
  if (typeof version !== "string") {
    throw new Error("distributionVersion must match X.Y.Z-gravit.N: " + String(version));
  }
  const match = DISTRIBUTION_VERSION.exec(version);
  if (!match) {
    throw new Error("distributionVersion must match X.Y.Z-gravit.N: " + version);
  }
  const revision = Number(match[4]);
  if (match[4] !== String(revision) || !Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("distribution revision must be a positive safe integer: " + match[4]);
  }
  if (revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("distribution revision cannot be incremented safely: " + match[4]);
  }
  return { prefix: match[1] + "." + match[2] + "." + match[3], revision };
}

function nextRevision(version) {
  const parsed = parseRevision(version);
  return parsed.prefix + "-gravit." + (parsed.revision + 1);
}

function validateInputs(input) {
  assertRecord(input, "input");
  const { catalog, lock } = input;
  assertRecord(catalog, "catalog");
  if (!Array.isArray(catalog.plugins)) throw new Error("catalog.plugins must be an array");
  if (catalog.plugins.length === 0) throw new Error("catalog.plugins must not be empty");
  assertRecord(lock, "lock");
  assertRecord(lock.plugins, "lock.plugins");

  const catalogNames = new Set();
  for (const [index, plugin] of catalog.plugins.entries()) {
    const label = "catalog.plugins[" + index + "]";
    assertRecord(plugin, label);
    if (typeof plugin.name !== "string" || !PLUGIN_NAME.test(plugin.name)) {
      throw new Error(label + ".name must be a registry plugin name");
    }
    if (catalogNames.has(plugin.name)) {
      throw new Error("duplicate plugin name: " + plugin.name);
    }
    catalogNames.add(plugin.name);
    parseRevision(plugin.distributionVersion);
    validateSource(plugin.source, label + ".source");
    if (!Object.hasOwn(lock.plugins, plugin.name)) {
      throw new Error("missing lock entry for catalog plugin: " + plugin.name);
    }
  }

  for (const name of Object.keys(lock.plugins)) {
    if (!PLUGIN_NAME.test(name)) throw new Error("invalid lock plugin name: " + name);
    const entry = lock.plugins[name];
    assertRecord(entry, "lock.plugins." + name);
    if (!catalogNames.has(name)) {
      throw new Error("lock entry without matching catalog plugin: " + name);
    }
    if (!Object.hasOwn(entry, "source")) {
      throw new Error("lock entry is missing source: " + name);
    }
    validateSource(entry.source, "lock.plugins." + name + ".source");
  }

  return { catalog, lock };
}

export function bumpChangedRevisions(input) {
  const { catalog, lock } = validateInputs(input);
  const next = structuredClone(catalog);
  const changedNames = [];
  for (const plugin of next.plugins) {
    const previous = lock.plugins[plugin.name];
    if (!sameSourceIdentity(plugin.source, previous.source)) {
      plugin.distributionVersion = nextRevision(plugin.distributionVersion);
      changedNames.push(plugin.name);
    }
  }
  return { catalog: next, changedNames: changedNames.sort() };
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const catalogPath = resolve("registry/catalog.json");
  const result = bumpChangedRevisions({
    catalog: readJson(catalogPath),
    lock: readJson(resolve("registry/lock.json")),
  });
  if (result.changedNames.length > 0) {
    writeJson(catalogPath, result.catalog);
    process.stdout.write(result.changedNames.join("\n") + "\n");
  }
}
