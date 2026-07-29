import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { sha256 } from "./hash.mjs";
import { compareCodePoints } from "./ordering.mjs";
import {
  assertInside,
  canonicalPath,
  pathIsInside,
  pathsOverlap,
} from "./path-safety.mjs";

export const MANAGED_REGISTRY_PATHS = Object.freeze([
  "plugins",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  "registry/lock.json",
]);

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function identity(path) {
  const stats = lstatSync(path);
  return { device: stats.dev, inode: stats.ino };
}

function sameIdentity(path, expected) {
  if (!pathEntryExists(path)) return false;
  const actual = identity(path);
  return actual.device === expected.device && actual.inode === expected.inode;
}

function assertRealDirectory(path, label) {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(label + " must be a real directory: " + path);
  }
  return realpathSync(path);
}

function assertUnpivoted(root, candidate, label) {
  const lexicalRoot = resolve(root);
  const lexicalCandidate = assertInside(lexicalRoot, resolve(candidate), label);
  const canonicalRoot = realpathSync(lexicalRoot);
  const expected = resolve(canonicalRoot, relative(lexicalRoot, lexicalCandidate));
  const actual = canonicalPath(lexicalCandidate);
  if (actual !== expected || !pathIsInside(canonicalRoot, actual)) {
    throw new Error("unsafe symbolic path pivot for " + label + ": " + lexicalCandidate);
  }
  return lexicalCandidate;
}

function assertManagedArtifact(path, relativePath, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new Error("symbolic links are not allowed in " + label + ": " + relativePath);
  }
  const expectsFile = relativePath.endsWith(".json");
  if (expectsFile ? !stats.isFile() : !stats.isDirectory()) {
    throw new Error(
      label + " has wrong artifact type: " + relativePath,
    );
  }
}

