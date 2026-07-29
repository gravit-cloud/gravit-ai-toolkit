import {
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { treeHash, sha256 } from "./hash.mjs";
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
  readUpstreamManifests,
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

// Host manifests and conventional component roots are classified even when a
// particular plugin does not contain a declaration for them. Custom declared
// roots are added dynamically below, so upstreams are not limited to these names.
const KNOWN_TOP_LEVEL_DIRECTORIES = new Set([
  ".claude-plugin",
  ".codex-plugin",
  "agents",
  "assets",
  "bin",
  "channels",
  "commands",
  "hooks",
  "monitors",
  "output-styles",
  "skills",
  "themes",
]);

const KNOWN_TOP_LEVEL_FILES = new Set([
  ".app.json",
  ".lsp.json",
  ".mcp.json",
  "settings.json",
]);

// These roots contain repository metadata, documentation, examples, or tests;
// they are source context rather than installable plugin components.
const NON_COMPONENT_RESOURCE_DIRECTORIES = new Set([
  ".agents",
  ".changeset",
  ".circleci",
  ".cursor-plugin",
  ".devcontainer",
  ".github",
  ".gitlab",
  ".husky",
  ".kimi-plugin",
  ".opencode",
  ".vscode",
  ".out-of-scope",
  ".pi",
  "docs",
  "examples",
  "landing-page",
  "test",
  "tests",
]);

const NON_COMPONENT_METADATA_FILES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".markdownlint.json",
  ".npmignore",
  ".prettierignore",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".pre-commit-config.yaml",
  ".version-bump.json",
  "Cargo.lock",
  "Cargo.toml",
  "Gemfile",
  "Gemfile.lock",
  "Makefile",
  "Taskfile.yaml",
  "Taskfile.yml",
  "apm.yml",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "flake.lock",
  "flake.nix",
  "go.mod",
  "go.sum",
  "gemini-extension.json",
  "jsconfig.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "plugin.json",
  "pyproject.toml",
  "requirements-dev.txt",
  "requirements.txt",
  "renovate.json",
  "install.ps1",
  "install.sh",
  "tsconfig.json",
  "uninstall.ps1",
  "uninstall.sh",
  "uv.lock",
  "yarn.lock",
]);

const NON_COMPONENT_HOST_FILES = new Set([
  ".claude-plugin/marketplace.json",
  "hooks/cursor-hooks.json",
  "hooks/hooks-cursor.json",
  "hooks/hooks.json",
  "hooks/run-hook.cmd",
  "hooks/session-start",
  "scripts/bump-version.sh",
  "scripts/link-skills.sh",
  "scripts/lint-shell.sh",
  "scripts/list-skills.sh",
  "scripts/package-codex-plugin.sh",
  "scripts/sync-to-codex-plugin.sh",
]);

const NON_COMPONENT_DOCUMENTATION_FILE = /^(?:(?:AGENTS|AUTHORS|CHANGELOG|CLAUDE|CODE_OF_CONDUCT|CONTEXT|CONTRIBUTING|CONTRIBUTORS|GEMINI|LICENSE|NOTICE|PRIVACY|README|SECURITY|SUPPORT|VERSION)(?:\.(?:md|rst|txt))?|CITATION\.cff)$/i;
const EXACT_NON_COMPONENT_DOCUMENTATION_FILES = new Set(["RELEASE-NOTES.md"]);
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

