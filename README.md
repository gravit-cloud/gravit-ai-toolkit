# gravit-ai-toolkit

Kuratierter **Plugin-Marketplace** der Gravit Cloud Organisation für Claude Code. Der Katalog vereint zwei Arten von Plugins:

- **verlinkt** — bereits veröffentlichte Fremd-Plugins, die direkt aus ihrem Original-Repo bezogen und auf eine getestete Version gepinnt werden (kein Kopieren der Skills).
- **lokal** — das Plugin `gravit-custom`, dessen Skills in diesem Repo unter `custom/skills/` liegen und selbst gepflegt werden.

## Claude Code vs. Codex

Der Marketplace-Mechanismus (`.claude-plugin/marketplace.json`, `/plugin install`, namespaced Skill-Aufrufe) ist **Claude-Code-spezifisch** — Codex kennt weder Plugins noch einen Marketplace und arbeitet stattdessen mit `AGENTS.md` und einfachen Dateien.

| | Claude Code | Codex |
|---|---|---|
| Marketplace + verlinkte Plugins (`/plugin install`) | ✅ | ❌ |
| Skill-Bundle via einem `npx`-Befehl (aus diesem Repo) | ✅ | ✅ ([`codex/`](codex/README.md)) |
| `AGENTS.md` als Projektkontext | ✅ | ✅ |

