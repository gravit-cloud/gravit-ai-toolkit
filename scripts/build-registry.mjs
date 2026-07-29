#!/usr/bin/env node
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  claimManagedRegistryPaths,
  promoteManagedPaths,
  withAtomicOutput,
} from "./lib/atomic-output.mjs";
import { buildPluginBundle } from "./lib/bundle-builder.mjs";
import {
  loadCatalog,
  resolveCatalogPath,
  resolveLocalCatalogSources,
} from "./lib/catalog.mjs";
import { treeHash } from "./lib/hash.mjs";
import { readJson, stableJson, writeJson } from "./lib/json.mjs";
import { compareCodePoints } from "./lib/ordering.mjs";
import {
  canonicalPath,
  pathIsInside,
  pathIsStrictlyInside,
  pathsOverlap,
} from "./lib/path-safety.mjs";
import { assertVersionChange, createLockEntry } from "./lib/provenance.mjs";
import { stageSource } from "./lib/source-loader.mjs";

const PRODUCTION_ROOT_NAMES = [".claude-plugin", ".agents", "plugins"];
const GENERATOR_ROOT = dirname(fileURLToPath(import.meta.url));
const CATEGORY = Object.freeze({
  cloud: "Cloud",
  development: "Development",
  productivity: "Productivity",
  seo: "Productivity",
});

function titleCase(value) {
  return value.split("-").map((part) => (
    part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)
  )).join(" ");
}

function createClaudeMarketplace(catalog) {
  return {
    name: catalog.name,
    owner: { name: "Gravit Cloud" },
    description: "Kuratierter Gravit-Cloud-Marketplace für Claude Code und Codex.",
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      source: "./plugins/" + plugin.name + "/targets/claude",
      category: plugin.category,
    })),
  };
}

function createCodexMarketplace(catalog) {
  return {
    name: catalog.name,
    interface: { displayName: titleCase(catalog.name) },
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      source: {
        source: "local",
        path: "./plugins/" + plugin.name + "/targets/codex",
      },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: CATEGORY[plugin.category],
    })),
  };
}

function assertSameNames(actual, expected, label) {
  if (
    actual.length !== expected.length
    || actual.some((name, index) => name !== expected[index])
  ) {
    throw new Error(label + " names do not match the production catalog");
  }
}

function validateStagedProduction({
  stageRoot,
  catalog,
  lock,
  builtPlugins,
  expectedClaudeMarketplace,
  expectedCodexMarketplace,
}) {
  const expectedNames = catalog.plugins.map(({ name }) => name);
  const builtByName = new Map(builtPlugins.map((plugin) => [plugin.name, plugin]));
  const pluginDirectories = readdirSync(resolve(stageRoot, "plugins"), {
    withFileTypes: true,
  });
  if (pluginDirectories.some((entry) => !entry.isDirectory() || entry.isSymbolicLink())) {
    throw new Error("staged plugins must contain only real plugin directories");
  }
  assertSameNames(
    pluginDirectories.map(({ name }) => name).sort(compareCodePoints),
    [...expectedNames].sort(compareCodePoints),
    "staged plugin",
  );

  for (const plugin of catalog.plugins) {
    const built = builtByName.get(plugin.name);
    if (!built) throw new Error(plugin.name + ": missing staged build result");
    const pluginRoot = resolve(stageRoot, "plugins", plugin.name);
    if (treeHash(pluginRoot) !== lock.plugins[plugin.name]?.bundleDigest) {
      throw new Error(plugin.name + ": staged plugin digest differs from registry lock");
    }
    const neutralManifest = readJson(resolve(pluginRoot, ".agent-plugin/plugin.json"));
    if (stableJson(neutralManifest) !== stableJson(built.manifest)) {
      throw new Error(plugin.name + ": staged neutral manifest differs from build result");
    }
    assertSameNames(
      neutralManifest.components.map(({ id }) => id),
      built.manifest.components.map(({ id }) => id),
      plugin.name + " staged component",
    );
    for (const target of plugin.targets) {
      const manifestPath = resolve(
        pluginRoot,
        "targets",
        target,
        "." + target + "-plugin/plugin.json",
      );
      const manifest = readJson(manifestPath);
      if (manifest.name !== plugin.name) {
        throw new Error(plugin.name + ": staged " + target + " manifest name mismatch");
      }
    }
  }

  const claudeMarketplace = readJson(resolve(stageRoot, ".claude-plugin/marketplace.json"));
  const codexMarketplace = readJson(resolve(stageRoot, ".agents/plugins/marketplace.json"));
  if (stableJson(claudeMarketplace) !== stableJson(expectedClaudeMarketplace)) {
    throw new Error("staged Claude marketplace differs from generated marketplace");
  }
  if (stableJson(codexMarketplace) !== stableJson(expectedCodexMarketplace)) {
    throw new Error("staged Codex marketplace differs from generated marketplace");
  }
  assertSameNames(
    claudeMarketplace.plugins.map(({ name }) => name),
    expectedNames,
    "Claude marketplace",
  );
  assertSameNames(
    codexMarketplace.plugins.map(({ name }) => name),
    expectedNames,
    "Codex marketplace",
  );
  for (const plugin of catalog.plugins) {
    const claude = claudeMarketplace.plugins.find(({ name }) => name === plugin.name);
    const codex = codexMarketplace.plugins.find(({ name }) => name === plugin.name);
    if (claude.source !== "./plugins/" + plugin.name + "/targets/claude") {
      throw new Error(plugin.name + ": invalid staged Claude marketplace path");
    }
    if (codex.source?.path !== "./plugins/" + plugin.name + "/targets/codex") {
      throw new Error(plugin.name + ": invalid staged Codex marketplace path");
    }
  }
  assertSameNames(
    Object.keys(lock.plugins).sort(compareCodePoints),
    [...expectedNames].sort(compareCodePoints),
    "registry lock",
  );
  const stagedLock = readJson(resolve(stageRoot, "registry/lock.json"));
  if (stableJson(stagedLock) !== stableJson(lock)) {
    throw new Error("staged registry lock differs from validated lock data");
  }
}

