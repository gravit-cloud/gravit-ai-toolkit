# Agent-neutraler Plugin-Registry- und Bundle-Generator

Status: Architektur im Gespräch freigegeben; Dokument zur Review

Datum: 2026-07-27

Repository: `gravit-ai-toolkit`

## 1. Kontext

Das Repository ist heute gleichzeitig Claude-Marketplace, Codex-Generator und Ablage für lokal gepflegte Skills. Die Datei `.claude-plugin/marketplace.json` ist die kuratierte Quelle; `scripts/sync-plugins.mjs` lädt externe Quellen und erzeugt daraus Codex-Bundles unter `plugins/` sowie `.agents/plugins/marketplace.json`.

Dieses Modell ist nicht verlustfrei. Der aktuelle Generator behandelt vor allem Skills:

- Upstream-MCP-Server, Hooks und weitere Plugin-Komponenten werden nicht vollständig übernommen.
- Rekursiv gefundene Parent- und Child-Skills werden jeweils vollständig kopiert. Dadurch können in einem erzeugten Bundle mehrere auffindbare `SKILL.md` mit demselben `name` entstehen.
- Der vorhandene Duplikat-Guard prüft nur die ausgewählten Copy-Roots, nicht die rekursiv mitkopierten Inhalte.
- Die Validierung betrachtet nur direkte Kinder von `skills/` und übersieht verschachtelte Duplikate und nicht berücksichtigte Komponenten.
- Die semantische Upstream-Version ist zugleich die erzeugte Plugin-Version. Ändert sich nur der gepinnte SHA oder die Transformation, kann ein Client einen bereits gecachten Stand weiterverwenden.

Ein isolierter Re-Sync des aktuellen Azure-Pins hat gezeigt, dass die eingecheckten Duplikate reproduzierbar sind. Es handelt sich nicht nur um ein veraltetes Artefakt.

## 2. Zielbild

`gravit-ai-toolkit` wird eine zentrale, agent-neutrale Registry für versionierte Plugin-Bundles. Ein eingechecktes Bundle enthält alles, was lokale Coding-Agenten, OpenClaw, CI/CD-Pipelines oder Cloud-Agenten zum Auswählen und Laden seiner Fähigkeiten benötigen.

Ein Bundle trennt dabei drei Ebenen:

1. **Komponenteninventar:** normalisierte, agent-neutrale Skills, Commands, Subagents, MCP- und LSP-Server, Hooks, Apps sowie weitere ausführbare oder darstellende Komponenten.
2. **Target-Projektionen:** aus dem Inventar erzeugte Claude-, Codex-, OpenClaw- und spätere Cloud-Darstellungen.
3. **Provenienz:** unveränderliche Herkunft, Transformationsentscheidungen, Inhalts-Hashes und Laufzeitabhängigkeiten.

Die Registry ist die kuratierte Quelle. Claude ist ein Zielsystem wie Codex und nicht mehr das übergeordnete Datenmodell.

## 3. Ziele und Nicht-Ziele

### Ziele

- Ein manuell gepflegter, agent-neutraler Katalog ist die einzige Konfigurationsquelle.
- Externe Quellen sind durch einen vollständigen Commit-SHA gepinnt.
- Generierte Bundles sind eingecheckt und nach einem Checkout ohne erneuten Upstream-Download nutzbar.
- Jede erkannte Komponente wird pro Ziel explizit bewahrt, transformiert, abgelehnt oder durch eine dokumentierte Ausnahme deaktiviert. Es gibt kein stilles Weglassen.
- Claude und Codex werden im ersten Meilenstein als vollwertige Adapter unterstützt.
- OpenClaw kann eine explizite Kompatibilitätsprojektion installieren; Pipeline- und Cloud-Agenten können zusätzlich das neutrale Manifest auswerten. Native oder weitere Zieladapter lassen sich ohne Änderung des Katalogmodells ergänzen.
- Git-Tags beziehungsweise Releases bilden zunächst die zentrale, gemeinsam lesbare Distribution; Verbraucher können einen Repository-Stand unveränderlich pinnen.
- Der Build ist deterministisch, atomar und offline verifizierbar.
- Rekursiv auffindbare Skill-Namen sind innerhalb einer Zielprojektion eindeutig.
- Änderungen an Quelle oder Transformation führen zu einer neuen, expliziten Distributionsversion und damit zu einer neuen Cache-Identität.

### Nicht-Ziele des ersten Meilensteins

