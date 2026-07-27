#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withAtomicOutput } from "./lib/atomic-output.mjs";
import { buildPluginBundle } from "./lib/bundle-builder.mjs";
import { loadCatalog } from "./lib/catalog.mjs";
import { stageSource } from "./lib/source-loader.mjs";

export function buildRegistry({
  repositoryRoot,
  catalogPath,
  outputRoot,
  fetchGitHub,
}) {
  const catalog = loadCatalog({ repositoryRoot, catalogPath });
  return withAtomicOutput({
    finalRoot: outputRoot,
    build(stage) {
      const sourceStage = resolve(stage, ".sources");
      for (const plugin of catalog.plugins) {
        const sourceRoot = stageSource({
          plugin,
          repositoryRoot,
          destinationRoot: sourceStage,
          fetchGitHub,
        });
        buildPluginBundle({
          plugin,
          sourceRoot,
          bundleRoot: resolve(stage, "plugins", plugin.name),
        });
      }
      rmSync(sourceStage, { recursive: true, force: true });
    },
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("missing required argument " + name);
  }
  return process.argv[index + 1];
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  buildRegistry({
    repositoryRoot,
    catalogPath: argument("--catalog"),
    outputRoot: resolve(argument("--output")),
  });
}
