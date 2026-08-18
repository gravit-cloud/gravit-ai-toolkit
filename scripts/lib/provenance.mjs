import { lstatSync } from "node:fs";
import { compareCodePoints } from "./ordering.mjs";
import { assertRegistryName } from "./path-safety.mjs";
import { targetDisposition } from "./policy.mjs";
import { treeHash } from "./hash.mjs";

const COMPONENT_TYPES = new Set([
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
  "lsp",
  "output-style",
  "monitor",
  "theme",
  "channel",
  "executable",
  "settings",
  "asset",
  "app",
]);
const TARGET_NAMES = new Set(["claude", "codex"]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const REASON_CODE = /^[a-z0-9][a-z0-9-]*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(label + " must be a plain object");
}

function assertNoPrototypeKeys(value, label) {
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) {
      throw new Error("prototype key is not allowed in " + label + ": " + key);
    }
  }
}

function assertAllowedKeys(value, allowed, label) {
  assertNoPrototypeKeys(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error("unknown " + label + " field: " + key);
  }
}

function assertOwn(value, key, label) {
  if (!Object.hasOwn(value, key)) throw new Error(label + " requires " + key);
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !DIGEST.test(value)) {
    throw new Error(label + " must be a SHA-256 digest");
  }
  return value;
}

function safeRelativePath(value, label, { allowDot = false } = {}) {
  const valid = typeof value === "string"
    && value.length > 0
    && !/[\u0000-\u001f\\]/.test(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:/.test(value)
    && (allowDot && value === "." || value.split("/").every((part) => (
      part.length > 0 && part !== "." && part !== ".."
    )));
  if (!valid) throw new Error(label + " must be a safe relative path");
  return value;
}

function parseSemver(value, label) {
  if (typeof value !== "string") throw new Error(label + " must be valid SemVer");
  const match = SEMVER.exec(value);
  if (!match) throw new Error(label + " must be valid SemVer: " + value);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] === undefined ? undefined : match[4].split("."),
  };
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue, "distributionVersion");
  const right = parseSemver(rightValue, "distributionVersion");
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] < right[key]) return -1;
    if (left[key] > right[key]) return 1;
  }
  if (left.prerelease === undefined && right.prerelease === undefined) return 0;
  if (left.prerelease === undefined) return 1;
  if (right.prerelease === undefined) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return compareCodePoints(leftIdentifier, rightIdentifier);
  }
  return 0;
}

function validatedComponentIdentity(component) {
  assertPlainObject(component, "component");
  assertNoPrototypeKeys(component, "component");
  assertOwn(component, "id", "component");
  assertOwn(component, "type", "component");
  assertRegistryName(component.id, "component id");
  assertRegistryName(component.type, "component type");
  if (!COMPONENT_TYPES.has(component.type)) {
    throw new Error("unknown component type: " + component.type);
  }
  return { id: component.id, type: component.type };
}

function validateTargetsArray(targets) {
  if (!Array.isArray(targets)) throw new Error("targets must be an array");
  const seen = new Set();
  for (const target of targets) {
    if (PROTOTYPE_KEYS.has(target)) {
      throw new Error("prototype registry name is not allowed: " + target);
    }
    if (!TARGET_NAMES.has(target)) throw new Error("unknown target: " + String(target));
    if (seen.has(target)) throw new Error("duplicate target: " + target);
    seen.add(target);
  }
  return [...targets].sort(compareCodePoints);
}

