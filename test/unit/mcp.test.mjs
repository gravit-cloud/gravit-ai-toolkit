import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inventorySource } from "../../scripts/lib/inventory.mjs";
import { normalizeMcp, writeMcpConfig } from "../../scripts/lib/mcp.mjs";

const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/complete-plugin");
const exactPin = { "@fixture/mcp": "1.4.2" };
const knownShellAndWrapperCommands = [
  "/bin/ash",
  "/bin/bash",
  "/bin/csh",
  "/bin/dash",
  "/usr/bin/elvish",
  "/usr/bin/fish",
  "/usr/bin/ion",
  "/bin/ksh",
  "/bin/mksh",
  "/usr/bin/nu",
  "/usr/bin/osh",
  "/bin/rc",
  "/bin/sh",
  "/bin/tcsh",
  "/usr/bin/xonsh",
  "/usr/bin/ysh",
  "/bin/zsh",
  "busybox",
  "cmd.exe",
  "powershell.exe",
  "pwsh",
  "toybox",
  "wsl.exe",
  "/opt/wrappers/ASH.SH",
  "/opt/wrappers/XONSH.PY",
  "/opt/wrappers/YSH.RB",
  "/opt/wrappers/BUSYBOX.PL",
];

function inlineRecord(inline) {
  return { sourceFormat: "inline", inline };
}

function wrappedServer(server, id = "fixture", wrapper = "mcpServers") {
  return inlineRecord({ [wrapper]: { [id]: server } });
}

function npxServer(args, command = "npx") {
  return { command, args };
}

test("unwraps mcpServers and replaces latest with the exact catalog pin", () => {
  const record = inventorySource({ sourceRoot: fixture }).components
    .find((component) => component.type === "mcp");

  assert.deepEqual(normalizeMcp({ record, runtimePins: exactPin }), [{
    id: "fixture",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@fixture/mcp@1.4.2", "server", "start"],
    env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" },
    runtimeDependencies: { "@fixture/mcp": "1.4.2" },
  }]);
});

test("normalizes direct and mcp_servers maps in code-point server-ID order", () => {
  const direct = inlineRecord({
    alpha: { command: "node", args: ["alpha.mjs"] },
    Zulu: { command: "node", args: ["zulu.mjs"] },
  });
  const snakeWrapped = wrappedServer(
    { command: "node", args: ["server.mjs"] },
    "snake",
    "mcp_servers",
  );

  assert.deepEqual(normalizeMcp({ record: direct }), [
    {
      id: "Zulu",
      transport: "stdio",
      command: "node",
      args: ["zulu.mjs"],
      env: {},
      runtimeDependencies: {},
    },
    {
      id: "alpha",
      transport: "stdio",
      command: "node",
      args: ["alpha.mjs"],
      env: {},
      runtimeDependencies: {},
    },
  ]);
  assert.equal(normalizeMcp({ record: snakeWrapped })[0].id, "snake");
});

test("rejects latest when the catalog does not provide an exact pin", () => {
  const record = inventorySource({ sourceRoot: fixture }).components
    .find((component) => component.type === "mcp");
  assert.throws(
    () => normalizeMcp({ record, runtimePins: {} }),
    /unpinned MCP package @fixture\/mcp/,
  );
});

test("rejects prototype-like package specs before pin lookup", () => {
  const record = wrappedServer(npxServer(["constructor"]));
  assert.throws(
    () => normalizeMcp({ record, runtimePins: {} }),
    /invalid npx MCP package: constructor/,
  );
});

test("rejects an exact source version that disagrees with the catalog pin", () => {
  const record = wrappedServer(npxServer(["-y", "@fixture/mcp@1.4.1"]));
  assert.throws(
    () => normalizeMcp({ record, runtimePins: exactPin }),
    /MCP package version disagrees with catalog pin: @fixture\/mcp/,
  );
});

test("rejects non-exact catalog runtime pins", () => {
  const record = wrappedServer(npxServer(["@fixture/mcp"]));
  for (const version of [
    "latest",
    "next",
    "*",
    "^1.4.2",
    "~1.4.2",
    "1.4.x",
    "1.4",
    "01.4.2",
    "1.04.2",
    "1.4.02",
    "1.4.2-alpha..1",
    "1.4.2-alpha.01",
  ]) {
    assert.throws(
      () => normalizeMcp({ record, runtimePins: { "@fixture/mcp": version } }),
      /MCP catalog pin must be an exact semver: @fixture\/mcp/,
    );
  }
});

