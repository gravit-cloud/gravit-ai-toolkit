import { readJson } from "./json.mjs";
import { classifyRuntimeCommand } from "./runtime-command.mjs";

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROOT_REFERENCE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/gu;
const SHELL_TOKEN_BOUNDARIES = new Set([";", "&", "|", "<", ">", "(", ")", "`"]);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const INTERPRETER_OPTIONS = {
  node: {
    dynamicShort: new Set(["e", "p"]),
    clusterShort: new Set(["c", "h", "i", "v", "w"]),
    valueShort: new Set(["C", "r"]),
    dynamicLong: new Set(["--eval", "--print"]),
    valueLong: new Set([
      "--conditions",
      "--diagnostic-dir",
      "--env-file",
      "--env-file-if-exists",
      "--experimental-default-config-file",
      "--experimental-loader",
      "--heap-prof-dir",
      "--icu-data-dir",
      "--import",
      "--inspect-port",
      "--loader",
      "--openssl-config",
      "--permission",
      "--redirect-warnings",
      "--require",
      "--snapshot-blob",
      "--test-name-pattern",
      "--test-reporter",
      "--test-reporter-destination",
      "--title",
      "--trace-event-categories",
      "--trace-event-file-pattern",
      "--use-largepages",
    ]),
  },
  bun: {
    dynamicShort: new Set(["e", "p"]),
    clusterShort: new Set(["v"]),
    valueShort: new Set(["r"]),
    dynamicLong: new Set(["--eval", "--print"]),
    valueLong: new Set(["--config", "--cwd", "--preload", "--tsconfig"]),
  },
  deno: {
    dynamicShort: new Set(),
    clusterShort: new Set(["h", "q", "V"]),
    valueLong: new Set(["--cert", "--config", "--import-map", "--location", "--lock"]),
  },
  python: {
    dynamicShort: new Set(["c"]),
    clusterShort: new Set([
      "B", "b", "d", "E", "i", "I", "O", "P", "q", "R", "s", "S", "u", "v", "V", "x",
    ]),
    valueShort: new Set(["Q", "W", "X"]),
    terminalShort: new Set(["m"]),
  },
  ruby: {
    dynamicShort: new Set(["e"]),
    clusterShort: new Set(["a", "c", "d", "h", "l", "n", "p", "s", "v", "w"]),
    valueShort: new Set(["C", "E", "I", "r"]),
    attachedValueShort: new Set(["F", "K", "W", "x"]),
    terminalShort: new Set(["S"]),
  },
  perl: {
    dynamicShort: new Set(["e", "E"]),
    clusterShort: new Set([
      "a", "c", "d", "g", "l", "n", "p", "s", "t", "T", "u", "U", "v", "w", "W",
    ]),
    valueShort: new Set(["I"]),
    attachedValueShort: new Set(["0", "C", "D", "F", "M", "m", "x"]),
  },
  php: {
    dynamicShort: new Set(["r"]),
    clusterShort: new Set(["a", "n", "q", "s"]),
    valueShort: new Set(["c", "d", "z"]),
    terminalShort: new Set(["f"]),
    dynamicLong: new Set(["--run"]),
  },
};

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  if (!isPlainObject(value)) throw new Error(label + " must be a plain object");
}

function assertNoPrototypeKeys(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("hook source must not contain cycles");
  seen.add(value);
  for (const key of Object.keys(value)) {
    if (PROTOTYPE_KEYS.has(key)) throw new Error("prototype-like hook key: " + key);
    assertNoPrototypeKeys(value[key], seen);
  }
  seen.delete(value);
}

function sourceObject(record) {
  assertPlainObject(record, "hook record");
  if (record.sourceFormat === "inline") {
    if (!hasOwn(record, "inline")) throw new Error("inline hook record is missing inline");
    return record.inline;
  }
  if (record.sourceFormat === "path") {
    if (typeof record.sourcePath !== "string" || record.sourcePath.length === 0) {
      throw new Error("path hook record is missing sourcePath");
    }
    return readJson(record.sourcePath);
  }
  throw new Error("unsupported hook source format: " + String(record.sourceFormat));
}

