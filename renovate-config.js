// Global configuration for the self-hosted Renovate GitHub Action.
// Repository-specific dependency rules live in renovate.json.
module.exports = {
  onboarding: false,
  requireConfig: "required",
  platform: "github",
  repositories: ["gravit-cloud/gravit-ai-toolkit"],
  branchPrefix: "renovate-gravit-",
  allowedCommands: ["^bash scripts/renovate-codex-sync\\.sh$"]
};