- Kein automatisches Aktivieren vertrauenswürdiger Hooks oder MCP-Server auf einem Zielsystem.
- Keine Speicherung von Credentials, Tokens, Kundendaten oder zielsystemspezifischen Secrets.
- Kein pauschales Vendoring beliebiger externer Laufzeitprogramme. Gezielt eingebettete Programme benötigen Lizenz- und Sicherheitsfreigabe; nicht eingebettete Laufzeitabhängigkeiten werden exakt gepinnt und im Bundle deklariert.
- Kein nativer, im OpenClaw-Prozess laufender Plugin-Code. Der erste OpenClaw-Adapter erzeugt stattdessen ein Bundle in genau einem von OpenClaw unterstützten Kompatibilitätsformat und bleibt dadurch innerhalb der engeren Bundle-Trust-Grenze.
- Noch kein separater Registry-Dienst oder Objekt-Storage. Die Ablage im Git-Repository ist die erste belastbare Registry-Implementierung; spätere Backends verwenden dieselben Bundles und Hashes.
- Keine Veröffentlichung in einem externen öffentlichen Marketplace als Teil dieses Umbaus.

## 4. Bewertete Ansätze

### A. Den bestehenden Claude-zu-Codex-Sync reparieren

Dieser Ansatz ergänzt MCP-Copy, korrigiert die Skill-Flattening-Logik und erweitert die Validierung. Er wäre für Azure kurzfristig klein, behält Claude aber als implizites Domainmodell und würde bei jedem weiteren Agenten eine neue paarweise Übersetzung erzeugen.

### B. Agent-neutrale Registry mit Zieladaptern

Ein neutrales Inventar wird einmal aus der gepinnten Quelle gebaut. Adapter erzeugen daraus Claude-, Codex- und spätere Zielprojektionen. Komponenten, Provenienz und Transformationsentscheidungen werden zentral erfasst.

Dieser Ansatz ist die gewählte Architektur. Er verursacht eine größere einmalige Migration, verhindert aber die fortlaufende Kopplung an ein einzelnes Agentenformat.

### C. Upstream-Inhalte erst bei der Installation laden

Das Repository würde nur Metadaten und Pins enthalten; jeder Verbraucher lädt die eigentlichen Inhalte selbst. Das reduziert die Repository-Größe, ist aber für reproduzierbare Pipelines, eingeschränkte Cloud-Umgebungen und Offline-Nutzung ungeeignet. Dieser Ansatz wird verworfen.

## 5. Zielstruktur im Repository

```text
registry/
  catalog.json
  lock.json
  schemas/
    catalog.schema.json
    agent-plugin.schema.json
    lock.schema.json

sources/
  gravit-custom/
    ...                         # manuell gepflegte lokale Quelle

plugins/
  <plugin-name>/                # vollständig generiertes Universal-Bundle
    .agent-plugin/
      plugin.json               # neutrales Manifest und Inventar
    components/
      skills/
      commands/
      agents/
      mcp/
      lsp/
      hooks/
      apps/
      output-styles/
      monitors/
      themes/
      channels/
      executables/
      settings/
      assets/
    targets/
      claude/
        .claude-plugin/
          plugin.json
        ...                     # eigenständig installierbare Claude-Projektion
      codex/
        .codex-plugin/
          plugin.json
        ...                     # eigenständig installierbare Codex-Projektion
      openclaw/
        .codex-plugin/
          plugin.json
        ...                     # eigenständig installierbares Kompatibilitätsformat
    LICENSE
    NOTICE

.claude-plugin/marketplace.json # generiert; zeigt auf targets/claude
.agents/plugins/marketplace.json# generiert; zeigt auf targets/codex

scripts/
  sync-plugins.mjs              # schlanker Orchestrator
  validate.mjs                  # Offline-Gesamtvalidierung
  registry.mjs                  # Registry-lesende Consumer-CLI
  lib/
    catalog.mjs
    source-loader.mjs
    inventory.mjs
    bundle-builder.mjs
    provenance.mjs
    consumer.mjs
    targets/
      claude.mjs
      codex.mjs

test/
  fixtures/
  unit/
  integration/
```

Alle Verzeichnisse unter `plugins/` sind im Zielzustand generiert und dürfen nicht manuell editiert werden. Der heute manuell gepflegte Inhalt von `plugins/gravit-custom/` zieht nach `sources/gravit-custom/` um und durchläuft danach dieselbe Pipeline wie externe Quellen.

Die neutralen Komponenten liegen bewusst außerhalb der von Claude oder Codex deklarierten Skill-Pfade. Dadurch werden sie nicht zusätzlich als Ziel-Skills entdeckt. Zielprojektionen dürfen Inhalte duplizieren, wenn Agenten unterschiedliche Frontmatter- oder Layoutanforderungen haben; diese Duplikation ist deterministischer Build-Output, keine zweite Quelle.

Jede Zielprojektion ist für sich ein vollständiger Plugin-Root einschließlich ihres nativen Manifests. Das ist erforderlich, damit dieselbe Projektion sowohl direkt aus dem Marketplace installiert als auch unverändert durch die Consumer-CLI materialisiert werden kann. Die generierten Marketplaces zeigen deshalb nicht auf den Universal-Bundle-Root, sondern auf das jeweilige Verzeichnis unter `targets/`.

## 6. Katalogmodell

`registry/catalog.json` wird manuell gepflegt und durch JSON Schema validiert. Eine gekürzte Struktur sieht so aus:

