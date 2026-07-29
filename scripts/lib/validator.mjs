import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
  win32,
} from "node:path";
import Ajv from "ajv/dist/2020.js";
import { parse as parseMarkdown, postprocess, preprocess } from "micromark";
import { isTrueLike, parseFrontmatter } from "./frontmatter.mjs";
import { treeHash } from "./hash.mjs";
import { normalizeHooks } from "./hooks.mjs";
import { stableJson } from "./json.mjs";
import {
  CODEX_CATEGORIES,
  createClaudeMarketplace,
  createCodexMarketplace,
} from "./marketplaces.mjs";
import { normalizeMcp } from "./mcp.mjs";
import { compareCodePoints } from "./ordering.mjs";
import {
  canonicalPath,
  pathIsInside,
  walkFiles,
} from "./path-safety.mjs";
import { assertVersionChange } from "./provenance.mjs";
import { classifyRuntimeCommand } from "./runtime-command.mjs";

const PROTOTYPE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const TARGETS = new Set(["claude", "codex"]);
const SUPPORTED_SCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs", ".sh"]);
const CONTAINER_BOOLEAN_OPTIONS = new Set([
  "-i", "-t", "--init", "--interactive", "--read-only", "--rm", "--tty",
]);
const CONTAINER_VALUE_OPTIONS = new Set([
  "-e", "-p", "-u", "-v", "-w", "--entrypoint", "--env", "--hostname",
  "--mount", "--name", "--network", "--platform", "--publish", "--pull",
  "--user", "--volume", "--workdir",
]);
const LINK_DESTINATION_TYPES = new Set([
  "definitionDestinationString",
  "resourceDestinationString",
]);

function loadSchema(name) {
  return JSON.parse(readFileSync(
    new URL(`../../registry/schemas/${name}.schema.json`, import.meta.url),
    "utf8",
  ));
}

const ajv = new Ajv({ allErrors: true, strict: true });
const schemaValidators = {
  catalog: ajv.compile(loadSchema("catalog")),
  lock: ajv.compile(loadSchema("lock")),
  plugin: ajv.compile(loadSchema("agent-plugin")),
};

function messageOf(error) {
  return String(error instanceof Error ? error.message : error)
    .replace(/\s*\r?\n\s*/gu, " ")
    .trim();
}

function normalizedRelative(root, path) {
  const value = relative(root, path).replaceAll("\\", "/");
  return value || ".";
}

function addCaught(errors, label, operation) {
  try {
    return operation();
  } catch (error) {
    errors.push(`${label}: ${messageOf(error)}`);
    return undefined;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort(compareCodePoints);
}

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readJsonFile(path, label, errors) {
  return addCaught(errors, label, () => JSON.parse(readFileSync(path, "utf8")));
}

function readRepositoryJson(repositoryRoot, relativePath, errors) {
  const path = safeExistingPath({
    boundary: repositoryRoot,
    candidate: resolve(repositoryRoot, relativePath),
    label: relativePath,
    errors,
    type: "file",
  });
  return path ? readJsonFile(path, relativePath, errors) : undefined;
}

function validateMaintainedSourceVersions(repositoryRoot, catalog, errors) {
  const manifestPaths = [
    ["Claude", "sources/gravit-custom/.claude-plugin/plugin.json"],
    ["Codex", "sources/gravit-custom/.codex-plugin/plugin.json"],
  ];
  const sourceExists = Boolean(statEntry(resolve(repositoryRoot, "sources/gravit-custom")));
  const manifestExists = manifestPaths.some(([, path]) => (
    statEntry(resolve(repositoryRoot, path))
  ));
  const sourceSelected = Array.isArray(catalog?.plugins) && catalog.plugins.some((plugin) => (
    plugin?.source?.type === "local"
    && plugin.source.path === "sources/gravit-custom"
  ));
  if (!sourceExists && !manifestExists && !sourceSelected) return;
  const packageManifest = readRepositoryJson(repositoryRoot, "package.json", errors);
  for (const [target, path] of manifestPaths) {
    const manifest = readRepositoryJson(repositoryRoot, path, errors);
    if (
      isPlainObject(packageManifest)
      && isPlainObject(manifest)
      && manifest.version !== packageManifest.version
    ) {
      errors.push(
        `package.json and gravit-custom ${target} plugin must have the same version`,
      );
    }
  }
}

function applySchema(kind, value, label, errors) {
  if (value === undefined) return false;
  const validate = schemaValidators[kind];
  if (validate(value)) return true;
  for (const error of validate.errors || []) {
    errors.push(
      `${label}: schema ${error.instancePath || "/"} ${error.message}`,
    );
  }
  return false;
}

function rejectPrototypeNames(names, label, errors) {
  for (const name of names) {
    if (PROTOTYPE_NAMES.has(name)) errors.push(`${label}: prototype-like name ${name}`);
  }
}

function rejectDuplicateNames(names, label, errors) {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  for (const [name, count] of counts) {
    if (count > 1) errors.push(`${label}: duplicate plugin name ${name}`);
  }
}

function statEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function safeExistingPath({ boundary, candidate, label, errors, type }) {
  const lexicalBoundary = resolve(boundary);
  const lexicalCandidate = resolve(candidate);
  if (!pathIsInside(lexicalBoundary, lexicalCandidate)) {
    errors.push(`${label}: path escapes expected root`);
    return undefined;
  }
  const boundaryStats = statEntry(lexicalBoundary);
  if (!boundaryStats || boundaryStats.isSymbolicLink() || !boundaryStats.isDirectory()) {
    errors.push(`${label}: expected root must be a real directory`);
    return undefined;
  }
  const stats = statEntry(lexicalCandidate);
  if (!stats) {
    errors.push(`${label}: path does not exist`);
    return undefined;
  }
  const expectedCanonical = resolve(
    realpathSync(lexicalBoundary),
    relative(lexicalBoundary, lexicalCandidate),
  );
  let actualCanonical;
  try {
    actualCanonical = canonicalPath(lexicalCandidate);
  } catch (error) {
    errors.push(`${label}: ${messageOf(error)}`);
    return undefined;
  }
  if (stats.isSymbolicLink() || actualCanonical !== expectedCanonical) {
    errors.push(`${label}: symbolic path is not allowed`);
    return undefined;
  }
  if (type === "file" && !stats.isFile()) {
    errors.push(`${label}: expected a regular file`);
    return undefined;
  }
  if (type === "directory" && !stats.isDirectory()) {
    errors.push(`${label}: expected a directory`);
    return undefined;
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    errors.push(`${label}: special filesystem entries are not allowed`);
    return undefined;
  }
  return lexicalCandidate;
}

function safeRelativePath({ boundary, configuredPath, label, errors, type }) {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    errors.push(`${label}: expected a non-empty relative path`);
    return undefined;
  }
  if (isAbsolute(configuredPath) || win32.isAbsolute(configuredPath)) {
    errors.push(`${label}: absolute path is not allowed`);
    return undefined;
  }
  return safeExistingPath({
    boundary,
    candidate: resolve(boundary, configuredPath),
    label,
    errors,
    type,
  });
}

