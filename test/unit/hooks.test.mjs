import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { normalizeHooks, renderHooks } from "../../scripts/lib/hooks.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");

function inlineRecord(inline) {
  return { sourceFormat: "inline", inline };
}

test("renders exact plugin-root references for each host", () => {
  const record = inventorySource({ sourceRoot: fixture }).components
    .find((component) => component.type === "hook");
  const config = normalizeHooks(record);

  assert.equal(
    renderHooks({ config, target: "claude" }).hooks.SessionStart[0].hooks[0].command,
    "node \"${CLAUDE_PLUGIN_ROOT}/bin/helper\"",
  );
  assert.equal(
    renderHooks({ config, target: "codex" }).hooks.SessionStart[0].hooks[0].command,
    "node \"${PLUGIN_ROOT}/bin/helper\"",
  );
});

test("normalizes direct event maps without dropping group or hook payloads", () => {
  const source = {
    SessionStart: [{
      matcher: "startup",
      timeout: 30,
      hooks: [
        {
          type: "command",
          command: "node ${PLUGIN_ROOT}/bin/helper",
          statusMessage: "Preparing fixture",
          unknownMetadata: { enabled: true, values: [1, "two", null] },
        },
        {
          type: "prompt",
          prompt: "Inspect the workspace",
          command: ["preserve", "non-command", "payload"],
        },
      ],
    }],
  };

  const normalized = normalizeHooks(inlineRecord(source));
  assert.deepEqual(normalized, { hooks: source });
  assert.notStrictEqual(normalized.hooks, source);
  assert.notStrictEqual(normalized.hooks.SessionStart[0], source.SessionStart[0]);
});

test("normalization and rendering return deterministic independent clones", () => {
  const source = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "bin/helper", timeout: 5 }] }],
    },
  };
  const config = normalizeHooks(inlineRecord(source));
  const before = structuredClone(config);
  const first = renderHooks({ config, target: "claude" });
  const second = renderHooks({ config, target: "claude" });

  assert.deepEqual(first, second);
  assert.notStrictEqual(first, second);
  first.hooks.SessionStart[0].hooks[0].timeout = 99;
  assert.deepEqual(config, before);
  assert.equal(second.hooks.SessionStart[0].hooks[0].timeout, 5);
});

test("translates only unescaped exact braced root references", () => {
  const command = [
    "echo",
    "${CLAUDE_PLUGIN_ROOT}",
    "${PLUGIN_ROOT}",
    "${CLAUDE_PLUGIN_ROOT_SUFFIX}",
    "${PLUGIN_ROOTED}",
    "$CLAUDE_PLUGIN_ROOT",
    "$PLUGIN_ROOT",
    "\\${CLAUDE_PLUGIN_ROOT}",
    "\\\\${PLUGIN_ROOT}",
  ].join(" ");
  const config = normalizeHooks(inlineRecord({
    SessionStart: [{ hooks: [{ type: "command", command }] }],
  }));

  assert.equal(
    renderHooks({ config, target: "claude" }).hooks.SessionStart[0].hooks[0].command,
    "echo ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_ROOT} ${CLAUDE_PLUGIN_ROOT_SUFFIX} " +
      "${PLUGIN_ROOTED} $CLAUDE_PLUGIN_ROOT $PLUGIN_ROOT \\${CLAUDE_PLUGIN_ROOT} " +
      "\\\\${CLAUDE_PLUGIN_ROOT}",
  );
  assert.equal(
    renderHooks({ config, target: "codex" }).hooks.SessionStart[0].hooks[0].command,
    "echo ${PLUGIN_ROOT} ${PLUGIN_ROOT} ${CLAUDE_PLUGIN_ROOT_SUFFIX} ${PLUGIN_ROOTED} " +
      "$CLAUDE_PLUGIN_ROOT $PLUGIN_ROOT \\${CLAUDE_PLUGIN_ROOT} \\\\${PLUGIN_ROOT}",
  );
});