```json
{
  "schemaVersion": 1,
  "name": "gravit-cloud",
  "plugins": [
    {
      "name": "azure",
      "description": "Microsoft Azure capabilities",
      "category": "cloud",
      "distributionVersion": "1.2.5-gravit.1",
      "source": {
        "type": "github",
        "repo": "microsoft/azure-skills",
        "ref": "v1.2.5",
        "sha": "013b97d8aab03ce8cd88944976e9988f8c829746",
        "root": "."
      },
      "targets": ["claude", "codex", "openclaw"],
      "policies": {
        "default": "transform-or-fail",
        "skills": "transform",
        "mcp": "transform",
        "hooks": "transform-or-fail",
        "apps": "transform-or-fail"
      },
      "adapterOptions": {
        "openclaw": {
          "bundleFormat": "codex"
        }
      }
    }
  ]
}
```

`source.root` bezeichnet den Plugin-Root innerhalb des gepinnten Repositorys und ist standardmäßig `.`. Lokale Quellen verwenden `source.type: "local"` plus einen Pfad unter `sources/`. Pfade außerhalb des Repositorys und aufgelöste Pfade außerhalb des konfigurierten Source-Roots werden abgelehnt.

`distributionVersion` ist von der Upstream-Version getrennt. Sie muss erhöht werden, sobald sich der erzeugte Bundle-Hash ändert. Der Sync schlägt fehl, wenn bei gleicher Distributionsversion ein anderer Inhalt als im bisherigen Lockfile entstünde. Damit erhalten auch reine Transformationsänderungen eine neue Cache-Identität.

Zielspezifische Policies dürfen eine Komponente bewusst als `unsupported` behandeln, wenn Ziel, Komponenten-ID und dauerhafte technische Begründung angegeben sind. Ausnahmen von einer eigentlich verpflichtenden Policy sind nur mit verantwortlicher Person und Ablaufdatum erlaubt. Eine abgelaufene Ausnahme lässt Build und CI fehlschlagen.

## 7. Neutrales Bundle-Manifest

`.agent-plugin/plugin.json` ist die stabile Schnittstelle für eigene Loader, Pipelines und Cloud-Agenten. Es enthält mindestens:

- Schema-Version, Plugin-ID, Distributionsversion und Beschreibung.
- Upstream-Version, Repository, Ref und vollständigen SHA.
- Eine typisierte Komponentenliste mit stabilen IDs und relativen Pfaden. Die initialen Typen umfassen mindestens Skills, Commands, Agents, MCP, LSP, Hooks, App-Bindings, Output Styles, Monitors, Themes, Channels, Executables, Settings und Assets.
- Unterstützte Ziele und den Status jeder Komponente pro Ziel.
- Exakte Laufzeitabhängigkeiten und benötigte, aber wertfreie Umgebungsvariablen.
- Inhalts-Hashes der Komponenten und Zielprojektionen.
- Lizenz- und Trust-Metadaten.

Zulässige Target-Status sind:

- `preserved`: unverändert in die Projektion übernommen.
- `transformed`: deterministisch für das Ziel übersetzt.
- `unsupported`: im neutralen Bundle vorhanden, für das Ziel nicht installierbar oder nicht ausführbar; nur mit expliziter Target-Policy und maschinenlesbarer Begründung zulässig.
- `rejected`: aus Sicherheits-, Lizenz- oder Schemagründen bewusst nicht paketiert; der Sync schlägt ohne explizite Katalogentscheidung fehl.

Neue Komponentenarten werden nicht automatisch als Assets behandelt. Solange Schema, Inventarisierung und mindestens eine Policy fehlen, schlägt der Sync geschlossen fehl.

## 8. Lockfile und Provenienz

`registry/lock.json` wird generiert und ohne Zeitstempel geschrieben, damit identische Eingaben byte-identischen Output erzeugen. Pro Plugin enthält es:

- die aufgelöste Quelle und den vollständigen Commit-SHA;
- die beobachtete Upstream-Version;
- die Distributionsversion;
- Version beziehungsweise Hash des Generators und der Adapter;
- den Hash des neutralen Komponentenbestands;
- den Hash jeder Zielprojektion und des Gesamtbundles;
- eine Komponentenbilanz: entdeckt, paketiert, transformiert, durch Ausnahme deaktiviert oder abgelehnt;
- gepinnte Laufzeitabhängigkeiten;
- aktive Ausnahmen.

Das Lockfile ist beweisende Build-Metadaten, nicht die kuratierte Eingabe. Pins werden im Katalog geändert; der Sync aktualisiert daraufhin Lockfile und Bundles gemeinsam.

Der Gesamtbundle-Hash ist ein Tree-Hash über die lexikografisch sortierte Liste `relativer Pfad + SHA-256 des Dateiinhalts`. Das außerhalb des Bundles liegende Lockfile nimmt nicht an seinem eigenen Hash teil. Dadurch entsteht keine selbstreferenzielle Prüfsumme.

