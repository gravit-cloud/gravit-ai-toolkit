import Ajv from "ajv/dist/2020.js";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import {
  assertAtomicArtifactClaim,
  claimAtomicArtifact,
} from "./atomic-output.mjs";
import { sha256, treeHash } from "./hash.mjs";
import { stableJson } from "./json.mjs";
import {
  assertRegistryRevisionClaim,
  materializationSource,
} from "./registry-reader.mjs";
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

function permissionMode(stats) {
  return stats.mode & 0o7777;
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
  if (!pathEntry(lexicalParent)) {
    throw new Error("materialization immediate output parent must exist: " + lexicalParent);
  }
  const canonicalParent = realpathSync(lexicalParent);
  const parentStats = lstatSync(canonicalParent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error("materialization output parent must be a real directory: " + canonicalParent);
  }
  return {
    outputPath: resolve(canonicalParent, basename(lexicalOutput)),
    parentPath: canonicalParent,
    parentIdentity: { device: parentStats.dev, inode: parentStats.ino },
  };
}

function assertParentClaim(parentPath, expected) {
  const stats = lstatSync(parentPath);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== expected.device
    || stats.ino !== expected.inode
    || realpathSync(parentPath) !== parentPath
  ) {
    throw new Error("materialization output parent ownership changed: " + parentPath);
  }
}

function assertRootIdentity(path, expected, label) {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== expected.device
    || stats.ino !== expected.inode
  ) {
    throw new Error(label + " ownership changed: " + path);
  }
}

function claimCreatedDirectory(path, mode, label) {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(label + " must be a real directory: " + path);
  }
  if (permissionMode(before) !== mode) {
    throw new Error(label + " directory mode mismatch: " + path);
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_DIRECTORY ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || !sameIdentity(before, opened)) {
      throw new Error(label + " ownership changed: " + path);
    }
    const bound = lstatSync(path);
    if (
      !sameIdentity(opened, bound)
      || bound.isSymbolicLink()
      || !bound.isDirectory()
      || permissionMode(bound) !== mode
    ) {
      throw new Error(label + " ownership changed: " + path);
    }
    return { device: opened.dev, inode: opened.ino };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sourcePath(root, relativePath) {
  return relativePath === "."
    ? root
    : resolve(root, ...relativePath.split("/"));
}

function createExclusiveFile(sourceRoot, outputRoot, entry, assertDestinationParents) {
  const source = sourcePath(sourceRoot, entry.relativePath);
  const destination = sourcePath(outputRoot, entry.relativePath);
  const sourceBefore = lstatSync(source);
  if (
    sourceBefore.isSymbolicLink()
    || !sourceBefore.isFile()
    || sourceBefore.dev !== entry.device
    || sourceBefore.ino !== entry.inode
    || permissionMode(sourceBefore) !== entry.mode
  ) {
    throw new Error("materialization source file ownership changed: " + source);
  }

  let sourceDescriptor;
  let destinationDescriptor;
  try {
    sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceOpened = fstatSync(sourceDescriptor);
    if (!sourceOpened.isFile() || !sameIdentity(sourceBefore, sourceOpened)) {
      throw new Error("materialization source file ownership changed: " + source);
    }
    const bytes = readFileSync(sourceDescriptor);
    const sourceAfter = fstatSync(sourceDescriptor);
    if (
      !sameIdentity(sourceOpened, sourceAfter)
      || permissionMode(sourceAfter) !== entry.mode
      || sha256(bytes) !== entry.digest
    ) {
      throw new Error("materialization source file changed while copying: " + source);
    }

    assertDestinationParents(entry.relativePath);
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      entry.mode,
    );
    writeFileSync(destinationDescriptor, bytes);
    fchmodSync(destinationDescriptor, entry.mode);
    const destinationOpened = fstatSync(destinationDescriptor);
    const destinationBound = lstatSync(destination);
    if (
      !destinationOpened.isFile()
      || !sameIdentity(destinationOpened, destinationBound)
      || destinationBound.isSymbolicLink()
      || permissionMode(destinationOpened) !== entry.mode
    ) {
      throw new Error("materialization destination file ownership changed: " + destination);
    }
  } finally {
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
}

