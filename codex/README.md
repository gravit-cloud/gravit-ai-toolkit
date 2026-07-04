# Codex / cross-tool bundle

Claude Code installs the plugins in this repo via its marketplace mechanism
(`/plugin marketplace add …`). **Codex has no such mechanism** — it works from
`AGENTS.md` and plain files. This directory bridges that gap: it collects every
referenced skill as plain `skills/<name>/SKILL.md` files that Codex can read, and
lets you pull the whole set from this repo with a single `npx` command.

## For end users (Codex) — one command

Pull the entire collected bundle into your project:

```bash
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex ./.gravit-skills --force
```

You now have `./.gravit-skills/skills/<name>/SKILL.md` plus `./.gravit-skills/AGENTS.md`
(an index of every skill). Point Codex at it by referencing the skills from your
project's `AGENTS.md`, e.g.:

```markdown
# AGENTS.md
See `.gravit-skills/AGENTS.md` for the available Gravit skills.
When a task matches one, read that skill's `SKILL.md` and follow it.
```

Want just the raw skills (no index/README)?

```bash
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex/skills ./skills --force
```

### Alternative: skills.sh (per-tool install)

The local `gravit-custom` plugin is also installable cross-tool (Cursor, Copilot,
Warp, …) via [skills.sh](https://www.skills.sh/):

```bash
npx skills add gravit-cloud/gravit-ai-toolkit
```

## For maintainers — rebuild the bundle

`codex/skills/` is **generated**, not hand-edited. It mirrors the pins in
`.claude-plugin/marketplace.json`, so bump a version there and re-run:

```bash
npm run codex:sync      # = bash codex/sync.sh
```

The script:

1. reads the pinned `ref`/`sha` for each linked plugin from `marketplace.json`
   (single source of truth),
2. fetches each repo's `skills/` tree at that exact pin via `npx giget`,
3. flattens every `SKILL.md` dir into `codex/skills/<name>/`,
4. adds any `gravit-custom`-authored skills from `custom/skills/`,
5. regenerates `codex/AGENTS.md` and `codex/skills-manifest.json`.

Then commit the updated `codex/` so the one-command `giget` pull above serves the
new versions.

## Caveats

- **MCP-backed skills** (notably `azure`) ship their instruction text, but any MCP
  tool calls they reference only work where that MCP server is configured. Codex
  won't get Azure's bundled MCP server this way.
- Skill files retain their **original licenses and authorship** (see the repo's
  `AGENTS.md` → Attribution and `skills-manifest.json` → `source`). This bundle is a
  redistribution for convenience; upstream repos remain the source of truth.