function strictWalk(root) {
  const files = walkFiles(root);
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`symbolic links are not allowed in staged components: ${path}`);
      }
      if (entry.isDirectory()) visit(path);
      else if (!entry.isFile()) {
        throw new Error(`special filesystem entries are not allowed in staged components: ${path}`);
      }
    }
  };
  visit(root);
  return files;
}

function markdownDestinations(markdown) {
  const events = postprocess(
    parseMarkdown().document().write(preprocess()(markdown, "utf8", true)),
  );
  return events
    .filter(([kind, token]) => kind === "exit" && LINK_DESTINATION_TYPES.has(token.type))
    .map(([, token]) => markdown.slice(token.start.offset, token.end.offset));
}

function localMarkdownPath(rawTarget) {
  if (!rawTarget || /^(?:[a-z][a-z\d+.-]*:|#)/i.test(rawTarget)) return undefined;
  const suffix = rawTarget.search(/[?#]/);
  const rawPath = suffix === -1 ? rawTarget : rawTarget.slice(0, suffix);
  if (!rawPath) return undefined;
  const unescaped = rawPath.replace(/\\(.)/g, "$1");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    throw new Error(`invalid percent encoding in local Markdown link: ${rawPath}`);
  }
}

function validateMarkdownLinks({ root, file, errors }) {
  const relativeFile = normalizedRelative(root, file);
  const markdown = readFileSync(file, "utf8");
  let destinations;
  try {
    destinations = markdownDestinations(markdown);
  } catch (error) {
    errors.push(`${relativeFile}: invalid Markdown (${messageOf(error)})`);
    return;
  }
  for (const rawTarget of destinations) {
    let target;
    try {
      target = localMarkdownPath(rawTarget);
    } catch (error) {
      errors.push(`${relativeFile}: ${messageOf(error)}`);
      continue;
    }
    if (target === undefined) continue;
    if (isAbsolute(target) || win32.isAbsolute(target)) {
      errors.push(`${relativeFile}: absolute local Markdown link -> ${target}`);
      continue;
    }
    const absoluteTarget = resolve(dirname(file), target);
    if (!pathIsInside(root, absoluteTarget)) {
      errors.push(`${relativeFile}: local Markdown link escapes skill tree -> ${target}`);
      continue;
    }
    const stats = statEntry(absoluteTarget);
    if (!stats) {
      errors.push(`${relativeFile}: broken local Markdown link -> ${target}`);
      continue;
    }
    const expectedCanonical = resolve(realpathSync(root), relative(root, absoluteTarget));
    if (
      stats.isSymbolicLink()
      || canonicalPath(absoluteTarget) !== expectedCanonical
      || (!stats.isFile() && !stats.isDirectory())
    ) {
      errors.push(`${relativeFile}: unsafe local Markdown link -> ${target}`);
    }
  }
}

export function validateRecursiveSkills(targetSkillsRoot) {
  const errors = [];
  const root = resolve(targetSkillsRoot);
  const rootStats = statEntry(root);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return [`${root}: skills root must be a real directory`];
  }
  let files;
  try {
    files = strictWalk(root);
  } catch (error) {
    return [messageOf(error).replaceAll(root, ".")];
  }
  const isCodex = root.replaceAll("\\", "/").includes("/targets/codex/skills");
  const names = new Map();
  for (const file of files) {
    if ([".md", ".markdown"].includes(extname(file).toLowerCase())) {
      validateMarkdownLinks({ root, file, errors });
    }
    if (basename(file) !== "SKILL.md") continue;
    const relativeFile = normalizedRelative(root, file);
    let attributes;
    try {
      ({ attributes } = parseFrontmatter(readFileSync(file, "utf8")));
    } catch (error) {
      errors.push(`${relativeFile}: invalid frontmatter (${messageOf(error)})`);
      continue;
    }
    if (!attributes.name) errors.push(`${relativeFile}: missing frontmatter name`);
    if (!attributes.description) errors.push(`${relativeFile}: missing frontmatter description`);
    if (attributes.name) {
      if (PROTOTYPE_NAMES.has(attributes.name)) {
        errors.push(`${relativeFile}: prototype-like skill name ${attributes.name}`);
      } else if (!/^[a-z0-9][a-z0-9-]*$/.test(attributes.name)) {
        errors.push(
          `${relativeFile}: skill name must match ^[a-z0-9][a-z0-9-]*$: ${attributes.name}`,
        );
      }
      const paths = names.get(attributes.name) || [];
      paths.push(relativeFile);
      names.set(attributes.name, paths);
    }
    if (isCodex && isTrueLike(attributes["disable-model-invocation"])) {
      errors.push(`${relativeFile}: disable-model-invocation must not be true-like in Codex`);
    }
  }
  for (const [name, paths] of names) {
    if (paths.length > 1) {
      errors.push(`duplicate skill name ${name}: ${paths.sort(compareCodePoints).join(", ")}`);
    }
  }
  return errors.sort(compareCodePoints);
}

function marketplaceNames(marketplace, label, errors) {
  if (!isPlainObject(marketplace) || !Array.isArray(marketplace.plugins)) {
    errors.push(`${label}: plugins must be an array`);
    return [];
  }
  const names = marketplace.plugins
    .map((entry) => entry?.name)
    .filter((name) => typeof name === "string");
  rejectPrototypeNames(names, label, errors);
  rejectDuplicateNames(names, label, errors);
  return sortedUnique(names);
}

function validateMarketplaceRoot({ marketplace, catalog, target, errors }) {
  const label = target === "claude" ? "Claude marketplace" : "Codex marketplace";
  if (!isPlainObject(marketplace)) {
    errors.push(`${label}: root must be an object`);
    return;
  }
  if (
    !isPlainObject(catalog)
    || !Array.isArray(catalog.plugins)
    || catalog.plugins.some((plugin) => !isPlainObject(plugin))
  ) return;
  const expected = addCaught(errors, label, () => (
    target === "claude"
      ? createClaudeMarketplace(catalog)
      : createCodexMarketplace(catalog)
  ));
  if (!expected) return;
  const expectedFields = Object.keys(expected).sort(compareCodePoints);
  const actualFields = Object.keys(marketplace).sort(compareCodePoints);
  for (const field of actualFields) {
    if (!expectedFields.includes(field)) {
      errors.push(`${label}: unexpected root field ${field}`);
    }
  }
  for (const field of expectedFields) {
    if (!Object.hasOwn(marketplace, field)) {
      errors.push(`${label}: missing root field ${field}`);
    }
  }
  if (Object.hasOwn(marketplace, "name") && marketplace.name !== catalog.name) {
    errors.push(`${label}: name must match catalog`);
  }
  const metadataFields = target === "claude"
    ? ["owner", "description"]
    : ["interface"];
  for (const field of metadataFields) {
    if (
      Object.hasOwn(marketplace, field)
      && stableJson(marketplace[field]) !== stableJson(expected[field])
    ) {
      errors.push(`${label}: ${field} must match generated marketplace`);
    }
  }
}

function exactNameAgreement(groups, errors) {
  const entries = Object.entries(groups);
  const baseline = entries[0]?.[1] || [];
  if (entries.every(([, names]) => sameValues(names, baseline))) return;
  errors.push("registry plugin names disagree: " + entries.map(([label, names]) => (
    `${label}=[${names.join(", ")}]`
  )).join("; "));
}

function pluginDirectories(repositoryRoot, errors) {
  const pluginsRoot = safeExistingPath({
    boundary: repositoryRoot,
    candidate: resolve(repositoryRoot, "plugins"),
    label: "plugins",
    errors,
    type: "directory",
  });
  if (!pluginsRoot) return [];
  const result = [];
  for (const entry of readdirSync(pluginsRoot, { withFileTypes: true })) {
    const path = resolve(pluginsRoot, entry.name);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      errors.push(`plugins/${entry.name}: plugin entry must be a real directory`);
      continue;
    }
    result.push(entry.name);
  }
  rejectPrototypeNames(result, "plugins", errors);
  return sortedUnique(result);
}

function validateMarketplaceEntries({
  repositoryRoot,
  marketplace,
  catalogByName,
  target,
  errors,
}) {
  if (!Array.isArray(marketplace?.plugins)) return;
  const allowedFields = target === "claude"
    ? new Set(["category", "description", "name", "source"])
    : new Set(["category", "name", "policy", "source"]);
  for (const [index, entry] of marketplace.plugins.entries()) {
    const entryLabel = `${target === "claude" ? "Claude" : "Codex"} marketplace entry ${index}`;
    if (!isPlainObject(entry) || typeof entry.name !== "string" || entry.name.length === 0) {
      errors.push(`${entryLabel}: entry must be an object with a name`);
      continue;
    }
    for (const field of Object.keys(entry).sort(compareCodePoints)) {
      if (!allowedFields.has(field)) errors.push(`${entryLabel}: unexpected field ${field}`);
    }
    const catalogPlugin = catalogByName.get(entry.name);
    const expected = `./plugins/${entry.name}/targets/${target}`;
    const actual = target === "claude" ? entry.source : entry.source?.path;
    if (actual !== expected) {
      errors.push(`${target} marketplace ${entry.name}: expected local source ${expected}`);
      continue;
    }
    if (target === "codex" && entry.source?.source !== "local") {
      errors.push(`codex marketplace ${entry.name}: source must be local`);
    }
    if (target === "codex" && isPlainObject(entry.source)) {
      for (const field of Object.keys(entry.source).sort(compareCodePoints)) {
        if (!["path", "source"].includes(field)) {
          errors.push(`codex marketplace ${entry.name}: unexpected source field ${field}`);
        }
      }
    }
    if (
      target === "codex"
      && (
        entry.policy?.installation !== "AVAILABLE"
        || entry.policy?.authentication !== "ON_INSTALL"
        || Object.keys(entry.policy || {}).some((field) => (
          !["authentication", "installation"].includes(field)
        ))
      )
    ) {
      errors.push(`codex marketplace ${entry.name}: invalid installation policy`);
    }
    if (catalogPlugin) {
      const expectedCategory = target === "claude"
        ? catalogPlugin.category
        : CODEX_CATEGORIES[catalogPlugin.category];
      if (entry.category !== expectedCategory) {
        errors.push(
          `${target} marketplace ${entry.name}: category must be ${expectedCategory}`,
        );
      }
      if (target === "claude" && entry.description !== catalogPlugin.description) {
        errors.push(`claude marketplace ${entry.name}: description must match catalog`);
      }
    }
    const expectedRoot = resolve(repositoryRoot, `plugins/${entry.name}`);
    const resolvedTarget = safeRelativePath({
      boundary: repositoryRoot,
      configuredPath: actual,
      label: `${target} marketplace ${entry.name}`,
      errors,
      type: "directory",
    });
    if (resolvedTarget && !pathIsInside(expectedRoot, resolvedTarget)) {
      errors.push(`${target} marketplace ${entry.name}: source escapes plugin bundle`);
    }
  }
}

function mapById(components, label, errors) {
  const result = new Map();
  if (!Array.isArray(components)) return result;
  for (const component of components) {
    if (!isPlainObject(component) || typeof component.id !== "string") continue;
    if (PROTOTYPE_NAMES.has(component.id)) {
      errors.push(`${label}: prototype-like component id ${component.id}`);
    }
    if (result.has(component.id)) errors.push(`${label}: duplicate component id ${component.id}`);
    else result.set(component.id, component);
  }
  return result;
}

function compareObject(left, right) {
  return stableJson(left) === stableJson(right);
}

function values(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const HOST_REFERENCES = {
  claude: [
    ["skills", ["skill"], "directory"],
    ["commands", ["command"], "file"],
    ["agents", ["agent"], "file"],
    ["hooks", ["hook"], "file"],
    ["mcpServers", ["mcp"], "file"],
    ["lspServers", ["lsp"], "file"],
    ["outputStyles", ["output-style"], "file"],
    ["channels", ["channel"], "file"],
  ],
  codex: [
    ["skills", ["skill", "command"], "directory"],
    ["hooks", ["hook"], "file"],
    ["mcpServers", ["mcp"], "file"],
    ["apps", ["app"], "file"],
  ],
};

function dispositionPaths({ manifest, target, type }) {
  return (manifest.components || [])
    .filter((component) => component.type === type)
    .map((component) => component.targets?.[target]?.path)
    .filter((path) => typeof path === "string");
}

function pathsOverlap(left, right) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

function validateHostManifest({ pluginRoot, plugin, manifest, target, errors }) {
  const targetRoot = resolve(pluginRoot, `targets/${target}`);
  const hostRelative = target === "claude"
    ? ".claude-plugin/plugin.json"
    : ".codex-plugin/plugin.json";
  const hostPath = safeExistingPath({
    boundary: targetRoot,
    candidate: resolve(targetRoot, hostRelative),
    label: `${plugin.name} ${target} host manifest`,
    errors,
    type: "file",
  });
  if (!hostPath) return;
  const host = readJsonFile(hostPath, `${plugin.name} ${target} host manifest`, errors);
  if (!isPlainObject(host)) return;
  if (host.name !== plugin.name) errors.push(`${plugin.name} ${target}: host manifest name mismatch`);
  if (host.version !== plugin.distributionVersion) {
    errors.push(`${plugin.name} ${target}: host manifest version mismatch`);
  }
  const referenceSpecs = [...HOST_REFERENCES[target]];
  if (target === "claude") {
    referenceSpecs.push(["experimental.themes", ["theme"], "directory"]);
    referenceSpecs.push(["experimental.monitors", ["monitor"], "file"]);
  }
  const referencesByType = new Map();
  for (const [field, types, expectedType] of referenceSpecs) {
    const configured = field.startsWith("experimental.")
      ? host.experimental?.[field.split(".")[1]]
      : host[field];
    for (const configuredPath of values(configured)) {
      const referenceLabel = `${plugin.name} ${target} manifest ${field}`;
      const resolvedPath = safeRelativePath({
        boundary: targetRoot,
        configuredPath,
        label: referenceLabel,
        errors,
        type: expectedType,
      });
      if (!resolvedPath) continue;
      for (const type of types) {
        referencesByType.set(type, [
          ...(referencesByType.get(type) || []),
          resolvedPath,
        ]);
      }
      const declared = types.flatMap((type) => (
        dispositionPaths({ manifest, target, type })
      )).map((path) => resolve(pluginRoot, path));
      if (!declared.some((path) => pathsOverlap(path, resolvedPath))) {
        errors.push(
          `${referenceLabel}: path is not declared by a ${types.join("/")} disposition`,
        );
      }
    }
  }
  for (const component of manifest.components || []) {
    const disposition = component.targets?.[target];
    if (
      !["preserved", "transformed"].includes(disposition?.status)
      || typeof disposition.path !== "string"
      || !referenceSpecs.some(([, types]) => types.includes(component.type))
    ) {
      continue;
    }
    const componentPath = resolve(pluginRoot, disposition.path);
    const references = referencesByType.get(component.type) || [];
    if (!references.some((path) => pathsOverlap(path, componentPath))) {
      errors.push(
        `${plugin.name} ${target}: missing host manifest reference for `
          + `${component.type} ${component.id}`,
      );
    }
  }
  return host;
}

function validateComponent({
  pluginRoot,
  plugin,
  manifest,
  lockComponents,
  component,
  errors,
}) {
  const label = `${plugin.name} component ${component.id}`;
  const lockComponent = lockComponents.get(component.id);
  if (!lockComponent) {
    errors.push(`${label}: missing from lock`);
    return;
  }
  if (lockComponent.type !== component.type) errors.push(`${label}: type mismatch with lock`);
  if (lockComponent.digest !== component.digest) errors.push(`${label}: digest mismatch with lock`);
  if (!compareObject(lockComponent.targets, component.targets)) {
    errors.push(`${label}: target dispositions mismatch with lock`);
  }
  const componentPath = safeRelativePath({
    boundary: pluginRoot,
    configuredPath: component.path,
    label,
    errors,
  });
  if (componentPath) {
    if (!pathIsInside(resolve(pluginRoot, "components"), componentPath)) {
      errors.push(`${label}: neutral component path escapes components root`);
    }
    const actualDigest = addCaught(errors, label, () => treeHash(componentPath));
    if (actualDigest && actualDigest !== component.digest) {
      errors.push(`${label}: component digest mismatch`);
    }
  }
  const configuredTargets = sortedUnique(plugin.targets || []);
  const dispositionTargets = isPlainObject(component.targets)
    ? Object.keys(component.targets).sort(compareCodePoints)
    : [];
  if (!sameValues(configuredTargets, dispositionTargets)) {
    errors.push(`${label}: target disposition coverage mismatch`);
  }
  for (const target of configuredTargets) {
    const disposition = component.targets?.[target];
    const targetDisposition = manifest.targets?.[target]?.components?.[component.id];
    if (!disposition) errors.push(`${label}: missing ${target} disposition`);
    if (!targetDisposition) errors.push(`${label}: missing ${target} target accounting`);
    if (disposition && targetDisposition && !compareObject(disposition, targetDisposition)) {
      errors.push(`${label}: ${target} disposition disagrees with target accounting`);
    }
    if (typeof disposition?.path === "string") {
      const expectedTargetRoot = resolve(pluginRoot, `targets/${target}`);
      const path = safeRelativePath({
        boundary: pluginRoot,
        configuredPath: disposition.path,
        label: `${label} ${target} disposition`,
        errors,
      });
      if (path && !pathIsInside(expectedTargetRoot, path)) {
        errors.push(`${label}: ${target} disposition escapes target projection`);
      }
    } else if (["preserved", "transformed"].includes(disposition?.status)) {
      errors.push(`${label}: ${target} supported disposition is missing path`);
    }
  }
}

function validateTarget({ pluginRoot, plugin, manifest, lockEntry, target, errors }) {
  const label = `${plugin.name} target ${target}`;
  const targetData = manifest.targets?.[target];
  if (!isPlainObject(targetData)) return;
  if (targetData.path !== `targets/${target}`) errors.push(`${label}: non-canonical target path`);
  const targetRoot = safeRelativePath({
    boundary: pluginRoot,
    configuredPath: targetData.path,
    label,
    errors,
    type: "directory",
  });
  if (!targetRoot) return;
  const componentIds = sortedUnique((manifest.components || [])
    .map((component) => component?.id)
    .filter((id) => typeof id === "string"));
  const targetComponentIds = isPlainObject(targetData.components)
    ? Object.keys(targetData.components).sort(compareCodePoints)
    : [];
  if (!sameValues(componentIds, targetComponentIds)) {
    errors.push(`${label}: ${target} target component set mismatch`);
  }
  const actualDigest = addCaught(errors, label, () => treeHash(targetRoot));
  if (actualDigest && actualDigest !== targetData.digest) errors.push(`${label}: target digest mismatch`);
  if (targetData.digest !== lockEntry.targets?.[target]) {
    errors.push(`${label}: target digest mismatch with lock`);
  }
  validateHostManifest({ pluginRoot, plugin, manifest, target, errors });
  const skillsRoot = resolve(targetRoot, "skills");
  if (existsSync(skillsRoot)) {
    for (const error of validateRecursiveSkills(skillsRoot)) {
      errors.push(`${plugin.name} ${target}: ${error}`);
    }
  }
}

function validateLocalSource({ repositoryRoot, plugin, errors }) {
  if (plugin.source?.type !== "local") return;
  const sourcePath = plugin.source.path;
  if (
    typeof sourcePath !== "string"
    || (!sourcePath.startsWith("sources/") && !sourcePath.startsWith("test/fixtures/"))
  ) {
    errors.push(`${plugin.name}: local source must be below sources/ or test/fixtures/`);
    return;
  }
  const boundaryName = sourcePath.startsWith("sources/") ? "sources" : "test/fixtures";
  const boundary = resolve(repositoryRoot, boundaryName);
  const source = safeRelativePath({
    boundary,
    configuredPath: relative(boundaryName, sourcePath),
    label: `${plugin.name} local source`,
    errors,
    type: "directory",
  });
  if (!source) return;
  const sourceRoot = plugin.source.root || ".";
  safeRelativePath({
    boundary: source,
    configuredPath: sourceRoot,
    label: `${plugin.name} local source root`,
    errors,
    type: "directory",
  });
}

function isAbsoluteRuntimePath(value) {
  return (
    isAbsolute(value)
    || win32.isAbsolute(value)
    || /^file:\/\//i.test(value)
  );
}

function runtimeStrings(value, path = [], result = []) {
  if (typeof value === "string") result.push({ path, value });
  else if (Array.isArray(value)) {
    value.forEach((entry, index) => runtimeStrings(entry, [...path, String(index)], result));
  } else if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      runtimeStrings(entry, [...path, key], result);
    }
  }
  return result;
}

