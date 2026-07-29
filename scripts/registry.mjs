#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegistryName } from "./lib/path-safety.mjs";
import { openRegistry } from "./lib/registry-reader.mjs";

function usage() {
  return "usage: registry.mjs list|inspect --plugin <name>|verify [--plugin <name>]";
}

function parseCommand(argv) {
  const [command, ...arguments_] = argv;
  if (!new Set(["list", "inspect", "verify"]).has(command)) {
    throw new Error(usage());
  }
  let plugin;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--plugin") throw new Error(`unknown argument: ${argument}`);
    if (plugin !== undefined) throw new Error("repeated option --plugin");
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing option --plugin");
    plugin = assertRegistryName(value, "registry plugin name");
    index += 1;
  }
  if (command === "list" && plugin !== undefined) throw new Error("list does not accept options");
  if (command === "inspect" && plugin === undefined) throw new Error("missing option --plugin");
  return { command, plugin };
}

function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { command, plugin } = parseCommand(process.argv.slice(2));
  const registry = openRegistry(repositoryRoot);
  if (command === "list") {
    process.stdout.write(JSON.stringify(registry.list(), null, 2) + "\n");
    return;
  }
  if (command === "inspect") {
    process.stdout.write(JSON.stringify(registry.inspect(plugin), null, 2) + "\n");
    return;
  }
  const result = registry.verify(plugin);
  if (!result.ok) {
    process.stderr.write(result.errors.join("\n") + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Registry bundles verified.\n");
}

try {
  main();
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
}
