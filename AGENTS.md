# AGENTS.md

**gravit-ai-toolkit** ist ein kuratierter Plugin-Marketplace der Gravit Cloud Organisation für Claude Code und Codex.

- `registry/catalog.json` ist die einzige manuell gepflegte Quelle für Plugin-Auswahl, Distribution-Versionen, Quell-Pins, Ressourcen und Ziel-Policies.
- `sources/` enthält lokal gepflegte Plugin-Quellen, darunter `sources/gravit-custom/`.
- Alle Verzeichnisse unter `plugins/`, `.claude-plugin/marketplace.json`, `.agents/plugins/marketplace.json` und `registry/lock.json` werden gemeinsam generiert.
- Generierte Plugin-Interna nie von Hand bearbeiten. Nach Änderungen an Katalog oder lokalen Quellen `npm run plugins:sync` ausführen und alle verwalteten Ausgaben zusammen committen.

Vor dem Commit immer `npm test && npm run validate` ausführen.

---

## Repository-Struktur

```
.claude-plugin/
  marketplace.json         # generierter Claude-Marketplace
.agents/plugins/
  marketplace.json         # generierter Codex-Marketplace
registry/
  catalog.json             # einzige gepflegte Katalog- und Pin-Quelle
  lock.json                # generierte Provenienz, Digests und Dispositionen
  schemas/                 # neutrale Registry-Schemas
sources/
  gravit-custom/           # lokal gepflegte Dual-Plugin-Quelle
plugins/
  <plugin>/                # vollständig generiertes neutrales Bundle
    .agent-plugin/plugin.json
    components/            # neutrale Komponenten
    targets/claude/        # Claude-Projektion
    targets/codex/         # Codex-Projektion
scripts/
  sync-plugins.mjs         # gesamtes Registry-Modell generieren
  validate.mjs             # Offline-Validierung aller Artefakte
  build-registry.mjs       # atomarer Registry-Builder
build.sh                   # baut Release-Archive
package.json               # Build-, Test- und Release-Tooling
AGENTS.md                  # Diese Datei
CLAUDE.md                  # @AGENTS.md (Referenz für Claude Code)
README.md
LICENSE
```

### Plugin hinzufügen oder Quell-Pin ändern

Neuer Eintrag im `plugins`-Array von `registry/catalog.json`:

```json
{
  "name": "mein-plugin",
  "description": "Kurzbeschreibung",
  "category": "development",
  "distributionVersion": "1.0.0-gravit.1",
  "source": {
    "type": "github",
    "repo": "owner/repo",
    "ref": "v1.0.0",
    "sha": "<40-stelliger-commit>",
    "root": "."
  },
  "targets": ["claude", "codex"],
  "policies": { "default": "transform-or-fail", "skills": "transform" }
}
```

- `ref` = lesbarer Branch/Tag für Review und Renovate.
- `sha` = verpflichtender, exakter 40-stelliger Commit-Pin für Installation und Sync.
- `root` = optionaler Plugin-Unterpfad innerhalb des gepinnten Repositories.
- Nicht aus dem Upstream-Manifest ableitbare Laufzeitressourcen müssen explizit über `resources` katalogisiert werden.

### Skill zu `gravit-custom` hinzufügen

