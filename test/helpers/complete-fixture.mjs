import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceContextHash } from "../../scripts/lib/hash.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const completeFixtureRoot = resolve(repositoryRoot, "test/fixtures/complete-plugin");

export function completeFixturePlugin(overrides = {}) {
  const base = {
    name: "complete",
    description: "Complete component fixture",
    category: "development",
    distributionVersion: "1.0.0-gravit.1",
    runtimeDependencies: { "@fixture/mcp": "1.2.3" },
    source: {
      type: "local",
      path: "test/fixtures/complete-plugin",
      root: ".",
    },
    sourceContext: ["LICENSE", "README.md"].map((path) => ({
      path,
      digest: sourceContextHash(resolve(completeFixtureRoot, path)),
    })),
    targets: ["codex", "claude"],
    policies: { default: "transform-or-fail", skills: "transform" },
    targetPolicies: {
      claude: { unsupported: { app: "host-does-not-load-apps" } },
      codex: {
        unsupported: {
          agent: "host-does-not-load-agents",
          lsp: "host-does-not-load-lsp",
          "output-style": "host-does-not-load-output-styles",
          monitor: "host-does-not-load-monitors",
          theme: "host-does-not-load-themes",
          channel: "host-does-not-load-channels",
          settings: "host-does-not-load-settings",
        },
      },
    },
  };
  return { ...base, ...overrides };
}
