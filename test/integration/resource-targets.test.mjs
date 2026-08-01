import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { walkFiles } from "../../scripts/lib/path-safety.mjs";
import { validateRecursiveSkills } from "../../scripts/lib/validator.mjs";

function writeSourceFile(sourceRoot, relativePath, contents, mode) {
  const path = resolve(sourceRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  if (mode !== undefined) chmodSync(path, mode);
}

function fixture(context) {
  const root = mkdtempSync(resolve(tmpdir(), "resource-targets-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = resolve(root, "source");
  writeSourceFile(
    sourceRoot,
    ".claude-plugin/plugin.json",
    JSON.stringify({
      name: "resource-fixture",
      version: "1.0.0",
      skills: "./skills/",
      hooks: "./hooks/hooks.json",
    }),
  );
  writeSourceFile(
    sourceRoot,
    "skills/fixture/SKILL.md",
    "---\nname: fixture\ndescription: Resource fixture\n---\n\n# Fixture\n",
  );
  writeSourceFile(
    sourceRoot,
    "skills/fixture/references/flow.md",
    [
      "See the [framework](../../../assets/framework.svg).",
      "Use the [launcher](../../../bin/claude-seo).",
      "Run the [hook helper](../../../hooks/run-python-hook.js).",
      "Install the [requirements](../../../requirements.txt).",
      "",
    ].join("\n"),
  );
  writeSourceFile(sourceRoot, "assets/framework.svg", "<svg/>\n", 0o644);
  writeSourceFile(
    sourceRoot,
    "bin/claude-seo",
    "#!/bin/sh\nexec python3 \"$(dirname \"$0\")/../scripts/runtime.py\"\n",
    0o755,
  );
  writeSourceFile(sourceRoot, "scripts/runtime.py", "print('fixture')\n", 0o751);
  writeSourceFile(sourceRoot, "extensions/tool/install.sh", "#!/bin/sh\n", 0o755);
  writeSourceFile(
    sourceRoot,
    "extensions/tool/SKILL.md",
    "---\nname: hidden-resource-skill\ndescription: Resource payload\n---\n",
  );
  writeSourceFile(sourceRoot, "hooks/hooks.json", JSON.stringify({
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: "node ${CLAUDE_PLUGIN_ROOT}/hooks/run-python-hook.js",
        }],
      }],
    },
  }));
  writeSourceFile(sourceRoot, "hooks/run-python-hook.js", "export {};\n", 0o755);
  writeSourceFile(sourceRoot, "hooks/validate-schema.py", "print('valid')\n", 0o751);
  for (const path of [
    "schema/templates.json",
    "data/profile.json",
    "pdf/template.html",
    "screenshots/example.txt",
  ]) {
    writeSourceFile(sourceRoot, path, path + "\n", 0o640);
  }
  writeSourceFile(sourceRoot, "requirements.txt", "fixture==1.0.0\n", 0o644);
  return { sourceRoot, bundleRoot: resolve(root, "bundle") };
}

function plugin() {
  return {
    name: "resource-fixture",
    description: "Explicit resource fixture",
    category: "development",
    distributionVersion: "1.0.0-gravit.1",
    source: { type: "local", path: "sources/resource-fixture", root: "." },
    resources: [
      { type: "executable", path: "scripts" },
      { type: "executable", path: "extensions" },
      { type: "executable", path: "hooks/run-python-hook.js" },
      { type: "executable", path: "hooks/validate-schema.py" },
      { type: "asset", path: "schema" },
      { type: "asset", path: "data" },
      { type: "asset", path: "pdf" },
      { type: "asset", path: "screenshots" },
      { type: "asset", path: "requirements.txt" },
    ],
    targets: ["claude", "codex"],
    policies: { default: "transform-or-fail", skills: "transform" },
  };
}

