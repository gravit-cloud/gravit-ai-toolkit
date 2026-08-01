import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
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

function executable(path) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, "#!/usr/bin/env node\n", { mode: 0o755 });
  chmodSync(path, 0o755);
}

function fixtureRepository(context) {
  const repositoryRoot = sandbox(context, "smoke-clients-repository-");
  for (const name of ["claude", "codex", "openclaw"]) {
    executable(resolve(repositoryRoot, "node_modules/.bin", name));
  }
  mkdirSync(resolve(repositoryRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    resolve(repositoryRoot, ".claude-plugin/marketplace.json"),
    "{}\n",
  );
  mkdirSync(resolve(repositoryRoot, ".agents/plugins"), { recursive: true });
  writeFileSync(
    resolve(repositoryRoot, ".agents/plugins/marketplace.json"),
    "{}\n",
  );
  mkdirSync(
    resolve(repositoryRoot, "plugins/azure/targets/openclaw/.codex-plugin"),
    { recursive: true },
  );
  writeFileSync(
    resolve(
      repositoryRoot,
      "plugins/azure/targets/openclaw/.codex-plugin/plugin.json",
    ),
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
    "claude-validate": "Validation passed\n",
    "codex-marketplace-add": '{"marketplaceName":"gravit-cloud"}\n',
    "codex-plugin-list-available": '{"available":[{"pluginId":"azure@gravit-cloud"}]}\n',
    "openclaw-disable-all": "Updated plugins.enabled.\n",
    "openclaw-install": "Installed plugin: azure\n",
    "openclaw-disable-azure": 'Disabled plugin "azure".\n',
    "openclaw-list": '{"plugins":[{"id":"azure","enabled":false}]}\n',
    "openclaw-inspect": '{"plugin":{"id":"azure","bundleFormat":"codex","enabled":false,"status":"disabled"}}\n',
  }[spec.name];
  assert.ok(stdout, "missing fake output for " + spec.name);
  return { status: 0, signal: null, stdout, stderr: "" };
}

test("constructs only static/local client commands in their safety order", (context) => {
  const { commands, repositoryRoot } = commandFixture(context, {
    PATH: "/safe/bin",
  });

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
  assert.deepEqual(commands[0].args, [
    "plugin",
    "validate",
    "--strict",
    repositoryRoot,
  ]);
  assert.deepEqual(commands[1].args, [
    "plugin",
    "marketplace",
    "add",
    repositoryRoot,
    "--json",
  ]);
  assert.deepEqual(commands[2].args, [
    "plugin",
    "list",
    "--marketplace",
    "gravit-cloud",
    "--available",
    "--json",
  ]);
  assert.deepEqual(commands[3].args, [
    "--no-color",
    "config",
    "set",
    "plugins.enabled",
    "false",
    "--strict-json",
  ]);
  assert.deepEqual(commands[4].args.slice(0, 3), [
    "--no-color",
    "plugins",
    "install",
  ]);
  assert.equal(commands[4].args.at(-1), "--acknowledge-clawhub-risk");
  assert.deepEqual(commands[5].args, [
    "--no-color",
    "plugins",
    "disable",
    "azure",
  ]);
  assert.deepEqual(commands[6].args, [
    "--no-color",
    "plugins",
    "list",
    "--json",
  ]);
  assert.deepEqual(commands[7].args, [
    "--no-color",
    "plugins",
    "inspect",
    "azure",
    "--json",
  ]);
  assert.equal(
    commands.some(({ args }) => args.includes("--runtime")
      || (args[0] === "plugin" && args[1] === "add")),
    false,
  );
});

test("passes only allowlisted runtime variables into separate client homes", (context) => {
  const parentEnv = {
    PATH: "/safe/bin",
    LANG: "C.UTF-8",
    TZ: "UTC",
    ...SECRET_SENTINELS,
  };
  const { commands, temporaryRoot } = commandFixture(context, parentEnv);

  for (const command of commands) {
    assert.equal(command.env.PATH, "/safe/bin");
    assert.equal(command.env.LANG, "C.UTF-8");
    assert.equal(command.env.TZ, "UTC");
    for (const secret of Object.keys(SECRET_SENTINELS)) {
      assert.equal(secret in command.env, false, command.name + " leaked " + secret);
    }
    assert.equal(command.env.HOME.startsWith(temporaryRoot + "/"), true);
    assert.equal(command.env.XDG_CONFIG_HOME.startsWith(command.env.HOME + "/"), true);
    assert.equal(command.env.TMPDIR.startsWith(command.env.HOME + "/"), true);
  }

  const claude = commands.find(({ name }) => name === "claude-validate").env;
  const codex = commands.find(({ name }) => name.startsWith("codex-")).env;
  const openclaw = commands.find(({ name }) => name.startsWith("openclaw-")).env;
  assert.equal(claude.CLAUDE_CONFIG_DIR.startsWith(claude.HOME + "/"), true);
  assert.equal(codex.CODEX_HOME.startsWith(codex.HOME + "/"), true);
  assert.equal(openclaw.OPENCLAW_STATE_DIR.startsWith(openclaw.HOME + "/"), true);
  assert.equal(openclaw.OPENCLAW_CONFIG_PATH.startsWith(openclaw.HOME + "/"), true);
  assert.notEqual(claude.HOME, codex.HOME);
  assert.notEqual(codex.HOME, openclaw.HOME);
});

test("runs fake clients with bounded non-shell process options", (context) => {
  const repositoryRoot = fixtureRepository(context);
  const observed = [];

  const names = runClientSmoke(repositoryRoot, {
    parentEnv: { PATH: "/safe/bin", GITHUB_TOKEN: "never-forward" },
    processRunner(command, args, options) {
      const spec = smokeCommands({
        repositoryRoot,
        temporaryRoot: resolve(options.env.HOME, "../.."),
        parentEnv: { PATH: "/safe/bin" },
      }).find((candidate) => candidate.command === command
        && JSON.stringify(candidate.args) === JSON.stringify(args));
      assert.ok(spec, "unexpected fake invocation: " + command + " " + args.join(" "));
      observed.push({ options, spec });
      return successfulResult(spec);
    },
  });

  assert.deepEqual(names, [
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
  for (const { options } of observed) {
    assert.equal(options.cwd, repositoryRoot);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.timeout, 45_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal("GITHUB_TOKEN" in options.env, false);
  }
});

test("fails closed on spawn errors, signals, statuses, and output mismatches", (context) => {
  const cases = [
    [{ error: new Error("spawn denied"), status: null, signal: null }, /spawn denied/],
    [{ status: null, signal: "SIGTERM" }, /SIGTERM/],
    [{ status: 9, signal: null, stderr: "bad status" }, /status 9/],
    [{ status: 0, signal: null, stdout: "wrong output" }, /expected output/],
  ];

  for (const [result, expected] of cases) {
    const repositoryRoot = fixtureRepository(context);
    assert.throws(() => runClientSmoke(repositoryRoot, {
      parentEnv: { PATH: "/safe/bin" },
      processRunner() {
        return { stdout: "", stderr: "", ...result };
      },
    }), expected);
  }
});

test("bounds failure output before including it in an error", (context) => {
  const repositoryRoot = fixtureRepository(context);
  const marker = "sensitive-looking-client-output";
  let caught;

  assert.throws(() => runClientSmoke(repositoryRoot, {
    parentEnv: { PATH: "/safe/bin" },
    processRunner() {
      return {
        status: 1,
        signal: null,
        stdout: marker.repeat(10_000),
        stderr: "",
      };
    },
  }), (error) => {
    caught = error;
    return /output truncated/.test(error.message);
  });
  assert.ok(caught.message.length < 20_000);
});

test("retains a replacement temp root and reports its recovery path", (context) => {
  const repositoryRoot = fixtureRepository(context);
  let replacement;
  let displaced;

  assert.throws(() => runClientSmoke(repositoryRoot, {
    parentEnv: { PATH: "/safe/bin" },
    processRunner(command, args, options) {
      const spec = smokeCommands({
        repositoryRoot,
        temporaryRoot: resolve(options.env.HOME, "../.."),
        parentEnv: { PATH: "/safe/bin" },
      }).find((candidate) => candidate.command === command
        && JSON.stringify(candidate.args) === JSON.stringify(args));
      if (spec.name === "openclaw-inspect") {
        replacement = resolve(options.env.HOME, "../..");
        displaced = replacement + "-displaced";
        renameSync(replacement, displaced);
        mkdirSync(replacement);
        writeFileSync(resolve(replacement, "foreign.txt"), "keep\n");
      }
      return successfulResult(spec);
    },
  }), (error) => {
    assert.equal(error.recoveryPath, replacement);
    return /ownership changed/.test(error.message);
  });

  assert.equal(existsSync(resolve(replacement, "foreign.txt")), true);
  assert.equal(existsSync(displaced), true);
  rmSync(replacement, { recursive: true, force: true });
  rmSync(displaced, { recursive: true, force: true });
});
