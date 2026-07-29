import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
import { readJson } from "../../scripts/lib/json.mjs";
import {
  completeFixturePlugin,
  completeFixtureRoot,
} from "../helpers/complete-fixture.mjs";

test("renders one Codex-format OpenClaw bundle with honest statuses", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "registry-openclaw-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const plugin = completeFixturePlugin({
    targets: ["openclaw"],
    adapterOptions: { openclaw: { bundleFormat: "codex" } },
    targetPolicies: {
      openclaw: {
        unsupported: {
          agent: "openclaw-detects-agents-only",
          hook: "openclaw-does-not-run-claude-hook-json",
          lsp: "codex-bundle-format-does-not-load-lsp",
          app: "openclaw-reports-app-bindings-only",
          "output-style": "openclaw-reports-output-styles-only",
          monitor: "openclaw-does-not-run-monitors",
          theme: "openclaw-does-not-load-themes",
          channel: "openclaw-does-not-load-channels",
          settings: "codex-bundle-format-does-not-load-settings",
        },
      },
    },
  });
  const manifest = buildPluginBundle({
    plugin,
    sourceRoot: completeFixtureRoot,
    bundleRoot: resolve(root, "complete"),
  });
  const target = resolve(root, "complete/targets/openclaw");
  assert.equal(existsSync(resolve(target, ".codex-plugin/plugin.json")), true);
  assert.equal(existsSync(resolve(target, "openclaw.plugin.json")), false);
  assert.equal(existsSync(resolve(target, ".mcp.json")), true);
  assert.equal(existsSync(resolve(target, "assets/icon.svg")), true);
  assert.equal(existsSync(resolve(target, "bin/helper")), true);
  assert.equal(existsSync(resolve(target, "skills/release/SKILL.md")), true);
  assert.deepEqual(readJson(resolve(target, ".mcp.json")), {
    mcp_servers: {
      fixture: {
        command: "npx",
        args: ["-y", "@fixture/mcp@1.2.3", "server", "start"],
        env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
      },
    },
  });
  assert.doesNotMatch(readFileSync(resolve(target, ".mcp.json"), "utf8"), /@latest/);
  assert.deepEqual(
    readFileSync(resolve(target, "bin/helper")),
    readFileSync(resolve(completeFixtureRoot, "bin/helper")),
  );
  assert.equal(statSync(resolve(target, "bin/helper")).mode & 0o777, 0o755);
  const unsupported = Object.fromEntries(manifest.components
    .filter((component) => component.targets.openclaw.status === "unsupported")
    .map((component) => [component.type, component.targets.openclaw.reasonCode]));
  assert.deepEqual(unsupported, {
    agent: "openclaw-detects-agents-only",
    hook: "openclaw-does-not-run-claude-hook-json",
    lsp: "codex-bundle-format-does-not-load-lsp",
    app: "openclaw-reports-app-bindings-only",
    "output-style": "openclaw-reports-output-styles-only",
    monitor: "openclaw-does-not-run-monitors",
    theme: "openclaw-does-not-load-themes",
    channel: "openclaw-does-not-load-channels",
    settings: "codex-bundle-format-does-not-load-settings",
  });
  const host = readJson(resolve(target, ".codex-plugin/plugin.json"));
  for (const field of [
    "agents", "hooks", "lspServers", "apps", "outputStyles", "channels", "settings", "experimental",
  ]) {
    assert.equal(Object.hasOwn(host, field), false, field);
  }
  for (const path of [
    "agents", "hooks", ".lsp.json", ".app.json", "output-styles", "monitors", "themes", "channels", "settings.json",
  ]) {
    assert.equal(existsSync(resolve(target, path)), false, path);
  }
  assert.equal(
    manifest.components.find(({ type }) => type === "agent").targets.openclaw.status,
    "unsupported",
  );
});