## 9. Sync-Pipeline

Der neue Sync arbeitet in einem temporären Staging-Verzeichnis und ersetzt sichtbare Artefakte erst, nachdem alle Plugins vollständig gebaut und validiert wurden:

1. Katalog und bestehendes Lockfile laden und gegen ihre Schemas prüfen.
2. Den vollständigen konfigurierten Source-Root externer Quellen am exakten SHA beziehungsweise lokale Quellen aus `sources/` in ein isoliertes Staging-Verzeichnis kopieren. Es genügt ausdrücklich nicht, nur ein bekanntes `skills/`-Unterverzeichnis zu laden.
3. Agentenspezifische Upstream-Manifeste und bekannte Komponentenpfade untersuchen.
4. Ein vollständiges neutrales Inventar erzeugen.
5. Komponenten normalisieren und mit Hashes in `components/` schreiben.
6. Für jedes konfigurierte Ziel einen Adapter ausführen.
7. Komponentenbilanz, Schemas, Links, Versionen, Lizenzen und Sicherheitsregeln prüfen.
8. Eigenständig installierbare Ziel-Roots, Gesamtbundle und Marketplaces erzeugen.
9. Deterministischen Hash bilden und Versionsregel gegen das bisherige Lockfile prüfen.
10. Alle Bundles, Marketplaces und das Lockfile als eine logische Einheit atomar ersetzen.

Bei einem Fehler bleiben die zuvor eingecheckten beziehungsweise lokal vorhandenen Bundles vollständig unverändert. Ein abgebrochener Lauf hinterlässt keinen gemischten Zustand aus alten und neuen Plugins.

## 10. Skill-Inventarisierung und Projektion

Die Skill-Verarbeitung wird in Discovery, Auswahl und Rendering getrennt.

### Discovery

- Deklarierte Skill-Pfade im Upstream-Manifest haben Vorrang.
- Fehlt eine Deklaration, werden Verzeichnisse mit einer frontmatter-führenden `SKILL.md` rekursiv entdeckt.
- Dateien `SKILL.md` ohne eigenständiges Frontmatter innerhalb eines Skills gelten als interne Ressource des Parent-Skills.
- Jeder Pfad wird kanonisch aufgelöst; Pfadtraversal und Symlink-Ausbruch aus der Quelle werden abgelehnt.

### Auswahl ohne überlappende Copy-Roots

Die Pipeline baut zunächst einen Skill-Baum. Ist ein ausgewählter Skill ein Vorfahr eines weiteren ausgewählten Skills, wird sein Verzeichnis nicht blind zusammen mit dem Child als zweite Wurzel kopiert. Stattdessen werden Dateien genau einmal in den neutralen Baum aufgenommen und die zwei logischen Skill-IDs verweisen auf disjunkte gerenderte Zielverzeichnisse. Ein Parent darf weiterhin interne Ressourcen enthalten, aber keine zweite auffindbare Kopie eines eigenständigen Child-Skills.

### Eindeutigkeit

Nach dem Rendering wird nicht nur die erste Ebene, sondern jede rekursiv auffindbare `SKILL.md` geprüft. Ein `name` darf pro Zielprojektion genau einmal vorkommen. Außerdem müssen Verzeichnisname, Manifest-ID und Frontmatter-Name der jeweiligen Zielkonvention entsprechen.

### Target-Transformation

Claude- und Codex-Adapter rendern getrennte Skill-Ansichten. Beispielsweise darf der Codex-Adapter ein Claude-spezifisches `disable-model-invocation: true` entfernen, ohne die neutrale oder Claude-Darstellung zu verändern. Relative Links werden anhand des Skill-Baums neu berechnet; hart codierte Sonderfälle für einzelne Repositories sind nicht zulässig. Ein nicht auflösbarer lokaler Link ist ein Build-Fehler, sofern er nicht als dokumentierter Upstream-Defekt ausgenommen wurde.

## 11. MCP-Server

MCP-Konfiguration wird in ein internes Modell normalisiert:

- stabile Server-ID;
- Transport (`stdio`, HTTP oder ein zukünftig unterstützter Transport);
- Command, Argumente und Arbeitsverzeichnis;
- wertfreie Namen benötigter Umgebungsvariablen;
- optionale OAuth-/Authentifizierungsmetadaten;
- exakt gepinnte externe Laufzeitabhängigkeiten.

Die Adapter lesen sowohl deklarierte Manifestfelder als auch referenzierte Konfigurationsdateien und rendern daraus das jeweilige Zielformat. Referenzen werden relativ zum Bundle aufgelöst und im Manifest des Zielsystems eingetragen.

Ungepinntes `latest`, Floating Tags oder nicht auflösbare Paketversionen sind unzulässig. Soll ein MCP-Server über einen externen Paketmanager gestartet werden, muss der Katalog die genaue Version festlegen. Das Bundle bleibt damit reproduzierbar, auch wenn das Laufzeitpaket aus Größen- oder Lizenzgründen nicht eingecheckt wird.