// This scanner recognizes argv-like whitespace and quotes only. It never invokes a
// shell and deliberately rejects controls or ambiguous quoting instead of trying to
// reproduce host-specific shell expansion.
function commandTokens(command) {
  if (/[\u0000-\u001f\u007f]/u.test(command)) {
    throw new Error("invalid hook command syntax: control character");
  }
  const tokens = [];
  let current = "";
  let quote;
  let tokenStarted = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === undefined) {
      if (/\s/u.test(character)) {
        if (tokenStarted) {
          tokens.push(current);
          current = "";
          tokenStarted = false;
        }
        continue;
      }
      if (SHELL_TOKEN_BOUNDARIES.has(character)) {
        throw new Error("unsupported hook command shell composition: " + command);
      }
      if (character === "'" || character === '"') {
        quote = character;
        tokenStarted = true;
        continue;
      }
      if (character === "\\") {
        if (index + 1 >= command.length) {
          throw new Error("invalid hook command syntax: trailing escape");
        }
        const next = command[index + 1];
        if (
          /\s/u.test(next) ||
          next === "'" ||
          next === '"' ||
          next === "\\" ||
          SHELL_TOKEN_BOUNDARIES.has(next)
        ) {
          current += next;
          index += 1;
        } else {
          current += character;
        }
        tokenStarted = true;
        continue;
      }
      current += character;
      tokenStarted = true;
      continue;
    }

    if (character === quote) {
      quote = undefined;
      continue;
    }
    if (quote === '"' && character === "\\" && index + 1 < command.length) {
      const next = command[index + 1];
      if (["$", "`", '"', "\\"].includes(next)) {
        current += next;
        index += 1;
        continue;
      }
    }
    if (
      quote === '"' &&
      (character === "`" || (character === "$" && command[index + 1] === "("))
    ) {
      throw new Error("unsupported hook command shell composition: " + command);
    }
    current += character;
  }
  if (quote !== undefined) throw new Error("invalid hook command syntax: unterminated quote");
  if (tokenStarted) tokens.push(current);
  return tokens;
}

function assignedValue(token) {
  const separator = token.indexOf("=");
  return separator === -1 ? undefined : token.slice(separator + 1);
}

function isRootRelative(value) {
  return /^\\*\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}(?:[\\/]|$)/u.test(value);
}

function isHttpUrl(value) {
  return /^https?:\/\//iu.test(value);
}

function isAbsoluteLike(value) {
  if (value.length === 0 || isRootRelative(value) || isHttpUrl(value)) return false;
  if (/^file:/iu.test(value)) return true;
  if (/^[A-Za-z]:/u.test(value)) return true;
  return /^[\\/]/u.test(value);
}

function assertNoAbsoluteCommandPath(command, tokens) {
  for (const token of tokens) {
    const candidates = [token];
    const optionValue = assignedValue(token);
    if (!isHttpUrl(token) && optionValue !== undefined) candidates.push(optionValue);
    if (candidates.some(isAbsoluteLike)) {
      throw new Error("absolute hook command path: " + command);
    }
  }
}

function interpreterFamily(stem) {
  const match = stem.match(
    /^(nodejs|node|bun|deno|python|ruby|perl|php)(?:\d+(?:\.\d+)*)?$/u,
  );
  if (!match) return undefined;
  return match[1] === "nodejs" ? "node" : match[1];
}

function shortOptionEffect(token, options) {
  if (token.length < 2 || token[0] !== "-" || token[1] === "-") return {};
  for (let index = 1; index < token.length; index += 1) {
    const flag = token[index];
    if (options.dynamicShort.has(flag)) return { dynamic: true };
    if (options.terminalShort?.has(flag)) return { terminal: true };
    if (options.valueShort?.has(flag)) {
      return { consumesNext: index === token.length - 1 };
    }
    if (options.attachedValueShort?.has(flag)) return {};
    if (!options.clusterShort.has(flag)) return {};
  }
  return {};
}

