# AGENTS.md

**gravit-ai-toolkit** ist ein kuratierter Plugin-Marketplace der Gravit Cloud Organisation für Claude Code und Codex.

- `.claude-plugin/marketplace.json` ist die einzige manuell gepflegte Quelle der Wahrheit für Plugin-Auswahl, Versionen und SHA-Pins.
- `.agents/plugins/marketplace.json` ist der daraus generierte native Codex-Marketplace.
- Verlinkte Codex-Plugins unter `plugins/<name>/` werden aus den Claude-Pins generiert.
- `plugins/gravit-custom/` ist ein gemeinsam gepflegtes Dual-Plugin mit Claude- und Codex-Manifest und sieben Gravit-eigenen Skills.

Nach Änderungen am Claude-Katalog oder an `gravit-custom` immer `npm run plugins:sync` ausführen und `.agents/` sowie `plugins/` gemeinsam committen. Generierte verlinkte Plugin-Verzeichnisse nicht von Hand bearbeiten.

---

## Repository-Struktur

```
.claude-plugin/
  marketplace.json         # Quelle der Wahrheit: 5 verlinkte Plugins + gravit-custom
.agents/plugins/
  marketplace.json         # nativer Codex-Katalog (generiert)
plugins/
  <linked-plugin>/         # native Codex-Plugins (generiert)
    .codex-plugin/plugin.json
    skills/<name>/SKILL.md
  gravit-custom/           # lokales Dual-Plugin
    .claude-plugin/plugin.json
    .codex-plugin/plugin.json
    skills/<name>/SKILL.md # sieben Gravit-eigene Skills
scripts/
  sync-plugins.mjs         # Claude-Katalog → Codex-Katalog und Plugins
  validate.mjs             # gemeinsame Struktur- und Metadatenprüfung
build.sh                   # baut dist/*.zip für gravit-custom (Claude Desktop + Releases)
package.json               # Build-/Release-Tooling für gravit-custom
AGENTS.md                  # Diese Datei
CLAUDE.md                  # @AGENTS.md (Referenz für Claude Code)
README.md
LICENSE
```

---

## Enthaltene Plugins

| Plugin | Typ | Quelle | Pin |
|---|---|---|---|
| `claude-seo` | verlinkt | `AgricIDaniel/claude-seo` | `v2.2.0` + SHA |
| `obsidian` | verlinkt | `kepano/obsidian-skills` | `main` + SHA |
| `mattpocock-skills` | verlinkt | `mattpocock/skills` | `v1.1.0` + SHA |
| `azure` | verlinkt | `microsoft/azure-skills` | `v1.1.91` + SHA |
| `superpowers` | verlinkt | `obra/superpowers` | `v6.1.1` + SHA |
| `gravit-custom` | lokal | `./plugins/gravit-custom` | `v1.0.0` |

### Verlinktes Plugin hinzufügen / Version ändern

Neuer Eintrag im `plugins`-Array von `.claude-plugin/marketplace.json`:

```json
{
  "name": "mein-plugin",
  "description": "Kurzbeschreibung",
  "source": { "source": "github", "repo": "owner/repo", "ref": "v1.0.0", "sha": "<40-stelliger-commit>" }
}
```

- `ref` = lesbarer Branch/Tag für Review und Renovate.
- `sha` = verpflichtender, exakter 40-stelliger Commit-Pin für Installation und Sync.
- Monorepo: `{ "source": "git-subdir", "url": "…", "path": "pfad/zum/plugin" }`.
- Voraussetzung: Ziel-Repo ist ein Claude-Code-Plugin (`.claude-plugin/plugin.json` und/oder `skills/` im Repo-Root).

### Skill zu `gravit-custom` hinzufügen

1. `plugins/gravit-custom/skills/<name>/SKILL.md` anlegen:

```yaml
---
name: <skill-name>
description: Präzise Triggerbeschreibung — wann soll der Skill aktiviert werden
license: MIT
metadata:
  author: Gravit Cloud
  version: "1.0.0"
---

# Skill-Titel
## Wann verwenden
## Anleitung
```

2. Für Releases `npm run version:set -- <version>` verwenden; das aktualisiert Paket- und Pluginversion gemeinsam.
3. `npm run plugins:sync` ausführen, damit das Codex-Manifest konsistent bleibt.
4. `bash build.sh` erkennt Skills automatisch und baut die versionierten Archive.

