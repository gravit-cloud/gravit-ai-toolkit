import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import {
  runBoundedCommand,
  runClientSmoke,
  smokeCommands,
} from "../../scripts/smoke-clients.mjs";

const SECRET_SENTINELS = Object.freeze({
  ANTHROPIC_API_KEY: "anthropic-secret-sentinel",
  AZURE_CLIENT_SECRET: "azure-secret-sentinel",
  GITHUB_TOKEN: "github-secret-sentinel",
  HTTP_PROXY: "http://proxy-secret-sentinel.invalid",
  OPENAI_API_KEY: "openai-secret-sentinel",
  SSH_AUTH_SOCK: "/tmp/ssh-secret-sentinel.sock",
});
const EXPECTED_AZURE_SKILLS = [
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
];
const FIXTURE_AZURE_VERSION = "1.2.9-gravit.2";

function sandbox(context, prefix) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), prefix)));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function file(path, contents = "fixture\n", mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
}

function fixtureRepository(context) {
  const repositoryRoot = sandbox(context, "smoke-clients-repository-");
  file(
    resolve(repositoryRoot, "node_modules/@anthropic-ai/claude-code/bin/claude.exe"),
    "fixture native client\n",
    0o755,
  );
  file(
    resolve(repositoryRoot, "node_modules/@openai/codex/bin/codex.js"),
    "export {};\n",
  );
  file(resolve(repositoryRoot, ".claude-plugin/marketplace.json"), JSON.stringify({
    name: "gravit-cloud",
    plugins: [{ name: "azure", source: "./plugins/azure/targets/claude" }],
  }));
  file(resolve(repositoryRoot, ".agents/plugins/marketplace.json"), JSON.stringify({
    name: "gravit-cloud",
    plugins: [{
      name: "azure",
      source: { source: "local", path: "./plugins/azure/targets/codex" },
    }],
  }));
  file(
    resolve(repositoryRoot, "plugins/azure/targets/claude/.claude-plugin/plugin.json"),
    JSON.stringify({ name: "azure", version: FIXTURE_AZURE_VERSION }),
  );
  file(
    resolve(repositoryRoot, "plugins/azure/targets/codex/.codex-plugin/plugin.json"),
    JSON.stringify({ name: "azure", version: FIXTURE_AZURE_VERSION }),
  );
  return repositoryRoot;
}

function commandFixture(context, parentEnv = {}) {
  const repositoryRoot = fixtureRepository(context);
  const temporaryRoot = sandbox(context, "smoke-clients-state-");
  const commands = smokeCommands({ repositoryRoot, temporaryRoot, parentEnv });
  return { commands, repositoryRoot, temporaryRoot };
}

