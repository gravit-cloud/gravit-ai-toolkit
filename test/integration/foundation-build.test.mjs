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
import { dirname, relative, resolve } from "node:path";
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

test("removes a stageSource recoveryPath after outer cleanup deletes it", (context) => {
  const input = sandboxRegistry(context);
  const catalogFile = resolve(input.repositoryRoot, input.catalogPath);
  const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
  catalog.plugins[0].source = {
    type: "github",
    repo: "owner/repository",
    ref: "v1.0.0",
    sha: "0123456789abcdef0123456789abcdef01234567",
    root: ".",
  };
  writeFileSync(catalogFile, JSON.stringify(catalog));
  let error;

  assert.throws(() => buildRegistry({
    ...input,
    outputRoot: resolve(input.repositoryParent, "../recovery-output"),
    fetchGitHub({ destination }) {
      mkdirSync(destination, { recursive: true });
      writeFileSync(resolve(destination, "partial.txt"), "partial\n");
      throw new Error("synthetic registry fetch failure");
    },
  }), (caught) => {
    error = caught;
    return /synthetic registry fetch failure/.test(caught.message);
  });

  assert.equal(Object.hasOwn(error, "recoveryPath"), false);
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

test("rejects ancestor and descendant overlap with canonical production roots", (context) => {
  const cases = [
    {
      label: "Claude production root contains output",
      productionName: ".claude-plugin",
      paths(input) {
        const target = resolve(input.repositoryRoot, ".tmp/production-target");
        return { outputRoot: resolve(target, "generated"), target };
      },
    },
    {
      label: "output contains Agents production root",
      productionName: ".agents",
      paths(input) {
        const outputRoot = resolve(input.repositoryParent, "../external-production");
        return { outputRoot, target: resolve(outputRoot, "agents-target") };
      },
    },
    {
      label: "output equals plugins production root",
      productionName: "plugins",
      paths(input) {
        const target = resolve(input.repositoryParent, "../external-plugins");
        return { outputRoot: target, target };
      },
    },
  ];

  for (const { label, paths, productionName } of cases) {
    const input = sandboxRegistry(context);
    const { outputRoot, target } = paths(input);
    mkdirSync(target, { recursive: true });
    const sentinel = resolve(target, "production-sentinel.txt");
    writeFileSync(sentinel, "keep\n");
    symlinkSync(target, resolve(input.repositoryRoot, productionName));

    const error = captureBuildError({ ...input, outputRoot });

    assert.match(error?.message ?? "", /unsafe registry output/, label);
    assert.equal(readFileSync(sentinel, "utf8"), "keep\n", label);
  }
});

test("rejects every dangling production-root overlap before manifest exposure", (context) => {
  const failures = [];
  const productionNames = [".claude-plugin", ".agents", "plugins"];
  const locations = ["internal", "external"];
  const relations = ["ancestor", "descendant", "equality"];

  for (const productionName of productionNames) {
    for (const location of locations) {
      for (const relation of relations) {
        const input = sandboxRegistry(context);
        const anchor = location === "internal"
          ? resolve(input.repositoryRoot, ".tmp", "dangling-production")
          : resolve(input.repositoryParent, "..", "dangling-production");
        const outputRoot = resolve(anchor, "output");
        const productionTarget = relation === "ancestor"
          ? resolve(outputRoot, "production-target")
          : resolve(anchor, "production-target");
        const effectiveOutput = relation === "equality"
          ? productionTarget
          : relation === "descendant"
            ? resolve(productionTarget, "generated")
            : outputRoot;
        const sentinelRoot = relation === "ancestor" ? effectiveOutput : anchor;
        mkdirSync(sentinelRoot, { recursive: true });
        const sentinel = resolve(sentinelRoot, "production-sentinel.txt");
        writeFileSync(sentinel, "keep\n");
        const productionLink = resolve(input.repositoryRoot, productionName);
        const linkTarget = location === "internal"
          ? relative(dirname(productionLink), productionTarget)
          : productionTarget;
        symlinkSync(linkTarget, productionLink);
        const outputManifest = resolve(
          effectiveOutput,
          "plugins/safe-plugin/.agent-plugin/plugin.json",
        );
        const productionManifest = relation === "ancestor"
          ? undefined
          : resolve(productionLink, relative(productionTarget, outputManifest));

        const error = captureBuildError({ ...input, outputRoot: effectiveOutput });
        const errorMessage = error?.message ?? "";
        const sentinelContents = existsSync(sentinel)
          ? readFileSync(sentinel, "utf8")
          : "<missing>";
        const observed = {
          error: errorMessage,
          outputManifest: existsSync(outputManifest),
          productionLinkActive: existsSync(productionLink),
          productionManifest: productionManifest
            ? existsSync(productionManifest)
            : false,
          sentinel: sentinelContents,
        };
        if (
          !/unsafe registry output/.test(errorMessage)
          || sentinelContents !== "keep\n"
          || observed.outputManifest
          || observed.productionLinkActive
          || observed.productionManifest
        ) {
          failures.push({
            case: [productionName, location, relation].join("/"),
            ...observed,
          });
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test("rejects production targets whose dot segments follow a symlink pivot", (context) => {
  const failures = [];
  const cases = [
    [".claude-plugin", "pivot-one/../production-target"],
    [".agents", "absolute"],
    ["plugins", "pivot-one/./nested/../../production-target"],
  ];

  for (const [productionName, configuredTarget] of cases) {
    const input = sandboxRegistry(context);
    const external = resolve(input.repositoryParent, "..", "pivot-external");
    const pivotTarget = resolve(external, "pivot-target");
    mkdirSync(resolve(pivotTarget, "nested"), { recursive: true });
    const sentinel = resolve(external, "production-sentinel.txt");
    writeFileSync(sentinel, "keep\n");
    symlinkSync(pivotTarget, resolve(input.repositoryRoot, "pivot-two"));
    symlinkSync("pivot-two", resolve(input.repositoryRoot, "pivot-one"));
    const productionLink = resolve(input.repositoryRoot, productionName);
    const linkTarget = configuredTarget === "absolute"
      ? input.repositoryRoot + "/pivot-one/./nested/../../production-target"
      : configuredTarget;
    symlinkSync(linkTarget, productionLink);
    const outputRoot = resolve(external, "production-target");
    const outputManifest = resolve(
      outputRoot,
      "plugins/safe-plugin/.agent-plugin/plugin.json",
    );
    const exposedManifest = resolve(
      productionLink,
      "plugins/safe-plugin/.agent-plugin/plugin.json",
    );

    const error = captureBuildError({ ...input, outputRoot });
    const observed = {
      error: error?.message ?? "",
      exposedManifest: existsSync(exposedManifest),
      outputManifest: existsSync(outputManifest),
      productionLinkActive: existsSync(productionLink),
      sentinel: existsSync(sentinel) ? readFileSync(sentinel, "utf8") : "<missing>",
    };
    if (
      !/unsafe registry output/.test(observed.error)
      || observed.exposedManifest
      || observed.outputManifest
      || observed.productionLinkActive
      || observed.sentinel !== "keep\n"
    ) {
      failures.push({ productionName, ...observed });
    }
  }

  assert.deepEqual(failures, []);
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
