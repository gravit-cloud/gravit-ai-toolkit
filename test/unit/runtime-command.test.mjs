import test from "node:test";
import assert from "node:assert/strict";
import { classifyRuntimeCommand } from "../../scripts/lib/runtime-command.mjs";

test("classifies portable executable basenames after repeated wrappers and aliases", () => {
  const cases = [
    ["npx", { stem: "npx", runtimeClass: "npx" }],
    ["/usr/local/bin/NPX.CMD.EXE", { stem: "npx", runtimeClass: "npx" }],
    ["C:\\Program Files\\nodejs\\nPx.Ps1.CmD", { stem: "npx", runtimeClass: "npx" }],
    ["docker.exe.cmd", { stem: "docker", runtimeClass: "container" }],
    ["C:/tools/PoDmAn.BAT", { stem: "podman", runtimeClass: "container" }],
    ["/usr/local/bin/container.COM", { stem: "container", runtimeClass: "container" }],
    ["pnpx.exe.cmd", { stem: "pnpm", runtimeClass: "blocked" }],
    ["/opt/bin/YARNPKG.PS1", { stem: "yarn", runtimeClass: "blocked" }],
    ["/opt/bin/fixture-server.sh", { stem: "fixture-server", runtimeClass: "static" }],
  ];

  for (const [command, expected] of cases) {
    assert.deepEqual(classifyRuntimeCommand(command), expected, command);
  }
});

test("blocks package launchers, wrappers, shells, and multiplexers", () => {
  for (const command of [
    "bunx", "corepack", "env", "npm", "pipx", "pnpm", "uvx", "yarn",
    "ash", "bash", "busybox", "cmd", "csh", "dash", "elvish", "fish",
    "ion", "ksh", "mksh", "nu", "osh", "powershell", "pwsh", "rc", "sh",
    "tcsh", "toybox", "wsl", "xonsh", "ysh", "zsh",
  ]) {
    assert.deepEqual(
      classifyRuntimeCommand("/opt/wrappers/" + command.toUpperCase() + ".SH.EXE"),
      { stem: command, runtimeClass: "blocked" },
      command,
    );
  }
});

test("uses explicit POSIX semantics for unambiguous forward-slash paths", () => {
  const cases = [
    ["/Device/tool", "tool"],
    ["/device/fixture.exe.", "fixture.exe."],
    ["/Global??/fixture.exe.", "fixture.exe."],
    ["/DosDevices/fixture.exe.", "fixture.exe."],
    ["/??/fixture.exe.", "fixture.exe."],
    ["/opt/Program Files/bin/fixture-server.exe", "fixture-server"],
    ["/opt/name:tools/npx.cmd.", "npx.cmd."],
    ["tools:name/fixture.exe.", "fixture.exe."],
  ];

  for (const [command, stem] of cases) {
    assert.deepEqual(classifyRuntimeCommand(command), { stem, runtimeClass: "static" }, command);
  }
});

test("rejects Win32 trailing-dot and trailing-space aliases for every path form", () => {
  for (const command of [
    "npx.cmd.",
    "npm.exe ",
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
  ]) {
    assert.throws(
      () => classifyRuntimeCommand(command),
      /ambiguous Windows executable path/,
      command,
    );
  }
});

test("rejects extended Win32 device namespaces across separator spellings", () => {
  for (const command of [
    "\\\\?\\C:\\tools\\npx.cmd",
    "\\\\.\\C:\\tools\\docker.exe",
    "\\\\?/C:\\tools\\fixture.exe",
    "//?\\C:\\tools\\fixture.exe",
    "\\\\./C:/tools/fixture.exe",
    "//.\\C:/tools/fixture.exe",
    "////?////C:/tools/fixture.exe",
    "/\\./C:/tools/fixture.exe",
  ]) {
    assert.throws(
      () => classifyRuntimeCommand(command),
      /unsupported Windows device namespace/,
      command,
    );
  }
});

test("rejects native namespaces when Windows or repeated-separator semantics are ambiguous", () => {
  for (const command of [
    "\\??\\C:\\tools\\fixture.exe",
    "\\\\??\\C:\\tools\\fixture.exe",
    "\\Device\\HarddiskVolume1\\tools\\fixture.exe",
    "\\Global??\\C:\\tools\\fixture.exe",
    "\\DosDevices\\C:\\tools\\fixture.exe",
    "/??\\C:\\tools\\fixture.exe",
    "/dEvIcE\\HarddiskVolume1\\tools\\fixture.exe",
    "/Global??\\C:/tools/fixture.exe",
    "/DosDevices\\C:\\tools\\fixture.exe",
    "//Device/HarddiskVolume1/tools/fixture.exe",
    "////dEvIcE\\\\HarddiskVolume1//tools\\fixture.exe",
    "/\\/GLOBAL??\\\\C:\\tools\\fixture.exe",
    "/??//C:/tools/fixture.exe",
    "/Device//HarddiskVolume1/tools/fixture.exe",
    "/gLoBaL??//C:/tools/fixture.exe",
    "/DOSDEVICES//C:/tools/fixture.exe",
  ]) {
    assert.throws(
      () => classifyRuntimeCommand(command),
      /unsupported Windows device namespace/,
      command,
    );
  }
});

test("rejects values that are not one safe executable argv token", () => {
  for (const command of [
    undefined,
    null,
    42,
    "",
    " ",
    "npx -y",
    "docker run",
    "bash\t-lc",
    "node\nserver.mjs",
    "\"npx\"",
    "'npx'",
    "`npx`",
    "C:\\tools\\\"npx.cmd\"",
    "C:\\tools\\npx.cmd'",
    "/opt/tools/",
  ]) {
    assert.throws(
      () => classifyRuntimeCommand(command),
      /executable token|unsafe quote|embed arguments/,
      String(command),
    );
  }
});

test("keeps unambiguous static Windows paths and hyphen-leading tokens usable", () => {
  for (const [command, stem] of [
    ["C:tools/fixture-server.exe", "fixture-server"],
    ["d:/tools/fixture-server.exe", "fixture-server"],
    ["E:\\tools/fixture-server.exe", "fixture-server"],
    ["\\\\server\\share\\fixture-server.EXE", "fixture-server"],
    ["-c", "-c"],
    ["-tools\\fixture-server.CMD", "fixture-server"],
  ]) {
    assert.deepEqual(classifyRuntimeCommand(command), { stem, runtimeClass: "static" }, command);
  }
});
