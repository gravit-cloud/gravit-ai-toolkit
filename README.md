# gravit-ai-toolkit

Kuratierte, agentenneutrale Plugin-Registry der Gravit Cloud Organisation für Claude Code, Codex und die statische OpenClaw-Adapterprojektion.

## Registry-Modell

`registry/catalog.json` ist die einzige manuell gepflegte Quelle für Plugin-Auswahl, Distribution-Versionen, unveränderliche Quell-Pins, Ressourcen und Ziel-Policies. Ein gemeinsamer Sync erzeugt zusammen:

- `registry/lock.json` mit Provenienz und Digests,
- `.claude-plugin/marketplace.json` und `.agents/plugins/marketplace.json`,
- `plugins/<name>/` als universelles Bundle mit neutralen Komponenten sowie den Projektionen `targets/claude`, `targets/codex` und `targets/openclaw`.

`registry/lock.json`, die Marketplaces und `plugins/` werden nicht einzeln gepflegt oder von Hand geändert.

## Enthaltene Plugins

| Plugin | Inhalt | Quelle |
|---|---|---|
| `claude-seo` | SEO-Audits, Content, Schema, GEO und weitere SEO-Workflows | `AgricIDaniel/claude-seo` |
| `obsidian` | Obsidian CLI, Markdown, Bases, Canvas und Defuddle | `kepano/obsidian-skills` |
| `mattpocock-skills` | Engineering- und Produktivitäts-Workflows | `mattpocock/skills` |
| `azure` | Azure-Skills und Azure-MCP-Konfiguration | `microsoft/azure-skills` |
| `superpowers` | Entwicklungs-Workflows für Planung, TDD, Debugging und Reviews | `obra/superpowers` |
| `gravit-custom` | Lokal gepflegte Gravit-Skills | `sources/gravit-custom` |

Exakte Refs, Commit-SHAs, Distribution-Versionen und Digests stehen im Katalog und Lock.

## Native Marketplace-Installation

Claude Code:

```bash
/plugin marketplace add gravit-cloud/gravit-ai-toolkit
/plugin install azure@gravit-cloud
/plugin marketplace update gravit-cloud
```

Codex:

```bash
codex plugin marketplace add gravit-cloud/gravit-ai-toolkit
codex plugin add azure@gravit-cloud
codex plugin marketplace upgrade gravit-cloud
```

Skills werden mit dem Plugin-Namen als Namespace aufgerufen, zum Beispiel `/azure:azure-cost`.

## Verifizierte Registry-Nutzung

Produktionsverbraucher checken immer ein Release-Tag oder einen exakten Commit aus, niemals `main`. Die Registry kann vollständig offline inspiziert und verifiziert werden:

```bash
npm run registry -- list
npm run registry -- inspect --plugin azure
npm run registry -- verify --plugin azure
```

Materialisierung ist unveränderlich und write-once. Der unmittelbare Parent muss existieren; das Ziel selbst darf noch nicht existieren. Der Pfad enthält deshalb Plugin, Distribution-Version, Registry-Revision und Ziel:

```bash
PLUGIN=azure
DISTRIBUTION_VERSION=1.2.5-gravit.2
REGISTRY_REVISION="$(git rev-parse HEAD)"
TARGET_PARENT="/opt/gravit/plugins/$PLUGIN/$DISTRIBUTION_VERSION/$REGISTRY_REVISION"

install -d "$TARGET_PARENT"
npm run registry -- materialize \
  --plugin "$PLUGIN" \
  --target codex \
  --output "$TARGET_PARENT/codex"
npm run registry -- materialize \
  --plugin "$PLUGIN" \
  --target openclaw \
  --output "$TARGET_PARENT/openclaw"
openclaw plugins install "$TARGET_PARENT/openclaw" --force
```

Eine erfolgreiche Materialisierung endet mit `.gravit-plugin-receipt.json`. Sie bindet Registry-Revision, Plugin, Ziel, Distribution-Version sowie Quell- und Ergebnis-Digests. Ein Fehler nach der exklusiven Zielerstellung lässt die unvollständige Ausgabe absichtlich zur Diagnose stehen; das Fehlen eines gültigen Receipts ist das Fehlersignal. Ein Deployment-Controller darf seinen eigenen `current`-Pointer erst umschalten, nachdem er das finale Receipt und alle Digests geprüft hat. Der Registry-Materializer löscht, ersetzt oder aktiviert keinen Consumer-Zustand.

## OpenClaw-Grenzen

Der aktuelle Adapter erzeugt ein Codex-formatkompatibles Bundle, das OpenClaw installieren und im deaktivierten Zustand statisch inspizieren kann. Er lädt keinen nativen In-Process-Plugin-Code. Nicht unterstützte Komponenten bleiben im neutralen Manifest ausdrücklich markiert, beispielsweise Claude-Hook-JSON. Erfolgreiche Installation oder Inspektion ist deshalb keine pauschale Laufzeit-Kompatibilitätsgarantie.

## Einsatzmuster

### Lokale Entwicklung

```bash
npm ci --ignore-scripts
npm run registry -- verify --plugin azure
```

