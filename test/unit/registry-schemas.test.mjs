import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";

const DIGEST = "a".repeat(64);
const COMPONENT_TYPES = [
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
  "lsp",
  "output-style",
  "monitor",
  "theme",
  "channel",
  "executable",
  "settings",
  "asset",
  "app",
];

function schema(name) {
  return JSON.parse(readFileSync(
    new URL("../../registry/schemas/" + name, import.meta.url),
    "utf8",
  ));
}

function validators() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  return {
    agentPlugin: ajv.compile(schema("agent-plugin.schema.json")),
    lock: ajv.compile(schema("lock.schema.json")),
  };
}

function disposition(status = "preserved") {
  return {
    status,
    reasonCode: status === "preserved" ? "native-component" : "target-translation",
  };
}

function agentManifest() {
  const components = COMPONENT_TYPES.map((type) => {
    const id = type + "-fixture";
    return {
      id,
      type,
      path: "components/" + type + "/" + id,
      digest: DIGEST,
      targets: {
        claude: disposition(),
        codex: disposition("transformed"),
      },
    };
  });
  const componentMap = Object.fromEntries(components.map((component) => [
    component.id,
    component.targets.claude,
  ]));
  return {
    schemaVersion: 1,
    name: "fixture",
    distributionVersion: "1.0.0-gravit.1",
    components,
    targets: {
      claude: {
        path: "targets/claude",
        digest: DIGEST,
        components: componentMap,
      },
      codex: {
        path: "targets/codex",
        digest: DIGEST,
        components: Object.fromEntries(components.map((component) => [
          component.id,
          component.targets.codex,
        ])),
      },
    },
  };
}

function lockFile() {
  return {
    schemaVersion: 1,
    generatorDigest: DIGEST,
    plugins: {
      fixture: {
        name: "fixture",
        distributionVersion: "1.0.0-gravit.1",
        source: {
          type: "github",
          repo: "owner/repository",
          ref: "v1.0.0",
          sha: "0123456789abcdef0123456789abcdef01234567",
          root: ".",
        },
        generatorDigest: DIGEST,
        bundleDigest: DIGEST,
        components: [{
          id: "skill-fixture",
          type: "skill",
          digest: DIGEST,
          targets: {
            claude: disposition(),
            codex: disposition("transformed"),
          },
        }],
        targets: { claude: DIGEST, codex: DIGEST },
      },
    },
  };
}

test("agent plugin schema accepts all fourteen component types and full target accounting", () => {
  const { agentPlugin } = validators();
  const manifest = agentManifest();

  assert.equal(agentPlugin(manifest), true, JSON.stringify(agentPlugin.errors));
  assert.deepEqual(
    manifest.components.map(({ type }) => type),
    COMPONENT_TYPES,
  );
});

test("agent plugin schema rejects unsafe paths, invalid dispositions, and unknown map keys", () => {
  const { agentPlugin } = validators();
  const cases = [
    (manifest) => { manifest.components[0].path = "../outside"; },
    (manifest) => { manifest.components[0].path = "components//skill-fixture"; },
    (manifest) => { manifest.targets.claude.path = "targets/claude/"; },
    (manifest) => { manifest.components[0].digest = "short"; },
    (manifest) => {
      manifest.components[0].targets.claude = {
        status: "unsupported",
        reasonCode: "host-does-not-load-skills",
        path: "targets/claude/skills/skill-fixture",
      };
    },
    (manifest) => { manifest.components[0].targets.future = disposition(); },
    (manifest) => { manifest.targets.future = manifest.targets.claude; },
    (manifest) => { manifest.targets.claude.extra = true; },
    (manifest) => {
      manifest.components[0].targets = JSON.parse(
        '{"__proto__":{"status":"preserved","reasonCode":"native-component"}}',
      );
    },
  ];
  for (const mutate of cases) {
    const manifest = agentManifest();
    mutate(manifest);
    assert.equal(agentPlugin(manifest), false, JSON.stringify(manifest));
  }
});

test("lock schema compiles and accepts strict immutable provenance", () => {
  const { lock } = validators();
  const value = lockFile();

  assert.equal(lock(value), true, JSON.stringify(lock.errors));
});

test("lock schema rejects malformed sources, digests, names, and nested objects", () => {
  const { lock } = validators();
  const cases = [
    (value) => { value.extra = true; },
    (value) => { value.generatorDigest = "short"; },
    (value) => { value.plugins.fixture.source.sha = "a".repeat(39); },
    (value) => { value.plugins.fixture.source.repo = "./repository"; },
    (value) => { value.plugins.fixture.source.repo = "owner/.."; },
    (value) => {
      value.plugins.fixture.source = { type: "local", path: "../outside" };
    },
    (value) => { value.plugins.fixture.bundleDigest = "short"; },
    (value) => { value.plugins.fixture.components[0].digest = "short"; },
    (value) => { value.plugins.fixture.targets.claude = "short"; },
    (value) => { value.plugins.fixture.targets.future = DIGEST; },
    (value) => { value.plugins.fixture.components[0].targets.future = disposition(); },
    (value) => { value.plugins.fixture.components[0].extra = true; },
    (value) => {
      value.plugins = JSON.parse('{"constructor":' + JSON.stringify(value.plugins.fixture) + '}');
    },
  ];
  for (const mutate of cases) {
    const value = lockFile();
    mutate(value);
    assert.equal(lock(value), false, JSON.stringify(value));
  }
});
