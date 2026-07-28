import test from "node:test";
import assert from "node:assert/strict";
import {
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
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";
import { walkFiles } from "../../scripts/lib/path-safety.mjs";

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

function sandboxRegistry(context, options = {}) {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-preflight-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const repositoryParent = resolve(parent, "repository-parent");
  const sandboxRepository = resolve(repositoryParent, "repository");
  const sourceRoot = resolve(sandboxRepository, "test/fixtures/source");
  const sourceDirectory = resolve(sourceRoot, "skills/safe");
  const catalogPath = options.catalogPath ?? "catalog.json";
  mkdirSync(sourceDirectory, { recursive: true });
  writeFileSync(
    resolve(sourceDirectory, "SKILL.md"),
    "---\nname: safe\ndescription: Safe fixture\n---\n",
  );
  const absoluteCatalogPath = resolve(sandboxRepository, catalogPath);
  mkdirSync(dirname(absoluteCatalogPath), { recursive: true });
  writeFileSync(
    absoluteCatalogPath,
    JSON.stringify({
      schemaVersion: 1,
      name: "preflight-fixture",
      plugins: [{
        name: "safe-plugin",
        description: "Output preflight fixture",
        category: "development",
        distributionVersion: "1.0.0",
        source: { type: "local", path: "test/fixtures/source", root: "." },
        targets: ["codex"],
        policies: { default: "transform-or-fail", skills: "transform" },
      }],
    }),
  );
  return {
    catalogPath,
    repositoryParent,
    repositoryRoot: sandboxRepository,
    sourceRoot,
  };
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

  const result = buildRegistry({ ...input, outputRoot: first });
  buildRegistry({ ...input, outputRoot: second });

  assert.equal(treeHash(first), treeHash(second));

  const bundle = resolve(first, "plugins/nested-skills");
  const neutral = JSON.parse(readFileSync(resolve(bundle, ".agent-plugin/plugin.json")));
  assert.equal(result.catalogName, "fixture-marketplace");
  assert.equal(result.outputRoot, first);
  assert.equal(result.plugins[0].name, "nested-skills");
  assert.equal(result.plugins[0].bundleRoot, bundle);
  assert.deepEqual(result.plugins[0].manifest, neutral);
  assert.deepEqual(neutral.components.map((component) => component.id), ["child", "parent"]);
  const neutralSkillsRoot = resolve(bundle, "components/skills");
  const neutralNames = walkFiles(neutralSkillsRoot)
    .filter((path) => path.endsWith("/SKILL.md"))
    .map((path) => readFileSync(path, "utf8"))
    .filter((markdown) => markdown.startsWith("---\n") || markdown.startsWith("---\r\n"))
    .map((markdown) => parseFrontmatter(markdown).attributes.name)
    .sort();
  assert.deepEqual(neutralNames, ["child", "parent"]);
  assert.equal(existsSync(resolve(neutralSkillsRoot, "parent/child/SKILL.md")), false);
  assert.match(
    readFileSync(resolve(neutralSkillsRoot, "parent/SKILL.md"), "utf8"),
    /\[the child\]\(\.\.\/child\/SKILL\.md\)/,
  );
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

test("rejects repository and local-source output overlap before atomic promotion", (context) => {
  const cases = [
    ["repository root", ({ repositoryRoot: root }) => root],
    ["plugins tree", ({ repositoryRoot: root }) => resolve(root, "plugins")],
    ["agents tree", ({ repositoryRoot: root }) => resolve(root, ".agents")],
    ["Claude marketplace tree", ({ repositoryRoot: root }) => resolve(root, ".claude-plugin")],
    ["foundation root itself", ({ repositoryRoot: root }) => resolve(root, ".tmp")],
    ["source root", ({ sourceRoot: root }) => root],
    ["source ancestor", ({ repositoryRoot: root }) => resolve(root, "test/fixtures")],
    ["source descendant", ({ sourceRoot: root }) => resolve(root, "skills")],
    ["repository ancestor", ({ repositoryParent }) => repositoryParent],
  ];

  for (const [label, outputFor] of cases) {
    const input = sandboxRegistry(context);
    const outputRoot = outputFor(input);
    mkdirSync(outputRoot, { recursive: true });
    const sentinel = resolve(outputRoot, "preflight-sentinel.txt");
    writeFileSync(sentinel, "keep\n");

    const error = captureBuildError({ ...input, outputRoot });

    assert.match(error?.message ?? "", /unsafe registry output/, label);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n", label);
  }
});

test("rejects catalog overlap inside the foundation output area", (context) => {
  const input = sandboxRegistry(context, {
    catalogPath: ".tmp/catalog-output/catalog.json",
  });
  const outputRoot = resolve(input.repositoryRoot, ".tmp/catalog-output");
  const catalogFile = resolve(input.repositoryRoot, input.catalogPath);
  const originalCatalog = readFileSync(catalogFile, "utf8");

  const error = captureBuildError({ ...input, outputRoot });

  assert.match(error?.message ?? "", /unsafe registry output overlaps catalog/);
  assert.equal(readFileSync(catalogFile, "utf8"), originalCatalog);
});

test("rejects a foundation output symlink that resolves into a production tree", (context) => {
  const input = sandboxRegistry(context);
  const productionTree = resolve(input.repositoryRoot, "plugins");
  const foundationRoot = resolve(input.repositoryRoot, ".tmp");
  mkdirSync(productionTree, { recursive: true });
  mkdirSync(foundationRoot, { recursive: true });
  writeFileSync(resolve(productionTree, "preflight-sentinel.txt"), "keep\n");
  symlinkSync(productionTree, resolve(foundationRoot, "redirect"));

  const error = captureBuildError({
    ...input,
    outputRoot: resolve(foundationRoot, "redirect/generated"),
  });

  assert.match(error?.message ?? "", /unsafe registry output/);
  assert.equal(
    readFileSync(resolve(productionTree, "preflight-sentinel.txt"), "utf8"),
    "keep\n",
  );
});

test("rejects a symlinked .tmp root that resolves into a production tree", (context) => {
  const input = sandboxRegistry(context);
  const productionTree = resolve(input.repositoryRoot, "plugins");
  mkdirSync(productionTree, { recursive: true });
  writeFileSync(resolve(productionTree, "preflight-sentinel.txt"), "keep\n");
  symlinkSync(productionTree, resolve(input.repositoryRoot, ".tmp"));

  const error = captureBuildError({
    ...input,
    outputRoot: resolve(input.repositoryRoot, ".tmp/generated"),
  });

  assert.match(error?.message ?? "", /unsafe registry output/);
  assert.equal(
    readFileSync(resolve(productionTree, "preflight-sentinel.txt"), "utf8"),
    "keep\n",
  );
});

test("allows a disjoint foundation output below the real .tmp root", (context) => {
  const input = sandboxRegistry(context);
  const outputRoot = resolve(input.repositoryRoot, ".tmp/foundation-output");

  buildRegistry({ ...input, outputRoot });

  assert.equal(
    existsSync(resolve(outputRoot, "plugins/safe-plugin/.agent-plugin/plugin.json")),
    true,
  );
  assert.equal(existsSync(resolve(input.sourceRoot, "skills/safe/SKILL.md")), true);
});