function immutableContainerImage(image) {
  const match = /^([^@\s]+)@sha256:[a-f0-9]{64}$/u.exec(image);
  return Boolean(match && match[1].lastIndexOf(":") <= match[1].lastIndexOf("/"));
}

function parseContainerInvocation(args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("container runtime args must be an array of strings");
  }
  if (args[0] !== "run") throw new Error("container runtime command must use run");
  const options = [];
  let index = 1;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (!argument.startsWith("-")) break;
    if (CONTAINER_BOOLEAN_OPTIONS.has(argument) || /^-[it]{2}$/.test(argument)) {
      options.push({ option: argument });
      index += 1;
      continue;
    }
    const separator = argument.indexOf("=");
    const option = separator === -1 ? argument : argument.slice(0, separator);
    if (!CONTAINER_VALUE_OPTIONS.has(option)) {
      throw new Error(`unsupported container runtime option: ${argument}`);
    }
    const value = separator === -1 ? args[index + 1] : argument.slice(separator + 1);
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`container runtime option is missing a value: ${option}`);
    }
    options.push({ option, value });
    index += separator === -1 ? 2 : 1;
  }
  const image = args[index];
  if (typeof image !== "string" || image.length === 0) {
    throw new Error("container runtime command is missing an image");
  }
  if (!immutableContainerImage(image)) {
    throw new Error(`container image must use an immutable sha256 digest: ${image}`);
  }
  return { image, imageIndex: index, options };
}