Secrets werden nie aus der Build-Umgebung übernommen. Das Bundle darf nur Variablennamen und Setup-Hinweise enthalten.

## 12. Hooks, Apps und weitere Komponenten

Hooks bestehen aus Eventbindung, ausführbarer Aktion, benötigten Assets und einer Trust-Einstufung. Der neutrale Bestand bewahrt Upstream-Skripte, sofern Lizenz und Sicherheitsregeln dies erlauben. Ein Zieladapter darf einen Hook nur als unterstützt markieren, wenn Eventmodell, Variablen und Ausführungssemantik vollständig übersetzt sind.

Hooks werden beim Installieren nicht automatisch aktiviert. Der jeweilige Host beziehungsweise die Pipeline entscheidet anhand der Trust-Metadaten, ob eine Freigabe nötig ist.

Apps werden als eigene Komponentenart modelliert und nicht als gewöhnliches MCP oder Asset verschluckt. Im Codex-Format ist `.app.json` eine Kompatibilitätsbindung zu einer registrierten MCP-Verbindung, nicht ein zweiter Servertyp. Das neutrale Modell hält daher App-Binding, referenzierten MCP-Server sowie gegebenenfalls dessen UI-Ressourcen, MIME-Metadaten und CSP-/Domain-Anforderungen getrennt, aber verknüpft. Solange ein Zieladapter diese Semantik nicht beherrscht, ist das Ziel für die Komponente `unsupported` und benötigt eine explizite Target-Policy. Dadurch kann eine neue Upstream-App nicht unbemerkt aus einem Bundle verschwinden.

Commands beziehungsweise ältere Slash-Command-Dateien werden als eigener Quelltyp erfasst, auch wenn ein Ziel sie später als Skills rendert. Dasselbe gilt für Subagent-Definitionen. So bleibt erkennbar, ob ein Ziel einen Agent wirklich ausführen kann oder seinen Inhalt lediglich als Promptmaterial bewahrt.

LSP-Server, Output Styles, Monitors, Themes, Channels, Executables und Default Settings sind ebenfalls erstklassige Komponenten. Ausführbare Dateien und Hintergrundkomponenten folgen denselben Pinning-, Trust- und Freigaberegeln wie Hooks und MCP-Server. Einstellungen werden als strukturierte Defaults behandelt, niemals als ungeprüfter Patch auf die Host-Konfiguration. Zielmetadaten wie Icons, Screenshots und Starter-Prompts bleiben von ausführbaren Komponenten getrennt.

## 13. Adaptervertrag

Jeder Zieladapter implementiert dieselben Operationen:

1. `supports(component)`: Entscheidung mit maschinenlesbarer Begründung.
2. `render(component, context)`: deterministische Zielprojektion ohne Netzwerkzugriff.
3. `manifest(bundle)`: zielformatspezifisches Plugin-Manifest.
4. `marketplace(catalog)`: optionaler Marketplace-Eintrag.
5. `validate(output)`: Schema- und Semantikprüfung der Projektion.

Adapter erhalten nur das neutrale Inventar und Katalog-Policies, niemals ungeprüfte freie Pfade. So lassen sich weitere Hosts oder ein eigener Cloud-Loader ergänzen, ohne erneut GitHub-Quellen parsen zu müssen.

Der OpenClaw-Adapter erzeugt kein `openclaw.plugin.json`, weil dies das Bundle zu einem nativen, im Prozess laufenden Plugin machen würde. Er rendert pro Plugin genau ein von OpenClaw unterstütztes Claude- oder Codex-Bundleformat. Das Format wird im Katalog festgelegt: `codex` eignet sich für Skills, MCP, Apps und übersetzte OpenClaw-Hook-Packs; `claude` zusätzlich für Commands, Settings und LSP. Komponenten, die OpenClaw nur diagnostiziert, aber nicht ausführt, werden nicht fälschlich als unterstützt markiert.

Da OpenClaw für fremde Kompatibilitätsbundles keine automatische `npm install`-Reparatur ausführt, gilt eine Laufzeitkomponente dort nur dann als ausführbar, wenn ihr Binary im Bundle liegt oder ein deklarierter Host-Prerequisite-Check die exakt gepinnte Abhängigkeit bestätigt. Andernfalls bleibt die Komponente im neutralen Inventar, erhält für OpenClaw aber den Status `unsupported`.

Der generische Pipeline-/Cloud-Loader verwendet direkt `.agent-plugin/plugin.json`, wählt benötigte Komponenten nach Typ und Zielstatus und materialisiert sie in ein explizit konfiguriertes Arbeitsverzeichnis. Er darf keine Hooks ausführen oder MCP-Server starten, ohne dass die aufrufende Umgebung dies freigibt.

## 14. Distribution und Nutzung

