import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { treeHash } from "./hash.mjs";
import { readJson, stableJson } from "./json.mjs";
import { assertRegistryName, canonicalPath, pathIsInside } from "./path-safety.mjs";
import { validateCatalog } from "./catalog.mjs";
import { compareCodePoints } from "./ordering.mjs";
import { validateRepository } from "./validator.mjs";

function loadSchema(name) {
  return JSON.parse(readFileSync(new URL(
    `../../registry/schemas/${name}.schema.json`,
    import.meta.url,
  ), "utf8"));
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateLock = ajv.compile(loadSchema("lock"));
const validatePluginManifest = ajv.compile(loadSchema("agent-plugin"));
const materializationReaders = new WeakMap();
const releaseReaders = new WeakMap();
const revisionReaders = new WeakMap();
const revisionClaims = new WeakMap();
const MATERIALIZATION_TARGETS = new Set(["claude", "codex", "openclaw"]);
const RELEASE_RECEIPT = ".gravit-plugin-receipt.json";
const MAX_GIT_OUTPUT = 1024 * 1024;
const GIT_ENVIRONMENT = Object.freeze({ LC_ALL: "C", PATH: "/usr/bin:/bin" });

function messageOf(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s*\r?\n\s*/gu, " ")
    .trim();
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedNames(values) {
  return [...values].sort(compareCodePoints);
}

function validateWith(validator, value, label) {
  if (validator(value)) return;
  const details = (validator.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`invalid ${label}: ${details}`);
}

function assertRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== "string" || repositoryRoot.length === 0) {
    throw new Error("repository root must be a non-empty path");
  }
  const root = resolve(repositoryRoot);
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("repository root must be a real directory: " + root);
  }
  if (canonicalPath(root) !== realpathSync(root)) {
    throw new Error("repository root must be canonical: " + root);
  }
  return realpathSync(root);
}

function safeExistingPath(root, candidate, label, type) {
  const path = resolve(candidate);
  if (!pathIsInside(root, path)) throw new Error(`${label} escapes repository root`);
  const segments = relative(root, path).split(/[\\/]/u).filter(Boolean);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) throw new Error(`${label} must not use symbolic paths`);
    const final = index === segments.length - 1;
    if (!final && !stats.isDirectory()) {
      throw new Error(`${label} has a non-directory path segment`);
    }
    if (final && ((type === "directory" && !stats.isDirectory()) || (type === "file" && !stats.isFile()))) {
      throw new Error(`${label} must be a real ${type}`);
    }
    if (!stats.isDirectory() && !stats.isFile()) {
      throw new Error(`${label} must not be a special filesystem entry`);
    }
  }
  const expected = resolve(root, relative(root, path));
  if (canonicalPath(path) !== expected || realpathSync(path) !== expected) {
    throw new Error(`${label} must be canonical`);
  }
  return path;
}

function safeJson(root, relativePath, label) {
  return readJson(safeExistingPath(root, resolve(root, relativePath), label, "file"));
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function exactKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? sortedNames(Object.keys(value))
    : [];
}

function sameJson(left, right) {
  return stableJson(left) === stableJson(right);
}

function metadataError(catalog, lock) {
  const catalogNames = catalog.plugins.map((plugin) => plugin.name);
  const lockNames = exactKeys(lock.plugins);
  if (!sameValues(sortedNames(catalogNames), lockNames)) {
    return "catalog and lock plugin names disagree";
  }
  for (const plugin of catalog.plugins) {
    const locked = lock.plugins[plugin.name];
    if (!locked || locked.name !== plugin.name) return `${plugin.name}: lock name mismatch`;
    if (locked.generatorDigest !== lock.generatorDigest) {
      return `${plugin.name}: generator digest mismatch with registry`;
    }
    if (locked.distributionVersion !== plugin.distributionVersion) {
      return `${plugin.name}: distributionVersion mismatch with lock`;
    }
    if (!sameJson(locked.source, plugin.source)) return `${plugin.name}: source mismatch with lock`;
    const configuredTargets = sortedNames(plugin.targets);
    if (!sameValues(configuredTargets, exactKeys(locked.targets))) {
      return `${plugin.name}: configured targets mismatch with lock`;
    }
    const componentIds = new Set();
    for (const component of locked.components) {
      if (componentIds.has(component.id)) {
        return `${plugin.name}: duplicate lock component id ${component.id}`;
      }
      componentIds.add(component.id);
    }
  }
  return undefined;
}

