import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { sha256, treeHash } from "../../scripts/lib/hash.mjs";
import { stableJson } from "../../scripts/lib/json.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");

function temporarySource(context, manifest = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-coverage-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  mkdirSync(resolve(source, ".claude-plugin"), { recursive: true });
  writeFileSync(
    resolve(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "coverage", version: "1.0.0", ...manifest }),
  );
  return source;
}

function writeSourceFile(source, relativePath, contents = "{}\n") {
  const filePath = resolve(source, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

test("inventories every known component type exactly once", () => {
  const inventory = inventorySource({ sourceRoot: fixture });
  assert.deepEqual(
    [...new Set(inventory.components.map((component) => component.type))].sort(),
    [
      "agent",
      "app",
      "asset",
      "channel",
      "command",
      "executable",
      "hook",
      "lsp",
      "mcp",
      "monitor",
      "output-style",
      "settings",
      "theme",
    ],
  );
  assert.equal(inventory.components.length, 13);
  assert.equal(
    new Set(inventory.components.map((component) => component.type + ":" + component.id)).size,
    inventory.components.length,
  );
  assert.deepEqual(inventory.skills.map((skill) => skill.name), ["fixture"]);
  assert.deepEqual(
    inventory.components.map((component) => component.type + ":" + component.id),
    [...inventory.components]
      .map((component) => component.type + ":" + component.id)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  );
  for (const component of inventory.components) {
    assert.match(component.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.match(component.digest, /^[a-f0-9]{64}$/);
    assert.equal(component.sourceFormat, "path");
    assert.equal(component.inline, undefined);
    assert.equal(component.digest, treeHash(component.sourcePath));
    assert.doesNotMatch(component.metadata.relativePath, /\\/);
  }
});

test("expands string, array, and inline component declarations without duplicate paths", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  const inlineCommand = { name: "inline-release", prompt: "Release safely" };
  const inventory = inventorySource({
    sourceRoot: fixture,
    manifestOverrides: {
      claude: {
        ...manifests.claude,
        commands: ["./commands/release.md", inlineCommand, "commands/release.md"],
      },
      codex: {
        ...manifests.codex,
        apps: ["./.app.json", { apps: { inline: "plugin_asdk_app_inline" } }],
      },
    },
  });
  const commands = inventory.components.filter(({ type }) => type === "command");
  const apps = inventory.components.filter(({ type }) => type === "app");

  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(({ sourceFormat }) => sourceFormat).sort(), ["inline", "path"]);
  const inlineCommandRecord = commands.find(({ sourceFormat }) => sourceFormat === "inline");
  assert.deepEqual(inlineCommandRecord.inline, inlineCommand);
  assert.equal(inlineCommandRecord.digest, sha256(stableJson(inlineCommand)));
  assert.deepEqual(inlineCommandRecord.metadata, {});
  assert.equal(apps.length, 2);
  assert.deepEqual(apps.map(({ sourceFormat }) => sourceFormat).sort(), ["inline", "path"]);
});

test("honors an explicit declared skill selection", () => {
  assert.deepEqual(
    inventorySource({
      sourceRoot: fixture,
      declaredSkills: "./skills/fixture",
    }).skills.map((skill) => skill.name),
    ["fixture"],
  );
  assert.throws(
    () => inventorySource({ sourceRoot: fixture, declaredSkills: "../outside" }),
    /declared skill escapes source root/,
  );
});

test("explicit host skill selection classifies only unselected skill-tree content", (context) => {
  const selected = temporarySource(context, { skills: ["./skills/selected"] });
  writeSourceFile(
    selected,
    "skills/selected/SKILL.md",
    "---\nname: selected\ndescription: Selected skill\n---\n",
  );
  writeSourceFile(selected, "skills/unselected/README.md", "Not selected\n");
  assert.deepEqual(
    inventorySource({ sourceRoot: selected }).skills.map(({ name }) => name),
    ["selected"],
  );

  const undeclared = temporarySource(context);
  writeSourceFile(
    undeclared,
    "skills/selected/SKILL.md",
    "---\nname: selected\ndescription: Selected skill\n---\n",
  );
  writeSourceFile(undeclared, "skills/unselected/README.md", "Unaccounted\n");
  assert.throws(
    () => inventorySource({ sourceRoot: undeclared }),
    /unaccounted source file: skills\/unselected\/README\.md/,
  );
});

test("overlapping explicit parent and child skill paths discover each skill once", (context) => {
  const source = temporarySource(context, {
    skills: ["./skills/parent", "./skills/parent/child"],
  });
  writeSourceFile(
    source,
    "skills/parent/SKILL.md",
    "---\nname: parent\ndescription: Parent skill\n---\n",
  );
  writeSourceFile(
    source,
    "skills/parent/child/SKILL.md",
    "---\nname: child\ndescription: Child skill\n---\n",
  );
  writeSourceFile(source, "skills/unselected/README.md", "Not selected\n");

  assert.deepEqual(
    inventorySource({ sourceRoot: source }).skills.map(({ name }) => name).sort(),
    ["child", "parent"],
  );
});

test("inventories only explicitly declared generic resources", (context) => {
  const source = temporarySource(context);
  writeSourceFile(
    source,
    "skills/fixture/SKILL.md",
    "---\nname: fixture\ndescription: Resource fixture\n---\n",
  );
  writeSourceFile(source, "scripts/runtime.py", "print('fixture')\n");
  writeSourceFile(source, "extensions/tool/install.sh", "#!/bin/sh\n");
  writeSourceFile(source, "schema/templates.json");
  writeSourceFile(
    source,
    "extensions/tool/SKILL.md",
    "---\nname: hidden\ndescription: Resource payload only\n---\n",
  );

  const inventory = inventorySource({
    sourceRoot: source,
    resources: [
      { type: "executable", path: "scripts" },
      { type: "executable", path: "extensions" },
      { type: "asset", path: "schema" },
    ],
  });

  assert.deepEqual(
    inventory.components
      .filter(({ metadata }) => ["extensions", "schema", "scripts"].includes(
        metadata.relativePath,
      ))
      .map(({ type, metadata }) => `${type}:${metadata.relativePath}`),
    ["asset:schema", "executable:extensions", "executable:scripts"],
  );
  assert.deepEqual(inventory.skills.map(({ name }) => name), ["fixture"]);

  writeSourceFile(source, "unknown-peer/runtime.py", "print('unknown')\n");
  assert.throws(
    () => inventorySource({
      sourceRoot: source,
      resources: [
        { type: "executable", path: "scripts" },
        { type: "executable", path: "extensions" },
        { type: "asset", path: "schema" },
      ],
    }),
    /unknown top-level source entry: unknown-peer/,
  );
});

test("generic resources reject malformed, escaping, symbolic, and overlapping paths", (context) => {
  const cases = [
    {
      resources: [{ type: "asset", path: "../outside" }],
      error: /resource path must be a safe relative path/,
    },
    {
      resources: [{ type: "asset", path: "scripts" }, { type: "executable", path: "scripts" }],
      paths: ["scripts/runtime.py"],
      error: /overlapping resource paths: scripts, scripts/,
    },
    {
      resources: [{ type: "asset", path: "scripts" }, { type: "asset", path: "scripts/nested" }],
      paths: ["scripts/nested/runtime.py"],
      error: /overlapping resource paths: scripts, scripts\/nested/,
    },
    {
      resources: [{ type: "asset", path: "assets" }],
      paths: ["assets/icon.svg"],
      error: /resource path overlaps inventoried component: assets/,
    },
    {
      resources: [{ type: "asset", path: "skills" }],
      paths: ["skills/fixture/SKILL.md"],
      contents: "---\nname: fixture\ndescription: Fixture\n---\n",
      error: /resource path overlaps inventoried skill: skills/,
    },
  ];
  for (const fixtureCase of cases) {
    const source = temporarySource(context);
    for (const path of fixtureCase.paths || []) {
      writeSourceFile(source, path, fixtureCase.contents);
    }
    assert.throws(
      () => inventorySource({ sourceRoot: source, resources: fixtureCase.resources }),
      fixtureCase.error,
    );
  }

  const source = temporarySource(context);
  const outside = resolve(dirname(source), "outside-resource");
  mkdirSync(outside);
  writeSourceFile(outside, "runtime.py", "print('outside')\n");
  symlinkSync(outside, resolve(source, "scripts"));
  assert.throws(
    () => inventorySource({
      sourceRoot: source,
      resources: [{ type: "executable", path: "scripts" }],
    }),
    /symbolic links are not allowed|escapes source root/,
  );
});

test("rejects unknown Claude, experimental, and Codex component fields", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, unknownRuntime: "./runtime.json" },
      },
    }),
    /unknown Claude component field: unknownRuntime/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: {
          ...manifests.claude,
          experimental: { ...manifests.claude.experimental, daemons: "./daemons/" },
        },
      },
    }),
    /unknown Claude experimental component field: daemons/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        codex: { ...manifests.codex, runtimes: "./runtimes.json" },
      },
    }),
    /unknown Codex component field: runtimes/,
  );
});

