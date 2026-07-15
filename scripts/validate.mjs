#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  try {
    return JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    errors.push(`${file}: invalid JSON (${error.message})`);
    return {};
  }
}

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const lines = match[1].split(/\r?\n/);
  const values = {};
  for (let index = 0; index < lines.length; index += 1) {
    const field = lines[index].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const [, key, rawValue] = field;
    const value = rawValue.trim();
    if (key === "description" && /^[>|][+-]?$/.test(value)) {
      const block = [];
      for (index += 1; index < lines.length; index += 1) {
        if (/^\S/.test(lines[index])) {
          index -= 1;
          break;
        }
        block.push(lines[index].replace(/^\s{2}/, ""));
      }
      values[key] = value.startsWith(">")
        ? block.join("\n").replace(/(?<!\n)\n(?!\n)/g, " ").trim()
        : block.join("\n").trim();
      continue;
    }
    values[key] = value.replace(/^["']|["']$/g, "");
  }
  return values;
}

function checkSkillLinks(skillFile) {
  const markdown = readFileSync(skillFile, "utf8");
  const links = /\[[^\]]+\]\(([^)]+)\)/g;
  for (let match; (match = links.exec(markdown)); ) {
    const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
    if (
      !target ||
      /^(https?:|mailto:|vscode:|codex:|#)/.test(target) ||
      /^(url|link)$/i.test(target) ||
      target.includes("<") ||
      target.includes(" ") ||
      target.includes(",")
    ) continue;
    if (!existsSync(resolve(dirname(skillFile), target))) {
      errors.push(`${relative(root, skillFile)}: broken relative link -> ${target}`);
    }
  }
}

for (const file of [
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "plugins/gravit-custom/.claude-plugin/plugin.json",
  "plugins/gravit-custom/.codex-plugin/plugin.json",
  "package.json",
  "renovate.json",
]) readJson(file);

const packageManifest = readJson("package.json");
const localClaudeManifest = readJson("plugins/gravit-custom/.claude-plugin/plugin.json");
const localCodexManifest = readJson("plugins/gravit-custom/.codex-plugin/plugin.json");
for (const [label, version] of [
  ["gravit-custom Claude plugin", localClaudeManifest.version],
  ["gravit-custom Codex plugin", localCodexManifest.version],
]) {
  if (version !== packageManifest.version) {
    errors.push(`package.json and ${label} must have the same version`);
  }
}

const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
const codexMarketplace = readJson(".agents/plugins/marketplace.json");
const claudePlugins = Array.isArray(claudeMarketplace.plugins) ? claudeMarketplace.plugins : [];
const codexPlugins = Array.isArray(codexMarketplace.plugins) ? codexMarketplace.plugins : [];

for (const plugin of claudePlugins) {
  if (typeof plugin.source === "object" && plugin.source.source === "github") {
    if (!plugin.source.ref || !/^[a-f0-9]{40}$/.test(plugin.source.sha || "")) {
      errors.push(`Claude marketplace plugin ${plugin.name} must define ref and a 40-character sha`);
    }
  } else if (plugin.name === "gravit-custom" && plugin.source !== "./plugins/gravit-custom") {
    errors.push("gravit-custom must use ./plugins/gravit-custom as its Claude source");
  }
}

const claudeNames = claudePlugins.map((plugin) => plugin.name);
const codexNames = codexPlugins.map((plugin) => plugin.name);
if (JSON.stringify(claudeNames) !== JSON.stringify(codexNames)) {
  errors.push("Claude and Codex marketplaces must contain the same plugins in the same order");
}

if (new Set(codexNames).size !== codexNames.length) {
  errors.push("Codex marketplace contains duplicate plugin names");
}

for (const entry of codexPlugins) {
  const expectedPath = `./plugins/${entry.name}`;
  if (entry.source?.source !== "local" || entry.source.path !== expectedPath) {
    errors.push(`Codex marketplace ${entry.name}: expected local source ${expectedPath}`);
  }
  if (entry.policy?.installation !== "AVAILABLE" || entry.policy?.authentication !== "ON_INSTALL") {
    errors.push(`Codex marketplace ${entry.name}: invalid installation policy`);
  }

  const pluginRoot = join(root, "plugins", entry.name);
  const manifestPath = join(pluginRoot, ".codex-plugin/plugin.json");
  if (!existsSync(manifestPath)) {
    errors.push(`plugins/${entry.name}: missing .codex-plugin/plugin.json`);
    continue;
  }

  const manifest = readJson(relative(root, manifestPath));
  if (basename(pluginRoot) !== manifest.name || manifest.name !== entry.name) {
    errors.push(`plugins/${entry.name}: directory, manifest, and marketplace names must match`);
  }
  if (!semver.test(manifest.version || "")) {
    errors.push(`plugins/${entry.name}: invalid semantic version`);
  }
  if (!manifest.description || !manifest.author?.name || manifest.skills !== "./skills/") {
    errors.push(`plugins/${entry.name}: incomplete Codex plugin manifest`);
  }
  for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category", "defaultPrompt"]) {
    if (!manifest.interface?.[field]) errors.push(`plugins/${entry.name}: missing interface.${field}`);
  }
  if (!Array.isArray(manifest.interface?.capabilities)) {
    errors.push(`plugins/${entry.name}: interface.capabilities must be an array`);
  }

  const skillsRoot = join(pluginRoot, "skills");
  if (!existsSync(skillsRoot)) {
    errors.push(`plugins/${entry.name}: missing skills directory`);
    continue;
  }
  for (const skillDirectory of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!skillDirectory.isDirectory()) continue;
    const skillFile = join(skillsRoot, skillDirectory.name, "SKILL.md");
    if (!existsSync(skillFile)) {
      errors.push(`plugins/${entry.name}/skills/${skillDirectory.name}: missing SKILL.md`);
      continue;
    }
    const fm = frontmatter(readFileSync(skillFile, "utf8"));
    if (!fm.name) errors.push(`${relative(root, skillFile)}: missing frontmatter name`);
    if (fm.name && fm.name !== skillDirectory.name) {
      errors.push(`${relative(root, skillFile)}: skill name must match its directory`);
    }
    if (!fm.description) errors.push(`${relative(root, skillFile)}: missing frontmatter description`);
    if (fm["disable-model-invocation"] === "true") {
      errors.push(`${relative(root, skillFile)}: disable-model-invocation must not be true in a Codex plugin`);
    }
    checkSkillLinks(skillFile);
  }
}

for (const [command, args] of [
  ["bash", ["-n", "build.sh", "scripts/renovate-plugin-sync.sh"]],
  ["node", ["--check", "scripts/sync-plugins.mjs"]],
  ["node", ["--check", "scripts/set-version.mjs"]],
]) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) errors.push(`${command} ${args.join(" ")}: ${result.stderr.trim()}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Validation passed (${codexPlugins.length} Codex plugins).`);