function successfulResult(spec, repositoryRoot) {
  const claudeInstallPath = resolve(
    spec.env.CLAUDE_CONFIG_DIR || "",
    "plugins/cache/gravit-cloud/azure",
    FIXTURE_AZURE_VERSION,
  );
  const codexInstallPath = resolve(
    spec.env.CODEX_HOME || "",
    "plugins/cache/gravit-cloud/azure",
    FIXTURE_AZURE_VERSION,
  );
  const stdout = {
    "claude-validate": "Validating marketplace manifest\n✔ Validation passed\n",
    "claude-marketplace-add": "✔ Successfully added marketplace: gravit-cloud\n",
    "claude-plugin-install": "✔ Successfully installed plugin: azure@gravit-cloud\n",
    "claude-plugin-list-installed": JSON.stringify([{
      id: "azure@gravit-cloud",
      version: FIXTURE_AZURE_VERSION,
      scope: "user",
      enabled: true,
      installPath: claudeInstallPath,
      mcpServers: {
        azure: { command: "npx", args: ["-y", "@azure/mcp@2.0.5", "server", "start"] },
      },
      errors: [],
    }]),
    "claude-plugin-components": [
      `azure ${FIXTURE_AZURE_VERSION}`,
      `  Skills (34)  ${EXPECTED_AZURE_SKILLS.join(", ")}`,
      "  MCP servers (1)  azure  (tool schemas resolved at runtime; not counted)",
      "",
    ].join("\n"),
    "codex-marketplace-add": JSON.stringify({
      marketplaceName: "gravit-cloud",
      installedRoot: repositoryRoot,
      alreadyAdded: false,
    }),
    "codex-plugin-install": JSON.stringify({
      pluginId: "azure@gravit-cloud",
      name: "azure",
      marketplaceName: "gravit-cloud",
      version: FIXTURE_AZURE_VERSION,
      installedPath: codexInstallPath,
      authPolicy: "ON_INSTALL",
    }),
    "codex-plugin-list-installed": JSON.stringify({
      installed: [{
        pluginId: "azure@gravit-cloud",
        name: "azure",
        marketplaceName: "gravit-cloud",
        version: FIXTURE_AZURE_VERSION,
        installed: true,
        enabled: true,
        source: {
          source: "local",
          path: resolve(repositoryRoot, "plugins/azure/targets/codex"),
        },
        marketplaceSource: { sourceType: "local", source: repositoryRoot },
        installPolicy: "AVAILABLE",
        authPolicy: "ON_INSTALL",
      }],
      available: [],
    }),
    "codex-plugin-components": [
      JSON.stringify({ id: 1, result: { codexHome: spec.env.CODEX_HOME } }),
      JSON.stringify({
        id: 2,
        result: {
          plugin: {
            marketplaceName: "gravit-cloud",
            marketplacePath: resolve(repositoryRoot, ".agents/plugins/marketplace.json"),
            summary: {
              id: "azure@gravit-cloud",
              localVersion: FIXTURE_AZURE_VERSION,
              installed: true,
              enabled: true,
            },
            skills: EXPECTED_AZURE_SKILLS.map((name) => ({
              name: "azure:" + name,
              enabled: true,
              path: resolve(repositoryRoot, "plugins/azure/targets/codex/skills", name, "SKILL.md"),
            })),
            mcpServers: ["azure"],
          },
        },
      }),
    ].join("\n") + "\n",
  }[spec.name];
  assert.ok(stdout, "missing fake output for " + spec.name);
  return { status: 0, signal: null, stdout, stderr: "" };
}

function retainForTest(context, resultOrError) {
  assert.equal(typeof resultOrError.recoveryPath, "string");
  context.after(() => rmSync(resultOrError.recoveryPath, {
    recursive: true,
    force: true,
  }));
}

test("uses the trusted Node entrypoints and never inherits a fake-node PATH", (context) => {
  const fakeBin = sandbox(context, "smoke-clients-fake-path-");
  file(resolve(fakeBin, "node"), "#!/bin/sh\nexit 99\n", 0o755);
  const { commands, repositoryRoot } = commandFixture(context, {
    PATH: fakeBin + delimiter + "/parent/bin",
    Path: fakeBin,
  });
  const trustedPath = [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter);
  const claudeNative = resolve(
    repositoryRoot,
    "node_modules/@anthropic-ai/claude-code/bin/claude.exe",
  );
  const codexEntry = resolve(repositoryRoot, "node_modules/@openai/codex/bin/codex.js");

  assert.equal(commands[0].command, claudeNative);
  assert.equal(commands[0].args[0], "plugin");
  for (const command of commands.filter(({ name }) => name.startsWith("codex-"))) {
    assert.equal(command.command, process.execPath);
    assert.equal(command.args[0], codexEntry);
  }
  for (const command of commands) {
    assert.equal(command.env.PATH, trustedPath);
    assert.equal("Path" in command.env, false);
    assert.equal(command.env.PATH.includes(fakeBin), false);
  }
});