function copyClaimExclusively({
  sourceRoot,
  outputRoot,
  outputIdentity,
  sourceClaim,
  beforeEntryCreate,
  afterDirectoryCreate,
}) {
  const directoryIdentities = new Map([[".", outputIdentity]]);

  function assertDestinationParents(relativePath) {
    const segments = relativePath.split("/");
    segments.pop();
    let currentPath = outputRoot;
    let currentRelative = ".";
    assertRootIdentity(outputRoot, outputIdentity, "materialization output");
    for (const segment of segments) {
      currentPath = resolve(currentPath, segment);
      currentRelative = currentRelative === "."
        ? segment
        : currentRelative + "/" + segment;
      const expected = directoryIdentities.get(currentRelative);
      if (!expected) {
        throw new Error("materialization destination parent was not created: " + currentPath);
      }
      assertRootIdentity(
        currentPath,
        expected,
        "materialization destination directory",
      );
    }
  }

  for (const entry of sourceClaim.entries.slice(1)) {
    const destination = sourcePath(outputRoot, entry.relativePath);
    assertDestinationParents(entry.relativePath);
    beforeEntryCreate({
      outputPath: outputRoot,
      destination,
      relativePath: entry.relativePath,
      type: entry.type,
    });
    assertDestinationParents(entry.relativePath);
    if (entry.type === "directory") {
      mkdirSync(destination, { mode: entry.mode });
      const identity = claimCreatedDirectory(
        destination,
        entry.mode,
        "materialization destination directory",
      );
      afterDirectoryCreate({
        outputPath: outputRoot,
        destination,
        relativePath: entry.relativePath,
      });
      assertRootIdentity(
        destination,
        identity,
        "materialization destination directory",
      );
      directoryIdentities.set(entry.relativePath, identity);
    } else {
      createExclusiveFile(
        sourceRoot,
        outputRoot,
        entry,
        assertDestinationParents,
      );
    }
  }
}

function incompleteMaterialization(error, outputPath) {
  const retained = new AggregateError(
    [error],
    "materialization is incomplete; recovery data retained at " + outputPath
      + ": " + error.message,
  );
  retained.recoveryPath = outputPath;
  return retained;
}