function isNonComponentDocumentationFile(name) {
  return (
    EXACT_NON_COMPONENT_DOCUMENTATION_FILES.has(name)
    || NON_COMPONENT_DOCUMENTATION_FILE.test(name)
  );
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

function declaredPath(sourceRoot, configuredPath, label) {
  const absoluteRoot = resolve(sourceRoot);
  return assertInside(
    absoluteRoot,
    resolve(absoluteRoot, configuredPath),
    label,
  );
}

function declaredComponentPaths({ sourceRoot, manifests, skillPaths, resources }) {
  const result = [];
  for (const manifest of [manifests.claude, manifests.codex]) {
    for (const [field, config] of Object.entries(TYPE_CONFIG)) {
      for (const value of values(manifest[field])) {
        if (typeof value === "string") {
          result.push(declaredPath(sourceRoot, value, config.type + " component"));
        }
      }
    }
  }
  for (const [field, config] of Object.entries(EXPERIMENTAL_TYPE_CONFIG)) {
    for (const value of values(manifests.claude.experimental?.[field])) {
      if (typeof value === "string") {
        result.push(declaredPath(sourceRoot, value, config.type + " component"));
      }
    }
  }
  for (const value of skillPaths || []) {
    result.push(declaredPath(sourceRoot, value, "declared skill"));
  }
  for (const resource of resources || []) result.push(resource.sourcePath);
  return result;
}

function entryCoveredByDeclarations(entryPath, declarations) {
  const relevant = declarations.filter((declaration) => (
    pathIsInside(entryPath, declaration) || pathIsInside(declaration, entryPath)
  ));
  if (relevant.length === 0) return false;
  const stats = lstatSync(entryPath);
  const files = stats.isDirectory() ? walkFiles(entryPath) : [entryPath];
  return files.every((filePath) => relevant.some((declaration) => (
    pathIsInside(declaration, filePath)
  )));
}

function assertKnownTopLevelEntries({ sourceRoot, manifests, skillPaths, resources }) {
  const absoluteRoot = resolve(sourceRoot);
  const declarations = declaredComponentPaths({
    sourceRoot,
    manifests,
    skillPaths,
    resources,
  });
  declarations.push(...[...NON_COMPONENT_HOST_FILES].map((file) => (
    resolve(absoluteRoot, file)
  )));
  const entries = readdirSync(absoluteRoot, { withFileTypes: true })
    .sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    const entryPath = resolve(absoluteRoot, entry.name);
    if (entry.isSymbolicLink()) {
      if (
        entry.name === AGENTS_ALIAS_NAME
        && isExactAgentsDocumentAlias(absoluteRoot, entryPath)
      ) {
        continue;
      }
      throw new Error("symbolic links are not allowed in staged components: " + entryPath);
    }
    if (KNOWN_TOP_LEVEL_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory()) {
        throw new Error("top-level source entry must be a directory: " + entry.name);
      }
      continue;
    }
    if (KNOWN_TOP_LEVEL_FILES.has(entry.name)) {
      if (!entry.isFile()) {
        throw new Error("top-level source entry must be a file: " + entry.name);
      }
      continue;
    }
    if (NON_COMPONENT_RESOURCE_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory()) {
        throw new Error("non-component resource root must be a directory: " + entry.name);
      }
      continue;
    }
    if (
      NON_COMPONENT_METADATA_FILES.has(entry.name)
      || isNonComponentDocumentationFile(entry.name)
    ) {
      if (!entry.isFile()) {
        throw new Error("non-component metadata entry must be a file: " + entry.name);
      }
      continue;
    }
    if (entryCoveredByDeclarations(entryPath, declarations)) continue;
    throw new Error("unknown top-level source entry: " + entry.name);
  }
}

function nonComponentCoveragePaths(sourceRoot) {
  const absoluteRoot = resolve(sourceRoot);
  const paths = [
    resolve(absoluteRoot, ".claude-plugin/plugin.json"),
    resolve(absoluteRoot, ".codex-plugin/plugin.json"),
    ...[...NON_COMPONENT_HOST_FILES]
      .map((file) => resolve(absoluteRoot, file)),
    ...[...NON_COMPONENT_RESOURCE_DIRECTORIES]
      .map((directory) => resolve(absoluteRoot, directory)),
    ...[...NON_COMPONENT_METADATA_FILES]
      .map((file) => resolve(absoluteRoot, file)),
  ];
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (entry.isFile() && isNonComponentDocumentationFile(entry.name)) {
      paths.push(resolve(absoluteRoot, entry.name));
    }
  }
  return paths;
}

function assertInventoryCoverage({
  sourceRoot,
  components,
  skills,
  hasExplicitSkillSelection,
}) {
  const defaultSkillsRoot = resolve(sourceRoot, "skills");
  const coverageRoots = [
    ...components
      .filter(({ sourceFormat }) => sourceFormat === "path")
      .map(({ sourcePath }) => sourcePath),
    ...skills.map(({ sourceDirectory }) => sourceDirectory),
    ...(hasExplicitSkillSelection && pathEntryExists(defaultSkillsRoot)
      ? [defaultSkillsRoot]
      : []),
    ...nonComponentCoveragePaths(sourceRoot),
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

function assertSafeResourcePath(path) {
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
    throw new Error("resource path must be a safe relative path: " + String(path));
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
    assertSafeResourcePath(resource.path);
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
  declaredSkills,
  manifestOverrides = {},
  resources,
}) {
  const loadedManifests = readUpstreamManifests(sourceRoot);
  const manifests = {
    claude: manifestOverrides.claude ?? loadedManifests.claude,
    codex: manifestOverrides.codex ?? loadedManifests.codex,
  };
  validateManifest(manifests.claude, "Claude");
  validateManifest(manifests.codex, "Codex");
  const skillPaths = configuredSkillPaths(manifests, declaredSkills);
  const resourceRecords = configuredResourceRecords({ sourceRoot, resources });
  assertKnownTopLevelEntries({
    sourceRoot,
    manifests,
    skillPaths,
    resources: resourceRecords,
  });

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
  assertInventoryCoverage({
    sourceRoot,
    components,
    skills,
    hasExplicitSkillSelection: skillPaths !== undefined,
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
