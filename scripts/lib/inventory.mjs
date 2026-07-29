import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { treeHash, sha256 } from "./hash.mjs";
import { externalLicenseSource } from "./external-license.mjs";
import { stableJson } from "./json.mjs";
import { compareCodePoints } from "./ordering.mjs";
import {
  assertInside,
  assertRealInside,
  assertRegistryName,
  canonicalPath,
  pathIsInside,
  pathsOverlap,
  walkFiles,
} from "./path-safety.mjs";
import { declaredSkillPaths, discoverSkills } from "./skills.mjs";
import {
  CLAUDE_COMPONENT_FIELDS,
  CODEX_COMPONENT_FIELDS,
  readUpstreamManifestEntries,
} from "./upstream-manifest.mjs";

const TYPE_CONFIG = {
  commands: { type: "command", defaultPath: "commands" },
  agents: { type: "agent", defaultPath: "agents" },
  hooks: { type: "hook", defaultPath: "hooks/hooks.json" },
  mcpServers: { type: "mcp", defaultPath: ".mcp.json" },
  lspServers: { type: "lsp", defaultPath: ".lsp.json" },
  outputStyles: { type: "output-style", defaultPath: "output-styles" },
  channels: { type: "channel" },
  apps: { type: "app", defaultPath: ".app.json" },
};

const CLAUDE_METADATA_FIELDS = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "displayName",
  "defaultEnabled",
  "userConfig",
  "dependencies",
]);

const CODEX_METADATA_FIELDS = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "interface",
]);

const CLAUDE_EXPERIMENTAL_COMPONENT_FIELDS = new Set(["themes", "monitors"]);

const EXPERIMENTAL_TYPE_CONFIG = {
  themes: { type: "theme", defaultPath: "themes" },
  monitors: { type: "monitor", defaultPath: "monitors/monitors.json" },
};

const CONVENTIONAL_COMPONENTS = [
  ["executable", "bin"],
  ["settings", "settings.json"],
  ["asset", "assets"],
];

const AGENTS_ALIAS_NAME = "AGENTS.md";
const AGENTS_ALIAS_TARGET_NAME = "CLAUDE.md";
const AGENTS_ALIAS_TARGET_BYTES = Buffer.from(AGENTS_ALIAS_TARGET_NAME, "ascii");
const FILE_TYPE_MASK = 0o170000n;

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
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

function isExactAgentsDocumentAlias(sourceRoot, entryPath) {
  if (entryPath !== resolve(sourceRoot, AGENTS_ALIAS_NAME)) return false;
  let before;
  let targetBytes;
  let after;
  try {
    before = lstatSync(entryPath, { bigint: true });
    if (!before.isSymbolicLink()) return false;
    targetBytes = readlinkSync(entryPath, { encoding: "buffer" });
    after = lstatSync(entryPath, { bigint: true });
  } catch {
    return false;
  }
  if (
    !after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || (before.mode & FILE_TYPE_MASK) !== (after.mode & FILE_TYPE_MASK)
    || before.size !== after.size
    || before.ctimeNs !== after.ctimeNs
    || before.mtimeNs !== after.mtimeNs
    || !targetBytes.equals(AGENTS_ALIAS_TARGET_BYTES)
  ) {
    return false;
  }
  let targetStats;
  try {
    targetStats = lstatSync(resolve(sourceRoot, AGENTS_ALIAS_TARGET_NAME), { bigint: true });
  } catch {
    return false;
  }
  return targetStats.isFile();
}

function walkSourceFiles(sourceRoot, directory = sourceRoot, result = []) {
  const absoluteRoot = resolve(sourceRoot);
  const absoluteDirectory = resolve(directory);
  for (const entry of readdirSync(absoluteDirectory, { withFileTypes: true })) {
    const entryPath = resolve(absoluteDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      if (
        absoluteDirectory === absoluteRoot
        && entry.name === AGENTS_ALIAS_NAME
        && isExactAgentsDocumentAlias(absoluteRoot, entryPath)
      ) {
        continue;
      }
      throw new Error("symbolic links are not allowed in staged components: " + entryPath);
    }
    if (entry.isDirectory()) walkSourceFiles(absoluteRoot, entryPath, result);
    else if (entry.isFile()) result.push(entryPath);
    else throw new Error("special filesystem entries are not allowed in staged components: " + entryPath);
  }
  return result.sort(compareCodePoints);
}