test("explicit resources preserve root layout, modes, and runtime reachability", (context) => {
  const { sourceRoot, bundleRoot } = fixture(context);
  const manifest = buildPluginBundle({ plugin: plugin(), sourceRoot, bundleRoot });
  const resourcePaths = [
    "scripts",
    "extensions",
    "hooks/run-python-hook.js",
    "hooks/validate-schema.py",
    "schema",
    "data",
    "pdf",
    "screenshots",
    "requirements.txt",
  ];

  for (const target of ["claude", "codex"]) {
    const targetRoot = resolve(bundleRoot, "targets", target);
    for (const path of resourcePaths) {
      assert.equal(existsSync(resolve(targetRoot, path)), true, `${target}:${path}`);
    }
    assert.equal(statSync(resolve(targetRoot, "scripts/runtime.py")).mode & 0o777, 0o751);
    assert.equal(statSync(resolve(targetRoot, "extensions/tool/install.sh")).mode & 0o777, 0o755);
    assert.equal(statSync(resolve(targetRoot, "hooks/run-python-hook.js")).mode & 0o777, 0o755);
    assert.equal(statSync(resolve(targetRoot, "hooks/validate-schema.py")).mode & 0o777, 0o751);
    assert.equal(statSync(resolve(targetRoot, "schema/templates.json")).mode & 0o777, 0o640);
    const launcher = resolve(targetRoot, "bin/claude-seo");
    assert.match(readFileSync(launcher, "utf8"), /\.\.\/scripts\/runtime\.py/);
    assert.equal(existsSync(resolve(dirname(launcher), "../scripts/runtime.py")), true);
    const skillRoot = resolve(targetRoot, "skills");
    const flow = readFileSync(resolve(skillRoot, "fixture/references/flow.md"), "utf8");
    assert.match(flow, /\.\.\/\.\.\/\.\.\/assets\/framework\.svg/);
    assert.equal(
      existsSync(resolve(skillRoot, "fixture/references/../../../assets/framework.svg")),
      true,
    );
    assert.equal(
      walkFiles(skillRoot).filter((path) => path.endsWith("/SKILL.md")).length,
      1,
    );
    assert.deepEqual(validateRecursiveSkills(skillRoot, {
      target,
      projectionRoot: targetRoot,
      allowedComponentRoots: manifest.components
        .map((component) => component.targets[target])
        .filter((disposition) => ["preserved", "transformed"].includes(
          disposition.status,
        ))
        .map((disposition) => resolve(bundleRoot, disposition.path)),
    }), []);
  }

  const targetPaths = manifest.components.flatMap(({ targets }) => (
    [targets.claude.path, targets.codex.path]
  ));
  for (const target of ["claude", "codex"]) {
    for (const path of resourcePaths) {
      assert.equal(targetPaths.includes(`targets/${target}/${path}`), true, `${target}:${path}`);
    }
  }
});

test("OpenClaw relocates path resources under safe namespaces and rewrites skill links", (context) => {
  const { sourceRoot, bundleRoot } = fixture(context);
  const openClawPlugin = {
    ...plugin(),
    targets: ["openclaw"],
    adapterOptions: { openclaw: { bundleFormat: "codex" } },
    targetPolicies: {
      openclaw: {
        unsupported: { hook: "openclaw-does-not-run-claude-hook-json" },
      },
    },
  };
  const manifest = buildPluginBundle({ plugin: openClawPlugin, sourceRoot, bundleRoot });
  const targetRoot = resolve(bundleRoot, "targets/openclaw");
  const launcher = resolve(targetRoot, "bin/plugin-layout/bin/claude-seo");
  assert.equal(existsSync(launcher), true);
  assert.deepEqual(readFileSync(launcher), readFileSync(resolve(sourceRoot, "bin/claude-seo")));
  assert.match(readFileSync(launcher, "utf8"), /\.\.\/scripts\/runtime\.py/u);
  assert.equal(existsSync(resolve(dirname(launcher), "../scripts/runtime.py")), true);
  const targetFiles = walkFiles(targetRoot)
    .map((path) => path.slice(targetRoot.length + 1));
  for (const suffix of [
    "runtime.py",
    "install.sh",
    "run-python-hook.js",
    "validate-schema.py",
    "templates.json",
    "profile.json",
    "template.html",
    "example.txt",
    "requirements.txt",
  ]) {
    assert.equal(targetFiles.some((path) => path.endsWith("/" + suffix)), true, suffix);
  }
  assert.equal(existsSync(resolve(targetRoot, "hooks")), false);
  assert.equal(existsSync(resolve(targetRoot, "scripts")), false);
  assert.equal(existsSync(resolve(targetRoot, "requirements.txt")), false);

  const flowPath = resolve(targetRoot, "skills/fixture/references/flow.md");
  const flow = readFileSync(flowPath, "utf8");
  const links = [...flow.matchAll(/\]\(([^)]+)\)/gu)].map((match) => match[1]);
  assert.equal(links.length, 4);
  for (const link of links) {
    const linkedPath = resolve(dirname(flowPath), link);
    assert.equal(existsSync(linkedPath), true, link);
    assert.equal(
      linkedPath.startsWith(resolve(targetRoot, "assets") + "/")
        || linkedPath.startsWith(resolve(targetRoot, "bin") + "/"),
      true,
      link,
    );
  }

  const resources = manifest.components.filter(({ type }) => (
    type === "asset" || type === "executable"
  ));
  for (const component of resources) {
    assert.match(component.targets.openclaw.status, /^(?:preserved|transformed)$/u, component.id);
    if (component.targets.openclaw.status === "transformed") {
      assert.equal(component.targets.openclaw.reasonCode, "target-translation", component.id);
    }
    assert.match(
      component.targets.openclaw.path,
      component.type === "asset"
        ? /^targets\/openclaw\/assets(?:\/|$)/u
        : /^targets\/openclaw\/bin(?:\/|$)/u,
      component.id,
    );
  }
  assert.equal(
    resources.filter(({ targets }) => targets.openclaw.status === "transformed").length >= 9,
    true,
  );

  const secondBundle = resolve(bundleRoot, "../second-bundle");
  buildPluginBundle({ plugin: openClawPlugin, sourceRoot, bundleRoot: secondBundle });
  assert.equal(treeHash(secondBundle), treeHash(bundleRoot));
});