Das Git-Repository ist zunächst Registry und Distributionskanal zugleich. Ein Release-Tag bezeichnet einen konsistenten Satz aus Katalog, Lockfile und Universal-Bundles. Pipelines und Cloud-Deployments pinnen einen Tag oder Commit-SHA; `main` ist keine reproduzierbare Produktionsreferenz.

Eine Registry-lesende CLI stellt eine agent-neutrale Consumer-Schnittstelle bereit. Sie verändert weder Katalog noch Bundles, schreibt aber auf ausdrücklichen `materialize`-Aufruf in das angegebene Consumer-Ziel:

```text
node scripts/registry.mjs list
node scripts/registry.mjs inspect --plugin azure
node scripts/registry.mjs materialize --plugin azure --target codex --output <path>
node scripts/registry.mjs materialize --plugin azure --target openclaw --output <path>
node scripts/registry.mjs verify --plugin azure
```

`list` und `inspect` lesen ausschließlich Katalog, Lockfile und neutrale Manifeste. `materialize` kopiert die passende, bereits eigenständig installierbare Zielprojektion atomar in einen explizit angegebenen Zielpfad und schreibt darin eine kleine Receipt-Datei mit Plugin-ID, Distributionsversion, Registry-Commit, Gesamtbundle-Hash und Zielprojektions-Hash. Bestehende fremde Dateien werden nicht überschrieben, sofern kein exakt passender, zuvor von der CLI geschriebener Receipt ihre Eigentümerschaft und den unveränderten Payload-Hash belegt.

Die CLI lädt keine Upstream-Quellen, startet keine MCP-Server und aktiviert keine Hooks. Bei Bedarf kann ein späterer Release-Job dieselben Universal-Bundles zusätzlich als signierte Archive veröffentlichen; deren Tree-Hash muss dem Lockfile entsprechen. Das ändert weder Katalog noch Bundleformat.

Für typische Verbraucher ergibt sich damit:

- lokale Entwicklung: Repository klonen oder als Submodul pinnen und ein Target in ein lokales Agentenverzeichnis materialisieren;
- OpenClaw: die schmale Kompatibilitätsprojektion materialisieren und mit `openclaw plugins install` als Bundle installieren; für nicht ausführbare Komponenten bleibt das neutrale Inventar die vollständige Bilanz;
- CI/CD: Repository-Commit pinnen, `verify` ausführen und nur die benötigten Komponenten ins Build-Artefakt übernehmen;
- Cloud-Agenten: Bundle oder signiertes Archiv in ein Image beziehungsweise einen kontrollierten Shared Volume legen und anhand des Receipts verifizieren.

## 15. Validierung

`npm run validate` bleibt vollständig offline und prüft mindestens:

- Katalog-, Lock- und Manifest-Schemas.
- vollständige SHA-Pins und erlaubte lokale Source-Roots.
- Übereinstimmung von Katalog, Lockfile, Bundles und Marketplaces.
- Komponentenbilanz ohne unerklärte Verluste.
- rekursive Skill-Eindeutigkeit, Frontmatter und relative Links.
- Existenz und Hash aller referenzierten Komponenten und Assets.
- zielsystemspezifische Manifest- und Konfigurationsschemas.
- Vollständigkeit aller bekannten Claude-, Codex- und OpenClaw-Komponentenpfade einschließlich Commands, Agents, LSP, Monitors, Settings und Executables.
- keine Floating Runtime Dependencies.
- keine bekannten Secret-Werte oder unzulässigen absoluten Pfade.
- Lizenzdateien für weiterverteilte externe Inhalte.
- gültige, nicht abgelaufene Ausnahmen.
- unveränderte Distributionsversion nur bei unverändertem Bundle-Hash.

Zusätzlich erhält `npm run plugins:verify` einen Determinismus-Check: Es baut ausschließlich aus eingecheckten Test-Fixtures beziehungsweise lokalen Quellen und vergleicht den Output bytegenau. Der Netzwerksync bleibt ein expliziter Maintainer-Schritt und ist keine Voraussetzung für Verbraucher des Repositorys.

## 16. Teststrategie

### Zuerst rote Regressionstests

1. Ein Fixture mit einem Parent-Skill und einem eigenständigen verschachtelten Child-Skill darf im Codex-Output jeden Namen genau einmal enthalten.
2. Zwei tatsächlich verschiedene Skills mit demselben Frontmatter-Namen müssen vor dem Schreiben eines Bundles fehlschlagen.
3. Ein Fixture mit `.mcp.json` und Manifestreferenz muss in neutralem Inventar und beiden Zielprojektionen auftauchen.
4. Eine deklarierte Hook-Datei darf weder verschwinden noch ohne Status in der Komponentenbilanz bleiben.
5. Der Validator muss ein manuell eingebrachtes verschachteltes Skill-Duplikat finden.
6. Ein veränderter Source-SHA oder Adapter-Output bei gleicher `distributionVersion` muss fehlschlagen.
7. Die Consumer-CLI darf nur eine passende Zielprojektion materialisieren und keine fremden Dateien überschreiben.
8. Ein Fixture mit Commands, Agent, LSP oder Monitor muss diese Komponenten inventarisieren und pro Ziel wahrheitsgemäß als ausführbar, transformiert oder nicht unterstützt ausweisen.

