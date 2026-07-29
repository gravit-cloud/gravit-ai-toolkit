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
const MATERIALIZATION_TARGETS = new Set(["claude", "codex", "openclaw"]);

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
      const result = this.verify(name);
      if (!result.ok) throw new Error(result.errors.join("\n"));
      const selected = entry(name);
      return {
        ...this.list().find((plugin) => plugin.name === name),
        components: structuredClone(selected.locked.components),
        source: structuredClone(selected.locked.source),
      };
    },
    verify(name) {
      if (loadError) return { ok: false, errors: [loadError] };
      if (state.error) return { ok: false, errors: [state.error] };
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
      return { ok: errors.length === 0, errors };
    },
  };
  materializationReaders.set(reader, (name, target) => {
    if (!MATERIALIZATION_TARGETS.has(target)) {
      throw new Error("unsupported materialization target: " + String(target));
    }
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
  return reader;
}

export function materializationSource(reader, name, target) {
  const select = materializationReaders.get(reader);
  if (!select) throw new Error("materialization requires a trusted registry reader");
  return select(name, target);
}

export function registryRevision(repositoryRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status !== 0 || !/^[a-f0-9]{40}\n?$/u.test(result.stdout)) {
    throw new Error("registry checkout must have a resolvable Git HEAD");
  }
  return result.stdout.trim();
}
