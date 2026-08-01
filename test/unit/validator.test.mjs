import test from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { sourceContextHash, treeHash } from "../../scripts/lib/hash.mjs";
import { writeJson } from "../../scripts/lib/json.mjs";
import {
  validateRecursiveSkills,
  validateRepository,
} from "../../scripts/lib/validator.mjs";

function writeSkill(root, relativeDirectory, name) {
  const directory = resolve(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n# ${name}\n`,
  );
}

function validRepository(context, { includeOpenClaw = false } = {}) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-validator-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryRoot = resolve(parent, "repository");
  writeSkill(repositoryRoot, "sources/fixture/skills/child", "child");
  writeJson(resolve(repositoryRoot, "sources/fixture/.mcp.json"), {
    mcpServers: {
      fixture: {
        command: "npx",
        args: ["-y", "@fixture/mcp@latest"],
        env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
      },
    },
  });
  writeJson(resolve(repositoryRoot, "sources/fixture/hooks/hooks.json"), {
    hooks: {
      SessionStart: [{
        hooks: [{
          type: "command",
          command: 'bash "${CLAUDE_PLUGIN_ROOT}/bin/helper.sh"',
        }],
      }],
    },
  });
  mkdirSync(resolve(repositoryRoot, "sources/fixture/bin"), { recursive: true });
  writeFileSync(
    resolve(repositoryRoot, "sources/fixture/bin/helper.sh"),
    "#!/usr/bin/env bash\nexit 0\n",
  );
  const sourceContextPath = resolve(
    repositoryRoot,
    "sources/fixture/source-only-context.txt",
  );
  writeFileSync(sourceContextPath, "classification only\n");
  mkdirSync(resolve(repositoryRoot, "registry"), { recursive: true });
  writeFileSync(resolve(repositoryRoot, "registry/catalog.json"), JSON.stringify({
    schemaVersion: 1,
    name: "fixture-marketplace",
    plugins: [{
      name: "fixture",
      description: "Validator fixture",
      category: "development",
      distributionVersion: "1.0.0-gravit.1",
      runtimeDependencies: { "@fixture/mcp": "1.4.2" },
      source: { type: "local", path: "sources/fixture", root: "." },
      sourceContext: [{
        path: "source-only-context.txt",
        digest: sourceContextHash(sourceContextPath),
      }],
      targets: includeOpenClaw ? ["claude", "codex", "openclaw"] : ["claude", "codex"],
      ...(includeOpenClaw ? {
        adapterOptions: { openclaw: { bundleFormat: "codex" } },
        targetPolicies: {
          openclaw: {
            unsupported: {
              hook: "openclaw-does-not-run-claude-hook-json",
            },
          },
        },
      } : {}),
      policies: { default: "transform-or-fail", skills: "transform" },
    }],
  }));
  buildRegistry({
    repositoryRoot,
    catalogPath: "registry/catalog.json",
    outputRoot: repositoryRoot,
    production: true,
  });
  return repositoryRoot;
}

test("OpenClaw rejects every unsupported host binding and target root", (context) => {
  const repositoryRoot = validRepository(context, { includeOpenClaw: true });
  const targetRoot = "plugins/fixture/targets/openclaw";
  mutateJson(repositoryRoot, targetRoot + "/.codex-plugin/plugin.json", (host) => {
    host.agents = ["./agents/reviewer.md"];
    host.hooks = "./hooks/hooks.json";
    host.lspServers = "./.lsp.json";
    host.apps = "./.app.json";
    host.outputStyles = ["./output-styles/terse.md"];
    host.channels = ["./channels/alerts.json"];
    host.settings = "./settings.json";
    host.experimental = {
      monitors: "./monitors/monitors.json",
      themes: "./themes/",
    };
  });
  for (const [path, contents] of [
    ["agents/reviewer.md", "# reviewer\n"],
    ["hooks/hooks.json", "{}\n"],
    [".lsp.json", "{}\n"],
    [".app.json", "{}\n"],
    ["output-styles/terse.md", "# terse\n"],
    ["monitors/monitors.json", "{}\n"],
    ["themes/theme.json", "{}\n"],
    ["channels/alerts.json", "{}\n"],
    ["settings.json", "{}\n"],
  ]) {
    const destination = resolve(repositoryRoot, targetRoot, path);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    writeFileSync(destination, contents);
  }
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  for (const field of [
    "agents",
    "hooks",
    "lspServers",
    "apps",
    "outputStyles",
    "channels",
    "settings",
    "experimental",
  ]) {
    assertHasError(errors, `openclaw host manifest must not declare ${field}`);
  }
  for (const path of [
    "agents",
    "hooks",
    ".lsp.json",
    ".app.json",
    "output-styles",
    "monitors",
    "themes",
    "channels",
    "settings.json",
  ]) {
    assertHasError(errors, `openclaw target must not contain ${path}`);
  }
});

