# AGENTS.md

**gravit-ai-toolkit** ist ein kuratierter **Plugin-Marketplace** der Gravit Cloud Organisation für Claude Code. Der Katalog (`.claude-plugin/marketplace.json`) vereint zwei Arten von Plugins:

- **verlinkt** — bereits veröffentlichte Fremd-Plugins, die per `github`-Source direkt aus ihrem Original-Repo bezogen und auf eine getestete Version gepinnt werden. Die Skills werden **nicht** in dieses Repo kopiert.
- **lokal** — das Plugin `gravit-custom` (`source: "./custom"`), dessen Skills unter `custom/skills/` liegen und selbst gepflegt werden.

Unterstützte Tools: primär Claude Code. Das lokale `custom/`-Plugin lässt sich zusätzlich über [skills.sh](https://www.skills.sh/) / `npx skills add` cross-tool (Cursor, Copilot, Warp) beziehen.

**Claude Code vs. Codex:** Der Marketplace (`marketplace.json`, `/plugin install`, namespaced Aufrufe) funktioniert nur in Claude Code. Codex kennt keine Plugins und arbeitet mit `AGENTS.md` + reinen Dateien. Für Codex liegt unter `codex/` ein **generiertes Bundle** aller referenzierten Skills als `codex/skills/<name>/SKILL.md`, beziehbar mit einem `npx giget`-Befehl (siehe `codex/README.md` und den Abschnitt „Codex / cross-tool" unten).

---

## Repository-Struktur

```
.claude-plugin/
  marketplace.json         # Katalog: 4 verlinkte Plugins + gravit-custom
custom/                    # lokales Plugin "gravit-custom"
  .claude-plugin/
    plugin.json            # Plugin-Manifest (name: gravit-custom)
  skills/<name>/SKILL.md   # eigene Skills (YAML-Frontmatter + Body)
  skills-lock.json         # Lockfile für extern via npx bezogene Skills
codex/                     # cross-tool Bundle für Codex (generiert, committed)
  skills/<name>/SKILL.md   # alle referenzierten Skills als reine Dateien
  AGENTS.md                # generierter Skill-Index (von Codex geladen)
  skills-manifest.json     # Provenienz + Anzahl je Skill (generiert)
  sync.sh                  # baut Bundle aus marketplace.json-Pins (npm run codex:sync)
  gen-index.mjs            # erzeugt AGENTS.md + manifest aus den SKILL.md-Frontmattern
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
| `claude-seo` | verlinkt | `AgricIDaniel/claude-seo` | `v2.2.0` |
| `obsidian` | verlinkt | `kepano/obsidian-skills` | SHA (kein Tag verfügbar) |
| `mattpocock-skills` | verlinkt | `mattpocock/skills` | `v1.0.1` |
| `azure` | verlinkt | `microsoft/azure-skills` | `v1.1.79` |
| `gravit-custom` | lokal | `./custom` | `v1.0.0` |

### Verlinktes Plugin hinzufügen / Version ändern

Neuer Eintrag im `plugins`-Array von `.claude-plugin/marketplace.json`:

```json
{
  "name": "mein-plugin",
  "description": "Kurzbeschreibung",
  "source": { "source": "github", "repo": "owner/repo", "ref": "v1.0.0" }
}
```

- `ref` = Branch/Tag (`"main"` für Auto-Updates, Tag für feste Version).
- `sha` = exakter Commit (nötig bei Repos ohne Tags).
- Monorepo: `{ "source": "git-subdir", "url": "…", "path": "pfad/zum/plugin" }`.
- Voraussetzung: Ziel-Repo ist ein Claude-Code-Plugin (`.claude-plugin/plugin.json` und/oder `skills/` im Repo-Root).

### Skill zu `gravit-custom` hinzufügen

1. `custom/skills/<name>/SKILL.md` anlegen:

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

2. Optional Version in `custom/.claude-plugin/plugin.json` hochzählen.
3. `bash build.sh` (erkennt Skills automatisch aus `custom/skills/*/SKILL.md`), committen, pushen.

Externen Skill in `custom/skills/` ziehen:

```bash
cd custom && npx skills add <org/repo>   # aktualisiert custom/skills/ + custom/skills-lock.json
cd custom && npx skills add              # stellt alle Lockfile-Einträge nach einem Clone wieder her
```

---

## Installation (Endnutzer)

```bash
# Einmalig: Marketplace registrieren
/plugin marketplace add gravit-cloud gravit-cloud/gravit-ai-toolkit

# Gewünschte Plugins installieren (jedes einzeln)
/plugin install claude-seo@gravit-cloud
/plugin install azure@gravit-cloud
/plugin install gravit-custom@gravit-cloud
# …

# Katalog & Plugin-Updates einspielen
/plugin marketplace update gravit-cloud
```

Skills werden namespaced aufgerufen: `/claude-seo:seo-audit`, `/azure:azure-cost`, `/gravit-custom:<skill>`.

---

## Codex / cross-tool

Codex nutzt keinen Marketplace. Das Verzeichnis `codex/` sammelt alle referenzierten Skills als reine Dateien und macht sie mit **einem** Befehl aus diesem Repo beziehbar.

**Endnutzer (Codex):**

```bash
# Komplettes Bundle (Skills + AGENTS.md-Index) ins Projekt ziehen
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex ./.gravit-skills --force
# oder nur die reinen Skills
npx giget@latest gh:gravit-cloud/gravit-ai-toolkit/codex/skills ./skills --force
```

Danach in der Projekt-`AGENTS.md` auf `.gravit-skills/AGENTS.md` verweisen; Codex liest bei passender Aufgabe das jeweilige `SKILL.md`.

**Maintainer — Bundle regenerieren** (nach Pin-Änderung in `marketplace.json`):

```bash
npm run codex:sync    # = bash codex/sync.sh
```

`sync.sh` liest die Pins aus `marketplace.json` (einzige Quelle der Wahrheit), holt jede `skills/`-Struktur per `npx giget` auf den gepinnten Stand, flacht sie zu `codex/skills/<name>/` ab, ergänzt `gravit-custom`-eigene Skills und regeneriert `codex/AGENTS.md` + `codex/skills-manifest.json`. Danach `codex/` committen.

Caveat: MCP-gestützte Skills (v.a. `azure`) liefern nur ihren Anleitungstext — referenzierte MCP-Tool-Aufrufe funktionieren in Codex nur mit konfiguriertem MCP-Server. Skill-Dateien behalten Lizenz und Autorenschaft (Provenienz in `codex/skills-manifest.json`).

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

28 Skills für Azure-Ressourcenverwaltung, Deployments, Diagnostics, Kostenanalyse, AKS, Foundry u.a. — inkl. mitgeliefertem Azure-MCP-Server.

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

Verlinkte Plugins werden aus ihren Original-Repos bezogen und behalten Lizenz und Autorenschaft. Für Skills, die in `custom/skills/` via `npx skills add` bezogen wurden, hält `custom/skills-lock.json` Provenienz und Hashes.

| Quelle | Inhalt | Autor |
|---|---|---|
| [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | 25 SEO-Skills | AgricIDaniel |
| [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | Obsidian-Skills | kepano |
| [`mattpocock/skills`](https://github.com/mattpocock/skills) | `grill-me` u.a. | mattpocock |
| [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | Azure-Skills + MCP | Microsoft |

Die `MIT`-Lizenz dieses Repos bezieht sich auf die Kuratierung (Katalog, Doku, Build-Skripte) sowie eigene Skills unter `custom/skills/`. Verlinkte Plugins unterliegen ihren jeweils eigenen Lizenzen.

---

## Verwandte Repos (geplant)

- `gravit-cloud-platform` — Self-hosted Docker Compose Stack (Typebot, n8n, Traefik, MinIO)
- `gravit-agents` — Agenten-Implementierungen (Hermes, Flock, Ollama/Claude)