test("manifest allowlists reject every non-allowlisted key spelling", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  for (const [host, label] of [["claude", "Claude"], ["codex", "Codex"]]) {
    for (const key of ["UnknownRuntime", "_runtime", "$runtime"]) {
      assert.throws(
        () => inventorySource({
          sourceRoot: fixture,
          manifestOverrides: {
            [host]: { ...manifests[host], [key]: "./runtime.json" },
          },
        }),
        (error) => error.message === "unknown " + label + " component field: " + key,
      );
    }
    assert.doesNotThrow(() => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        [host]: {
          ...manifests[host],
          $schema: "https://example.invalid/plugin.schema.json",
        },
      },
    }));
  }
});

test("experimental declarations suppress their conventional component roots", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-experimental-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  cpSync(fixture, source, { recursive: true });
  const manifests = inventorySource({ sourceRoot: source }).manifests;
  rmSync(resolve(source, "themes"), { recursive: true });
  rmSync(resolve(source, "monitors/monitors.json"));
  writeFileSync(resolve(source, "alternate-theme.json"), "{\"name\":\"alternate\"}\n");
  writeFileSync(resolve(source, "monitors/custom.json"), "{\"custom\":true}\n");

  const declared = inventorySource({
    sourceRoot: source,
    manifestOverrides: {
      claude: {
        ...manifests.claude,
        experimental: {
          themes: "./alternate-theme.json",
          monitors: "./monitors/custom.json",
        },
      },
    },
  });
  assert.deepEqual(
    declared.components
      .filter(({ type }) => ["theme", "monitor"].includes(type))
      .map(({ type, metadata }) => type + ":" + metadata.relativePath),
    ["monitor:monitors/custom.json", "theme:alternate-theme.json"],
  );

  rmSync(resolve(source, "alternate-theme.json"));
  rmSync(resolve(source, "monitors/custom.json"));
  const disabled = inventorySource({
    sourceRoot: source,
    manifestOverrides: {
      claude: {
        ...manifests.claude,
        experimental: { themes: [], monitors: [] },
      },
    },
  });
  assert.deepEqual(
    disabled.components.filter(({ type }) => ["theme", "monitor"].includes(type)),
    [],
  );
});

