import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog, validateCatalog } from "../../scripts/lib/catalog.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("loads the checked-in fixture catalog", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  assert.equal(catalog.plugins[0].name, "nested-skills");
});

test("rejects duplicate plugin names after schema validation", () => {
  const catalog = loadCatalog({
    repositoryRoot,
    catalogPath: "test/fixtures/skill-only-catalog.json",
  });
  catalog.plugins.push(structuredClone(catalog.plugins[0]));
  assert.throws(() => validateCatalog(catalog), /duplicate plugin name: nested-skills/);
});