test("rejects floating source selectors other than the supported latest migration", () => {
  for (const version of ["next", "*", "^1.4.2", "~1.4.2", "1.4.x", "1.4"]) {
    const record = wrappedServer(npxServer(["@fixture/mcp@" + version]));
    assert.throws(
      () => normalizeMcp({ record, runtimePins: exactPin }),
      /floating MCP package version: @fixture\/mcp@/,
    );
  }
});

test("supports only unambiguous npx and npx.cmd yes-option forms", () => {
  for (const [command, prefix] of [
    ["npx", []],
    ["npx", ["-y"]],
    ["npx.cmd", ["--yes"]],
    ["npx.cmd", ["--yes", "--"]],
  ]) {
    const record = wrappedServer(npxServer([...prefix, "@fixture/mcp", "serve"], command));
    const normalized = normalizeMcp({ record, runtimePins: exactPin })[0];
    assert.equal(normalized.command, command);
    assert.deepEqual(normalized.args, [...prefix, "@fixture/mcp@1.4.2", "serve"]);
  }
});

test("detects supported npx commands by POSIX and Windows basename", () => {
  for (const command of [
    "/usr/local/bin/npx",
    "/opt/Program Files/bin/NPX.EXE",
    "C:\\Program Files\\nodejs\\npx.cmd",
    "C:\\tools\\nPx.BaT",
    "C:\\tools\\NPX.PS1",
  ]) {
    assert.deepEqual(normalizeMcp({
      record: wrappedServer(npxServer(["-y", "@fixture/mcp@latest"], command)),
      runtimePins: exactPin,
    })[0], {
      id: "fixture",
      transport: "stdio",
      command,
      args: ["-y", "@fixture/mcp@1.4.2"],
      env: {},
      runtimeDependencies: { "@fixture/mcp": "1.4.2" },
    });
  }
});

test("normalizes executable suffixes and aliases before blocking dynamic launchers", () => {
  for (const command of [
    "C:\\tools\\bunx.cmd",
    "C:\\tools\\UVX.CMD",
    "C:\\tools\\env.cmd",
    "C:\\tools\\bash.cmd",
    "C:\\tools\\pnpx.exe",
    "C:\\tools\\yarnpkg.exe",
    "/opt/tools/BuNx.CoM",
    "/opt/tools/yarnpkg.PS1",
    "corepack.bat",
    "pipx.com",
  ]) {
    assert.throws(
      () => normalizeMcp({
        record: wrappedServer({ command, args: ["@fixture/mcp"] }),
      }),
      /unsupported dynamic MCP launcher/,
    );
  }
});

test("rejects ambiguous Win32 aliases and device paths in normalizer and writer", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-windows-paths-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const commands = [
    "npx.cmd.",
    "npm.exe.",
    "docker.exe.",
    "C:\\tools.\\fixture-server.exe",
    "C:\\tools. \\fixture-server.exe",
    "C:/tools/npm.exe.",
    "C:tools/nPx.CmD.",
    "c:tools /fixture.exe",
    "D:tools./fixture.exe",
    "e:/tools./fixture.exe",
    "F:\\tools./fixture.exe",
    "g:tools\\fixture.exe.",
    "\\\\server\\share\\docker.exe.",
    "//server/share/npx.cmd.",
    "/\\server/share./fixture.exe",
    "\\/server\\share./fixture.exe",
    "\\\\?\\C:\\tools\\npx.cmd",
    "\\\\.\\C:\\tools\\docker.exe",
    "\\\\?/C:\\tools\\fixture.exe",
    "//?\\C:\\tools\\fixture.exe",
    "\\\\./C:/tools/fixture.exe",
    "//.\\C:/tools/fixture.exe",
    "\\??\\C:\\tools\\fixture.exe",
    "\\\\??\\C:\\tools\\fixture.exe",
    "\\Device\\HarddiskVolume1\\tools\\fixture.exe",
    "\\Global??\\C:\\tools\\fixture.exe",
    "\\DosDevices\\C:\\tools\\fixture.exe",
    "/??\\C:\\tools\\fixture.exe",
    "/dEvIcE\\HarddiskVolume1\\tools\\fixture.exe",
    "/Global??\\C:/tools/fixture.exe",
    "/DosDevices\\C:\\tools\\fixture.exe",
    "//Device\\HarddiskVolume1\\tools\\fixture.exe",
    "//Device/HarddiskVolume1/tools/fixture.exe",
    "////dEvIcE\\\\HarddiskVolume1//tools\\fixture.exe",
    "/\\/GLOBAL??\\\\C:\\tools\\fixture.exe",
    "/??//C:/tools/fixture.exe",
    "/Device//HarddiskVolume1/tools/fixture.exe",
    "/gLoBaL??//C:/tools/fixture.exe",
    "/DOSDEVICES//C:/tools/fixture.exe",
  ];

  for (const [index, command] of commands.entries()) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command }) }),
      /Windows (?:executable path|device namespace)/,
    );

    const filePath = resolve(root, String(index), ".mcp.json");
    assert.throws(
      () => writeMcpConfig({
        servers: [{
          id: "fixture",
          transport: "stdio",
          command,
          args: [],
          env: {},
          runtimeDependencies: {},
        }],
        target: "claude",
        filePath,
      }),
      /Windows (?:executable path|device namespace)/,
    );
    assert.equal(existsSync(filePath), false);
  }
});

