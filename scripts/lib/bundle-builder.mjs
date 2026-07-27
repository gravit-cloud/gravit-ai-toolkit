import { cpSync, mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { treeHash } from "./hash.mjs";
import { writeJson } from "./json.mjs";
import { assertInside, assertRegistryName } from "./path-safety.mjs";
import { discoverSkills } from "./skills.mjs";
import { renderClaudeTarget } from "./targets/claude.mjs";
import { renderCodexTarget } from "./targets/codex.mjs";

export function buildPluginBundle({ plugin, sourceRoot, bundleRoot }) {
  const skills = discoverSkills({ sourceRoot });
  for (const skill of skills) assertRegistryName(skill.name, "skill name");

  mkdirSync(bundleRoot, { recursive: true });
  const componentsRoot = resolve(bundleRoot, "components/skills");
  const components = skills
    .map((skill) => {
      const destination = assertInside(
        componentsRoot,
        resolve(componentsRoot, skill.name),
        "skill component destination",
      );
      cpSync(skill.sourceDirectory, destination, { recursive: true });
      return {
        id: skill.name,
        type: "skill",
        path: relative(bundleRoot, destination).replaceAll("\\", "/"),
        digest: treeHash(destination),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const targets = {};
  if (plugin.targets.includes("claude")) {
    targets.claude = renderClaudeTarget({ plugin, skills, bundleRoot });
  }
  if (plugin.targets.includes("codex")) {
    targets.codex = renderCodexTarget({ plugin, skills, bundleRoot });
  }

  const manifest = {
    schemaVersion: 1,
    name: plugin.name,
    distributionVersion: plugin.distributionVersion,
    components,
    targets,
  };
  writeJson(resolve(bundleRoot, ".agent-plugin/plugin.json"), manifest);
  return manifest;
}
