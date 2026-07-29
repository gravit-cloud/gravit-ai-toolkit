import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  accountComponents,
  assertVersionChange,
  createLockEntry,
} from "../../scripts/lib/provenance.mjs";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function versionEntry(distributionVersion, bundleDigest) {
  return { distributionVersion, bundleDigest };
}

function completePolicies() {
  return {
    claude: { unsupported: { app: "host-does-not-load-apps" } },
    codex: { unsupported: { agent: "host-does-not-load-agents" } },
  };
}

function lockFixture(context) {
  const bundleRoot = mkdtempSync(resolve(tmpdir(), "registry-lock-"));
  context.after(() => rmSync(bundleRoot, { recursive: true, force: true }));
  mkdirSync(resolve(bundleRoot, "components"));
  writeFileSync(resolve(bundleRoot, "components/fixture.txt"), "fixture\n");
  return {
    bundleRoot,
    components: [
      { id: "skill-zeta", type: "skill", digest: DIGEST_C },
      { id: "asset-alpha", type: "asset", digest: DIGEST_A },
    ],
    generatorDigest: DIGEST_B,
    plugin: {
      name: "fixture",
      distributionVersion: "1.0.0-gravit.2",
      source: {
        type: "github",
        repo: "owner/repository",
        ref: "v1.0.0",
        sha: "0123456789abcdef0123456789abcdef01234567",
        root: ".",
      },
      targets: ["codex", "claude"],
    },
    source: {
      type: "github",
      repo: "owner/repository",
      ref: "v1.0.0",
      sha: "0123456789abcdef0123456789abcdef01234567",
      root: ".",
    },
    targets: {
      codex: {
        digest: DIGEST_C,
        components: {
          "skill-zeta": {
            status: "transformed",
            reasonCode: "target-translation",
            path: "targets/codex/skills/skill-zeta",
          },
          "asset-alpha": {
            status: "preserved",
            reasonCode: "native-component",
          },
        },
      },
      claude: {
        digest: DIGEST_A,
        components: {
          "skill-zeta": {
            status: "preserved",
            reasonCode: "native-component",
          },
          "asset-alpha": {
            status: "preserved",
            reasonCode: "native-component",
            path: "targets/claude/assets/asset-alpha",
          },
        },
      },
    },
  };
}

function localLockFixture(context) {
  const input = lockFixture(context);
  const source = { type: "local", path: "plugins/fixture", root: "source" };
  input.plugin.source = structuredClone(source);
  input.source = structuredClone(source);
  return input;
}

test("accounts for every component on every configured target without leaking render hints", () => {
  const input = {
    components: [
      { id: "skill-middle", type: "skill", sourcePath: "/not-copied" },
      { id: "app-zeta", type: "app", inline: { app: true } },
      { id: "agent-alpha", type: "agent", metadata: { source: "fixture" } },
    ],
    targets: ["codex", "claude"],
    targetPolicies: completePolicies(),
  };
  const before = structuredClone(input);

  const accounting = accountComponents(input);

  assert.deepEqual(accounting, [
    {
      id: "agent-alpha",
      type: "agent",
      targets: {
        claude: { status: "preserved", reasonCode: "native-component" },
        codex: {
          status: "unsupported",
          reasonCode: "host-does-not-load-agents",
        },
      },
    },
    {
      id: "app-zeta",
      type: "app",
      targets: {
        claude: {
          status: "unsupported",
          reasonCode: "host-does-not-load-apps",
        },
        codex: { status: "preserved", reasonCode: "native-component" },
      },
    },
    {
      id: "skill-middle",
      type: "skill",
      targets: {
        claude: { status: "preserved", reasonCode: "native-component" },
        codex: { status: "transformed", reasonCode: "target-translation" },
      },
    },
  ]);
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(accounting).includes("renderAs"), false);
});

test("accounting rejects duplicate or prototype-like IDs and invalid targets", () => {
  const base = {
    components: [{ id: "skill-fixture", type: "skill" }],
    targets: ["claude"],
    targetPolicies: {},
  };
  assert.throws(
    () => accountComponents({
      ...base,
      components: [...base.components, { id: "skill-fixture", type: "asset" }],
    }),
    /duplicate component id: skill-fixture/,
  );
  for (const id of ["__proto__", "constructor", "prototype"]) {
    assert.throws(
      () => accountComponents({
        ...base,
        components: [{ id, type: "skill" }],
      }),
      /prototype registry name is not allowed/,
    );
  }
  assert.throws(
    () => accountComponents({ ...base, targets: ["claude", "claude"] }),
    /duplicate target: claude/,
  );
  assert.throws(
    () => accountComponents({ ...base, targets: ["future-host"] }),
    /unknown target: future-host/,
  );
});

