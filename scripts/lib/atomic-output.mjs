import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";
import { pathIsInside } from "./path-safety.mjs";

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

    if (recoveryErrors.length === 0) throw promotionError;
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