function cloneDisposition(value) {
  assertPlainObject(value, "disposition");
  assertAllowedKeys(
    value,
    new Set(["status", "reasonCode", "path"]),
    "disposition",
  );
  assertOwn(value, "status", "disposition");
  assertOwn(value, "reasonCode", "disposition");
  if (!["preserved", "transformed", "unsupported", "rejected"].includes(value.status)) {
    throw new Error("unknown disposition status: " + String(value.status));
  }
  if (typeof value.reasonCode !== "string" || !REASON_CODE.test(value.reasonCode)) {
    throw new Error("disposition reasonCode must be a stable reason code");
  }
  if (Object.hasOwn(value, "path")) {
    if (["unsupported", "rejected"].includes(value.status)) {
      throw new Error(value.status + " disposition must not include path");
    }
    safeRelativePath(value.path, "disposition path");
  }
  return {
    status: value.status,
    reasonCode: value.reasonCode,
    ...(Object.hasOwn(value, "path") ? { path: value.path } : {}),
  };
}

export function accountComponents(input) {
  assertPlainObject(input, "accountComponents input");
  assertAllowedKeys(
    input,
    new Set(["components", "targets", "targetPolicies"]),
    "accountComponents input",
  );
  for (const field of ["components", "targets", "targetPolicies"]) {
    assertOwn(input, field, "accountComponents input");
  }
  if (!Array.isArray(input.components)) throw new Error("components must be an array");
  const targets = validateTargetsArray(input.targets);
  assertPlainObject(input.targetPolicies, "targetPolicies");
  const seen = new Set();
  const components = input.components.map((component) => {
    const identity = validatedComponentIdentity(component);
    if (seen.has(identity.id)) throw new Error("duplicate component id: " + identity.id);
    seen.add(identity.id);
    return identity;
  }).sort((left, right) => compareCodePoints(left.id, right.id));

  return components.map((component) => {
    const dispositions = targets.map((target) => {
      const policyResult = targetDisposition({
        component,
        target,
        targetPolicies: input.targetPolicies,
      });
      return [target, cloneDisposition({
        status: policyResult.status,
        reasonCode: policyResult.reasonCode,
      })];
    });
    return { ...component, targets: Object.fromEntries(dispositions) };
  });
}

function cloneSource(source) {
  assertPlainObject(source, "source");
  assertNoPrototypeKeys(source, "source");
  assertOwn(source, "type", "source");
  if (source.type === "local") {
    assertAllowedKeys(source, new Set(["type", "path", "root"]), "source");
    assertOwn(source, "path", "local source");
    safeRelativePath(source.path, "source path");
    if (Object.hasOwn(source, "root")) {
      safeRelativePath(source.root, "source root", { allowDot: true });
    }
    return {
      type: "local",
      path: source.path,
      ...(Object.hasOwn(source, "root") ? { root: source.root } : {}),
    };
  }
  if (source.type === "github") {
    assertAllowedKeys(
      source,
      new Set(["type", "repo", "ref", "sha", "root"]),
      "source",
    );
    for (const field of ["repo", "ref", "sha"]) assertOwn(source, field, "GitHub source");
    if (
      typeof source.repo !== "string"
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo)
      || source.repo.split("/").some((part) => part === "." || part === "..")
    ) {
      throw new Error("GitHub source repo must be owner/repository");
    }
    if (
      typeof source.ref !== "string"
      || source.ref.length === 0
      || /[\u0000-\u001f]/.test(source.ref)
    ) {
      throw new Error("GitHub source ref must be a non-empty string");
    }
    if (typeof source.sha !== "string" || !COMMIT_SHA.test(source.sha)) {
      throw new Error("GitHub source sha must be a full commit SHA");
    }
    if (Object.hasOwn(source, "root")) {
      safeRelativePath(source.root, "source root", { allowDot: true });
    }
    return {
      type: "github",
      repo: source.repo,
      ref: source.ref,
      sha: source.sha,
      ...(Object.hasOwn(source, "root") ? { root: source.root } : {}),
    };
  }
  throw new Error("unknown source type: " + String(source.type));
}

