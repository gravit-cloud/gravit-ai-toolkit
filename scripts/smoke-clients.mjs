#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
const EXPECTED_AZURE_SKILLS = Object.freeze([
  "airunway-aks-setup",
  "appinsights-instrumentation",
  "azure-ai",
  "azure-aigateway",
  "azure-app-onboard",
  "azure-app-onboard-prereq",
  "azure-cloud-migrate",
  "azure-compliance",
  "azure-compute",
  "azure-cost",
  "azure-deploy",
  "azure-diagnostics",
  "azure-enterprise-infra-planner",
  "azure-kubernetes",
  "azure-kubernetes-app-deploy",
  "azure-kubernetes-automatic-readiness",
  "azure-kusto",
  "azure-messaging",
  "azure-prepare",
  "azure-quotas",
  "azure-reliability",
  "azure-resource-lookup",
  "azure-resource-visualizer",
  "azure-storage",
  "azure-upgrade",
  "azure-validate",
  "capacity",
  "customize",
  "deploy-model",
  "entra-agent-id",
  "entra-app-registration",
  "finetuning",
  "microsoft-foundry",
  "preset",
  "python-appservice-deploy",
]);

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
  if (spec.jsonLineProtocol) {
    Object.freeze(spec.jsonLineProtocol.afterInitialize);
    Object.freeze(spec.jsonLineProtocol);
  }
  return Object.freeze(spec);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonValue(name, stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(name + " returned malformed JSON", { cause: error });
  }
  return value;
}

function parseJsonStdout(name, stdout) {
  const value = parseJsonValue(name, stdout);
  if (!plainObject(value)) throw new Error(name + " JSON root must be an object");
  return value;
}

function pluginVersion(repository, target) {
  const manifestPath = assertRepositoryFile(
    repository,
    resolve(repository, `plugins/azure/targets/${target}/.${target}-plugin/plugin.json`),
    `Azure ${target} plugin manifest`,
  );
  const manifest = parseJsonStdout(`Azure ${target} plugin manifest`, readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "azure" || typeof manifest.version !== "string") {
    throw new Error(`Azure ${target} plugin manifest has the wrong identity`);
  }
  return manifest.version;
}

function validateClaudeInstalled(stdout, expectedVersion, expectedInstallPath) {
  const value = parseJsonValue("claude-plugin-list-installed", stdout);
  if (!Array.isArray(value)) {
    throw new Error("claude-plugin-list-installed JSON root must be an array");
  }
  const matches = value.filter((entry) => plainObject(entry) && entry.id === "azure@gravit-cloud");
  if (matches.length !== 1) {
    throw new Error("claude-plugin-list-installed must contain one installed Azure record");
  }
  const azure = matches[0];
  const server = azure.mcpServers?.azure;
  if (
    azure.version !== expectedVersion
    || azure.scope !== "user"
    || azure.enabled !== true
    || azure.installPath !== expectedInstallPath
    || !plainObject(server)
    || server.command !== "npx"
    || JSON.stringify(server.args) !== JSON.stringify([
      "-y", "@azure/mcp@2.0.5", "server", "start",
    ])
    || (Array.isArray(azure.errors) && azure.errors.length !== 0)
  ) {
    throw new Error("claude-plugin-list-installed returned an unhealthy Azure installation");
  }
}