function loadState(repositoryRoot) {
  const root = assertRepositoryRoot(repositoryRoot);
  const catalog = safeJson(root, "registry/catalog.json", "registry catalog");
  const lock = safeJson(root, "registry/lock.json", "registry lock");
  validateCatalog(catalog);
  validateWith(validateLock, lock, "registry lock");
  const error = metadataError(catalog, lock);
  return { root, catalog, lock, error };
}

function assertManifestShape(manifest, name) {
  validateWith(validatePluginManifest, manifest, `${name} neutral manifest`);
  const componentIds = manifest.components.map((component) => component.id);
  if (new Set(componentIds).size !== componentIds.length) {
    throw new Error("duplicate component id in neutral manifest");
  }
}

function verifyPlugin({ root, plugin, locked }) {
  const bundleRoot = safeExistingPath(
    root,
    resolve(root, "plugins", plugin.name),
    `${plugin.name} bundle`,
    "directory",
  );
  if (treeHash(bundleRoot) !== locked.bundleDigest) {
    return [`${plugin.name}: bundle digest mismatch`];
  }

  const manifest = safeJson(
    root,
    `plugins/${plugin.name}/.agent-plugin/plugin.json`,
    `${plugin.name} neutral manifest`,
  );
  assertManifestShape(manifest, plugin.name);
  const errors = [];
  const add = (condition, message) => {
    if (condition) errors.push(`${plugin.name}: ${message}`);
  };
  add(manifest.name !== plugin.name, "neutral manifest name mismatch");
  add(
    manifest.distributionVersion !== plugin.distributionVersion
      || manifest.distributionVersion !== locked.distributionVersion,
    "neutral manifest distributionVersion mismatch",
  );
  const configuredTargets = sortedNames(plugin.targets);
  add(!sameValues(configuredTargets, exactKeys(manifest.targets)), "configured targets mismatch with neutral manifest");
  add(!sameValues(configuredTargets, exactKeys(locked.targets)), "configured targets mismatch with lock");

  const lockComponents = new Map(locked.components.map((component) => [component.id, component]));
  const manifestComponents = new Map(manifest.components.map((component) => [component.id, component]));
  add(
    !sameValues(sortedNames(lockComponents.keys()), sortedNames(manifestComponents.keys())),
    "neutral manifest and lock component sets disagree",
  );
  for (const component of manifest.components) {
    const lockedComponent = lockComponents.get(component.id);
    if (!lockedComponent) continue;
    if (
      component.type !== lockedComponent.type
      || component.digest !== lockedComponent.digest
      || !sameJson(component.targets, lockedComponent.targets)
    ) {
      errors.push(`${plugin.name}: component ${component.id} mismatch with lock`);
    }
    try {
      const componentPath = safeExistingPath(
        bundleRoot,
        resolve(bundleRoot, component.path),
        `${plugin.name} component ${component.id}`,
      );
      if (!pathIsInside(resolve(bundleRoot, "components"), componentPath)) {
        errors.push(`${plugin.name}: component ${component.id} escapes components root`);
      } else if (treeHash(componentPath) !== component.digest) {
        errors.push(`${plugin.name}: component ${component.id} digest mismatch`);
      }
    } catch (error) {
      errors.push(`${plugin.name}: component ${component.id}: ${messageOf(error)}`);
    }
  }
  for (const target of configuredTargets) {
    const targetData = manifest.targets[target];
    const lockDigest = locked.targets[target];
    if (!targetData || typeof targetData !== "object") continue;
    if (targetData.path !== `targets/${target}`) {
      errors.push(`${plugin.name}: target ${target} has a non-canonical path`);
      continue;
    }
    try {
      const targetRoot = safeExistingPath(
        bundleRoot,
        resolve(bundleRoot, targetData.path),
        `${plugin.name} target ${target}`,
        "directory",
      );
      const actualDigest = treeHash(targetRoot);
      if (actualDigest !== targetData.digest || targetData.digest !== lockDigest) {
        errors.push(`${plugin.name}: target ${target} digest mismatch`);
      }
      const targetComponentIds = exactKeys(targetData.components);
      if (!sameValues(sortedNames(manifestComponents.keys()), targetComponentIds)) {
        errors.push(`${plugin.name}: target ${target} component set mismatch`);
      }
      for (const component of manifest.components) {
        if (!sameJson(component.targets[target], targetData.components?.[component.id])) {
          errors.push(`${plugin.name}: component ${component.id} ${target} disposition mismatch`);
        }
      }
    } catch (error) {
      errors.push(`${plugin.name}: target ${target}: ${messageOf(error)}`);
    }
  }
  return errors;
}