test("OpenClaw rejects a reserved target root even when an executable disposition owns it", (context) => {
  const repositoryRoot = validRepository(context, { includeOpenClaw: true });
  const pluginRoot = resolve(repositoryRoot, "plugins/fixture");
  const targetRoot = resolve(pluginRoot, "targets/openclaw");
  const sourcePath = resolve(targetRoot, "bin/helper.sh");
  const forbiddenPath = resolve(targetRoot, "hooks/helper.sh");
  mkdirSync(resolve(forbiddenPath, ".."), { recursive: true });
  renameSync(sourcePath, forbiddenPath);

  const manifestPath = resolve(pluginRoot, ".agent-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const executable = manifest.components.find(({ type }) => type === "executable");
  executable.targets.openclaw.path = "targets/openclaw/hooks/helper.sh";
  manifest.targets.openclaw.components[executable.id].path =
    "targets/openclaw/hooks/helper.sh";
  writeJson(manifestPath, manifest);

  const lockPath = resolve(repositoryRoot, "registry/lock.json");
  const lock = readJson(repositoryRoot, "registry/lock.json");
  const lockedExecutable = lock.plugins.fixture.components.find(({ id }) => id === executable.id);
  lockedExecutable.targets.openclaw.path = "targets/openclaw/hooks/helper.sh";
  writeJson(lockPath, lock);
  refreshGeneratedDigests(repositoryRoot);

  assertHasError(
    validateRepository({ repositoryRoot }),
    "openclaw target must not contain hooks",
  );
});

function readJson(repositoryRoot, relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
}

function mutateJson(repositoryRoot, relativePath, mutate) {
  const value = readJson(repositoryRoot, relativePath);
  mutate(value);
  writeJson(resolve(repositoryRoot, relativePath), value);
}

function refreshGeneratedDigests(repositoryRoot) {
  const pluginRoot = resolve(repositoryRoot, "plugins/fixture");
  const manifestPath = resolve(pluginRoot, ".agent-plugin/plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const lock = readJson(repositoryRoot, "registry/lock.json");
  for (const target of Object.keys(manifest.targets)) {
    const digest = treeHash(resolve(pluginRoot, `targets/${target}`));
    manifest.targets[target].digest = digest;
    lock.plugins.fixture.targets[target] = digest;
  }
  writeJson(manifestPath, manifest);
  lock.plugins.fixture.bundleDigest = treeHash(pluginRoot);
  writeJson(resolve(repositoryRoot, "registry/lock.json"), lock);
}

function assertHasError(errors, fragment) {
  assert.equal(
    errors.some((error) => error.includes(fragment)),
    true,
    `expected an error containing ${JSON.stringify(fragment)} in:\n${errors.join("\n")}`,
  );
}

function assertNoError(errors, fragment) {
  assert.equal(
    errors.some((error) => error.includes(fragment)),
    false,
    `did not expect an error containing ${JSON.stringify(fragment)} in:\n${errors.join("\n")}`,
  );
}

test("recursive skill validation reports duplicate names with sorted relative paths", (context) => {
  const skillsRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(skillsRoot, { recursive: true, force: true }));
  writeSkill(skillsRoot, "parent", "parent");
  writeSkill(skillsRoot, "parent/copied-child", "child");
  writeSkill(skillsRoot, "child", "child");

  assert.deepEqual(validateRecursiveSkills(skillsRoot), [
    "duplicate skill name child: child/SKILL.md, parent/copied-child/SKILL.md",
  ]);
});

test("recursive validation resolves BOM and non-BOM Markdown link offsets", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-bom-skills-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = resolve(parent, "targets/codex/skills");
  writeSkill(root, "fixture", "fixture");
  writeFileSync(resolve(root, "fixture/reference.md"), "# Reference\n");
  writeFileSync(
    resolve(root, "fixture/bom.md"),
    "\uFEFFRead [reference](./reference.md).\n",
  );
  writeFileSync(
    resolve(root, "fixture/plain.md"),
    "Read [reference](./reference.md).\n",
  );

  assert.deepEqual(validateRecursiveSkills(root), []);
});

