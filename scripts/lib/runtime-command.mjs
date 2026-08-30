const CONTAINER_LAUNCHERS = new Set(["container", "docker", "podman"]);
const BLOCKED_LAUNCHERS = new Set([
  "ash",
  "bash",
  "bunx",
  "busybox",
  "cmd",
  "corepack",
  "csh",
  "dash",
  "elvish",
  "env",
  "fish",
  "ion",
  "ksh",
  "mksh",
  "npm",
  "nu",
  "osh",
  "pipx",
  "pnpm",
  "powershell",
  "pwsh",
  "rc",
  "sh",
  "tcsh",
  "toybox",
  "uvx",
  "wsl",
  "xonsh",
  "yarn",
  "ysh",
  "zsh",
]);
const WRAPPER_SUFFIXES = [
  ".exe",
  ".cmd",
  ".bat",
  ".com",
  ".ps1",
  ".psm1",
  ".vbs",
  ".vbe",
  ".wsf",
  ".wsh",
  ".js",
  ".mjs",
  ".cjs",
  ".sh",
  ".py",
  ".rb",
  ".pl",
];
const ALIASES = new Map([
  ["pnpx", "pnpm"],
  ["yarnpkg", "yarn"],
]);
const NATIVE_NAMESPACE_ROOT = /^(?:\?\?|device|global\?\?|dosdevices)$/iu;

function assertSafeToken(command) {
  if (typeof command !== "string" || command.length === 0 || command.trim().length === 0) {
    throw new Error("runtime executable token must be a non-empty string");
  }
  if (/['"`]/u.test(command)) {
    throw new Error("runtime executable token contains an unsafe quote: " + command);
  }

  const leadingSeparators = command.match(/^[\\/]+/u)?.[0] || "";
  const normalizedSegments = command.replaceAll("\\", "/").split("/");
  const firstSegment = normalizedSegments.find((segment) => segment.length > 0)?.toLowerCase();
  const hasBackslash = command.includes("\\");
  const hasRepeatedSeparator = /[\\/]{2}/u.test(command);

  if (
    (firstSegment === "?" || firstSegment === ".") &&
    (hasBackslash || leadingSeparators.length >= 2)
  ) {
    throw new Error("unsupported Windows device namespace: " + command);
  }
  if (
    firstSegment &&
    NATIVE_NAMESPACE_ROOT.test(firstSegment) &&
    (hasBackslash || leadingSeparators.length >= 2 || hasRepeatedSeparator)
  ) {
    throw new Error("unsupported Windows device namespace: " + command);
  }

  const isBare = !command.includes("/") && !hasBackslash;
  const hasDrivePrefix = /^[A-Za-z]:/u.test(command);
  const hasUncOrAmbiguousPrefix = leadingSeparators.length >= 2;
  const hasWindowsSemantics = isBare || hasDrivePrefix || hasUncOrAmbiguousPrefix || hasBackslash;
  if (
    hasWindowsSemantics &&
    command.split(/[\\/]/u).some((segment) => segment.length > 0 && /[. ]$/u.test(segment))
  ) {
    throw new Error("ambiguous Windows executable path: " + command);
  }

  const basename = command.split(/[\\/]/u).at(-1);
  if (!basename) {
    throw new Error("runtime executable token must name an executable: " + command);
  }
  if (command !== command.trim() || /\s/u.test(basename) || /[\r\n\t\0]/u.test(command)) {
    throw new Error("runtime executable token must not embed arguments: " + command);
  }
  return basename;
}

function canonicalStem(basename) {
  let stem = basename.toLowerCase();
  let suffix;
  do {
    suffix = WRAPPER_SUFFIXES.find((candidate) => stem.endsWith(candidate));
    if (suffix) stem = stem.slice(0, -suffix.length);
  } while (suffix && stem.length > 0);
  return ALIASES.get(stem) || stem;
}

export function classifyRuntimeCommand(command) {
  const stem = canonicalStem(assertSafeToken(command));
  if (!stem) throw new Error("runtime executable token must name an executable: " + command);
  if (stem === "npx") return { stem, runtimeClass: "npx" };
  if (CONTAINER_LAUNCHERS.has(stem)) return { stem, runtimeClass: "container" };
  if (BLOCKED_LAUNCHERS.has(stem)) return { stem, runtimeClass: "blocked" };
  return { stem, runtimeClass: "static" };
}
