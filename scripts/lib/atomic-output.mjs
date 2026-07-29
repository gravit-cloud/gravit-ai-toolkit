import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathIsInside } from "./path-safety.mjs";

function removeIfPresent(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function withAtomicOutput({ finalRoot, build, replaceExisting = true }, fileSystem = {}) {
  const makeTemporaryDirectory = fileSystem.mkdtempSync ?? mkdtempSync;
  const rename = fileSystem.renameSync ?? renameSync;
  const outputRoot = resolve(finalRoot);
  const parent = dirname(outputRoot);
  const name = basename(outputRoot);
  if (!replaceExisting && existsSync(outputRoot)) {
    throw new Error("atomic output already exists: " + outputRoot);
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
    // Absent-only callers recheck after the build. A concurrent non-empty
    // directory also makes the following directory rename fail without
    // clobbering it; preserve that promotion error because there is no backup.
    if (!replaceExisting && existsSync(outputRoot)) {
      throw new Error("atomic output already exists: " + outputRoot);
    }
    if (replaceExisting && existsSync(outputRoot)) rename(outputRoot, backup);
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
    try {
      removeIfPresent(stage);
    } catch (cleanupError) {
      if (!activeError) throw cleanupError;
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
        removeIfPresent(backupRoot);
      } catch (cleanupError) {
        if (!activeError) throw cleanupError;
      }
    }
  }
}
