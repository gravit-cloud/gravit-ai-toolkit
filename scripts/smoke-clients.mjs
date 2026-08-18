#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pathIsInside } from "./lib/path-safety.mjs";

const CLIENT_TIMEOUT_MS = 45_000;
const CLIENT_MAX_OUTPUT_BYTES = 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const FINALIZATION_GRACE_MS = 250;
const ERROR_OUTPUT_LIMIT = 8 * 1024;
const ALLOWED_PARENT_ENV = Object.freeze(["LANG", "LC_ALL", "LC_CTYPE", "TZ"]);

function assertRealDirectory(path, label) {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(label + " must be a real directory: " + absolute);
  }
  return realpathSync(absolute);
}

function assertRepositoryFile(repositoryRoot, path, label, expectedRoot = repositoryRoot) {
  const absolute = resolve(path);
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(label + " must be a real file: " + absolute);
  }
  const canonical = realpathSync(absolute);
  const boundary = realpathSync(expectedRoot);
  if (!pathIsInside(boundary, canonical) || !pathIsInside(repositoryRoot, canonical)) {
    throw new Error(label + " escapes its exact package root: " + absolute);
  }
  return canonical;
}

function createClientDirectory(temporaryRoot, client) {
  const root = resolve(temporaryRoot, client);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const canonical = assertRealDirectory(root, client + " smoke root");
  if (!pathIsInside(temporaryRoot, canonical) || canonical === temporaryRoot) {
    throw new Error(client + " smoke root escapes temporary root: " + canonical);
  }
  return canonical;
}

function windowsSystemRoot(parentEnv) {
  const systemRoot = parentEnv.SystemRoot || parentEnv.WINDIR;
  if (typeof systemRoot !== "string" || systemRoot.length === 0) {
    throw new Error("client smoke requires SystemRoot on Windows");
  }
  return systemRoot;
}

function trustedPath(parentEnv) {
  const paths = [dirname(process.execPath)];
  if (process.platform === "win32") {
    const systemRoot = windowsSystemRoot(parentEnv);
    paths.push(resolve(systemRoot, "System32"), resolve(systemRoot));
  } else {
    paths.push("/usr/bin", "/bin");
  }
  return [...new Set(paths)].join(delimiter);
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
  if (process.platform === "win32") {
    const systemRoot = windowsSystemRoot(parentEnv);
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.ComSpec = resolve(systemRoot, "System32/cmd.exe");
    env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
  }
  env.PATH = trustedPath(parentEnv);
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

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonStdout(name, stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(name + " returned malformed JSON", { cause: error });
  }
  if (!plainObject(value)) throw new Error(name + " JSON root must be an object");
  return value;
}

function validateCodexMarketplace(stdout, expectedRoot) {
  const value = parseJsonStdout("codex-marketplace-add", stdout);
  if (
    value.marketplaceName !== "gravit-cloud"
    || value.installedRoot !== expectedRoot
    || typeof value.alreadyAdded !== "boolean"
  ) {
    throw new Error("codex-marketplace-add returned the wrong local marketplace");
  }
}