test("recursive validation permits only explicitly owned component projection roots", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-owned-links-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const targetRoot = resolve(parent, "targets/codex");
  const skillsRoot = resolve(targetRoot, "skills");
  const assetsRoot = resolve(targetRoot, "assets");
  writeSkill(skillsRoot, "fixture", "fixture");
  mkdirSync(resolve(targetRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(resolve(targetRoot, ".codex-plugin/plugin.json"), "{}\n");
  writeFileSync(resolve(targetRoot, "package.json"), "{}\n");
  mkdirSync(assetsRoot);
  writeFileSync(resolve(assetsRoot, "icon.svg"), "<svg/>\n");
  symlinkSync("../package.json", resolve(assetsRoot, "metadata-link"));
  mkdirSync(resolve(targetRoot, "unsupported"));
  writeFileSync(resolve(targetRoot, "unsupported/payload.txt"), "unsupported\n");
  mkdirSync(resolve(targetRoot, "assets-prefix"));
  writeFileSync(resolve(targetRoot, "assets-prefix/payload.txt"), "prefix\n");
  const skill = resolve(skillsRoot, "fixture/SKILL.md");

  writeFileSync(skill, readFileSync(skill, "utf8") + [
    "[asset](../../assets/icon.svg)",
    "[host](../../.codex-plugin/plugin.json)",
    "[metadata](../../package.json)",
    "[unsupported](../../unsupported/payload.txt)",
    "[prefix](../../assets-prefix/payload.txt)",
    "[symlink](../../assets/metadata-link)",
    "[escape](../../../../outside.txt)",
    "",
  ].join("\n"));

  const errors = validateRecursiveSkills(skillsRoot, {
    target: "codex",
    projectionRoot: targetRoot,
    allowedComponentRoots: [skillsRoot, assetsRoot],
  });
  assertNoError(errors, "../../assets/icon.svg");
  for (const path of [
    "../../.codex-plugin/plugin.json",
    "../../package.json",
    "../../unsupported/payload.txt",
    "../../assets-prefix/payload.txt",
    "../../../../outside.txt",
  ]) {
    assertHasError(errors, `local Markdown link is outside owned components -> ${path}`);
  }
  assertHasError(errors, "unsafe local Markdown link -> ../../assets/metadata-link");
});

test("recursive validation requires a projection root for external component roots", (context) => {
  const targetRoot = mkdtempSync(resolve(tmpdir(), "registry-projection-required-"));
  context.after(() => rmSync(targetRoot, { recursive: true, force: true }));
  const skillsRoot = resolve(targetRoot, "skills");
  writeSkill(skillsRoot, "fixture", "fixture");

  assertHasError(
    validateRecursiveSkills(skillsRoot, { allowedComponentRoots: [skillsRoot] }),
    "projection root is required when allowed component roots are supplied",
  );
});

test("recursive validation rejects component roots outside the trusted projection", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-projection-escape-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const targetRoot = resolve(parent, "target");
  const skillsRoot = resolve(targetRoot, "skills");
  const outsideRoot = resolve(parent, "outside-assets");
  writeSkill(skillsRoot, "fixture", "fixture");
  mkdirSync(outsideRoot);
  writeFileSync(resolve(outsideRoot, "icon.svg"), "<svg/>\n");

  assertHasError(
    validateRecursiveSkills(skillsRoot, {
      projectionRoot: targetRoot,
      allowedComponentRoots: [skillsRoot, outsideRoot],
    }),
    "allowed component projection root: path escapes expected root",
  );
});

test("recursive validation rejects a parent symlink pivot below the projection root", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-projection-pivot-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const targetRoot = resolve(parent, "target");
  const outsideRoot = resolve(parent, "outside");
  mkdirSync(targetRoot);
  writeSkill(outsideRoot, "skills/fixture", "fixture");
  symlinkSync(outsideRoot, resolve(targetRoot, "pivot"));
  const pivotedSkillsRoot = resolve(targetRoot, "pivot/skills");

  assertHasError(
    validateRecursiveSkills(pivotedSkillsRoot, {
      projectionRoot: targetRoot,
      allowedComponentRoots: [pivotedSkillsRoot],
    }),
    "skills root: symbolic path is not allowed",
  );
});

test("repository validation rejects a skill link to generated host metadata", (context) => {
  const repositoryRoot = validRepository(context);
  const skill = resolve(
    repositoryRoot,
    "plugins/fixture/targets/codex/skills/child/SKILL.md",
  );
  writeFileSync(
    skill,
    readFileSync(skill, "utf8") + "\n[host metadata](../../.codex-plugin/plugin.json)\n",
  );
  refreshGeneratedDigests(repositoryRoot);

  assertHasError(
    validateRepository({ repositoryRoot }),
    "local Markdown link is outside owned components -> ../../.codex-plugin/plugin.json",
  );
});

test("repository validation detects a bundle mutation after lock creation", (context) => {
  const repositoryRoot = validRepository(context);
  writeFileSync(
    resolve(repositoryRoot, "plugins/fixture/components/skills/child/post-lock.txt"),
    "mutated\n",
  );

  assertHasError(validateRepository({ repositoryRoot }), "bundle digest mismatch");
});

