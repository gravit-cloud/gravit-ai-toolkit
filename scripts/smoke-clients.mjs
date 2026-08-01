#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathIsInside } from "./lib/path-safety.mjs";

const CLIENT_TIMEOUT_MS = 45_000;
const CLIENT_MAX_BUFFER = 1024 * 1024;
const ERROR_OUTPUT_LIMIT = 8 * 1024;
const ALLOWED_PARENT_ENV = Object.freeze([
  "PATH",
  "Path",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
]);

function pathEntry(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertRealDirectory(path, label) {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(label + " must be a real directory: " + absolute);
  }
  const canonical = realpathSync(absolute);
  return canonical;
}

function assertRepositoryFile(repositoryRoot, path, label) {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(label + " must be a real file: " + absolute);
  }
  const canonical = realpathSync(absolute);
  if (!pathIsInside(repositoryRoot, canonical)) {
    throw new Error(label + " escapes repository root: " + absolute);
  }
  return canonical;
}

function localExecutable(repositoryRoot, name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const binPath = resolve(repositoryRoot, "node_modules/.bin", name + suffix);
  const entry = lstatSync(binPath);
  if (!entry.isFile() && !entry.isSymbolicLink()) {
    throw new Error("local client executable has wrong type: " + binPath);
  }
  const executable = realpathSync(binPath);
  if (!statSync(executable).isFile()) {
    throw new Error("local client executable target is not a file: " + binPath);
  }
  const nodeModules = resolve(repositoryRoot, "node_modules");
  if (!pathIsInside(nodeModules, executable)) {
    throw new Error("local client executable escapes node_modules: " + binPath);
  }
  return binPath;
}

function createClientDirectory(temporaryRoot, client) {
  const root = resolve(temporaryRoot, client);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = assertRealDirectory(root, client + " smoke root");
  if (!pathIsInside(temporaryRoot, canonical) || canonical === temporaryRoot) {
    throw new Error(client + " smoke root escapes temporary root: " + canonical);
  }
  for (const name of ["home", "config", "cache", "data", "state", "tmp"]) {
    const path = resolve(root, name);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const child = assertRealDirectory(path, client + " " + name + " directory");
    if (!pathIsInside(canonical, child) || child === canonical) {
      throw new Error(client + " state directory escapes client root: " + child);
    }
  }
  return root;
}

