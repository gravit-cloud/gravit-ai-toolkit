import { readJson } from "./json.mjs";

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ROOT_REFERENCE = /\$\{(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT)\}/gu;
const SHELL_TOKEN_BOUNDARIES = new Set([";", "&", "|", "<", ">", "(", ")", "`"]);

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
        if (tokenStarted) {
          tokens.push(current);
          current = "";
          tokenStarted = false;
        }
        continue;
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

function assertNoAbsoluteCommandPath(command) {
  for (const token of commandTokens(command)) {
    const candidates = [token];
    const optionValue = assignedValue(token);
    if (!isHttpUrl(token) && optionValue !== undefined) candidates.push(optionValue);
    if (candidates.some(isAbsoluteLike)) {
      throw new Error("absolute hook command path: " + command);
    }
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
        assertNoAbsoluteCommandPath(hook.command);
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
