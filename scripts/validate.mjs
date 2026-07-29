#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRepository } from "./lib/validator.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const errors = validateRepository({ repositoryRoot });
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Registry validation passed.");