function writeReceiptExclusive(path, receipt) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | constants.O_NOFOLLOW,
      0o644,
    );
    writeFileSync(descriptor, stableJson(receipt));
    fchmodSync(descriptor, 0o644);
    const opened = fstatSync(descriptor);
    const bound = lstatSync(path);
    if (
      !opened.isFile()
      || !sameIdentity(opened, bound)
      || bound.isSymbolicLink()
      || permissionMode(opened) !== 0o644
    ) {
      throw new Error("materialization receipt ownership changed: " + path);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function validateReceipt(receipt) {
  if (validateReceiptSchema(receipt)) {
    if (
      receipt.target === "universal"
      && (
        receipt.sourceTargetDigest !== receipt.sourceBundleDigest
        || receipt.materializedDigest !== receipt.sourceBundleDigest
      )
    ) {
      throw new Error(
        "invalid materialization receipt: universal receipt digests must equal sourceBundleDigest",
      );
    }
    return;
  }
  const details = (validateReceiptSchema.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error("invalid materialization receipt: " + details);
}

export function materialize({
  reader,
  pluginName,
  target,
  outputPath: requestedOutputPath,
  registryRevisionClaim,
  publicationHooks = {},
}) {
  if (!TARGETS.has(target)) {
    throw new Error("unsupported materialization target: " + String(target));
  }
  if (typeof requestedOutputPath !== "string" || requestedOutputPath.length === 0) {
    throw new Error("materialization output must be a non-empty path");
  }
  const lexicalOutput = resolve(requestedOutputPath);
  if (lexicalOutput === parse(lexicalOutput).root) {
    throw new Error("materialization output must not be a filesystem root");
  }

  const source = materializationSource(reader, pluginName, target);
  const registryRevision = assertRegistryRevisionClaim(
    reader,
    registryRevisionClaim,
    [pluginName],
  );
  const prospectiveOutput = canonicalPath(lexicalOutput);
  if (
    pathsOverlap(prospectiveOutput, source.targetRoot)
    || pathsOverlap(prospectiveOutput, source.bundleRoot)
  ) {
    throw new Error("materialization output overlaps registry target source: " + prospectiveOutput);
  }
  const {
    outputPath,
    parentPath,
    parentIdentity,
  } = safeOutputPath(requestedOutputPath);
  if (
    pathsOverlap(outputPath, source.targetRoot)
    || pathsOverlap(outputPath, source.bundleRoot)
  ) {
    throw new Error("materialization output overlaps registry target source: " + outputPath);
  }
  if (pathEntry(outputPath)) {
    throw new Error("materialization output already exists: " + outputPath);
  }
  if (pathEntry(resolve(source.targetRoot, RECEIPT))) {
    throw new Error("source target contains reserved receipt: " + source.targetRoot);
  }

  const sourceTargetDigest = treeHash(source.targetRoot);
  if (sourceTargetDigest !== source.targetDigest) {
    throw new Error(pluginName + ": target digest mismatch: " + target);
  }
  if (treeHash(source.bundleRoot) !== source.bundleDigest) {
    throw new Error(pluginName + ": bundle digest mismatch");
  }
  const bundleClaim = claimAtomicArtifact(
    source.bundleRoot,
    pluginName + " source bundle",
  );
  const sourceClaim = claimAtomicArtifact(
    source.targetRoot,
    pluginName + " source target " + target,
  );
  assertRegistryRevisionClaim(reader, registryRevisionClaim, [pluginName]);

  const beforeOutputCreate = publicationHooks.beforeOutputCreate ?? (() => {});
  const beforeOutputMkdir = publicationHooks.beforeOutputMkdir ?? (() => {});
  const afterOutputMkdir = publicationHooks.afterOutputMkdir ?? (() => {});
  const beforeEntryCreate = publicationHooks.beforeEntryCreate ?? (() => {});
  const afterDirectoryCreate = publicationHooks.afterDirectoryCreate ?? (() => {});
  const afterCopy = publicationHooks.afterCopy ?? (() => {});
  const beforeReceiptCreate = publicationHooks.beforeReceiptCreate ?? (() => {});
  const beforeReceiptOpen = publicationHooks.beforeReceiptOpen ?? (() => {});

  assertParentClaim(parentPath, parentIdentity);
  assertAtomicArtifactClaim(source.bundleRoot, bundleClaim, pluginName + " source bundle");
  assertAtomicArtifactClaim(
    source.targetRoot,
    sourceClaim,
    pluginName + " source target " + target,
  );
  beforeOutputCreate({ outputPath });
  assertParentClaim(parentPath, parentIdentity);
  if (pathEntry(outputPath)) {
    throw new Error("materialization output already exists: " + outputPath);
  }
  beforeOutputMkdir({ outputPath });

  try {
    mkdirSync(outputPath, { mode: sourceClaim.entries[0].mode });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("materialization output already exists: " + outputPath, { cause: error });
    }
    throw error;
  }

  try {
    const outputIdentity = claimCreatedDirectory(
      outputPath,
      sourceClaim.entries[0].mode,
      "materialization output",
    );
    afterOutputMkdir({ outputPath });
    assertRootIdentity(outputPath, outputIdentity, "materialization output");
    assertParentClaim(parentPath, parentIdentity);
    copyClaimExclusively({
      sourceRoot: source.targetRoot,
      outputRoot: outputPath,
      outputIdentity,
      sourceClaim,
      beforeEntryCreate,
      afterDirectoryCreate,
    });
    afterCopy({ outputPath, source });
    assertParentClaim(parentPath, parentIdentity);
    assertRootIdentity(outputPath, outputIdentity, "materialization output");
    assertAtomicArtifactClaim(source.bundleRoot, bundleClaim, pluginName + " source bundle");
    assertAtomicArtifactClaim(
      source.targetRoot,
      sourceClaim,
      pluginName + " source target " + target,
    );
    assertRegistryRevisionClaim(reader, registryRevisionClaim, [pluginName]);
    if (pathEntry(resolve(outputPath, RECEIPT))) {
      throw new Error("materialization output contains reserved receipt: " + outputPath);
    }
    const copiedDigest = treeHash(outputPath);
    if (copiedDigest !== sourceTargetDigest) {
      throw new Error(pluginName + ": copied target digest mismatch: " + target);
    }
    const copiedClaim = claimAtomicArtifact(outputPath, "copied materialization target");
    if (copiedClaim.deterministicSnapshot !== sourceClaim.deterministicSnapshot) {
      throw new Error(pluginName + ": copied target metadata mismatch: " + target);
    }
    const materializedDigest = treeHash(outputPath, { includeModes: true });
    const receipt = {
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

    const receiptPath = resolve(outputPath, RECEIPT);
    beforeReceiptCreate({ outputPath, receipt });
    if (pathEntry(receiptPath)) {
      throw new Error("materialization output contains reserved receipt: " + receiptPath);
    }
    assertParentClaim(parentPath, parentIdentity);
    assertRootIdentity(outputPath, outputIdentity, "materialization output");
    assertAtomicArtifactClaim(outputPath, copiedClaim, "copied materialization target");
    assertAtomicArtifactClaim(source.bundleRoot, bundleClaim, pluginName + " source bundle");
    assertAtomicArtifactClaim(
      source.targetRoot,
      sourceClaim,
      pluginName + " source target " + target,
    );
    assertRegistryRevisionClaim(reader, registryRevisionClaim, [pluginName]);
    assertParentClaim(parentPath, parentIdentity);
    assertRootIdentity(outputPath, outputIdentity, "materialization output");
    if (pathEntry(receiptPath)) {
      throw new Error("materialization output contains reserved receipt: " + receiptPath);
    }
    beforeReceiptOpen({ receiptPath });
    assertParentClaim(parentPath, parentIdentity);
    assertRootIdentity(outputPath, outputIdentity, "materialization output");
    assertAtomicArtifactClaim(outputPath, copiedClaim, "copied materialization target");
    assertAtomicArtifactClaim(source.bundleRoot, bundleClaim, pluginName + " source bundle");
    assertAtomicArtifactClaim(
      source.targetRoot,
      sourceClaim,
      pluginName + " source target " + target,
    );
    assertRegistryRevisionClaim(reader, registryRevisionClaim, [pluginName]);
    if (pathEntry(receiptPath)) {
      throw new Error("materialization output contains reserved receipt: " + receiptPath);
    }
    writeReceiptExclusive(receiptPath, receipt);
    return receipt;
  } catch (error) {
    throw incompleteMaterialization(error, outputPath);
  }
}
