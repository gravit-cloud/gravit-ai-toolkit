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
import { resolve } from "node:path";
import { buildRegistry } from "../../scripts/build-registry.mjs";
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

function validRepository(context) {
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
      targets: ["claude", "codex"],
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

function readJson(repositoryRoot, relativePath) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, relativePath), "utf8"));
}

function mutateJson(repositoryRoot, relativePath, mutate) {
  const value = readJson(repositoryRoot, relativePath);
  mutate(value);
  writeJson(resolve(repositoryRoot, relativePath), value);
}

function assertHasError(errors, fragment) {
  assert.equal(
    errors.some((error) => error.includes(fragment)),
    true,
    `expected an error containing ${JSON.stringify(fragment)} in:\n${errors.join("\n")}`,
  );
}

test("recursive skill validation reports duplicate names with sorted relative paths", (context) => {
  const skillsRoot = mkdtempSync(resolve(tmpdir(), "registry-skills-"));
  context.after(() => rmSync(skillsRoot, { recursive: true, force: true }));
  writeSkill(skillsRoot, "parent/copied-child", "child");
  writeSkill(skillsRoot, "child", "child");

  assert.deepEqual(validateRecursiveSkills(skillsRoot), [
    "duplicate skill name child: child/SKILL.md, parent/copied-child/SKILL.md",
  ]);
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
  writeFileSync(resolve(root, "invalid/SKILL.md"), "# No frontmatter\n");

  const errors = validateRecursiveSkills(root);
  assertHasError(errors, "broken/SKILL.md: missing frontmatter description");
  assertHasError(errors, "disable-model-invocation must not be true-like in Codex");
  assertHasError(errors, "broken local Markdown link -> ./missing.md");
  assertHasError(errors, "invalid/SKILL.md: invalid frontmatter");
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
  assertHasError(errors, "mutable OCI image registry.example/fixture:1.0");
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(0, 1), ["--check"]);
  assert.equal(calls[0].options.timeout, 5_000);
  assert.equal(calls[0].options.shell, undefined);
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
