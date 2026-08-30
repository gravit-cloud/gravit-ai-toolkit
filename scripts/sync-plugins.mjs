#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "./build-registry.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

buildRegistry({
  repositoryRoot,
  catalogPath: "registry/catalog.json",
  outputRoot: repositoryRoot,
  production: true,
});