test("keeps true POSIX paths and unambiguous static Windows commands usable", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-posix-paths-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const commands = [
    "/opt/tools/npx.cmd.",
    "/opt/tools/npm.exe.",
    "/opt/tools/docker.exe.",
    "/opt/tools/fixture-server.",
    "/opt/tools/fixture-server.sh",
    "/opt/tools/fixture-server.py",
    "/opt/name:tools/npx.cmd.",
    "tools:name/fixture.exe.",
    "/opt/C:tools/fixture.exe.",
    "/??/fixture.exe.",
    "/Device/fixture.exe.",
    "/device/fixture.exe.",
    "/Global??/fixture.exe.",
    "/DosDevices/fixture.exe.",
    "C:tools/fixture-server.exe",
    "d:/tools/fixture-server.exe",
    "E:\\tools/fixture-server.exe",
  ];

  for (const [index, command] of commands.entries()) {
    const server = normalizeMcp({
      record: wrappedServer({ command, args: ["serve"] }),
    })[0];
    assert.equal(server.command, command);
    assert.deepEqual(server.runtimeDependencies, {});

    const filePath = resolve(root, String(index), ".mcp.json");
    writeMcpConfig({ servers: [server], target: "claude", filePath });
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).mcpServers.fixture.command, command);
  }
});

test("rejects the known shell and wrapper policy in normalizer and writer", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-shell-policy-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));

  for (const [index, command] of knownShellAndWrapperCommands.entries()) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command }) }),
      /unsupported dynamic MCP launcher/,
    );

    const filePath = resolve(root, String(index), ".mcp.json");
    assert.throws(
      () => writeMcpConfig({
        servers: [{
          id: "fixture",
          transport: "stdio",
          command,
          args: [],
          env: {},
          runtimeDependencies: {},
        }],
        target: "claude",
        filePath,
      }),
      /unsupported dynamic MCP launcher/,
    );
    assert.equal(existsSync(filePath), false);
  }
});

test("rejects command strings that embed executable arguments", () => {
  for (const command of [
    "npx -y",
    "docker run",
    "bash -lc",
    "node server.mjs",
    '"C:\\tools\\npx.cmd" -y',
    '"npx"',
    "'docker'",
    "`bash`",
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command }) }),
      /executable token (?:contains an unsafe quote|must not embed arguments)/,
    );
  }
});

test("allows safe static commands after portable stem normalization", () => {
  for (const command of [
    "fixture-server",
    "/opt/Program Files/bin/fixture-server.exe",
    "C:\\tools\\fixture-server.CMD",
  ]) {
    assert.deepEqual(normalizeMcp({
      record: wrappedServer({ command, args: ["serve"] }),
    })[0], {
      id: "fixture",
      transport: "stdio",
      command,
      args: ["serve"],
      env: {},
      runtimeDependencies: {},
    });
  }
});

