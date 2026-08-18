import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { withAtomicOutput } from "./atomic-output.mjs";
import { copyComponent } from "./component-files.mjs";
import { canonicalLicenseSource } from "./external-license.mjs";
import { treeHash } from "./hash.mjs";
import { inventorySource } from "./inventory.mjs";
import { writeJson } from "./json.mjs";
import { compareCodePoints } from "./ordering.mjs";
import {
  assertRegistryName,
  canonicalPath,
  pathIsInside,
} from "./path-safety.mjs";
import { accountComponents } from "./provenance.mjs";
import { renderSkills } from "./skills.mjs";
import { renderClaudeTarget } from "./targets/claude.mjs";
import { renderCodexTarget } from "./targets/codex.mjs";

const TARGET_RENDERERS = {
  claude: renderClaudeTarget,
  codex: renderCodexTarget,
};
function materializeCanonicalLicense({ sourcePath, bundleRoot }) {
  if (!sourcePath) return;
  const bundleStats = lstatSync(bundleRoot);
  if (bundleStats.isSymbolicLink() || !bundleStats.isDirectory()) {
    throw new Error("bundle root must be a real directory: " + bundleRoot);
  }
  const canonicalBundleRoot = realpathSync(bundleRoot);
  const destination = resolve(bundleRoot, "LICENSE");
  const expectedCanonical = resolve(canonicalBundleRoot, "LICENSE");
  if (
    !pathIsInside(bundleRoot, destination)
    || !pathIsInside(canonicalBundleRoot, expectedCanonical)
    || canonicalPath(destination) !== expectedCanonical
    || existsSync(destination)
  ) {
    throw new Error("external license destination is unsafe: " + destination);
  }
  cpSync(sourcePath, destination, { errorOnExist: true, force: false });
  const destinationStats = lstatSync(destination);
  if (
    destinationStats.isSymbolicLink()
    || !destinationStats.isFile()
    || realpathSync(destination) !== expectedCanonical
  ) {
    throw new Error("external license destination is unsafe: " + destination);
  }
}

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

function assertAdapterResult({ plugin, target, bundleRoot, neutralComponents, result }) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(plugin.name + ": invalid " + target + " adapter result");
  }
  const targetRoot = resolve(bundleRoot, "targets", target);
  if (result.digest !== treeHash(targetRoot)) {
    throw new Error(plugin.name + ": stale " + target + " target digest");
  }
  if (!result.components || typeof result.components !== "object" || Array.isArray(result.components)) {
    throw new Error(plugin.name + ": invalid " + target + " component results");
  }
  const expectedIds = neutralComponents.map(({ id }) => id);
  const actualIds = Object.keys(result.components).sort(compareCodePoints);
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new Error(plugin.name + ": incomplete " + target + " component results");
  }

  const canonicalTargetRoot = realpathSync(targetRoot);
  const components = Object.fromEntries(neutralComponents.map((component) => {
    const expected = component.targets[target];
    const actual = result.components[component.id];
    if (
      !actual
      || typeof actual !== "object"
      || Array.isArray(actual)
      || actual.status !== expected.status
      || actual.reasonCode !== expected.reasonCode
    ) {
      throw new Error(
        plugin.name + ": incorrect adapter disposition for " + target + " " + component.id,
      );
    }
    const terminal = ["unsupported", "rejected"].includes(actual.status);
    if (terminal) {
      if (Object.hasOwn(actual, "path")) {
        throw new Error(
          plugin.name + ": " + actual.status + " component has target path " + component.id,
        );
      }
      return [component.id, cloneDisposition(actual)];
    }
    if (typeof actual.path !== "string" || actual.path.length === 0) {
      throw new Error(plugin.name + ": rendered component missing target path " + component.id);
    }
    const absolutePath = resolve(bundleRoot, actual.path);
    if (!pathIsInside(targetRoot, absolutePath) || !existsSync(absolutePath)) {
      throw new Error(plugin.name + ": target component path is not materialized " + component.id);
    }
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink() || !pathIsInside(canonicalTargetRoot, realpathSync(absolutePath))) {
      throw new Error(plugin.name + ": unsafe target component path " + component.id);
    }
    return [component.id, cloneDisposition(actual, actual.path)];
  }));
  return { digest: result.digest, components };
}

export function buildPluginBundle({ plugin, sourceRoot, bundleRoot }) {
  const canonicalLicense = canonicalLicenseSource({
    sourceType: plugin.source?.type,
    sourceRoot,
  });
  const inventory = inventorySource({
    sourceRoot,
    sourceType: plugin.source?.type,
    sourceContext: plugin.sourceContext,
    resources: plugin.resources,
  });
  for (const skill of inventory.skills) assertRegistryName(skill.id, "skill component id");

  const accounting = accountComponents({
    components: [
      ...inventory.skills.map((skill) => ({ id: skill.id, type: "skill" })),
      ...inventory.components,
    ],
    targets: plugin.targets,
    targetPolicies: plugin.targetPolicies || {},
  });
  const accountingById = new Map(accounting.map((component) => [component.id, component]));

  mkdirSync(bundleRoot, { recursive: true });
  materializeCanonicalLicense({ sourcePath: canonicalLicense, bundleRoot });
  const neutralRoot = resolve(bundleRoot, "components");
  const materialized = [];
  const resourceMappings = [];
  for (const component of inventory.components) {
    const directory = copyComponent({ component, bundleRoot, neutralRoot });
    materialized.push({
      id: component.id,
      type: component.type,
      directory,
    });
    if (
      component.sourceFormat === "path"
      && ["asset", "executable"].includes(component.type)
    ) {
      resourceMappings.push({
        sourcePath: component.sourcePath,
        destinationPath: directory,
      });
    }
  }
  const renderedSkills = renderSkills({
    skills: inventory.skills,
    destinationRoot: resolve(neutralRoot, "skills"),
    target: "neutral",
    resourceMappings,
  });
  materialized.push(...renderedSkills.map((skill) => ({
    id: skill.id,
    type: "skill",
    directory: skill.directory,
  })));

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
        return [target, cloneDisposition(accounted.targets[target])];
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

  let targetResults;
  withAtomicOutput({
    finalRoot: resolve(bundleRoot, "targets"),
    replaceExisting: false,
    build(stageRoot) {
      const stagedBundleRoot = resolve(stageRoot, ".bundle");
      mkdirSync(stagedBundleRoot);
      const stagedResults = {};
      for (const target of targetNames) {
        const rendered = TARGET_RENDERERS[target]({
          plugin,
          inventory,
          neutralComponents,
          bundleRoot: stagedBundleRoot,
        });
        const validated = assertAdapterResult({
          plugin,
          target,
          bundleRoot: stagedBundleRoot,
          neutralComponents,
          result: rendered,
        });
        stagedResults[target] = {
          path: "targets/" + target,
          digest: validated.digest,
          components: validated.components,
        };
      }
      for (const target of targetNames) {
        renameSync(
          resolve(stagedBundleRoot, "targets", target),
          resolve(stageRoot, target),
        );
      }
      rmSync(stagedBundleRoot, { recursive: true });
      targetResults = stagedResults;
    },
  });

  for (const component of neutralComponents) {
    for (const target of plugin.targets) {
      if (!targetResults[target].components[component.id]) {
        throw new Error(
          plugin.name + ": unaccounted component " + component.type + ":" + component.id
            + " for " + target,
        );
      }
      component.targets[target] = structuredClone(targetResults[target].components[component.id]);
    }
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