function containerVolumeSource(value) {
  if (/^[A-Za-z]:[\\/]/u.test(value)) {
    const separator = value.indexOf(":", 2);
    return separator === -1 ? value : value.slice(0, separator);
  }
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(0, separator);
}

function validateContainerHostPaths(invocation, label, errors) {
  for (const { option, value } of invocation.options) {
    if (["-v", "--volume"].includes(option)) {
      const source = containerVolumeSource(value);
      if (isAbsoluteRuntimePath(source)) {
        errors.push(`${label}: absolute container bind source ${source}`);
      }
    }
    if (option !== "--mount") continue;
    const fields = Object.fromEntries(value.split(",").map((field) => {
      const separator = field.indexOf("=");
      return separator === -1
        ? [field.trim().toLowerCase(), ""]
        : [field.slice(0, separator).trim().toLowerCase(), field.slice(separator + 1)];
    }));
    const source = fields.source ?? fields.src;
    if (source && isAbsoluteRuntimePath(source)) {
      errors.push(`${label}: absolute container bind source ${source}`);
    }
  }
}

function argumentHostPath(argument) {
  if (isAbsoluteRuntimePath(argument)) return argument;
  const separator = argument.indexOf("=");
  if (separator === -1) return undefined;
  const value = argument.slice(separator + 1);
  return isAbsoluteRuntimePath(value) ? argument : undefined;
}

