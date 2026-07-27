import {
  closeSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  statSync,
} from "node:fs";
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

function claimStage(stage) {
  let descriptor;
  try {
    descriptor = openSync(stage, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("plugin staging destination already exists: " + stage);
    }
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    return { device: stats.dev, inode: stats.ino };
  } finally {
    closeSync(descriptor);
  }
}

function stageIdentity(stage) {
  try {
    const stats = lstatSync(stage);
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

function withRecoveryPath(error, workspace) {
  if (error && typeof error === "object") {
    error.recoveryPath = workspace;
    return error;
  }
  const stagingError = new Error("source staging failed: " + String(error));
  stagingError.cause = error;
  stagingError.recoveryPath = workspace;
  return stagingError;
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
    case "local": {
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
      populateStage = (sourceStage) => cpSync(
        safeLocalSource,
        sourceStage,
        { recursive: true, dereference: false },
      );
      break;
    }
    case "github":
      assertGitHubSource(plugin.source);
      populateStage = (sourceStage) => fetchGitHub({
        repo: plugin.source.repo,
        sha: plugin.source.sha,
        destination: sourceStage,
        repositoryRoot,
      });
      break;
    default:
      throw new Error("unsupported plugin source type: " + plugin.source.type);
  }

  mkdirSync(destinationRoot, { recursive: true });
  const claim = claimStage(stage);
  const workspace = mkdtempSync(resolve(destinationRoot, "." + plugin.name + ".source-"));
  const sourceStage = resolve(workspace, "repository");
  try {
    populateStage(sourceStage);
    if (!sameStage(stageIdentity(stage), claim)) {
      throw new Error("plugin staging destination ownership changed: " + stage);
    }
    const safeStage = assertRealInside(
      workspace,
      sourceStage,
      "plugin staging destination",
    );
    const configuredRoot = assertInside(
      sourceStage,
      resolve(sourceStage, plugin.source.root || "."),
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
    throw withRecoveryPath(error, workspace);
  }
}
