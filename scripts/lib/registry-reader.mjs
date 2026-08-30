import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
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
const MATERIALIZATION_TARGETS = new Set(["claude", "codex"]);
const RELEASE_RECEIPT = ".gravit-plugin-receipt.json";
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const GIT_ENVIRONMENT = Object.freeze({ LC_ALL: "C", PATH: "/usr/bin:/bin" });
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

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
    env: GIT_ENVIRONMENT,
    maxBuffer: MAX_GIT_OUTPUT,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(label);
  }
  return result.stdout;
}

function decodeGitText(output, label) {
  try {
    return UTF8_DECODER.decode(output);
  } catch {
    throw new Error(label);
  }
}

function splitGitRecords(output, label) {
  if (output.length === 0) return [];
  if (output.at(-1) !== 0) throw new Error(label);
  const records = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) throw new Error(label);
    records.push(decodeGitText(output.subarray(start, index), label));
    start = index + 1;
  }
  return records;
}

function gitObjectFormat(repositoryRoot) {
  const output = decodeGitText(runGit(
    repositoryRoot,
    ["rev-parse", "--show-object-format"],
    "registry checkout must have a resolvable Git HEAD",
  ), "registry checkout must expose its Git object format").trim();
  if (output !== "sha1" && output !== "sha256") {
    throw new Error("registry checkout uses an unsupported Git object format");
  }
  return output;
}

function gitHead(repositoryRoot, objectFormat) {
  const output = decodeGitText(runGit(
    repositoryRoot,
    ["rev-parse", "HEAD"],
    "registry checkout must have a resolvable Git HEAD",
  ), "registry checkout must have a resolvable Git HEAD").trim();
  const length = objectFormat === "sha1" ? 40 : 64;
  if (!new RegExp(`^[a-f0-9]{${length}}$`, "u").test(output)) {
    throw new Error("registry checkout must have a resolvable Git HEAD");
  }
  return output;
}

function consumedRevisionPaths(pluginNames) {
  return [
    "registry/catalog.json",
    "registry/lock.json",
    ...pluginNames.map((name) => `plugins/${name}`),
  ];
}

function isSelectedTreePath(path, bundleRoots) {
  return bundleRoots.some((root) => path === root || path.startsWith(root + "/"));
}

function parseHeadTree({ root, revision, objectFormat, pluginNames, pathspecs }) {
  const output = runGit(
    root,
    ["ls-tree", "-r", "-t", "-z", "--full-tree", revision, "--", ...pathspecs],
    "committed registry tree could not be read",
  );
  const bundleRoots = pluginNames.map((name) => `plugins/${name}`);
  const exactFiles = new Set(["registry/catalog.json", "registry/lock.json"]);
  const objectLength = objectFormat === "sha1" ? 40 : 64;
  const entries = new Map();
  for (const record of splitGitRecords(output, "committed registry tree has invalid records")) {
    const separator = record.indexOf("\t");
    if (separator === -1) throw new Error("committed registry tree has invalid records");
    const header = record.slice(0, separator);
    const path = record.slice(separator + 1);
    const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]+)$/u.exec(header);
    if (!match || match[3].length !== objectLength) {
      throw new Error("committed registry tree has invalid records");
    }
    if (!exactFiles.has(path) && !isSelectedTreePath(path, bundleRoots)) continue;
    const [, mode, type, objectId] = match;
    if (
      (type === "tree" && mode !== "040000")
      || (type === "blob" && mode !== "100644" && mode !== "100755")
      || (type !== "tree" && type !== "blob")
    ) {
      throw new Error("committed registry tree contains unsupported entry: " + path);
    }
    if (entries.has(path)) throw new Error("committed registry tree contains duplicate paths");
    entries.set(path, Object.freeze({ mode, type, objectId }));
  }
  for (const path of [...exactFiles, ...bundleRoots]) {
    if (!entries.has(path)) throw new Error("committed registry tree is missing: " + path);
  }
  return entries;
}

function parseIndexEntries({ root, pathspecs }) {
  const output = runGit(
    root,
    ["ls-files", "-v", "-z", "--", ...pathspecs],
    "registry index flags could not be verified",
  );
  const paths = new Set();
  for (const record of splitGitRecords(output, "registry index has invalid records")) {
    if (record.length < 3 || record[1] !== " ") {
      throw new Error("registry index has invalid records");
    }
    const flag = record[0];
    const path = record.slice(2);
    if (flag !== "H") {
      throw new Error("consumed registry paths use unsupported index flags: " + path);
    }
    if (paths.has(path)) throw new Error("registry index contains duplicate paths");
    paths.add(path);
  }
  return paths;
}

function gitBlobId(contents, objectFormat) {
  return createHash(objectFormat)
    .update(Buffer.from(`blob ${contents.length}\0`, "utf8"))
    .update(contents)
    .digest("hex");
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && (left.mode & 0o7777) === (right.mode & 0o7777);
}