function isolatedEnvironment(parentEnv, clientRoot) {
  const env = Object.create(null);
  for (const key of ALLOWED_PARENT_ENV) {
    if (
      Object.prototype.hasOwnProperty.call(parentEnv, key)
      && typeof parentEnv[key] === "string"
    ) {
      env[key] = parentEnv[key];
    }
  }
  if (typeof env.PATH !== "string" && typeof env.Path !== "string") {
    throw new Error("client smoke requires an explicit PATH runtime variable");
  }
  const home = resolve(clientRoot, "home");
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = resolve(home, "config");
  env.XDG_CACHE_HOME = resolve(home, "cache");
  env.XDG_DATA_HOME = resolve(home, "data");
  env.XDG_STATE_HOME = resolve(home, "state");
  env.TMPDIR = resolve(home, "tmp");
  env.TMP = env.TMPDIR;
  env.TEMP = env.TMPDIR;
  env.NO_COLOR = "1";
  env.CI = "true";
  for (const path of [
    env.HOME,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.TMPDIR,
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return env;
}

function freezeSpec(spec) {
  Object.freeze(spec.args);
  Object.freeze(spec.env);
  return Object.freeze(spec);
}

export function smokeCommands({
  repositoryRoot,
  temporaryRoot,
  parentEnv = process.env,
}) {
  const repository = assertRealDirectory(repositoryRoot, "repository root");
  const temporary = assertRealDirectory(temporaryRoot, "client smoke temporary root");
  assertRepositoryFile(
    repository,
    resolve(repository, ".claude-plugin/marketplace.json"),
    "Claude marketplace",
  );
  assertRepositoryFile(
    repository,
    resolve(repository, ".agents/plugins/marketplace.json"),
    "Codex marketplace",
  );
  const openclawBundle = assertRealDirectory(
    resolve(repository, "plugins/azure/targets/openclaw"),
    "OpenClaw Azure bundle",
  );
  if (!pathIsInside(repository, openclawBundle)) {
    throw new Error("OpenClaw Azure bundle escapes repository root: " + openclawBundle);
  }
  assertRepositoryFile(
    repository,
    resolve(openclawBundle, ".codex-plugin/plugin.json"),
    "OpenClaw Azure bundle marker",
  );
  const claudeRoot = createClientDirectory(temporary, "claude");
  const codexRoot = createClientDirectory(temporary, "codex");
  const openclawRoot = createClientDirectory(temporary, "openclaw");
  const claudeEnv = isolatedEnvironment(parentEnv, claudeRoot);
  claudeEnv.CLAUDE_CONFIG_DIR = resolve(claudeEnv.HOME, "claude-config");
  mkdirSync(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const codexEnv = isolatedEnvironment(parentEnv, codexRoot);
  codexEnv.CODEX_HOME = resolve(codexEnv.HOME, "codex-state");
  mkdirSync(codexEnv.CODEX_HOME, { recursive: true, mode: 0o700 });
  const openclawEnv = isolatedEnvironment(parentEnv, openclawRoot);
  openclawEnv.OPENCLAW_STATE_DIR = resolve(openclawEnv.HOME, "openclaw-state");
  openclawEnv.OPENCLAW_CONFIG_PATH = resolve(
    openclawEnv.HOME,
    "openclaw-config/openclaw.json",
  );
  mkdirSync(openclawEnv.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(openclawEnv.OPENCLAW_CONFIG_PATH), {
    recursive: true,
    mode: 0o700,
  });

  const claude = localExecutable(repository, "claude");
  const codex = localExecutable(repository, "codex");
  const openclaw = localExecutable(repository, "openclaw");
  return [
    {
      name: "claude-validate",
      command: claude,
      args: ["plugin", "validate", "--strict", repository],
      env: claudeEnv,
      expectedPattern: /Validation passed/i,
    },
    {
      name: "codex-marketplace-add",
      command: codex,
      args: ["plugin", "marketplace", "add", repository, "--json"],
      env: codexEnv,
      expectedPattern: /"marketplaceName"\s*:\s*"gravit-cloud"/u,
    },
    {
      name: "codex-plugin-list-available",
      command: codex,
      args: [
        "plugin",
        "list",
        "--marketplace",
        "gravit-cloud",
        "--available",
        "--json",
      ],
      env: codexEnv,
      expectedPattern: /"available"[\s\S]*"pluginId"\s*:\s*"azure@gravit-cloud"/u,
    },
    {
      name: "openclaw-disable-all",
      command: openclaw,
      args: [
        "--no-color",
        "config",
        "set",
        "plugins.enabled",
        "false",
        "--strict-json",
      ],
      env: openclawEnv,
      expectedPattern: /Updated plugins\.enabled/u,
    },
    {
      name: "openclaw-install",
      command: openclaw,
      args: [
        "--no-color",
        "plugins",
        "install",
        openclawBundle,
        "--acknowledge-clawhub-risk",
      ],
      env: openclawEnv,
      expectedPattern: /Installed plugin:\s*azure/u,
    },
    {
      name: "openclaw-disable-azure",
      command: openclaw,
      args: ["--no-color", "plugins", "disable", "azure"],
      env: openclawEnv,
      expectedPattern: /Disabled plugin\s+"azure"/u,
    },
    {
      name: "openclaw-list",
      command: openclaw,
      args: ["--no-color", "plugins", "list", "--json"],
      env: openclawEnv,
      expectedPattern: /"id"\s*:\s*"azure"[\s\S]{0,8192}"enabled"\s*:\s*false/u,
    },
    {
      name: "openclaw-inspect",
      command: openclaw,
      args: ["--no-color", "plugins", "inspect", "azure", "--json"],
      env: openclawEnv,
      expectedPattern: /"id"\s*:\s*"azure"[\s\S]*"bundleFormat"\s*:\s*"codex"[\s\S]*"enabled"\s*:\s*false/u,
    },
  ].map(freezeSpec);
}

function rootClaim(path) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("client smoke temporary root must be a real directory: " + path);
  }
  return Object.freeze({
    path: realpathSync(path),
    device: stats.dev,
    inode: stats.ino,
  });
}

function cleanupOwnedRoot(claim) {
  const current = pathEntry(claim.path);
  if (
    !current
    || current.isSymbolicLink()
    || !current.isDirectory()
    || current.dev !== claim.device
    || current.ino !== claim.inode
    || realpathSync(claim.path) !== claim.path
  ) {
    const error = new Error(
      "client smoke temporary root ownership changed; retained recovery path: "
        + claim.path,
    );
    error.recoveryPath = claim.path;
    throw error;
  }
  rmSync(claim.path, { recursive: true, force: false });
}

function boundedOutput(result) {
  return String(result.stdout || "") + String(result.stderr || "");
}

function failureOutput(output) {
  if (output.length <= ERROR_OUTPUT_LIMIT) return output;
  return output.slice(0, ERROR_OUTPUT_LIMIT) + "\n[output truncated]";
}

function commandFailure(spec, detail, output) {
  const suffix = output.length > 0 ? "\n" + failureOutput(output) : "";
  return new Error(spec.name + " failed: " + detail + suffix);
}

function runCommand(spec, repositoryRoot, processRunner) {
  const result = processRunner(spec.command, spec.args, {
    cwd: repositoryRoot,
    env: spec.env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CLIENT_TIMEOUT_MS,
    maxBuffer: CLIENT_MAX_BUFFER,
    windowsHide: true,
  });
  if (!result || typeof result !== "object") {
    throw commandFailure(spec, "process runner returned no result", "");
  }
  const output = boundedOutput(result);
  if (result.error) {
    throw commandFailure(spec, result.error.message || String(result.error), output);
  }
  if (result.signal) {
    throw commandFailure(spec, "terminated by signal " + result.signal, output);
  }
  if (!Number.isInteger(result.status) || result.status !== 0) {
    throw commandFailure(spec, "exited with status " + String(result.status), output);
  }
  if (spec.expectedPattern) {
    const pattern = new RegExp(
      spec.expectedPattern.source,
      spec.expectedPattern.flags.replace(/[gy]/gu, ""),
    );
    if (!pattern.test(output)) {
      throw commandFailure(spec, "expected output was not observed", output);
    }
  }
}

export function runClientSmoke(repositoryRoot, {
  parentEnv = process.env,
  processRunner = spawnSync,
} = {}) {
  const temporaryRoot = realpathSync(mkdtempSync(
    resolve(tmpdir(), "gravit-client-smoke-"),
  ));
  const claim = rootClaim(temporaryRoot);
  const completed = [];
  let activeError;
  try {
    const commands = smokeCommands({
      repositoryRoot,
      temporaryRoot,
      parentEnv,
    });
    for (const spec of commands) {
      runCommand(spec, assertRealDirectory(repositoryRoot, "repository root"), processRunner);
      completed.push(spec.name);
    }
  } catch (error) {
    activeError = error;
  }

  try {
    cleanupOwnedRoot(claim);
  } catch (cleanupError) {
    if (!activeError) throw cleanupError;
    const aggregate = new AggregateError(
      [activeError, cleanupError],
      activeError.message + "; temporary cleanup also failed: " + cleanupError.message,
    );
    aggregate.recoveryPath = cleanupError.recoveryPath;
    throw aggregate;
  }
  if (activeError) throw activeError;
  return completed;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  runClientSmoke(repositoryRoot);
  console.log("Client smoke tests passed.");
}
