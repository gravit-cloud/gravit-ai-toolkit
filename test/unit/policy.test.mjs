import test from "node:test";
import assert from "node:assert/strict";
import { targetDisposition } from "../../scripts/lib/policy.mjs";

const COMPONENT_ID = {
  skill: "skill-fixture",
  command: "command-fixture",
  agent: "agent-fixture",
  hook: "hook-fixture",
  mcp: "mcp-fixture",
  lsp: "lsp-fixture",
  "output-style": "output-style-fixture",
  monitor: "monitor-fixture",
  theme: "theme-fixture",
  channel: "channel-fixture",
  executable: "executable-fixture",
  settings: "settings-fixture",
  asset: "asset-fixture",
  app: "app-fixture",
};

const EXPECTED_SUPPORT = {
  claude: {
    skill: ["preserved", "skill", "native-component"],
    command: ["preserved", "command", "native-component"],
    agent: ["preserved", "agent", "native-component"],
    hook: ["transformed", "hook", "target-translation"],
    mcp: ["transformed", "mcp", "target-translation"],
    lsp: ["preserved", "lsp", "native-component"],
    "output-style": ["preserved", "output-style", "native-component"],
    monitor: ["preserved", "monitor", "native-component"],
    theme: ["preserved", "theme", "native-component"],
    channel: ["preserved", "channel", "native-component"],
    executable: ["preserved", "executable", "native-component"],
    settings: ["preserved", "settings", "native-component"],
    asset: ["preserved", "asset", "native-component"],
    app: undefined,
  },
  codex: {
    skill: ["transformed", "skill", "target-translation"],
    command: ["transformed", "skill", "command-to-skill"],
    agent: undefined,
    hook: ["transformed", "hook", "target-translation"],
    mcp: ["transformed", "mcp", "target-translation"],
    lsp: undefined,
    "output-style": undefined,
    monitor: undefined,
    theme: undefined,
    channel: undefined,
    executable: ["preserved", "executable", "native-component"],
    settings: undefined,
    asset: ["preserved", "asset", "native-component"],
    app: ["preserved", "app", "native-component"],
  },
};

function component(type) {
  return { id: COMPONENT_ID[type], type };
}

test("accounts for every inventory component type on both targets", () => {
  for (const [target, matrix] of Object.entries(EXPECTED_SUPPORT)) {
    const unsupported = Object.fromEntries(
      Object.entries(matrix)
        .filter(([, disposition]) => disposition === undefined)
        .map(([type]) => [type, "host-does-not-load-" + type]),
    );
    for (const [type, disposition] of Object.entries(matrix)) {
      const actual = targetDisposition({
        component: component(type),
        target,
        targetPolicies: { [target]: { unsupported } },
      });
      assert.deepEqual(
        actual,
        disposition === undefined
          ? {
              status: "unsupported",
              reasonCode: "host-does-not-load-" + type,
              renderAs: undefined,
            }
          : {
              status: disposition[0],
              reasonCode: disposition[2],
              renderAs: disposition[1],
            },
        target + " " + type,
      );
    }
  }
});

test("requires an explicit stable policy for actually unsupported components", () => {
  assert.throws(
    () => targetDisposition({
      component: component("agent"),
      target: "codex",
      targetPolicies: {},
    }),
    /missing unsupported policy for codex agent/,
  );
  assert.throws(
    () => targetDisposition({
      component: component("agent"),
      target: "codex",
      targetPolicies: {
        codex: { unsupported: { agent: "Host does not load agents" } },
      },
    }),
    /reason code must match \^\[a-z0-9\]/,
  );
});

test("rejects unsupported policy entries for supported components", () => {
  assert.throws(
    () => targetDisposition({
      component: component("skill"),
      target: "codex",
      targetPolicies: {
        codex: { unsupported: { skill: "host-does-not-load-skills" } },
      },
    }),
    /unsupported policy contradicts support matrix for codex skill/,
  );
});

test("fails closed for unknown targets and component types", () => {
  assert.throws(
    () => targetDisposition({
      component: component("skill"),
      target: "future-host",
      targetPolicies: {},
    }),
    /unknown target: future-host/,
  );
  assert.throws(
    () => targetDisposition({
      component: { id: "daemon-fixture", type: "daemon" },
      target: "codex",
      targetPolicies: {},
    }),
    /unknown component type: daemon/,
  );
});

test("requires plain objects, own fields, and registry-safe component identity", () => {
  for (const invalid of [null, [], "skill", Object.create({
    id: "skill-fixture",
    type: "skill",
  })]) {
    assert.throws(
      () => targetDisposition({ component: invalid, target: "codex", targetPolicies: {} }),
      /component must be a plain object|component must have own id and type properties/,
    );
  }
  for (const invalid of [
    { id: "../skill", type: "skill" },
    { id: "/skill", type: "skill" },
    { id: "skill-fixture", type: "output/style" },
  ]) {
    assert.throws(
      () => targetDisposition({ component: invalid, target: "codex", targetPolicies: {} }),
      /component (?:id|type) must match \^\[a-z0-9\]/,
    );
  }
  assert.throws(
    () => targetDisposition({ component: component("skill"), targetPolicies: {} }),
    /targetDisposition input requires target/,
  );
  assert.throws(
    () => targetDisposition(JSON.parse(
      '{"component":{"id":"skill-fixture","type":"skill"},"target":"codex","targetPolicies":{},"__proto__":{}}',
    )),
    /prototype key is not allowed: __proto__/,
  );
  assert.throws(
    () => targetDisposition({
      component: JSON.parse(
        '{"id":"skill-fixture","type":"skill","constructor":"unsafe"}',
      ),
      target: "codex",
      targetPolicies: {},
    }),
    /prototype key is not allowed: constructor/,
  );
});

test("rejects malformed policy objects, unknown keys, and prototype keys", () => {
  const inheritedUnsupported = Object.create({ unsupported: { agent: "inherited" } });
  const cases = [
    [null, /targetPolicies must be a plain object/],
    [[], /targetPolicies must be a plain object/],
    [{ codex: inheritedUnsupported }, /target policy for codex must be a plain object/],
    [{ codex: {} }, /target policy for codex requires unsupported/],
    [{ codex: { unsupported: [] } }, /unsupported policy for codex must be a plain object/],
    [{ future: { unsupported: {} } }, /unknown target policy: future/],
    [{ codex: { unsupported: {}, extra: true } }, /unknown target policy field: codex extra/],
    [{ codex: { unsupported: { daemon: "not-loaded" } } }, /unknown component type policy: codex daemon/],
    [JSON.parse('{"__proto__":{"unsupported":{}}}'), /prototype key is not allowed: __proto__/],
    [{ codex: { unsupported: JSON.parse('{"constructor":"not-loaded"}') } }, /prototype key is not allowed: constructor/],
  ];
  for (const [targetPolicies, expected] of cases) {
    assert.throws(
      () => targetDisposition({
        component: component("agent"),
        target: "codex",
        targetPolicies,
      }),
      expected,
    );
  }
});
