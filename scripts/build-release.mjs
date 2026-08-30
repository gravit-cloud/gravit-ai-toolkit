import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  parse,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertAtomicArtifactClaim,
  claimAtomicArtifact,
} from "./lib/atomic-output.mjs";
import { sha256, treeHash } from "./lib/hash.mjs";
import { stableJson } from "./lib/json.mjs";
import { validateReceipt } from "./lib/materialize.mjs";
import { compareCodePoints } from "./lib/ordering.mjs";
import {
  assertRegistryName,
  canonicalPath,
  pathIsInside,
  pathsOverlap,
  walkFiles,
} from "./lib/path-safety.mjs";
import {
  assertRegistryRevisionClaim,
  claimRegistryRevision,
  openRegistry,
  releaseSource,
} from "./lib/registry-reader.mjs";

const RECEIPT = ".gravit-plugin-receipt.json";
const ZIP = "/usr/bin/zip";
const UNZIP = "/usr/bin/unzip";
const ARCHIVE_TIMESTAMP = new Date("1980-01-01T00:00:00.000Z");
const MAX_TOOL_OUTPUT = 8 * 1024 * 1024;
const SAFE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MANAGED_INPUTS = Object.freeze([
  "registry",
  "plugins",
  "sources",
  ".claude-plugin",
  ".agents",
]);

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

function modeOf(stats) {
  return stats.mode & 0o7777;
}

function assertTrustedExecutable(path, label) {
  if (parse(path).root === "" || canonicalPath(path) !== path) {
    throw new Error(`trusted ${label} executable must use a canonical absolute path: ${path}`);
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o111) === 0) {
    throw new Error(`trusted ${label} executable is unavailable: ${path}`);
  }
}

function runArchiveTool(executable, args, label, { cwd } = {}) {
  assertTrustedExecutable(executable, label);
  if (cwd !== undefined && realpathSync(cwd) !== cwd) {
    throw new Error(label + " working directory must be canonical: " + cwd);
  }
  const result = spawnSync(executable, args, {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: "utf8",
    env: { TZ: "UTC" },
    maxBuffer: MAX_TOOL_OUTPUT,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    const diagnostic = String(result.stderr || result.error?.message || "no diagnostic")
      .trim()
      .slice(0, MAX_TOOL_OUTPUT);
    throw new Error(`${label} failed (${String(result.status)}): ${diagnostic}`);
  }
  return result.stdout;
}

function safeArchiveName(summary) {
  assertRegistryName(summary.name, "release plugin name");
  if (typeof summary.distributionVersion !== "string" || !SAFE_VERSION.test(summary.distributionVersion)) {
    throw new Error(summary.name + ": unsafe release distribution version");
  }
  const name = `${summary.name}-v${summary.distributionVersion}.zip`;
  if (
    basename(name) !== name
    || name === "."
    || name === ".."
    || /[\\/\u0000-\u001f]/u.test(name)
  ) {
    throw new Error(summary.name + ": unsafe release archive name");
  }
  return name;
}

function assertDirectoryClaim(path, expected, label) {
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.dev !== expected.device
    || stats.ino !== expected.inode
    || realpathSync(path) !== path
  ) {
    throw new Error(label + " ownership changed: " + path);
  }
}

export function selectReleaseStageParent({ repositoryRoot, distRoot, distParent }) {
  const candidate = pathIsInside(repositoryRoot, distRoot)
    ? dirname(repositoryRoot)
    : distParent;
  if (candidate === parse(candidate).root) {
    throw new Error("release stage parent must not be a filesystem root");
  }
  return candidate;
}

