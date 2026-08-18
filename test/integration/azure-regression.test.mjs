import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseFrontmatter } from "../../scripts/lib/frontmatter.mjs";
import { walkFiles } from "../../scripts/lib/path-safety.mjs";
import { validateRecursiveSkills } from "../../scripts/lib/validator.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const EXPECTED_AZURE_SKILLS = [
  "airunway-aks-setup",
  "appinsights-instrumentation",
  "azure-ai",
  "azure-aigateway",
  "azure-app-onboard",
  "azure-app-onboard-prereq",
  "azure-cloud-migrate",
  "azure-compliance",
  "azure-compute",
  "azure-cost",
  "azure-deploy",
  "azure-diagnostics",
  "azure-enterprise-infra-planner",
  "azure-kubernetes",
  "azure-kubernetes-automatic-readiness",
  "azure-kusto",
  "azure-messaging",
  "azure-prepare",
  "azure-quotas",
  "azure-reliability",
  "azure-resource-lookup",
  "azure-resource-visualizer",
  "azure-storage",
  "azure-upgrade",
  "azure-validate",
  "capacity",
  "customize",
  "deploy-model",
  "entra-agent-id",
  "entra-app-registration",
  "finetuning",
  "microsoft-foundry",
  "preset",
  "python-appservice-deploy",
];

function allowedComponentRoots(root, target) {
  const manifest = JSON.parse(readFileSync(resolve(root, ".agent-plugin/plugin.json")));
  return manifest.components
    .map((component) => component.targets[target])
    .filter((disposition) => ["preserved", "transformed"].includes(disposition.status))
    .map((disposition) => resolve(root, disposition.path));
}

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
    validateRecursiveSkills(resolve(root, "targets/codex/skills"), {
      target: "codex",
      projectionRoot: resolve(root, "targets/codex"),
      allowedComponentRoots: allowedComponentRoots(root, "codex"),
    }),
    [],
  );

  const skillsRoot = resolve(root, "targets/codex/skills");
  for (const phase of ["deploy", "prepare", "scaffold"]) {
    assert.match(
      readFileSync(
        resolve(skillsRoot, `azure-app-onboard/${phase}/SKILL.resource.md`),
        "utf8",
      ),
      new RegExp(`^# .*${phase}`, "im"),
    );
  }
  const appOnboardRoot = resolve(skillsRoot, "azure-app-onboard");
  for (const markdownPath of walkFiles(appOnboardRoot).filter((path) => path.endsWith(".md"))) {
    assert.doesNotMatch(
      readFileSync(markdownPath, "utf8"),
      /(?:deploy|prepare|scaffold)\/SKILL\.md/,
      markdownPath,
    );
  }
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
    assert.deepEqual([...names].sort(), EXPECTED_AZURE_SKILLS);
    assert.deepEqual(validateRecursiveSkills(skillsRoot, {
      target,
      projectionRoot: targetRoot,
      allowedComponentRoots: allowedComponentRoots(root, target),
    }), []);
  }
});
