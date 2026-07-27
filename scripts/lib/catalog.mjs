import Ajv from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export function loadCatalog({ repositoryRoot, catalogPath }) {
  const absolutePath = resolve(repositoryRoot, catalogPath);
  const catalog = JSON.parse(readFileSync(absolutePath, "utf8"));
  validateCatalog(catalog);
  return catalog;
}