test("rejects malformed hook records, wrappers, events, groups, and hook arrays", () => {
  const malformed = [
    [null, /hook record must be an object/],
    [[], /hook record must be an object/],
    [{}, /unsupported hook source format/],
    [{ sourceFormat: "other" }, /unsupported hook source format/],
    [{ sourceFormat: "inline" }, /inline hook record is missing inline/],
    [inlineRecord(null), /hook source must be an object/],
    [inlineRecord([]), /hook source must be an object/],
    [inlineRecord(3), /hook source must be an object/],
    [{ sourceFormat: "path" }, /path hook record is missing sourcePath/],
    [{ sourceFormat: "path", sourcePath: "" }, /path hook record is missing sourcePath/],
    [inlineRecord({ hooks: [] }), /hook event map must be an object/],
    [inlineRecord({ hooks: {}, metadata: true }), /hook wrapper must contain only hooks/],
    [inlineRecord({ SessionStart: {} }), /hook event must contain an array: SessionStart/],
    [inlineRecord({ SessionStart: [null] }), /hook group.*must be an object/],
    [inlineRecord({ SessionStart: [[]] }), /hook group.*must be an object/],
    [inlineRecord({ SessionStart: [{}] }), /hook group must define a hooks array: SessionStart/],
    [inlineRecord({ SessionStart: [{ hooks: null }] }), /hook group must define a hooks array: SessionStart/],
    [inlineRecord({ SessionStart: [{ hooks: {} }] }), /hook group must define a hooks array: SessionStart/],
    [inlineRecord({ SessionStart: [{ hooks: [null] }] }), /hook entry.*must be an object/],
    [inlineRecord({ SessionStart: [{ hooks: [[]] }] }), /hook entry.*must be an object/],
    [inlineRecord({ SessionStart: [{ hooks: [2] }] }), /hook entry.*must be an object/],
  ];

  for (const [record, expected] of malformed) {
    assert.throws(() => normalizeHooks(record), expected);
  }
});

test("rejects malformed command hook payloads but preserves non-command command fields", () => {
  for (const command of [undefined, null, "", "   ", 42, [], {}]) {
    const hook = { type: "command" };
    if (command !== undefined) hook.command = command;
    assert.throws(
      () => normalizeHooks(inlineRecord({ SessionStart: [{ hooks: [hook] }] })),
      /command hook requires a non-empty string command: SessionStart/,
    );
  }

  const payload = { type: "prompt", command: ["opaque", 42], extra: { keep: true } };
  assert.deepEqual(
    normalizeHooks(inlineRecord({ SessionStart: [{ hooks: [payload] }] }))
      .hooks.SessionStart[0].hooks[0],
    payload,
  );
});

test("rejects prototype-like keys and non-plain objects in trusted hook shapes", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const source = JSON.parse(`{"${key}":[]}`);
    assert.throws(() => normalizeHooks(inlineRecord(source)), /prototype-like hook key/);
  }

  const inheritedSource = Object.create({ SessionStart: [] });
  assert.throws(
    () => normalizeHooks(inlineRecord(inheritedSource)),
    /hook source must be a plain object/,
  );
  const inheritedGroup = Object.create({ hooks: [] });
  assert.throws(
    () => normalizeHooks(inlineRecord({ SessionStart: [inheritedGroup] })),
    /hook group.*must be a plain object/,
  );
  const inheritedHook = Object.create({ type: "prompt" });
  assert.throws(
    () => normalizeHooks(inlineRecord({ SessionStart: [{ hooks: [inheritedHook] }] })),
    /hook entry.*must be a plain object/,
  );
});

