import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/release.yml"), "utf8");

test("release workflow uses pinned Node 24 tooling with least privilege", () => {
  assert.match(workflow, /permissions:\n  contents: read\n/u);
  assert.match(workflow, /release:\n    permissions:\n      contents: write\n/u);
  assert.match(workflow, /node-version: 24/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /persist-credentials: false/u);
  for (const reference of workflow.matchAll(/uses:\s+([^\s]+)/gu)) {
    assert.match(reference[1], /@[a-f0-9]{40}$/u);
  }
});

test("release workflow validates the exact safe tag and committed registry", () => {
  assert.match(workflow, /RELEASE_TAG/u);
  assert.match(workflow, /package\.json/u);
  assert.match(workflow, /\^v/u);
  assert.match(workflow, /npm test/u);
  assert.match(workflow, /npm run validate/u);
  assert.match(workflow, /npm run registry:verify/u);
  assert.match(workflow, /npm run --silent build/u);
});

test("release workflow uploads only builder-validated archive arguments", () => {
  assert.doesNotMatch(workflow, /dist\/\*-v\*\.zip/u);
  assert.match(workflow, /steps\.artifacts\.outputs\.archives/u);
  assert.match(workflow, /mapfile -t archives/u);
  assert.match(workflow, /gh release create "\$RELEASE_TAG" "\$\{archives\[@\]\}" --generate-notes/u);
});
