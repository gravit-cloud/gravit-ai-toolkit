import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { sourceContextHash, treeHash } from "../../scripts/lib/hash.mjs";
import { readJson } from "../../scripts/lib/json.mjs";
import { walkFiles } from "../../scripts/lib/path-safety.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const completeFixtureRoot = resolve(repositoryRoot, "test/fixtures/complete-plugin");

function completePlugin() {
  return {
    name: "complete",
    description: "Complete component fixture",
    category: "development",
    distributionVersion: "1.0.0-gravit.1",
    runtimeDependencies: { "@fixture/mcp": "1.2.3" },
    source: {
      type: "local",
      path: "test/fixtures/complete-plugin",
      root: ".",
    },
    sourceContext: ["LICENSE", "README.md"].map((path) => ({
      path,
      digest: sourceContextHash(resolve(completeFixtureRoot, path)),
    })),
    targets: ["codex", "claude"],
    policies: { default: "transform-or-fail", skills: "transform" },
    targetPolicies: {
      claude: { unsupported: { app: "host-does-not-load-apps" } },
      codex: {
        unsupported: {
          agent: "host-does-not-load-agents",
          lsp: "host-does-not-load-lsp",
          "output-style": "host-does-not-load-output-styles",
          monitor: "host-does-not-load-monitors",
          theme: "host-does-not-load-themes",
          channel: "host-does-not-load-channels",
          settings: "host-does-not-load-settings",
        },
      },
    },
  };
}

