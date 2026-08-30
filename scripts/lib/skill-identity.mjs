import { sha256 } from "./hash.mjs";
import { assertRegistryName } from "./path-safety.mjs";

export function assertHostSkillName(value) {
  if (value === "prototype") return value;
  return assertRegistryName(value, "skill name");
}

export function skillComponentId(name) {
  assertHostSkillName(name);
  if (name !== "prototype") return name;
  return "skill-prototype-" + sha256("host-skill:" + name).slice(0, 12);
}
