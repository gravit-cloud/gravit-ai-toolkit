import Ajv from "ajv/dist/2020.js";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { compareCodePoints } from "./ordering.mjs";
import { assertInside, assertRealInside } from "./path-safety.mjs";

const schemaUrl = new URL("../../registry/schemas/catalog.schema.json", import.meta.url);
const schema = JSON.parse(readFileSync(schemaUrl, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile(schema);

export function validateCatalog(catalog) {
  if (!validateSchema(catalog)) {
    const details = validateSchema.errors
      .map((error) => error.instancePath + " " + error.message)
      .join("; ");
    throw new Error("invalid registry catalog: " + details);
  }
  const names = new Set();
  for (const plugin of catalog.plugins) {
    if (names.has(plugin.name)) throw new Error("duplicate plugin name: " + plugin.name);
    names.add(plugin.name);
  }
}

export function resolveLocalCatalogSources({ repositoryRoot, catalog }) {
  const localPlugins = catalog.plugins.filter((plugin) => plugin.source.type === "local");
  if (localPlugins.length === 0) return [];

  const absoluteRoot = resolve(repositoryRoot);
  const fixtureRoot = resolve(absoluteRoot, "test/fixtures");
  const safeFixtureRoot = assertRealInside(
    absoluteRoot,
    fixtureRoot,
    "local fixture root",
  );
  return localPlugins
    .map((plugin) => {
      const sourcePath = assertInside(
        fixtureRoot,
        resolve(absoluteRoot, plugin.source.path),
        "local catalog source",
      );
      const safeSourcePath = assertRealInside(
        safeFixtureRoot,
        sourcePath,
        "local catalog source",
      );
      if (!statSync(safeSourcePath).isDirectory()) {
        throw new Error("local catalog source must be a directory: " + sourcePath);
      }
      const sourceRoot = assertInside(
        safeSourcePath,
        resolve(safeSourcePath, plugin.source.root || "."),
        "local plugin source root",
      );
      const safeSourceRoot = assertRealInside(
        safeSourcePath,
        sourceRoot,
        "local plugin source root",
      );
      if (!statSync(safeSourceRoot).isDirectory()) {
        throw new Error("local plugin source root must be a directory: " + sourceRoot);
      }
      return {
        lexicalSourcePath: sourcePath,
        lexicalSourceRoot: sourceRoot,
        pluginName: plugin.name,
        sourcePath: safeSourcePath,
        sourceRoot: safeSourceRoot,
      };
    })
    .sort((left, right) => compareCodePoints(left.pluginName, right.pluginName));
}

export function resolveCatalogPath({ repositoryRoot, catalogPath }) {
  const absoluteRoot = resolve(repositoryRoot);
  const absolutePath = assertInside(
    absoluteRoot,
    resolve(absoluteRoot, catalogPath),
    "registry catalog",
  );
  return assertRealInside(absoluteRoot, absolutePath, "registry catalog");
}

export function loadCatalog({ repositoryRoot, catalogPath }) {
  const absoluteRoot = resolve(repositoryRoot);
  const safePath = resolveCatalogPath({ repositoryRoot: absoluteRoot, catalogPath });
  const catalog = JSON.parse(readFileSync(safePath, "utf8"));
  validateCatalog(catalog);
  resolveLocalCatalogSources({ repositoryRoot: absoluteRoot, catalog });
  return catalog;
}
