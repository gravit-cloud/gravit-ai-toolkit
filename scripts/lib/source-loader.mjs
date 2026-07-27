import { cpSync, lstatSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { assertInside, assertRealInside } from "./path-safety.mjs";

function defaultFetchGitHub({ repo, sha, destination, repositoryRoot }) {
  const gigetCli = resolve(repositoryRoot, "node_modules/giget/dist/cli.mjs");
  const result = spawnSync(
    process.execPath,
    [gigetCli, "gh:" + repo + "#" + sha, destination, "--force"],
    { cwd: repositoryRoot, encoding: "utf8", stdio: "pipe" },
  );
  if (result.status !== 0) {
    throw new Error("giget failed: " + (result.stderr || result.stdout || "").trim());
  }
}

function stageIdentity(path) {
  try {
    const stats = lstatSync(path);
    return { device: stats.dev, inode: stats.ino };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameStage(left, right) {
  return Boolean(
    left
    && right
    && left.device === right.device
    && left.inode === right.inode,
  );
}

function claimStage(stage) {
  try {
    mkdirSync(stage);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("plugin staging destination already exists: " + stage);
    }
    throw error;
  }
  return stageIdentity(stage);
}

function removeClaimedStage(stage, claim, stagingError) {
  if (!sameStage(stageIdentity(stage), claim)) return;
  try {
    rmSync(stage, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError(
      [stagingError, cleanupError],
      "source staging failed and the partial stage could not be removed: " + stage,
    );
  }
}

function assertGitHubSource({ repo, sha }) {
  const parts = repo.split("/");
  if (
    parts.length !== 2
    || parts.some((part) => (
      !/^[A-Za-z0-9_.-]+$/.test(part)
      || part === "."
      || part === ".."
    ))
  ) {
    throw new Error(
      "GitHub source repository must be an owner/repository pair: " + repo,
    );
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error(
      "GitHub source SHA must be an exact 40-character lowercase commit: " + sha,
    );
  }
}

export function stageSource({
  plugin,
  repositoryRoot,
  destinationRoot,
  fetchGitHub = defaultFetchGitHub,
}) {
  const stage = assertInside(
    destinationRoot,
    resolve(destinationRoot, plugin.name),
    "plugin staging destination",
  );
  let populateStage;
  switch (plugin.source.type) {
    case "local":
      populateStage = () => {
        const localSource = assertInside(
          repositoryRoot,
          resolve(repositoryRoot, plugin.source.path),
          "local plugin source",
        );
        const safeLocalSource = assertRealInside(
          repositoryRoot,
          localSource,
          "local plugin source",
        );
        cpSync(safeLocalSource, stage, { recursive: true, dereference: false });
      };
      break;
    case "github":
      assertGitHubSource(plugin.source);
      populateStage = () => fetchGitHub({
        repo: plugin.source.repo,
        sha: plugin.source.sha,
        destination: stage,
        repositoryRoot,
      });
      break;
    default:
      throw new Error("unsupported plugin source type: " + plugin.source.type);
  }

  mkdirSync(destinationRoot, { recursive: true });
  const claim = claimStage(stage);
  try {
    populateStage();
    const safeStage = assertRealInside(
      destinationRoot,
      stage,
      "plugin staging destination",
    );
    if (!sameStage(stageIdentity(stage), claim)) {
      throw new Error("plugin staging destination ownership changed: " + stage);
    }
    const configuredRoot = assertInside(
      stage,
      resolve(stage, plugin.source.root || "."),
      "plugin source root",
    );
    const safeRoot = assertRealInside(
      safeStage,
      configuredRoot,
      "plugin source root",
    );
    if (!statSync(safeRoot).isDirectory()) {
      throw new Error("plugin source root must be a directory: " + configuredRoot);
    }
    return safeRoot;
  } catch (error) {
    removeClaimedStage(stage, claim, error);
    throw error;
  }
}