test("a generated fixture repository passes every offline gate", (context) => {
  const repositoryRoot = validRepository(context);

  assert.deepEqual(validateRepository({ repositoryRoot }), []);
  const manifest = readJson(
    repositoryRoot,
    "plugins/fixture/.agent-plugin/plugin.json",
  );
  const lock = readJson(repositoryRoot, "registry/lock.json");
  assert.equal(JSON.stringify(manifest).includes("source-only-context"), false);
  assert.equal(JSON.stringify(lock).includes("source-only-context"), false);
  for (const target of ["claude", "codex"]) {
    assert.equal(existsSync(resolve(
      repositoryRoot,
      `plugins/fixture/targets/${target}/source-only-context.txt`,
    )), false);
  }
  assert.equal(existsSync(resolve(
    repositoryRoot,
    "plugins/fixture/components/source-only-context.txt",
  )), false);
});

test("target hooks require their exact target root placeholder", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/hooks/hooks.json", (hooks) => {
    hooks.hooks.SessionStart[0].hooks[0].command =
      'bash "${CLAUDE_PLUGIN_ROOT}/bin/helper.sh"';
  });
  refreshGeneratedDigests(repositoryRoot);

  assertHasError(
    validateRepository({ repositoryRoot }),
    "blocked hook command runtime",
  );
});

test("recursive skills report invalid frontmatter, true-like Codex flags, and nested links", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-codex-skills-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = resolve(parent, "targets/codex/skills");
  mkdirSync(resolve(root, "broken/references"), { recursive: true });
  writeFileSync(resolve(root, "broken/SKILL.md"), [
    "---",
    "name: broken",
    "disable-model-invocation: YES",
    "---",
    "",
    "# Broken",
    "",
  ].join("\n"));
  writeFileSync(
    resolve(root, "broken/references/guide.md"),
    "Read [missing](./missing.md).\n",
  );
  mkdirSync(resolve(root, "invalid"));
  writeFileSync(resolve(root, "invalid/SKILL.md"), "---\nname: invalid\n");
  mkdirSync(resolve(root, "broken/internal"));
  writeFileSync(resolve(root, "broken/internal/SKILL.md"), "# Internal resource\n");
  mkdirSync(resolve(root, "broken/malformed"));
  writeFileSync(
    resolve(root, "broken/malformed/SKILL.md"),
    "\uFEFF---\nname: malformed\n",
  );
  mkdirSync(resolve(root, "routable"));
  writeFileSync(resolve(root, "routable/SKILL.md"), "# Missing frontmatter\n");
  mkdirSync(resolve(root, "missing-root"));
  writeFileSync(resolve(root, "missing-root/reference.md"), "# Missing root skill\n");

  const errors = validateRecursiveSkills(root, { target: "codex" });
  assertHasError(errors, "broken/SKILL.md: missing frontmatter description");
  assertHasError(errors, "disable-model-invocation must not be true-like in Codex");
  assertHasError(errors, "broken local Markdown link -> ./missing.md");
  assertHasError(errors, "invalid/SKILL.md: invalid frontmatter");
  assertHasError(errors, "broken/malformed/SKILL.md: invalid frontmatter");
  assertHasError(errors, "routable/SKILL.md: invalid frontmatter");
  assertHasError(errors, "missing-root/SKILL.md: missing canonical skill entrypoint");
  assertNoError(errors, "broken/internal/SKILL.md: invalid frontmatter");
  assert.deepEqual(errors, [...errors].sort());
});

test("recursive skills reject invalid and prototype-like names", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-skill-names-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  writeSkill(root, "invalid", "Invalid Name");
  writeSkill(root, "prototype", "constructor");

  const errors = validateRecursiveSkills(root);
  assertHasError(errors, "skill name must match ^[a-z0-9][a-z0-9-]*$");
  assertHasError(errors, "prototype-like skill name constructor");
});

test("malformed JSON and schema failures are returned instead of thrown", (context) => {
  const repositoryRoot = validRepository(context);
  writeFileSync(resolve(repositoryRoot, "registry/lock.json"), "{not-json\n");
  mutateJson(repositoryRoot, "registry/catalog.json", (catalog) => {
    catalog.schemaVersion = 2;
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "registry/lock.json:");
  assertHasError(errors, "registry/catalog.json: schema /schemaVersion");
});

test("catalog, lock, marketplace, and plugin directory name drift is rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, ".claude-plugin/marketplace.json", (marketplace) => {
    marketplace.plugins[0].name = "renamed";
  });

  assertHasError(validateRepository({ repositoryRoot }), "registry plugin names disagree");
});