function safeDistRoot(repositoryRoot, requestedRoot) {
  if (typeof requestedRoot !== "string" || requestedRoot.length === 0) {
    throw new Error("release DIST_DIR must be a non-empty path");
  }
  const lexicalRoot = resolve(requestedRoot);
  if (lexicalRoot === parse(lexicalRoot).root) {
    throw new Error("release DIST_DIR must not be a filesystem root");
  }
  const lexicalParent = dirname(lexicalRoot);
  if (lexicalParent === parse(lexicalParent).root) {
    throw new Error("release DIST_DIR immediate parent must not be a filesystem root");
  }
  const parentEntry = pathEntry(lexicalParent);
  if (!parentEntry) {
    throw new Error("release DIST_DIR immediate parent must exist: " + lexicalParent);
  }
  const parentRoot = realpathSync(lexicalParent);
  const parentIdentity = Object.freeze({ device: parentEntry.dev, inode: parentEntry.ino });
  if (
    parentEntry.isSymbolicLink()
    || !parentEntry.isDirectory()
    || parentRoot !== lexicalParent
    || canonicalPath(lexicalParent) !== lexicalParent
  ) {
    throw new Error("release DIST_DIR parent must be a canonical real directory: " + lexicalParent);
  }
  const distRoot = resolve(parentRoot, basename(lexicalRoot));
  if (distRoot !== lexicalRoot || canonicalPath(distRoot) !== distRoot) {
    throw new Error("release DIST_DIR must be canonical: " + lexicalRoot);
  }

  const repository = realpathSync(repositoryRoot);
  if (distRoot === repository || pathIsInside(distRoot, repository)) {
    throw new Error("release DIST_DIR must not contain the repository: " + distRoot);
  }
  for (const relativePath of MANAGED_INPUTS) {
    if (pathsOverlap(distRoot, resolve(repository, relativePath))) {
      throw new Error("release DIST_DIR overlaps managed registry inputs: " + distRoot);
    }
  }
  const stageParentPath = selectReleaseStageParent({
    repositoryRoot: repository,
    distRoot,
    distParent: parentRoot,
  });

  assertDirectoryClaim(parentRoot, parentIdentity, "release DIST_DIR parent");
  let distEntry = pathEntry(distRoot);
  if (!distEntry) {
    mkdirSync(distRoot, { mode: 0o755 });
    distEntry = lstatSync(distRoot);
  }
  assertDirectoryClaim(parentRoot, parentIdentity, "release DIST_DIR parent");
  if (
    distEntry.isSymbolicLink()
    || !distEntry.isDirectory()
    || realpathSync(distRoot) !== distRoot
  ) {
    throw new Error("release DIST_DIR must be a canonical real directory: " + distRoot);
  }
  return Object.freeze({
    path: distRoot,
    identity: Object.freeze({ device: distEntry.dev, inode: distEntry.ino }),
    parentPath: parentRoot,
    parentIdentity,
    stageParentPath,
  });
}

function safeStageParent(repositoryRoot, dist) {
  const candidate = dist.stageParentPath;
  const entry = lstatSync(candidate);
  if (
    entry.isSymbolicLink()
    || !entry.isDirectory()
    || realpathSync(candidate) !== candidate
    || canonicalPath(candidate) !== candidate
  ) {
    throw new Error("release stage parent must be a canonical real directory: " + candidate);
  }
  if (
    candidate === repositoryRoot
    || pathIsInside(repositoryRoot, candidate)
    || candidate === dist.path
    || pathIsInside(dist.path, candidate)
  ) {
    throw new Error("release stage parent must be outside repository and DIST_DIR: " + candidate);
  }
  if (entry.dev !== dist.identity.device) {
    throw new Error("release stage parent and DIST_DIR must use the same filesystem");
  }
  return Object.freeze({
    path: candidate,
    identity: Object.freeze({ device: entry.dev, inode: entry.ino }),
  });
}

function sourcePath(root, relativePath) {
  return relativePath === "." ? root : resolve(root, ...relativePath.split("/"));
}

function openBoundSourceFile(path, entry, label) {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || before.dev !== entry.device
    || before.ino !== entry.inode
    || modeOf(before) !== entry.mode
  ) {
    throw new Error(label + " ownership or metadata changed: " + path);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(descriptor);
  if (!opened.isFile() || !sameIdentity(before, opened)) {
    closeSync(descriptor);
    throw new Error(label + " ownership changed: " + path);
  }
  return descriptor;
}