test("creates a deterministic deep-cloned lock entry with complete component provenance", (context) => {
  const input = lockFixture(context);
  const before = structuredClone(input);

  const entry = createLockEntry(input);

  assert.deepEqual(entry, {
    name: "fixture",
    distributionVersion: "1.0.0-gravit.2",
    source: {
      type: "github",
      repo: "owner/repository",
      ref: "v1.0.0",
      sha: "0123456789abcdef0123456789abcdef01234567",
      root: ".",
    },
    generatorDigest: DIGEST_B,
    bundleDigest: "f54ee2124b92a10f29f9fc09be796c8713ad543575502266a45a61e059e8f8eb",
    components: [
      {
        id: "asset-alpha",
        type: "asset",
        digest: DIGEST_A,
        targets: {
          claude: {
            status: "preserved",
            reasonCode: "native-component",
            path: "targets/claude/assets/asset-alpha",
          },
          codex: { status: "preserved", reasonCode: "native-component" },
        },
      },
      {
        id: "skill-zeta",
        type: "skill",
        digest: DIGEST_C,
        targets: {
          claude: { status: "preserved", reasonCode: "native-component" },
          codex: {
            status: "transformed",
            reasonCode: "target-translation",
            path: "targets/codex/skills/skill-zeta",
          },
        },
      },
    ],
    targets: { claude: DIGEST_A, codex: DIGEST_C },
  });
  assert.deepEqual(input, before);

  entry.source.ref = "mutated";
  entry.components[0].targets.claude.reasonCode = "mutated";
  assert.equal(input.source.ref, "v1.0.0");
  assert.equal(
    input.targets.claude.components["asset-alpha"].reasonCode,
    "native-component",
  );
});