test("marketplace and host-manifest path escapes or symlink pivots are rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/claude/.claude-plugin/plugin.json", (manifest) => {
    manifest.skills = "../../../../sources/fixture/skills";
  });
  const realSkills = resolve(repositoryRoot, "plugins/fixture/targets/codex/skills-real");
  const skills = resolve(repositoryRoot, "plugins/fixture/targets/codex/skills");
  cpSync(skills, realSkills, { recursive: true });
  rmSync(skills, { recursive: true });
  symlinkSync(realSkills, skills, "dir");

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "path escapes expected root");
  assertHasError(errors, "symbolic path is not allowed");
});

test("missing and extra component accounting is rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/.agent-plugin/plugin.json", (manifest) => {
    manifest.components.pop();
  });

  assertHasError(
    validateRepository({ repositoryRoot }),
    "manifest and lock component sets disagree",
  );
});

test("component, target, and bundle digest mismatches are all detected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "registry/lock.json", (lock) => {
    lock.plugins.fixture.components[0].digest = "b".repeat(64);
  });
  writeFileSync(resolve(repositoryRoot, "plugins/fixture/targets/codex/mutation.txt"), "changed\n");

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "digest mismatch with lock");
  assertHasError(errors, "target digest mismatch");
  assertHasError(errors, "bundle digest mismatch");
});

test("a missing target disposition is rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/.agent-plugin/plugin.json", (manifest) => {
    delete manifest.components[0].targets.codex;
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "target disposition coverage mismatch");
  assertHasError(errors, "missing codex disposition");
});

test("unaccounted target components and neutral paths outside components are rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/.agent-plugin/plugin.json", (manifest) => {
    manifest.targets.codex.components.extra = {
      status: "unsupported",
      reasonCode: "synthetic-extra",
    };
    manifest.components[0].path = "targets/codex";
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "codex target component set mismatch");
  assertHasError(errors, "neutral component path escapes components root");
});

test("floating runtimes, absolute runtime paths, and concrete secrets are rejected", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcp_servers)[0];
    server.command = "/usr/bin/npx";
    server.args[1] = "@fixture/mcp@latest";
    server.env.FIXTURE_TOKEN = "concrete-secret";
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "floating runtime selector @fixture/mcp@latest");
  assertHasError(errors, "absolute runtime path /usr/bin/npx");
  assertHasError(errors, "concrete environment value");
});

test("runtime package pins and OCI images must be immutable", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.mcp.json", (mcp) => {
    Object.values(mcp.mcp_servers)[0].args[1] = "@fixture/mcp@9.9.9";
  });
  mutateJson(repositoryRoot, "plugins/fixture/targets/claude/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcpServers)[0];
    server.command = "docker";
    server.args = ["run", "registry.example/fixture:1.0"];
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "runtime package disagrees with catalog pin");
  assertHasError(errors, "container image must use an immutable sha256 digest");
});

test("container option values are not mistaken for an immutable image", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/claude/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcpServers)[0];
    server.command = "docker";
    server.args = [
      "run",
      "--name",
      "fixture-container",
      `registry.example/fixture@sha256:${"a".repeat(64)}`,
    ];
  });

  assert.equal(
    validateRepository({ repositoryRoot }).some((error) => error.includes("mutable OCI image")),
    false,
  );
});

test("unknown container options fail closed after target hashes are refreshed", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcp_servers)[0];
    server.command = "docker";
    server.args = [
      "run",
      "--mystery-option",
      "value",
      `registry.example/fixture@sha256:${"a".repeat(64)}`,
    ];
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "unsupported container MCP option: --mystery-option");
  assertNoError(errors, "digest mismatch");
});

test("container aliases reject tagged images even when a digest is appended", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/claude/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcpServers)[0];
    server.command = "docker.cmd";
    server.args = [
      "run",
      `registry.example/fixture:mutable@sha256:${"a".repeat(64)}`,
    ];
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "container image must use an immutable sha256 digest");
  assertNoError(errors, "digest mismatch");
});

test("npx package arguments must be exact catalog-declared runtime pins", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.mcp.json", (mcp) => {
    Object.values(mcp.mcp_servers)[0].args[1] = "@undeclared/mcp@9.9.9";
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "unpinned MCP package @undeclared/mcp");
  assertNoError(errors, "digest mismatch");
});

test("host checkout paths in runtime arguments fail closed", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcp_servers)[0];
    server.command = "node";
    server.args = ["--config=/checkout/config.json", "file:///checkout/tool.mjs"];
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "absolute runtime path --config=/checkout/config.json");
  assertHasError(errors, "absolute runtime path file:///checkout/tool.mjs");
  assertNoError(errors, "digest mismatch");
});

test("absolute bind sources fail but container-internal workdirs remain valid", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/claude/.mcp.json", (mcp) => {
    const server = Object.values(mcp.mcpServers)[0];
    server.command = "podman";
    server.args = [
      "run",
      "--workdir",
      "/app",
      "--mount=type=bind,source=/checkout,target=/workspace",
      `registry.example/fixture@sha256:${"a".repeat(64)}`,
    ];
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "absolute container bind source /checkout");
  assertNoError(errors, "absolute runtime path /app");
  assertNoError(errors, "digest mismatch");
});

