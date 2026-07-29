import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { validateRecursiveSkills } from "../../scripts/lib/validator.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Azure Codex bundle contains pinned MCP and unique skills", () => {
  const root = resolve(repositoryRoot, "plugins/azure");
  const manifest = JSON.parse(readFileSync(
    resolve(root, "targets/codex/.codex-plugin/plugin.json"),
  ));
  assert.equal(manifest.mcpServers, "./.mcp.json");
  const mcp = readFileSync(resolve(root, "targets/codex/.mcp.json"), "utf8");
  assert.match(mcp, /@azure\/mcp@2\.0\.5/);
  assert.doesNotMatch(mcp, /@latest/);
  assert.deepEqual(
    validateRecursiveSkills(resolve(root, "targets/codex/skills")),
    [],
  );
});

test("Azure target projections preserve exact runtime links and 34 unique public skills", () => {
  const root = resolve(repositoryRoot, "plugins/azure");
  for (const target of ["claude", "codex"]) {
    const targetRoot = resolve(root, `targets/${target}`);
    const hostManifest = JSON.parse(readFileSync(
      resolve(targetRoot, `.${target}-plugin/plugin.json`),
    ));
    assert.equal(hostManifest.skills, "./skills/");
    assert.equal(hostManifest.mcpServers, "./.mcp.json");
    assert.equal(hostManifest.hooks, "./hooks/hooks.json");

    const mcp = readFileSync(resolve(targetRoot, ".mcp.json"), "utf8");
    assert.match(mcp, /@azure\/mcp@2\.0\.5/);
    assert.doesNotMatch(mcp, /@latest/);
    const hooks = JSON.parse(readFileSync(resolve(targetRoot, "hooks/hooks.json")));
    const command = hooks.hooks.PostToolUse[0].hooks[0].command;
    const rootVariable = target === "claude" ? "CLAUDE_PLUGIN_ROOT" : "PLUGIN_ROOT";
    assert.equal(
      command,
      `bash "\${${rootVariable}}/hooks/scripts/track-telemetry.sh"`,
    );
    assert.equal(
      existsSync(resolve(targetRoot, "hooks/scripts/track-telemetry.sh")),
      true,
    );

    const skillsRoot = resolve(targetRoot, "skills");
    const names = readdirSync(skillsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseFrontmatter(readFileSync(
        resolve(skillsRoot, entry.name, "SKILL.md"),
        "utf8",
      ).replace(/^\uFEFF/u, "")).attributes.name);
    assert.equal(names.length, 34);
    assert.equal(new Set(names).size, 34);
    assert.deepEqual(validateRecursiveSkills(skillsRoot), []);
  }
});