function previousLock(repositoryRoot) {
  const path = resolve(repositoryRoot, "registry/lock.json");
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const canonicalRepository = realpathSync(repositoryRoot);
  const expected = resolve(
    canonicalRepository,
    relative(resolve(repositoryRoot), path),
  );
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || canonicalPath(path) !== expected
  ) {
    throw new Error(
      "existing registry lock uses an unsafe symbolic path: " + path,
    );
  }
  const lock = JSON.parse(readFileSync(path, "utf8"));
  if (!lock || typeof lock !== "object" || Array.isArray(lock) || !lock.plugins) {
    throw new Error("existing registry lock is malformed");
  }
  return lock;
}

function buildBundles({
  catalog,
  repositoryRoot,
  stageRoot,
  fetchGitHub,
  generatorDigest,
}) {
  const sourceStage = resolve(stageRoot, ".sources");
  const builtPlugins = [];
  for (const plugin of catalog.plugins) {
    const sourceRoot = stageSource({
      plugin,
      repositoryRoot,
      destinationRoot: sourceStage,
      fetchGitHub,
    });
    const bundleRoot = resolve(stageRoot, "plugins", plugin.name);
    const manifest = buildPluginBundle({ plugin, sourceRoot, bundleRoot });
    const lockEntry = generatorDigest === undefined
      ? undefined
      : createLockEntry({
        plugin,
        source: plugin.source,
        bundleRoot,
        components: manifest.components.map(({ id, type, digest }) => ({
          id,
          type,
          digest,
        })),
        targets: manifest.targets,
        generatorDigest,
      });
    builtPlugins.push({ name: plugin.name, manifest, lockEntry });
  }
  rmSync(sourceStage, { recursive: true, force: true });
  return builtPlugins;
}

function directoryIdentity(path) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("temporary registry stage must be a real directory: " + path);
  }
  return { device: stats.dev, inode: stats.ino };
}

