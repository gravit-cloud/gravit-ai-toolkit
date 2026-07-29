import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateCatalog } from "../../scripts/lib/catalog.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixtureCatalog(sourcePath = "test/fixtures/source") {
  return {
    schemaVersion: 1,
    name: "boundary-fixture",
    plugins: [{
      name: "boundary-plugin",
      description: "Catalog boundary fixture",
      category: "development",
      distributionVersion: "1.0.0",
      source: { type: "local", path: sourcePath, root: "." },
      targets: ["codex"],
      policies: { default: "transform-or-fail", skills: "transform" },
    }],
  };
}

test("loads the checked-in fixture catalog", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  assert.equal(catalog.plugins[0].name, "nested-skills");
  assert.deepEqual(catalog.plugins[0].runtimeDependencies, {
    "@fixture/mcp": "1.4.2",
  });
});

test("accepts exact runtime dependency pins and rejects floating selectors", () => {
  const catalog = fixtureCatalog();
  catalog.plugins[0].runtimeDependencies = { "@fixture/mcp": "1.4.2-beta.1" };
  assert.doesNotThrow(() => validateCatalog(catalog));

  for (const version of [
    "latest",
    "next",
    "*",
    "^1.4.2",
    "~1.4.2",
    "1.4.x",
    "1.4",
    "01.4.2",
    "1.04.2",
    "1.4.02",
    "1.4.2-alpha..1",
    "1.4.2-alpha.01",
  ]) {
    catalog.plugins[0].runtimeDependencies = { "@fixture/mcp": version };
    assert.throws(
      () => validateCatalog(catalog),
      /invalid registry catalog: .*must match pattern/,
    );
  }
});

test("rejects invalid and prototype-like runtime dependency package names", () => {
  const catalog = fixtureCatalog();
  for (const name of [
    "not a package",
    "@scope/pkg@latest",
    "constructor",
    "prototype",
    "__proto__",
  ]) {
    catalog.plugins[0].runtimeDependencies = Object.fromEntries([[name, "1.4.2"]]);
    assert.throws(
      () => validateCatalog(catalog),
      /invalid registry catalog/,
    );
  }
});

test("rejects duplicate plugin names after schema validation", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  catalog.plugins.push(structuredClone(catalog.plugins[0]));
  assert.throws(() => validateCatalog(catalog), /duplicate plugin name: nested-skills/);
});

test("accepts optional target policies with known targets, component types, and stable reasons", () => {
  const catalog = fixtureCatalog();
  catalog.plugins[0].targetPolicies = {
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
  };

  assert.doesNotThrow(() => validateCatalog(catalog));
});

test("rejects malformed target policies and prototype-like keys", () => {
  const cases = [
    { future: { unsupported: {} } },
    { codex: {} },
    { codex: { unsupported: {}, extra: true } },
    { codex: { unsupported: { daemon: "host-does-not-load-daemons" } } },
    { codex: { unsupported: { agent: "Host does not load agents" } } },
    JSON.parse('{"__proto__":{"unsupported":{}}}'),
    { codex: { unsupported: JSON.parse('{"constructor":"not-loaded"}') } },
  ];
  for (const targetPolicies of cases) {
    const catalog = fixtureCatalog();
    catalog.plugins[0].targetPolicies = targetPolicies;
    assert.throws(
      () => validateCatalog(catalog),
      /invalid registry catalog/,
    );
  }
});

test("rejects catalog paths outside the repository lexically and canonically", (context) => {
  const parent = mkdtempSync(resolve(tmpdir(), "registry-catalog-"));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const sandboxRepository = resolve(parent, "repository");
  const outsideCatalog = resolve(parent, "outside-catalog.json");
  mkdirSync(resolve(sandboxRepository, "test/fixtures/source"), { recursive: true });
  writeFileSync(outsideCatalog, JSON.stringify(fixtureCatalog()));

  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "../outside-catalog.json",
    }),
    /registry catalog escapes source root/,
  );

  symlinkSync(outsideCatalog, resolve(sandboxRepository, "catalog-link.json"));
  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "catalog-link.json",
    }),
    /registry catalog escapes source root/,
  );
});

test("rejects local sources outside the real test fixture root", (context) => {
  const sandboxRepository = mkdtempSync(resolve(tmpdir(), "registry-catalog-"));
  context.after(() => rmSync(sandboxRepository, { recursive: true, force: true }));
  const fixturesRoot = resolve(sandboxRepository, "test/fixtures");
  const outsideSource = resolve(sandboxRepository, "test/outside-source");
  mkdirSync(fixturesRoot, { recursive: true });
  mkdirSync(outsideSource, { recursive: true });

  writeFileSync(
    resolve(sandboxRepository, "traversal-catalog.json"),
    JSON.stringify(fixtureCatalog("test/fixtures/../outside-source")),
  );
  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "traversal-catalog.json",
    }),
    /local catalog source escapes source root/,
  );

  symlinkSync(outsideSource, resolve(fixturesRoot, "linked-source"));
  writeFileSync(
    resolve(sandboxRepository, "symlink-catalog.json"),
    JSON.stringify(fixtureCatalog("test/fixtures/linked-source")),
  );
  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "symlink-catalog.json",
    }),
    /local catalog source escapes source root/,
  );
});

test("accepts sources as a local boundary and rejects lexical or canonical escape", (context) => {
  const sandboxRepository = mkdtempSync(resolve(tmpdir(), "registry-sources-catalog-"));
  context.after(() => rmSync(sandboxRepository, { recursive: true, force: true }));
  const sourcesRoot = resolve(sandboxRepository, "sources");
  const safeSource = resolve(sourcesRoot, "safe-source");
  const outsideSource = resolve(sandboxRepository, "outside-source");
  mkdirSync(safeSource, { recursive: true });
  mkdirSync(outsideSource);

  writeFileSync(
    resolve(sandboxRepository, "safe-catalog.json"),
    JSON.stringify(fixtureCatalog("sources/safe-source")),
  );
  assert.equal(loadCatalog({
    repositoryRoot: sandboxRepository,
    catalogPath: "safe-catalog.json",
  }).plugins[0].source.path, "sources/safe-source");

  writeFileSync(
    resolve(sandboxRepository, "traversal-catalog.json"),
    JSON.stringify(fixtureCatalog("sources/../outside-source")),
  );
  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "traversal-catalog.json",
    }),
    /local catalog source escapes source root/,
  );

  symlinkSync(outsideSource, resolve(sourcesRoot, "linked-source"));
  writeFileSync(
    resolve(sandboxRepository, "symlink-catalog.json"),
    JSON.stringify(fixtureCatalog("sources/linked-source")),
  );
  assert.throws(
    () => loadCatalog({
      repositoryRoot: sandboxRepository,
      catalogPath: "symlink-catalog.json",
    }),
    /local catalog source escapes source root/,
  );
});
