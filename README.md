# gravit-ai-toolkit

Kuratierter **Plugin-Marketplace** der Gravit Cloud Organisation für Claude Code und Codex. Beide Tools erhalten denselben Plugin-Katalog über ihre native Struktur:

- `.claude-plugin/marketplace.json` ist die manuell gepflegte Quelle der Wahrheit.
- `.agents/plugins/marketplace.json` ist der daraus generierte Codex-Marketplace.
- `plugins/<name>/` enthält die installierbaren Codex-Plugins; `plugins/gravit-custom` ist gleichzeitig das lokale Claude-Code-Plugin.

## Claude Code vs. Codex

| | Claude Code | Codex |
|---|---|---|
| Marketplace | `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` |
| Marketplace registrieren | `/plugin marketplace add …` | `codex plugin marketplace add …` |
| Plugin installieren | `/plugin install …` | `codex plugin add …` oder `/plugins` |
| Projektanweisungen | `CLAUDE.md` / `AGENTS.md` | `AGENTS.md` |

Der frühere `codex/`-Dateibundle-Workaround ist nicht mehr nötig: Codex unterstützt native Plugins und Marketplaces.

## Enthaltene Plugins

| Plugin | Typ | Inhalt | Quelle | Version |
|---|---|---|---|---|
| `claude-seo` | verlinkt | SEO-Skills: Audits, technisches SEO, Schema, Content/E-E-A-T, GEO, Local, Maps, Backlinks | [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | `v2.2.0` |
| `obsidian` | verlinkt | `obsidian-cli`, `obsidian-markdown`, `obsidian-bases`, `json-canvas`, `defuddle` | [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | SHA-Pin |
| `mattpocock-skills` | verlinkt | Produktivitäts-Skills (u.a. `grill-me`) | [`mattpocock/skills`](https://github.com/mattpocock/skills) | `v1.1.0` |
| `azure` | verlinkt | Azure-Skills + Azure-MCP-Server (Cloud-Ressourcen, Deployments, Monitoring, Kosten) | [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | `v1.1.91` |
| `superpowers` | verlinkt | Entwicklungs-Workflows für Brainstorming, Planung, TDD, Debugging und Code-Reviews | [`obra/superpowers`](https://github.com/obra/superpowers) | `v6.1.1` |
| `gravit-custom` | lokal | 7 Gravit-eigene Skills für Dokumentation, Reviews, GitHub und Diagramme | dieses Repo (`./plugins/gravit-custom`) | `v1.0.0` |

## Installation mit Claude Code

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

## Installation mit Codex

Marketplace registrieren und Plugins einzeln installieren:

```bash
codex plugin marketplace add gravit-cloud/gravit-ai-toolkit
codex plugin add claude-seo@gravit-cloud
codex plugin add gravit-custom@gravit-cloud
```

Alternativ öffnet `/plugins` in der Codex-App den Plugin-Browser. Marketplace-Updates werden so eingespielt:

```bash
codex plugin marketplace upgrade gravit-cloud
```

## Gemeinsamer Plugin-Sync für Maintainer

Linked Plugins und Pins werden nur in `.claude-plugin/marketplace.json` gepflegt. Danach erzeugt ein Befehl den nativen Codex-Katalog und alle Codex-Plugin-Verzeichnisse:

```bash
npm ci
npm run plugins:sync
```

Der Sync lädt verlinkte Skills am unveränderlichen SHA, übernimmt Upstream-Version und -Autor, normalisiert die Codex-Verzeichnisstruktur, erzeugt `.codex-plugin/plugin.json` und schreibt `.agents/plugins/marketplace.json`. Explizit im Claude-Manifest deklarierte Skills werden respektiert; Entwürfe und deprecated Skills werden nicht versehentlich veröffentlicht. Anschließend `.agents/` und `plugins/` committen.

MCP-gestützte Skills liefern in Codex nur dann alle Funktionen, wenn der passende MCP-Server auch für Codex konfiguriert ist.

## Dependency-Updates mit Renovate

Renovate pflegt die GitHub-Plugin-Pins in `.claude-plugin/marketplace.json`, die
GitHub-Actions und die geprüften npm-Tools. Branch-Pins wie `main` werden als
Commit-Digest aktualisiert; versionierte Tags aktualisieren Tag und SHA gemeinsam.

Die Renovate-Konfiguration läuft selbst-hosted über
`.github/workflows/renovate.yml`. Dafür muss im Repository ein Secret
`RENOVATE_TOKEN` mit Berechtigung zum Lesen und Schreiben von Contents, Issues,
Pull Requests und Workflows hinterlegt werden. Nach einem Marketplace-Update
führt Renovate `npm run plugins:sync` aus, damit `.agents/` und die generierten
Codex-Plugins in derselben PR bleiben.

Die sieben Skills in `plugins/gravit-custom/skills/` werden lokal gepflegt.

## Repository-Struktur

```
.claude-plugin/
  marketplace.json          # Quelle der Wahrheit: 5 verlinkte Plugins + gravit-custom
.agents/plugins/
  marketplace.json          # nativer Codex-Katalog (generiert)
plugins/
  <linked-plugin>/          # native Codex-Plugins (generiert)
    .codex-plugin/plugin.json
    skills/<name>/SKILL.md
  gravit-custom/            # lokales Dual-Plugin (Claude Code + Codex)
    .claude-plugin/plugin.json
    .codex-plugin/plugin.json
    skills/<name>/SKILL.md  # sieben Gravit-eigene Skills
scripts/sync-plugins.mjs    # synchronisiert Claude-Katalog → Codex-Plugins
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

1. `plugins/gravit-custom/skills/<name>/SKILL.md` anlegen (YAML-Frontmatter mit `name` + `description`, dann Markdown-Body).
2. Mit `npm run version:set -- <version>` Paket- und Pluginversion gemeinsam erhöhen, falls ein Release folgt.
3. `bash build.sh` erkennt alle Skills automatisch aus `plugins/gravit-custom/skills/*/SKILL.md` — keine manuelle Liste nötig.

Nach Änderungen `npm run plugins:sync` ausführen, damit das Codex-Manifest und der generierte Katalog konsistent bleiben.

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

Die `MIT`-Lizenz dieses Repos bezieht sich auf Kuratierung, Build-Tooling, Doku und die lokal gepflegten Skills. Generierte Plugin-Inhalte behalten ihre Upstream-Lizenz; eine Kopie liegt jeweils als `plugins/<name>/LICENSE` bei.
