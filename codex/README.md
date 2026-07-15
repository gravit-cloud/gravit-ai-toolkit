# Codex / cross-tool bundle

Claude Code installs the marketplace plugins directly. **Codex has no plugin
marketplace**; it reads `AGENTS.md` and plain files. This directory therefore
contains a generated snapshot of every marketplace source.

Each source retains its `skills/` hierarchy below `sources/<plugin>/`. Complex
upstream skills often link to sibling workflows or examples, and flattening them
breaks those references. Only the skill hierarchy, required shared assets and
license text are included; unrelated repository files are excluded.

## For end users

Pull the complete bundle into a project:

```bash
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex ./.gravit-skills --force
```

Reference its generated index from the project's `AGENTS.md`:

```markdown
See `.gravit-skills/AGENTS.md` for the available Gravit skills.
When a task matches one, read that skill's `SKILL.md` and follow it.
```

To pull only the source-preserving snapshots:

```bash
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex/sources ./skills --force
```

## For maintainers

`sources/`, `AGENTS.md`, and `skills-manifest.json` are generated. Rebuild them
after any marketplace pin or local-skill change:

```bash
npm run codex:sync
```

The sync downloads every linked `skills/` hierarchy at its immutable SHA, adds
required shared assets and licenses, copies `custom/`, and regenerates the index
and manifest. Commit the resulting `codex/` changes. Run the full local checks with:

```bash
npm run validate
npm run release:prepare
```

The repository's Renovate runner uses `scripts/renovate-codex-sync.sh` to install
the pinned tooling and regenerate this directory after Marketplace pin updates.

## Caveats

- MCP-backed skills, notably Azure, only provide instructions unless the matching
  MCP server is configured in the consuming environment.
- Skill files preserve their upstream source path. Attribution and provenance for
  the local curated bundle are in `custom/THIRD_PARTY_NOTICES.md` and
  `custom/skills-lock.json`.