function validateNpxInvocation(args, runtimeDependencies, label, errors) {
  let index = 0;
  while (["-y", "--yes"].includes(args[index])) index += 1;
  if (args[index] === "--") index += 1;
  const packageSpec = args[index];
  const match = typeof packageSpec === "string"
    ? /^((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/u.exec(packageSpec)
    : undefined;
  if (!match || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(match[2])) {
    errors.push(`${label}: npx runtime package must use an exact version`);
    return;
  }
  if (!Object.hasOwn(runtimeDependencies, match[1])) {
    errors.push(`${label}: unpinned runtime package ${match[1]}`);
  } else if (runtimeDependencies[match[1]] !== match[2]) {
    errors.push(`${label}: runtime package disagrees with catalog pin ${packageSpec}`);
  }
}

function validateRuntimeInvocation(entry, label, errors, runtimeDependencies) {
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return;
  let runtime;
  try {
    runtime = classifyRuntimeCommand(entry.command);
  } catch (error) {
    errors.push(`${label}: ${messageOf(error)}`);
    return;
  }
  if (isAbsoluteRuntimePath(entry.command)) {
    errors.push(`${label}: absolute runtime path ${entry.command}`);
  }
  if (runtime.runtimeClass === "blocked") {
    errors.push(`${label}: unsupported dynamic runtime launcher ${runtime.stem}`);
    return;
  }
  if (runtime.runtimeClass === "container") {
    try {
      validateContainerHostPaths(parseContainerInvocation(entry.args), label, errors);
    } catch (error) {
      errors.push(`${label}: ${messageOf(error)}`);
    }
    return;
  }
  for (const argument of entry.args) {
    const unsafePath = typeof argument === "string" ? argumentHostPath(argument) : undefined;
    if (unsafePath) errors.push(`${label}: absolute runtime path ${unsafePath}`);
  }
  if (runtime.runtimeClass === "npx") {
    validateNpxInvocation(entry.args, runtimeDependencies, label, errors);
  }
}

function validateRuntimeJson(value, label, errors, runtimeDependencies = {}) {
  if (!isPlainObject(value) && !Array.isArray(value)) return;
  const inspect = (entry, path = []) => {
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => inspect(child, [...path, String(index)]));
      return;
    }
    if (!isPlainObject(entry)) return;
    validateRuntimeInvocation(entry, label, errors, runtimeDependencies);
    for (const [key, child] of Object.entries(entry)) {
      const nextPath = [...path, key];
      if (["env", "environment"].includes(key) && isPlainObject(child)) {
        for (const [name, secret] of Object.entries(child)) {
          if (typeof secret !== "string" || (secret !== "" && secret !== `\${${name}}`)) {
            errors.push(`${label}: concrete environment value at ${nextPath.join(".")}.${name}`);
          }
        }
      }
      inspect(child, nextPath);
    }
  };
  inspect(value);
  for (const { path, value: string } of runtimeStrings(value)) {
    const key = path.at(-1) || "";
    const parent = path.at(-2)?.toLowerCase();
    const runtimeField = parent === "args"
      || ["command", "image", "package", "version"].includes(key.toLowerCase());
    if (runtimeField && (
      /(?:@|:)(?:latest|next|\*|[xX])(?:$|[\s/])/u.test(string)
      || /@(?:[\^~><=].+|\d+(?:\.\d+)?\.(?:x|X|\*))$/u.test(string)
    )) {
      errors.push(`${label}: floating runtime selector ${string}`);
    }
    if (key.toLowerCase() === "image" && !immutableContainerImage(string)) {
      errors.push(`${label}: mutable OCI image ${string}`);
    }
    if (
      ["command", "cwd", "executable", "path"].includes(key.toLowerCase())
      && isAbsoluteRuntimePath(string)
    ) {
      errors.push(`${label}: absolute runtime path ${string}`);
    }
  }
}

