const CLAUDE_DESCRIPTION =
  "Kuratierter Gravit-Cloud-Marketplace für Claude Code und Codex.";
export const CODEX_CATEGORIES = Object.freeze({
  cloud: "Cloud",
  development: "Development",
  productivity: "Productivity",
  seo: "Productivity",
});

function titleCase(value) {
  return value.split("-").map((part) => (
    part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)
  )).join(" ");
}

export function createClaudeMarketplace(catalog) {
  return {
    name: catalog.name,
    owner: { name: "Gravit Cloud" },
    description: CLAUDE_DESCRIPTION,
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      source: "./plugins/" + plugin.name + "/targets/claude",
      category: plugin.category,
    })),
  };
}

export function createCodexMarketplace(catalog) {
  return {
    name: catalog.name,
    interface: { displayName: titleCase(catalog.name) },
    plugins: catalog.plugins.map((plugin) => ({
      name: plugin.name,
      source: {
        source: "local",
        path: "./plugins/" + plugin.name + "/targets/codex",
      },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: CODEX_CATEGORIES[plugin.category],
    })),
  };
}
