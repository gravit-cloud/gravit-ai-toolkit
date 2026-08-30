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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandSourceFiles,
  commandToSkill,
  copyComponent,
  materializeComponent,
} from "../../scripts/lib/component-files.mjs";

const completeFixtureRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/complete-plugin",
);

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

test("command-to-skill refuses an existing target skill name", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "command-skill-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "release"), { recursive: true });

  assert.throws(() => commandToSkill({
    component: {
      sourcePath: resolve(completeFixtureRoot, "commands/release.md"),
    },
    destinationRoot: root,
  }), /duplicate target skill name: release/);
});

test("command-to-skill preserves Markdown without executing its body", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "command-no-execution-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = resolve(root, "executed");
  const command = resolve(root, "safe.md");
  writeFileSync(
    command,
    "---\ndescription: Preserve only\n---\n\n# Safe\n\n$(touch " + marker + ")\n",
  );

  assert.equal(commandToSkill({
    component: { sourcePath: command },
    destinationRoot: resolve(root, "skills"),
  }), "safe");
  assert.equal(existsSync(marker), false);
  assert.match(
    readFileSync(resolve(root, "skills/safe/SKILL.md"), "utf8"),
    /# Safe\n\n\$\(touch /,
  );
});

test("command-to-skill rejects non-Markdown and invalid command filenames", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "command-invalid-name-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const nonMarkdown = resolve(root, "release.txt");
  const invalidName = resolve(root, "!!!.md");
  for (const path of [nonMarkdown, invalidName]) {
    writeFileSync(path, "---\ndescription: Invalid\n---\nBody\n");
  }

  assert.throws(
    () => commandToSkill({
      component: { sourcePath: nonMarkdown },
      destinationRoot: resolve(root, "skills"),
    }),
    /command source must be a Markdown file/,
  );
  assert.throws(
    () => commandToSkill({
      component: { sourcePath: invalidName },
      destinationRoot: resolve(root, "skills"),
    }),
    /command filename does not produce a valid skill name/,
  );
  assert.equal(existsSync(resolve(root, "skills")), false);
});

test("materializes path directories, path files, and inline records at exact destinations", (context) => {
  const { root, bundleRoot } = sandbox(context, "component-materialize-");
  const directory = resolve(root, "source-directory");
  mkdirSync(resolve(directory, "nested/empty"), { recursive: true });
  chmodSync(resolve(directory, "nested"), 0o750);
  chmodSync(resolve(directory, "nested/empty"), 0o710);
  writeFileSync(resolve(directory, "root.txt"), "root\n");
  writeFileSync(resolve(directory, "nested/data.bin"), Buffer.from([0x00, 0xff]));
  chmodSync(resolve(directory, "nested/data.bin"), 0o751);

  const directoryDestination = resolve(bundleRoot, "targets/claude/assets");
  assert.equal(materializeComponent({
    component: pathComponent(directory),
    bundleRoot,
    destination: directoryDestination,
  }), directoryDestination);
  assert.deepEqual(
    readFileSync(resolve(directoryDestination, "nested/data.bin")),
    Buffer.from([0x00, 0xff]),
  );
  assert.equal(statSync(resolve(directoryDestination, "nested/data.bin")).mode & 0o777, 0o751);
  assert.equal(statSync(resolve(directoryDestination, "nested")).mode & 0o777, 0o750);
  assert.equal(statSync(resolve(directoryDestination, "nested/empty")).mode & 0o777, 0o710);

  const file = resolve(root, "settings-source.json");
  writeFileSync(file, "{\"enabled\":true}\n");
  const fileDestination = resolve(bundleRoot, "targets/claude/settings.json");
  materializeComponent({
    component: pathComponent(file, { id: "settings-fixture", type: "settings" }),
    bundleRoot,
    destination: fileDestination,
  });
  assert.equal(readFileSync(fileDestination, "utf8"), "{\"enabled\":true}\n");

  const inlineDestination = resolve(bundleRoot, "targets/codex/.app.json");
  materializeComponent({
    component: {
      id: "app-inline",
      type: "app",
      sourceFormat: "inline",
      inline: { z: true, a: 1 },
    },
    bundleRoot,
    destination: inlineDestination,
  });
  assert.equal(readFileSync(inlineDestination, "utf8"), '{\n  "a": 1,\n  "z": true\n}\n');
});

test("materializeComponent rejects traversal, destination pivots, and overwrite", (context) => {
  const { root, bundleRoot } = sandbox(context, "component-render-safety-");
  const source = resolve(root, "source.txt");
  const outside = resolve(root, "outside.txt");
  writeFileSync(source, "source\n");
  assert.throws(() => materializeComponent({
    component: pathComponent(source),
    bundleRoot,
    destination: outside,
  }), /destination escapes bundle root/);

  const targetRoot = resolve(bundleRoot, "targets/claude");
  const outsideDirectory = resolve(root, "outside");
  mkdirSync(targetRoot, { recursive: true });
  mkdirSync(outsideDirectory);
  symlinkSync(outsideDirectory, resolve(targetRoot, "assets"));
  assert.throws(() => materializeComponent({
    component: pathComponent(source),
    bundleRoot,
    destination: resolve(targetRoot, "assets/icon.svg"),
  }), /symbolic links are not allowed in component destination/);
  assert.equal(existsSync(resolve(outsideDirectory, "icon.svg")), false);

  const destination = resolve(targetRoot, "settings.json");
  writeFileSync(destination, "keep\n");
  assert.throws(() => materializeComponent({
    component: pathComponent(source),
    bundleRoot,
    destination,
  }), /component destination already exists/);
  assert.equal(readFileSync(destination, "utf8"), "keep\n");
});

test("command directories expand every Markdown file in code-point order and fail closed", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "command-directory-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const commands = resolve(root, "commands");
  mkdirSync(resolve(commands, "nested"), { recursive: true });
  for (const path of ["z.md", "A.md", "nested/b.md"]) {
    writeFileSync(resolve(commands, path), "---\ndescription: Command\n---\nBody\n");
  }
  const component = pathComponent(commands, { id: "command-fixture", type: "command" });

  assert.deepEqual(
    commandSourceFiles(component).map((path) => path.slice(commands.length + 1)),
    ["A.md", "nested/b.md", "z.md"],
  );

  writeFileSync(resolve(commands, "README.txt"), "not a command\n");
  assert.throws(() => commandSourceFiles(component), /command directory contains a non-Markdown file/);
  rmSync(resolve(commands, "README.txt"));
  symlinkSync(resolve(commands, "z.md"), resolve(commands, "linked.md"));
  assert.throws(() => commandSourceFiles(component), /symbolic links are not allowed/);
});