test("rejects package-manager launchers and shell wrappers by command basename", () => {
  for (const [command, args] of [
    ["/usr/bin/npm", ["exec", "@fixture/mcp"]],
    ["C:\\Program Files\\nodejs\\npm.cmd", ["run", "mcp"]],
    ["/usr/local/bin/pnpm", ["dlx", "@fixture/mcp"]],
    ["yarn", ["dlx", "@fixture/mcp"]],
    ["bunx", ["@fixture/mcp"]],
    ["uvx", ["fixture-mcp"]],
    ["/bin/sh", ["-c", "npx @fixture/mcp"]],
    ["C:\\Program Files\\Git\\bin\\bash.exe", ["-lc", "npx @fixture/mcp"]],
    ["/usr/bin/env", ["npx", "@fixture/mcp"]],
    ["cmd.exe", ["/c", "npx @fixture/mcp"]],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", [
      "-Command",
      "npx @fixture/mcp",
    ]],
    ["pwsh", ["-Command", "npx @fixture/mcp"]],
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command, args }) }),
      /unsupported dynamic MCP launcher/,
    );
  }
});

test("rejects invalid and prototype-like runtime pin package names", () => {
  for (const name of [
    "not a package",
    "@scope/pkg@latest",
    "constructor",
    "prototype",
    "__proto__",
  ]) {
    assert.throws(
      () => normalizeMcp({
        record: wrappedServer({ command: "node" }),
        runtimePins: Object.fromEntries([[name, "1.4.2"]]),
      }),
      /invalid MCP catalog package name/,
    );
  }
});

test("npx parsing cannot confuse option values with packages or execute extra packages", () => {
  for (const args of [
    ["--cache", "/tmp/cache", "@fixture/mcp"],
    ["--package", "@fixture/extra", "@fixture/mcp"],
    ["--package=@fixture/extra", "@fixture/mcp"],
    ["-p", "@fixture/extra", "@fixture/mcp"],
    ["-yq", "@fixture/mcp"],
    ["--yes=true", "@fixture/mcp"],
    ["-y", "-y", "@fixture/mcp"],
    ["@fixture/mcp", "-p=@fixture/extra"],
    ["@fixture/mcp", "--call", "other-command"],
    ["@fixture/mcp", "-c", "other-command"],
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer(npxServer(args)), runtimePins: exactPin }),
      /unsupported npx MCP option/,
    );
  }
});

test("rejects malformed MCP roots and wrapper shapes", () => {
  for (const inline of [
    null,
    [],
    {},
    { mcpServers: [] },
    { mcpServers: null },
    { mcpServers: {}, extra: {} },
    { mcpServers: {}, mcp_servers: {} },
  ]) {
    assert.throws(
      () => normalizeMcp({ record: inlineRecord(inline) }),
      /MCP (source|server map|wrapper)/,
    );
  }
  assert.throws(
    () => normalizeMcp({ record: { sourceFormat: "unknown", inline: {} } }),
    /unsupported MCP source format/,
  );
});

test("rejects unsafe server IDs and malformed server objects", () => {
  for (const id of ["", "with space", "with/slash", ".hidden", "-flag"]){
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "node" }, id) }),
      /invalid MCP server ID/,
    );
  }
  for (const server of [null, [], "node", { command: "node", unknown: true }]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer(server) }),
      /MCP server fixture must be an object|unknown MCP server field: fixture\.unknown/,
    );
  }
});

test("normalizes commandless HTTP and SSE servers without undefined fields", () => {
  const record = inlineRecord({
    sse: { type: "sse", url: "https://example.invalid/events" },
    http: { url: "https://example.invalid/mcp" },
  });

  assert.deepEqual(normalizeMcp({ record }), [
    {
      id: "http",
      transport: "http",
      env: {},
      url: "https://example.invalid/mcp",
      runtimeDependencies: {},
    },
    {
      id: "sse",
      transport: "sse",
      env: {},
      url: "https://example.invalid/events",
      runtimeDependencies: {},
    },
  ]);
});

test("rejects unsupported transports and mixed remote or stdio shapes", () => {
  for (const server of [
    { type: "websocket", url: "https://example.invalid/mcp" },
    { type: "stdio", command: "node", url: "https://example.invalid/mcp" },
    { type: "http", url: "https://example.invalid/mcp", command: "node" },
    { type: "sse" },
    { type: "http", url: "file:///tmp/mcp.sock" },
    { type: "http", url: "https://user:secret-value@example.invalid/mcp" },
    { command: "" },
    {},
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer(server) }),
      /unsupported MCP transport|stdio MCP server|remote MCP server|remote MCP URL|MCP command/,
    );
  }
});