### Unit-Tests

- Manifest-Parser für String-, Array- und Objektformen.
- Skill-Baum und Erkennung überlappender Copy-Roots.
- Pfadnormalisierung, Symlink- und Traversal-Abwehr.
- Link-Rewriting ohne repository-spezifische Sonderfälle.
- MCP-Normalisierung und Runtime-Pinning.
- Komponentenbilanz und Ausnahmeablauf.
- stabile JSON-Sortierung und Hashbildung.
- Auswahl, atomare Materialisierung und Receipt-Prüfung der Consumer-CLI.

### Integrations- und Smoke-Tests

- Vollständiger Offline-Build aus kleinen Fixtures.
- Zweiter Build ohne Diff.
- Fehler in einem Plugin lässt alle bisherigen Bundles unangetastet.
- Claude-Marketplace wird in einer isolierten Konfiguration geladen und das Plugin-Manifest aufgelöst.
- Codex-Marketplace wird in einem isolierten `CODEX_HOME` hinzugefügt; Plugin, Skills und gebündelte MCP-Definition werden erkannt.
- OpenClaw installiert die materialisierte Kompatibilitätsprojektion in einer isolierten Konfiguration und meldet Skills sowie MCP als ausführbar; nur diagnostizierte Komponenten erscheinen nicht als ausführbar.
- Eine neue Distributionsversion ersetzt in einer frischen Client-Session nachweislich den alten Cache-Inhalt.
- Azure dient als reale End-to-End-Regression: eindeutige Skills, vorhandener Azure-MCP-Eintrag und vollständige Komponentenbilanz.

Netzwerkabhängige Client-Smoke-Tests laufen getrennt von den deterministischen Unit- und Offline-Integrationstests und dürfen lokale Entwicklerläufe nicht unnötig blockieren.

## 17. CI- und Update-Workflow

Der normale Pull-Request-Check führt aus:

```text
npm ci
npm test
npm run validate
npm run plugins:verify
git diff --exit-code
```

Ein Renovate- oder Maintainer-Update ändert zunächst Ref, SHA und bei verändertem Output die `distributionVersion` im Katalog. Danach läuft der Netzwerksync, der Bundles und Lockfile gemeinsam aktualisiert. Der Pull Request zeigt deshalb sowohl die Herkunftsänderung als auch den tatsächlich ausgelieferten Komponenten-Diff.

CI darf einen reinen SHA-Wechsel ohne neue Distributionsversion nicht akzeptieren. Dazu vergleicht sie betroffene Lockfile-Einträge zusätzlich mit dem Merge-Base-Stand; ein gemeinsam manipulierter neuer Katalog- und Lockfile-Stand darf keine bereits verwendete Version mit anderem Hash wiederverwenden. Ebenso darf eine neue Upstream-Komponentenart nicht allein deshalb grün werden, weil ältere Adapter sie nicht kennen.

## 18. Sicherheit und Betrieb

- Quellen werden nur an vollständigen SHAs geladen und vor dem Build in einem isolierten Staging-Verzeichnis behandelt.
- Der Sync führt keine Upstream-Hooks, Installer oder Build-Skripte aus.
- Ausführbare Komponenten erhalten Hash und Trust-Metadaten.
- Absolute lokale Pfade, Credentials und konkrete Secret-Werte sind in Bundles verboten.
- Target-Loader materialisieren nur in explizit erlaubte Zielverzeichnisse.
- Consumer-Receipts und Bundle-Hashes werden vor Wiederverwendung oder Update geprüft.
- Das Löschen veralteter Bundles erfolgt erst nach erfolgreichem Gesamtbuild und nur für Pfade, die aus dem validierten Katalog abgeleitet wurden.
- Lizenz und NOTICE werden pro Bundle bewahrt; Komponenten mit unklarer Weiterverteilungslizenz lassen den Sync fehlschlagen.

## 19. Migration in kleinen Schritten

### Phase 1: Regressionsnetz

- Test-Runner ergänzen.
- Fixtures für Nested Skills, MCP, Hooks und Versionsdrift hinzufügen.
- Aktuelle Fehler reproduzierbar rot machen.

### Phase 2: Neutrale Registry und Provenienz

- `registry/catalog.json`, Schemas und Lockfile einführen.
- Bestehende Marketplace-Einträge verlustfrei migrieren.
- `gravit-custom` nach `sources/` verschieben.
- Generator auf atomaren Gesamtbuild umstellen.

### Phase 3: Skills korrekt modellieren

- Skill-Baum statt rekursiver Blindkopie einführen.
- Claude- und Codex-Projektionen getrennt rendern.
- rekursive Validierung und generisches Link-Rewriting aktivieren.

### Phase 4: MCP, Hooks und Apps bilanzieren