function trustedComponentPath({ pluginRoot, configuredPath, containmentRoot }) {
  if (
    typeof configuredPath !== "string"
    || configuredPath.length === 0
    || isAbsolute(configuredPath)
    || win32.isAbsolute(configuredPath)
  ) {
    return undefined;
  }
  const pluginStats = statEntry(pluginRoot);
  const containmentStats = statEntry(containmentRoot);
  if (
    !pluginStats?.isDirectory()
    || pluginStats.isSymbolicLink()
    || !containmentStats?.isDirectory()
    || containmentStats.isSymbolicLink()
    || !pathIsInside(pluginRoot, containmentRoot)
  ) {
    return undefined;
  }
  const canonicalPluginRoot = realpathSync(pluginRoot);
  const expectedContainmentRoot = resolve(
    canonicalPluginRoot,
    relative(pluginRoot, containmentRoot),
  );
  if (canonicalPath(containmentRoot) !== expectedContainmentRoot) return undefined;
  const path = resolve(pluginRoot, configuredPath);
  if (!pathIsInside(containmentRoot, path)) return undefined;
  const stats = statEntry(path);
  if (!stats || stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    return undefined;
  }
  const expectedCanonical = resolve(
    expectedContainmentRoot,
    relative(containmentRoot, path),
  );
  return canonicalPath(path) === expectedCanonical ? path : undefined;
}

function componentMaterializationPaths({ pluginRoot, component }) {
  const paths = [];
  const neutral = trustedComponentPath({
    pluginRoot,
    configuredPath: component.path,
    containmentRoot: resolve(pluginRoot, "components"),
  });
  if (neutral) paths.push(neutral);
  for (const [target, disposition] of Object.entries(component.targets || {})) {
    const targetPath = trustedComponentPath({
      pluginRoot,
      configuredPath: disposition?.path,
      containmentRoot: resolve(pluginRoot, `targets/${target}`),
    });
    if (targetPath) paths.push(targetPath);
  }
  return sortedUnique(paths);
}

function runtimeComponentFiles({ pluginRoot, manifest }) {
  const records = new Map();
  for (const component of manifest.components || []) {
    if (!["app", "hook", "mcp"].includes(component.type)) continue;
    for (const path of componentMaterializationPaths({ pluginRoot, component })) {
      const stats = lstatSync(path);
      const files = stats.isFile() ? [path] : strictWalk(path);
      for (const file of files.filter((file) => extname(file).toLowerCase() === ".json")) {
        records.set(`${component.type}\0${file}`, { file, type: component.type });
      }
    }
  }
  return [...records.values()].sort((left, right) => compareCodePoints(left.file, right.file));
}

