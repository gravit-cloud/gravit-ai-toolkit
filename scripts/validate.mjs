#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function checkJson(file) {
  try {
    JSON.parse(readFileSync(join(root, file), "utf8"));
  } catch (error) {
    errors.push(`${file}: invalid JSON (${error.message})`);
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
    if ((key === "description") && /^[>|][+-]?$/.test(value)) {
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

function walk(directory, visitor) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path, visitor);
    else visitor(path);
  }
}

for (const file of [
  ".claude-plugin/marketplace.json",
  "custom/.claude-plugin/plugin.json",
  "custom/skills-lock.json",
  "package.json",
  "renovate.json",
]) checkJson(file);

const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const pluginManifest = JSON.parse(readFileSync(join(root, "custom/.claude-plugin/plugin.json"), "utf8"));
if (packageManifest.version !== pluginManifest.version) {
  errors.push("package.json and custom/.claude-plugin/plugin.json must have the same version");
}

const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
for (const plugin of marketplace.plugins) {
  if (typeof plugin.source !== "object" || plugin.source.source !== "github") continue;
  if (!plugin.source.ref || !/^[a-f0-9]{40}$/.test(plugin.source.sha || "")) {
    errors.push(`marketplace plugin ${plugin.name} must define ref and a 40-character sha`);
  }
}

if (!existsSync(join(root, "custom/THIRD_PARTY_NOTICES.md"))) {
  errors.push("custom/THIRD_PARTY_NOTICES.md is missing");
}
for (const license of [
  "custom/licenses/claude-seo-MIT.txt",
  "custom/licenses/obsidian-skills-MIT.txt",
  "custom/licenses/mattpocock-skills-MIT.txt",
]) {
  if (!existsSync(join(root, license))) errors.push(`${license} is missing`);
}

for (const directory of ["custom/skills", "codex/sources"]) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) continue;
  walk(absolute, (file) => {
    if (!file.endsWith("SKILL.md")) return;
    const fm = frontmatter(readFileSync(file, "utf8"));
    if (!fm.name) errors.push(`${relative(root, file)}: missing frontmatter name`);
    if (!fm.description) errors.push(`${relative(root, file)}: missing frontmatter description`);
  });
}

const manifestPath = join(root, "codex/skills-manifest.json");
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.skills) || manifest.count !== manifest.skills.length) {
    errors.push("codex/skills-manifest.json: count does not match skills array");
  } else {
    for (const skill of manifest.skills) {
      const skillPath = join(root, "codex", skill.path || "");
      if (!skill.path || !existsSync(skillPath)) {
        errors.push(`codex manifest: missing skill path ${skill.path || "<empty>"}`);
      }
      if (!skill.description || skill.description === ">" || skill.description === "|") {
        errors.push(`codex manifest: unusable description for ${skill.name}`);
      }
      if (!existsSync(skillPath)) continue;

      const markdown = readFileSync(skillPath, "utf8");
      const links = /\[[^\]]+\]\(([^)]+)\)/g;
      for (let match; (match = links.exec(markdown)); ) {
        const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
        if (
          !target ||
          /^(https?:|mailto:|vscode:|#)/.test(target) ||
          /^(url|link)$/i.test(target) ||
          target.includes("<") ||
          target.includes(" ") ||
          target.includes(",")
        ) continue;
        if (!existsSync(resolve(join(skillPath, ".."), target))) {
          errors.push(`codex skill link: ${skill.path} -> ${target}`);
        }
      }
    }
  }
}

for (const command of [
  ["bash", ["-n", "build.sh", "codex/sync.sh"]],
  ["node", ["--check", "codex/gen-index.mjs"]],
]) {
  const result = spawnSync(command[0], command[1], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) errors.push(`${command[0]} ${command[1].join(" ")}: ${result.stderr.trim()}`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Validation passed.");
