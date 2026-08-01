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
  file(resolve(repositoryRoot, "node_modules/openclaw/openclaw.mjs"), "export {};\n");
  file(resolve(repositoryRoot, ".claude-plugin/marketplace.json"), "{}\n");
  file(resolve(repositoryRoot, ".agents/plugins/marketplace.json"), "{}\n");
  file(
    resolve(repositoryRoot, "plugins/azure/targets/openclaw/.codex-plugin/plugin.json"),
    '{"name":"azure"}\n',
  );
  return repositoryRoot;
}

function commandFixture(context, parentEnv = {}) {
  const repositoryRoot = fixtureRepository(context);
  const temporaryRoot = sandbox(context, "smoke-clients-state-");
  const commands = smokeCommands({ repositoryRoot, temporaryRoot, parentEnv });
  return { commands, repositoryRoot, temporaryRoot };
}

function successfulResult(spec) {
  const stdout = {
    "claude-validate": "Validating marketplace manifest\n✔ Validation passed\n",
    "codex-marketplace-add": JSON.stringify({
      marketplaceName: "gravit-cloud",
      installedRoot: spec.args.at(-2),
      alreadyAdded: false,
    }),
    "codex-plugin-list-available": JSON.stringify({
      installed: [],
      available: [{
        pluginId: "azure@gravit-cloud",
        name: "azure",
        marketplaceName: "gravit-cloud",
        installed: false,
      }],
    }),
    "openclaw-disable-all": "Updated plugins.enabled.\n",
    "openclaw-install": "Installed plugin: azure\n",
    "openclaw-disable-azure": 'Disabled plugin "azure".\n',
    "openclaw-list": JSON.stringify({
      plugins: [{
        id: "azure",
        format: "bundle",
        bundleFormat: "codex",
        enabled: false,
        status: "disabled",
      }],
    }),
    "openclaw-inspect": JSON.stringify({
      plugin: {
        id: "azure",
        format: "bundle",
        bundleFormat: "codex",
        enabled: false,
        activated: false,
        status: "disabled",
      },
    }),
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
  const openclawEntry = resolve(repositoryRoot, "node_modules/openclaw/openclaw.mjs");

  assert.equal(commands[0].command, claudeNative);
  assert.equal(commands[0].args[0], "plugin");
  for (const command of commands.filter(({ name }) => name.startsWith("codex-"))) {
    assert.equal(command.command, process.execPath);
    assert.equal(command.args[0], codexEntry);
  }
  for (const command of commands.filter(({ name }) => name.startsWith("openclaw-"))) {
    assert.equal(command.command, process.execPath);
    assert.equal(command.args[0], openclawEntry);
  }
  for (const command of commands) {
    assert.equal(command.env.PATH, trustedPath);
    assert.equal("Path" in command.env, false);
    assert.equal(command.env.PATH.includes(fakeBin), false);
  }
});

test("keeps the static/local command order without add, setup, enable, or runtime", (context) => {
  const { commands } = commandFixture(context);
  assert.deepEqual(commands.map(({ name }) => name), [
    "claude-validate",
    "codex-marketplace-add",
    "codex-plugin-list-available",
    "openclaw-disable-all",
    "openclaw-install",
    "openclaw-disable-azure",
    "openclaw-list",
    "openclaw-inspect",
  ]);
  const clientArgs = commands.map(({ args }) => args.slice(1));
  assert.equal(clientArgs.some((args) => args.includes("--runtime")), false);
  assert.equal(clientArgs.some((args) => args[0] === "plugin" && args[1] === "add"), false);
  assert.equal(clientArgs.some((args) => args.includes("setup") || args.includes("enable")), false);
  assert.equal(commands[4].args.at(-1), "--acknowledge-clawhub-risk");
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
  assert.equal(homes.size, 3);
});

test("runs fake clients asynchronously and retains the exact smoke root", async (context) => {
  const repositoryRoot = fixtureRepository(context);
  const observed = [];
  const result = await runClientSmoke(repositoryRoot, {
    parentEnv: { PATH: "/attacker/bin", GITHUB_TOKEN: "never-forward" },
    async commandRunner(spec, options) {
      observed.push({ options, spec });
      return successfulResult(spec);
    },
  });
  retainForTest(context, result);

  assert.deepEqual(result.completed, [
    "claude-validate",
    "codex-marketplace-add",
    "codex-plugin-list-available",
    "openclaw-disable-all",
    "openclaw-install",
    "openclaw-disable-azure",
    "openclaw-list",
    "openclaw-inspect",
  ]);
  assert.equal(observed.length, 8);
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
    ["codex-plugin-list-available", JSON.stringify({
      installed: [],
      available: [
        { pluginId: "azure@gravit-cloud", name: "azure", marketplaceName: "gravit-cloud", installed: false },
        { pluginId: "azure@gravit-cloud", name: "azure", marketplaceName: "gravit-cloud", installed: false },
      ],
    })],
    ["openclaw-list", JSON.stringify({
      plugins: [{ id: "azure", format: "bundle", bundleFormat: "codex", enabled: true, status: "loaded" }],
    })],
    ["openclaw-inspect", JSON.stringify({
      plugin: { id: "azure", format: "openclaw", bundleFormat: "codex", enabled: false, activated: false, status: "disabled" },
    })],
  ];

  for (const [badName, badOutput] of badOutputs) {
    const repositoryRoot = fixtureRepository(context);
    let caught;
    await assert.rejects(runClientSmoke(repositoryRoot, {
      async commandRunner(spec) {
        const result = successfulResult(spec);
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