test("rejects unknown top-level roots but permits declared roots and standard resources", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-roots-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  cpSync(fixture, source, { recursive: true });
  mkdirSync(resolve(source, "runtime"));
  writeFileSync(resolve(source, "runtime/component.json"), "{}\n");

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unknown top-level source entry: runtime/,
  );

  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  const declared = inventorySource({
    sourceRoot: source,
    manifestOverrides: {
      claude: {
        ...manifests.claude,
        commands: ["./commands/release.md", "./runtime/component.json"],
      },
    },
  });
  assert.equal(
    declared.components.find(({ metadata }) => (
      metadata.relativePath === "runtime/component.json"
    )).metadata.relativePath,
    "runtime/component.json",
  );
  assert.deepEqual(declared.skills.map(({ name }) => name), ["fixture"]);

  writeFileSync(resolve(source, "runtime/unaccounted.json"), "{}\n");
  assert.throws(
    () => inventorySource({
      sourceRoot: source,
      manifestOverrides: {
        claude: {
          ...manifests.claude,
          commands: ["./commands/release.md", "./runtime/component.json"],
        },
      },
    }),
    /unknown top-level source entry: runtime/,
  );
});

test("permits named upstream documents without allowing extension peers", (context) => {
  for (const [document, peer] of [
    ["CITATION.cff", "runtime.cff"],
    ["CONTRIBUTORS.md", "runtime.md"],
    ["PRIVACY.md", "private-data.md"],
    ["RELEASE-NOTES.md", "RUNTIME-NOTES.md"],
  ]) {
    const root = mkdtempSync(resolve(tmpdir(), "inventory-document-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "source");
    cpSync(fixture, source, { recursive: true });
    writeFileSync(resolve(source, document), "Upstream document\n");

    assert.doesNotThrow(() => inventorySource({ sourceRoot: source }), document);

    writeFileSync(resolve(source, peer), "Unknown peer\n");
    assert.throws(
      () => inventorySource({ sourceRoot: source }),
      new RegExp("unknown top-level source entry: " + peer.replace(".", "\\.")),
    );
  }
});

test("permits exact repository lifecycle scripts without allowing script peers", (context) => {
  for (const [script, peer] of [
    ["install.sh", "setup.sh"],
    ["install.ps1", "setup.ps1"],
    ["uninstall.sh", "remove.sh"],
    ["uninstall.ps1", "remove.ps1"],
  ]) {
    const root = mkdtempSync(resolve(tmpdir(), "inventory-lifecycle-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const source = resolve(root, "source");
    cpSync(fixture, source, { recursive: true });
    writeFileSync(resolve(source, script), "Repository setup helper\n");

    assert.doesNotThrow(() => inventorySource({ sourceRoot: source }), script);

    writeFileSync(resolve(source, peer), "Unknown script\n");
    assert.throws(
      () => inventorySource({ sourceRoot: source }),
      new RegExp("unknown top-level source entry: " + peer.replace(".", "\\.")),
    );
  }
});

test("permits the exact upstream Claude marketplace document without allowing peers", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, ".claude-plugin/marketplace.json");

  assert.doesNotThrow(() => inventorySource({ sourceRoot: source }));

  writeSourceFile(source, ".claude-plugin/catalog.json");
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unaccounted source file: \.claude-plugin\/catalog\.json/,
  );
});

test("permits exact agent source-context roots and CONTEXT.md", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, ".agents/adr/0001-example.md", "# Decision\n");
  writeSourceFile(source, ".out-of-scope/example.md", "# Rejected\n");
  writeSourceFile(source, "CONTEXT.md", "# Context\n");

  assert.doesNotThrow(() => inventorySource({ sourceRoot: source }));

  writeSourceFile(source, ".agent-notes/example.md", "# Unknown\n");
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unknown top-level source entry: \.agent-notes/,
  );
});

