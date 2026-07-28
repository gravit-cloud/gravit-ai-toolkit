import { assertRegistryName } from "./path-safety.mjs";

const SUPPORT = Object.freeze({
  claude: Object.freeze({
    skill: Object.freeze(["preserved", "skill"]),
    command: Object.freeze(["preserved", "command"]),
    agent: Object.freeze(["preserved", "agent"]),
    hook: Object.freeze(["transformed", "hook"]),
    mcp: Object.freeze(["transformed", "mcp"]),
    lsp: Object.freeze(["preserved", "lsp"]),
    "output-style": Object.freeze(["preserved", "output-style"]),
    monitor: Object.freeze(["preserved", "monitor"]),
    theme: Object.freeze(["preserved", "theme"]),
    channel: Object.freeze(["preserved", "channel"]),
    executable: Object.freeze(["preserved", "executable"]),
    settings: Object.freeze(["preserved", "settings"]),
    asset: Object.freeze(["preserved", "asset"]),
    app: undefined,
  }),
  codex: Object.freeze({
    skill: Object.freeze(["transformed", "skill"]),
    command: Object.freeze(["transformed", "skill"]),
    agent: undefined,
    hook: Object.freeze(["transformed", "hook"]),
    mcp: Object.freeze(["transformed", "mcp"]),
    lsp: undefined,
    "output-style": undefined,
    monitor: undefined,
    theme: undefined,
    channel: undefined,
    executable: Object.freeze(["preserved", "executable"]),
    settings: undefined,
    asset: Object.freeze(["preserved", "asset"]),
    app: Object.freeze(["preserved", "app"]),
  }),
});

const TARGETS = new Set(Object.keys(SUPPORT));
const COMPONENT_TYPES = new Set(Object.keys(SUPPORT.claude));
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REASON_CODE = /^[a-z0-9][a-z0-9-]*$/;

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw new Error(label + " must be a plain object");
  return value;
}

function assertNoPrototypeKey(key) {
  if (PROTOTYPE_KEYS.has(key)) {
    throw new Error("prototype key is not allowed: " + key);
  }
}

function assertNoPrototypeKeys(value) {
  for (const key of Object.keys(value)) assertNoPrototypeKey(key);
}

function validateTargetPolicies(value) {
  const targetPolicies = value === undefined ? {} : value;
  assertPlainObject(targetPolicies, "targetPolicies");
  for (const target of Object.keys(targetPolicies)) {
    assertNoPrototypeKey(target);
    if (!TARGETS.has(target)) throw new Error("unknown target policy: " + target);
    const targetPolicy = targetPolicies[target];
    assertPlainObject(targetPolicy, "target policy for " + target);
    for (const field of Object.keys(targetPolicy)) {
      assertNoPrototypeKey(field);
      if (field !== "unsupported") {
        throw new Error("unknown target policy field: " + target + " " + field);
      }
    }
    if (!Object.hasOwn(targetPolicy, "unsupported")) {
      throw new Error("target policy for " + target + " requires unsupported");
    }
    const unsupported = targetPolicy.unsupported;
    assertPlainObject(unsupported, "unsupported policy for " + target);
    for (const type of Object.keys(unsupported)) {
      assertNoPrototypeKey(type);
      if (!COMPONENT_TYPES.has(type)) {
        throw new Error("unknown component type policy: " + target + " " + type);
      }
      const reasonCode = unsupported[type];
      if (typeof reasonCode !== "string" || !REASON_CODE.test(reasonCode)) {
        throw new Error(
          "reason code must match ^[a-z0-9][a-z0-9-]*$: " + String(reasonCode),
        );
      }
      if (SUPPORT[target][type] !== undefined) {
        throw new Error(
          "unsupported policy contradicts support matrix for " + target + " " + type,
        );
      }
    }
  }
  return targetPolicies;
}

export function targetDisposition(input) {
  assertPlainObject(input, "targetDisposition input");
  assertNoPrototypeKeys(input);
  if (!Object.hasOwn(input, "component")) {
    throw new Error("targetDisposition input requires component");
  }
  if (!Object.hasOwn(input, "target")) {
    throw new Error("targetDisposition input requires target");
  }
  const component = input.component;
  assertPlainObject(component, "component");
  assertNoPrototypeKeys(component);
  if (!Object.hasOwn(component, "id") || !Object.hasOwn(component, "type")) {
    throw new Error("component must have own id and type properties");
  }
  assertRegistryName(component.id, "component id");
  assertRegistryName(component.type, "component type");
  if (!COMPONENT_TYPES.has(component.type)) {
    throw new Error("unknown component type: " + component.type);
  }

  const target = input.target;
  if (!TARGETS.has(target)) throw new Error("unknown target: " + String(target));
  const targetPolicies = validateTargetPolicies(
    Object.hasOwn(input, "targetPolicies") ? input.targetPolicies : undefined,
  );
  const supported = SUPPORT[target][component.type];
  if (supported !== undefined) {
    const [status, renderAs] = supported;
    return {
      status,
      reasonCode: status === "preserved"
        ? "native-component"
        : component.type === "command"
          ? "command-to-skill"
          : "target-translation",
      renderAs,
    };
  }

  const targetPolicy = Object.hasOwn(targetPolicies, target)
    ? targetPolicies[target]
    : undefined;
  const unsupported = targetPolicy && Object.hasOwn(targetPolicy, "unsupported")
    ? targetPolicy.unsupported
    : undefined;
  const reasonCode = unsupported && Object.hasOwn(unsupported, component.type)
    ? unsupported[component.type]
    : undefined;
  if (reasonCode === undefined) {
    throw new Error("missing unsupported policy for " + target + " " + component.type);
  }
  return { status: "unsupported", reasonCode, renderAs: undefined };
}