Materialisiere in einen neuen versions- und revisionsspezifischen Pfad unter einem lokalen Arbeitsverzeichnis. Ein zweiter Versuch auf dasselbe Ziel ist erwartungsgemäß ein Fehler.

### Gepinnte CI-Images

CI verwendet Node 24 und pinnt das Container-Image zusätzlich zum Tag auf einen unveränderlichen OCI-Digest, zum Beispiel das organisationsweit freigegebene `node:24.18.0-bookworm-slim@sha256:<64-hex-digest>`. Auch der Registry-Checkout ist auf Release-Tag oder Commit-SHA gepinnt. `npm ci --ignore-scripts` verhindert Lifecycle-Ausführung; Verifikation und Materialisierung führen niemals Bundle-Inhalte aus.

### Cloud Shared Volumes

Ein Init-Job oder Deployment-Controller materialisiert auf einem schreibbaren Shared Volume in den vollständigen unveränderlichen Pfad. Workloads mounten die validierte Revision read-only. Erst nach Receipt- und Digest-Prüfung darf der Controller einen eigenen atomaren `current`-Pointer auf die neue Revision setzen. Alte oder unvollständige Verzeichnisse bleiben bis zu einer separat autorisierten Retention-Entscheidung unangetastet.

## Universelle Release-Archive

`npm run build` verifiziert zuerst die committed Registry und erstellt genau ein Archiv je Katalog-Plugin:

```text
dist/<plugin>-v<distributionVersion>.zip
```

Jedes ZIP besitzt genau einen Top-Level-Ordner mit dem Plugin-Namen und enthält das unveränderte universelle Bundle, alle drei Zielprojektionen, `LICENSE` und `.gravit-plugin-receipt.json`. Das Receipt-Ziel `universal` ist ausschließlich für diese Archive reserviert; alle drei Digest-Felder entsprechen dem verifizierten `bundleDigest` aus dem Lock.

Archive werden deterministisch mit festen Zeitstempeln, stabilen Modi und sortierten Pfaden gebaut. Veröffentlichung ist write-once: ein vorhandenes Archiv ist ein Fehler und wird weder gelöscht noch ersetzt. Private Build-Stages bleiben auf Erfolg und Fehler zur Recovery erhalten. Für zwei Vergleichsbauten werden zwei neue Output-Roots verwendet:

```bash
FIRST_ROOT="$(mktemp -d)"
SECOND_ROOT="$(mktemp -d)"
DIST_DIR="$FIRST_ROOT/dist" npm run build
DIST_DIR="$SECOND_ROOT/dist" npm run build
```

## Maintainer-Runbook

1. Katalogänderungen ausschließlich in `registry/catalog.json` und lokale Inhalte ausschließlich in `sources/` vornehmen. Externe Quellen behalten lesbaren `ref` plus exakten 40-stelligen `sha`-Pin.
2. Bei jeder verteilten Änderung die betroffene `distributionVersion` erhöhen. Andere Plugin-Revisionen bleiben unverändert.
3. Die gepinnten Tools einschließlich der für Client-Smoke-Tests benötigten nativen Clients installieren und alle Outputs gemeinsam regenerieren:

   ```bash
   npm ci
   npm run plugins:sync
   ```

4. Die vollständigen Offline- und Client-Gates ausführen:

   ```bash
   npm test
   npm run validate
   npm run registry:verify
   npm run smoke:clients
   ```

5. Universelle Archive in einem frischen Output-Root bauen:

   ```bash
   RELEASE_ROOT="$(mktemp -d)"
   DIST_DIR="$RELEASE_ROOT/dist" npm run build
   ```

6. `registry/lock.json`, beide Marketplaces und alle generierten Plugin-Outputs zusammen mit Katalog/Quelländerungen committen. Die Release-Workflow-Datei installiert Node 24 mit gepinnten Actions und `npm ci --ignore-scripts`, validiert Tag gegen `package.json`, wiederholt die rein statischen Tests und Registry-Gates und übergibt ausschließlich die vom Builder strukturell validierten Archivpfade an `gh release create`. Native Client-Smoke-Tests bleiben im Maintainer-Gate mit regulärem `npm ci`.

## Einen lokalen Skill hinzufügen

Lege `sources/gravit-custom/skills/<name>/SKILL.md` mit YAML-Frontmatter (`name`, `description`) und Markdown-Inhalt an. Die lokale Quelle darf keinen oder genau einen kanonischen Top-Level-Lizenznamen (`LICENSE`, optional `.md`, `.rst` oder `.txt`, Groß-/Kleinschreibung beliebig) besitzen; mehrere, symbolische oder spezielle Lizenz-Einträge werden abgelehnt. Danach Distribution-Revision erhöhen und das Maintainer-Runbook ausführen.

## Lizenz und Attribution

Die Repository-Kuratierung, Build-Tools und lokal gepflegten Quellen stehen unter der MIT-Lizenz. Externe Plugins behalten ihre jeweilige Upstream-Lizenz; die kanonische Kopie liegt im universellen Bundle unter `plugins/<name>/LICENSE`.