function longOptionEffect(token, options) {
  if (!token.startsWith("--")) return {};
  const separator = token.indexOf("=");
  const name = separator === -1 ? token : token.slice(0, separator);
  if (options.dynamicLong?.has(name)) return { dynamic: true };
  if (options.terminalLong?.has(name)) return { terminal: true };
  if (options.valueLong?.has(name)) return { consumesNext: separator === -1 };
  return {};
}

function hasDynamicEvaluationMode(family, args) {
  const options = INTERPRETER_OPTIONS[family];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--") return false;
    if (token === "-" || !token.startsWith("-")) {
      return family === "deno" && token === "eval";
    }
    if (!options) continue;
    const effect = token.startsWith("--")
      ? longOptionEffect(token, options)
      : shortOptionEffect(token, options);
    if (effect.dynamic) return true;
    if (effect.terminal) return false;
    if (effect.consumesNext) index += 1;
  }
  return false;
}

function assertSafeRuntimeCommand(command, tokens) {
  if (ENV_ASSIGNMENT.test(tokens[0])) {
    throw new Error("leading environment assignment in hook command: " + command);
  }
  let runtime;
  try {
    runtime = classifyRuntimeCommand(tokens[0]);
  } catch (error) {
    assertNoAbsoluteCommandPath(command, tokens);
    throw error;
  }
  if (runtime.runtimeClass === "blocked") {
    throw new Error("blocked hook command runtime: " + command);
  }
  const family = interpreterFamily(runtime.stem);
  if (family && hasDynamicEvaluationMode(family, tokens.slice(1))) {
    throw new Error("dynamic hook command evaluation: " + command);
  }
}

function validateHookMap(hooks) {
  assertPlainObject(hooks, "hook event map");
  assertNoPrototypeKeys(hooks);
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      throw new Error("hook event must contain an array: " + event);
    }
    for (const group of groups) {
      assertPlainObject(group, "hook group: " + event);
      if (!hasOwn(group, "hooks") || !Array.isArray(group.hooks)) {
        throw new Error("hook group must define a hooks array: " + event);
      }
      for (const hook of group.hooks) {
        assertPlainObject(hook, "hook entry: " + event);
        if (hook.type !== "command") continue;
        if (typeof hook.command !== "string" || hook.command.trim().length === 0) {
          throw new Error("command hook requires a non-empty string command: " + event);
        }
        const tokens = commandTokens(hook.command);
        assertSafeRuntimeCommand(hook.command, tokens);
        assertNoAbsoluteCommandPath(hook.command, tokens);
      }
    }
  }
}

function normalizedHooks(config) {
  assertPlainObject(config, "normalized hook config");
  if (!hasOwn(config, "hooks") || Object.keys(config).length !== 1) {
    throw new Error("normalized hook config must contain only hooks");
  }
  validateHookMap(config.hooks);
  return config.hooks;
}

function renderRootReferences(command, target) {
  const targetReference = target === "claude"
    ? "${CLAUDE_PLUGIN_ROOT}"
    : "${PLUGIN_ROOT}";
  return command.replace(ROOT_REFERENCE, (reference, offset, source) => {
    let escapes = 0;
    for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) {
      escapes += 1;
    }
    return escapes % 2 === 1 ? reference : targetReference;
  });
}

export function normalizeHooks(record) {
  const source = sourceObject(record);
  assertPlainObject(source, "hook source");
  assertNoPrototypeKeys(source);
  const wrapped = hasOwn(source, "hooks");
  if (wrapped && Object.keys(source).length !== 1) {
    throw new Error("hook wrapper must contain only hooks");
  }
  const hooks = wrapped ? source.hooks : source;
  validateHookMap(hooks);
  return { hooks: structuredClone(hooks) };
}

export function renderHooks({ config, target }) {
  if (!["claude", "codex"].includes(target)) {
    throw new Error("unsupported hook target: " + String(target));
  }
  normalizedHooks(config);
  const rendered = structuredClone(config);
  for (const groups of Object.values(rendered.hooks)) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type === "command") {
          hook.command = renderRootReferences(hook.command, target);
        }
      }
    }
  }
  return rendered;
}
