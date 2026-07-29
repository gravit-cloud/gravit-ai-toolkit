import { renderCodexFormatTarget } from "./codex.mjs";

export function renderOpenClawTarget(input) {
  if (input.plugin.adapterOptions?.openclaw?.bundleFormat !== "codex") {
    throw new Error(input.plugin.name + ": OpenClaw bundleFormat must be codex");
  }
  return renderCodexFormatTarget({ ...input, target: "openclaw" });
}