function removeOwnedStage(path, claim) {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== claim.device
    || stats.ino !== claim.inode
  ) {
    throw new Error("temporary registry stage ownership changed: " + path);
  }
  rmSync(path, { recursive: true, force: true });
}

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

  for (const name of PRODUCTION_ROOT_NAMES) {
    const lexicalProductionRoot = resolve(lexicalRepository, name);
    const canonicalProductionRoot = canonicalPath(lexicalProductionRoot);
    if (
      pathsOverlap(lexicalOutput, lexicalProductionRoot)
      || pathsOverlap(canonicalOutput, canonicalProductionRoot)
    ) {
      throw new Error(
        "unsafe registry output overlaps production root " + name + ": "
          + lexicalOutput,
      );
    }
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
  production = false,
  promote = promoteManagedPaths,
}) {
  const lexicalRepository = resolve(repositoryRoot);
  const catalog = loadCatalog({ repositoryRoot: lexicalRepository, catalogPath });
  const canonicalCatalogPath = resolveCatalogPath({
    repositoryRoot: lexicalRepository,
    catalogPath,
  });
  const localSources = resolveLocalCatalogSources({
    repositoryRoot: lexicalRepository,
    catalog,
  });
  let safeOutputRoot;
  let builtPlugins;

  if (production) {
    const repositoryStats = lstatSync(lexicalRepository);
    if (!repositoryStats.isDirectory() || repositoryStats.isSymbolicLink()) {
      throw new Error("production repository root must be a real directory");
    }
    if (
      resolve(outputRoot) !== lexicalRepository
      || realpathSync(resolve(outputRoot)) !== realpathSync(lexicalRepository)
    ) {
      throw new Error("production output must be the repository root");
    }
    safeOutputRoot = lexicalRepository;
    const existingLock = previousLock(lexicalRepository);
    const generatorDigest = treeHash(GENERATOR_ROOT);
    const stageRoot = mkdtempSync(resolve(
      dirname(lexicalRepository),
      "." + basename(lexicalRepository) + ".registry-stage-",
    ));
    const stageClaim = directoryIdentity(stageRoot);
    let activeError;
    try {
      builtPlugins = buildBundles({
        catalog,
        repositoryRoot: lexicalRepository,
        stageRoot,
        fetchGitHub,
        generatorDigest,
      });
      const lock = {
        schemaVersion: 1,
        generatorDigest,
        plugins: Object.fromEntries(builtPlugins.map(({ name, lockEntry }) => [
          name,
          lockEntry,
        ])),
      };
      for (const plugin of builtPlugins) {
        assertVersionChange({
          previousEntry: existingLock?.plugins?.[plugin.name],
          nextEntry: plugin.lockEntry,
        });
      }
      const claudeMarketplace = createClaudeMarketplace(catalog);
      const codexMarketplace = createCodexMarketplace(catalog);
      writeJson(
        resolve(stageRoot, ".claude-plugin/marketplace.json"),
        claudeMarketplace,
      );
      writeJson(
        resolve(stageRoot, ".agents/plugins/marketplace.json"),
        codexMarketplace,
      );
      writeJson(resolve(stageRoot, "registry/lock.json"), lock);
      const sourceClaims = claimManagedRegistryPaths(stageRoot);
      validateStagedProduction({
        stageRoot,
        catalog,
        lock,
        builtPlugins,
        expectedClaudeMarketplace: claudeMarketplace,
        expectedCodexMarketplace: codexMarketplace,
      });
      promote({
        repositoryRoot: lexicalRepository,
        stageRoot,
        sourceClaims,
        requireSourceClaims: true,
      });
    } catch (error) {
      activeError = error;
      throw error;
    } finally {
      const recoveryPaths = activeError && typeof activeError === "object"
        ? [
          activeError.recoveryPath,
          ...(Array.isArray(activeError.additionalRecoveryPaths)
            ? activeError.additionalRecoveryPaths
            : []),
        ].filter((path) => typeof path === "string")
        : [];
      const preserveStage = recoveryPaths.some((path) => (
        pathIsInside(stageRoot, path) || pathIsInside(path, stageRoot)
      ));
      if (!preserveStage) {
        try {
          removeOwnedStage(stageRoot, stageClaim);
        } catch (cleanupError) {
          if (!activeError) throw cleanupError;
          const error = new AggregateError(
            [activeError, cleanupError],
            "registry build failed and its owned stage could not be cleaned; recovery data remains at "
              + stageRoot,
          );
          error.recoveryPath = stageRoot;
          throw error;
        }
      }
    }
  } else {
    safeOutputRoot = assertSafeOutput({
      repositoryRoot: lexicalRepository,
      catalogPath,
      canonicalCatalogPath,
      outputRoot,
      localSources,
    });
    withAtomicOutput({
      finalRoot: safeOutputRoot,
      build(stageRoot) {
        builtPlugins = buildBundles({
          catalog,
          repositoryRoot: lexicalRepository,
          stageRoot,
          fetchGitHub,
        });
      },
    });
  }

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
