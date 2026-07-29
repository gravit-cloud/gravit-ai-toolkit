import { mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { copyComponent } from "./component-files.mjs";
import { treeHash } from "./hash.mjs";
import { inventorySource } from "./inventory.mjs";
import { writeJson } from "./json.mjs";
import { compareCodePoints } from "./ordering.mjs";
import { assertRegistryName } from "./path-safety.mjs";
import { accountComponents } from "./provenance.mjs";
import { renderSkills } from "./skills.mjs";
import { renderClaudeTarget } from "./targets/claude.mjs";
import { renderCodexTarget } from "./targets/codex.mjs";

const TARGET_RENDERERS = {
  claude: renderClaudeTarget,
  codex: renderCodexTarget,
};

function relativeBundlePath(bundleRoot, path) {
  return relative(bundleRoot, path).replaceAll("\\", "/");
}

function cloneDisposition(disposition, path) {
  return {
    status: disposition.status,
    reasonCode: disposition.reasonCode,
    ...(path === undefined ? {} : { path }),
  };
}

export function buildPluginBundle({ plugin, sourceRoot, bundleRoot }) {
  const inventory = inventorySource({ sourceRoot });
  for (const skill of inventory.skills) assertRegistryName(skill.name, "skill name");

  const accounting = accountComponents({
    components: [
      ...inventory.skills.map((skill) => ({ id: skill.name, type: "skill" })),
      ...inventory.components,
    ],
    targets: plugin.targets,
    targetPolicies: plugin.targetPolicies || {},
  });
  const accountingById = new Map(accounting.map((component) => [component.id, component]));

  mkdirSync(bundleRoot, { recursive: true });
  const neutralRoot = resolve(bundleRoot, "components");
  const renderedSkills = renderSkills({
    skills: inventory.skills,
    destinationRoot: resolve(neutralRoot, "skills"),
    target: "neutral",
  });
  const materialized = renderedSkills.map((skill) => ({
    id: skill.name,
    type: "skill",
    directory: skill.directory,
  }));
  for (const component of inventory.components) {
    materialized.push({
      id: component.id,
      type: component.type,
      directory: copyComponent({ component, bundleRoot, neutralRoot }),
    });
  }

  const targetNames = [...plugin.targets].sort(compareCodePoints);
  const neutralComponents = materialized
    .map((component) => {
      const accounted = accountingById.get(component.id);
      if (!accounted) {
        throw new Error(
          plugin.name + ": neutral component missing accounting "
            + component.type + ":" + component.id,
        );
      }
      const targets = Object.fromEntries(targetNames.map((target) => {
        const targetPath = component.type === "skill"
          ? "targets/" + target + "/skills/" + component.id
          : undefined;
        return [target, cloneDisposition(accounted.targets[target], targetPath)];
      }));
      return {
        id: component.id,
        type: component.type,
        path: relativeBundlePath(bundleRoot, component.directory),
        digest: treeHash(component.directory),
        targets,
      };
    })
    .sort((left, right) => compareCodePoints(left.id, right.id));

  const targetResults = Object.fromEntries(targetNames.map((target) => [
    target,
    {
      path: "targets/" + target,
      components: Object.fromEntries(neutralComponents.map((component) => [
        component.id,
        cloneDisposition(component.targets[target], component.targets[target].path),
      ])),
    },
  ]));

  for (const target of targetNames) {
    TARGET_RENDERERS[target]({
      plugin,
      skills: inventory.skills,
      bundleRoot,
    });
  }

  for (const component of neutralComponents) {
    for (const target of plugin.targets) {
      if (!targetResults[target].components[component.id]) {
        throw new Error(
          plugin.name + ": unaccounted component " + component.type + ":" + component.id
            + " for " + target,
        );
      }
    }
  }
  for (const target of targetNames) {
    targetResults[target].digest = treeHash(resolve(bundleRoot, targetResults[target].path));
  }

  const manifest = {
    schemaVersion: 1,
    name: plugin.name,
    distributionVersion: plugin.distributionVersion,
    components: neutralComponents,
    targets: targetResults,
  };
  writeJson(resolve(bundleRoot, ".agent-plugin/plugin.json"), manifest);
  return manifest;
}
