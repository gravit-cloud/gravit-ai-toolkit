import { lstatSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import {
  assertJsonSingletonComponent,
  commandSourceFiles,
  materializeComponent,
} from "../component-files.mjs";
import { treeHash } from "../hash.mjs";
import { normalizeHooks, renderHooks } from "../hooks.mjs";
import { removeUndefined, writeJson } from "../json.mjs";
import { normalizeMcp, writeMcpConfig } from "../mcp.mjs";
import { compareCodePoints } from "../ordering.mjs";
import { assertInside, walkFiles } from "../path-safety.mjs";
import { renderSkills } from "../skills.mjs";

const ROOTS = {
  command: "commands",
  agent: "agents",
  "output-style": "output-styles",
  channel: "channels",
  theme: "themes",
  executable: "bin",
  asset: "assets",
};

const SINGLETONS = {
  lsp: ".lsp.json",
  monitor: "monitors/monitors.json",
  settings: "settings.json",
};

function targetPath(bundleRoot, path) {
  return relative(bundleRoot, path).replaceAll("\\", "/");
}

function manifestPath(targetRoot, path, directory = false) {
  const value = "./" + relative(targetRoot, path).replaceAll("\\", "/");
  return directory && !value.endsWith("/") ? value + "/" : value;
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
  if (SINGLETONS[component.type]) {
    return assertInside(targetRoot, resolve(targetRoot, SINGLETONS[component.type]), "target component");
  }
  const root = ROOTS[component.type];
  if (!root) throw new Error("unsupported Claude native component: " + component.type);
  if (component.sourceFormat === "inline") {
    return assertInside(
      targetRoot,
      resolve(targetRoot, root, component.id + ".json"),
      "target component",
    );
  }
  const sourceRelative = relativeSourcePath(component);
  const nested = sourceRelative === root || sourceRelative.startsWith(root + "/")
    ? sourceRelative
    : root + "/" + basename(sourceRelative);
  return assertInside(targetRoot, resolve(targetRoot, nested), "target component");
}

function commandOutputs({ component, targetRoot }) {
  const files = commandSourceFiles(component);
  const componentDestination = nativeDestination({ component, targetRoot });
  if (lstatSync(component.sourcePath).isFile()) {
    return { componentDestination, files: [[files[0], componentDestination]] };
  }
  return {
    componentDestination,
    files: files.map((sourcePath) => [
      sourcePath,
      assertInside(
        componentDestination,
        resolve(componentDestination, relative(component.sourcePath, sourcePath)),
        "target command",
      ),
    ]),
  };
}

function assertUniqueOutputs(outputs) {
  const seen = new Map();
  for (const { component, destination } of outputs.sort((left, right) => (
    compareCodePoints(left.destination, right.destination)
  ))) {
    if (seen.has(destination)) {
      throw new Error(
        "duplicate target component destination: " + destination
          + " (" + seen.get(destination) + ", " + component.id + ")",
      );
    }
    seen.set(destination, component.id);
  }
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

function renderedFiles(path) {
  const stats = lstatSync(path);
  return (stats.isDirectory() ? walkFiles(path) : [path]).sort(compareCodePoints);
}

export function renderClaudeTarget({ plugin, inventory, neutralComponents, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/claude");
  const records = new Map(inventory.components.map((component) => [component.id, component]));
  const components = {};
  const nativePlans = [];
  const commandPlans = [];
  const hooks = [];
  const mcps = [];

  for (const neutral of neutralComponents) {
    const disposition = neutral.targets.claude;
    if (disposition.status === "unsupported" || disposition.status === "rejected") {
      components[neutral.id] = { ...disposition };
      continue;
    }
    if (neutral.type === "skill") continue;
    const record = records.get(neutral.id);
    if (!record) throw new Error("missing inventory component: " + neutral.id);
    if (["hook", "mcp", "lsp", "monitor", "settings"].includes(neutral.type)) {
      assertJsonSingletonComponent(record);
    }
    if (neutral.type === "hook") {
      hooks.push(record);
      continue;
    }
    if (neutral.type === "mcp") {
      mcps.push(record);
      continue;
    }
    if (neutral.type === "command") {
      const plan = commandOutputs({ component: record, targetRoot });
      commandPlans.push({ component: record, ...plan });
      continue;
    }
    const destination = nativeDestination({ component: record, targetRoot });
    nativePlans.push({ component: record, destination });
  }

  assertUniqueOutputs([
    ...nativePlans,
    ...commandPlans.flatMap(({ component, files }) => (
      files.map(([, destination]) => ({ component, destination }))
    )),
  ]);

  const renderedSkills = renderSkills({
    skills: inventory.skills,
    destinationRoot: resolve(targetRoot, "skills"),
    target: "claude",
  });
  for (const skill of renderedSkills) {
    const neutral = neutralComponents.find(({ id }) => id === skill.id);
    components[skill.id] = {
      ...neutral.targets.claude,
      path: targetPath(bundleRoot, skill.directory),
    };
  }

  const commandPaths = [];
  for (const plan of commandPlans) {
    for (const [sourcePath, destination] of plan.files) {
      materializeComponent({
        component: { ...plan.component, sourcePath },
        bundleRoot,
        destination,
      });
      commandPaths.push(manifestPath(targetRoot, destination));
    }
    const neutral = neutralComponents.find(({ id }) => id === plan.component.id);
    components[plan.component.id] = {
      ...neutral.targets.claude,
      path: targetPath(bundleRoot, plan.componentDestination),
    };
  }

  const manifestPaths = new Map();
  for (const plan of nativePlans) {
    materializeComponent({
      component: plan.component,
      bundleRoot,
      destination: plan.destination,
    });
    const neutral = neutralComponents.find(({ id }) => id === plan.component.id);
    components[plan.component.id] = {
      ...neutral.targets.claude,
      path: targetPath(bundleRoot, plan.destination),
    };
    manifestPaths.set(plan.component.id, renderedFiles(plan.destination).map((path) => (
      manifestPath(targetRoot, path)
    )));
  }

  if (hooks.length > 0) {
    const hookPath = resolve(targetRoot, "hooks/hooks.json");
    writeJson(hookPath, renderHooks({ config: mergeHooks(hooks), target: "claude" }));
    for (const record of hooks) {
      const neutral = neutralComponents.find(({ id }) => id === record.id);
      components[record.id] = {
        ...neutral.targets.claude,
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
      target: "claude",
      filePath: mcpPath,
    });
    for (const record of mcps) {
      const neutral = neutralComponents.find(({ id }) => id === record.id);
      components[record.id] = {
        ...neutral.targets.claude,
        path: targetPath(bundleRoot, mcpPath),
      };
    }
  }

  const pathsFor = (type) => nativePlans
    .filter(({ component }) => component.type === type)
    .flatMap(({ component }) => manifestPaths.get(component.id))
    .sort(compareCodePoints);
  const themeCount = nativePlans.filter(({ component }) => component.type === "theme").length;
  const monitorCount = nativePlans.filter(({ component }) => component.type === "monitor").length;
  const experimental = removeUndefined({
    themes: themeCount ? "./themes/" : undefined,
    monitors: monitorCount ? "./monitors/monitors.json" : undefined,
  });
  const manifest = removeUndefined({
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    author: { name: plugin.author || "Gravit Cloud" },
    skills: renderedSkills.length ? "./skills/" : undefined,
    commands: commandPaths.length ? commandPaths.sort(compareCodePoints) : undefined,
    agents: pathsFor("agent").length ? pathsFor("agent") : undefined,
    hooks: hooks.length ? "./hooks/hooks.json" : undefined,
    mcpServers: mcps.length ? "./.mcp.json" : undefined,
    lspServers: nativePlans.some(({ component }) => component.type === "lsp")
      ? "./.lsp.json"
      : undefined,
    outputStyles: pathsFor("output-style").length ? pathsFor("output-style") : undefined,
    channels: pathsFor("channel").length ? pathsFor("channel") : undefined,
    experimental: Object.keys(experimental).length ? experimental : undefined,
  });
  writeJson(resolve(targetRoot, ".claude-plugin/plugin.json"), manifest);
  return { digest: treeHash(targetRoot), components };
}
