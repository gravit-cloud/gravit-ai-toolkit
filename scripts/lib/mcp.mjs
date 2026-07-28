import { compareCodePoints } from "./ordering.mjs";
import { readJson, writeJson } from "./json.mjs";

const EXACT_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?`;
const EXACT_SEMVER = new RegExp("^" + EXACT_SEMVER_SOURCE + "$");
const NPM_PACKAGE = /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)(?:@([^@]+))?$/;
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTAINER_COMMANDS = new Set([
  "container",
  "container.exe",
  "docker",
  "docker.exe",
  "podman",
  "podman.exe",
]);
const CONTAINER_BOOLEAN_OPTIONS = new Set([
  "-i",
  "-t",
  "--init",
  "--interactive",
  "--read-only",
  "--rm",
  "--tty",
]);
const CONTAINER_VALUE_OPTIONS = new Set([
  "-e",
  "-p",
  "-u",
  "-v",
  "-w",
  "--entrypoint",
  "--env",
  "--hostname",
  "--mount",
  "--name",
  "--network",
  "--platform",
  "--publish",
  "--pull",
  "--user",
  "--volume",
  "--workdir",
]);
const SERVER_FIELDS = new Set(["args", "command", "env", "type", "url"]);

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function sourceObject(record) {
  if (!isObject(record)) throw new Error("MCP record must be an object");
  if (record.sourceFormat === "inline") return record.inline;
  if (record.sourceFormat === "path") {
    if (typeof record.sourcePath !== "string" || record.sourcePath.length === 0) {
      throw new Error("path MCP record is missing sourcePath");
    }
    return readJson(record.sourcePath);
  }
  throw new Error("unsupported MCP source format: " + String(record.sourceFormat));
}

function serverMap(source) {
  if (!isObject(source)) throw new Error("MCP source must be an object");
  const wrapperKeys = ["mcpServers", "mcp_servers"].filter((key) => hasOwn(source, key));
  if (wrapperKeys.length > 1) throw new Error("MCP wrapper must use exactly one server-map field");
  const map = wrapperKeys.length === 1 ? source[wrapperKeys[0]] : source;
  if (wrapperKeys.length === 1 && Object.keys(source).length !== 1) {
    throw new Error("MCP wrapper must contain only " + wrapperKeys[0]);
  }
  if (!isObject(map)) throw new Error("MCP server map must be an object");
  if (Object.keys(map).length === 0) throw new Error("MCP server map must not be empty");
  return map;
}

function validateRuntimePins(runtimePins) {
  if (!isObject(runtimePins)) throw new Error("MCP runtime pins must be an object");
  for (const [name, version] of Object.entries(runtimePins)) {
    if (!NPM_PACKAGE.test(name) || name.includes("@", 1)) {
      throw new Error("invalid MCP catalog package name: " + name);
    }
    if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
      throw new Error("MCP catalog pin must be an exact semver: " + name);
    }
  }
}

function validateArgs(serverId, args) {
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new Error("MCP args must be an array of strings: " + serverId);
  }
  return [...args];
}

function safeEnv(serverId, env) {
  if (!isObject(env)) throw new Error("MCP env must be an object: " + serverId);
  const entries = [];
  for (const name of Object.keys(env).sort(compareCodePoints)) {
    const value = env[name];
    if (!ENV_NAME.test(name)) throw new Error("invalid MCP env name: " + serverId + "." + name);
    if (typeof value !== "string") {
      throw new Error("MCP env values must be strings: " + serverId + "." + name);
    }
    if (value !== "${" + name + "}" && value !== "") {
      throw new Error("MCP env must not embed a value: " + serverId + "." + name);
    }
    entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}

function parseNpmPackage(spec) {
  const match = NPM_PACKAGE.exec(spec);
  return match ? { name: match[1], version: match[2] } : undefined;
}

function pinNpxArgs(args, runtimePins) {
  let packageIndex = 0;
  let sawYes = false;
  let sawSeparator = false;
  while (packageIndex < args.length && args[packageIndex].startsWith("-")) {
    const option = args[packageIndex];
    if (option === "--" && !sawSeparator) {
      sawSeparator = true;
      packageIndex += 1;
      break;
    }
    if (["-y", "--yes"].includes(option) && !sawYes && !sawSeparator) {
      sawYes = true;
      packageIndex += 1;
      continue;
    }
    throw new Error("unsupported npx MCP option: " + option);
  }
  if (packageIndex >= args.length) throw new Error("npx MCP command is missing a package");

  const parsed = parseNpmPackage(args[packageIndex]);
  if (!parsed) throw new Error("invalid npx MCP package: " + args[packageIndex]);
  for (const argument of args.slice(packageIndex + 1)) {
    if (argument === "--") break;
    if (/^(?:-p|-c|--package|--call|--shell|--script-shell|--yes|-y)(?:=|$)/.test(argument)) {
      throw new Error("unsupported npx MCP option: " + argument);
    }
  }

  if (!hasOwn(runtimePins, parsed.name)) throw new Error("unpinned MCP package " + parsed.name);
  const pinnedVersion = runtimePins[parsed.name];
  if (parsed.version && parsed.version !== "latest") {
    if (!EXACT_SEMVER.test(parsed.version)) {
      throw new Error("floating MCP package version: " + parsed.name + "@" + parsed.version);
    }
    if (parsed.version !== pinnedVersion) {
      throw new Error("MCP package version disagrees with catalog pin: " + parsed.name);
    }
  }

  const rewritten = [...args];
  rewritten[packageIndex] = parsed.name + "@" + pinnedVersion;
  return {
    args: rewritten,
    runtimeDependencies: { [parsed.name]: pinnedVersion },
  };
}

function validateContainerEnv(option, value) {
  if (!["-e", "--env"].includes(option)) return;
  if (!ENV_NAME.test(value)) throw new Error("container env must not embed a value: " + value);
}

function validateContainerOptionValue(option, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("container MCP option is missing a value: " + option);
  }
  validateContainerEnv(option, value);
  if (option === "--pull" && !["always", "missing", "never"].includes(value)) {
    throw new Error("unsupported container pull policy: " + value);
  }
}

function containerImage(args) {
  if (args[0] !== "run") throw new Error("container MCP command must use run");
  let index = 1;
  while (index < args.length) {
    const argument = args[index];
    if (argument === "--") {
      index += 1;
      break;
    }
    if (!argument.startsWith("-")) break;
    if (CONTAINER_BOOLEAN_OPTIONS.has(argument) || /^-[it]{2}$/.test(argument)) {
      index += 1;
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const option = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    if (!CONTAINER_VALUE_OPTIONS.has(option)) {
      throw new Error("unsupported container MCP option: " + argument);
    }
    if (equalsIndex !== -1) {
      const value = argument.slice(equalsIndex + 1);
      validateContainerOptionValue(option, value);
      index += 1;
      continue;
    }
    validateContainerOptionValue(option, args[index + 1]);
    index += 2;
  }
  if (index >= args.length) throw new Error("container MCP command is missing an image");
  return args[index];
}

function assertPinnedContainerImage(image) {
  const digest = /^([^@\s]+)@sha256:([a-f0-9]{64})$/.exec(image);
  if (digest) return;
  if (image.includes("@") || /\s/.test(image)) {
    throw new Error("container image must use an exact version tag or sha256 digest: " + image);
  }
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  const tag = lastColon > lastSlash ? image.slice(lastColon + 1) : "";
  if (!new RegExp("^v?" + EXACT_SEMVER_SOURCE + "$").test(tag)) {
    throw new Error("container image must use an exact version tag or sha256 digest: " + image);
  }
}

function pinArgs(command, args, runtimePins) {
  if (["npx", "npx.cmd"].includes(command)) return pinNpxArgs(args, runtimePins);
  if (CONTAINER_COMMANDS.has(command)) {
    assertPinnedContainerImage(containerImage(args));
  }
  return { args, runtimeDependencies: {} };
}

function normalizedServer(id, server, runtimePins) {
  if (!SERVER_ID.test(id)) throw new Error("invalid MCP server ID: " + id);
  if (!isObject(server)) throw new Error("MCP server " + id + " must be an object");
  for (const field of Object.keys(server).sort(compareCodePoints)) {
    if (!SERVER_FIELDS.has(field)) throw new Error("unknown MCP server field: " + id + "." + field);
  }

  const transport = server.type === undefined ? (server.url === undefined ? "stdio" : "http") : server.type;
  if (!["stdio", "http", "sse"].includes(transport)) {
    throw new Error("unsupported MCP transport for " + id + ": " + String(transport));
  }
  const env = safeEnv(id, server.env === undefined ? {} : server.env);
  if (transport === "stdio") {
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      throw new Error("MCP command must be a non-empty string: " + id);
    }
    if (server.url !== undefined) throw new Error("stdio MCP server must not define a URL: " + id);
    const args = validateArgs(id, server.args === undefined ? [] : server.args);
    const pinned = pinArgs(server.command, args, runtimePins);
    return {
      id,
      transport,
      command: server.command,
      args: pinned.args,
      env,
      runtimeDependencies: pinned.runtimeDependencies,
    };
  }

  if (server.command !== undefined || server.args !== undefined) {
    throw new Error("remote MCP server must not define command or args: " + id);
  }
  if (typeof server.url !== "string" || server.url.length === 0) {
    throw new Error("remote MCP server must define a URL: " + id);
  }
  let url;
  try {
    url = new URL(server.url);
  } catch {
    throw new Error("remote MCP URL must use HTTP or HTTPS: " + id);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("remote MCP URL must use HTTP or HTTPS: " + id);
  }
  if (url.username || url.password) {
    throw new Error("remote MCP URL must not embed credentials: " + id);
  }
  return {
    id,
    transport,
    env,
    url: server.url,
    runtimeDependencies: {},
  };
}

export function normalizeMcp({ record, runtimePins = {} }) {
  validateRuntimePins(runtimePins);
  return Object.entries(serverMap(sourceObject(record)))
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([id, server]) => normalizedServer(id, server, runtimePins));
}

function writerFields(server) {
  if (!isObject(server)) throw new Error("normalized MCP server must be an object");
  if (!SERVER_ID.test(server.id)) throw new Error("invalid MCP server ID: " + String(server.id));
  const env = safeEnv(server.id, server.env === undefined ? {} : server.env);
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      throw new Error("MCP command must be a non-empty string: " + server.id);
    }
    if (hasOwn(server, "url")) {
      throw new Error("stdio MCP server must not define a URL: " + server.id);
    }
    const args = validateArgs(server.id, server.args === undefined ? [] : server.args);
    return Object.fromEntries([
      ["command", server.command],
      args.length > 0 ? ["args", args] : undefined,
      Object.keys(env).length > 0 ? ["env", env] : undefined,
    ].filter(Boolean));
  }
  if (!["http", "sse"].includes(server.transport)) {
    throw new Error("unsupported MCP transport for " + server.id + ": " + String(server.transport));
  }
  if (hasOwn(server, "command") || hasOwn(server, "args")) {
    throw new Error("remote MCP server must not define command or args: " + server.id);
  }
  if (typeof server.url !== "string" || server.url.length === 0) {
    throw new Error("remote MCP server must define a URL: " + server.id);
  }
  return Object.fromEntries([
    ["type", server.transport],
    ["url", server.url],
    Object.keys(env).length > 0 ? ["env", env] : undefined,
  ].filter(Boolean));
}

export function writeMcpConfig({ servers, target, filePath }) {
  if (!["claude", "codex"].includes(target)) {
    throw new Error("unsupported MCP target: " + String(target));
  }
  if (!Array.isArray(servers)) throw new Error("MCP servers must be an array");
  const seen = new Set();
  const entries = [...servers]
    .sort((left, right) => compareCodePoints(left?.id, right?.id))
    .map((server) => {
      const fields = writerFields(server);
      if (seen.has(server.id)) throw new Error("duplicate MCP server ID: " + server.id);
      seen.add(server.id);
      return [server.id, fields];
    });
  writeJson(filePath, target === "codex"
    ? { mcp_servers: Object.fromEntries(entries) }
    : { mcpServers: Object.fromEntries(entries) });
}