function sandbox(context) {
  const root = mkdtempSync(resolve(tmpdir(), "component-targets-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return resolve(root, "bundle");
}

function skillNames(root) {
  return walkFiles(root)
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => parseFrontmatter(readFileSync(path, "utf8")).attributes.name)
    .sort();
}

function commandSource(context, { skillName = "fixture", files }) {
  const root = mkdtempSync(resolve(tmpdir(), "component-command-source-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(root, "skills", skillName), { recursive: true });
  writeFileSync(
    resolve(root, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "command-fixture",
      version: "1.0.0",
      skills: "./skills/",
      commands: "./commands/",
    }),
  );
  writeFileSync(
    resolve(root, "skills", skillName, "SKILL.md"),
    "---\nname: " + skillName + "\ndescription: Fixture skill\n---\n\n# Fixture\n",
  );
  for (const [path, contents] of Object.entries(files)) {
    const destination = resolve(root, "commands", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  return root;
}

function commandPlugin() {
  return {
    name: "command-fixture",
    description: "Command directory fixture",
    category: "development",
    distributionVersion: "1.0.0",
    source: { type: "local", path: "test/fixtures/command-fixture", root: "." },
    targets: ["claude", "codex"],
    policies: { default: "transform-or-fail", skills: "transform" },
    targetPolicies: {},
  };
}

function singletonSource(context, { host, field, sourcePath }) {
  const root = mkdtempSync(resolve(tmpdir(), "component-singleton-source-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const manifestRoot = host === "claude" ? ".claude-plugin" : ".codex-plugin";
  mkdirSync(resolve(root, manifestRoot), { recursive: true });
  writeFileSync(resolve(root, manifestRoot, "plugin.json"), JSON.stringify({
    name: "singleton-fixture",
    version: "1.0.0",
    [field]: "./" + sourcePath,
  }));
  mkdirSync(resolve(root, sourcePath), { recursive: true });
  writeFileSync(resolve(root, sourcePath, "nested.json"), "{}\n");
  return root;
}

function singletonPlugin(target) {
  return {
    name: "singleton-fixture",
    description: "Singleton directory fixture",
    category: "development",
    distributionVersion: "1.0.0",
    source: { type: "local", path: "test/fixtures/singleton-fixture", root: "." },
    targets: [target],
    policies: { default: "transform-or-fail", skills: "transform" },
    targetPolicies: {},
  };
}

test("renders complete standalone Claude and Codex component bundles", (context) => {
  const bundleRoot = sandbox(context);
  const manifest = buildPluginBundle({
    plugin: completePlugin(),
    sourceRoot: completeFixtureRoot,
    bundleRoot,
  });

  const claudeRoot = resolve(bundleRoot, "targets/claude");
  const codexRoot = resolve(bundleRoot, "targets/codex");
  const claudeManifest = readJson(resolve(claudeRoot, ".claude-plugin/plugin.json"));
  const codexManifest = readJson(resolve(codexRoot, ".codex-plugin/plugin.json"));

  assert.deepEqual(claudeManifest, {
    name: "complete",
    version: "1.0.0-gravit.1",
    description: "Complete component fixture",
    author: { name: "Gravit Cloud" },
    skills: "./skills/",
    commands: ["./commands/release.md"],
    agents: ["./agents/reviewer.md"],
    hooks: "./hooks/hooks.json",
    mcpServers: "./.mcp.json",
    lspServers: "./.lsp.json",
    outputStyles: ["./output-styles/terse.md"],
    channels: ["./channels/alerts.json"],
    experimental: {
      themes: "./themes/",
      monitors: "./monitors/monitors.json",
    },
  });
  assert.deepEqual(codexManifest, {
    name: "complete",
    version: "1.0.0-gravit.1",
    description: "Complete component fixture",
    author: { name: "Gravit Cloud" },
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    apps: "./.app.json",
    hooks: "./hooks/hooks.json",
    interface: {
      displayName: "complete",
      shortDescription: "Complete component fixture",
      longDescription: "Complete component fixture",
      developerName: "Gravit Cloud",
      category: "Development",
      capabilities: [],
      defaultPrompt: ["Use complete to help with this task."],
    },
  });

  assert.deepEqual(readJson(resolve(claudeRoot, ".mcp.json")), {
    mcpServers: {
      fixture: {
        command: "npx",
        args: ["-y", "@fixture/mcp@1.2.3", "server", "start"],
        env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
      },
    },
  });
  assert.deepEqual(readJson(resolve(codexRoot, ".mcp.json")), {
    mcp_servers: {
      fixture: {
        command: "npx",
        args: ["-y", "@fixture/mcp@1.2.3", "server", "start"],
        env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
      },
    },
  });
  assert.equal(
    readJson(resolve(claudeRoot, "hooks/hooks.json"))
      .hooks.SessionStart[0].hooks[0].command,
    'node "${CLAUDE_PLUGIN_ROOT}/bin/helper"',
  );
  assert.equal(
    readJson(resolve(codexRoot, "hooks/hooks.json"))
      .hooks.SessionStart[0].hooks[0].command,
    'node "${PLUGIN_ROOT}/bin/helper"',
  );

  assert.deepEqual(skillNames(resolve(codexRoot, "skills")), ["fixture", "release"]);
  assert.match(
    readFileSync(resolve(codexRoot, "skills/release/SKILL.md"), "utf8"),
    /description: "Release the fixture"[\s\S]*# Release/,
  );
  assert.deepEqual(
    readFileSync(resolve(claudeRoot, "assets/icon.svg")),
    readFileSync(resolve(completeFixtureRoot, "assets/icon.svg")),
  );
  assert.deepEqual(
    readFileSync(resolve(codexRoot, ".app.json")),
    readFileSync(resolve(completeFixtureRoot, ".app.json")),
  );
  for (const root of [claudeRoot, codexRoot]) {
    assert.equal(statSync(resolve(root, "bin/helper")).mode & 0o777, 0o755);
    assert.deepEqual(
      readFileSync(resolve(root, "bin/helper")),
      readFileSync(resolve(completeFixtureRoot, "bin/helper")),
    );
  }

  assert.deepEqual(Object.keys(manifest.targets), ["claude", "codex"]);
  for (const target of ["claude", "codex"]) {
    const targetResult = manifest.targets[target];
    assert.equal(targetResult.digest, treeHash(resolve(bundleRoot, targetResult.path)));
    assert.deepEqual(
      Object.keys(targetResult.components),
      manifest.components.map(({ id }) => id),
    );
    for (const component of manifest.components) {
      const disposition = targetResult.components[component.id];
      assert.deepEqual(disposition, component.targets[target]);
      if (["unsupported", "rejected"].includes(disposition.status)) {
        assert.equal(Object.hasOwn(disposition, "path"), false);
      } else {
        assert.equal(existsSync(resolve(bundleRoot, disposition.path)), true);
      }
    }
  }

  const claudeApp = manifest.components.find(({ type }) => type === "app").targets.claude;
  assert.equal(claudeApp.status, "unsupported");
  assert.equal(Object.hasOwn(claudeApp, "path"), false);
  assert.equal(existsSync(resolve(claudeRoot, ".app.json")), false);
  for (const type of [
    "agent", "lsp", "output-style", "monitor", "theme", "channel", "settings",
  ]) {
    const disposition = manifest.components.find((component) => component.type === type)
      .targets.codex;
    assert.equal(disposition.status, "unsupported", type);
    assert.equal(Object.hasOwn(disposition, "path"), false, type);
  }
  for (const path of [
    "agents", ".lsp.json", "output-styles", "monitors", "themes", "channels", "settings.json",
  ]) {
    assert.equal(existsSync(resolve(codexRoot, path)), false, path);
  }
});

test("expands command directories recursively in deterministic code-point order", (context) => {
  const sourceRoot = commandSource(context, {
    files: {
      "z.md": "---\ndescription: Z command\n---\n\n# Z\n",
      "A.md": "---\ndescription: A command\n---\n\n# A\n",
      "nested/b.md": "---\ndescription: B command\n---\n\n# B\n",
    },
  });
  const bundleRoot = sandbox(context);

  buildPluginBundle({ plugin: commandPlugin(), sourceRoot, bundleRoot });

  assert.deepEqual(
    readJson(resolve(bundleRoot, "targets/claude/.claude-plugin/plugin.json")).commands,
    ["./commands/A.md", "./commands/nested/b.md", "./commands/z.md"],
  );
  assert.deepEqual(skillNames(resolve(bundleRoot, "targets/codex/skills")), [
    "a", "b", "fixture", "z",
  ]);
});

test("rejects command collisions against real and converted skills before manifest exposure", (context) => {
  const cases = [
    {
      skillName: "release",
      files: { "release.md": "---\ndescription: Release\n---\nBody\n" },
    },
    {
      skillName: "fixture",
      files: {
        "first/release.md": "---\ndescription: First\n---\nBody\n",
        "second/release.md": "---\ndescription: Second\n---\nBody\n",
      },
    },
  ];
  for (const fixture of cases) {
    const sourceRoot = commandSource(context, fixture);
    const bundleRoot = sandbox(context);
    assert.throws(
      () => buildPluginBundle({ plugin: commandPlugin(), sourceRoot, bundleRoot }),
      /duplicate target skill name: release/,
    );
    assert.equal(existsSync(resolve(bundleRoot, "targets/codex/.codex-plugin/plugin.json")), false);
    assert.equal(existsSync(resolve(bundleRoot, "targets/claude/.claude-plugin/plugin.json")), false);
    assert.equal(existsSync(resolve(bundleRoot, "targets")), false);
    assert.equal(existsSync(resolve(bundleRoot, ".agent-plugin/plugin.json")), false);
    assert.deepEqual(
      readdirSync(bundleRoot).filter((entry) => entry.startsWith(".targets.stage-")),
      [],
    );
  }
});

test("rejects path directories for fixed JSON singleton destinations before exposure", (context) => {
  const cases = [
    { host: "claude", field: "lspServers", sourcePath: "lsp-config", target: "claude" },
    { host: "codex", field: "apps", sourcePath: "app-config", target: "codex" },
  ];
  for (const fixture of cases) {
    const sourceRoot = singletonSource(context, fixture);
    const bundleRoot = sandbox(context);
    assert.throws(
      () => buildPluginBundle({
        plugin: singletonPlugin(fixture.target),
        sourceRoot,
        bundleRoot,
      }),
      /component must be a regular JSON file/,
    );
    assert.equal(existsSync(resolve(bundleRoot, "targets")), false);
    assert.equal(existsSync(resolve(bundleRoot, ".agent-plugin/plugin.json")), false);
  }
});

test("refuses to replace or merge an existing final target tree", (context) => {
  const sourceRoot = commandSource(context, {
    files: { "release.md": "---\ndescription: Release\n---\nBody\n" },
  });
  const bundleRoot = sandbox(context);
  const sentinel = resolve(bundleRoot, "targets/sentinel.txt");
  mkdirSync(dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "keep\n");

  assert.throws(
    () => buildPluginBundle({ plugin: commandPlugin(), sourceRoot, bundleRoot }),
    /atomic output already exists/,
  );
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  assert.deepEqual(readdirSync(resolve(bundleRoot, "targets")), ["sentinel.txt"]);
  assert.equal(existsSync(resolve(bundleRoot, ".agent-plugin/plugin.json")), false);
});

test("renders inline hooks, MCP, and Codex app records without leaking Claude app output", (context) => {
  const sourceRoot = mkdtempSync(resolve(tmpdir(), "component-inline-source-"));
  context.after(() => rmSync(sourceRoot, { recursive: true, force: true }));
  mkdirSync(resolve(sourceRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(sourceRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(resolve(sourceRoot, ".claude-plugin/plugin.json"), JSON.stringify({
    name: "inline-fixture",
    version: "1.0.0",
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "node ${PLUGIN_ROOT}/safe.js" }] }],
    },
    mcpServers: {
      fixture: { command: "npx", args: ["-y", "@fixture/mcp@latest"] },
    },
  }));
  writeFileSync(resolve(sourceRoot, ".codex-plugin/plugin.json"), JSON.stringify({
    name: "inline-fixture",
    version: "1.0.0",
    apps: { apps: { fixture: "plugin_asdk_app_fixture" } },
  }));
  const bundleRoot = sandbox(context);
  const plugin = {
    ...commandPlugin(),
    name: "inline-fixture",
    description: "Inline fixture",
    runtimeDependencies: { "@fixture/mcp": "1.2.3" },
    targetPolicies: {
      claude: { unsupported: { app: "host-does-not-load-apps" } },
    },
  };

  const manifest = buildPluginBundle({ plugin, sourceRoot, bundleRoot });

  assert.deepEqual(readJson(resolve(bundleRoot, "targets/codex/.app.json")), {
    apps: { fixture: "plugin_asdk_app_fixture" },
  });
  assert.equal(existsSync(resolve(bundleRoot, "targets/claude/.app.json")), false);
  assert.equal(
    readJson(resolve(bundleRoot, "targets/claude/hooks/hooks.json"))
      .hooks.SessionStart[0].hooks[0].command,
    "node ${CLAUDE_PLUGIN_ROOT}/safe.js",
  );
  assert.equal(
    readJson(resolve(bundleRoot, "targets/codex/hooks/hooks.json"))
      .hooks.SessionStart[0].hooks[0].command,
    "node ${PLUGIN_ROOT}/safe.js",
  );
  for (const component of manifest.components) {
    for (const target of ["claude", "codex"]) {
      const disposition = component.targets[target];
      if (["unsupported", "rejected"].includes(disposition.status)) {
        assert.equal(Object.hasOwn(disposition, "path"), false);
      } else {
        assert.equal(existsSync(resolve(bundleRoot, disposition.path)), true);
      }
    }
  }
});