test("lock creation rejects missing, duplicate, extra, or malformed accounting", (context) => {
  const cases = [
    [
      (input) => delete input.targets.codex.components["asset-alpha"],
      /unaccounted component asset:asset-alpha for codex/,
    ],
    [
      (input) => { input.components.push(structuredClone(input.components[0])); },
      /duplicate component id: skill-zeta/,
    ],
    [
      (input) => {
        input.targets.claude.components.unknown = {
          status: "preserved",
          reasonCode: "native-component",
        };
      },
      /unknown accounted component: unknown for claude/,
    ],
    [
      (input) => { input.targets.claude.digest = "not-a-digest"; },
      /target digest must be a SHA-256 digest/,
    ],
    [
      (input) => {
        input.targets.codex.components["asset-alpha"] = {
          status: "unsupported",
          reasonCode: "host-does-not-load-assets",
          path: "targets/codex/assets/asset-alpha",
        };
      },
      /unsupported disposition must not include path/,
    ],
    [
      (input) => {
        input.targets.codex.components["asset-alpha"] = {
          status: "preserved",
          reasonCode: "native-component",
          renderAs: "asset",
        };
      },
      /unknown disposition field: renderAs/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const input = lockFixture(context);
    mutate(input);
    assert.throws(() => createLockEntry(input), expected);
  }
});

test("lock creation validates sources, digests, paths, and prototype-safe maps", (context) => {
  const cases = [
    [
      (input) => { input.generatorDigest = "not-a-digest"; },
      /generatorDigest must be a SHA-256 digest/,
    ],
    [
      (input) => { input.components[0].digest = "not-a-digest"; },
      /component digest must be a SHA-256 digest/,
    ],
    [
      (input) => { input.source.sha = "a".repeat(39); },
      /GitHub source sha must be a full commit SHA/,
    ],
    [
      (input) => { input.source = { type: "local", path: "../outside" }; },
      /source path must be a safe relative path/,
    ],
    [
      (input) => {
        input.targets.codex.components["skill-zeta"].path = "../../outside";
      },
      /disposition path must be a safe relative path/,
    ],
    [
      (input) => {
        input.targets = JSON.parse('{"__proto__":{"digest":"' + DIGEST_A
          + '","components":{}}}');
      },
      /prototype key is not allowed in targets: __proto__/,
    ],
    [
      (input) => {
        input.targets.claude.components = JSON.parse(
          '{"constructor":{"status":"preserved","reasonCode":"native-component"}}',
        );
      },
      /prototype key is not allowed in target components: constructor/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const input = lockFixture(context);
    mutate(input);
    assert.throws(() => createLockEntry(input), expected);
  }
});

test("lock creation rejects every GitHub provenance mismatch without mutating input", (context) => {
  const cases = [
    ["type", (source) => {
      delete source.repo;
      delete source.ref;
      delete source.sha;
      delete source.root;
      source.type = "local";
      source.path = "plugins/fixture";
    }],
    ["repo", (source) => { source.repo = "other/repository"; }],
    ["ref", (source) => { source.ref = "v2.0.0"; }],
    ["sha", (source) => { source.sha = "f".repeat(40); }],
    ["root presence", (source) => { delete source.root; }],
    ["root value", (source) => { source.root = "nested"; }],
  ];
  for (const [field, mutate] of cases) {
    const input = lockFixture(context);
    mutate(input.source);
    const before = structuredClone(input);

    assert.throws(
      () => createLockEntry(input),
      new RegExp("plugin source must exactly match input source: " + field),
    );
    assert.deepEqual(input, before);
  }
});

test("lock creation rejects every local provenance mismatch without mutating input", (context) => {
  const cases = [
    ["type", (source) => {
      delete source.path;
      delete source.root;
      source.type = "github";
      source.repo = "owner/repository";
      source.ref = "v1.0.0";
      source.sha = "0123456789abcdef0123456789abcdef01234567";
    }],
    ["path", (source) => { source.path = "plugins/other"; }],
    ["root presence", (source) => { delete source.root; }],
    ["root value", (source) => { source.root = "nested"; }],
  ];
  for (const [field, mutate] of cases) {
    const input = localLockFixture(context);
    mutate(input.source);
    const before = structuredClone(input);

    assert.throws(
      () => createLockEntry(input),
      new RegExp("plugin source must exactly match input source: " + field),
    );
    assert.deepEqual(input, before);
  }
});

test("lock creation requires plugin provenance without mutating input", (context) => {
  const input = lockFixture(context);
  delete input.plugin.source;
  const before = structuredClone(input);

  assert.throws(() => createLockEntry(input), /plugin requires source/);
  assert.deepEqual(input, before);
});

test("lock creation requires configured targets to exactly match target results", (context) => {
  const missingResult = lockFixture(context);
  delete missingResult.targets.codex;
  assert.throws(
    () => createLockEntry(missingResult),
    /configured targets must match target results/,
  );

  const missingConfiguration = lockFixture(context);
  delete missingConfiguration.plugin.targets;
  assert.throws(
    () => createLockEntry(missingConfiguration),
    /plugin requires targets/,
  );

  const duplicateConfiguration = lockFixture(context);
  duplicateConfiguration.plugin.targets.push("claude");
  assert.throws(
    () => createLockEntry(duplicateConfiguration),
    /duplicate target: claude/,
  );

  const unknownPluginField = lockFixture(context);
  unknownPluginField.plugin.displayName = "not part of the catalog schema";
  assert.throws(
    () => createLockEntry(unknownPluginField),
    /unknown plugin field: displayName/,
  );
});

test("lock creation hashes only an existing real bundle directory", (context) => {
  const withFile = lockFixture(context);
  const bundleFile = resolve(withFile.bundleRoot, "bundle-file");
  writeFileSync(bundleFile, "not a bundle\n");
  withFile.bundleRoot = bundleFile;
  assert.throws(
    () => createLockEntry(withFile),
    /bundleRoot must be an existing real directory/,
  );

  const withLink = lockFixture(context);
  const bundleLink = resolve(withLink.bundleRoot, "bundle-link");
  symlinkSync(resolve(withLink.bundleRoot, "components"), bundleLink);
  withLink.bundleRoot = bundleLink;
  assert.throws(
    () => createLockEntry(withLink),
    /bundleRoot must be an existing real directory/,
  );
});

test("version changes require strictly greater SemVer precedence when bundle content changes", () => {
  const previousEntry = versionEntry("1.0.0-gravit.2", DIGEST_A);
  for (const nextVersion of [
    "1.0.0-gravit.2",
    "1.0.0-gravit.2+rebuilt",
    "1.0.0-gravit.1",
    "1.0.0-alpha",
  ]) {
    assert.throws(
      () => assertVersionChange({
        previousEntry,
        nextEntry: versionEntry(nextVersion, DIGEST_B),
      }),
      /bundle changed without distributionVersion bump/,
    );
  }
  for (const nextVersion of ["1.0.0-gravit.10", "1.0.0", "1.0.1-0"]) {
    assert.doesNotThrow(() => assertVersionChange({
      previousEntry,
      nextEntry: versionEntry(nextVersion, DIGEST_B),
    }));
  }
});

test("version checks allow unchanged content and reject malformed entries", () => {
  assert.doesNotThrow(() => assertVersionChange({
    previousEntry: versionEntry("2.0.0", DIGEST_A),
    nextEntry: versionEntry("1.0.0+metadata", DIGEST_A),
  }));
  assert.doesNotThrow(() => assertVersionChange({
    previousEntry: undefined,
    nextEntry: versionEntry("1.0.0", DIGEST_A),
  }));
  for (const [previousEntry, nextEntry] of [
    [versionEntry("1.0", DIGEST_A), versionEntry("1.0.1", DIGEST_B)],
    [versionEntry("1.0.0", "short"), versionEntry("1.0.1", DIGEST_B)],
    [versionEntry("1.0.0", DIGEST_A), versionEntry("1.0.01", DIGEST_B)],
    [versionEntry("1.0.0", DIGEST_A), { distributionVersion: "1.0.1" }],
    [null, versionEntry("1.0.0", DIGEST_A)],
  ]) {
    assert.throws(
      () => assertVersionChange({ previousEntry, nextEntry }),
      /version entry|distributionVersion|bundleDigest/,
    );
  }
});