test("OpenClaw preserves disjoint source trees whose preferred namespaces overlap", (context) => {
  const { sourceRoot, bundleRoot } = fixture(context);
  writeSourceFile(sourceRoot, "assets/schema/templates.json", "conflict\n");
  const openClawPlugin = {
    ...plugin(),
    targets: ["openclaw"],
    adapterOptions: { openclaw: { bundleFormat: "codex" } },
    targetPolicies: {
      openclaw: {
        unsupported: { hook: "openclaw-does-not-run-claude-hook-json" },
      },
    },
  };

  assert.doesNotThrow(
    () => buildPluginBundle({ plugin: openClawPlugin, sourceRoot, bundleRoot }),
  );
  assert.equal(
    existsSync(resolve(bundleRoot, "targets/openclaw/assets/plugin-layout/assets/schema/templates.json")),
    true,
  );
  assert.equal(
    existsSync(resolve(bundleRoot, "targets/openclaw/assets/plugin-layout/schema/templates.json")),
    true,
  );
});

test("explicit resources cannot occupy generated target namespaces", (context) => {
  for (const [target, resourcePath, reserved] of [
    ["claude", ".claude-plugin", ".claude-plugin"],
    ["codex", ".codex-plugin", ".codex-plugin"],
    ["codex", "skills", "skills"],
  ]) {
    const root = mkdtempSync(resolve(tmpdir(), "resource-collision-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const sourceRoot = resolve(root, "source");
    const manifestRoot = target === "claude" ? ".claude-plugin" : ".codex-plugin";
    writeSourceFile(
      sourceRoot,
      `${manifestRoot}/plugin.json`,
      JSON.stringify({ name: "collision", version: "1.0.0" }),
    );
    if (resourcePath !== manifestRoot) {
      writeSourceFile(sourceRoot, `${resourcePath}/payload.txt`, "payload\n");
    }
    const collisionPlugin = {
      ...plugin(),
      name: "collision",
      source: { type: "local", path: "sources/collision", root: "." },
      resources: [{ type: "asset", path: resourcePath }],
      targets: [target],
    };
    const bundleRoot = resolve(root, "bundle");

    assert.throws(
      () => buildPluginBundle({ plugin: collisionPlugin, sourceRoot, bundleRoot }),
      new RegExp("resource target overlaps reserved namespace: " + reserved.replace(".", "\\.")),
    );
    assert.equal(existsSync(resolve(bundleRoot, "targets")), false);
  }
});
