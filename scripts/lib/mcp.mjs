import { compareCodePoints } from "./ordering.mjs";
import { readJson, writeJson } from "./json.mjs";
import { classifyRuntimeCommand } from "./runtime-command.mjs";

const EXACT_SEMVER_SOURCE = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?`;
const EXACT_SEMVER = new RegExp("^" + EXACT_SEMVER_SOURCE + "$");
const NPM_PACKAGE_NAME_SOURCE = String.raw`(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*`;
const NPM_PACKAGE_NAME = new RegExp("^" + NPM_PACKAGE_NAME_SOURCE + "$");
const NPM_PACKAGE = new RegExp("^(" + NPM_PACKAGE_NAME_SOURCE + ")(?:@([^@]+))?$");
const PROTOTYPE_PACKAGE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
const NORMALIZED_SERVER_FIELDS = new Set([
  "args",
  "command",
  "env",
  "id",
  "runtimeDependencies",
  "transport",
  "url",
]);
function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNpmPackageName(value) {
  return NPM_PACKAGE_NAME.test(value) && !PROTOTYPE_PACKAGE_NAMES.has(value);
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
    if (!isNpmPackageName(name)) {
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
  return match && isNpmPackageName(match[1])
    ? { name: match[1], version: match[2] }
    : undefined;
}

function pinNpxArgs(args, runtimePins, { allowLatest }) {
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
  if (parsed.version === "latest" && !allowLatest) {
    throw new Error("floating MCP package version: " + parsed.name + "@latest");
  }
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

function containerInvocation(args) {
  if (args[0] !== "run") throw new Error("container MCP command must use run");
  let index = 1;
  let entrypoint;
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
      if (option === "--entrypoint") entrypoint = value;
      index += 1;
      continue;
    }
    validateContainerOptionValue(option, args[index + 1]);
    if (option === "--entrypoint") entrypoint = args[index + 1];
    index += 2;
  }
  if (index >= args.length) throw new Error("container MCP command is missing an image");
  return { entrypoint, image: args[index], imageIndex: index };
}

function assertPinnedContainerImage(image) {
  const match = /^([^@\s]+)@sha256:[a-f0-9]{64}$/.exec(image);
  if (match) {
    const name = match[1];
    if (name.lastIndexOf(":") <= name.lastIndexOf("/")) return;
  }
  throw new Error("container image must use an immutable sha256 digest: " + image);
}

function assertNoNestedContainerRuntime(command) {
  if (command === undefined) return;
  if (classifyRuntimeCommand(command).runtimeClass !== "static") {
    throw new Error("container MCP must not launch nested runtime: " + command);
  }
}

function pinArgs(command, args, runtimePins, { allowLatest }) {
  const runtime = classifyRuntimeCommand(command);
  if (runtime.runtimeClass === "npx") return pinNpxArgs(args, runtimePins, { allowLatest });
  if (runtime.runtimeClass === "blocked") {
    throw new Error("unsupported dynamic MCP launcher: " + runtime.stem);
  }
  if (runtime.runtimeClass === "container") {
    const invocation = containerInvocation(args);
    assertPinnedContainerImage(invocation.image);
    assertNoNestedContainerRuntime(invocation.entrypoint);
    assertNoNestedContainerRuntime(args[invocation.imageIndex + 1]);
  }
  return { args, runtimeDependencies: {} };
}

function sourceServer(id, server) {
  if (!SERVER_ID.test(id)) throw new Error("invalid MCP server ID: " + id);
  if (!isObject(server)) throw new Error("MCP server " + id + " must be an object");
  for (const field of Object.keys(server).sort(compareCodePoints)) {
    if (!SERVER_FIELDS.has(field)) throw new Error("unknown MCP server field: " + id + "." + field);
  }

  const candidate = {
    id,
    transport: hasOwn(server, "type") ? server.type : (hasOwn(server, "url") ? "http" : "stdio"),
  };
  for (const field of ["command", "args", "env", "url"]) {
    if (hasOwn(server, field)) candidate[field] = server[field];
  }
  return candidate;
}

function safeRemoteUrl(serverId, value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("remote MCP server must define a URL: " + serverId);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("remote MCP URL must use HTTP or HTTPS: " + serverId);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("remote MCP URL must use HTTP or HTTPS: " + serverId);
  }
  if (url.username || url.password) {
    throw new Error("remote MCP URL must not embed credentials: " + serverId);
  }
  return value;
}

function equalStringArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function equalRuntimeDependencies(left, right) {
  const leftKeys = Object.keys(left).sort(compareCodePoints);
  const rightKeys = Object.keys(right).sort(compareCodePoints);
  return equalStringArrays(leftKeys, rightKeys) &&
    leftKeys.every((key) => left[key] === right[key]);
}

function canonicalServer({
  server,
  runtimePins,
  allowLatest,
  requireCanonicalInput,
}) {
  if (!isObject(server)) throw new Error("normalized MCP server must be an object");
  for (const field of Object.keys(server).sort(compareCodePoints)) {
    if (!NORMALIZED_SERVER_FIELDS.has(field)) {
      throw new Error("unknown normalized MCP server field: " + field);
    }
  }
  if (!SERVER_ID.test(server.id)) {
    throw new Error("invalid MCP server ID: " + String(server.id));
  }
  if (requireCanonicalInput) {
    for (const field of ["env", "runtimeDependencies", "transport"]) {
      if (!hasOwn(server, field)) {
        throw new Error("normalized MCP server is missing field: " + field);
      }
    }
  }
  validateRuntimePins(runtimePins);

  if (!["stdio", "http", "sse"].includes(server.transport)) {
    throw new Error("unsupported MCP transport for " + server.id + ": " + String(server.transport));
  }
  const env = safeEnv(server.id, hasOwn(server, "env") ? server.env : {});
  if (server.transport === "stdio") {
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      throw new Error("MCP command must be a non-empty string: " + server.id);
    }
    if (hasOwn(server, "url")) {
      throw new Error("stdio MCP server must not define a URL: " + server.id);
    }
    if (requireCanonicalInput && !hasOwn(server, "args")) {
      throw new Error("normalized MCP server is missing field: args");
    }
    const args = validateArgs(server.id, hasOwn(server, "args") ? server.args : []);
    const pinned = pinArgs(server.command, args, runtimePins, { allowLatest });
    if (requireCanonicalInput && !equalStringArrays(args, pinned.args)) {
      throw new Error("normalized MCP server arguments are not canonical: " + server.id);
    }
    if (
      requireCanonicalInput &&
      !equalRuntimeDependencies(server.runtimeDependencies, pinned.runtimeDependencies)
    ) {
      throw new Error("MCP runtime dependencies disagree with command: " + server.id);
    }
    return {
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: pinned.args,
      env,
      runtimeDependencies: pinned.runtimeDependencies,
    };
  }

  if (hasOwn(server, "command") || hasOwn(server, "args")) {
    throw new Error("remote MCP server must not define command or args: " + server.id);
  }
  const url = safeRemoteUrl(server.id, server.url);
  const runtimeDependencies = {};
  if (
    requireCanonicalInput &&
    !equalRuntimeDependencies(server.runtimeDependencies, runtimeDependencies)
  ) {
    throw new Error("MCP runtime dependencies disagree with command: " + server.id);
  }
  return {
    id: server.id,
    transport: server.transport,
    env,
    url,
    runtimeDependencies,
  };
}

export function normalizeMcp({ record, runtimePins = {} }) {
  return Object.entries(serverMap(sourceObject(record)))
    .sort(([left], [right]) => compareCodePoints(left, right))
    .map(([id, server]) => canonicalServer({
      server: sourceServer(id, server),
      runtimePins,
      allowLatest: true,
      requireCanonicalInput: false,
    }));
}

function hostFields(server) {
  if (server.transport === "stdio") {
    return Object.fromEntries([
      ["command", server.command],
      server.args.length > 0 ? ["args", server.args] : undefined,
      Object.keys(server.env).length > 0 ? ["env", server.env] : undefined,
    ].filter(Boolean));
  }
  return Object.fromEntries([
    ["type", server.transport],
    ["url", server.url],
    Object.keys(server.env).length > 0 ? ["env", server.env] : undefined,
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
      const canonical = canonicalServer({
        server,
        runtimePins: isObject(server) ? server.runtimeDependencies : undefined,
        allowLatest: false,
        requireCanonicalInput: true,
      });
      if (seen.has(canonical.id)) throw new Error("duplicate MCP server ID: " + canonical.id);
      seen.add(canonical.id);
      return [canonical.id, hostFields(canonical)];
    });
  writeJson(filePath, target === "codex"
    ? { mcp_servers: Object.fromEntries(entries) }
    : { mcpServers: Object.fromEntries(entries) });
}
