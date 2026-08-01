#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateRepository,
  validateVersionHistory,
} from "./lib/validator.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "usage: node scripts/validate.mjs [--compare-lock <path>]";

function compareLockPath(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--compare-lock" && args[1].length > 0) {
    return args[1];
  }
  throw new Error(usage);
}

let comparePath;
try {
  comparePath = compareLockPath(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const errors = validateRepository({ repositoryRoot });
if (comparePath !== undefined) {
  let baseLock;
  try {
    const source = readFileSync(comparePath, "utf8");
    try {
      baseLock = JSON.parse(source);
    } catch {
      errors.push("compare lock: invalid JSON");
    }
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "read failure";
    errors.push(`compare lock: unable to read file (${code})`);
  }
  if (baseLock !== undefined) {
    let currentLock;
    try {
      currentLock = JSON.parse(readFileSync(resolve(repositoryRoot, "registry/lock.json"), "utf8"));
    } catch {
      errors.push("registry/lock.json: invalid JSON for history comparison");
    }
    if (currentLock !== undefined) {
      errors.push(...validateVersionHistory({ currentLock, baseLock }));
    }
  }
}
if (errors.length) {
  console.error([...new Set(errors)].sort().join("\n"));
  process.exit(1);
}
console.log("Registry validation passed.");