test("permits only exact repository tooling scripts", (context) => {
  const source = temporarySource(context);
  for (const script of [
    "bump-version.sh",
    "link-skills.sh",
    "lint-shell.sh",
    "list-skills.sh",
    "package-codex-plugin.sh",
    "sync-to-codex-plugin.sh",
  ]) {
    writeSourceFile(source, `scripts/${script}`, "#!/bin/sh\n");
  }

  assert.deepEqual(inventorySource({ sourceRoot: source }).components, []);

  writeSourceFile(source, "scripts/runtime.sh", "#!/bin/sh\n");
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unknown top-level source entry: scripts|unaccounted source file: scripts\/runtime\.sh/,
  );
});

test("permits exact alternate-host Azure metadata without allowing peers", (context) => {
  const populate = (source) => {
    writeSourceFile(source, ".cursor-plugin/marketplace.json");
    writeSourceFile(source, "landing-page/index.md", "# Site source\n");
    writeSourceFile(source, "apm.yml", "name: fixture\n");
    writeSourceFile(source, "gemini-extension.json");
    writeSourceFile(source, "plugin.json");
    writeSourceFile(source, "hooks/cursor-hooks.json");
    writeSourceFile(source, "hooks/hooks.json");
  };
  const source = temporarySource(context);
  populate(source);
  assert.doesNotThrow(() => inventorySource({ sourceRoot: source }));

  for (const [path, error] of [
    ["cursor-plugin.json", /unknown top-level source entry: cursor-plugin\.json/],
    ["hooks/other-hooks.json", /unaccounted source file: hooks\/other-hooks\.json/],
  ]) {
    const withPeer = temporarySource(context);
    populate(withPeer);
    writeSourceFile(withPeer, path);
    assert.throws(() => inventorySource({ sourceRoot: withPeer }), error);
  }
});

