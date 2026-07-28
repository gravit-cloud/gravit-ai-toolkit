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
import { copyComponent } from "../../scripts/lib/component-files.mjs";

function sandbox(context, prefix = "component-copy-") {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const bundleRoot = resolve(root, "bundle");
  const neutralRoot = resolve(bundleRoot, "components");
  mkdirSync(bundleRoot);
  return { root, bundleRoot, neutralRoot };
}

function pathComponent(sourcePath, overrides = {}) {
  return {
    id: "asset-fixture",
    type: "asset",
    sourceFormat: "path",
    sourcePath,
    ...overrides,
  };
}

test("copies regular files without changing their bytes or executable mode", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "helper");
  writeFileSync(source, Buffer.from([0x23, 0x21, 0x0a, 0x00, 0xff]));
  chmodSync(source, 0o751);

  const destination = copyComponent({
    component: pathComponent(source, { id: "executable-fixture", type: "executable" }),
    bundleRoot,
    neutralRoot,
  });

  assert.equal(destination, resolve(neutralRoot, "executable/executable-fixture"));
  assert.deepEqual(readFileSync(destination), Buffer.from([0x23, 0x21, 0x0a, 0x00, 0xff]));
  assert.equal(statSync(destination).mode & 0o777, 0o751);
});

test("copies directory trees with file contents and modes intact", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "assets");
  mkdirSync(resolve(source, "nested"), { recursive: true });
  writeFileSync(resolve(source, "icon.svg"), "<svg/>\n");
  writeFileSync(resolve(source, "nested/data.bin"), Buffer.from([0x01, 0x02]));
  chmodSync(resolve(source, "nested/data.bin"), 0o640);

  const destination = copyComponent({
    component: pathComponent(source),
    bundleRoot,
    neutralRoot,
  });

  assert.equal(readFileSync(resolve(destination, "icon.svg"), "utf8"), "<svg/>\n");
  assert.deepEqual(readFileSync(resolve(destination, "nested/data.bin")), Buffer.from([0x01, 0x02]));
  assert.equal(statSync(resolve(destination, "nested/data.bin")).mode & 0o777, 0o640);
});

test("writes inline components as deterministic stable JSON", (context) => {
  const first = sandbox(context, "component-inline-first-");
  const second = sandbox(context, "component-inline-second-");
  const component = {
    id: "app-fixture",
    type: "app",
    sourceFormat: "inline",
    inline: { z: 1, a: { y: true, b: false } },
  };

  const firstDestination = copyComponent({ ...first, component });
  const secondDestination = copyComponent({ ...second, component });
  const expected = '{\n  "a": {\n    "b": false,\n    "y": true\n  },\n  "z": 1\n}\n';

  assert.equal(readFileSync(resolve(firstDestination, "component.json"), "utf8"), expected);
  assert.deepEqual(
    readFileSync(resolve(firstDestination, "component.json")),
    readFileSync(resolve(secondDestination, "component.json")),
  );
});

test("rejects traversal and absolute component identities before any outside write", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const outside = resolve(root, "escaped");
  const source = resolve(root, "source.txt");
  writeFileSync(source, "source\n");
  for (const component of [
    pathComponent(source, { id: "../../escaped" }),
    pathComponent(source, { id: outside }),
    pathComponent(source, { type: "../asset" }),
    pathComponent(source, { type: "/asset" }),
  ]) {
    assert.throws(
      () => copyComponent({ component, bundleRoot, neutralRoot }),
      /component (?:id|type) must match \^\[a-z0-9\]/,
    );
  }
  assert.equal(existsSync(outside), false);
  assert.equal(existsSync(neutralRoot), false);
});

test("uses bundleRoot as both lexical and canonical containment boundary", (context) => {
  const { root, bundleRoot } = sandbox(context);
  const source = resolve(root, "source.txt");
  const outside = resolve(root, "outside");
  writeFileSync(source, "source\n");
  mkdirSync(outside);

  assert.throws(
    () => copyComponent({
      component: pathComponent(source),
      bundleRoot,
      neutralRoot: outside,
    }),
    /neutral root escapes bundle root/,
  );
  assert.equal(existsSync(resolve(outside, "asset/asset-fixture")), false);

  symlinkSync(outside, resolve(bundleRoot, "components"));
  assert.throws(
    () => copyComponent({
      component: pathComponent(source),
      bundleRoot,
      neutralRoot: resolve(bundleRoot, "components"),
    }),
    /symbolic links are not allowed in component destination/,
  );
  assert.equal(existsSync(resolve(outside, "asset/asset-fixture")), false);
});

test("rejects a destination parent symlink pivot without writing through it", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "source.txt");
  const outside = resolve(root, "outside");
  writeFileSync(source, "source\n");
  mkdirSync(neutralRoot, { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, resolve(neutralRoot, "asset"));

  assert.throws(
    () => copyComponent({ component: pathComponent(source), bundleRoot, neutralRoot }),
    /symbolic links are not allowed in component destination/,
  );
  assert.equal(existsSync(resolve(outside, "asset-fixture")), false);
});