function snapshotWorktreeEntry({ root, relativePath, objectFormat, entries }) {
  const path = resolve(root, relativePath);
  let before;
  try {
    before = lstatSync(path);
  } catch {
    throw new Error("working registry tree differs from committed registry tree: " + relativePath);
  }
  if (before.isSymbolicLink() || (!before.isDirectory() && !before.isFile())) {
    throw new Error("working registry tree contains unsupported entry: " + relativePath);
  }
  if (entries.has(relativePath)) {
    throw new Error("working registry tree contains duplicate paths: " + relativePath);
  }
  if (before.isFile()) {
    const contents = readFileSync(path);
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || !sameFileIdentity(before, after)) {
      throw new Error("working registry tree changed while reading: " + relativePath);
    }
    entries.set(relativePath, Object.freeze({
      mode: (after.mode & 0o111) === 0 ? "100644" : "100755",
      posixMode: after.mode & 0o7777,
      type: "blob",
      objectId: gitBlobId(contents, objectFormat),
    }));
    return;
  }
  entries.set(relativePath, Object.freeze({
    mode: "040000",
    posixMode: before.mode & 0o7777,
    type: "tree",
  }));
  const names = readdirSync(path).sort(compareCodePoints);
  for (const name of names) {
    snapshotWorktreeEntry({
      root,
      relativePath: relativePath + "/" + name,
      objectFormat,
      entries,
    });
  }
  const namesAfter = readdirSync(path).sort(compareCodePoints);
  const after = lstatSync(path);
  if (
    !after.isDirectory()
    || after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || (before.mode & 0o7777) !== (after.mode & 0o7777)
    || !sameValues(names, namesAfter)
  ) {
    throw new Error("working registry tree changed while reading: " + relativePath);
  }
}

function snapshotWorktree({ root, pluginNames, objectFormat }) {
  const entries = new Map();
  for (const relativePath of ["registry/catalog.json", "registry/lock.json"]) {
    snapshotWorktreeEntry({ root, relativePath, objectFormat, entries });
  }
  for (const name of pluginNames) {
    snapshotWorktreeEntry({
      root,
      relativePath: `plugins/${name}`,
      objectFormat,
      entries,
    });
  }
  return entries;
}

function assertSameRegistryTree(expected, actual) {
  if (expected.size !== actual.size) {
    throw new Error("working registry tree differs from committed registry tree");
  }
  for (const [path, committed] of expected) {
    const working = actual.get(path);
    const canonicalMode = committed.type === "tree"
      ? 0o755
      : committed.mode === "100755" ? 0o755 : 0o644;
    if (working && working.type === committed.type && working.posixMode !== canonicalMode) {
      throw new Error(
        "working registry tree has non-canonical POSIX mode: "
          + path
          + " (expected 0"
          + canonicalMode.toString(8)
          + ", found 0"
          + working.posixMode.toString(8)
          + ")",
      );
    }
    if (
      !working
      || working.mode !== committed.mode
      || working.type !== committed.type
      || (committed.type === "blob" && working.objectId !== committed.objectId)
    ) {
      throw new Error("working registry tree differs from committed registry tree: " + path);
    }
  }
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

function assertCommittedRevision({ root, revision, objectFormat: claimedFormat, pluginNames }) {
  const objectFormat = gitObjectFormat(root);
  if (claimedFormat !== undefined && claimedFormat !== objectFormat) {
    throw new Error("registry Git object format changed after revision claim");
  }
  const before = gitHead(root, objectFormat);
  if (revision !== undefined && before !== revision) {
    throw new Error("registry Git HEAD changed after revision claim");
  }
  const pathspecs = consumedRevisionPaths(pluginNames);
  const status = runGit(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathspecs],
    "registry checkout status could not be verified",
  );
  if (status.length !== 0) {
    throw new Error("consumed registry paths are not committed at registry revision");
  }
  const committed = parseHeadTree({
    root,
    revision: before,
    objectFormat,
    pluginNames,
    pathspecs,
  });
  const indexPaths = parseIndexEntries({ root, pathspecs });
  const committedFiles = new Set(
    [...committed].filter(([, entry]) => entry.type === "blob").map(([path]) => path),
  );
  if (
    indexPaths.size !== committedFiles.size
    || [...committedFiles].some((path) => !indexPaths.has(path))
  ) {
    throw new Error("registry index differs from committed registry tree");
  }
  assertSameRegistryTree(
    committed,
    snapshotWorktree({ root, pluginNames, objectFormat }),
  );
  const after = gitHead(root, objectFormat);
  if (after !== before || (revision !== undefined && after !== revision)) {
    throw new Error("registry Git HEAD changed after revision claim");
  }
  return Object.freeze({ revision: after, objectFormat });
}

export function claimRegistryRevision(reader, pluginNames) {
  const select = revisionReaders.get(reader);
  if (!select) throw new Error("revision claim requires a trusted registry reader");
  const selected = select();
  const names = normalizeRevisionNames(pluginNames, selected.pluginNames);
  const committed = assertCommittedRevision({
    root: selected.root,
    pluginNames: names,
  });
  const claim = Object.freeze(Object.create(null));
  revisionClaims.set(claim, Object.freeze({
    reader,
    root: selected.root,
    pluginNames: Object.freeze(names),
    revision: committed.revision,
    objectFormat: committed.objectFormat,
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
    objectFormat: trusted.objectFormat,
    pluginNames: trusted.pluginNames,
  }).revision;
}