test("permits only exact unselected Superpowers host context without inventorying it", (context) => {
  const populate = (source) => {
    writeSourceFile(source, ".codex-plugin/plugin.json", JSON.stringify({
      name: "coverage",
      version: "1.0.0",
      hooks: {},
    }));
    writeSourceFile(source, ".kimi-plugin/plugin.json");
    writeSourceFile(source, ".opencode/INSTALL.md", "# Install\n");
    writeSourceFile(source, ".pi/extensions/superpowers.ts", "export {};\n");
    writeSourceFile(source, ".pre-commit-config.yaml", "repos: []\n");
    writeSourceFile(source, ".version-bump.json");
    writeSourceFile(source, "hooks/hooks.json");
    writeSourceFile(source, "hooks/hooks-cursor.json");
    writeSourceFile(source, "hooks/run-hook.cmd", "@echo off\n");
    writeSourceFile(source, "hooks/session-start", "#!/usr/bin/env bash\n");
  };
  const source = temporarySource(context);
  populate(source);

  const inventory = inventorySource({ sourceRoot: source });
  assert.deepEqual(
    inventory.components.map(({ sourceFormat, type }) => `${type}:${sourceFormat}`),
    ["hook:inline"],
  );

  for (const [path, expected] of [
    [".other-host/plugin.json", /unknown top-level source entry: \.other-host/],
    [".pre-commit-config.yml", /unknown top-level source entry: \.pre-commit-config\.yml/],
    [".version-bump.yaml", /unknown top-level source entry: \.version-bump\.yaml/],
    ["hooks/other-hook.cmd", /unaccounted source file: hooks\/other-hook\.cmd/],
  ]) {
    const withPeer = temporarySource(context);
    populate(withPeer);
    writeSourceFile(withPeer, path);
    assert.throws(() => inventorySource({ sourceRoot: withPeer }), expected, path);
  }
});

test("skips only the exact root AGENTS.md to CLAUDE.md document alias", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, "CLAUDE.md", "# Instructions\n");
  symlinkSync("CLAUDE.md", resolve(source, "AGENTS.md"));

  const inventory = inventorySource({ sourceRoot: source });
  assert.deepEqual(inventory.components, []);
  assert.deepEqual(inventory.skills, []);

  const cases = [
    ["absolute", resolve(source, "CLAUDE.md"), "AGENTS.md"],
    ["parent", "../CLAUDE.md", "AGENTS.md"],
    ["wrong-case", "claude.md", "AGENTS.md"],
    ["component", "assets/icon.svg", "AGENTS.md"],
    ["nested", "CLAUDE.md", "docs/AGENTS.md"],
    ["arbitrary-name", "CLAUDE.md", "TEAM.md"],
  ];
  for (const [name, target, alias] of cases) {
    const candidate = temporarySource(context);
    writeSourceFile(candidate, "CLAUDE.md", "# Instructions\n");
    if (name === "wrong-case") writeSourceFile(candidate, "claude.md", "# Lowercase\n");
    if (name === "component") writeSourceFile(candidate, "assets/icon.svg", "<svg/>\n");
    mkdirSync(dirname(resolve(candidate, alias)), { recursive: true });
    symlinkSync(target, resolve(candidate, alias));
    assert.throws(
      () => inventorySource({ sourceRoot: candidate }),
      /symbolic links are not allowed in staged components/,
      name,
    );
  }

  const dangling = temporarySource(context);
  symlinkSync("CLAUDE.md", resolve(dangling, "AGENTS.md"));
  assert.throws(
    () => inventorySource({ sourceRoot: dangling }),
    /symbolic links are not allowed in staged components/,
  );

  const chained = temporarySource(context);
  writeSourceFile(chained, "README.md", "# Instructions\n");
  symlinkSync("README.md", resolve(chained, "CLAUDE.md"));
  symlinkSync("CLAUDE.md", resolve(chained, "AGENTS.md"));
  assert.throws(
    () => inventorySource({ sourceRoot: chained }),
    /symbolic links are not allowed in staged components/,
  );
});

