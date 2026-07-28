import { existsSync, lstatSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { treeHash, sha256 } from "./hash.mjs";
import { stableJson } from "./json.mjs";
import { compareCodePoints } from "./ordering.mjs";
import { assertInside, assertRealInside, assertRegistryName } from "./path-safety.mjs";
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

const CONVENTIONAL_COMPONENTS = [
  ["monitor", "monitors/monitors.json"],
  ["theme", "themes"],
  ["executable", "bin"],
  ["settings", "settings.json"],
  ["asset", "assets"],
];

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
    if (!/^[a-z]/.test(key) || metadataFields.has(key) || componentFields.has(key)) continue;
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

export function inventorySource({ sourceRoot, declaredSkills, manifestOverrides = {} }) {
  const loadedManifests = readUpstreamManifests(sourceRoot);
  const manifests = {
    claude: manifestOverrides.claude ?? loadedManifests.claude,
    codex: manifestOverrides.codex ?? loadedManifests.codex,
  };
  validateManifest(manifests.claude, "Claude");
  validateManifest(manifests.codex, "Codex");

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

  for (const [field, type] of [["themes", "theme"], ["monitors", "monitor"]]) {
    for (const value of values(manifests.claude.experimental?.[field])) {
      addRecord(components, seen, recordFor({ sourceRoot, type, value }));
    }
  }

  for (const [type, path] of CONVENTIONAL_COMPONENTS) {
    if (!pathEntryExists(resolve(sourceRoot, path))) continue;
    addRecord(components, seen, recordFor({ sourceRoot, type, value: path }));
  }

  return {
    manifests,
    skills: discoverSkills({
      sourceRoot,
      declaredSkills: configuredSkillPaths(manifests, declaredSkills),
    }),
    components: components.sort((left, right) => compareCodePoints(
      left.type + ":" + left.id,
      right.type + ":" + right.id,
    )),
  };
}