---

## Installation (Endnutzer)

### Claude Code

```bash
# Einmalig: Marketplace registrieren
/plugin marketplace add gravit-cloud/gravit-ai-toolkit

# Gewünschte Plugins installieren (jedes einzeln)
/plugin install claude-seo@gravit-cloud
/plugin install azure@gravit-cloud
/plugin install superpowers@gravit-cloud
/plugin install gravit-custom@gravit-cloud
# …

# Katalog & Plugin-Updates einspielen
/plugin marketplace update gravit-cloud
```

Skills werden namespaced aufgerufen: `/claude-seo:seo-audit`, `/azure:azure-cost`, `/gravit-custom:<skill>`.

### Codex

```bash
codex plugin marketplace add gravit-cloud/gravit-ai-toolkit
codex plugin add claude-seo@gravit-cloud
codex plugin add gravit-custom@gravit-cloud

# Marketplace aktualisieren
codex plugin marketplace upgrade gravit-cloud
```

Alternativ Plugins in der Codex-App über `/plugins` auswählen.

### Gemeinsamer Sync (Maintainer)

```bash
npm ci
npm run plugins:sync
npm run validate
```

Der Sync verarbeitet nur aktive, vom Upstream-Plugin deklarierte Skills, normalisiert sie auf `skills/<name>/SKILL.md` und erzeugt Codex-Manifeste. Claude-spezifische `disable-model-invocation: true`-Flags werden nur in generierten Codex-Kopien entfernt. MCP-gestützte Skills funktionieren in Codex nur vollständig, wenn der passende MCP-Server konfiguriert ist.

---

## Skill-Referenz

Inhalte der verlinkten Plugins (zur Orientierung — bezogen aus dem jeweiligen Original-Repo).

### Obsidian (`obsidian` ← `kepano/obsidian-skills`)

| Skill | Beschreibung |
|---|---|
| `obsidian-cli` | Vault-Interaktion via CLI — Notizen lesen, erstellen, suchen, Plugin/Theme-Entwicklung |
| `obsidian-markdown` | Obsidian Flavored Markdown — Wikilinks, Embeds, Callouts, Properties, Frontmatter |
| `obsidian-bases` | Obsidian Bases (.base) — Datenbankansichten, Filter, Formeln, Card/Table Views |
| `json-canvas` | JSON Canvas (.canvas) — Nodes, Edges, Gruppen, Infinite Canvas Spec |
| `defuddle` | Web-Seiten zu sauberem Markdown konvertieren (Clutter entfernen, Token sparen) |

### SEO (`claude-seo` ← `AgricIDaniel/claude-seo`)

| Skill | Beschreibung |
|---|---|
| `seo` | Orchestrator — vollständige Audits, Single-Page, technisches SEO, Schema, E-E-A-T, GEO |
| `seo-audit` | Site-Audit mit parallelen Subagenten, bis 500 Seiten, Health Score |
| `seo-page` | Einzelseiten-Analyse — On-Page, Content, Meta, Schema, Performance |
| `seo-technical` | Crawlability, Indexability, Core Web Vitals, Sicherheit, Mobile, JavaScript Rendering |
| `seo-content` | E-E-A-T, Lesbarkeit, Content-Qualität, AI Citation Readiness |
| `seo-content-brief` | Wettbewerbsfähige Content-Briefs mit Wortanzahl, Keywords, Outline, interne Links |
| `seo-schema` | Schema.org Structured Data — JSON-LD Erkennung, Validierung, Generierung |
| `seo-sitemap` | XML Sitemaps analysieren oder mit Industry-Templates generieren |
| `seo-images` | Alt-Text, Dateigrößen, Formate (WebP/AVIF), Lazy Loading, Image SERP |
| `seo-geo` | AI Overviews, ChatGPT Web Search, Perplexity — Generative Engine Optimization |
| `seo-google` | Search Console, PageSpeed, CrUX, Indexing API, GA4 Organic Traffic |
| `seo-backlinks` | Backlink-Profil via Moz, Bing Webmaster, Common Crawl, DataForSEO |
| `seo-cluster` | SERP-basiertes Topic Clustering, Hub-and-Spoke, interne Verlinkungsmatrix |
| `seo-sxo` | Search Experience Optimization — SERP-Analyse, Intent-Matching, Persona Scoring |
| `seo-drift` | SEO-Änderungen tracken — Baseline erfassen, Regressions erkennen, diff |
| `seo-local` | Local SEO, Google Business Profile, NAP-Konsistenz, Citations, Map Pack |
| `seo-maps` | Geo-Grid Rank Tracking, GBP-Audit, Review Intelligence, Competitor-Radius |
| `seo-plan` | Strategische SEO-Planung, Industry-Templates, Content-Roadmap |
| `seo-competitor-pages` | "X vs Y" und "Alternativen zu X" Seiten, Feature-Matrizen |
| `seo-hreflang` | International SEO, Hreflang-Audit, Sprach/Region-Codes, Validierung |
| `seo-ecommerce` | Google Shopping, Amazon Marketplace Intelligence, Produkt-Schema |
| `seo-programmatic` | Programmatic SEO — Pages at Scale, Templates, Index Bloat Prevention |
| `seo-dataforseo` | Live SERP-Daten via DataForSEO MCP (Extension erforderlich) |
| `seo-image-gen` | KI-Bildgenerierung für OG-Images, Hero-Bilder, Infografiken (Banana MCP) |
| `seo-flow` | FLOW Framework — Find → Leverage → Optimize → Win, 41 stage-spezifische Prompts |