test("hook command strings reject absolute checkout paths", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/hooks/hooks.json", (hooks) => {
    hooks.hooks.SessionStart[0].hooks[0].command = "node /checkout/tool.mjs";
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "absolute hook command path");
  assertNoError(errors, "digest mismatch");
});

test("supported target components must remain reachable from each host manifest", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "plugins/fixture/targets/codex/.codex-plugin/plugin.json", (manifest) => {
    delete manifest.skills;
    delete manifest.hooks;
    delete manifest.mcpServers;
  });
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "missing host manifest reference for skill child");
  assertHasError(errors, "missing host manifest reference for hook");
  assertHasError(errors, "missing host manifest reference for mcp");
  assertNoError(errors, "digest mismatch");
});

test("marketplace entries use the exact generated host shapes", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, ".claude-plugin/marketplace.json", (marketplace) => {
    marketplace.plugins[0].unexpected = true;
    marketplace.plugins.push({});
  });
  mutateJson(repositoryRoot, ".agents/plugins/marketplace.json", (marketplace) => {
    marketplace.plugins[0].category = "Cloud";
    marketplace.plugins[0].policy = {
      installation: "BLOCKED",
      authentication: "NEVER",
    };
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "Claude marketplace entry 0: unexpected field unexpected");
  assertHasError(errors, "Claude marketplace entry 1: entry must be an object with a name");
  assertHasError(errors, "codex marketplace fixture: invalid installation policy");
  assertHasError(errors, "codex marketplace fixture: category must be Development");
});

test("marketplace roots exactly match generated catalog metadata", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, ".claude-plugin/marketplace.json", (marketplace) => {
    marketplace.name = "renamed-marketplace";
    marketplace.owner = { name: "Someone Else" };
    marketplace.description = "Different description";
    marketplace.homepage = "https://example.test";
  });
  mutateJson(repositoryRoot, ".agents/plugins/marketplace.json", (marketplace) => {
    marketplace.name = "renamed-marketplace";
    delete marketplace.interface;
    marketplace.description = "Unexpected description";
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "Claude marketplace: unexpected root field homepage");
  assertHasError(errors, "Claude marketplace: name must match catalog");
  assertHasError(errors, "Claude marketplace: owner must match generated marketplace");
  assertHasError(errors, "Claude marketplace: description must match generated marketplace");
  assertHasError(errors, "Codex marketplace: unexpected root field description");
  assertHasError(errors, "Codex marketplace: missing root field interface");
  assertHasError(errors, "Codex marketplace: name must match catalog");
});

test("invalid executable paths are never passed to local syntax parsers", (context) => {
  const repositoryRoot = validRepository(context);
  const outside = resolve(repositoryRoot, "outside/evil.mjs");
  mkdirSync(resolve(repositoryRoot, "outside"));
  writeFileSync(outside, "export {};\n");
  const manifestPath = "plugins/fixture/.agent-plugin/plugin.json";
  const lockPath = "registry/lock.json";
  const manifest = readJson(repositoryRoot, manifestPath);
  const lock = readJson(repositoryRoot, lockPath);
  const component = manifest.components.find(({ type }) => type === "mcp");
  const lockComponent = lock.plugins.fixture.components.find(({ id }) => id === component.id);
  component.type = "executable";
  component.path = "../../outside/evil.mjs";
  component.digest = treeHash(outside);
  lockComponent.type = component.type;
  lockComponent.digest = component.digest;
  for (const target of ["claude", "codex"]) {
    component.targets[target].path = "../../outside/evil.mjs";
    manifest.targets[target].components[component.id] = structuredClone(component.targets[target]);
  }
  lockComponent.targets = structuredClone(component.targets);
  writeJson(resolve(repositoryRoot, manifestPath), manifest);
  writeJson(resolve(repositoryRoot, lockPath), lock);
  refreshGeneratedDigests(repositoryRoot);
  const calls = [];

  const errors = validateRepository({
    repositoryRoot,
    processRunner(command, args) {
      calls.push({ command, args });
      return { status: 0, stderr: "" };
    },
  });

  assertHasError(errors, "path escapes expected root");
  assert.equal(calls.some(({ args }) => args.includes(outside)), false);
});

