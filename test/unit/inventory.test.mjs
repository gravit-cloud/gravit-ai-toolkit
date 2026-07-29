import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
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

function contextEntry(source, path) {
  return { path, digest: treeHash(resolve(source, path)) };
}

function fixtureSourceContext(source = fixture) {
  return ["LICENSE", "README.md"]
    .filter((path) => existsSync(resolve(source, path)))
    .map((path) => contextEntry(source, path));
}

test("inventories every known component type exactly once", () => {
  const inventory = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  });
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
  const manifests = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).manifests;
  const inlineCommand = { name: "inline-release", prompt: "Release safely" };
  const inventory = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
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
      sourceContext: fixtureSourceContext(),
    }).skills.map((skill) => skill.name),
    ["fixture"],
  );
  assert.throws(
    () => inventorySource({
      sourceRoot: fixture,
      declaredSkills: "../outside",
      sourceContext: fixtureSourceContext(),
    }),
    /declared skill escapes source root/,
  );
});

test("explicit host skill selection requires digest-bound context for every unselected peer", (context) => {
  const selected = temporarySource(context, { skills: ["./skills/selected"] });
  writeSourceFile(
    selected,
    "skills/selected/SKILL.md",
    "---\nname: selected\ndescription: Selected skill\n---\n",
  );
  writeSourceFile(
    selected,
    ".agents/skills/hidden/SKILL.md",
    "---\nname: hidden\ndescription: Hidden alternate-host skill\n---\n",
  );
  assert.throws(
    () => inventorySource({ sourceRoot: selected }),
    /unaccounted source file: \.agents\/skills\/hidden\/SKILL\.md/,
  );
  assert.deepEqual(
    inventorySource({
      sourceRoot: selected,
      sourceContext: [contextEntry(selected, ".agents")],
    }).skills.map(({ name }) => name),
    ["selected"],
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
    inventorySource({
      sourceRoot: source,
      sourceContext: [contextEntry(source, "skills/unselected")],
    }).skills.map(({ name }) => name).sort(),
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
    /unaccounted source file: unknown-peer\/runtime\.py/,
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
  const manifests = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).manifests;
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
  const manifests = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).manifests;
  for (const [host, label] of [["claude", "Claude"], ["codex", "Codex"]]) {
    for (const key of ["UnknownRuntime", "_runtime", "$runtime"]) {
      assert.throws(
        () => inventorySource({
          sourceRoot: fixture,
          sourceContext: fixtureSourceContext(),
          manifestOverrides: {
            [host]: { ...manifests[host], [key]: "./runtime.json" },
          },
        }),
        (error) => error.message === "unknown " + label + " component field: " + key,
      );
    }
    assert.doesNotThrow(() => inventorySource({
      sourceRoot: fixture,
      sourceContext: fixtureSourceContext(),
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
  const sourceContext = fixtureSourceContext(source);
  const manifests = inventorySource({ sourceRoot: source, sourceContext }).manifests;
  rmSync(resolve(source, "themes"), { recursive: true });
  rmSync(resolve(source, "monitors/monitors.json"));
  writeFileSync(resolve(source, "alternate-theme.json"), "{\"name\":\"alternate\"}\n");
  writeFileSync(resolve(source, "monitors/custom.json"), "{\"custom\":true}\n");

  const declared = inventorySource({
    sourceRoot: source,
    sourceContext,
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
    sourceContext,
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
    () => inventorySource({
      sourceRoot: source,
      sourceContext: fixtureSourceContext(source),
    }),
    /unaccounted source file: runtime\/component\.json/,
  );

  const manifests = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).manifests;
  const declared = inventorySource({
    sourceRoot: source,
    sourceContext: fixtureSourceContext(source),
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
      sourceContext: fixtureSourceContext(source),
      manifestOverrides: {
        claude: {
          ...manifests.claude,
          commands: ["./commands/release.md", "./runtime/component.json"],
        },
      },
    }),
    /unaccounted source file: runtime\/unaccounted\.json/,
  );
});

test("digest-bound source context is classification-only and unknown peers still fail", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, ".agents/adr/0001-example.md", "# Decision\n");
  writeSourceFile(source, "docs/architecture.md", "# Architecture\n");
  writeSourceFile(source, "package.json", "{}\n");
  const sourceContext = [".agents", "docs", "package.json"]
    .map((path) => contextEntry(source, path));

  const inventory = inventorySource({ sourceRoot: source, sourceContext });
  assert.deepEqual(inventory.components, []);
  assert.deepEqual(inventory.skills, []);
  assert.equal(JSON.stringify(inventory).includes("architecture.md"), false);

  writeSourceFile(source, "runtime/new-peer.js", "export {};\n");
  assert.throws(
    () => inventorySource({ sourceRoot: source, sourceContext }),
    /unaccounted source file: runtime\/new-peer\.js/,
  );
});