### Produktivität (`mattpocock-skills` ← `mattpocock/skills`)

| Skill | Beschreibung |
|---|---|
| `grill-me` | Intensives Interview zur Schärfung von Plänen und Designs |

### Azure (`azure` ← `microsoft/azure-skills`)

Azure-Skills für Ressourcenverwaltung, Deployments, Diagnostics, Kostenanalyse, AKS, Foundry u.a. — inkl. mitgeliefertem Azure-MCP-Server.

### Superpowers (`superpowers` ← `obra/superpowers`)

Agentische Entwicklungs-Workflows für Brainstorming, Planung, TDD, Debugging, parallele Ausführung, Code-Reviews und den Abschluss eines Entwicklungs-Branches.

---

## MCP Server

MCP Server erweitern Agents um externe Tool-Zugriffe. Das `azure`-Plugin bringt seinen MCP-Server bereits mit; weitere lassen sich projektweit in `.mcp.json` ergänzen. Viele Server laufen per Docker — ideal für isolierte Umgebungen.

### WordPress / Elementor

[WordPress Elementor Assistant](https://mcpmarket.com/tools/skills/wordpress-elementor-assistant) — direkter Zugriff auf WordPress inkl. Elementor-Editor.

```bash
docker run -i --rm \
  -e WORDPRESS_URL=https://your-site.com \
  -e WORDPRESS_USERNAME=admin \
  -e WORDPRESS_PASSWORD=your-app-password \
  mcp/wordpress-elementor-assistant
```

In `.mcp.json` eintragen:

```json
{
  "wordpress": {
    "type": "stdio",
    "command": "docker",
    "args": ["run", "-i", "--rm",
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

---

## Attribution

Verlinkte Plugins werden aus ihren Original-Repos bezogen und behalten Lizenz und Autorenschaft. Die exakte Herkunft und Revision steht im Claude-Marketplace; die jeweilige Upstream-Lizenz wird in das generierte Codex-Plugin kopiert.

| Quelle | Inhalt | Autor |
|---|---|---|
| [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | SEO-Skills | AgricIDaniel |
| [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | Obsidian-Skills | kepano |
| [`mattpocock/skills`](https://github.com/mattpocock/skills) | `grill-me` u.a. | mattpocock |
| [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | Azure-Skills + MCP | Microsoft |
| [`obra/superpowers`](https://github.com/obra/superpowers) | Entwicklungs-Workflows und Skills | Jesse Vincent |

Die `MIT`-Lizenz dieses Repos bezieht sich auf die Kuratierung, Doku, Build-Skripte und lokal gepflegte Skills unter `plugins/gravit-custom/skills/`. Verlinkte Plugins unterliegen ihren jeweiligen Upstream-Lizenzen unter `plugins/<name>/LICENSE`.

---

## Verwandte Repos (geplant)

- `gravit-cloud-platform` — Self-hosted Docker Compose Stack (Typebot, n8n, Traefik, MinIO)
- `gravit-agents` — Agenten-Implementierungen (Hermes, Flock, Ollama/Claude)