function readBoundFile(path, entry, label) {
  let descriptor;
  try {
    descriptor = openBoundSourceFile(path, entry, label);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== entry.device
      || after.ino !== entry.inode
      || modeOf(after) !== entry.mode
      || sha256(bytes) !== entry.digest
    ) {
      throw new Error(label + " changed while reading: " + path);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createBoundDirectory(path, mode, label) {
  mkdirSync(path, { mode });
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(label + " must be a real directory: " + path);
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
    fchmodSync(descriptor, mode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function copyClaimedBundle(sourceRoot, destinationRoot, claim, label) {
  for (const entry of claim.entries) {
    if (
      typeof entry.relativePath !== "string"
      || entry.relativePath.includes("\\")
      || (entry.relativePath !== "." && entry.relativePath.split("/").some((part) => (
        part.length === 0 || part === "." || part === ".."
      )))
    ) {
      throw new Error(label + " has an unsafe claimed path");
    }
    const destination = sourcePath(destinationRoot, entry.relativePath);
    if (entry.type === "directory") {
      createBoundDirectory(destination, entry.mode, "release stage directory");
      continue;
    }
    if (entry.type !== "file") throw new Error(label + " contains an unsupported entry");

    const source = sourcePath(sourceRoot, entry.relativePath);
    let destinationDescriptor;
    try {
      const bytes = readBoundFile(source, entry, label);
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
        || modeOf(destinationOpened) !== entry.mode
      ) {
        throw new Error("release stage file ownership changed: " + destination);
      }
    } finally {
      if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    }
  }
  assertAtomicArtifactClaim(sourceRoot, claim, label);
}

function writeExclusiveFile(path, bytes, mode, label) {
  let descriptor;
  let claim;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    const opened = fstatSync(descriptor);
    const bound = lstatSync(path);
    if (
      !opened.isFile()
      || !sameIdentity(opened, bound)
      || bound.isSymbolicLink()
      || modeOf(opened) !== mode
    ) {
      throw new Error(label + " ownership changed: " + path);
    }
    claim = Object.freeze({
      device: opened.dev,
      inode: opened.ino,
      mode,
      digest: sha256(bytes),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return claim;
}

function normalizeArchiveFiles(bundleStage, payloadRoot) {
  return walkFiles(bundleStage).map((filePath) => {
    utimesSync(filePath, ARCHIVE_TIMESTAMP, ARCHIVE_TIMESTAMP);
    const relativePath = relative(payloadRoot, filePath).replaceAll("\\", "/");
    if (
      relativePath.startsWith("/")
      || relativePath.includes("\\")
      || relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    ) {
      throw new Error("unsafe staged release path: " + relativePath);
    }
    return relativePath;
  }).sort(compareCodePoints);
}

function verifyArchive(archive, expectedFiles) {
  const actualFiles = runArchiveTool(UNZIP, ["-Z", "-1", archive], "unzip")
    .split("\n")
    .filter(Boolean);
  if (
    actualFiles.length !== expectedFiles.length
    || actualFiles.some((entry, index) => entry !== expectedFiles[index])
  ) {
    throw new Error("archive entries differ from the verified staged payload: " + archive);
  }
  runArchiveTool(UNZIP, ["-tqq", archive], "unzip");
}

function createStagedArchive({ payloadRoot, bundleStage, archivePath }) {
  const relativeFiles = normalizeArchiveFiles(bundleStage, payloadRoot);
  runArchiveTool(
    ZIP,
    ["-X", "-q", archivePath, ...relativeFiles],
    "zip",
    { cwd: payloadRoot },
  );
  let descriptor;
  try {
    descriptor = openSync(archivePath, constants.O_RDWR | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    const bound = lstatSync(archivePath);
    if (
      !opened.isFile()
      || !sameIdentity(opened, bound)
      || bound.isSymbolicLink()
    ) {
      throw new Error("staged release archive must be a bound regular file: " + archivePath);
    }
    fchmodSync(descriptor, 0o644);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  verifyArchive(archivePath, relativeFiles);
}

function publishArchive({
  source,
  sourceEntry,
  destination,
  dist,
  publicationHooks,
  beforeLinkValidation,
  recordPublished,
}) {
  assertDirectoryClaim(dist.parentPath, dist.parentIdentity, "release DIST_DIR parent");
  assertDirectoryClaim(dist.path, dist.identity, "release DIST_DIR");
  if (sourceEntry.device !== dist.identity.device) {
    throw new Error("staged archive and DIST_DIR must use the same filesystem");
  }
  if (pathEntry(destination)) {
    throw new Error("release archive already exists: " + destination);
  }
  publicationHooks.beforeArchiveLink?.({ source, destination });
  beforeLinkValidation();
  assertDirectoryClaim(dist.parentPath, dist.parentIdentity, "release DIST_DIR parent");
  assertDirectoryClaim(dist.path, dist.identity, "release DIST_DIR");
  readBoundFile(source, sourceEntry, "staged release archive");
  try {
    linkSync(source, destination);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("release archive already exists: " + destination);
    }
    if (error.code === "EXDEV") {
      throw new Error("staged archive and DIST_DIR must use the same filesystem");
    }
    throw error;
  }
  recordPublished(destination);
  publicationHooks.afterArchiveLink?.({ source, destination });
  assertDirectoryClaim(dist.parentPath, dist.parentIdentity, "release DIST_DIR parent");
  assertDirectoryClaim(dist.path, dist.identity, "release DIST_DIR");
  if (
    sha256(readBoundFile(destination, sourceEntry, "published release archive"))
      !== sourceEntry.digest
  ) {
    throw new Error("published release archive digest mismatch: " + destination);
  }
}

function retainedReleaseError(error, stageRoot, publishedArchives) {
  const retained = new AggregateError(
    [error],
    "release build failed; recovery data retained at " + stageRoot,
  );
  retained.recoveryPath = stageRoot;
  retained.publishedArchives = Object.freeze([...publishedArchives]);
  return retained;
}

export function buildRelease({
  repositoryRoot,
  distRoot,
  publicationHooks = {},
}) {
  const repository = realpathSync(repositoryRoot);
  const reader = openRegistry(repository);
  const verification = reader.verify();
  if (!verification.ok) throw new Error(verification.errors.join("\n"));
  const summaries = reader.list();
  const sources = summaries.map(({ name }) => releaseSource(reader, name));
  const pluginNames = summaries.map(({ name }) => name);
  const revisionClaim = claimRegistryRevision(reader, pluginNames);
  const revision = assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
  const archiveNames = summaries.map(safeArchiveName);
  if (new Set(archiveNames).size !== archiveNames.length) {
    throw new Error("release archive names collide");
  }
  const dist = safeDistRoot(repository, distRoot);
  for (const archiveName of archiveNames) {
    const destination = resolve(dist.path, archiveName);
    if (basename(destination) !== archiveName || pathEntry(destination)) {
      throw new Error("release archive already exists: " + destination);
    }
  }

  const stageParent = safeStageParent(repository, dist);
  assertDirectoryClaim(stageParent.path, stageParent.identity, "release stage parent");
  const stageRoot = realpathSync(mkdtempSync(resolve(stageParent.path, "gravit-release-")));
  const payloadRoot = resolve(stageRoot, "payload");
  const archivesRoot = resolve(stageRoot, "archives");
  const staged = [];
  const published = [];

  try {
    assertDirectoryClaim(stageParent.path, stageParent.identity, "release stage parent");
    const stageEntry = lstatSync(stageRoot);
    if (
      stageEntry.isSymbolicLink()
      || !stageEntry.isDirectory()
      || dirname(stageRoot) !== stageParent.path
      || stageEntry.dev !== dist.identity.device
      || pathsOverlap(stageRoot, repository)
      || pathsOverlap(stageRoot, dist.path)
    ) {
      throw new Error("release stage must be a same-filesystem directory outside trusted inputs");
    }
    for (const relativePath of MANAGED_INPUTS) {
      if (pathsOverlap(stageRoot, resolve(repository, relativePath))) {
        throw new Error("release stage overlaps managed registry inputs: " + stageRoot);
      }
    }
    createBoundDirectory(payloadRoot, 0o700, "release payload root");
    createBoundDirectory(archivesRoot, 0o700, "release archives root");
    for (const [index, summary] of summaries.entries()) {
      const source = sources[index];
      const sourceClaim = claimAtomicArtifact(
        source.bundleRoot,
        summary.name + " source bundle",
      );
      publicationHooks.afterSourceClaim?.({ source, sourceClaim });
      assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
      const bundleStage = resolve(payloadRoot, summary.name);
      copyClaimedBundle(
        source.bundleRoot,
        bundleStage,
        sourceClaim,
        summary.name + " source bundle",
      );
      publicationHooks.afterSourceCopy?.({ source, sourceClaim, bundleStage });
      assertAtomicArtifactClaim(
        source.bundleRoot,
        sourceClaim,
        summary.name + " source bundle",
      );
      const payloadDigest = treeHash(bundleStage);
      if (payloadDigest !== source.bundleDigest) {
        throw new Error(summary.name + ": staged release digest mismatch");
      }
      assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
      const receipt = {
        schemaVersion: 1,
        registry: "gravit-cloud",
        registryRevision: revision,
        plugin: summary.name,
        target: "universal",
        distributionVersion: source.distributionVersion,
        sourceBundleDigest: source.bundleDigest,
        sourceTargetDigest: source.bundleDigest,
        materializedDigest: source.bundleDigest,
      };
      validateReceipt(receipt);
      writeExclusiveFile(
        resolve(bundleStage, RECEIPT),
        stableJson(receipt),
        0o644,
        "universal release receipt",
      );
      assertAtomicArtifactClaim(
        source.bundleRoot,
        sourceClaim,
        summary.name + " source bundle",
      );
      const archivePath = resolve(archivesRoot, archiveNames[index]);
      createStagedArchive({ payloadRoot, bundleStage, archivePath });
      staged.push(Object.freeze({
        archiveName: archiveNames[index],
        archivePath,
        destination: resolve(dist.path, archiveNames[index]),
      }));
    }

    assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
    for (const item of staged) {
      if (pathEntry(item.destination)) {
        throw new Error("release archive already exists: " + item.destination);
      }
    }
    const stageClaim = claimAtomicArtifact(stageRoot, "completed release stage");
    publicationHooks.beforePublication?.({ staged: Object.freeze([...staged]), dist });
    for (const item of staged) {
      assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
      assertAtomicArtifactClaim(stageRoot, stageClaim, "completed release stage");
      const archiveEntry = stageClaim.entries.find((entry) => (
        entry.relativePath === `archives/${item.archiveName}`
      ));
      if (!archiveEntry || archiveEntry.type !== "file") {
        throw new Error("completed release stage is missing archive: " + item.archiveName);
      }
      publishArchive({
        source: item.archivePath,
        sourceEntry: archiveEntry,
        destination: item.destination,
        dist,
        publicationHooks,
        beforeLinkValidation() {
          assertRegistryRevisionClaim(reader, revisionClaim, pluginNames);
        },
        recordPublished(destination) {
          published.push(destination);
        },
      });
      assertAtomicArtifactClaim(stageRoot, stageClaim, "completed release stage");
    }

    assertAtomicArtifactClaim(stageRoot, stageClaim, "completed release stage");
    const result = [...published];
    Object.defineProperty(result, "stagePath", {
      value: stageRoot,
      enumerable: false,
      writable: false,
    });
    return Object.freeze(result);
  } catch (error) {
    throw retainedReleaseError(error, stageRoot, published);
  }
}

function isExecutableModule() {
  return process.argv[1] !== undefined
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isExecutableModule()) {
  try {
    if (process.argv.length !== 2) {
      throw new Error("build-release accepts no positional arguments");
    }
    const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));
    const distRoot = process.env.DIST_DIR === undefined
      ? resolve(repositoryRoot, "dist")
      : process.env.DIST_DIR;
    const archives = buildRelease({ repositoryRoot, distRoot });
    for (const archive of archives) process.stdout.write(archive + "\n");
  } catch (error) {
    process.stderr.write((error?.stack || String(error)) + "\n");
    process.exitCode = 1;
  }
}
