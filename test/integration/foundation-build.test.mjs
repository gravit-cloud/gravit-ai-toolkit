import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../../scripts/build-registry.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