test("installs Azure and verifies components in fresh Claude and Codex processes", (context) => {
  const { commands } = commandFixture(context);
  assert.deepEqual(commands.map(({ name }) => name), [
    "claude-validate",
    "claude-marketplace-add",
    "claude-plugin-install",
    "claude-plugin-list-installed",
    "claude-plugin-components",
    "codex-marketplace-add",
    "codex-plugin-install",
    "codex-plugin-list-installed",
    "codex-plugin-components",
  ]);
  const clientArgs = commands.map(({ args }) => args.slice(1));
  assert.equal(clientArgs.some((args) => args.includes("--runtime")), false);
  assert.equal(clientArgs.some((args) => args.includes("setup") || args.includes("enable")), false);
  assert.deepEqual(commands.find(({ name }) => name === "claude-plugin-install").args, [
    "plugin", "install", "azure@gravit-cloud", "--scope", "user",
  ]);
  assert.deepEqual(commands.find(({ name }) => name === "codex-plugin-install").args.slice(1), [
    "plugin", "add", "azure@gravit-cloud", "--json",
  ]);
  const components = commands.find(({ name }) => name === "codex-plugin-components");
  assert.deepEqual(components.args.slice(1), ["app-server", "--stdio"]);
  assert.equal(components.jsonLineProtocol.initial.method, "initialize");
  assert.deepEqual(
    components.jsonLineProtocol.afterInitialize.map(({ method }) => method),
    ["initialized", "plugin/read"],
  );
});

test("passes only allowlisted variables into separate retained client homes", (context) => {
  const { commands, temporaryRoot } = commandFixture(context, {
    LANG: "C.UTF-8",
    TZ: "UTC",
    ...SECRET_SENTINELS,
  });
  for (const command of commands) {
    assert.equal(command.env.LANG, "C.UTF-8");
    assert.equal(command.env.TZ, "UTC");
    for (const secret of Object.keys(SECRET_SENTINELS)) {
      assert.equal(secret in command.env, false, command.name + " leaked " + secret);
    }
    assert.equal(command.env.HOME.startsWith(temporaryRoot + "/"), true);
    assert.equal(command.env.XDG_CONFIG_HOME.startsWith(command.env.HOME + "/"), true);
    assert.equal(command.env.TMPDIR.startsWith(command.env.HOME + "/"), true);
  }
  const homes = new Set(commands.map(({ env }) => env.HOME));
  assert.equal(homes.size, 2);
});

test("runs fake clients asynchronously and retains the exact smoke root", async (context) => {
  const repositoryRoot = fixtureRepository(context);
  const observed = [];
  const result = await runClientSmoke(repositoryRoot, {
    parentEnv: { PATH: "/attacker/bin", GITHUB_TOKEN: "never-forward" },
    async commandRunner(spec, options) {
      observed.push({ options, spec });
      return successfulResult(spec, repositoryRoot);
    },
  });
  retainForTest(context, result);

  assert.deepEqual(result.completed, [
    "claude-validate",
    "claude-marketplace-add",
    "claude-plugin-install",
    "claude-plugin-list-installed",
    "claude-plugin-components",
    "codex-marketplace-add",
    "codex-plugin-install",
    "codex-plugin-list-installed",
    "codex-plugin-components",
  ]);
  assert.equal(observed.length, 9);
  assert.equal(existsSync(result.recoveryPath), true);
  assert.equal(existsSync(resolve(result.recoveryPath, "claude/home")), true);
  for (const { options, spec } of observed) {
    assert.equal(options.repositoryRoot, repositoryRoot);
    assert.equal(options.timeoutMs, 45_000);
    assert.equal(options.maxOutputBytes, 1024 * 1024);
    assert.equal("GITHUB_TOKEN" in spec.env, false);
  }
});

test("retains the smoke root on command failure and bounds diagnostics", async (context) => {
  const repositoryRoot = fixtureRepository(context);
  let caught;
  await assert.rejects(runClientSmoke(repositoryRoot, {
    async commandRunner() {
      return {
        status: 9,
        signal: null,
        stdout: "sensitive-looking-client-output".repeat(10_000),
        stderr: "",
      };
    },
  }), (error) => {
    caught = error;
    return /status 9/.test(error.message) && /output truncated/.test(error.message);
  });
  retainForTest(context, caught);
  assert.equal(existsSync(caught.recoveryPath), true);
  assert.ok(caught.message.length < 20_000);
});

