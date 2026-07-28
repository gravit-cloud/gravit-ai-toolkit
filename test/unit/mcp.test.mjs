import test from "node:test";
import assert from "node:assert/strict";
import {
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

test("does not resolve package pins through object prototypes", () => {
  const record = wrappedServer(npxServer(["constructor"]));
  assert.throws(
    () => normalizeMcp({ record, runtimePins: {} }),
    /unpinned MCP package constructor/,
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

test("accepts versioned container tags and immutable image digests", () => {
  const digest = "a".repeat(64);
  const record = inlineRecord({
    docker: {
      command: "docker",
      args: [
        "run", "-i", "--rm", "-e", "TOKEN",
        "registry.example.invalid/fixture/mcp:1.4.2",
      ],
      env: { TOKEN: "${TOKEN}" },
    },
    podman: {
      command: "podman",
      args: ["run", "--", "ghcr.io/fixture/mcp@sha256:" + digest],
    },
    container: {
      command: "container",
      args: ["run", "ghcr.io/fixture/mcp:v1.4.2-beta.1"],
    },
  });

  const normalized = normalizeMcp({ record });
  assert.deepEqual(normalized.map(({ id }) => id), ["container", "docker", "podman"]);
  assert.deepEqual(normalized.find(({ id }) => id === "docker").args, [
    "run", "-i", "--rm", "-e", "TOKEN",
    "registry.example.invalid/fixture/mcp:1.4.2",
  ]);
  assert.match(normalized.find(({ id }) => id === "podman").args.at(-1), /@sha256:[a-f0-9]{64}$/);
});

test("rejects unversioned, latest, floating, and malformed container image references", () => {
  const images = [
    "ghcr.io/fixture/mcp",
    "ghcr.io/fixture/mcp:latest",
    "ghcr.io/fixture/mcp:next",
    "ghcr.io/fixture/mcp:stable",
    "ghcr.io/fixture/mcp:1",
    "ghcr.io/fixture/mcp:1.4",
    "ghcr.io/fixture/mcp:1.4.x",
    "ghcr.io/fixture/mcp:*",
    "ghcr.io/fixture/mcp:01.4.2",
    "ghcr.io/fixture/mcp:1.4.2-alpha..1",
    "ghcr.io/fixture/mcp@sha256:abc",
  ];
  for (const image of images) {
    assert.throws(
      () => normalizeMcp({ record: wrappedServer({ command: "docker", args: ["run", image] }) }),
      /container image must use an exact version tag or sha256 digest/,
    );
  }
});

test("container parsing does not mistake option values for the image or embed env values", () => {
  assert.doesNotThrow(() => normalizeMcp({
    record: wrappedServer({
      command: "docker",
      args: ["run", "--name", "fixture", "--platform=linux/amd64", "fixture/mcp:1.4.2"],
    }),
  }));
  assert.throws(
    () => normalizeMcp({
      record: wrappedServer({
        command: "docker",
        args: ["run", "--env", "TOKEN=secret-value", "fixture/mcp:1.4.2"],
      }),
    }),
    /container env must not embed a value/,
  );
  assert.throws(
    () => normalizeMcp({ record: wrappedServer({ command: "docker", args: ["pull", "fixture/mcp:1.4.2"] }) }),
    /container MCP command must use run/,
  );
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