export function openRegistry(repositoryRoot) {
  let state;
  let loadError;
  let completeVerificationSucceeded = false;
  try {
    state = loadState(repositoryRoot);
  } catch (error) {
    loadError = "registry: " + messageOf(error);
  }

  function ready() {
    if (loadError) throw new Error(loadError);
    if (state.error) throw new Error(state.error);
    return state;
  }

  function entry(name) {
    assertRegistryName(name, "registry plugin name");
    const loaded = ready();
    const plugin = loaded.catalog.plugins.find((candidate) => candidate.name === name);
    const locked = loaded.lock.plugins[name];
    if (!plugin || !locked) throw new Error("unknown registry plugin: " + name);
    return { plugin, locked };
  }

  function verify(name) {
    if (loadError) {
      if (name === undefined) completeVerificationSucceeded = false;
      return { ok: false, errors: [loadError] };
    }
    if (state.error) {
      if (name === undefined) completeVerificationSucceeded = false;
      return { ok: false, errors: [state.error] };
    }
    const names = name === undefined
      ? state.catalog.plugins.map((plugin) => plugin.name)
      : [assertRegistryName(name, "registry plugin name")];
    const errors = [];
    for (const pluginName of names) {
      try {
        const selected = entry(pluginName);
        errors.push(...verifyPlugin({ root: state.root, ...selected }));
      } catch (error) {
        errors.push(`${pluginName}: ${messageOf(error)}`);
      }
    }
    if (errors.length === 0) {
      errors.push(...validateRepository({
        repositoryRoot: state.root,
        selectedPlugins: names,
      }));
    }
    const result = { ok: errors.length === 0, errors };
    if (name === undefined) completeVerificationSucceeded = result.ok;
    return result;
  }

  const reader = {
    list() {
      const loaded = ready();
      return loaded.catalog.plugins.map((plugin) => ({
        name: plugin.name,
        distributionVersion: plugin.distributionVersion,
        targets: sortedNames(plugin.targets),
        bundleDigest: loaded.lock.plugins[plugin.name].bundleDigest,
      }));
    },
    inspect(name) {
      const result = verify(name);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      const selected = entry(name);
      return {
        ...reader.list().find((plugin) => plugin.name === name),
        components: structuredClone(selected.locked.components),
        source: structuredClone(selected.locked.source),
      };
    },
    verify,
  };
  materializationReaders.set(reader, (name, target) => {
    if (!MATERIALIZATION_TARGETS.has(target)) {
      throw new Error("unsupported materialization target: " + String(target));
    }
    const verification = verify(name);
    if (!verification.ok) throw new Error(verification.errors.join("\n"));
    const selected = entry(name);
    if (!selected.plugin.targets.includes(target)) {
      throw new Error(name + ": target is not configured: " + target);
    }
    const bundleRoot = safeExistingPath(
      state.root,
      resolve(state.root, "plugins", name),
      `${name} bundle`,
      "directory",
    );
    const targetRoot = safeExistingPath(
      bundleRoot,
      resolve(bundleRoot, "targets", target),
      `${name} target ${target}`,
      "directory",
    );
    return Object.freeze({
      plugin: selected.plugin.name,
      target,
      distributionVersion: selected.plugin.distributionVersion,
      bundleDigest: selected.locked.bundleDigest,
      targetDigest: selected.locked.targets[target],
      bundleRoot,
      targetRoot,
    });
  });
  releaseReaders.set(reader, (name) => {
    if (!completeVerificationSucceeded) {
      const verification = verify(name);
      if (!verification.ok) throw new Error(verification.errors.join("\n"));
    }
    const selected = entry(name);
    const bundleRoot = safeExistingPath(
      state.root,
      resolve(state.root, "plugins", name),
      `${name} bundle`,
      "directory",
    );
    if (pathEntryExists(resolve(bundleRoot, RELEASE_RECEIPT))) {
      throw new Error(name + ": source bundle contains reserved receipt");
    }
    const licensePath = resolve(bundleRoot, "LICENSE");
    if (!pathEntryExists(licensePath)) {
      throw new Error(name + ": source bundle requires a top-level LICENSE");
    }
    const safeLicense = safeExistingPath(
      bundleRoot,
      licensePath,
      `${name} top-level LICENSE`,
      "file",
    );
    if (lstatSync(safeLicense).size === 0) {
      throw new Error(name + ": top-level LICENSE must not be empty");
    }
    return Object.freeze({
      plugin: selected.plugin.name,
      distributionVersion: selected.plugin.distributionVersion,
      bundleDigest: selected.locked.bundleDigest,
      bundleRoot,
    });
  });
  revisionReaders.set(reader, () => {
    const loaded = ready();
    return Object.freeze({
      root: loaded.root,
      pluginNames: Object.freeze(loaded.catalog.plugins.map(({ name }) => name)),
    });
  });
  return Object.freeze(reader);
}