function validateManifest(manifest, host) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(host + " manifest must be an object");
  }
  const componentFields = host === "Claude"
    ? CLAUDE_COMPONENT_FIELDS
    : CODEX_COMPONENT_FIELDS;
  const metadataFields = host === "Claude"
    ? CLAUDE_METADATA_FIELDS
    : CODEX_METADATA_FIELDS;
  for (const key of Object.keys(manifest)) {
    if (key === "$schema" || metadataFields.has(key) || componentFields.has(key)) continue;
    if (host === "Claude" && key === "experimental") continue;
    throw new Error("unknown " + host + " component field: " + key);
  }
  if (host !== "Claude" || manifest.experimental === undefined) return;
  const experimental = manifest.experimental;
  if (!experimental || typeof experimental !== "object" || Array.isArray(experimental)) {
    throw new Error("Claude experimental components must be an object");
  }
  for (const key of Object.keys(experimental)) {
    if (!CLAUDE_EXPERIMENTAL_COMPONENT_FIELDS.has(key)) {
      throw new Error("unknown Claude experimental component field: " + key);
    }
  }
}

function assertInventoryCoverage({
  sourceRoot,
  components,
  skills,
  sourceContextPaths,
  intrinsicContextPaths,
}) {
  const coverageRoots = [
    ...components
      .filter(({ sourceFormat }) => sourceFormat === "path")
      .map(({ sourcePath }) => sourcePath),
    ...skills.map(({ sourceDirectory }) => sourceDirectory),
    ...sourceContextPaths,
    ...intrinsicContextPaths,
  ].map(canonicalPath);
  for (const filePath of walkSourceFiles(resolve(sourceRoot))) {
    const canonicalFile = canonicalPath(filePath);
    if (coverageRoots.some((coverageRoot) => pathIsInside(coverageRoot, canonicalFile))) {
      continue;
    }
    const relativePath = relative(resolve(sourceRoot), filePath).replaceAll("\\", "/");
    throw new Error("unaccounted source file: " + relativePath);
  }
}