test("rejects non-string commands, arguments, URLs, and malformed env maps", () => {
  for (const server of [
    { command: 42 },
    { command: "node", args: "server.mjs" },
    { command: "node", args: ["server.mjs", 42] },
    { command: "node", env: [] },
    { command: "node", env: { TOKEN: 42 } },
    { type: "http", url: 42 },
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer(server) }),
      /MCP command|MCP args|MCP env|remote MCP server|remote MCP URL/,
    );
  }
});

test("accepts only empty or same-name env placeholders", () => {
  assert.deepEqual(normalizeMcp({
    record: wrappedServer({
      command: "node",
      env: { OPTIONAL: "", TOKEN: "${TOKEN}" },
    }),
  })[0].env, { OPTIONAL: "", TOKEN: "${TOKEN}" });

  for (const env of [
    { TOKEN: "secret-value" },
    { TOKEN: "${OTHER}" },
    { "INVALID-NAME": "${INVALID-NAME}" },
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "node", env }) }),
      /MCP env must not embed a value|invalid MCP env name/,
    );
  }

  const prototypeEnv = JSON.parse('{"__proto__":"${__proto__}"}');
  assert.deepEqual(normalizeMcp({
    record: wrappedServer({ command: "node", env: prototypeEnv }),
  })[0].env, prototypeEnv);
});

test("accepts only immutable container image digests", () => {
  const digest = "a".repeat(64);
  const record = inlineRecord({
    docker: {
      command: "docker",
      args: [
        "run", "-i", "--rm", "-e", "TOKEN",
        "registry.example.invalid/fixture/mcp@sha256:" + digest,
      ],
      env: { TOKEN: "${TOKEN}" },
    },
    podman: {
      command: "podman",
      args: ["run", "--", "ghcr.io/fixture/mcp@sha256:" + digest],
    },
    container: {
      command: "container",
      args: ["run", "ghcr.io/fixture/mcp@sha256:" + digest],
    },
  });

  const normalized = normalizeMcp({ record });
  assert.deepEqual(normalized.map(({ id }) => id), ["container", "docker", "podman"]);
  assert.deepEqual(normalized.find(({ id }) => id === "docker").args, [
    "run", "-i", "--rm", "-e", "TOKEN",
    "registry.example.invalid/fixture/mcp@sha256:" + digest,
  ]);
  assert.match(normalized.find(({ id }) => id === "podman").args.at(-1), /@sha256:[a-f0-9]{64}$/);
});

test("rejects every container tag plus unversioned and malformed image references", () => {
  const images = [
    "ghcr.io/fixture/mcp",
    "ghcr.io/fixture/mcp:latest",
    "ghcr.io/fixture/mcp:next",
    "ghcr.io/fixture/mcp:stable",
    "ghcr.io/fixture/mcp:1",
    "ghcr.io/fixture/mcp:1.4",
    "ghcr.io/fixture/mcp:1.4.x",
    "ghcr.io/fixture/mcp:*",
    "ghcr.io/fixture/mcp:1.4.2",
    "ghcr.io/fixture/mcp:v1.4.2-beta.1",
    "ghcr.io/fixture/mcp:01.4.2",
    "ghcr.io/fixture/mcp:1.4.2-alpha..1",
    "ghcr.io/fixture/mcp@sha256:abc",
    "ghcr.io/fixture/mcp:1.4.2@sha256:" + "d".repeat(64),
  ];
  for (const image of images) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "docker", args: ["run", image] }) }),
      /container image must use an immutable sha256 digest/,
    );
  }
});

test("container parsing does not mistake option values for the image or embed env values", () => {
  const image = "fixture/mcp@sha256:" + "b".repeat(64);
  assert.doesNotThrow(() => normalizeMcp({
    record: wrappedServer({
      command: "docker",
      args: ["run", "--name", "fixture", "--platform=linux/amd64", image],
    }),
  }));
  assert.throws(
    () => normalizeMcp({
      record: wrappedServer({
        command: "docker",
        args: ["run", "--env", "TOKEN=secret-value", image],
      }),
    }),
    /container env must not embed a value/,
  );
  assert.throws(
    () => normalizeMcp({ record: wrappedServer({ command: "docker", args: ["pull", image] }) }),
    /container MCP command must use run/,
  );
});