test("an exact document alias cannot be selected as a component", (context) => {
  const source = temporarySource(context, { commands: "./AGENTS.md" });
  writeSourceFile(source, "CLAUDE.md", "# Instructions\n");
  symlinkSync("CLAUDE.md", resolve(source, "AGENTS.md"));

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /symbolic links are not allowed in staged components/,
  );
});

test("rejects dangling symbolic links during top-level classification", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-root-link-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  cpSync(fixture, source, { recursive: true });
  symlinkSync("missing-target", resolve(source, "runtime"));

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /symbolic links are not allowed in staged components: .*runtime/,
  );
});

for (const [relativePath, expectedError] of [
  ["channels/alerts.json", /unaccounted source file: channels\/alerts\.json/],
  ["monitors/custom.json", /unaccounted source file: monitors\/custom\.json/],
  ["hooks/custom.json", /unaccounted source file: hooks\/custom\.json/],
]) {
  test("rejects an unaccounted known-root file at " + relativePath, (context) => {
    const source = temporarySource(context);
    writeSourceFile(source, relativePath);

    assert.throws(
      () => inventorySource({ sourceRoot: source }),
      expectedError,
    );
  });
}

test("a directory component record covers every descendant", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, "commands/release.md", "# Release\n");
  writeSourceFile(source, "commands/nested/verify.md", "# Verify\n");

  const inventory = inventorySource({ sourceRoot: source });
  assert.deepEqual(
    inventory.components
      .filter(({ type }) => type === "command")
      .map(({ metadata }) => metadata.relativePath),
    ["commands"],
  );
});

test("a declared file component does not cover a sibling", (context) => {
  const source = temporarySource(context, { commands: "./commands/release.md" });
  writeSourceFile(source, "commands/release.md", "# Release\n");
  writeSourceFile(source, "commands/hidden.md", "# Hidden\n");

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unaccounted source file: commands\/hidden\.md/,
  );
});

test("a skill covers nested resources but not siblings in the skills root", (context) => {
  const source = temporarySource(context);
  writeSourceFile(
    source,
    "skills/fixture/SKILL.md",
    "---\nname: fixture\ndescription: Coverage fixture\n---\n",
  );
  writeSourceFile(source, "skills/fixture/references/guide.md", "# Guide\n");

  assert.deepEqual(
    inventorySource({ sourceRoot: source }).skills.map(({ name }) => name),
    ["fixture"],
  );

  writeSourceFile(source, "skills/orphan.md", "# Orphan\n");
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /unaccounted source file: skills\/orphan\.md/,
  );
});

test("rejects malformed inline payloads and escaping component paths", () => {
  const manifests = inventorySource({ sourceRoot: fixture }).manifests;
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, commands: [42] },
      },
    }),
    /command component must be a path or inline object/,
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      manifestOverrides: {
        claude: { ...manifests.claude, commands: "../outside.md" },
      },
    }),
    /command component escapes source root/,
  );
});

test("rejects component roots and nested files reached through symbolic links", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "inventory-symlink-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, "source");
  const outside = resolve(root, "outside");
  mkdirSync(resolve(source, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(source, "assets"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(resolve(outside, "component.json"), "{}\n");
  writeFileSync(
    resolve(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", commands: "./linked" }),
  );
  symlinkSync(outside, resolve(source, "linked"));

  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /command component escapes source root|symbolic links are not allowed/,
  );

  rmSync(resolve(source, "linked"));
  writeFileSync(
    resolve(source, ".claude-plugin/plugin.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  symlinkSync(resolve(outside, "component.json"), resolve(source, "assets/linked.json"));
  assert.throws(
    () => inventorySource({ sourceRoot: source }),
    /symbolic links are not allowed in staged components/,
  );
});

test("inventorying executable content never runs it", () => {
  const helper = resolve(fixture, "bin/helper");
  const before = readFileSync(helper, "utf8");
  const executable = inventorySource({ sourceRoot: fixture }).components
    .find(({ type }) => type === "executable");

  assert.equal(executable.metadata.relativePath, "bin");
  assert.equal(readFileSync(helper, "utf8"), before);
});