export function materializationSource(reader, name, target) {
  const select = materializationReaders.get(reader);
  if (!select) throw new Error("materialization requires a trusted registry reader");
  return select(name, target);
}

export function releaseSource(reader, name) {
  const select = releaseReaders.get(reader);
  if (!select) throw new Error("release requires a trusted registry reader");
  return select(name);
}

function runGit(repositoryRoot, args, label) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: GIT_ENVIRONMENT,
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(label);
  }
  return result.stdout;
}

function gitHead(repositoryRoot) {
  const output = runGit(
    repositoryRoot,
    ["rev-parse", "HEAD"],
    "registry checkout must have a resolvable Git HEAD",
  );
  if (!/^[a-f0-9]{40}\n?$/u.test(output)) {
    throw new Error("registry checkout must have a resolvable Git HEAD");
  }
  return output.trim();
}

function normalizeRevisionNames(names, knownNames) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("registry revision claim requires at least one plugin");
  }
  const normalized = sortedNames(names.map((name) => (
    assertRegistryName(name, "registry revision plugin name")
  )));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("registry revision claim contains duplicate plugins");
  }
  const known = new Set(knownNames);
  for (const name of normalized) {
    if (!known.has(name)) throw new Error("unknown registry plugin: " + name);
  }
  return normalized;
}

function assertCommittedRevision({ root, revision, pluginNames }) {
  const before = gitHead(root);
  if (revision !== undefined && before !== revision) {
    throw new Error("registry Git HEAD changed after revision claim");
  }
  const pathspecs = [
    "registry/catalog.json",
    "registry/lock.json",
    ...pluginNames.map((name) => `plugins/${name}`),
  ];
  const status = runGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs],
    "registry checkout status could not be verified",
  );
  if (status.length !== 0) {
    throw new Error("consumed registry paths are not committed at registry revision");
  }
  const after = gitHead(root);
  if (after !== before || (revision !== undefined && after !== revision)) {
    throw new Error("registry Git HEAD changed after revision claim");
  }
  return after;
}

export function claimRegistryRevision(reader, pluginNames) {
  const select = revisionReaders.get(reader);
  if (!select) throw new Error("revision claim requires a trusted registry reader");
  const selected = select();
  const names = normalizeRevisionNames(pluginNames, selected.pluginNames);
  const revision = assertCommittedRevision({
    root: selected.root,
    pluginNames: names,
  });
  const claim = Object.freeze(Object.create(null));
  revisionClaims.set(claim, Object.freeze({
    reader,
    root: selected.root,
    pluginNames: Object.freeze(names),
    revision,
  }));
  return claim;
}

export function assertRegistryRevisionClaim(reader, claim, pluginNames) {
  const trusted = revisionClaims.get(claim);
  if (!trusted || trusted.reader !== reader) {
    throw new Error("registry publication requires a trusted registry revision claim");
  }
  const select = revisionReaders.get(reader);
  if (!select) throw new Error("revision claim requires a trusted registry reader");
  const selected = select();
  const names = normalizeRevisionNames(pluginNames, selected.pluginNames);
  if (!sameValues(names, trusted.pluginNames)) {
    throw new Error("registry revision claim plugin selection mismatch");
  }
  return assertCommittedRevision({
    root: trusted.root,
    revision: trusted.revision,
    pluginNames: trusted.pluginNames,
  });
}
