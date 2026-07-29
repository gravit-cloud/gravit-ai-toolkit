import { readFileSync } from "node:fs";
import { basename, extname, relative, resolve } from "node:path";
import {
  commandSourceFiles,
  commandToSkill,
  materializeComponent,
} from "../component-files.mjs";
import { parseFrontmatter } from "../frontmatter.mjs";
import { treeHash } from "../hash.mjs";
import { normalizeHooks, renderHooks } from "../hooks.mjs";
import { removeUndefined, writeJson } from "../json.mjs";
import { normalizeMcp, writeMcpConfig } from "../mcp.mjs";
import { compareCodePoints } from "../ordering.mjs";
import { assertInside } from "../path-safety.mjs";
import { renderSkills } from "../skills.mjs";

const CATEGORY = {
  cloud: "Cloud",
  development: "Development",
  productivity: "Productivity",
  seo: "Productivity",
};

function targetPath(bundleRoot, path) {
  return relative(bundleRoot, path).replaceAll("\\", "/");
}

function relativeSourcePath(component) {
  const value = component.metadata?.relativePath;
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error("path component requires a safe relativePath: " + component.id);
  }
  const segments = value.split("/");
  if (value.startsWith("/") || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("path component requires a safe relativePath: " + component.id);
  }
  return value;
}

function nativeDestination({ component, targetRoot }) {
  if (component.type === "app") return resolve(targetRoot, ".app.json");
  const root = component.type === "asset" ? "assets" : "bin";
  if (component.sourceFormat === "inline") {
    return assertInside(targetRoot, resolve(targetRoot, root, component.id + ".json"), "target component");
  }
  const sourceRelative = relativeSourcePath(component);
  const nested = sourceRelative === root || sourceRelative.startsWith(root + "/")
    ? sourceRelative
    : root + "/" + basename(sourceRelative);
  return assertInside(targetRoot, resolve(targetRoot, nested), "target component");
}

function commandSkillName(sourcePath) {
  const stem = basename(sourcePath, extname(sourcePath))
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!stem) throw new Error("command filename does not produce a valid skill name");
  parseFrontmatter(readFileSync(sourcePath, "utf8"));
  return stem;
}

function mergeHooks(records) {
  const hooks = {};
  for (const record of records) {
    const normalized = normalizeHooks(record);
    for (const event of Object.keys(normalized.hooks).sort(compareCodePoints)) {
      hooks[event] = [...(hooks[event] || []), ...normalized.hooks[event]];
    }
  }
  return { hooks };
}

export function renderCodexTarget({ plugin, inventory, neutralComponents, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/codex");
  const skillRoot = resolve(targetRoot, "skills");
  const records = new Map(inventory.components.map((component) => [component.id, component]));
  const components = {};
  const commandPlans = [];
  const nativePlans = [];
  const hooks = [];
  const mcps = [];

  const skillNames = new Set(inventory.skills.map(({ name }) => name));
  for (const neutral of neutralComponents) {
    const disposition = neutral.targets.codex;
    if (disposition.status === "unsupported" || disposition.status === "rejected") {
      components[neutral.id] = { ...disposition };
      continue;
    }
    if (neutral.type === "skill") continue;
    const record = records.get(neutral.id);
    if (!record) throw new Error("missing inventory component: " + neutral.id);
    if (neutral.type === "command") {
      const files = commandSourceFiles(record);
      const names = files.map(commandSkillName);
      for (const name of names) {
        if (skillNames.has(name)) throw new Error("duplicate target skill name: " + name);
        skillNames.add(name);
      }
      commandPlans.push({ component: record, files, names });
      continue;
    }
    if (neutral.type === "hook") hooks.push(record);
    else if (neutral.type === "mcp") mcps.push(record);
    else if (["app", "asset", "executable"].includes(neutral.type)) {
      nativePlans.push({
        component: record,
        destination: nativeDestination({ component: record, targetRoot }),
      });
    } else {
      throw new Error("unsupported Codex rendered component: " + neutral.type);
    }
  }

  const destinations = new Set();
  for (const { component, destination } of nativePlans.sort((left, right) => (
    compareCodePoints(left.destination, right.destination)
  ))) {
    if (destinations.has(destination)) {
      throw new Error("duplicate target component destination: " + destination);
    }
    destinations.add(destination);
  }

  const renderedSkills = renderSkills({
    skills: inventory.skills,
    destinationRoot: skillRoot,
    target: "codex",
  });
  for (const skill of renderedSkills) {
    const neutral = neutralComponents.find(({ id }) => id === skill.id);
    components[skill.id] = {
      ...neutral.targets.codex,
      path: targetPath(bundleRoot, skill.directory),
    };
  }

  for (const plan of commandPlans) {
    for (const sourcePath of plan.files) {
      commandToSkill({ component: { sourcePath }, destinationRoot: skillRoot });
    }
    const neutral = neutralComponents.find(({ id }) => id === plan.component.id);
    const componentPath = plan.files.length === 1
      ? resolve(skillRoot, plan.names[0])
      : skillRoot;
    components[plan.component.id] = {
      ...neutral.targets.codex,
      path: targetPath(bundleRoot, componentPath),
    };
  }

  for (const plan of nativePlans) {
    materializeComponent({
      component: plan.component,
      bundleRoot,
      destination: plan.destination,
    });
    const neutral = neutralComponents.find(({ id }) => id === plan.component.id);
    components[plan.component.id] = {
      ...neutral.targets.codex,
      path: targetPath(bundleRoot, plan.destination),
    };
  }

  if (hooks.length > 0) {
    const hookPath = resolve(targetRoot, "hooks/hooks.json");
    writeJson(hookPath, renderHooks({ config: mergeHooks(hooks), target: "codex" }));
    for (const record of hooks) {
      const neutral = neutralComponents.find(({ id }) => id === record.id);
      components[record.id] = {
        ...neutral.targets.codex,
        path: targetPath(bundleRoot, hookPath),
      };
    }
  }
  if (mcps.length > 0) {
    const mcpPath = resolve(targetRoot, ".mcp.json");
    writeMcpConfig({
      servers: mcps.flatMap((record) => normalizeMcp({
        record,
        runtimePins: plugin.runtimeDependencies || {},
      })),
      target: "codex",
      filePath: mcpPath,
    });
    for (const record of mcps) {
      const neutral = neutralComponents.find(({ id }) => id === record.id);
      components[record.id] = {
        ...neutral.targets.codex,
        path: targetPath(bundleRoot, mcpPath),
      };
    }
  }

  const manifest = removeUndefined({
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    author: { name: plugin.author || "Gravit Cloud" },
    skills: renderedSkills.length || commandPlans.length ? "./skills/" : undefined,
    mcpServers: mcps.length ? "./.mcp.json" : undefined,
    apps: nativePlans.some(({ component }) => component.type === "app")
      ? "./.app.json"
      : undefined,
    hooks: hooks.length ? "./hooks/hooks.json" : undefined,
    interface: {
      displayName: plugin.displayName || plugin.name,
      shortDescription: plugin.description.slice(0, 110),
      longDescription: plugin.description,
      developerName: plugin.author || "Gravit Cloud",
      category: CATEGORY[plugin.category],
      capabilities: [],
      defaultPrompt: [
        "Use " + (plugin.displayName || plugin.name) + " to help with this task.",
      ],
    },
  });
  writeJson(resolve(targetRoot, ".codex-plugin/plugin.json"), manifest);
  return { digest: treeHash(targetRoot), components };
}