test("detects container runtimes by POSIX and Windows command basename", () => {
  for (const command of [
    "/usr/bin/docker",
    "C:\\tools\\DOCKER.CMD",
    "C:\\Program Files\\RedHat\\podman.exe",
    "C:\\tools\\podman.CmD",
    "/usr/local/bin/container",
    "C:\\tools\\container.BAT",
  ]) {
    assert.throws(
      () => normalizeMcp({
        record: wrappedServer({
          command,
          args: ["run", "ghcr.io/fixture/mcp:latest"],
        }),
      }),
      /container image must use an immutable sha256 digest/,
    );
  }
});

test("accepts suffixed container runtimes only with an immutable image digest", () => {
  const image = "ghcr.io/fixture/mcp@sha256:" + "e".repeat(64);
  for (const command of ["docker.exe", "podman.cmd", "container.com"]) {
    assert.equal(normalizeMcp({
      record: wrappedServer({ command, args: ["run", image] }),
    })[0].command, command);
  }
});

test("rejects nested dynamic launchers in container commands and entrypoints", () => {
  const image = "ghcr.io/fixture/mcp@sha256:" + "c".repeat(64);
  for (const args of [
    ["run", image, "npx", "@fixture/mcp"],
    ["run", image, "/usr/bin/npm", "exec", "@fixture/mcp"],
    ["run", image, "cmd.exe", "/c", "npx @fixture/mcp"],
    ["run", image, "docker", "run", image],
    ["run", "--entrypoint", "npx", image],
    ["run", "--entrypoint=/bin/sh", image],
    ["run", "--entrypoint", "C:\\tools\\uvx.cmd", image],
    ["run", image, "C:\\tools\\YARNPKG.EXE", "fixture"],
  ]) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "docker", args }) }),
      /container MCP must not launch nested runtime/,
    );
  }
});

test("rejects ambiguous Win32 aliases in nested container commands and entrypoints", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-nested-windows-paths-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const image = "ghcr.io/fixture/mcp@sha256:" + "f".repeat(64);
  const invocations = [
    ["run", "--entrypoint", "npx.cmd.", image],
    ["run", image, "npm.exe."],
    ["run", image, "docker.exe."],
    ["run", "--entrypoint", "\\\\server\\share\\npx.cmd.", image],
    ["run", image, "\\\\?\\C:\\tools\\npx.cmd"],
    ["run", "--entrypoint", "C:tools/nPx.CmD.", image],
    ["run", image, "c:tools /fixture.exe"],
    ["run", "--entrypoint", "D:/tools./fixture.exe", image],
    ["run", image, "e:tools\\fixture.exe."],
    ["run", "--entrypoint", "\\\\?/C:\\tools\\fixture.exe", image],
    ["run", image, "//?\\C:\\tools\\fixture.exe"],
    ["run", "--entrypoint", "\\Global??\\C:\\tools\\fixture.exe", image],
    ["run", "--entrypoint", "/??\\C:\\tools\\fixture.exe", image],
    ["run", image, "/Device\\HarddiskVolume1\\tools\\fixture.exe"],
    ["run", "--entrypoint=/Global??\\C:\\tools\\fixture.exe", image],
    ["run", image, "//dOsDeViCeS\\C:\\tools\\fixture.exe"],
    ["run", "--entrypoint", "/??//C:/tools/fixture.exe", image],
    ["run", "--entrypoint=/Device//HarddiskVolume1/tools/fixture.exe", image],
    ["run", image, "/Global??//C:/tools/fixture.exe"],
    ["run", image, "/DosDevices//C:/tools/fixture.exe"],
  ];

  for (const [index, args] of invocations.entries()) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "docker", args }) }),
      /Windows (?:executable path|device namespace)/,
    );

    const filePath = resolve(root, String(index), ".mcp.json");
    assert.throws(
      () => writeMcpConfig({
        servers: [{
          id: "fixture",
          transport: "stdio",
          command: "docker",
          args,
          env: {},
          runtimeDependencies: {},
        }],
        target: "codex",
        filePath,
      }),
      /Windows (?:executable path|device namespace)/,
    );
    assert.equal(existsSync(filePath), false);
  }
});

test("validates hyphen-leading nested executable paths in every container position", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-hyphen-nested-invalid-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const image = "ghcr.io/fixture/mcp@sha256:" + "8".repeat(64);
  const command = "-tools\\npx.cmd.";
  const invocations = [
    ["run", "--entrypoint", command, image],
    ["run", "--entrypoint=" + command, image],
    ["run", image, command],
  ];

  for (const [index, args] of invocations.entries()) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "docker", args }) }),
      /Windows (?:executable path|device namespace)/,
    );

    const filePath = resolve(root, String(index), ".mcp.json");
    assert.throws(
      () => writeMcpConfig({
        servers: [{
          id: "fixture",
          transport: "stdio",
          command: "docker",
          args,
          env: {},
          runtimeDependencies: {},
        }],
        target: "claude",
        filePath,
      }),
      /Windows (?:executable path|device namespace)/,
    );
    assert.equal(existsSync(filePath), false);
  }
});

