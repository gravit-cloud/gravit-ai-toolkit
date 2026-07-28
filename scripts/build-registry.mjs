#!/usr/bin/env node
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withAtomicOutput } from "./lib/atomic-output.mjs";
import { buildPluginBundle } from "./lib/bundle-builder.mjs";
import {
  loadCatalog,
  resolveCatalogPath,
  resolveLocalCatalogSources,
} from "./lib/catalog.mjs";
import {
  canonicalPath,
  pathIsInside,
  pathIsStrictlyInside,
  pathsOverlap,
} from "./lib/path-safety.mjs";
import { stageSource } from "./lib/source-loader.mjs";

function assertSafeOutput({
  repositoryRoot,
  catalogPath,
  canonicalCatalogPath,
  outputRoot,
  localSources,
}) {
  const lexicalRepository = resolve(repositoryRoot);
  const canonicalRepository = canonicalPath(lexicalRepository);
  const lexicalOutput = resolve(outputRoot);
  const canonicalOutput = canonicalPath(lexicalOutput);
  const lexicalFoundationRoot = resolve(lexicalRepository, ".tmp");
  const canonicalFoundationRoot = canonicalPath(lexicalFoundationRoot);
  const repositoryContainsOutput = (
    pathIsInside(lexicalRepository, lexicalOutput)
    || pathIsInside(canonicalRepository, canonicalOutput)
  );

  if (repositoryContainsOutput) {
    if (
      canonicalFoundationRoot !== resolve(canonicalRepository, ".tmp")
      || !pathIsStrictlyInside(lexicalFoundationRoot, lexicalOutput)
      || !pathIsStrictlyInside(canonicalFoundationRoot, canonicalOutput)
    ) {
      throw new Error(
        "unsafe registry output: repository outputs must stay below .tmp/: "
          + lexicalOutput,
      );
    }
  } else if (
    pathsOverlap(lexicalRepository, lexicalOutput)
    || pathsOverlap(canonicalRepository, canonicalOutput)
  ) {
    throw new Error("unsafe registry output overlaps repository: " + lexicalOutput);
  }

  const lexicalCatalog = resolve(lexicalRepository, catalogPath);
  if (
    pathsOverlap(lexicalOutput, lexicalCatalog)
    || pathsOverlap(canonicalOutput, canonicalCatalogPath)
  ) {
    throw new Error("unsafe registry output overlaps catalog: " + lexicalOutput);
  }

  for (const source of localSources) {
    const inputPaths = [
      [source.lexicalSourcePath, source.sourcePath],
      [source.lexicalSourceRoot, source.sourceRoot],
    ];
    for (const [lexicalInput, canonicalInput] of inputPaths) {
      if (
        pathsOverlap(lexicalOutput, lexicalInput)
        || pathsOverlap(canonicalOutput, canonicalInput)
      ) {
        throw new Error(
          "unsafe registry output overlaps local source for " + source.pluginName
            + ": " + lexicalOutput,
        );
      }
    }
  }

  return lexicalOutput;
}

export function buildRegistry({
  repositoryRoot,
  catalogPath,
  outputRoot,
  fetchGitHub,
}) {
  const catalog = loadCatalog({ repositoryRoot, catalogPath });
  const canonicalCatalogPath = resolveCatalogPath({ repositoryRoot, catalogPath });
  const localSources = resolveLocalCatalogSources({ repositoryRoot, catalog });
  const safeOutputRoot = assertSafeOutput({
    repositoryRoot,
    catalogPath,
    canonicalCatalogPath,
    outputRoot,
    localSources,
  });
  const builtPlugins = [];
  withAtomicOutput({
    finalRoot: safeOutputRoot,
    build(stage) {
      const sourceStage = resolve(stage, ".sources");
      for (const plugin of catalog.plugins) {
        const sourceRoot = stageSource({
          plugin,
          repositoryRoot,
          destinationRoot: sourceStage,
          fetchGitHub,
        });
        const manifest = buildPluginBundle({
          plugin,
          sourceRoot,
          bundleRoot: resolve(stage, "plugins", plugin.name),
        });
        builtPlugins.push({ name: plugin.name, manifest });
      }
      rmSync(sourceStage, { recursive: true, force: true });
    },
  });
  return {
    catalogName: catalog.name,
    outputRoot: safeOutputRoot,
    plugins: builtPlugins.map(({ name, manifest }) => ({
      name,
      bundleRoot: resolve(safeOutputRoot, "plugins", name),
      manifest,
    })),
  };
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
