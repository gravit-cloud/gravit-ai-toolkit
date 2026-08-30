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

export function parseValidateArguments(args) {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--compare-lock" && args[1].length > 0) {
    return { comparePath: args[1] };
  }
  throw new Error(usage);
}

export function parseCompareLockJson(source) {
  try {
    return JSON.parse(source);
  } catch {
    throw new Error("compare lock: invalid JSON");
  }
}

export function main(args = process.argv.slice(2)) {
  let options;
  try {
    options = parseValidateArguments(args);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  const errors = validateRepository({ repositoryRoot });
  if (options.comparePath !== undefined) {
    let baseLock;
    try {
      baseLock = parseCompareLockJson(readFileSync(options.comparePath, "utf8"));
    } catch (error) {
      if (error?.message === "compare lock: invalid JSON") errors.push(error.message);
      else {
        const code = typeof error?.code === "string" ? error.code : "read failure";
        errors.push(`compare lock: unable to read file (${code})`);
      }
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
    return 1;
  }
  console.log("Registry validation passed.");
  return 0;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
