#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertRegistryName } from "./lib/path-safety.mjs";
import { materialize } from "./lib/materialize.mjs";
import { openRegistry, registryRevision } from "./lib/registry-reader.mjs";

const TARGETS = new Set(["claude", "codex", "openclaw"]);

function usage() {
  return "usage: registry.mjs list|inspect --plugin <name>|verify [--plugin <name>]"
    + "|materialize --plugin <name> --target <target> --output <path>";
}

function parseCommand(argv) {
  const [command, ...arguments_] = argv;
  if (!new Set(["list", "inspect", "verify", "materialize"]).has(command)) {
    throw new Error(usage());
  }
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (!new Set(["--plugin", "--target", "--output"]).has(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const key = argument.slice(2);
    if (options[key] !== undefined) throw new Error("repeated option " + argument);
    const value = arguments_[index + 1];
    if (!value || value.startsWith("--")) throw new Error("missing option " + argument);
    options[key] = key === "plugin"
      ? assertRegistryName(value, "registry plugin name")
      : value;
    index += 1;
  }
  const supplied = Object.keys(options);
  const allowed = command === "list"
    ? []
    : command === "inspect" || command === "verify"
      ? ["plugin"]
      : ["plugin", "target", "output"];
  const unexpected = supplied.find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(command + " does not accept option --" + unexpected);
  if (command === "inspect" && options.plugin === undefined) {
    throw new Error("missing option --plugin");
  }
  if (command === "materialize") {
    for (const key of allowed) {
      if (options[key] === undefined) throw new Error("missing option --" + key);
    }
    if (!TARGETS.has(options.target)) {
      throw new Error("unsupported materialization target: " + options.target);
    }
  }
  return { command, ...options };
}

function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { command, plugin, target, output } = parseCommand(process.argv.slice(2));
  const registry = openRegistry(repositoryRoot);
  if (command === "list") {
    process.stdout.write(JSON.stringify(registry.list(), null, 2) + "\n");
    return;
  }
  if (command === "inspect") {
    process.stdout.write(JSON.stringify(registry.inspect(plugin), null, 2) + "\n");
    return;
  }
  if (command === "materialize") {
    const receipt = materialize({
      reader: registry,
      pluginName: plugin,
      target,
      outputPath: resolve(output),
      registryRevision: registryRevision(repositoryRoot),
    });
    process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
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