test("allows a hyphen-leading static executable in every nested container position", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-hyphen-nested-static-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const image = "ghcr.io/fixture/mcp@sha256:" + "7".repeat(64);
  const invocations = [
    ["run", "--entrypoint", "-c", image],
    ["run", "--entrypoint=-c", image],
    ["run", image, "-c"],
  ];

  for (const [index, args] of invocations.entries()) {
    const server = normalizeMcp({
      record: wrappedServer({ command: "docker", args }),
    })[0];
    assert.deepEqual(server.args, args);

    const filePath = resolve(root, String(index), ".mcp.json");
    writeMcpConfig({ servers: [server], target: "codex", filePath });
    assert.deepEqual(
      JSON.parse(readFileSync(filePath, "utf8")).mcp_servers.fixture.args,
      args,
    );
  }
});

test("rejects every known shell and wrapper in nested container positions", () => {
  const image = "ghcr.io/fixture/mcp@sha256:" + "9".repeat(64);

  for (const command of knownShellAndWrapperCommands) {
    for (const args of [
      ["run", "--entrypoint", command, image],
      ["run", image, command],
    ]) {
      assert.throws(
        () => normalizeMcp({ record: wrappedServer({ command: "docker", args }) }),
        /container MCP must not launch nested runtime/,
      );
    }
  }
});

test("writes deterministic Claude and Codex configs without empty host fields", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-writer-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const servers = normalizeMcp({
    record: inlineRecord({
      remote: { type: "sse", url: "https://example.invalid/events" },
      local: { command: "node", args: ["server.mjs"], env: { TOKEN: "${TOKEN}" } },
      empty: { command: "node" },
    }),
  }).reverse();
  const claudePath = resolve(root, "claude/.mcp.json");
  const codexPath = resolve(root, "codex/.mcp.json");

  writeMcpConfig({ servers, target: "claude", filePath: claudePath });
  writeMcpConfig({ servers, target: "codex", filePath: codexPath });

  assert.equal(readFileSync(claudePath, "utf8"), `{
  "mcpServers": {
    "empty": {
      "command": "node"
    },
    "local": {
      "args": [
        "server.mjs"
      ],
      "command": "node",
      "env": {
        "TOKEN": "\${TOKEN}"
      }
    },
    "remote": {
      "type": "sse",
      "url": "https://example.invalid/events"
    }
  }
}
`);
  assert.deepEqual(JSON.parse(readFileSync(codexPath, "utf8")), {
    mcp_servers: {
      empty: { command: "node" },
      local: { command: "node", args: ["server.mjs"], env: { TOKEN: "${TOKEN}" } },
      remote: { type: "sse", url: "https://example.invalid/events" },
    },
  });
  assert.doesNotMatch(readFileSync(codexPath, "utf8"), /undefined/);
});

test("writer rejects unsupported targets, duplicate IDs, and malformed server input", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-writer-invalid-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = resolve(root, ".mcp.json");
  const server = normalizeMcp({ record: wrappedServer({ command: "node" }) })[0];

  assert.throws(
    () => writeMcpConfig({ servers: [server], target: "openclaw", filePath }),
    /unsupported MCP target: openclaw/,
  );
  assert.throws(
    () => writeMcpConfig({ servers: [server, server], target: "claude", filePath }),
    /duplicate MCP server ID: fixture/,
  );
  assert.throws(
    () => writeMcpConfig({ servers: {}, target: "claude", filePath }),
    /MCP servers must be an array/,
  );

  const remote = normalizeMcp({
    record: wrappedServer({ type: "http", url: "https://example.invalid/mcp" }),
  })[0];
  assert.throws(
    () => writeMcpConfig({
      servers: [{ ...remote, command: "node" }],
      target: "claude",
      filePath,
    }),
    /remote MCP server must not define command or args/,
  );
  assert.throws(
    () => writeMcpConfig({
      servers: [{ ...server, url: "https://example.invalid/mcp" }],
      target: "claude",
      filePath,
    }),
    /stdio MCP server must not define a URL/,
  );
});

