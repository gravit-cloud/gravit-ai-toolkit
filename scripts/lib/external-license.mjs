import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";
import { canonicalPath, pathIsInside } from "./path-safety.mjs";

const EXTERNAL_LICENSE_NAME = /^license(?:\.(?:md|rst|txt))?$/i;

export function externalLicenseSource({ sourceType, sourceRoot }) {
  if (sourceType !== "github") return undefined;
  const sourceStats = lstatSync(sourceRoot);
  if (sourceStats.isSymbolicLink() || !sourceStats.isDirectory()) {
    throw new Error("external source root must be a real directory: " + sourceRoot);
  }
  const canonicalSourceRoot = realpathSync(sourceRoot);
  const candidates = readdirSync(sourceRoot, { withFileTypes: true })
    .filter(({ name }) => EXTERNAL_LICENSE_NAME.test(name))
    .sort((left, right) => compareCodePoints(left.name, right.name));
  if (candidates.length === 0) {
    throw new Error("external source must contain one top-level license");
  }
  if (candidates.length > 1) {
    throw new Error(
      "external source has ambiguous top-level licenses: "
        + candidates.map(({ name }) => name).join(", "),
    );
  }
  const candidate = candidates[0];
  const sourcePath = resolve(sourceRoot, candidate.name);
  const stats = lstatSync(sourcePath);
  const expectedCanonical = resolve(canonicalSourceRoot, candidate.name);
  if (
    candidate.isSymbolicLink()
    || !candidate.isFile()
    || stats.isSymbolicLink()
    || !stats.isFile()
    || canonicalPath(sourcePath) !== expectedCanonical
    || !pathIsInside(canonicalSourceRoot, expectedCanonical)
  ) {
    throw new Error("external license must be a real regular file: " + sourcePath);
  }
  return sourcePath;
}
