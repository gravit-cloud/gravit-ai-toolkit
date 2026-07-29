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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import { treeHash } from "../../scripts/lib/hash.mjs";

function sandbox(context) {
  const root = mkdtempSync(resolve(tmpdir(), "bundle-license-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = resolve(root, "source");
  mkdirSync(resolve(sourceRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(sourceRoot, "skills/fixture"), { recursive: true });
  writeFileSync(
    resolve(sourceRoot, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "license-fixture",
      version: "1.0.0",
      skills: "./skills/",
    }),
  );
  writeFileSync(
    resolve(sourceRoot, "skills/fixture/SKILL.md"),
    "---\nname: fixture\ndescription: License fixture\n---\n\n# Fixture\n",
  );
  return { root, sourceRoot, bundleRoot: resolve(root, "bundle") };
}

function plugin(sourceType = "github") {
  return {
    name: "license-fixture",
    description: "License fixture",
    category: "development",
    distributionVersion: "1.0.0-gravit.1",
    source: sourceType === "github"
      ? {
        type: "github",
        repo: "gravit-cloud/license-fixture",
        ref: "v1.0.0",
        sha: "a".repeat(40),
        root: ".",
      }
      : { type: "local", path: "sources/license-fixture", root: "." },
    targets: ["claude", "codex"],
    policies: { default: "transform-or-fail", skills: "transform" },
  };
}

test("external bundles preserve one canonical top-level license", (context) => {
  const { sourceRoot, bundleRoot } = sandbox(context);
  const sourceLicense = resolve(sourceRoot, "LiCeNsE.rSt");
  const bytes = Buffer.from([0x46, 0x69, 0x78, 0x74, 0x75, 0x72, 0x65, 0x0a]);
  writeFileSync(sourceLicense, bytes);
  chmodSync(sourceLicense, 0o640);

  const manifest = buildPluginBundle({
    plugin: plugin(),
    sourceRoot,
    bundleRoot,
  });

  assert.deepEqual(readFileSync(resolve(bundleRoot, "LICENSE")), bytes);
  assert.equal(statSync(resolve(bundleRoot, "LICENSE")).mode & 0o777, 0o640);
  assert.equal(
    manifest.components.some(({ id, type }) => id === "LICENSE" || type === "license"),
    false,
  );
});

test("external bundles fail before publication without exactly one license", (context) => {
  for (const licenseNames of [[], ["LICENSE", "LICENSE.md"]]) {
    const { sourceRoot, bundleRoot } = sandbox(context);
    for (const name of licenseNames) {
      writeFileSync(resolve(sourceRoot, name), name + "\n");
    }

    assert.throws(
      () => buildPluginBundle({ plugin: plugin(), sourceRoot, bundleRoot }),
      licenseNames.length === 0
        ? /external source must contain one top-level license/
        : /external source has ambiguous top-level licenses/,
    );
    assert.equal(existsSync(bundleRoot), false);
  }
});

test("external bundles reject a symbolic license without reading its target", (context) => {
  const { root, sourceRoot, bundleRoot } = sandbox(context);
  const outside = resolve(root, "outside-license");
  writeFileSync(outside, "outside secret\n");
  symlinkSync(outside, resolve(sourceRoot, "LICENSE"));

  assert.throws(
    () => buildPluginBundle({ plugin: plugin(), sourceRoot, bundleRoot }),
    /external license must be a real regular file/,
  );
  assert.equal(existsSync(bundleRoot), false);
});

test("local bundles do not invent a redistributed external license", (context) => {
  const { sourceRoot, bundleRoot } = sandbox(context);
  writeFileSync(resolve(sourceRoot, "LICENSE.txt"), "local source license\n");
  const localPlugin = plugin("local");
  localPlugin.sourceContext = [{
    path: "LICENSE.txt",
    digest: treeHash(resolve(sourceRoot, "LICENSE.txt")),
  }];

  buildPluginBundle({
    plugin: localPlugin,
    sourceRoot,
    bundleRoot,
  });

  assert.equal(existsSync(resolve(bundleRoot, "LICENSE")), false);
});