1. `sources/gravit-custom/skills/<name>/SKILL.md` anlegen:

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
3. `npm run plugins:sync` ausführen, damit neutrale Bundles und beide Zielprojektionen konsistent bleiben.
4. `bash build.sh` verifiziert die committed Registry und baut genau ein versioniertes universelles Archiv je Katalog-Plugin. Einzelne Skill-ZIPs werden nicht mehr erzeugt.

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
npm test
npm run validate
```

Für Produktionsverbraucher ist die Registry-CLI die verifizierte Schnittstelle:

```bash
npm run registry -- list
npm run registry -- inspect --plugin azure
npm run registry -- verify --plugin azure
```

Materialisierungen sind write-once und müssen unter einem Pfad der Form
`<shared-root>/<plugin>/<distributionVersion>/<registryRevision>/<target>`
liegen. Der unmittelbare Parent existiert, das Ziel noch nicht. Ein gültiges
`.gravit-plugin-receipt.json` schließt die Materialisierung ab; unvollständige
Ausgaben ohne gültiges Receipt bleiben als Recovery-Signal erhalten. Nur ein
Deployment-Controller darf nach Receipt- und Digest-Prüfung seinen eigenen
`current`-Pointer umschalten. Der Registry-Materializer löscht, ersetzt oder
aktiviert keinen Consumer-Zustand.

Der Sync inventarisiert die vom Upstream deklarierten Komponenten, baut ein neutrales Bundle und erzeugt daraus Claude- und Codex-Projektionen. Claude-spezifische `disable-model-invocation: true`-Flags werden nur in generierten Codex-Skills entfernt. Unterstützte MCP-Definitionen werden in die jeweilige Zielprojektion eingebettet und aus dem Host-Manifest referenziert; Laufzeitpakete müssen im Katalog exakt gepinnt sein.

Die Codex-Projektion belegt nur die erzeugte Dateistruktur und ihre internen Referenzen. Sie garantiert weder, dass `bin/` automatisch in `PATH` liegt, noch dass Claude-spezifische Upstream-Umgebungsvariablen durch Codex bereitgestellt werden. Hook-Konfigurationen und lokale Skripte werden statisch validiert, aber während Sync und Validierung nicht ausgeführt.

### Universelle Release-Archive

`npm run build` verifiziert die committed Registry und erzeugt write-once genau
ein deterministisches `dist/<plugin>-v<distributionVersion>.zip` je
Katalog-Plugin. Jedes Archiv enthält unter genau einem Plugin-Root das
universelle Bundle, alle Zielprojektionen, `LICENSE` und ein Receipt mit Ziel
`universal`. Dieses Ziel gilt nur im Receipt-Schema; Materialisierung unterstützt
weiterhin ausschließlich `claude` und `codex`.

Vorhandene Archive oder Output-Bäume nie löschen, ersetzen oder bereinigen.
Für Wiederholungs- oder Determinismusprüfungen zwei frische `DIST_DIR`-Roots
verwenden. Private Release-Stages bleiben auf Erfolg und Fehler erhalten. ZIP
und UnZIP werden ausschließlich über vertrauenswürdige absolute Systempfade,
statische Argumentarrays und minimale Umgebungen aufgerufen; Bundle-Inhalte
werden nie ausgeführt.

Produktionsconsumer pinnen immer ein Release-Tag oder einen exakten Commit,
niemals `main`. CI installiert mit `npm ci --ignore-scripts`, verwendet Node 24
und pinnt Container/Actions unveränderlich. Shared-Volume-Consumer mounten nur
eine vom Controller vollständig verifizierte Revision read-only.

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

Externe Plugins werden aus ihren Original-Repos bezogen und behalten Lizenz und Autorenschaft. Exakte Herkunft, Revision und Artefakt-Digests stehen in `registry/catalog.json` und der generierten `registry/lock.json`; die jeweilige Upstream-Lizenz liegt im Root des generierten Plugin-Bundles.

| Quelle | Inhalt | Autor |
|---|---|---|
| [`AgricIDaniel/claude-seo`](https://github.com/AgricIDaniel/claude-seo) | SEO-Skills | AgricIDaniel |
| [`kepano/obsidian-skills`](https://github.com/kepano/obsidian-skills) | Obsidian-Skills | kepano |
| [`mattpocock/skills`](https://github.com/mattpocock/skills) | `grill-me` u.a. | mattpocock |
| [`microsoft/azure-skills`](https://github.com/microsoft/azure-skills) | Azure-Skills + MCP | Microsoft |
| [`obra/superpowers`](https://github.com/obra/superpowers) | Entwicklungs-Workflows und Skills | Jesse Vincent |

Die `MIT`-Lizenz dieses Repos bezieht sich auf die Kuratierung, Doku, Build-Skripte und lokal gepflegte Quellen unter `sources/gravit-custom/`. Externe Plugins unterliegen ihren jeweiligen Upstream-Lizenzen unter `plugins/<name>/LICENSE`.

---

## Verwandte Repos (geplant)

- `gravit-cloud-platform` — Self-hosted Docker Compose Stack (Typebot, n8n, Traefik, MinIO)
- `gravit-agents` — Agenten-Implementierungen (Hermes, Flock, Ollama/Claude)

## Shared Obsidian Memory

When `../gravit-obsidian-brain` is available, use the installed Obsidian skills to consult it before architecture-level work and to record durable repository facts, decisions, learnings, or cross-repository runbooks after a task. Repository code and local documentation remain authoritative. Commit only the relevant vault files with a `docs(memory): ...` subject, never push automatically, and never store secrets or raw task logs.
