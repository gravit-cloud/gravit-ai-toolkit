import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

function numericVersion(version) {
  return version.replace(/^v/, "").split(/[.-]/, 3).map(Number);
}

function compareNumericVersion(left, right) {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function walkSkillEntrypoints(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walkSkillEntrypoints(path, result);
    else if (entry.isFile() && basename(path) === "SKILL.md") result.push(path);
  }
  return result;
}

test("generated Codex plugins expose only canonical top-level SKILL.md entrypoints", () => {
  const pluginsRoot = resolve(repositoryRoot, "plugins");
  const nestedEntrypoints = [];

  for (const plugin of readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const skillsRoot = resolve(pluginsRoot, plugin.name, "targets/codex/skills");
    for (const skillFile of walkSkillEntrypoints(skillsRoot)) {
      const path = relative(skillsRoot, skillFile).replaceAll("\\", "/");
      if (path.split("/").length !== 2) {
        nestedEntrypoints.push(`${plugin.name}/targets/codex/skills/${path}`);
      }
    }
  }

  assert.deepEqual(
    nestedEntrypoints.sort(),
    [],
    "nested SKILL.md files are recursively discovered by Codex",
  );
});

test("internal Azure phase instructions remain reachable as non-skill resources", () => {
  const skillRoot = resolve(repositoryRoot, "plugins/azure/targets/codex/skills/azure-app-onboard");
  const expectedHeadings = {
    deploy: "# Deploy — IaC Execution & Health Verification",
    prepare: "# Prepare — Architecture Planning & Cost Estimation",
    scaffold: "# Azure App Onboard Scaffold — IaC Generation + Self-Review",
  };

  for (const [phase, heading] of Object.entries(expectedHeadings)) {
    const resource = resolve(skillRoot, phase, "SKILL.resource.md");
    assert.equal(existsSync(resource), true, `${phase} instructions must be preserved`);
    assert.equal(readFileSync(resource, "utf8").includes(heading), true);
  }

  const staleReferences = [];
  for (const markdownFile of readdirSync(skillRoot, { recursive: true })
    .filter((path) => path.endsWith(".md"))) {
    const markdown = readFileSync(resolve(skillRoot, markdownFile), "utf8");
    if (/(?:deploy|prepare|scaffold)\/SKILL\.md/.test(markdown)) {
      staleReferences.push(markdownFile);
    }
  }
  assert.deepEqual(staleReferences, [], "phase references must follow renamed resources");

  const orchestrator = readFileSync(resolve(skillRoot, "SKILL.md"), "utf8");
  assert.match(orchestrator, /\[prepare\/SKILL\.resource\.md]/);
  assert.match(orchestrator, /\[scaffold\/SKILL\.resource\.md]/);
  assert.match(orchestrator, /\[deploy\/SKILL\.resource\.md]/);
});

test("the repackaged Azure bundle has a newer Codex cache identity", () => {
  const catalog = JSON.parse(readFileSync(
    resolve(repositoryRoot, "registry/catalog.json"),
    "utf8",
  ));
  const azureSourceVersion = catalog.plugins.find(
    (plugin) => plugin.name === "azure",
  ).source.ref;
  const azureManifest = JSON.parse(readFileSync(
    resolve(repositoryRoot, "plugins/azure/targets/codex/.codex-plugin/plugin.json"),
    "utf8",
  ));

  assert.equal(
    compareNumericVersion(azureManifest.version, azureSourceVersion) > 0,
    true,
    "changed bundle bytes must not reuse the upstream install version",
  );
  assert.match(azureManifest.version, /-gravit\.\d+$/);
});
