import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildPluginBundle } from "../../scripts/lib/bundle-builder.mjs";
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
  assert.equal(existsSync(resolve(target, "skills/release/SKILL.md")), true);
  assert.equal(
    manifest.components.find(({ type }) => type === "agent")
      .targets.openclaw.status,
    "unsupported",
  );
});
