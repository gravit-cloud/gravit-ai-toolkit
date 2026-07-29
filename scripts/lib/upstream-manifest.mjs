import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { readJson } from "./json.mjs";
import { assertInside, assertRealInside } from "./path-safety.mjs";

export const CLAUDE_COMPONENT_FIELDS = new Set([
  "skills",
  "commands",
  "agents",
  "hooks",
  "mcpServers",
  "lspServers",
  "outputStyles",
  "channels",
]);

export const CODEX_COMPONENT_FIELDS = new Set([
  "skills",
  "hooks",
  "mcpServers",
  "apps",
]);

function safeManifestPath(sourceRoot, relativePath) {
  const absoluteRoot = resolve(sourceRoot);
  const rootStats = lstatSync(absoluteRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error("source root must be a real directory: " + sourceRoot);
  }
  const manifestPath = assertInside(
    absoluteRoot,
    resolve(absoluteRoot, relativePath),
    "upstream manifest",
  );
  let stats;
  try {
    stats = lstatSync(manifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalManifest = assertRealInside(
    absoluteRoot,
    manifestPath,
    "upstream manifest",
  );
  if (canonicalManifest !== resolve(canonicalRoot, relativePath)) {
    throw new Error("symbolic links are not allowed in staged components: " + manifestPath);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("upstream manifest must be a regular file: " + manifestPath);
  }
  return manifestPath;
}

export function readUpstreamManifestEntries(sourceRoot) {
  const claudePath = safeManifestPath(sourceRoot, ".claude-plugin/plugin.json");
  const codexPath = safeManifestPath(sourceRoot, ".codex-plugin/plugin.json");
  return {
    claude: { path: claudePath, manifest: claudePath ? readJson(claudePath) : {} },
    codex: { path: codexPath, manifest: codexPath ? readJson(codexPath) : {} },
  };
}

export function readUpstreamManifests(sourceRoot) {
  const entries = readUpstreamManifestEntries(sourceRoot);
  return {
    claude: entries.claude.manifest,
    codex: entries.codex.manifest,
  };
}
