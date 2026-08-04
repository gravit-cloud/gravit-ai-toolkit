#!/usr/bin/env node

/**
 * Generate the native Codex plugin marketplace from the Claude marketplace.
 *
 * `.claude-plugin/marketplace.json` is the only curated source of truth:
 * linked plugins are downloaded at their immutable SHA, while the local
 * `gravit-custom` plugin is used directly from `plugins/gravit-custom`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const claudeMarketplacePath = join(root, ".claude-plugin/marketplace.json");
const codexMarketplacePath = join(root, ".agents/plugins/marketplace.json");
const pluginsRoot = join(root, "plugins");
const localPluginName = "gravit-custom";
const gigetCli = join(root, "node_modules/giget/dist/cli.mjs");
const temporaryRoot = mkdtempSync(join(tmpdir(), "gravit-codex-plugins-"));
const internalSkillResourceName = "SKILL.resource.md";
const codexDistributionVersionOverrides = new Map([
  ["azure@v1.2.8@1.2.8", "1.2.9-gravit.1"],
]);

const claudeMarketplace = readJson(claudeMarketplacePath);
const previousCodexMarketplace = existsSync(codexMarketplacePath)
  ? readJson(codexMarketplacePath)
  : { plugins: [] };

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    const details = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(`${command} ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
  }
  return result.stdout || "";
}

function giget(source, destination) {
  if (!existsSync(gigetCli)) {
    throw new Error("Missing pinned giget CLI. Run `npm ci` before syncing plugins.");
  }
  run(process.execPath, [gigetCli, source, destination, "--force"], { capture: true });
}

function fetchText(url, required = true) {
  const result = spawnSync("curl", ["-fsSL", url], { encoding: "utf8" });
  if (result.status === 0) return result.stdout;
  if (!required) return undefined;
  throw new Error(`Could not download ${url}: ${(result.stderr || "").trim()}`);
}

function fetchJson(url) {
  const text = fetchText(url, false);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${url}: invalid JSON (${error.message})`);
  }
}

function displayName(name) {
  const known = {
    "claude-seo": "Claude SEO",
    obsidian: "Obsidian",
    "mattpocock-skills": "Matt Pocock Skills",
    azure: "Azure",
    superpowers: "Superpowers",
    "gravit-custom": "Gravit Custom",
  };
  return known[name] || name.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" ");
}

function codexCategory(category) {
  return {
    cloud: "Cloud",
    development: "Development",
    productivity: "Productivity",
    seo: "Productivity",
  }[category] || "Productivity";
}

function semver(...candidates) {
  for (const candidate of candidates) {
    const normalized = String(candidate || "").replace(/^v/, "");
    if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(normalized)) {
      return normalized;
    }
  }
  return "0.0.0";
}

function truncate(text, maximum = 110) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, maximum - 1).trimEnd()}…`;
}

function authorName(author, fallback) {
  if (typeof author === "string" && author.trim()) return author.trim();
  if (author && typeof author.name === "string" && author.name.trim()) return author.name.trim();
  return fallback;
}

function createCodexManifest(plugin, upstreamManifest = {}, packageManifest = {}) {
  const name = plugin.name;
  const source = plugin.source;
  const fallbackAuthor = typeof source === "object" && source.repo
    ? source.repo.split("/")[0]
    : "Gravit Cloud";
  const developer = authorName(upstreamManifest.author, fallbackAuthor);
  const title = displayName(name);
  const category = codexCategory(plugin.category);
  const description = plugin.description || upstreamManifest.description || `${title} skills for Codex.`;
  const upstreamVersion = semver(
    upstreamManifest.version,
    packageManifest.version,
    source?.ref,
  );
  const distributionVersion = codexDistributionVersionOverrides.get(
    `${name}@${source?.ref}@${upstreamVersion}`,
  ) || upstreamVersion;

  return {
    name,
    version: distributionVersion,
    description,
    author: { name: developer },
    skills: "./skills/",
    interface: {
      displayName: title,
      shortDescription: truncate(description),
      longDescription: description,
      developerName: developer,
      category,
      capabilities: [],
      websiteURL: plugin.homepage || upstreamManifest.homepage || undefined,
      defaultPrompt: `Use ${title} to help with this task.`,
    },
  };
}

function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, removeUndefined(child)]),
  );
}

function skillCount(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "SKILL.md")))
    .length;
}

function findSkillDirectories(directory, result = [], insideSkill = false) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    const skillFile = join(path, "SKILL.md");
    const isSkill = existsSync(skillFile);
    const hasFrontmatter = isSkill && /^---\r?\n[\s\S]*?\r?\n---/.test(readFileSync(skillFile, "utf8"));

    // Some upstream skills contain internal phase modules named SKILL.md.
    // Keep those resources inside their parent, but only flatten nested files
    // that declare skill frontmatter and are therefore standalone skills.
    if (isSkill && (!insideSkill || hasFrontmatter)) result.push(path);
    findSkillDirectories(path, result, insideSkill || isSkill);
  }
  return result;
}

function findMarkdownFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findMarkdownFiles(path, result);
    else if (entry.name.endsWith(".md")) result.push(path);
  }
  return result;
}

function nestedWithin(parent, candidate) {
  const nested = relative(parent, candidate);
  return nested !== "" && !nested.startsWith("..") && !isAbsolute(nested);
}

function findNestedSkillFiles(directory, rootDirectory = directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findNestedSkillFiles(path, rootDirectory, result);
    else if (
      entry.isFile()
      && entry.name === "SKILL.md"
      && dirname(path) !== rootDirectory
    ) {
      result.push(path);
    }
  }
  return result;
}

function owningSkill(mappings, sourcePath) {
  return mappings
    .filter((mapping) => (
      sourcePath === mapping.source || nestedWithin(mapping.source, sourcePath)
    ))
    .sort((left, right) => right.source.length - left.source.length)[0];
}

function mappedSourcePath(sourcePath, mappings, internalResources) {
  const resource = internalResources.find((entry) => entry.source === sourcePath);
  if (resource) return resource.destination;
  const owner = owningSkill(mappings, sourcePath);
  if (!owner) return undefined;
  return join(owner.destination, relative(owner.source, sourcePath));
}

function rewriteInternalSkillReferences(
  markdown,
  sourceMarkdownFile,
  mappings,
  internalResources,
) {
  const owner = owningSkill(mappings, sourceMarkdownFile);
  const pathPattern = /(?<![A-Za-z0-9._~%+\/-])(?:(?:\.{1,2}|[A-Za-z0-9._~%+-]+)\/)+SKILL\.md/g;
  return markdown.replace(pathPattern, (rawPath) => {
    const directSource = resolve(dirname(sourceMarkdownFile), rawPath);
    let matches = internalResources.filter((entry) => entry.source === directSource);
    if (matches.length === 0 && owner) {
      matches = internalResources.filter((entry) => {
        if (!nestedWithin(owner.source, entry.source)) return false;
        const ownerRelative = relative(owner.source, entry.source).replaceAll("\\", "/");
        return rawPath === ownerRelative || rawPath.endsWith("/" + ownerRelative);
      });
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous internal SKILL.md reference: ${sourceMarkdownFile} -> ${rawPath}`);
    }
    if (matches.length === 0) return rawPath;
    return rawPath.slice(0, -"SKILL.md".length) + internalSkillResourceName;
  });
}

function skillName(directory) {
  const markdown = readFileSync(join(directory, "SKILL.md"), "utf8");
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const name = frontmatter?.[1].match(/^name:\s*["']?([^\r\n"']+)/m)?.[1]?.trim();
  return name || basename(directory);
}

function prepareCodexSkills(skillsRoot, declaredSkills) {
  const selected = Array.isArray(declaredSkills)
    ? declaredSkills.map((path) => resolve(skillsRoot, path.replace(/^\.\/skills\//, "")))
    : findSkillDirectories(skillsRoot);
  const flattened = `${skillsRoot}.codex`;
  const names = new Set();
  mkdirSync(flattened, { recursive: true });

  const mappings = selected.map((source) => {
    if (!existsSync(join(source, "SKILL.md"))) {
      throw new Error(`Declared skill is missing SKILL.md: ${source}`);
    }
    const name = skillName(source);
    if (names.has(name)) throw new Error(`Duplicate Codex skill name: ${name}`);
    names.add(name);
    const destination = join(flattened, name);
    return { source, destination };
  });

  const internalResources = [];
  for (const mapping of mappings) {
    const descendantSkills = mappings
      .filter((candidate) => nestedWithin(mapping.source, candidate.source))
      .map((candidate) => candidate.source);
    cpSync(mapping.source, mapping.destination, {
      recursive: true,
      filter(sourcePath) {
        return !descendantSkills.some((descendant) => (
          sourcePath === descendant || nestedWithin(descendant, sourcePath)
        ));
      },
    });

    for (const destinationFile of findNestedSkillFiles(mapping.destination)) {
      const resourceDestination = join(dirname(destinationFile), internalSkillResourceName);
      if (existsSync(resourceDestination)) {
        throw new Error(`Internal skill resource destination already exists: ${resourceDestination}`);
      }
      const sourceFile = join(
        mapping.source,
        relative(mapping.destination, destinationFile),
      );
      renameSync(destinationFile, resourceDestination);
      internalResources.push({ source: sourceFile, destination: resourceDestination });
    }

    // Claude supports user-only skills. Codex plugins currently require this
    // flag to be absent or false, so generated copies use Codex's implicit
    // invocation behavior while the upstream Claude plugin remains unchanged.
    const markdownPath = join(mapping.destination, "SKILL.md");
    const markdown = readFileSync(markdownPath, "utf8")
      .replace(/^disable-model-invocation:\s*true\s*\r?\n/m, "");
    writeFileSync(markdownPath, markdown);
  }

  // Flattening nested Claude skills changes their relative position. Rewrite
  // links throughout copied Markdown so they continue to resolve in Codex.
  for (const mapping of mappings) {
    for (const destinationMarkdown of findMarkdownFiles(mapping.destination)) {
      const internalResource = internalResources.find(
        (entry) => entry.destination === destinationMarkdown,
      );
      const sourceMarkdown = internalResource?.source || join(
        mapping.source,
        relative(mapping.destination, destinationMarkdown),
      );
      const sourceOwner = owningSkill(mappings, sourceMarkdown);
      const isCanonicalSkill = destinationMarkdown === join(mapping.destination, "SKILL.md");
      let markdown = readFileSync(destinationMarkdown, "utf8").replace(
        /\[([^\]]+)]\(([^)]+)\)/g,
        (whole, label, rawTarget) => {
          const target = rawTarget.trim().replace(/^<|>$/g, "");
          if (!target || /^(https?:|mailto:|#)/.test(target)) return whole;
          const [targetPath, anchor = ""] = target.split("#", 2);
          if (!targetPath || targetPath.includes(" ")) return whole;
          const absoluteTarget = resolve(dirname(sourceMarkdown), targetPath);
          const mappedTarget = existsSync(absoluteTarget)
            ? mappedSourcePath(absoluteTarget, mappings, internalResources)
            : undefined;
          const unchangedTarget = sourceOwner
            ? join(
              sourceOwner.destination,
              relative(sourceOwner.source, absoluteTarget),
            )
            : undefined;

          if (mappedTarget && (isCanonicalSkill || mappedTarget !== unchangedTarget)) {
            let rewritten = relative(dirname(destinationMarkdown), mappedTarget)
              .replaceAll("\\", "/");
            if (!rewritten.startsWith(".")) rewritten = `./${rewritten}`;
            return `[${label}](${rewritten}${anchor ? `#${anchor}` : ""})`;
          }

          // These links are already dangling at the pinned Azure revision. Keep
          // the guidance text but do not ship a broken local Markdown target.
          if (/\/(?:quota\/quota|foundry-agent\/create\/create-hosted)\.md$/.test(absoluteTarget)) {
            return label;
          }
          return whole;
        },
      );
      markdown = rewriteInternalSkillReferences(
        markdown,
        sourceMarkdown,
        mappings,
        internalResources,
      );
      writeFileSync(destinationMarkdown, markdown);
    }
  }

  // Remove the link syntax (not the guidance text) for dangling links already
  // present in the pinned Azure source, including duplicated nested resources.
  for (const markdownPath of findMarkdownFiles(flattened)) {
    const markdown = readFileSync(markdownPath, "utf8").replace(
      /\[([^\]]+)]\(([^)]*(?:quota\/quota|foundry-agent\/create\/create-hosted)\.md(?:#[^)]*)?)\)/g,
      "$1",
    );
    writeFileSync(markdownPath, markdown);
  }

  rmSync(skillsRoot, { recursive: true, force: true });
  renameSync(flattened, skillsRoot);
}

function installLinkedPlugin(plugin) {
  const { repo, ref, sha } = plugin.source;
  if (!repo || !ref || !/^[a-f0-9]{40}$/.test(sha || "")) {
    throw new Error(`${plugin.name}: linked sources require repo, ref and an immutable 40-character sha`);
  }

  const stage = join(temporaryRoot, plugin.name);
  const destination = join(pluginsRoot, plugin.name);
  mkdirSync(stage, { recursive: true });

  console.log(`  ↓ ${plugin.name} (${repo} @ ${ref}, ${sha.slice(0, 12)})`);
  giget(`gh:${repo}/skills#${sha}`, join(stage, "skills"));

  const rawBase = `https://raw.githubusercontent.com/${repo}/${sha}`;
  const upstreamManifest = fetchJson(`${rawBase}/.claude-plugin/plugin.json`);
  const packageManifest = fetchJson(`${rawBase}/package.json`);
  writeFileSync(join(stage, "LICENSE"), fetchText(`${rawBase}/LICENSE`));
  prepareCodexSkills(join(stage, "skills"), upstreamManifest.skills);

  // claude-seo's seo-flow skill links to shared framework assets outside skills/.
  if (plugin.name === "claude-seo") {
    giget(`gh:${repo}/assets#${sha}`, join(stage, "assets"));
  }

  writeJson(
    join(stage, ".codex-plugin/plugin.json"),
    removeUndefined(createCodexManifest(plugin, upstreamManifest, packageManifest)),
  );

  rmSync(destination, { recursive: true, force: true });
  renameSync(stage, destination);
  console.log(`    → ${skillCount(join(destination, "skills"))} Codex skill(s)`);
}

function configureLocalPlugin(plugin) {
  const configuredPath = typeof plugin.source === "string" ? plugin.source : "";
  const destination = resolve(root, configuredPath);
  if (basename(destination) !== plugin.name) {
    throw new Error(`${plugin.name}: local source directory must match the plugin name (${configuredPath})`);
  }
  if (!existsSync(join(destination, "skills"))) {
    throw new Error(`${plugin.name}: missing ${configuredPath}/skills`);
  }

  const upstreamManifest = readJson(join(destination, ".claude-plugin/plugin.json"));
  const packageManifest = readJson(join(root, "package.json"));
  writeJson(
    join(destination, ".codex-plugin/plugin.json"),
    removeUndefined(createCodexManifest(plugin, upstreamManifest, packageManifest)),
  );
  console.log(`  • ${plugin.name} (${configuredPath}) → ${skillCount(join(destination, "skills"))} Codex skill(s)`);
}

function removeStaleGeneratedPlugins(currentNames) {
  for (const plugin of previousCodexMarketplace.plugins || []) {
    if (plugin.name === localPluginName || currentNames.has(plugin.name)) continue;
    const path = plugin.source?.source === "local" ? plugin.source.path : "";
    if (path === `./plugins/${plugin.name}`) {
      rmSync(join(root, path), { recursive: true, force: true });
      console.log(`  × removed stale generated plugin ${plugin.name}`);
    }
  }
}

try {
  mkdirSync(pluginsRoot, { recursive: true });
  const currentNames = new Set(claudeMarketplace.plugins.map((plugin) => plugin.name));
  removeStaleGeneratedPlugins(currentNames);

  console.log("Syncing native Codex plugins from the Claude marketplace…");
  for (const plugin of claudeMarketplace.plugins) {
    if (typeof plugin.source === "object" && plugin.source.source === "github") {
      installLinkedPlugin(plugin);
    } else if (plugin.name === localPluginName) {
      configureLocalPlugin(plugin);
    } else {
      throw new Error(`${plugin.name}: unsupported marketplace source`);
    }
  }

  const codexMarketplace = {
    name: claudeMarketplace.name,
    interface: { displayName: claudeMarketplace.owner?.name || "Gravit Cloud" },
    plugins: claudeMarketplace.plugins.map((plugin) => ({
      name: plugin.name,
      source: { source: "local", path: `./plugins/${plugin.name}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: codexCategory(plugin.category),
    })),
  };
  writeJson(codexMarketplacePath, codexMarketplace);

  const total = claudeMarketplace.plugins.reduce(
    (count, plugin) => count + skillCount(join(pluginsRoot, plugin.name, "skills")),
    0,
  );
  console.log(`\nDone. ${claudeMarketplace.plugins.length} Codex plugins with ${total} skills are ready.`);
  console.log("Commit .agents/ and plugins/ after reviewing the generated changes.");
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
