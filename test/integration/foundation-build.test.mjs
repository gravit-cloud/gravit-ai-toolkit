import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function maliciousRegistry(context, skillName) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-malicious-skill-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const sandboxRepository = resolve(parent, "repository");
  const sourceDirectory = resolve(
    sandboxRepository,
    "test/fixtures/malicious-source/skills/malicious",
  );
  const catalogPath = "test/fixtures/malicious-catalog.json";
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    resolve(sourceDirectory, "SKILL.md"),
    `---\nname: ${skillName}\ndescription: Malicious skill name\n---\n\n# Malicious\n`,
  );
  writeFileSync(
    resolve(sandboxRepository, catalogPath),
    JSON.stringify({
      schemaVersion: 1,
      name: "malicious-fixture",
      plugins: [{
        name: "malicious-plugin",
        description: "Malicious skill name fixture",
        category: "development",
        distributionVersion: "1.0.0",
        source: {
          type: "local",
          path: "test/fixtures/malicious-source",
          root: ".",
        },
        targets: ["claude", "codex"],
        policies: { default: "transform-or-fail", skills: "transform" },
      }],
    }),
  );
  return {
    repositoryRoot: sandboxRepository,
    catalogPath,
    outputRoot: resolve(parent, "output"),
  };
}

function captureBuildError(input) {
  try {
    buildRegistry(input);
    return undefined;
  } catch (error) {
    return error;
  }
}

test("builds byte-identical universal bundles twice", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-build-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const first = resolve(parent, "first");
  const second = resolve(parent, "second");
  const input = {
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  };

  buildRegistry({ ...input, outputRoot: first });
  buildRegistry({ ...input, outputRoot: second });

  assert.equal(treeHash(first), treeHash(second));

  const bundle = resolve(first, "plugins/nested-skills");
  const neutral = JSON.parse(readFileSync(resolve(bundle, ".agent-plugin/plugin.json")));
  assert.deepEqual(neutral.components.map((component) => component.id), ["child", "parent"]);
  assert.equal(
    JSON.parse(readFileSync(
      resolve(bundle, "targets/codex/.codex-plugin/plugin.json"),
    )).interface.defaultPrompt.length,
    1,
  );
});

test("rejects an absolute skill name without writing outside atomic output", (context) => {
  const outside = resolve(
    mkdtempSync(resolve(tmpdir(), "registry-absolute-parent-")),
    "escaped-absolute",
  );
  const outsideParent = dirname(outside);
  context.after(() => rmSync(outsideParent, { recursive: true, force: true }));
  const input = maliciousRegistry(context, outside);

  const error = captureBuildError(input);

  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(input.outputRoot), false);
  assert.match(error?.message ?? "", /skill name must match \^\[a-z0-9\]/);
});

test("rejects a traversal skill name without promoting escaped artifacts", (context) => {
  const input = maliciousRegistry(context, "../../../../escaped-traversal");

  const error = captureBuildError(input);

  assert.equal(existsSync(resolve(input.outputRoot, "escaped-traversal")), false);
  assert.equal(existsSync(input.outputRoot), false);
  assert.match(error?.message ?? "", /skill name must match \^\[a-z0-9\]/);
});