function executableComponentFiles({ pluginRoot, manifest }) {
  const paths = [];
  for (const component of manifest.components || []) {
    if (component.type !== "executable") continue;
    for (const path of componentMaterializationPaths({ pluginRoot, component })) {
      const stats = lstatSync(path);
      if (stats.isFile()) paths.push(path);
      else if (stats.isDirectory()) paths.push(...strictWalk(path));
    }
  }
  return sortedUnique(paths).filter((file) => SUPPORTED_SCRIPT_EXTENSIONS.has(extname(file)));
}

function syntaxFiles(repositoryRoot, pluginManifests) {
  const files = [];
  for (const relativeRoot of ["scripts"]) {
    const root = resolve(repositoryRoot, relativeRoot);
    const stats = statEntry(root);
    if (stats?.isSymbolicLink() || (stats && !stats.isDirectory())) {
      throw new Error(`${relativeRoot} must be a real directory`);
    }
    if (stats?.isDirectory()) {
      files.push(...strictWalk(root).filter((file) => SUPPORTED_SCRIPT_EXTENSIONS.has(extname(file))));
    }
  }
  const build = resolve(repositoryRoot, "build.sh");
  const buildStats = statEntry(build);
  if (buildStats?.isSymbolicLink() || (buildStats && !buildStats.isFile())) {
    throw new Error("build.sh must be a regular file");
  }
  if (buildStats?.isFile()) files.push(build);
  for (const entry of pluginManifests) files.push(...executableComponentFiles(entry));
  return sortedUnique(files);
}

