import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compareCodePoints } from "./ordering.mjs";

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort(compareCodePoints).map((key) => [key, sortValue(value[key])]),
  );
}

export function removeUndefined(value) {
  if (Array.isArray(value)) return value.map(removeUndefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareCodePoints)
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, removeUndefined(value[key])]),
  );
}

export function stableJson(value) {
  return JSON.stringify(sortValue(value), null, 2) + "\n";
}

export function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

export function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, stableJson(value));
}