function validateSourceContext(sourceContext) {
  if (sourceContext === undefined) return;
  if (!Array.isArray(sourceContext)) throw new Error("sourceContext must be an array");
  const paths = sourceContext.map((entry) => {
    assertPlainObject(entry, "sourceContext entry");
    assertAllowedKeys(entry, new Set(["path", "digest"]), "sourceContext entry");
    assertOwn(entry, "path", "sourceContext entry");
    assertOwn(entry, "digest", "sourceContext entry");
    safeRelativePath(entry.path, "sourceContext path");
    assertDigest(entry.digest, "sourceContext digest");
    return entry.path;
  });
  for (const [index, left] of paths.entries()) {
    for (const right of paths.slice(index + 1)) {
      if (
        left === right
        || left.startsWith(right + "/")
        || right.startsWith(left + "/")
      ) {
        throw new Error("sourceContext paths overlap: " + [left, right].join(", "));
      }
    }
  }
}

function validatePlugin(plugin) {
  assertPlainObject(plugin, "plugin");
  assertAllowedKeys(plugin, new Set([
    "name",
    "description",
    "category",
    "distributionVersion",
    "source",
    "targets",
    "policies",
    "runtimeDependencies",
    "resources",
    "sourceContext",
    "targetPolicies",
    "adapterOptions",
  ]), "plugin");
  assertOwn(plugin, "name", "plugin");
  assertOwn(plugin, "distributionVersion", "plugin");
  assertOwn(plugin, "source", "plugin");
  assertOwn(plugin, "targets", "plugin");
  assertRegistryName(plugin.name, "plugin name");
  parseSemver(plugin.distributionVersion, "distributionVersion");
  validateSourceContext(plugin.sourceContext);
  return {
    source: cloneSource(plugin.source),
    targets: validateTargetsArray(plugin.targets),
  };
}

function assertMatchingSource(pluginSource, inputSource) {
  if (pluginSource.type !== inputSource.type) {
    throw new Error("plugin source must exactly match input source: type");
  }
  const fields = pluginSource.type === "github"
    ? ["repo", "ref", "sha"]
    : ["path"];
  for (const field of fields) {
    if (pluginSource[field] !== inputSource[field]) {
      throw new Error("plugin source must exactly match input source: " + field);
    }
  }
  const pluginHasRoot = Object.hasOwn(pluginSource, "root");
  const inputHasRoot = Object.hasOwn(inputSource, "root");
  if (pluginHasRoot !== inputHasRoot) {
    throw new Error("plugin source must exactly match input source: root presence");
  }
  if (pluginHasRoot && pluginSource.root !== inputSource.root) {
    throw new Error("plugin source must exactly match input source: root value");
  }
}

function validateLockComponents(components) {
  if (!Array.isArray(components)) throw new Error("components must be an array");
  const seen = new Set();
  return components.map((component) => {
    assertPlainObject(component, "component");
    assertAllowedKeys(component, new Set(["id", "type", "digest"]), "component");
    const identity = validatedComponentIdentity(component);
    if (seen.has(identity.id)) throw new Error("duplicate component id: " + identity.id);
    seen.add(identity.id);
    assertOwn(component, "digest", "component");
    return {
      ...identity,
      digest: assertDigest(component.digest, "component digest"),
    };
  }).sort((left, right) => compareCodePoints(left.id, right.id));
}

function validateTargetResults(targets, components) {
  assertPlainObject(targets, "targets");
  assertNoPrototypeKeys(targets, "targets");
  const componentById = new Map(components.map((component) => [component.id, component]));
  return Object.keys(targets).sort(compareCodePoints).map((target) => {
    if (!TARGET_NAMES.has(target)) throw new Error("unknown target: " + target);
    const result = targets[target];
    assertPlainObject(result, "target result");
    assertAllowedKeys(result, new Set(["digest", "components", "path"]), "target result");
    assertOwn(result, "digest", "target result");
    assertOwn(result, "components", "target result");
    const digest = assertDigest(result.digest, "target digest");
    if (Object.hasOwn(result, "path")) safeRelativePath(result.path, "target path");
    assertPlainObject(result.components, "target components");
    assertNoPrototypeKeys(result.components, "target components");
    for (const id of Object.keys(result.components)) {
      assertRegistryName(id, "accounted component id");
      if (!componentById.has(id)) {
        throw new Error("unknown accounted component: " + id + " for " + target);
      }
    }
    const dispositions = components.map((component) => {
      if (!Object.hasOwn(result.components, component.id)) {
        throw new Error(
          "unaccounted component " + component.type + ":" + component.id
            + " for " + target,
        );
      }
      return [component.id, cloneDisposition(result.components[component.id])];
    });
    return {
      name: target,
      digest,
      components: Object.fromEntries(dispositions),
    };
  });
}