function validateCodexAvailable(stdout) {
  const value = parseJsonStdout("codex-plugin-list-available", stdout);
  if (!Array.isArray(value.installed) || !Array.isArray(value.available)) {
    throw new Error("codex-plugin-list-available returned malformed plugin arrays");
  }
  const installedAzure = value.installed.filter(
    (entry) => plainObject(entry) && entry.pluginId === "azure@gravit-cloud",
  );
  const availableAzure = value.available.filter(
    (entry) => plainObject(entry) && entry.pluginId === "azure@gravit-cloud",
  );
  if (installedAzure.length !== 0 || availableAzure.length !== 1) {
    throw new Error("codex-plugin-list-available must contain one uninstalled Azure record");
  }
  const azure = availableAzure[0];
  if (
    azure.name !== "azure"
    || azure.marketplaceName !== "gravit-cloud"
    || azure.installed !== false
  ) {
    throw new Error("codex-plugin-list-available returned the wrong Azure disposition");
  }
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
  const claudePackage = resolve(repository, "node_modules/@anthropic-ai/claude-code");
  const codexPackage = resolve(repository, "node_modules/@openai/codex");
  const claudeNative = assertRepositoryFile(
    repository,
    resolve(claudePackage, "bin/claude.exe"),
    "Claude native client",
    claudePackage,
  );
  const codexEntry = assertRepositoryFile(
    repository,
    resolve(codexPackage, "bin/codex.js"),
    "Codex JavaScript entrypoint",
    codexPackage,
  );

  const claudeEnv = isolatedEnvironment(
    parentEnv,
    createClientDirectory(temporary, "claude"),
  );
  claudeEnv.CLAUDE_CONFIG_DIR = resolve(claudeEnv.HOME, "claude-config");
  mkdirSync(claudeEnv.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
  const codexEnv = isolatedEnvironment(
    parentEnv,
    createClientDirectory(temporary, "codex"),
  );
  codexEnv.CODEX_HOME = resolve(codexEnv.HOME, "codex-state");
  mkdirSync(codexEnv.CODEX_HOME, { recursive: true, mode: 0o700 });
  return [
    {
      name: "claude-validate",
      command: claudeNative,
      args: ["plugin", "validate", "--strict", repository],
      env: claudeEnv,
      expectedPattern: /(?:^|\n).*Validation passed(?:\n|$)/u,
    },
    {
      name: "codex-marketplace-add",
      command: process.execPath,
      args: [codexEntry, "plugin", "marketplace", "add", repository, "--json"],
      env: codexEnv,
      validateStdout(stdout) {
        validateCodexMarketplace(stdout, repository);
      },
    },
    {
      name: "codex-plugin-list-available",
      command: process.execPath,
      args: [
        codexEntry,
        "plugin",
        "list",
        "--marketplace",
        "gravit-cloud",
        "--available",
        "--json",
      ],
      env: codexEnv,
      validateStdout: validateCodexAvailable,
    },
  ].map(freezeSpec);
}

function failureOutput(output) {
  if (output.length <= ERROR_OUTPUT_LIMIT) return output;
  return output.slice(0, ERROR_OUTPUT_LIMIT) + "\n[output truncated]";
}

function commandFailure(spec, detail, output = "") {
  const suffix = output.length > 0 ? "\n" + failureOutput(output) : "";
  return new Error(spec.name + " failed: " + detail + suffix);
}

function signalProcessTree(child, signal) {
  if (process.platform !== "win32" && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return;
    }
  }
  // Stock Node has no Windows process-group/job-object API. The safest portable
  // fallback terminates the direct child; CI's outer job timeout owns descendants.
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

export function runBoundedCommand(spec, {
  repositoryRoot,
  timeoutMs = CLIENT_TIMEOUT_MS,
  terminationGraceMs = TERMINATION_GRACE_MS,
  finalizationGraceMs = FINALIZATION_GRACE_MS,
  maxOutputBytes = CLIENT_MAX_OUTPUT_BYTES,
  spawnProcess = spawn,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnProcess(spec.command, spec.args, {
        cwd: repositoryRoot,
        env: spec.env,
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      rejectPromise(commandFailure(spec, error.message || String(error)));
      return;
    }

    let settled = false;
    let terminationReason;
    let outputBytes = 0;
    const stdout = [];
    const stderr = [];
    let timeoutTimer;
    let terminationTimer;
    let finalizationTimer;

    function clearTimers() {
      clearTimeout(timeoutTimer);
      clearTimeout(terminationTimer);
      clearTimeout(finalizationTimer);
    }

    function outputText() {
      return Buffer.concat(stdout).toString("utf8") + Buffer.concat(stderr).toString("utf8");
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimers();
      if (error) rejectPromise(error);
      else resolvePromise(result);
    }

    function forceFinish() {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref?.();
      finish(commandFailure(spec, terminationReason, outputText()));
    }

    function beginTermination(reason) {
      if (terminationReason) return;
      terminationReason = reason;
      try {
        signalProcessTree(child, "SIGTERM");
      } catch {}
      terminationTimer = setTimeout(() => {
        try {
          signalProcessTree(child, "SIGKILL");
        } catch {}
        finalizationTimer = setTimeout(forceFinish, finalizationGraceMs);
      }, terminationGraceMs);
    }

    function collect(target, chunk) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) target.push(bytes.subarray(0, remaining));
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) {
        beginTermination("exceeded the " + maxOutputBytes + " byte output limit");
      }
    }

    child.stdout?.on("data", (chunk) => collect(stdout, chunk));
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.once("error", (error) => {
      finish(commandFailure(spec, error.message || String(error), outputText()));
    });
    child.once("close", (status, signal) => {
      const result = {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (terminationReason) {
        finish(commandFailure(spec, terminationReason, result.stdout + result.stderr));
      } else {
        finish(undefined, result);
      }
    });

    timeoutTimer = setTimeout(() => {
      beginTermination("timed out after " + timeoutMs + "ms");
    }, timeoutMs);
  });
}

function validateResult(spec, result) {
  if (!result || typeof result !== "object") {
    throw commandFailure(spec, "process runner returned no result");
  }
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const output = stdout + stderr;
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
  if (spec.validateStdout) {
    try {
      spec.validateStdout(stdout);
    } catch (error) {
      throw commandFailure(spec, error.message || String(error), output);
    }
  }
}

export async function runClientSmoke(repositoryRoot, {
  parentEnv = process.env,
  commandRunner = runBoundedCommand,
} = {}) {
  const temporaryRoot = realpathSync(mkdtempSync(
    resolve(tmpdir(), "gravit-client-smoke-"),
  ));
  const completed = [];
  try {
    const repository = assertRealDirectory(repositoryRoot, "repository root");
    const commands = smokeCommands({
      repositoryRoot: repository,
      temporaryRoot,
      parentEnv,
    });
    for (const spec of commands) {
      const result = await commandRunner(spec, {
        repositoryRoot: repository,
        timeoutMs: CLIENT_TIMEOUT_MS,
        maxOutputBytes: CLIENT_MAX_OUTPUT_BYTES,
      });
      validateResult(spec, result);
      completed.push(spec.name);
    }
    return Object.freeze({
      completed: Object.freeze(completed.slice()),
      recoveryPath: temporaryRoot,
    });
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    error.recoveryPath = temporaryRoot;
    if (!error.message.includes(temporaryRoot)) {
      error.message += "\nRetained client state: " + temporaryRoot;
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await runClientSmoke(repositoryRoot);
  console.log("Client smoke tests passed. Retained state: " + result.recoveryPath);
}