test("writer validates every executable before creating any output", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-writer-atomic-validation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = resolve(root, "nested/.mcp.json");
  const safe = normalizeMcp({ record: wrappedServer({ command: "node" }, "safe") })[0];
  const unsafe = {
    id: "unsafe",
    transport: "stdio",
    command: '"npx"',
    args: ["@fixture/mcp@1.4.2"],
    env: {},
    runtimeDependencies: { "@fixture/mcp": "1.4.2" },
  };

  assert.throws(
    () => writeMcpConfig({ servers: [safe, unsafe], target: "claude", filePath }),
    /unsafe quote/,
  );
  assert.equal(existsSync(filePath), false);
});

for (const { name, server, error } of [
  {
    name: "file URLs",
    server: {
      id: "remote",
      transport: "http",
      env: {},
      url: "file:///tmp/mcp.sock",
      runtimeDependencies: {},
    },
    error: /remote MCP URL must use HTTP or HTTPS/,
  },
  {
    name: "URL userinfo",
    server: {
      id: "remote",
      transport: "sse",
      env: {},
      url: "https://user:secret-value@example.invalid/events",
      runtimeDependencies: {},
    },
    error: /remote MCP URL must not embed credentials/,
  },
  {
    name: "floating npx packages",
    server: {
      id: "local",
      transport: "stdio",
      command: "npx",
      args: ["@fixture/mcp@latest"],
      env: {},
      runtimeDependencies: { "@fixture/mcp": "1.4.2" },
    },
    error: /floating MCP package version/,
  },
  {
    name: "missing npx runtime dependencies",
    server: {
      id: "local",
      transport: "stdio",
      command: "npx",
      args: ["@fixture/mcp@1.4.2"],
      env: {},
      runtimeDependencies: {},
    },
    error: /unpinned MCP package @fixture\/mcp/,
  },
  {
    name: "unexpected static runtime dependencies",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: {},
      runtimeDependencies: { "@fixture/mcp": "1.4.2" },
    },
    error: /MCP runtime dependencies disagree with command/,
  },
  {
    name: "floating runtime dependency pins",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: {},
      runtimeDependencies: { "@fixture/mcp": "latest" },
    },
    error: /MCP catalog pin must be an exact semver/,
  },
  {
    name: "non-object runtime dependencies",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: ["server.mjs"],
      env: {},
      runtimeDependencies: [],
    },
    error: /MCP runtime pins must be an object/,
  },
  {
    name: "literal env values",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: [],
      env: { TOKEN: "secret-value" },
      runtimeDependencies: {},
    },
    error: /MCP env must not embed a value/,
  },
  {
    name: "non-string args",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: [42],
      env: {},
      runtimeDependencies: {},
    },
    error: /MCP args must be an array of strings/,
  },
  {
    name: "unsupported transports",
    server: {
      id: "remote",
      transport: "websocket",
      env: {},
      url: "https://example.invalid/mcp",
      runtimeDependencies: {},
    },
    error: /unsupported MCP transport/,
  },
  {
    name: "unknown normalized fields",
    server: {
      id: "local",
      transport: "stdio",
      command: "node",
      args: [],
      env: {},
      runtimeDependencies: {},
      headers: { Authorization: "placeholder" },
    },
    error: /unknown normalized MCP server field/,
  },
]) {
  test("writer rejects " + name + " before emitting a config", (context) => {
    const root = mkdtempSync(resolve(tmpdir(), "mcp-writer-gate-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const filePath = resolve(root, ".mcp.json");

    assert.throws(
      () => writeMcpConfig({ servers: [server], target: "claude", filePath }),
      error,
    );
    assert.equal(existsSync(filePath), false);
  });
}

test("writer accepts a canonically normalized pinned npx server", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "mcp-writer-pinned-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = resolve(root, ".mcp.json");
  const server = normalizeMcp({
    record: wrappedServer(npxServer(["-y", "@fixture/mcp@latest"])),
    runtimePins: exactPin,
  })[0];

  writeMcpConfig({ servers: [server], target: "claude", filePath });

  assert.deepEqual(JSON.parse(readFileSync(filePath, "utf8")), {
    mcpServers: {
      fixture: {
        command: "npx",
        args: ["-y", "@fixture/mcp@1.4.2"],
      },
    },
  });
});