function validateSyntax({ repositoryRoot, pluginManifests, processRunner, errors }) {
  for (const file of syntaxFiles(repositoryRoot, pluginManifests)) {
    const extension = extname(file).toLowerCase();
    const command = extension === ".sh" ? "bash" : process.execPath;
    const args = extension === ".sh" ? ["-n", file] : ["--check", file];
    let result;
    try {
      result = processRunner(command, args, {
        cwd: repositoryRoot,
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
    } catch (error) {
      errors.push(`${normalizedRelative(repositoryRoot, file)}: syntax check failed (${messageOf(error)})`);
      continue;
    }
    if (result?.status !== 0) {
      const detail = String(result?.stderr || result?.error?.message || "non-zero exit")
        .replace(/\s+/gu, " ")
        .trim();
      errors.push(`${normalizedRelative(repositoryRoot, file)}: syntax error${detail ? ` (${detail})` : ""}`);
    }
  }
}

function validateExceptions(value, errors, now = Date.now(), path = "catalog") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateExceptions(entry, errors, now, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = `${path}.${key}`;
    if (key === "exceptions") {
      const exceptions = Array.isArray(entry) ? entry : isPlainObject(entry) ? Object.values(entry) : [];
      if (!Array.isArray(entry) && !isPlainObject(entry)) {
        errors.push(`${nextPath}: exception metadata must be an array or object`);
      }
      exceptions.forEach((exception, index) => {
        const label = `${nextPath}[${index}]`;
        if (!isPlainObject(exception)) {
          errors.push(`${label}: exception metadata must be an object`);
          return;
        }
        const expiry = exception.expiresAt ?? exception.expires ?? exception.expiry;
        const timestamp = typeof expiry === "string" ? Date.parse(expiry) : Number.NaN;
        if (!Number.isFinite(timestamp)) errors.push(`${label}: exception expiry is not parseable`);
        else if (timestamp <= now) errors.push(`${label}: exception is expired`);
      });
    }
    validateExceptions(entry, errors, now, nextPath);
  }
}

function validatePlugin({ repositoryRoot, plugin, lock, lockEntry, processData, errors }) {
  const pluginRoot = resolve(repositoryRoot, `plugins/${plugin.name}`);
  const manifestPath = safeExistingPath({
    boundary: pluginRoot,
    candidate: resolve(pluginRoot, ".agent-plugin/plugin.json"),
    label: `${plugin.name} neutral manifest`,
    errors,
    type: "file",
  });
  if (!manifestPath || !isPlainObject(lockEntry)) return;
  const manifest = readJsonFile(manifestPath, `${plugin.name} neutral manifest`, errors);
  if (!isPlainObject(manifest)) return;
  applySchema("plugin", manifest, `${plugin.name} neutral manifest`, errors);
  if (manifest.name !== plugin.name || lockEntry.name !== plugin.name) {
    errors.push(`${plugin.name}: catalog, manifest, and lock names must match`);
  }
  if (
    manifest.distributionVersion !== plugin.distributionVersion
    || lockEntry.distributionVersion !== plugin.distributionVersion
  ) {
    errors.push(`${plugin.name}: catalog, manifest, and lock versions must match`);
  }
  if (!compareObject(plugin.source, lockEntry.source)) {
    errors.push(`${plugin.name}: source mismatch with lock`);
  }
  if (lockEntry.generatorDigest !== lock.generatorDigest) {
    errors.push(`${plugin.name}: generator digest mismatch`);
  }
  const configuredTargets = sortedUnique(plugin.targets || []);
  const manifestTargets = isPlainObject(manifest.targets)
    ? Object.keys(manifest.targets).sort(compareCodePoints)
    : [];
  const lockTargets = isPlainObject(lockEntry.targets)
    ? Object.keys(lockEntry.targets).sort(compareCodePoints)
    : [];
  if (!sameValues(configuredTargets, manifestTargets) || !sameValues(configuredTargets, lockTargets)) {
    errors.push(`${plugin.name}: configured target coverage mismatch`);
  }
  const manifestComponents = mapById(manifest.components, `${plugin.name} manifest`, errors);
  const lockComponents = mapById(lockEntry.components, `${plugin.name} lock`, errors);
  if (!sameValues(sortedUnique([...manifestComponents.keys()]), sortedUnique([...lockComponents.keys()]))) {
    errors.push(`${plugin.name}: manifest and lock component sets disagree`);
  }
  for (const component of manifestComponents.values()) {
    validateComponent({
      pluginRoot,
      plugin,
      manifest,
      lockComponents,
      component,
      errors,
    });
  }
  for (const target of configuredTargets.filter((target) => TARGETS.has(target))) {
    validateTarget({ pluginRoot, plugin, manifest, lockEntry, target, errors });
  }
  const actualBundleDigest = addCaught(errors, plugin.name, () => treeHash(pluginRoot));
  if (actualBundleDigest && actualBundleDigest !== lockEntry.bundleDigest) {
    errors.push(`${plugin.name}: bundle digest mismatch`);
  }
  if (plugin.source?.type === "github") {
    if (typeof plugin.source.sha !== "string" || !/^[a-f0-9]{40}$/.test(plugin.source.sha)) {
      errors.push(`${plugin.name}: GitHub source requires a full lowercase SHA`);
    }
    const licensePath = safeExistingPath({
      boundary: pluginRoot,
      candidate: resolve(pluginRoot, "LICENSE"),
      label: `${plugin.name} external LICENSE`,
      errors,
      type: "file",
    });
    if (licensePath && lstatSync(licensePath).size === 0) {
      errors.push(`${plugin.name}: external LICENSE must not be empty`);
    }
  } else validateLocalSource({ repositoryRoot, plugin, errors });
  for (const { file, type } of runtimeComponentFiles({ pluginRoot, manifest })) {
    const label = normalizedRelative(repositoryRoot, file);
    const json = readJsonFile(file, label, errors);
    if (json !== undefined) {
      if (type === "mcp") {
        addCaught(errors, label, () => normalizeMcp({
          record: { sourceFormat: "path", sourcePath: file },
          runtimePins: plugin.runtimeDependencies || {},
        }));
      } else if (type === "hook") {
        addCaught(errors, label, () => normalizeHooks({
          sourceFormat: "path",
          sourcePath: file,
        }));
      }
      validateRuntimeJson(
        json,
        label,
        errors,
        plugin.runtimeDependencies || {},
      );
    }
  }
  processData.push({ pluginRoot, manifest });
}

function previousLockValue(compareLock, repositoryRoot, currentLock, errors) {
  if (compareLock === undefined) return undefined;
  if (typeof compareLock === "function") {
    try {
      const result = compareLock({ repositoryRoot, currentLock: structuredClone(currentLock) });
      if (result && typeof result.then === "function") {
        errors.push("compareLock callback must be synchronous");
        return undefined;
      }
      return result;
    } catch (error) {
      errors.push(`compareLock callback failed: ${messageOf(error)}`);
      return undefined;
    }
  }
  if (isPlainObject(compareLock)) return compareLock;
  errors.push("compareLock must be a prior lock object or callback");
  return undefined;
}

function validatePreviousLock({ compareLock, repositoryRoot, currentLock, errors }) {
  const previous = previousLockValue(compareLock, repositoryRoot, currentLock, errors);
  if (previous === undefined) return;
  if (!applySchema("lock", previous, "previous registry lock", errors)) return;
  for (const [name, nextEntry] of Object.entries(currentLock.plugins || {})) {
    try {
      assertVersionChange({ previousEntry: previous.plugins?.[name], nextEntry });
    } catch (error) {
      errors.push(`${name}: ${messageOf(error)}`);
    }
  }
}

export function validateRepository({
  repositoryRoot,
  compareLock,
  processRunner = spawnSync,
}) {
  const errors = [];
  const root = resolve(repositoryRoot);
  const rootStats = statEntry(root);
  if (!rootStats || rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    return [`repository root must be a real directory: ${root}`];
  }

  const catalog = readRepositoryJson(root, "registry/catalog.json", errors);
  const lock = readRepositoryJson(root, "registry/lock.json", errors);
  const claudeMarketplace = readRepositoryJson(root, ".claude-plugin/marketplace.json", errors);
  const codexMarketplace = readRepositoryJson(root, ".agents/plugins/marketplace.json", errors);
  validateMaintainedSourceVersions(root, catalog, errors);
  applySchema("catalog", catalog, "registry/catalog.json", errors);
  applySchema("lock", lock, "registry/lock.json", errors);
  if (catalog !== undefined) validateExceptions(catalog, errors);

  const catalogPlugins = Array.isArray(catalog?.plugins) ? catalog.plugins : [];
  const catalogNamesRaw = catalogPlugins
    .map((plugin) => plugin?.name)
    .filter((name) => typeof name === "string");
  rejectPrototypeNames(catalogNamesRaw, "registry catalog", errors);
  rejectDuplicateNames(catalogNamesRaw, "registry catalog", errors);
  const catalogNames = sortedUnique(catalogNamesRaw);
  const catalogByName = new Map(catalogPlugins
    .filter((plugin) => isPlainObject(plugin) && typeof plugin.name === "string")
    .map((plugin) => [plugin.name, plugin]));
  validateMarketplaceRoot({
    marketplace: claudeMarketplace,
    catalog,
    target: "claude",
    errors,
  });
  validateMarketplaceRoot({
    marketplace: codexMarketplace,
    catalog,
    target: "codex",
    errors,
  });
  const lockNames = isPlainObject(lock?.plugins)
    ? Object.keys(lock.plugins).sort(compareCodePoints)
    : [];
  rejectPrototypeNames(lockNames, "registry lock", errors);
  exactNameAgreement({
    catalog: catalogNames,
    lock: lockNames,
    claude: marketplaceNames(claudeMarketplace, "Claude marketplace", errors),
    codex: marketplaceNames(codexMarketplace, "Codex marketplace", errors),
    plugins: pluginDirectories(root, errors),
  }, errors);
  validateMarketplaceEntries({
    repositoryRoot: root,
    marketplace: claudeMarketplace,
    catalogByName,
    target: "claude",
    errors,
  });
  validateMarketplaceEntries({
    repositoryRoot: root,
    marketplace: codexMarketplace,
    catalogByName,
    target: "codex",
    errors,
  });

  const processData = [];
  for (const plugin of catalogPlugins) {
    if (!isPlainObject(plugin) || typeof plugin.name !== "string") continue;
    const lockEntry = isPlainObject(lock?.plugins) && Object.hasOwn(lock.plugins, plugin.name)
      ? lock.plugins[plugin.name]
      : undefined;
    if (!lockEntry) continue;
    addCaught(errors, plugin.name, () => validatePlugin({
      repositoryRoot: root,
      plugin,
      lock,
      lockEntry,
      processData,
      errors,
    }));
  }
  addCaught(errors, "syntax validation", () => validateSyntax({
    repositoryRoot: root,
    pluginManifests: processData,
    processRunner,
    errors,
  }));
  if (isPlainObject(lock)) {
    addCaught(errors, "compareLock", () => validatePreviousLock({
      compareLock,
      repositoryRoot: root,
      currentLock: lock,
      errors,
    }));
  }
  return errors.sort(compareCodePoints);
}