test("rejects absolute source paths in any command token or option value", () => {
  const commands = [
    "/tmp/run.sh",
    "node /tmp/run.mjs",
    "node \"/tmp/plugin helper.mjs\"",
    "node '/tmp/plugin helper.mjs'",
    "node --script=/tmp/run.mjs",
    "node C:\\checkout\\run.mjs",
    "node c:/checkout/run.mjs",
    "node D:checkout\\run.mjs",
    String.raw`node "\\server\share\run.mjs"`,
    String.raw`node \\?\C:\checkout\run.mjs`,
    String.raw`node \\.\C:\checkout\run.mjs`,
    String.raw`node \??\C:\checkout\run.mjs`,
    String.raw`node \Device\HarddiskVolume1\run.mjs`,
    String.raw`node \Global??\C:\checkout\run.mjs`,
    String.raw`node \DosDevices\C:\checkout\run.mjs`,
    "node file:///tmp/run.mjs",
    "node \"FILE:C:/checkout/run.mjs\"",
    "node x;/tmp/run.mjs",
    "node x&&/tmp/run.mjs",
    "node x||/tmp/run.mjs",
    "node x|/tmp/run.mjs",
    "node x&/tmp/run.mjs",
    "node x>/tmp/output.log",
    "node x</tmp/input.json",
    "node $(/tmp/run.mjs)",
    "node `/tmp/run.mjs`",
  ];

  for (const command of commands) {
    assert.throws(
      () => normalizeHooks(inlineRecord({
        SessionStart: [{ hooks: [{ type: "command", command }] }],
      })),
      /absolute hook command path/,
      command,
    );
  }
});

test("allows plugin-root paths, relative commands, flags, and HTTP URLs", () => {
  for (const command of [
    "node \"${CLAUDE_PLUGIN_ROOT}/bin/helper\"",
    "node '${PLUGIN_ROOT}/bin/helper'",
    "bin/helper --quiet",
    "node ./scripts/run.mjs --output=relative/path",
    "node scripts/run.mjs --endpoint=https://example.test/path?next=/tmp/file",
    "node scripts/run.mjs https://example.test/resource",
    "node scripts/run.mjs 'https://example.test/resource?next=/tmp/file'",
    "node 'literal;/tmp/run.mjs' \"literal&&/tmp/run.mjs\"",
    "node literal\\;/tmp/run.mjs literal\\|/tmp/run.mjs",
  ]) {
    assert.equal(
      normalizeHooks(inlineRecord({
        SessionStart: [{ hooks: [{ type: "command", command }] }],
      })).hooks.SessionStart[0].hooks[0].command,
      command,
    );
  }
});

test("rejects controls, null bytes, and malformed quoting in command hooks", () => {
  for (const command of [
    "node script.mjs\n/tmp/run.mjs",
    "node script.mjs\r/tmp/run.mjs",
    "node\tscript.mjs",
    "node \0script.mjs",
    "node \u001fscript.mjs",
    "node \u007fscript.mjs",
    "node \"unterminated",
    "node 'unterminated",
    "node trailing\\",
  ]) {
    assert.throws(
      () => normalizeHooks(inlineRecord({
        SessionStart: [{ hooks: [{ type: "command", command }] }],
      })),
      /invalid hook command syntax/,
      JSON.stringify(command),
    );
  }
});

test("normalizing a relative executable hook never runs it", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "hooks-never-run-"));
  const originalCwd = process.cwd();
  context.after(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  });
  const helper = resolve(root, "bin/helper");
  const sentinel = resolve(root, "hook-ran");
  mkdirSync(resolve(root, "bin"));
  writeFileSync(helper, "#!/bin/sh\nprintf ran > hook-ran\n", { mode: 0o755 });
  chmodSync(helper, 0o755);
  process.chdir(root);

  normalizeHooks(inlineRecord({
    SessionStart: [{ hooks: [{ type: "command", command: "bin/helper" }] }],
  }));

  assert.equal(existsSync(sentinel), false);
});

test("rendering rejects unsupported targets and malformed normalized configs", () => {
  const config = normalizeHooks(inlineRecord({ SessionStart: [{ hooks: [] }] }));
  assert.throws(() => renderHooks({ config, target: "openclaw" }), /unsupported hook target/);
  assert.throws(
    () => renderHooks({ config: { hooks: { SessionStart: {} } }, target: "claude" }),
    /hook event must contain an array: SessionStart/,
  );
});
