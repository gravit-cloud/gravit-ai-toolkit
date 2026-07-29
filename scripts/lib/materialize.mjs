import Ajv from "ajv/dist/2020.js";
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import {
  assertAtomicArtifactClaim,
  claimAtomicArtifact,
  withClaimedAtomicOutput,
} from "./atomic-output.mjs";
import { treeHash } from "./hash.mjs";
import { writeJson } from "./json.mjs";
import { materializationSource } from "./registry-reader.mjs";
import { canonicalPath, pathsOverlap } from "./path-safety.mjs";

const RECEIPT = ".gravit-plugin-receipt.json";
const TARGETS = new Set(["claude", "codex", "openclaw"]);
const receiptSchema = JSON.parse(readFileSync(
  new URL("../../registry/schemas/receipt.schema.json", import.meta.url),
  "utf8",
));
const validateReceiptSchema = new Ajv({ allErrors: true, strict: true })
  .compile(receiptSchema);

function pathEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeOutputPath(requestedPath) {
  if (typeof requestedPath !== "string" || requestedPath.length === 0) {
    throw new Error("materialization output must be a non-empty path");
  }
  const lexicalOutput = resolve(requestedPath);
  if (lexicalOutput === parse(lexicalOutput).root) {
    throw new Error("materialization output must not be a filesystem root");
  }
  const lexicalParent = dirname(lexicalOutput);
  const missing = [];
  let existingParent = lexicalParent;
  let parentStats = pathEntry(existingParent);
  while (!parentStats) {
    const next = dirname(existingParent);
    if (next === existingParent) throw new Error("materialization output has no existing parent");
    missing.unshift(basename(existingParent));
    existingParent = next;
    parentStats = pathEntry(existingParent);
  }
  if (parentStats.isSymbolicLink()) {
    throw new Error("symbolic output parent pivot is not allowed: " + existingParent);
  }
  if (!parentStats.isDirectory()) {
    throw new Error("materialization output parent must be a real directory: " + existingParent);
  }
  let canonicalParent = realpathSync(existingParent);
  for (const segment of missing) {
    const next = resolve(canonicalParent, segment);
    try {
      mkdirSync(next);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = lstatSync(next);
    if (stats.isSymbolicLink()) {
      throw new Error("symbolic output parent pivot is not allowed: " + next);
    }
    if (!stats.isDirectory() || realpathSync(next) !== next) {
      throw new Error("materialization output parent must be a real directory: " + next);
    }
    canonicalParent = next;
  }
  return resolve(canonicalParent, basename(lexicalOutput));
}

function readBoundReceipt(path) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("materialization ownership requires a real regular receipt: " + path);
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameIdentity(before, opened)) {
      throw new Error("materialization receipt ownership changed: " + path);
    }
    const value = JSON.parse(readFileSync(descriptor, "utf8"));
    const after = fstatSync(descriptor);
    const bound = lstatSync(path);
    if (
      !after.isFile()
      || !sameIdentity(opened, after)
      || opened.size !== after.size
      || !sameIdentity(after, bound)
      || bound.isSymbolicLink()
    ) {
      throw new Error("materialization receipt ownership changed: " + path);
    }
    return value;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateReceipt(receipt) {
  if (validateReceiptSchema(receipt)) return;
  const details = (validateReceiptSchema.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error("invalid materialization receipt: " + details);
}

function matchingReceipt(receipt, expected) {
  return receipt.registry === "gravit-cloud"
    && receipt.plugin === expected.plugin
    && receipt.target === expected.target;
}

function claimOwnedOutput(outputPath, expected) {
  const outputStats = pathEntry(outputPath);
  if (!outputStats) return undefined;
  if (outputStats.isSymbolicLink()) {
    throw new Error("symbolic output is not allowed: " + outputPath);
  }
  if (outputStats.isFile()) {
    throw new Error("materialization output must be a real directory: " + outputPath);
  }
  if (!outputStats.isDirectory()) {
    throw new Error("special output is not allowed: " + outputPath);
  }
  const receiptPath = resolve(outputPath, RECEIPT);
  if (!pathEntry(receiptPath)) return false;
  const receipt = readBoundReceipt(receiptPath);
  validateReceipt(receipt);
  if (!matchingReceipt(receipt, expected)) return false;
  const actualDigest = treeHash(outputPath, {
    exclude: [RECEIPT],
    includeModes: true,
  });
  if (actualDigest !== receipt.materializedDigest) {
    throw new Error("receipt payload digest mismatch: " + outputPath);
  }
  const claim = claimAtomicArtifact(outputPath, "receipt-owned materialization output");
  const confirmedReceipt = readBoundReceipt(receiptPath);
  validateReceipt(confirmedReceipt);
  if (
    !matchingReceipt(confirmedReceipt, expected)
    || JSON.stringify(confirmedReceipt) !== JSON.stringify(receipt)
    || treeHash(outputPath, { exclude: [RECEIPT], includeModes: true })
      !== confirmedReceipt.materializedDigest
  ) {
    throw new Error("materialization receipt ownership changed: " + receiptPath);
  }
  assertAtomicArtifactClaim(outputPath, claim, "receipt-owned materialization output");
  return claim;
}

export function materialize({
  reader,
  pluginName,
  target,
  outputPath: requestedOutputPath,
  registryRevision,
  copyDirectory = cpSync,
  atomicFileSystem = {},
}) {
  if (!TARGETS.has(target)) {
    throw new Error("unsupported materialization target: " + String(target));
  }
  if (typeof registryRevision !== "string" || !/^[a-f0-9]{40}$/u.test(registryRevision)) {
    throw new Error("invalid materialization receipt: registryRevision must be 40 lowercase hex characters");
  }
  if (typeof requestedOutputPath !== "string" || requestedOutputPath.length === 0) {
    throw new Error("materialization output must be a non-empty path");
  }
  const lexicalOutput = resolve(requestedOutputPath);
  if (lexicalOutput === parse(lexicalOutput).root) {
    throw new Error("materialization output must not be a filesystem root");
  }
  const verification = reader.verify(pluginName);
  const source = materializationSource(reader, pluginName, target);
  const prospectiveOutput = canonicalPath(lexicalOutput);
  if (
    pathsOverlap(prospectiveOutput, source.targetRoot)
    || pathsOverlap(prospectiveOutput, source.bundleRoot)
  ) {
    throw new Error("materialization output overlaps registry target source: " + prospectiveOutput);
  }
  const outputPath = safeOutputPath(lexicalOutput);
  const sourceTargetDigest = treeHash(source.targetRoot);
  if (sourceTargetDigest !== source.targetDigest) {
    throw new Error(pluginName + ": target digest mismatch: " + target);
  }
  if (!verification.ok) throw new Error(verification.errors.join("\n"));
  const sourceClaim = claimAtomicArtifact(
    source.targetRoot,
    pluginName + " source target " + target,
  );
  const existingClaim = claimOwnedOutput(outputPath, { plugin: pluginName, target });
  if (existingClaim === false) {
    throw new Error("refusing to replace unowned output: " + outputPath);
  }

  let receipt;
  withClaimedAtomicOutput({
    finalRoot: outputPath,
    existingClaim,
    stageMode: sourceClaim.entries[0].mode,
    build(stage) {
      assertAtomicArtifactClaim(
        source.targetRoot,
        sourceClaim,
        pluginName + " source target " + target,
      );
      copyDirectory(source.targetRoot, stage, {
        recursive: true,
        preserveTimestamps: false,
      });
      assertAtomicArtifactClaim(
        source.targetRoot,
        sourceClaim,
        pluginName + " source target " + target,
      );
    },
    finalize(stage) {
      const copiedDigest = treeHash(stage);
      if (copiedDigest !== sourceTargetDigest) {
        throw new Error(pluginName + ": copied target digest mismatch: " + target);
      }
      const copiedClaim = claimAtomicArtifact(stage, "copied materialization target");
      if (copiedClaim.deterministicSnapshot !== sourceClaim.deterministicSnapshot) {
        throw new Error(pluginName + ": copied target metadata mismatch: " + target);
      }
      const materializedDigest = treeHash(stage, { includeModes: true });
      receipt = {
        schemaVersion: 1,
        registry: "gravit-cloud",
        registryRevision,
        plugin: pluginName,
        target,
        distributionVersion: source.distributionVersion,
        sourceBundleDigest: source.bundleDigest,
        sourceTargetDigest,
        materializedDigest,
      };
      validateReceipt(receipt);
      writeJson(resolve(stage, RECEIPT), receipt);
    },
  }, atomicFileSystem);
  return receipt;
}