test("strict JSON validators reject malformed and false-positive client output", async (context) => {
  const badOutputs = [
    ["codex-marketplace-add", 'prefix {"marketplaceName":"gravit-cloud"}'],
    ["codex-marketplace-add", JSON.stringify({
      marketplaceName: "gravit-cloud",
      installedRoot: "/different/repository",
      alreadyAdded: false,
    })],
    ["claude-plugin-list-installed", JSON.stringify([])],
    ["claude-plugin-components", "azure 1.2.9-gravit.2\n  Skills (33)  azure-cost\n"],
    ["codex-plugin-install", JSON.stringify({
      pluginId: "azure@gravit-cloud",
      name: "azure",
      marketplaceName: "gravit-cloud",
      version: "9.9.9",
      installedPath: "/wrong/path",
      authPolicy: "ON_INSTALL",
    })],
    ["codex-plugin-list-installed", JSON.stringify({ installed: [], available: [] })],
    ["codex-plugin-components", [
      JSON.stringify({ id: 1, result: {} }),
      JSON.stringify({ id: 2, result: {
        plugin: {
          marketplaceName: "gravit-cloud",
          summary: {
            id: "azure@gravit-cloud",
            localVersion: FIXTURE_AZURE_VERSION,
            installed: true,
            enabled: true,
          },
          skills: EXPECTED_AZURE_SKILLS.map((name) => ({ name: "azure:" + name, enabled: true })),
          mcpServers: [],
        },
      } }),
    ].join("\n")],
  ];

  for (const [badName, badOutput] of badOutputs) {
    const repositoryRoot = fixtureRepository(context);
    let caught;
    await assert.rejects(runClientSmoke(repositoryRoot, {
      async commandRunner(spec) {
        const result = successfulResult(spec, repositoryRoot);
        if (spec.name === badName) result.stdout = badOutput;
        return result;
      },
    }), (error) => {
      caught = error;
      return new RegExp(badName + " failed").test(error.message);
    });
    retainForTest(context, caught);
  }
});

async function processIsGone(pid) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  return false;
}

test("keeps protocol input open until the final response arrives", async (context) => {
  const root = sandbox(context, "smoke-clients-protocol-");
  const helper = resolve(root, "protocol-helper.mjs");
  file(helper, [
    'import { createInterface } from "node:readline";',
    'const input = createInterface({ input: process.stdin });',
    'input.on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");',
    '  if (message.id === 2) setTimeout(() => {',
    '    process.stdout.write(JSON.stringify({ id: 2, result: { recognized: true } }) + "\\n");',
    '  }, 25);',
    '});',
    'process.stdin.on("end", () => process.exit(0));',
    "",
  ].join("\n"));

  const result = await runBoundedCommand({
    name: "protocol-helper",
    command: process.execPath,
    args: [helper],
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) },
    jsonLineProtocol: {
      initial: { id: 1, method: "initialize", params: {} },
      afterInitialize: [
        { method: "initialized" },
        { id: 2, method: "plugin/read", params: {} },
      ],
    },
  }, {
    repositoryRoot: root,
    timeoutMs: 1_000,
    terminationGraceMs: 100,
    finalizationGraceMs: 100,
    maxOutputBytes: 1024,
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /"id":2/);
  assert.match(result.stdout, /"recognized":true/);
});

test("hard timeout kills a SIGTERM-resistant POSIX process group", {
  skip: process.platform === "win32",
}, async (context) => {
  const root = sandbox(context, "smoke-clients-timeout-");
  const pidFile = resolve(root, "pids.json");
  const helper = resolve(root, "hung-helper.mjs");
  file(helper, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'process.on("SIGTERM", () => {});',
    'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });',
    'writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));',
    'setInterval(() => {}, 1000);',
    "",
  ].join("\n"));
  const started = Date.now();

  await assert.rejects(runBoundedCommand({
    name: "hung-helper",
    command: process.execPath,
    args: [helper, pidFile],
    env: { PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) },
  }, {
    repositoryRoot: root,
    timeoutMs: 100,
    terminationGraceMs: 100,
    finalizationGraceMs: 100,
    maxOutputBytes: 1024,
  }), /timed out/);
  assert.ok(Date.now() - started < 1_500);

  const pids = JSON.parse(readFileSync(pidFile, "utf8"));
  context.after(() => {
    try { process.kill(-pids.parent, "SIGKILL"); } catch {}
  });
  assert.equal(await processIsGone(pids.parent), true);
  assert.equal(await processIsGone(pids.child), true);
});
