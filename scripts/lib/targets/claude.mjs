import { resolve } from "node:path";
import { writeJson } from "../json.mjs";
import { renderSkills } from "../skills.mjs";

export function renderClaudeTarget({ plugin, skills, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/claude");
  renderSkills({
    skills,
    destinationRoot: resolve(targetRoot, "skills"),
    target: "claude",
  });
  writeJson(resolve(targetRoot, ".claude-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    skills: "./skills/",
  });
  return { status: "transformed", path: "targets/claude" };
}
