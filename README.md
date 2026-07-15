# gravit-ai-toolkit

Kuratierter **Plugin-Marketplace** der Gravit Cloud Organisation für Claude Code. Der Katalog vereint zwei Arten von Plugins:

- **verlinkt** — bereits veröffentlichte Fremd-Plugins, die direkt aus ihrem Original-Repo bezogen und auf eine getestete Version gepinnt werden (kein Kopieren der Skills).
- **lokal** — das kuratierte Plugin `gravit-custom` mit 38 lokalen und übernommenen Skills unter `custom/skills/`.

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
| `claude-seo` | verlinkt | SEO-Skills: Audits, technisches SEO, Schema, Content/E-E-A-T, GEO, Local, Maps, Backlinks | [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | `v2.2.0` |
| `obsidian` | verlinkt | `obsidian-cli`, `obsidian-markdown`, `obsidian-bases`, `json-canvas`, `defuddle` | [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | SHA-Pin |
| `mattpocock-skills` | verlinkt | Produktivitäts-Skills (u.a. `grill-me`) | [`mattpocock/skills`](https://github.com/mattpocock/skills) | `v1.1.0` |
| `azure` | verlinkt | Azure-Skills + Azure-MCP-Server (Cloud-Ressourcen, Deployments, Monitoring, Kosten) | [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | `v1.1.91` |
| `superpowers` | verlinkt | Entwicklungs-Workflows für Brainstorming, Planung, TDD, Debugging und Code-Reviews | [`obra/superpowers`](https://github.com/obra/superpowers) | `v6.1.1` |
| `gravit-custom` | lokal | 38 kuratierte lokale und übernommene Skills aus `custom/skills/` | dieses Repo (`./custom`) | `v1.0.0` |

## Installation

```bash
# Einmalig: diesen Marketplace registrieren
/plugin marketplace add gravit-cloud/gravit-ai-toolkit
 
# Gewünschte Plugins installieren
/plugin install claude-seo@gravit-cloud
/plugin install obsidian@gravit-cloud
/plugin install mattpocock-skills@gravit-cloud
/plugin install azure@gravit-cloud
/plugin install superpowers@gravit-cloud
/plugin install gravit-custom@gravit-cloud
```

Skills werden mit dem Plugin-Namen als Präfix aufgerufen, z.B. `/claude-seo:seo-audit`, `/azure:azure-cost` oder `/gravit-custom:<skill>`.

Updates: `/plugin marketplace update gravit-cloud` lädt den Katalog neu; anschließend zeigt der Plugin-Manager verfügbare Plugin-Updates an.

## Codex / cross-tool

Codex kann den Marketplace nicht nutzen. Deshalb liegt unter [`codex/`](codex/README.md) ein **generiertes Bundle**, das die vollständigen Quellen unter `codex/sources/` erhält und mit **einem** `npx`-Befehl aus diesem Repo beziehbar macht:

```bash
# Komplettes Bundle (Skills + AGENTS.md-Index) ins Projekt ziehen
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex ./.gravit-skills --force

# oder nur die quellengetreuen Skill-Dateien
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex/sources ./skills --force
```

Danach in der Projekt-`AGENTS.md` referenzieren:

```markdown
See `.gravit-skills/AGENTS.md` for the available Gravit skills.
When a task matches one, read that skill's `SKILL.md` and follow it.
```

**Bundle aktualisieren (Maintainer):** `codex/sources/` wird nicht von Hand gepflegt, sondern aus den SHA-Pins in `.claude-plugin/marketplace.json` erzeugt:

```bash
npm run codex:sync    # lädt alle verlinkten Skills auf ihren gepinnten Stand + gravit-custom
```

Der Befehl liest die Pins direkt aus dem Katalog, holt nur die jeweiligen `skills/`-Hierarchien sowie notwendige Assets und Lizenzen und regeneriert `codex/AGENTS.md` + `codex/skills-manifest.json`. Die erhaltene Skill-Struktur bewahrt relative Verweise auf verschachtelte Workflows. Anschließend `codex/` committen. Details und Caveats (u.a. MCP-Skills wie `azure`): [`codex/README.md`](codex/README.md).

## Dependency-Updates mit Renovate

Renovate pflegt die GitHub-Plugin-Pins in `.claude-plugin/marketplace.json`, die
GitHub-Actions und die geprüften npm-Tools. Branch-Pins wie `main` werden als
Commit-Digest aktualisiert; versionierte Tags aktualisieren Tag und SHA gemeinsam.

Die Renovate-Konfiguration läuft selbst-hosted über
`.github/workflows/renovate.yml`. Dafür muss im Repository ein Secret
`RENOVATE_TOKEN` mit Berechtigung zum Lesen und Schreiben von Contents, Issues,
Pull Requests und Workflows hinterlegt werden. Nach einem Marketplace-Update
führt Renovate `scripts/renovate-codex-sync.sh` aus, damit der generierte
`codex/`-Bestandteil in derselben PR bleibt.

Übernommene Skills unter `custom/` werden nicht automatisch aktualisiert. Sie
bleiben wegen Inhaltsprüfung, Lizenz und Provenienz ein manueller
Kurationsprozess.

## Repository-Struktur

```
.claude-plugin/
  marketplace.json          # Katalog: 5 verlinkte Plugins + gravit-custom
custom/                     # das lokale, kuratierte Plugin "gravit-custom"
  .claude-plugin/
    plugin.json
  skills/<name>/SKILL.md    # lokale und übernommene Skills
  skills-lock.json          # Provenienz übernommener Skills
  THIRD_PARTY_NOTICES.md    # Lizenz- und Herkunftshinweise
codex/                      # cross-tool Bundle für Codex (generiert)
  sources/<plugin>/…        # quellengetreue Skill-Snapshots
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
  "source": { "source": "github", "repo": "owner/repo", "ref": "v1.0.0", "sha": "<40-stelliger-commit>" }
}
```

- `ref` = lesbarer Branch oder Tag für Review und Renovate.
- `sha` = verpflichtender, exakter 40-stelliger Commit-Pin für Installation und Sync.
- Für Monorepos: `{ "source": "git-subdir", "url": "...", "path": "pfad/zum/plugin" }`.

Voraussetzung: Das Ziel-Repo ist ein Claude-Code-Plugin (enthält `.claude-plugin/plugin.json` und/oder ein `skills/`-Verzeichnis im Repo-Root). Alle fünf oben erfüllen das.

## Einen Skill zu `gravit-custom` hinzufügen

1. `custom/skills/<name>/SKILL.md` anlegen (YAML-Frontmatter mit `name` + `description`, dann Markdown-Body).
2. Mit `npm run version:set -- <version>` Paket- und Pluginversion gemeinsam erhöhen, falls ein Release folgt.
3. `bash build.sh` erkennt alle Skills automatisch aus `custom/skills/*/SKILL.md` — keine manuelle Liste nötig.

Übernommene Skills müssen mit Quelle, Lizenz und Provenienz in `custom/skills-lock.json` sowie `custom/THIRD_PARTY_NOTICES.md` dokumentiert werden. Ein bloßes `npx skills add` ist kein Lockfile-Restore und wird nicht als Installationsweg dokumentiert.

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
- Superpowers — [Jesse Vincent / obra](https://github.com/obra/superpowers)

Die `MIT`-Lizenz dieses Repos bezieht sich auf Kuratierung, Build-Tooling, Doku und lokal gepflegte Skills. Übernommene Skills unterliegen ihren ursprünglichen Bedingungen; Details stehen in [`custom/THIRD_PARTY_NOTICES.md`](custom/THIRD_PARTY_NOTICES.md).