- MCP normalisieren und für Claude/Codex rendern.
- Runtime-Pins erzwingen.
- Hooks und Apps inventarisieren; unterstützte Hooks übersetzen und übrige Fälle geschlossen behandeln.
- Commands, Agents, LSP, Monitors, Styles, Themes, Channels, Executables und Settings inventarisieren und zielgenau projizieren.

### Phase 5: Client-Smoke-Tests und Dokumentation

- isolierte Claude-/Codex-Installationsprüfungen in CI integrieren.
- Registry-lesende Consumer-CLI mit atomarer Materialisierung ergänzen.
- OpenClaw-Kompatibilitätsprojektion und isolierten Bundle-Smoke-Test integrieren.
- lokale Entwicklung, Pipeline-Nutzung und Cloud-Materialisierung dokumentieren.
- Update- und Ausnahmeprozess dokumentieren.

### Phase 6: Weitere Adapter

- Bei tatsächlichem Bedarf einen nativen OpenClaw-Adapter gegen den festgelegten Adaptervertrag bauen; dieser benötigt eine gesonderte Trust- und Codeausführungsentscheidung.
- Bei Bedarf schlanke Zielpakete aus dem Universal-Bundle exportieren, ohne eine neue Quelle einzuführen.

Jede Phase endet mit grünem Offline-Validator und einem diff-freien zweiten Build. Die bestehenden Marketplaces bleiben während der Migration benutzbar.

## 20. Abnahmekriterien

Die Architektur gilt als umgesetzt, wenn:

- `registry/catalog.json` die einzige manuell gepflegte Marketplace-Konfiguration ist;
- alle Bundles und beide aktuellen Marketplaces daraus reproduzierbar entstehen;
- ein Checkout die eingecheckten Bundles ohne Upstream-Netzwerkzugriff verwenden kann;
- Azure-MCP in neutralem Manifest und Codex-Projektion vorhanden ist;
- jede Skill-ID in jeder Zielprojektion rekursiv genau einmal vorkommt;
- jede entdeckte Komponente in der Bilanz eine explizite Behandlung besitzt;
- ein unbekannter Komponententyp oder eine nicht unterstützte Pflichtkomponente den Build stoppt;
- eine Inhaltsänderung ohne neue Distributionsversion den Build stoppt;
- ein fehlerhafter Sync keinen partiell aktualisierten Plugin-Baum hinterlässt;
- Offline-Tests, Validator, Determinismusprüfung sowie isolierte Claude-/Codex-Smoke-Tests grün sind;
- die OpenClaw-Kompatibilitätsprojektion installierbar ist und ihre ausführbaren gegenüber nur diagnostizierten Komponenten korrekt ausweist;
- ein weiterer Adapter ausschließlich über den dokumentierten Adaptervertrag hinzugefügt werden kann;
- ein auf einen Registry-Commit gepinnter Verbraucher ein Bundle offline prüfen und atomar materialisieren kann.

## 21. Voraussichtlich betroffene Dateien

Neu:

- `registry/catalog.json`
- `registry/lock.json`
- `registry/schemas/*.schema.json`
- `sources/gravit-custom/**`
- `scripts/lib/**`
- `scripts/registry.mjs`
- `test/fixtures/**`
- `test/unit/**`
- `test/integration/**`
- `.agent-plugin/plugin.json` und Target-Projektionen je Bundle

Zu ändern:

- `scripts/sync-plugins.mjs`
- `scripts/validate.mjs`
- `package.json`
- `.claude-plugin/marketplace.json`
- `.agents/plugins/marketplace.json`
- `renovate.json` und `scripts/renovate-plugin-sync.sh`
- `README.md`, `AGENTS.md` und betroffene Betriebsdokumentation

Zu migrieren beziehungsweise vollständig neu zu generieren:

- `plugins/gravit-custom/**`
- `plugins/claude-seo/**`
- `plugins/obsidian/**`
- `plugins/mattpocock-skills/**`
- `plugins/azure/**`
- `plugins/superpowers/**`

## 22. Normative Referenzen

Die Adapter implementieren die am Entwurfsdatum dokumentierten Hostformate; die Offline-Fixtures frieren die jeweils unterstützte Schemaform ein. Änderungen dieser Quellen werden wie Adapteränderungen behandelt und können eine neue Distributionsversion auslösen:

- [Claude Code Plugins Reference](https://code.claude.com/docs/en/plugins-reference)
- [OpenAI: Package your plugin](https://developers.openai.com/plugins/build/plugins)
- [OpenAI: Build skills](https://developers.openai.com/plugins/build/skills)
- [OpenClaw Plugin bundles](https://docs.openclaw.ai/plugins/bundles)

Die eigentliche Umsetzung soll aus dieser Spezifikation in einen separaten, testgetriebenen Implementierungsplan zerlegt werden. Dieser Entwurf nimmt noch keine Änderungen am Generator oder an generierten Plugin-Bundles vor.