test("source context digests bind content, additions, and removals", (context) => {
  for (const mutation of [
    (source) => writeSourceFile(source, "docs/guide.md", "changed\n"),
    (source) => writeSourceFile(source, "docs/new.md", "new\n"),
    (source) => rmSync(resolve(source, "docs/guide.md")),
  ]) {
    const source = temporarySource(context);
    writeSourceFile(source, "docs/guide.md", "original\n");
    writeSourceFile(source, "docs/keep.md", "keep\n");
    const sourceContext = [contextEntry(source, "docs")];
    mutation(source);
    assert.throws(
      () => inventorySource({ sourceRoot: source, sourceContext }),
      /source context digest mismatch: docs/,
    );
  }
});

test("source context rejects malformed, unsafe, symbolic, special, and overlapping paths", (context) => {
  const malformed = temporarySource(context);
  writeSourceFile(malformed, "docs/guide.md", "guide\n");
  for (const sourceContext of [
    {},
    [{ path: "docs" }],
    [{ path: "docs", digest: "A".repeat(64) }],
    [{ path: "../outside", digest: "a".repeat(64) }],
    [{ path: "docs", digest: "a".repeat(64), type: "metadata" }],
  ]) {
    assert.throws(
      () => inventorySource({ sourceRoot: malformed, sourceContext }),
      /source context/,
    );
  }

  const overlap = temporarySource(context);
  writeSourceFile(overlap, "docs/nested/guide.md", "guide\n");
  assert.throws(
    () => inventorySource({
      sourceRoot: overlap,
      sourceContext: [
        contextEntry(overlap, "docs"),
        contextEntry(overlap, "docs/nested"),
      ],
    }),
    /overlapping source context paths: docs, docs\/nested/,
  );

  const symbolic = temporarySource(context);
  writeSourceFile(symbolic, "real/guide.md", "guide\n");
  symlinkSync("real", resolve(symbolic, "docs"), "dir");
  assert.throws(
    () => inventorySource({
      sourceRoot: symbolic,
      sourceContext: [{ path: "docs", digest: "a".repeat(64) }],
    }),
    /symbolic links are not allowed|source context escapes source root/,
  );

  const nestedSymbolic = temporarySource(context);
  writeSourceFile(nestedSymbolic, "docs/guide.md", "guide\n");
  symlinkSync("guide.md", resolve(nestedSymbolic, "docs/alias.md"));
  assert.throws(
    () => inventorySource({
      sourceRoot: nestedSymbolic,
      sourceContext: [{ path: "docs", digest: "a".repeat(64) }],
    }),
    /symbolic links are not allowed/,
  );

  const special = temporarySource(context);
  mkdirSync(resolve(special, "docs"));
  const fifo = resolve(special, "docs/events");
  const mkfifo = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  if (mkfifo.status === 0) {
    assert.throws(
      () => inventorySource({
        sourceRoot: special,
        sourceContext: [{ path: "docs", digest: "a".repeat(64) }],
      }),
      /special filesystem entries are not allowed|tree hash root must be a file or directory/,
    );
  }
});

test("source context cannot overlap manifests, a license, skills, resources, or components", (context) => {
  const cases = [
    {
      path: ".claude-plugin",
      error: /source context overlaps upstream manifest/,
    },
    {
      path: "LICENSE",
      sourceType: "github",
      setup(source) { writeSourceFile(source, "LICENSE", "license\n"); },
      error: /source context overlaps redistributed license/,
    },
    {
      path: "skills/fixture",
      setup(source) {
        writeSourceFile(
          source,
          "skills/fixture/SKILL.md",
          "---\nname: fixture\ndescription: Fixture\n---\n",
        );
      },
      error: /source context overlaps inventoried skill/,
    },
    {
      path: "scripts",
      resources: [{ type: "executable", path: "scripts" }],
      setup(source) { writeSourceFile(source, "scripts/runtime.sh", "#!/bin/sh\n"); },
      error: /source context overlaps inventoried component/,
    },
    {
      path: "assets",
      setup(source) { writeSourceFile(source, "assets/icon.svg", "<svg/>\n"); },
      error: /source context overlaps inventoried component/,
    },
  ];
  for (const fixtureCase of cases) {
    const source = temporarySource(context);
    fixtureCase.setup?.(source);
    assert.throws(
      () => inventorySource({
        sourceRoot: source,
        sourceType: fixtureCase.sourceType,
        resources: fixtureCase.resources,
        sourceContext: [contextEntry(source, fixtureCase.path)],
      }),
      fixtureCase.error,
      fixtureCase.path,
    );
  }
});

test("skips only the exact root AGENTS.md to CLAUDE.md document alias", (context) => {
  const source = temporarySource(context);
  writeSourceFile(source, "CLAUDE.md", "# Instructions\n");
  symlinkSync("CLAUDE.md", resolve(source, "AGENTS.md"));

  const inventory = inventorySource({
    sourceRoot: source,
    sourceContext: [contextEntry(source, "CLAUDE.md")],
  });
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
  const manifests = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).manifests;
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
  const executable = inventorySource({
    sourceRoot: fixture,
    sourceContext: fixtureSourceContext(),
  }).components
    .find(({ type }) => type === "executable");

  assert.equal(executable.metadata.relativePath, "bin");
  assert.equal(readFileSync(helper, "utf8"), before);
});
