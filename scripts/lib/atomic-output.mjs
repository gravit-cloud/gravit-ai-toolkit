import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function removeIfPresent(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export function withAtomicOutput({ finalRoot, build }) {
  const outputRoot = resolve(finalRoot);
  const parent = dirname(outputRoot);
  const name = basename(outputRoot);
  mkdirSync(parent, { recursive: true });

  const stage = mkdtempSync(resolve(parent, "." + name + ".stage-"));
  const backupRoot = mkdtempSync(resolve(parent, "." + name + ".backup-"));
  const backup = resolve(backupRoot, "previous");
  let keepBackupRoot = false;
  let activeError;

  try {
    build(stage);
    if (existsSync(outputRoot)) renameSync(outputRoot, backup);
    try {
      renameSync(stage, outputRoot);
    } catch (promotionError) {
      if (existsSync(backup)) {
        if (existsSync(outputRoot)) {
          keepBackupRoot = true;
        } else {
          try {
            renameSync(backup, outputRoot);
          } catch (rollbackError) {
            keepBackupRoot = true;
            throw new AggregateError(
              [promotionError, rollbackError],
              "could not promote atomic output or restore the previous output",
            );
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
    if (!keepBackupRoot) {
      try {
        removeIfPresent(backupRoot);
      } catch (cleanupError) {
        if (!activeError) throw cleanupError;
      }
    }
  }
}
