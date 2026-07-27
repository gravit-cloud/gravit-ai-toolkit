import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function removeIfPresent(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function withAtomicOutput({ finalRoot, build }, fileSystem = {}) {
  const makeTemporaryDirectory = fileSystem.mkdtempSync ?? mkdtempSync;
  const rename = fileSystem.renameSync ?? renameSync;
  const outputRoot = resolve(finalRoot);
  const parent = dirname(outputRoot);
  const name = basename(outputRoot);
  mkdirSync(parent, { recursive: true });

  const stage = makeTemporaryDirectory(resolve(parent, "." + name + ".stage-"));
  let backupRoot;
  let backup;
  let keepBackupRoot = false;
  let activeError;

  try {
    backupRoot = makeTemporaryDirectory(resolve(parent, "." + name + ".backup-"));
    backup = resolve(backupRoot, "previous");
    build(stage);
    if (existsSync(outputRoot)) rename(outputRoot, backup);
    try {
      rename(stage, outputRoot);
    } catch (promotionError) {
      if (existsSync(backup)) {
        if (existsSync(outputRoot)) {
          keepBackupRoot = true;
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
    if (backupRoot && !keepBackupRoot) {
      try {
        removeIfPresent(backupRoot);
      } catch (cleanupError) {
        if (!activeError) throw cleanupError;
      }
    }
  }
}