Für Codex und andere AGENTS.md-basierte Tools stellt dieses Repo unter [`codex/`](codex/README.md) alle referenzierten Skills als reine Dateien bereit — beziehbar mit **einem** Befehl (siehe [Codex / cross-tool](#codex--cross-tool)).

## Enthaltene Plugins

| Plugin | Typ | Inhalt | Quelle | Version |
|---|---|---|---|---|
| `claude-seo` | verlinkt | 25 SEO-Skills: Audits, technisches SEO, Schema, Content/E-E-A-T, GEO, Local, Maps, Backlinks | [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | `v2.2.0` |
| `obsidian` | verlinkt | `obsidian-cli`, `obsidian-markdown`, `obsidian-bases`, `json-canvas`, `defuddle` | [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | SHA-Pin |
| `mattpocock-skills` | verlinkt | Produktivitäts-Skills (u.a. `grill-me`) | [`mattpocock/skills`](https://github.com/mattpocock/skills) | `v1.0.1` |
| `azure` | verlinkt | 28 Azure-Skills + Azure-MCP-Server (Cloud-Ressourcen, Deployments, Monitoring, Kosten) | [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | `v1.1.79` |
| `gravit-custom` | lokal | Eigene, kuratierte Skills aus `custom/skills/` | dieses Repo (`./custom`) | `v1.0.0` |

## Installation

```bash
# Einmalig: diesen Marketplace registrieren
/plugin marketplace add gravit-cloud gravit-cloud/gravit-ai-toolkit

# Gewünschte Plugins installieren
/plugin install claude-seo@gravit-cloud
/plugin install obsidian@gravit-cloud
/plugin install mattpocock-skills@gravit-cloud
/plugin install azure@gravit-cloud
/plugin install gravit-custom@gravit-cloud
```

Skills werden mit dem Plugin-Namen als Präfix aufgerufen, z.B. `/claude-seo:seo-audit`, `/azure:azure-cost` oder `/gravit-custom:<skill>`.

Updates: `/plugin marketplace update gravit-cloud` lädt den Katalog neu; anschließend zeigt der Plugin-Manager verfügbare Plugin-Updates an.

## Codex / cross-tool

Codex kann den Marketplace nicht nutzen. Deshalb liegt unter [`codex/`](codex/README.md) ein **generiertes Bundle**, das jeden referenzierten Skill als `codex/skills/<name>/SKILL.md` sammelt und mit **einem** `npx`-Befehl aus diesem Repo beziehbar macht:

```bash
# Komplettes Bundle (Skills + AGENTS.md-Index) ins Projekt ziehen
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex ./.gravit-skills --force

# oder nur die reinen Skills
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex/skills ./skills --force
```

Danach in der Projekt-`AGENTS.md` referenzieren:

```markdown
See `.gravit-skills/AGENTS.md` for the available Gravit skills.
When a task matches one, read that skill's `SKILL.md` and follow it.
```

**Bundle aktualisieren (Maintainer):** `codex/skills/` wird nicht von Hand gepflegt, sondern aus den Pins in `.claude-plugin/marketplace.json` erzeugt:

```bash
npm run codex:sync    # lädt alle verlinkten Skills auf ihren gepinnten Stand + gravit-custom
```

Der Befehl liest die Pins direkt aus dem Katalog (einzige Quelle der Wahrheit), holt jede `skills/`-Struktur per `npx giget` und regeneriert `codex/AGENTS.md` + `codex/skills-manifest.json`. Anschließend `codex/` committen. Details und Caveats (u.a. MCP-Skills wie `azure`): [`codex/README.md`](codex/README.md).

Alternativ ist das lokale `gravit-custom` cross-tool via [skills.sh](https://www.skills.sh/) installierbar: `npx skills add gravit-cloud/gravit-ai-toolkit`.

## Repository-Struktur

```
.claude-plugin/
  marketplace.json          # Katalog: 4 verlinkte Plugins + gravit-custom
custom/                     # das lokale Plugin "gravit-custom"
  .claude-plugin/
    plugin.json
  skills/<name>/SKILL.md    # eigene Skills
  skills-lock.json          # Provenienz extern bezogener Skills (npx skills add)
codex/                      # cross-tool Bundle für Codex (generiert)
  skills/<name>/SKILL.md    # alle referenzierten Skills als reine Dateien
  AGENTS.md                 # generierter Skill-Index (von Codex geladen)
  sync.sh                   # baut das Bundle aus den marketplace.json-Pins
build.sh                    # baut dist/*.zip für gravit-custom (Claude Desktop + Releases)
```

## Ein verlinktes Plugin hinzufügen / Version ändern

Neuer Eintrag im `plugins`-Array von `.claude-plugin/marketplace.json`:

```json
{
  "name": "mein-plugin",
  "description": "Kurzbeschreibung",
  "source": { "source": "github", "repo": "owner/repo", "ref": "v1.0.0" }
}
```

- `ref` = Branch oder Tag (z.B. `"main"` für Auto-Updates, `"v1.0.0"` für eine feste Version).
- `sha` = exakter Commit (nötig bei Repos ohne Tags, z.B. `kepano/obsidian-skills`).
- Für Monorepos: `{ "source": "git-subdir", "url": "...", "path": "pfad/zum/plugin" }`.

Voraussetzung: Das Ziel-Repo ist ein Claude-Code-Plugin (enthält `.claude-plugin/plugin.json` und/oder ein `skills/`-Verzeichnis im Repo-Root). Alle vier oben erfüllen das.

## Einen Skill zu `gravit-custom` hinzufügen

1. `custom/skills/<name>/SKILL.md` anlegen (YAML-Frontmatter mit `name` + `description`, dann Markdown-Body).
2. Optional Version in `custom/.claude-plugin/plugin.json` hochzählen.
3. `bash build.sh` erkennt alle Skills automatisch aus `custom/skills/*/SKILL.md` — keine manuelle Liste nötig.

Externe Skills lassen sich mit `npx skills add <org/repo>` in `custom/skills/` ziehen (Provenienz landet in `custom/skills-lock.json`).

## MCP Server

Das `azure`-Plugin bringt seinen Azure-MCP-Server bereits mit. Weitere MCP-Server lassen sich projektweit in `.mcp.json` ergänzen.

### WordPress / Elementor

Der [WordPress Elementor Assistant](https://mcpmarket.com/tools/skills/wordpress-elementor-assistant) MCP-Server bietet direkten Zugriff auf WordPress-Instanzen inkl. Elementor-Seiteneditor.

**Installation über Docker (empfohlen):**

```bash
docker run -i --rm \
  -e WORDPRESS_URL=https://your-site.com \
  -e WORDPRESS_USERNAME=admin \
  -e WORDPRESS_PASSWORD=your-app-password \
  mcp/wordpress-elementor-assistant
```

Dann in `.mcp.json` eintragen:

```json
{
  "wordpress": {
    "type": "stdio",
    "command": "docker",
    "args": [
      "run", "-i", "--rm",
      "-e", "WORDPRESS_URL",
      "-e", "WORDPRESS_USERNAME",
      "-e", "WORDPRESS_PASSWORD",
      "mcp/wordpress-elementor-assistant"
    ],
    "env": {
      "WORDPRESS_URL": "https://your-site.com",
      "WORDPRESS_USERNAME": "admin",
      "WORDPRESS_PASSWORD": "your-app-password"
    }
  }
}
```

## Attribution & Lizenz

Alle Plugins werden aus ihren Original-Repos bezogen und behalten ihre jeweilige Lizenz und Autorenschaft:

- SEO — [AgricIDaniel](https://github.com/AgricIDaniel/claude-seo)
- Obsidian — [kepano](https://github.com/kepano/obsidian-skills)
- `grill-me` u.a. — [Matt Pocock](https://github.com/mattpocock/skills)
- Azure — [Microsoft](https://github.com/microsoft/azure-skills)

Die `MIT`-Lizenz dieses Repos bezieht sich ausschließlich auf die Kuratierung (den Marketplace-Katalog und die Doku).