test("a symlinked component root never reaches local syntax parsers", (context) => {
  const repositoryRoot = validRepository(context);
  const pluginRoot = resolve(repositoryRoot, "plugins/fixture");
  const componentsRoot = resolve(pluginRoot, "components");
  const outsideComponents = resolve(repositoryRoot, "outside-components");
  const manifestPath = "plugins/fixture/.agent-plugin/plugin.json";
  const lockPath = "registry/lock.json";
  const manifest = readJson(repositoryRoot, manifestPath);
  const lock = readJson(repositoryRoot, lockPath);
  const component = manifest.components.find(({ type }) => type === "mcp");
  const lockComponent = lock.plugins.fixture.components.find(({ id }) => id === component.id);
  component.type = "executable";
  lockComponent.type = "executable";
  renameSync(componentsRoot, outsideComponents);
  symlinkSync(outsideComponents, componentsRoot, "dir");
  const originalComponent = resolve(
    outsideComponents,
    component.path.slice("components/".length),
  );
  const outsideExecutable = resolve(outsideComponents, "mcp/evil.mjs");
  renameSync(originalComponent, outsideExecutable);
  writeFileSync(outsideExecutable, "export {};\n");
  component.path = "components/mcp/evil.mjs";
  lockComponent.digest = treeHash(outsideExecutable);
  component.digest = lockComponent.digest;
  writeJson(resolve(repositoryRoot, manifestPath), manifest);
  writeJson(resolve(repositoryRoot, lockPath), lock);
  const calls = [];

  const errors = validateRepository({
    repositoryRoot,
    processRunner(command, args) {
      calls.push({ command, args });
      return { status: 0, stderr: "" };
    },
  });

  assertHasError(errors, "symbolic");
  assert.equal(calls.some(({ args }) => args.some((argument) => (
    argument === outsideExecutable
    || (
      typeof argument === "string"
      && argument.endsWith("evil.mjs")
      && realpathSync(argument) === realpathSync(outsideExecutable)
    )
  ))), false);
});

test("invalid runtime component paths are rejected without reading outside JSON", (context) => {
  const repositoryRoot = validRepository(context);
  const outside = resolve(repositoryRoot, "outside/runtime.json");
  mkdirSync(resolve(repositoryRoot, "outside"));
  writeJson(outside, { env: { TOKEN: "outside-secret" } });
  const manifestPath = "plugins/fixture/.agent-plugin/plugin.json";
  const lockPath = "registry/lock.json";
  const manifest = readJson(repositoryRoot, manifestPath);
  const lock = readJson(repositoryRoot, lockPath);
  const component = manifest.components.find(({ type }) => type === "mcp");
  const lockComponent = lock.plugins.fixture.components.find(({ id }) => id === component.id);
  component.path = "../../outside/runtime.json";
  component.digest = treeHash(outside);
  lockComponent.digest = component.digest;
  for (const target of ["claude", "codex"]) {
    component.targets[target].path = "../../outside/runtime.json";
    manifest.targets[target].components[component.id] = structuredClone(component.targets[target]);
  }
  lockComponent.targets = structuredClone(component.targets);
  writeJson(resolve(repositoryRoot, manifestPath), manifest);
  writeJson(resolve(repositoryRoot, lockPath), lock);
  refreshGeneratedDigests(repositoryRoot);

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "path escapes expected root");
  assertNoError(errors, "concrete environment value");
});

test("maintained local source manifests stay version-aligned with package.json", (context) => {
  const repositoryRoot = validRepository(context);
  writeJson(resolve(repositoryRoot, "package.json"), { version: "1.0.0" });
  writeJson(resolve(repositoryRoot, "sources/gravit-custom/.claude-plugin/plugin.json"), {
    version: "2.0.0",
  });
  writeJson(resolve(repositoryRoot, "sources/gravit-custom/.codex-plugin/plugin.json"), {
    version: "3.0.0",
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "package.json and gravit-custom Claude plugin must have the same version");
  assertHasError(errors, "package.json and gravit-custom Codex plugin must have the same version");
});

test("an existing maintained source requires package and both host manifests", (context) => {
  const repositoryRoot = validRepository(context);
  mkdirSync(resolve(repositoryRoot, "sources/gravit-custom"), { recursive: true });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "package.json: path does not exist");
  assertHasError(
    errors,
    "sources/gravit-custom/.claude-plugin/plugin.json: path does not exist",
  );
  assertHasError(
    errors,
    "sources/gravit-custom/.codex-plugin/plugin.json: path does not exist",
  );
});

test("either maintained host manifest requires its sibling", (context) => {
  const repositoryRoot = validRepository(context);
  writeJson(resolve(repositoryRoot, "package.json"), { version: "1.0.0" });
  writeJson(resolve(repositoryRoot, "sources/gravit-custom/.claude-plugin/plugin.json"), {
    version: "1.0.0",
  });

  let errors = validateRepository({ repositoryRoot });
  assertHasError(
    errors,
    "sources/gravit-custom/.codex-plugin/plugin.json: path does not exist",
  );

  rmSync(resolve(repositoryRoot, "sources/gravit-custom/.claude-plugin"), {
    recursive: true,
  });
  writeJson(resolve(repositoryRoot, "sources/gravit-custom/.codex-plugin/plugin.json"), {
    version: "1.0.0",
  });

  errors = validateRepository({ repositoryRoot });
  assertHasError(
    errors,
    "sources/gravit-custom/.claude-plugin/plugin.json: path does not exist",
  );
});

