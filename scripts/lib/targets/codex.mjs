import { resolve } from "node:path";
import { writeJson } from "../json.mjs";
import { renderSkills } from "../skills.mjs";

const CATEGORY = {
  cloud: "Cloud",
  development: "Development",
  productivity: "Productivity",
  seo: "Productivity",
};

export function renderCodexTarget({ plugin, skills, bundleRoot }) {
  const targetRoot = resolve(bundleRoot, "targets/codex");
  renderSkills({
    skills,
    destinationRoot: resolve(targetRoot, "skills"),
    target: "codex",
  });
  writeJson(resolve(targetRoot, ".codex-plugin/plugin.json"), {
    name: plugin.name,
    version: plugin.distributionVersion,
    description: plugin.description,
    author: { name: "Gravit Cloud" },
    skills: "./skills/",
    interface: {
      displayName: plugin.name,
      shortDescription: plugin.description.slice(0, 110),
      longDescription: plugin.description,
      developerName: "Gravit Cloud",
      category: CATEGORY[plugin.category],
      capabilities: [],
      defaultPrompt: ["Use " + plugin.name + " to help with this task."],
    },
  });
  return { status: "transformed", path: "targets/codex" };
}