function validateClaudeComponents(stdout, expectedVersion) {
  if (!new RegExp(`^azure ${expectedVersion.replaceAll(".", "\\.")}$`, "mu").test(stdout)) {
    throw new Error("claude-plugin-components returned the wrong Azure version");
  }
  const skillsPattern = new RegExp(
    `^\\s*Skills \\(${EXPECTED_AZURE_SKILLS.length}\\)\\s{2}(.+)$`,
    "mu",
  );
  const skills = skillsPattern.exec(stdout)?.[1]?.split(", ");
  if (JSON.stringify(skills) !== JSON.stringify(EXPECTED_AZURE_SKILLS)) {
    throw new Error("claude-plugin-components did not recognize all Azure skills");
  }
  if (!/^\s*MCP servers \(1\)\s{2}azure(?:\s|$)/mu.test(stdout)) {
    throw new Error("claude-plugin-components did not recognize the Azure MCP server");
  }
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

function validateCodexInstall(stdout, expectedVersion, expectedInstallPath) {
  const value = parseJsonStdout("codex-plugin-install", stdout);
  if (
    value.pluginId !== "azure@gravit-cloud"
    || value.name !== "azure"
    || value.marketplaceName !== "gravit-cloud"
    || value.version !== expectedVersion
    || value.installedPath !== expectedInstallPath
    || value.authPolicy !== "ON_INSTALL"
  ) {
    throw new Error("codex-plugin-install returned the wrong Azure installation");
  }
}

function validateCodexInstalled(stdout, expectedVersion, repository) {
  const value = parseJsonStdout("codex-plugin-list-installed", stdout);
  if (!Array.isArray(value.installed) || !Array.isArray(value.available)) {
    throw new Error("codex-plugin-list-installed returned malformed plugin arrays");
  }
  const installedAzure = value.installed.filter(
    (entry) => plainObject(entry) && entry.pluginId === "azure@gravit-cloud",
  );
  if (installedAzure.length !== 1 || value.available.length !== 0) {
    throw new Error("codex-plugin-list-installed must contain one installed Azure record");
  }
  const azure = installedAzure[0];
  if (
    azure.name !== "azure"
    || azure.marketplaceName !== "gravit-cloud"
    || azure.version !== expectedVersion
    || azure.installed !== true
    || azure.enabled !== true
    || azure.source?.source !== "local"
    || azure.source?.path !== resolve(repository, "plugins/azure/targets/codex")
    || azure.marketplaceSource?.sourceType !== "local"
    || azure.marketplaceSource?.source !== repository
  ) {
    throw new Error("codex-plugin-list-installed returned the wrong Azure disposition");
  }
}

function validateCodexComponents(stdout, expectedVersion, expectedMarketplacePath) {
  const messages = stdout.trim().split("\n").map((line) => parseJsonStdout(
    "codex-plugin-components protocol line",
    line,
  ));
  const responses = messages.filter((message) => message.id === 2);
  if (responses.length !== 1 || responses[0].error) {
    throw new Error("codex-plugin-components did not return one successful plugin/read response");
  }
  const plugin = responses[0].result?.plugin;
  const skillNames = plugin?.skills?.map((skill) => skill?.name);
  if (
    !plainObject(plugin)
    || plugin.marketplaceName !== "gravit-cloud"
    || plugin.marketplacePath !== expectedMarketplacePath
    || plugin.summary?.id !== "azure@gravit-cloud"
    || plugin.summary?.localVersion !== expectedVersion
    || plugin.summary?.installed !== true
    || plugin.summary?.enabled !== true
    || JSON.stringify(skillNames) !== JSON.stringify(
      EXPECTED_AZURE_SKILLS.map((name) => "azure:" + name),
    )
    || plugin.skills.some((skill) => skill.enabled !== true)
    || JSON.stringify(plugin.mcpServers) !== JSON.stringify(["azure"])
  ) {
    throw new Error("codex-plugin-components did not recognize the installed Azure components");
  }
}

export function smokeCommands({
  repositoryRoot,
  temporaryRoot,
  parentEnv = process.env,
}) {
  const repository = assertRealDirectory(repositoryRoot, "repository root");
  const temporary = assertRealDirectory(temporaryRoot, "client smoke temporary root");
  const claudeMarketplace = assertRepositoryFile(
    repository,
    resolve(repository, ".claude-plugin/marketplace.json"),
    "Claude marketplace",
  );
  const codexMarketplace = assertRepositoryFile(
    repository,
    resolve(repository, ".agents/plugins/marketplace.json"),
    "Codex marketplace",
  );
  const claudeVersion = pluginVersion(repository, "claude");
  const codexVersion = pluginVersion(repository, "codex");
  if (claudeVersion !== codexVersion) {
    throw new Error("Azure client projections disagree on their version");
  }
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
  const claudeInstallPath = resolve(
    claudeEnv.CLAUDE_CONFIG_DIR,
    "plugins/cache/gravit-cloud/azure",
    claudeVersion,
  );
  const codexInstallPath = resolve(
    codexEnv.CODEX_HOME,
    "plugins/cache/gravit-cloud/azure",
    codexVersion,
  );
  return [
    {
      name: "claude-validate",
      command: claudeNative,
      args: ["plugin", "validate", "--strict", repository],
      env: claudeEnv,
      expectedPattern: /(?:^|\n).*Validation passed(?:\n|$)/u,
    },
    {
      name: "claude-marketplace-add",
      command: claudeNative,
      args: ["plugin", "marketplace", "add", repository, "--scope", "user"],
      env: claudeEnv,
      expectedPattern: /Successfully added marketplace: gravit-cloud/u,
    },
    {
      name: "claude-plugin-install",
      command: claudeNative,
      args: ["plugin", "install", "azure@gravit-cloud", "--scope", "user"],
      env: claudeEnv,
      expectedPattern: /Successfully installed plugin: azure@gravit-cloud/u,
    },
    {
      name: "claude-plugin-list-installed",
      command: claudeNative,
      args: ["plugin", "list", "--json"],
      env: claudeEnv,
      validateStdout(stdout) {
        validateClaudeInstalled(stdout, claudeVersion, claudeInstallPath);
      },
    },
    {
      name: "claude-plugin-components",
      command: claudeNative,
      args: ["plugin", "details", "azure@gravit-cloud"],
      env: claudeEnv,
      validateStdout(stdout) {
        validateClaudeComponents(stdout, claudeVersion);
      },
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
      name: "codex-plugin-install",
      command: process.execPath,
      args: [codexEntry, "plugin", "add", "azure@gravit-cloud", "--json"],
      env: codexEnv,
      validateStdout(stdout) {
        validateCodexInstall(stdout, codexVersion, codexInstallPath);
      },
    },
    {
      name: "codex-plugin-list-installed",
      command: process.execPath,
      args: [
        codexEntry,
        "plugin",
        "list",
        "--marketplace",
        "gravit-cloud",
        "--json",
      ],
      env: codexEnv,
      validateStdout(stdout) {
        validateCodexInstalled(stdout, codexVersion, repository);
      },
    },
    {
      name: "codex-plugin-components",
      command: process.execPath,
      args: [codexEntry, "app-server", "--stdio"],
      env: codexEnv,
      jsonLineProtocol: {
        initial: {
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "gravit-client-smoke", version: "1.0.0" },
            capabilities: { experimentalApi: true },
          },
        },
        afterInitialize: [
          { method: "initialized" },
          {
            id: 2,
            method: "plugin/read",
            params: { pluginName: "azure", marketplacePath: codexMarketplace },
          },
        ],
      },
      validateStdout(stdout) {
        validateCodexComponents(stdout, codexVersion, codexMarketplace);
      },
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
        stdio: [spec.jsonLineProtocol ? "pipe" : "ignore", "pipe", "pipe"],
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
    let protocolBuffer = "";
    let protocolInitialized = false;
    let protocolComplete = false;
    const protocolPendingResponseIds = new Set(
      spec.jsonLineProtocol?.afterInitialize
        .filter((message) => Object.prototype.hasOwnProperty.call(message, "id"))
        .map((message) => message.id) || [],
    );

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

    function inspectProtocol(chunk) {
      if (!spec.jsonLineProtocol || protocolComplete || terminationReason || settled) return;
      protocolBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      while (protocolBuffer.includes("\n")) {
        const newline = protocolBuffer.indexOf("\n");
        const line = protocolBuffer.slice(0, newline);
        protocolBuffer = protocolBuffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          beginTermination("returned malformed JSON-line protocol output");
          return;
        }
        if (!protocolInitialized) {
          if (message.id !== spec.jsonLineProtocol.initial.id) continue;
          protocolInitialized = true;
          if (message.error) {
            protocolComplete = true;
            child.stdin.end();
            return;
          }
          for (const followup of spec.jsonLineProtocol.afterInitialize) {
            child.stdin.write(JSON.stringify(followup) + "\n");
          }
          if (protocolPendingResponseIds.size === 0) {
            protocolComplete = true;
            child.stdin.end();
            return;
          }
          continue;
        }
        if (protocolPendingResponseIds.delete(message.id)
          && protocolPendingResponseIds.size === 0) {
          protocolComplete = true;
          child.stdin.end();
          return;
        }
      }
    }

    child.stdout?.on("data", (chunk) => {
      collect(stdout, chunk);
      inspectProtocol(chunk);
    });
    child.stderr?.on("data", (chunk) => collect(stderr, chunk));
    child.stdin?.on("error", (error) => {
      if (!settled) beginTermination("protocol input failed: " + (error.message || String(error)));
    });
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
    if (spec.jsonLineProtocol) {
      child.stdin.write(JSON.stringify(spec.jsonLineProtocol.initial) + "\n");
    }
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