function componentPath(sourceRoot, type, configuredPath) {
  if (!configuredPath) {
    throw new Error(type + " component path must not be empty");
  }
  const absoluteRoot = resolve(sourceRoot);
  const sourcePath = assertInside(
    absoluteRoot,
    resolve(absoluteRoot, configuredPath),
    type + " component",
  );
  if (!existsSync(sourcePath)) {
    throw new Error(type + " component does not exist: " + configuredPath);
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalSource = assertRealInside(absoluteRoot, sourcePath, type + " component");
  const relativePath = relative(absoluteRoot, sourcePath).replaceAll("\\", "/");
  if (canonicalSource !== resolve(canonicalRoot, relativePath)) {
    throw new Error("symbolic links are not allowed in staged components: " + sourcePath);
  }
  if (lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in staged components: " + sourcePath);
  }
  return { relativePath, sourcePath };
}

function recordFor({ sourceRoot, type, value }) {
  if (typeof value === "string") {
    const { relativePath, sourcePath } = componentPath(sourceRoot, type, value);
    const id = type + "-" + sha256(relativePath).slice(0, 12);
    assertRegistryName(id, type + " component id");
    return {
      id,
      type,
      sourceFormat: "path",
      sourcePath,
      inline: undefined,
      digest: treeHash(sourcePath),
      metadata: { relativePath },
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(type + " component must be a path or inline object");
  }
  const inline = structuredClone(value);
  const inlineDigest = sha256(stableJson(inline));
  const id = type + "-inline-" + inlineDigest.slice(0, 12);
  assertRegistryName(id, type + " component id");
  return {
    id,
    type,
    sourceFormat: "inline",
    sourcePath: undefined,
    inline,
    digest: inlineDigest,
    metadata: {},
  };
}

function addRecord(components, seen, record) {
  const key = record.type + ":" + (
    record.sourceFormat === "path"
      ? record.metadata.relativePath
      : record.digest
  );
  if (seen.has(key)) return;
  seen.add(key);
  components.push(record);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertSafeRelativePath(path, label) {
  const segments = typeof path === "string" ? path.split("/") : [];
  if (
    typeof path !== "string"
    || path.length === 0
    || isAbsolute(path)
    || win32.isAbsolute(path)
    || path.includes("\\")
    || path.includes("//")
    || path.endsWith("/")
    || segments.some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || /[\u0000-\u001f]/.test(segment)
    ))
  ) {
    throw new Error(label + " must be a safe relative path: " + String(path));
  }
}

function configuredResourceRecords({ sourceRoot, resources }) {
  if (resources === undefined) return [];
  if (!Array.isArray(resources)) throw new Error("plugin resources must be an array");
  const records = resources.map((resource) => {
    if (
      !isPlainObject(resource)
      || Object.keys(resource).sort(compareCodePoints).join(",") !== "path,type"
      || !["asset", "executable"].includes(resource.type)
    ) {
      throw new Error("plugin resource must contain only type and path");
    }
    assertSafeRelativePath(resource.path, "resource path");
    return recordFor({ sourceRoot, type: resource.type, value: resource.path });
  });
  for (const [index, left] of records.entries()) {
    for (const right of records.slice(index + 1)) {
      if (
        pathsOverlap(left.sourcePath, right.sourcePath)
        || pathsOverlap(realpathSync(left.sourcePath), realpathSync(right.sourcePath))
      ) {
        throw new Error(
          "overlapping resource paths: "
            + [left.metadata.relativePath, right.metadata.relativePath]
              .sort(compareCodePoints)
              .join(", "),
        );
      }
    }
  }
  return records;
}

function assertResourcesDisjoint({ resources, components, skills }) {
  const pathComponents = components.filter(({ sourceFormat }) => sourceFormat === "path");
  for (const resource of resources) {
    for (const component of pathComponents) {
      if (
        pathsOverlap(resource.sourcePath, component.sourcePath)
        || pathsOverlap(realpathSync(resource.sourcePath), realpathSync(component.sourcePath))
      ) {
        throw new Error(
          "resource path overlaps inventoried component: "
            + resource.metadata.relativePath + ", " + component.metadata.relativePath,
        );
      }
    }
    for (const skill of skills) {
      if (
        pathsOverlap(resource.sourcePath, skill.sourceDirectory)
        || pathsOverlap(realpathSync(resource.sourcePath), realpathSync(skill.sourceDirectory))
      ) {
        throw new Error(
          "resource path overlaps inventoried skill: " + resource.metadata.relativePath,
        );
      }
    }
  }
}

function sourceContextRecord({ sourceRoot, entry }) {
  if (
    !isPlainObject(entry)
    || Object.keys(entry).sort(compareCodePoints).join(",") !== "digest,path"
    || typeof entry.digest !== "string"
    || !/^[a-f0-9]{64}$/.test(entry.digest)
  ) {
    throw new Error("source context entry must contain only path and a SHA-256 digest");
  }
  assertSafeRelativePath(entry.path, "source context path");
  const absoluteRoot = resolve(sourceRoot);
  const sourcePath = assertInside(
    absoluteRoot,
    resolve(absoluteRoot, entry.path),
    "source context",
  );
  if (!pathEntryExists(sourcePath)) {
    throw new Error("source context path does not exist: " + entry.path);
  }
  const stats = lstatSync(sourcePath);
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalSource = assertRealInside(absoluteRoot, sourcePath, "source context");
  const expectedCanonical = resolve(canonicalRoot, entry.path);
  if (stats.isSymbolicLink() || canonicalSource !== expectedCanonical) {
    throw new Error("symbolic links are not allowed in source context: " + sourcePath);
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error("special filesystem entries are not allowed in source context: " + sourcePath);
  }
  if (stats.isDirectory()) walkFiles(sourcePath);
  const digest = treeHash(sourcePath);
  if (digest !== entry.digest) {
    throw new Error("source context digest mismatch: " + entry.path);
  }
  return {
    canonicalPath: canonicalSource,
    digest,
    path: entry.path,
    sourcePath,
  };
}

function configuredSourceContextRecords({ sourceRoot, sourceContext }) {
  if (sourceContext === undefined) return [];
  if (!Array.isArray(sourceContext)) {
    throw new Error("plugin source context must be an array");
  }
  const records = sourceContext
    .map((entry) => sourceContextRecord({ sourceRoot, entry }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  for (const [index, left] of records.entries()) {
    for (const right of records.slice(index + 1)) {
      if (
        pathsOverlap(left.sourcePath, right.sourcePath)
        || pathsOverlap(left.canonicalPath, right.canonicalPath)
      ) {
        throw new Error(
          "overlapping source context paths: " + [left.path, right.path].join(", "),
        );
      }
    }
  }
  return records;
}

function contextOverlaps(context, path) {
  return pathsOverlap(context.sourcePath, path)
    || pathsOverlap(context.canonicalPath, realpathSync(path));
}

function assertSourceContextDisjoint({
  sourceRoot,
  sourceContext,
  manifestPaths,
  externalLicense,
  components,
  skills,
  skillPaths,
}) {
  const pathComponents = components.filter(({ sourceFormat }) => sourceFormat === "path");
  const declaredSkills = (skillPaths || []).map((path) => resolve(sourceRoot, path));
  for (const context of sourceContext) {
    for (const manifestPath of manifestPaths) {
      if (contextOverlaps(context, manifestPath)) {
        throw new Error("source context overlaps upstream manifest: " + context.path);
      }
    }
    if (externalLicense && contextOverlaps(context, externalLicense)) {
      throw new Error("source context overlaps redistributed license: " + context.path);
    }
    for (const skill of skills) {
      if (contextOverlaps(context, skill.sourceDirectory)) {
        throw new Error("source context overlaps inventoried skill: " + context.path);
      }
    }
    for (const skillPath of declaredSkills) {
      if (pathEntryExists(skillPath) && contextOverlaps(context, skillPath)) {
        throw new Error("source context overlaps declared skill: " + context.path);
      }
    }
    for (const component of pathComponents) {
      if (contextOverlaps(context, component.sourcePath)) {
        throw new Error("source context overlaps inventoried component: " + context.path);
      }
    }
  }
}

function configuredSkillPaths(manifests, declaredSkills) {
  const inputs = declaredSkills === undefined
    ? [manifests.claude.skills, manifests.codex.skills]
    : [declaredSkills];
  const hasDeclaration = inputs.some((input) => input !== undefined);
  const result = [];
  const seen = new Set();
  for (const input of inputs) {
    for (const path of declaredSkillPaths(input) || []) {
      if (seen.has(path)) continue;
      seen.add(path);
      result.push(path);
    }
  }
  return hasDeclaration ? result : undefined;
}

export function inventorySource({
  sourceRoot,
  sourceType,
  sourceContext,
  declaredSkills,
  manifestOverrides = {},
  resources,
}) {
  const manifestEntries = readUpstreamManifestEntries(sourceRoot);
  const loadedManifests = {
    claude: manifestEntries.claude.manifest,
    codex: manifestEntries.codex.manifest,
  };
  const manifestPaths = [manifestEntries.claude.path, manifestEntries.codex.path]
    .filter(Boolean);
  const externalLicense = externalLicenseSource({ sourceType, sourceRoot });
  const manifests = {
    claude: manifestOverrides.claude ?? loadedManifests.claude,
    codex: manifestOverrides.codex ?? loadedManifests.codex,
  };
  validateManifest(manifests.claude, "Claude");
  validateManifest(manifests.codex, "Codex");
  const skillPaths = configuredSkillPaths(manifests, declaredSkills);
  const resourceRecords = configuredResourceRecords({ sourceRoot, resources });

  const components = [];
  const seen = new Set();
  for (const [field, config] of Object.entries(TYPE_CONFIG)) {
    const declaringManifests = [manifests.claude, manifests.codex]
      .filter((manifest) => manifest[field] !== undefined);
    const declarations = declaringManifests
      .flatMap((manifest) => values(manifest[field]));
    const defaultPath = config.defaultPath && resolve(sourceRoot, config.defaultPath);
    const candidates = declaringManifests.length === 0 && defaultPath && pathEntryExists(defaultPath)
      ? [config.defaultPath]
      : declarations;
    for (const value of candidates) {
      addRecord(components, seen, recordFor({ sourceRoot, type: config.type, value }));
    }
  }

  const experimental = manifests.claude.experimental || {};
  for (const [field, config] of Object.entries(EXPERIMENTAL_TYPE_CONFIG)) {
    const declared = Object.hasOwn(experimental, field);
    const conventionalPath = resolve(sourceRoot, config.defaultPath);
    const candidates = declared
      ? values(experimental[field])
      : pathEntryExists(conventionalPath) ? [config.defaultPath] : [];
    for (const value of candidates) {
      addRecord(components, seen, recordFor({ sourceRoot, type: config.type, value }));
    }
  }

  for (const [type, path] of CONVENTIONAL_COMPONENTS) {
    if (!pathEntryExists(resolve(sourceRoot, path))) continue;
    addRecord(components, seen, recordFor({ sourceRoot, type, value: path }));
  }

  const skills = discoverSkills({
    sourceRoot,
    declaredSkills: skillPaths,
  });
  assertResourcesDisjoint({ resources: resourceRecords, components, skills });
  for (const record of resourceRecords) addRecord(components, seen, record);
  const sourceContextRecords = configuredSourceContextRecords({
    sourceRoot,
    sourceContext,
  });
  assertSourceContextDisjoint({
    sourceRoot,
    sourceContext: sourceContextRecords,
    manifestPaths,
    externalLicense,
    components,
    skills,
    skillPaths,
  });
  assertInventoryCoverage({
    sourceRoot,
    components,
    skills,
    sourceContextPaths: sourceContextRecords.map(({ sourcePath }) => sourcePath),
    intrinsicContextPaths: [...manifestPaths, externalLicense].filter(Boolean),
  });

  return {
    manifests,
    skills,
    components: components.sort((left, right) => compareCodePoints(
      left.type + ":" + left.id,
      right.type + ":" + right.id,
    )),
  };
}