test("rejects symbolic links at the source root and anywhere in a source tree", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const target = resolve(root, "target.txt");
  const sourceLink = resolve(root, "source-link");
  writeFileSync(target, "target\n");
  symlinkSync(target, sourceLink);
  assert.throws(
    () => copyComponent({
      component: pathComponent(sourceLink),
      bundleRoot,
      neutralRoot,
    }),
    /symbolic links are not allowed in component source/,
  );

  const sourceDirectory = resolve(root, "source-directory");
  mkdirSync(sourceDirectory);
  symlinkSync(target, resolve(sourceDirectory, "nested-link"));
  assert.throws(
    () => copyComponent({
      component: pathComponent(sourceDirectory),
      bundleRoot,
      neutralRoot,
    }),
    /symbolic links are not allowed in component source/,
  );
  assert.equal(existsSync(neutralRoot), false);
});

test("fails closed on malformed component records and JSON values", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "source.txt");
  writeFileSync(source, "source\n");
  const cyclic = {};
  cyclic.self = cyclic;
  const inherited = Object.create(pathComponent(source));
  const cases = [
    [null, /component must be a plain object/],
    [inherited, /component must be a plain object/],
    [{ id: "asset-fixture", type: "asset" }, /component must have own id, type, and sourceFormat properties/],
    [JSON.parse(
      '{"id":"asset-fixture","type":"asset","sourceFormat":"path","sourcePath":"ignored","prototype":true}',
    ), /prototype key is not allowed in component: prototype/],
    [pathComponent(source, { sourceFormat: "url" }), /sourceFormat must be path or inline/],
    [pathComponent(resolve(root, "missing")), /component source does not exist/],
    [{ id: "app-fixture", type: "app", sourceFormat: "inline" }, /inline component requires an own inline property/],
    [{ id: "app-fixture", type: "app", sourceFormat: "inline", inline: new Date(0) }, /inline component must contain only JSON values/],
    [{ id: "app-fixture", type: "app", sourceFormat: "inline", inline: { value: NaN } }, /inline component must contain only JSON values/],
    [{ id: "app-fixture", type: "app", sourceFormat: "inline", inline: cyclic }, /inline component must not be cyclic/],
    [{
      id: "app-fixture",
      type: "app",
      sourceFormat: "inline",
      inline: JSON.parse('{"__proto__":"unsafe"}'),
    }, /prototype key is not allowed in inline component: __proto__/],
  ];
  for (const [component, expected] of cases) {
    assert.throws(
      () => copyComponent({ component, bundleRoot, neutralRoot }),
      expected,
    );
  }
  for (const id of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () => copyComponent({
        component: pathComponent(source, { id }),
        bundleRoot,
        neutralRoot,
      }),
      new RegExp("prototype registry name is not allowed: " + id.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")),
    );
  }
  assert.equal(existsSync(neutralRoot), false);
});

test("rejects prototype keys on the copy input itself", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "source.txt");
  writeFileSync(source, "source\n");
  const input = JSON.parse(JSON.stringify({
    component: pathComponent(source),
    bundleRoot,
    neutralRoot,
  }));
  Object.defineProperty(input, "__proto__", {
    enumerable: true,
    value: {},
  });

  assert.throws(
    () => copyComponent(input),
    /prototype key is not allowed in copyComponent input: __proto__/,
  );
  assert.equal(existsSync(neutralRoot), false);
});

test("never overwrites or merges an existing destination", (context) => {
  const { root, bundleRoot, neutralRoot } = sandbox(context);
  const source = resolve(root, "source");
  mkdirSync(source);
  writeFileSync(resolve(source, "new.txt"), "new\n");
  const destination = resolve(neutralRoot, "asset/asset-fixture");
  mkdirSync(destination, { recursive: true });
  writeFileSync(resolve(destination, "existing.txt"), "keep\n");

  assert.throws(
    () => copyComponent({ component: pathComponent(source), bundleRoot, neutralRoot }),
    /component destination already exists/,
  );
  assert.equal(readFileSync(resolve(destination, "existing.txt"), "utf8"), "keep\n");
  assert.equal(existsSync(resolve(destination, "new.txt")), false);

  rmSync(destination, { recursive: true });
  symlinkSync(resolve(root, "outside-target"), destination);
  assert.throws(
    () => copyComponent({ component: pathComponent(source), bundleRoot, neutralRoot }),
    /component destination already exists/,
  );
  assert.equal(existsSync(resolve(root, "outside-target")), false);
});

test("rejects a bundle root that is not an existing real directory", (context) => {
  const { root } = sandbox(context);
  const source = resolve(root, "source.txt");
  const missingBundle = resolve(root, "missing-bundle");
  writeFileSync(source, "source\n");
  assert.throws(
    () => copyComponent({
      component: pathComponent(source),
      bundleRoot: missingBundle,
      neutralRoot: resolve(missingBundle, "components"),
    }),
    /bundle root must be an existing real directory/,
  );
  assert.equal(existsSync(missingBundle), false);

  const bundleFile = resolve(root, "bundle-file");
  writeFileSync(bundleFile, "not a directory\n");
  assert.throws(
    () => copyComponent({
      component: pathComponent(source),
      bundleRoot: bundleFile,
      neutralRoot: resolve(bundleFile, "components"),
    }),
    /bundle root must be an existing real directory/,
  );
});