function permissionMode(stats) {
  return stats.mode & 0o7777;
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function claimArtifact(path, label) {
  const entries = [];

  function visit(currentPath, relativePath) {
    const before = lstatSync(currentPath);
    if (before.isSymbolicLink()) {
      throw new Error(
        "symbolic links are not allowed in " + label + ": " + currentPath,
      );
    }

    const common = {
      relativePath,
      mode: permissionMode(before),
      device: before.dev,
      inode: before.ino,
    };
    if (before.isFile()) {
      const digest = sha256(readFileSync(currentPath));
      const after = lstatSync(currentPath);
      if (
        !after.isFile()
        || after.isSymbolicLink()
        || !sameStatIdentity(before, after)
        || permissionMode(after) !== common.mode
        || after.size !== before.size
      ) {
        throw new Error("artifact changed while claiming " + label + ": " + currentPath);
      }
      entries.push({ ...common, type: "file", digest });
      return;
    }
    if (!before.isDirectory()) {
      throw new Error("unsupported artifact entry in " + label + ": " + currentPath);
    }

    entries.push({ ...common, type: "directory" });
    const names = readdirSync(currentPath).sort(compareCodePoints);
    for (const name of names) {
      const childRelative = relativePath === "." ? name : relativePath + "/" + name;
      visit(resolve(currentPath, name), childRelative);
    }
    const afterNames = readdirSync(currentPath).sort(compareCodePoints);
    const after = lstatSync(currentPath);
    if (
      !after.isDirectory()
      || after.isSymbolicLink()
      || !sameStatIdentity(before, after)
      || permissionMode(after) !== common.mode
      || names.length !== afterNames.length
      || names.some((name, index) => name !== afterNames[index])
    ) {
      throw new Error("artifact changed while claiming " + label + ": " + currentPath);
    }
  }

  visit(path, ".");
  const deterministicSnapshot = JSON.stringify(entries.map((entry) => ({
    relativePath: entry.relativePath,
    type: entry.type,
    mode: entry.mode,
    ...(entry.digest ? { digest: entry.digest } : {}),
  })));
  return {
    identity: { device: entries[0].device, inode: entries[0].inode },
    entries,
    deterministicSnapshot,
  };
}

function assertArtifactClaim(path, expected, label) {
  if (!sameIdentity(path, expected.identity)) {
    throw new Error(label + " ownership changed: " + path);
  }
  const actual = claimArtifact(path, label);
  if (actual.deterministicSnapshot !== expected.deterministicSnapshot) {
    throw new Error(label + " content or metadata changed: " + path);
  }
  return actual;
}

function assertClaimedEntry(path, expected, label) {
  const stats = lstatSync(path);
  const actualType = stats.isSymbolicLink()
    ? "symbolic-link"
    : stats.isFile()
      ? "file"
      : stats.isDirectory()
        ? "directory"
        : "unsupported";
  if (
    actualType !== expected.type
    || stats.dev !== expected.device
    || stats.ino !== expected.inode
    || permissionMode(stats) !== expected.mode
  ) {
    throw new Error(label + " ownership or metadata changed: " + path);
  }
  if (expected.type === "file" && sha256(readFileSync(path)) !== expected.digest) {
    throw new Error(label + " content changed: " + path);
  }
}

function removeClaimedArtifact(path, claim, label) {
  assertArtifactClaim(path, claim, label);
  const entries = [...claim.entries].sort((left, right) => {
    const leftDepth = left.relativePath === "." ? 0 : left.relativePath.split("/").length;
    const rightDepth = right.relativePath === "." ? 0 : right.relativePath.split("/").length;
    if (leftDepth !== rightDepth) return rightDepth - leftDepth;
    return compareCodePoints(right.relativePath, left.relativePath);
  });
  for (const entry of entries) {
    const entryPath = entry.relativePath === "."
      ? path
      : resolve(path, ...entry.relativePath.split("/"));
    assertClaimedEntry(entryPath, entry, label);
    if (entry.type === "file") unlinkSync(entryPath);
    else rmdirSync(entryPath);
  }
}

function ensureManagedParent({ repositoryRoot, target, createdDirectories }) {
  const parent = dirname(target);
  const nested = relative(repositoryRoot, parent);
  if (nested === "") return;
  let current = repositoryRoot;
  for (const segment of nested.split(/[\\/]/)) {
    current = resolve(current, segment);
    if (pathEntryExists(current)) continue;
    mkdirSync(current);
    createdDirectories.push({ path: current, claim: identity(current) });
  }
}

function removeCreatedDirectories(createdDirectories, rollbackErrors) {
  for (const directory of [...createdDirectories].reverse()) {
    try {
      if (!sameIdentity(directory.path, directory.claim)) {
        if (pathEntryExists(directory.path)) {
          throw new Error(
            "created managed parent ownership changed: " + directory.path,
          );
        }
        continue;
      }
      const entries = readdirSync(directory.path);
      if (entries.length > 0) {
        throw new Error(
          "created managed parent contains unexpected entries: " + directory.path,
        );
      }
      rmdirSync(directory.path);
    } catch (error) {
      rollbackErrors.push(error);
    }
  }
}

function removeOwnedTransactionRoot({
  transactionRoot,
  transactionClaim,
  backupRoot,
  backupRootClaim,
}) {
  if (pathEntryExists(backupRoot)) {
    if (!sameIdentity(backupRoot, backupRootClaim)) {
      throw new Error("registry backup root ownership changed: " + backupRoot);
    }
    rmdirSync(backupRoot);
  }
  if (!sameIdentity(transactionRoot, transactionClaim)) {
    throw new Error("registry transaction root ownership changed: " + transactionRoot);
  }
  rmdirSync(transactionRoot);
}

function managedRecoveryPaths({ stageRoot, pending }) {
  const paths = [];
  if (pathEntryExists(stageRoot)) paths.push(stageRoot);
  for (const item of pending) {
    if (pathEntryExists(item.target)) paths.push(item.target);
  }
  return [...new Set(paths)];
}

export function promoteManagedPaths({
  repositoryRoot,
  stageRoot,
  rename = renameSync,
}, fileSystem = {}) {
  const beforeSourceValidation = fileSystem.beforeSourceValidation ?? (() => {});
  const lexicalRepository = resolve(repositoryRoot);
  const lexicalStage = resolve(stageRoot);
  const canonicalRepository = assertRealDirectory(
    lexicalRepository,
    "repository root",
  );
  const canonicalStage = assertRealDirectory(lexicalStage, "registry stage root");
  if (
    pathsOverlap(lexicalRepository, lexicalStage)
    || pathsOverlap(canonicalRepository, canonicalStage)
  ) {
    throw new Error("unsafe managed registry stage overlaps repository");
  }

  const pending = MANAGED_REGISTRY_PATHS.map((relativePath, index) => {
    const source = assertUnpivoted(
      lexicalStage,
      resolve(lexicalStage, relativePath),
      "staged artifact",
    );
    const target = assertUnpivoted(
      lexicalRepository,
      resolve(lexicalRepository, relativePath),
      "managed artifact",
    );
    if (!pathEntryExists(source)) {
      throw new Error("missing staged artifact: " + relativePath);
    }
    assertManagedArtifact(source, relativePath, "staged artifact");
    const sourceClaim = claimArtifact(source, "staged artifact " + relativePath);
    const hadTarget = pathEntryExists(target);
    let targetClaim;
    if (hadTarget) {
      assertManagedArtifact(target, relativePath, "managed artifact");
      targetClaim = claimArtifact(target, "managed artifact " + relativePath);
    }
    return {
      relativePath,
      source,
      target,
      index,
      hadTarget,
      sourceClaim,
      targetClaim,
      backupMoved: false,
      promoted: false,
    };
  });

  const transactionRoot = mkdtempSync(resolve(
    dirname(lexicalRepository),
    "." + basename(lexicalRepository) + ".promote-",
  ));
  const transactionClaim = identity(transactionRoot);
  const backupRoot = resolve(transactionRoot, "backup");
  mkdirSync(backupRoot);
  const backupRootClaim = identity(backupRoot);
  const createdDirectories = [];
  let publicationStarted = false;
  let stageRecoveryRequired = false;

  function assertCurrentSource(item, phase) {
    try {
      beforeSourceValidation({
        phase,
        relativePath: item.relativePath,
        source: item.source,
      });
      assertArtifactClaim(
        item.source,
        item.sourceClaim,
        "staged artifact " + item.relativePath,
      );
    } catch (error) {
      stageRecoveryRequired = true;
      throw error;
    }
  }

  try {
    for (const item of pending) {
      item.backup = assertInside(
        transactionRoot,
        resolve(backupRoot, String(item.index)),
        "managed backup",
      );
      ensureManagedParent({
        repositoryRoot: lexicalRepository,
        target: item.target,
        createdDirectories,
      });
      assertUnpivoted(lexicalRepository, item.target, "managed artifact");
      assertCurrentSource(item, "before-backup");
      if (item.hadTarget) {
        if (!sameIdentity(item.target, item.targetClaim.identity)) {
          throw new Error("managed artifact ownership changed: " + item.relativePath);
        }
        rename(item.target, item.backup);
        item.backupMoved = true;
      } else if (pathEntryExists(item.target)) {
        throw new Error("managed artifact appeared during promotion: " + item.relativePath);
      }
      assertCurrentSource(item, "before-publication");
      publicationStarted = true;
      rename(item.source, item.target);
      item.promoted = true;
    }

    for (const item of pending) {
      assertArtifactClaim(
        item.target,
        item.sourceClaim,
        "promoted artifact " + item.relativePath,
      );
      if (item.backupMoved) {
        assertArtifactClaim(
          item.backup,
          item.targetClaim,
          "managed backup " + item.relativePath,
        );
      }
    }
  } catch (promotionError) {
    const rollbackErrors = [];
    for (const item of [...pending].reverse()) {
      try {
        if (item.promoted) {
          if (!sameIdentity(item.target, item.sourceClaim.identity)) {
            throw new Error(
              "promoted artifact ownership changed: " + item.relativePath,
            );
          }
          if (pathEntryExists(item.source)) {
            throw new Error(
              "staged recovery path reappeared: " + item.relativePath,
            );
          }
          rename(item.target, item.source);
          item.promoted = false;
        }
        if (item.backupMoved) {
          if (pathEntryExists(item.target)) {
            throw new Error(
              "managed artifact blocks rollback: " + item.relativePath,
            );
          }
          assertArtifactClaim(
            item.backup,
            item.targetClaim,
            "managed backup " + item.relativePath,
          );
          rename(item.backup, item.target);
          item.backupMoved = false;
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    removeCreatedDirectories(createdDirectories, rollbackErrors);
    if (rollbackErrors.length > 0) {
      const error = new AggregateError(
        [promotionError, ...rollbackErrors],
        "registry promotion and rollback failed; backups remain at " + transactionRoot,
      );
      error.recoveryPath = transactionRoot;
      error.additionalRecoveryPaths = managedRecoveryPaths({
        stageRoot: lexicalStage,
        pending,
      });
      throw error;
    }
    try {
      removeOwnedTransactionRoot({
        transactionRoot,
        transactionClaim,
        backupRoot,
        backupRootClaim,
      });
    } catch (cleanupError) {
      const error = new AggregateError(
        [promotionError, cleanupError],
        "registry promotion rolled back but transaction cleanup failed; recovery data remains at "
          + transactionRoot,
      );
      error.recoveryPath = transactionRoot;
      error.additionalRecoveryPaths = [lexicalStage];
      throw error;
    }
    if (publicationStarted || stageRecoveryRequired) {
      const error = new AggregateError(
        [promotionError],
        "registry promotion failed and rolled back: " + promotionError.message
          + "; staged recovery data retained at " + lexicalStage,
      );
      error.recoveryPath = lexicalStage;
      throw error;
    }
    throw promotionError;
  }

  try {
    for (const item of pending) {
      if (!item.backupMoved) continue;
      removeClaimedArtifact(
        item.backup,
        item.targetClaim,
        "managed backup " + item.relativePath,
      );
      item.backupMoved = false;
    }
    removeOwnedTransactionRoot({
      transactionRoot,
      transactionClaim,
      backupRoot,
      backupRootClaim,
    });
  } catch (cleanupError) {
    const error = new AggregateError(
      [cleanupError],
      "registry promotion succeeded but backups remain at " + transactionRoot,
    );
    error.recoveryPath = transactionRoot;
    throw error;
  }
}

function removeIfPresent(path, remove = rmSync) {
  if (existsSync(path)) remove(path, { recursive: true, force: true });
}

function outputExistsError(outputRoot, cause) {
  const error = new Error("atomic output already exists: " + outputRoot, { cause });
  error.code = "EEXIST";
  return error;
}

function retainedAbsentOutputError({ promotionError, recoveryErrors, stage, outputRoot }) {
  const outputRetained = existsSync(outputRoot);
  const locations = outputRetained ? stage + " and " + outputRoot : stage;
  const error = new AggregateError(
    [promotionError, ...recoveryErrors],
    "could not promote absent-only atomic output; recovery data retained at " + locations,
  );
  error.recoveryPath = stage;
  if (outputRetained) error.additionalRecoveryPaths = [outputRoot];
  return error;
}

function promoteIntoReservedOutput({
  stage,
  outputRoot,
  makeDirectory,
  readDirectory,
  rename,
  removeDirectory,
}) {
  const entries = readDirectory(stage).sort(compareCodePoints);
  try {
    makeDirectory(outputRoot);
  } catch (error) {
    if (error.code === "EEXIST") throw outputExistsError(outputRoot, error);
    throw error;
  }

  const movedEntries = [];
  try {
    for (const entry of entries) {
      rename(resolve(stage, entry), resolve(outputRoot, entry));
      movedEntries.push(entry);
    }
    removeDirectory(stage);
  } catch (promotionError) {
    const hadPublicMoves = movedEntries.length > 0;
    const recoveryErrors = [];
    for (const entry of movedEntries.reverse()) {
      try {
        rename(resolve(outputRoot, entry), resolve(stage, entry));
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
    }

    let outputEntries;
    try {
      outputEntries = readDirectory(outputRoot).sort(compareCodePoints);
    } catch (inspectionError) {
      recoveryErrors.push(inspectionError);
    }

    if (outputEntries?.length === 0) {
      try {
        // This path was exclusively reserved above. A non-recursive removal
        // cannot delete content that appears between inspection and cleanup.
        removeDirectory(outputRoot);
      } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
    } else if (outputEntries) {
      recoveryErrors.push(new Error(
        "reserved atomic output contains unexpected entries: "
          + outputEntries.join(", "),
      ));
    }

    if (!hadPublicMoves && recoveryErrors.length === 0) throw promotionError;
    throw retainedAbsentOutputError({
      promotionError,
      recoveryErrors,
      stage,
      outputRoot,
    });
  }
}

export function withAtomicOutput({ finalRoot, build, replaceExisting = true }, fileSystem = {}) {
  const makeTemporaryDirectory = fileSystem.mkdtempSync ?? mkdtempSync;
  const makeDirectory = fileSystem.mkdirSync ?? mkdirSync;
  const readDirectory = fileSystem.readdirSync ?? readdirSync;
  const rename = fileSystem.renameSync ?? renameSync;
  const remove = fileSystem.rmSync ?? rmSync;
  const removeDirectory = fileSystem.rmdirSync ?? rmdirSync;
  const outputRoot = resolve(finalRoot);
  const parent = dirname(outputRoot);
  const name = basename(outputRoot);
  if (!replaceExisting && existsSync(outputRoot)) {
    throw outputExistsError(outputRoot);
  }
  mkdirSync(parent, { recursive: true });

  const stage = makeTemporaryDirectory(resolve(parent, "." + name + ".stage-"));
  let backupRoot;
  let backup;
  let keepBackupRoot = false;
  let activeError;

  try {
    if (replaceExisting) {
      backupRoot = makeTemporaryDirectory(resolve(parent, "." + name + ".backup-"));
      backup = resolve(backupRoot, "previous");
    }
    build(stage);
    if (!replaceExisting) {
      promoteIntoReservedOutput({
        stage,
        outputRoot,
        makeDirectory,
        readDirectory,
        rename,
        removeDirectory,
      });
      return;
    }
    if (existsSync(outputRoot)) rename(outputRoot, backup);
    try {
      rename(stage, outputRoot);
    } catch (promotionError) {
      if (backup && existsSync(backup)) {
        if (existsSync(outputRoot)) {
          keepBackupRoot = true;
          const collisionError = new Error(
            "atomic output path reappeared during promotion: " + outputRoot,
          );
          const recoveryError = new AggregateError(
            [promotionError, collisionError],
            "could not promote atomic output because the output path was recreated; "
              + "previous output retained at " + backup,
          );
          recoveryError.recoveryPath = backup;
          throw recoveryError;
        } else {
          try {
            rename(backup, outputRoot);
          } catch (rollbackError) {
            keepBackupRoot = true;
            const recoveryError = new AggregateError(
              [promotionError, rollbackError],
              "could not promote atomic output or restore the previous output; "
                + "previous output retained at " + backup,
            );
            recoveryError.recoveryPath = backup;
            throw recoveryError;
          }
        }
      }
      throw promotionError;
    }
  } catch (error) {
    activeError = error;
    throw error;
  } finally {
    const preserveStage = !replaceExisting
      && activeError
      && typeof activeError === "object"
      && typeof activeError.recoveryPath === "string"
      && resolve(activeError.recoveryPath) === stage;
    if (!preserveStage) {
      try {
        removeIfPresent(stage, remove);
      } catch (cleanupError) {
        if (!activeError) throw cleanupError;
        if (!replaceExisting && existsSync(stage)) {
          const recoveryError = new AggregateError(
            [activeError, cleanupError],
            "could not clean up absent-only atomic output; recovery data retained at " + stage,
          );
          recoveryError.recoveryPath = stage;
          throw recoveryError;
        }
      }
    }
    if (
      activeError
      && typeof activeError === "object"
      && typeof activeError.recoveryPath === "string"
      && pathIsInside(stage, activeError.recoveryPath)
      && !existsSync(activeError.recoveryPath)
    ) {
      delete activeError.recoveryPath;
    }
    if (backupRoot && !keepBackupRoot) {
      try {
        removeIfPresent(backupRoot, remove);
      } catch (cleanupError) {
        if (!activeError) throw cleanupError;
      }
    }
  }
}