export function createLockEntry(input) {
  assertPlainObject(input, "createLockEntry input");
  assertAllowedKeys(
    input,
    new Set([
      "plugin",
      "source",
      "bundleRoot",
      "components",
      "targets",
      "generatorDigest",
    ]),
    "createLockEntry input",
  );
  for (const field of [
    "plugin",
    "source",
    "bundleRoot",
    "components",
    "targets",
    "generatorDigest",
  ]) {
    assertOwn(input, field, "createLockEntry input");
  }
  const { source: pluginSource, targets: configuredTargets } = validatePlugin(input.plugin);
  const source = cloneSource(input.source);
  assertMatchingSource(pluginSource, source);
  const generatorDigest = assertDigest(input.generatorDigest, "generatorDigest");
  let bundleStats;
  if (typeof input.bundleRoot === "string" && input.bundleRoot.length > 0) {
    try {
      bundleStats = lstatSync(input.bundleRoot);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!bundleStats || bundleStats.isSymbolicLink() || !bundleStats.isDirectory()) {
    throw new Error("bundleRoot must be an existing real directory");
  }
  const components = validateLockComponents(input.components);
  const targetResults = validateTargetResults(input.targets, components);
  const resultTargets = targetResults.map(({ name }) => name);
  if (
    configuredTargets.length !== resultTargets.length
    || configuredTargets.some((target, index) => target !== resultTargets[index])
  ) {
    throw new Error("configured targets must match target results");
  }

  return {
    name: input.plugin.name,
    distributionVersion: input.plugin.distributionVersion,
    source,
    generatorDigest,
    bundleDigest: treeHash(input.bundleRoot),
    components: components.map((component) => ({
      ...component,
      targets: Object.fromEntries(targetResults.map((target) => [
        target.name,
        structuredClone(target.components[component.id]),
      ])),
    })),
    targets: Object.fromEntries(targetResults.map((target) => [target.name, target.digest])),
  };
}

function validateVersionEntry(entry, label) {
  assertPlainObject(entry, label + " version entry");
  assertAllowedKeys(entry, new Set([
    "name",
    "distributionVersion",
    "source",
    "generatorDigest",
    "bundleDigest",
    "components",
    "targets",
  ]), label + " version entry");
  assertOwn(entry, "distributionVersion", label + " version entry");
  assertOwn(entry, "bundleDigest", label + " version entry");
  parseSemver(entry.distributionVersion, label + " distributionVersion");
  assertDigest(entry.bundleDigest, label + " bundleDigest");
}

export function assertVersionChange(input) {
  assertPlainObject(input, "assertVersionChange input");
  assertAllowedKeys(
    input,
    new Set(["previousEntry", "nextEntry"]),
    "assertVersionChange input",
  );
  assertOwn(input, "previousEntry", "assertVersionChange input");
  assertOwn(input, "nextEntry", "assertVersionChange input");
  validateVersionEntry(input.nextEntry, "next");
  if (input.previousEntry === undefined) return;
  validateVersionEntry(input.previousEntry, "previous");
  if (input.previousEntry.bundleDigest === input.nextEntry.bundleDigest) return;
  if (
    compareSemver(
      input.nextEntry.distributionVersion,
      input.previousEntry.distributionVersion,
    ) <= 0
  ) {
    throw new Error("bundle changed without distributionVersion bump");
  }
}