test("a catalog-selected maintained source requires both host manifests", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "registry/catalog.json", (catalog) => {
    catalog.plugins[0].source.path = "sources/gravit-custom";
  });
  mutateJson(repositoryRoot, "registry/lock.json", (lock) => {
    lock.plugins.fixture.source.path = "sources/gravit-custom";
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(
    errors,
    "sources/gravit-custom/.claude-plugin/plugin.json: path does not exist",
  );
  assertHasError(
    errors,
    "sources/gravit-custom/.codex-plugin/plugin.json: path does not exist",
  );
});

test("lock provenance must remain bound to the catalog", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "registry/lock.json", (lock) => {
    lock.plugins.fixture.source.path = "sources/another-fixture";
    lock.plugins.fixture.generatorDigest = "d".repeat(64);
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "source mismatch with lock");
  assertHasError(errors, "generator digest mismatch");
});

test("GitHub bundles require a real LICENSE", (context) => {
  const repositoryRoot = validRepository(context);
  const source = {
    type: "github",
    repo: "gravit-cloud/fixture",
    ref: "v1.0.0",
    sha: "a".repeat(40),
    root: ".",
  };
  mutateJson(repositoryRoot, "registry/catalog.json", (catalog) => {
    catalog.plugins[0].source = source;
  });
  mutateJson(repositoryRoot, "registry/lock.json", (lock) => {
    lock.plugins.fixture.source = source;
  });

  assertHasError(validateRepository({ repositoryRoot }), "external LICENSE: path does not exist");
  writeFileSync(resolve(repositoryRoot, "plugins/fixture/LICENSE"), "");
  assertHasError(validateRepository({ repositoryRoot }), "external LICENSE must not be empty");
});

test("configured exceptions require a parseable strictly future expiry", (context) => {
  const repositoryRoot = validRepository(context);
  mutateJson(repositoryRoot, "registry/catalog.json", (catalog) => {
    catalog.plugins[0].exceptions = [
      { reason: "expired fixture", expiresAt: "2000-01-01T00:00:00Z" },
      { reason: "invalid fixture", expiresAt: "never" },
    ];
  });

  const errors = validateRepository({ repositoryRoot });
  assertHasError(errors, "exception is expired");
  assertHasError(errors, "exception expiry is not parseable");
});

test("syntax checking parses local scripts without executing them", (context) => {
  const repositoryRoot = validRepository(context);
  mkdirSync(resolve(repositoryRoot, "scripts"));
  writeFileSync(resolve(repositoryRoot, "scripts/broken.mjs"), "const = ;\n");

  assertHasError(validateRepository({ repositoryRoot }), "scripts/broken.mjs: syntax error");
});

test("offline syntax checks invoke only bounded local parsers", (context) => {
  const repositoryRoot = validRepository(context);
  mkdirSync(resolve(repositoryRoot, "scripts"));
  writeFileSync(resolve(repositoryRoot, "scripts/check.mjs"), "export {};\n");
  const calls = [];

  const errors = validateRepository({
    repositoryRoot,
    processRunner(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stderr: "" };
    },
  });

  assert.deepEqual(errors, []);
  assert.equal(calls.length, 4);
  assert.equal(calls.filter(({ command }) => command === process.execPath).length, 1);
  assert.equal(calls.filter(({ command }) => command === "bash").length, 3);
  for (const call of calls) {
    assert.deepEqual(call.args.slice(0, 1), [call.command === "bash" ? "-n" : "--check"]);
    assert.equal(call.options.timeout, 5_000);
    assert.equal(call.options.shell, undefined);
  }
});

test("compareLock rejects same-version bundle drift and cannot skip current verification", (context) => {
  const repositoryRoot = validRepository(context);
  const previous = structuredClone(readJson(repositoryRoot, "registry/lock.json"));
  previous.plugins.fixture.bundleDigest = "c".repeat(64);
  writeFileSync(
    resolve(repositoryRoot, "plugins/fixture/components/skills/child/post-lock.txt"),
    "mutated\n",
  );

  const errors = validateRepository({
    repositoryRoot,
    compareLock({ currentLock }) {
      assert.deepEqual(currentLock, readJson(repositoryRoot, "registry/lock.json"));
      return previous;
    },
  });
  assertHasError(errors, "bundle changed without distributionVersion bump");
  assertHasError(errors, "bundle digest mismatch");
});
