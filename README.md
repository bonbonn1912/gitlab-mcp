# GitLab Data Center MCP Server für Gemini CLI

TypeScript-MCP-Server für eine **GitLab Self-Managed-Instanz im eigenen Rechenzentrum**. Der Server nutzt `stdio` und die GitLab REST API v4. `gitlab.com` und dessen Subdomains werden als SaaS-Ziele abgewiesen.

## Voraussetzungen

- Node.js 20 oder neuer
- Gemini CLI
- Ein GitLab Personal-, Project- oder Group-Access-Token. Für Schreibzugriffe wird der Scope `api` benötigt.

## Installation

```sh
npm install
npm run build
```

Die Gemini-Konfiguration reicht `GITLAB_URL` und `GITLAB_TOKEN` aus der Umgebung explizit an den MCP-Server weiter. Wenn diese Variablen nicht gesetzt sind, lädt der Server sie aus `.env`. `.env` wird von Git ignoriert; den Token nicht direkt in `.gemini/settings.json` oder im Quellcode speichern.

```sh
cp .env.example .env
# .env bearbeiten und GITLAB_URL sowie GITLAB_TOKEN eintragen
gemini
```

Die Projektkonfiguration in `.gemini/settings.json` startet `dist/index.js` mit Gemini CLI. Führe Gemini aus dem Projektverzeichnis aus. Nach Änderungen an der TypeScript-Quelle `npm run build` erneut ausführen.

Für eine GitLab-Instanz mit URL-Unterpfad kann `GITLAB_URL` zum Beispiel `https://gitlab.firma.example/gitlab` lauten. `/api/v4` wird vom Server ergänzt.

## Tools

Die Tools folgen der Liste aus [`tools.md`](./tools.md): Projekte und Repository, Merge Requests und Issues sowie Pipelines und CI-Jobs. Für CI-Analysen kann Gemini Pipeline-Testreports mit fehlgeschlagenen Tests abrufen, Job-Logs und Jobdetails zusammenführen sowie einzelne Artefaktdateien laden. Das Durchsuchen von Artefaktarchiven benötigt GitLab 18.8 oder neuer; Abrufe von Report-Artefakten über `file_type` benötigen GitLab 19.4 oder neuer. Einzelne Artefaktdateien und Reports sind auf 90.000 Bytes begrenzt.

Listen liefern eine Seite mit `items`, `total_count`, `has_more` und `next_page`. Pro Aufruf sind bis zu 100 Einträge möglich.

Schreibende Operationen sind als MCP-Tools mit Schreibhinweisen markiert. Dazu gehören Branches, Commits, Merge Requests, Kommentare, Issues sowie das Starten, Abbrechen und Wiederholen von Pipelines und Jobs. `play_job` löst genau den angegebenen manuellen Job aus.

## Gemini CLI

Die enthaltene Projektkonfiguration definiert den Server `gitlab-datacenter`. Prüfe die Verbindung in Gemini CLI mit `/mcp list`; Tools erscheinen mit dem Präfix `mcp_gitlab-datacenter_`, zum Beispiel `mcp_gitlab-datacenter_list_projects`.

Bei fehlenden oder ungültigen Zugangsdaten gibt der Server die Ursache über `stderr` aus. `stdout` bleibt für das MCP-Protokoll reserviert.

Für die angefragte interne Self-Signed-Konfiguration setzt der Prozess `NODE_TLS_REJECT_UNAUTHORIZED=0`. Dadurch wird die TLS-Zertifikatsprüfung für sämtliche HTTPS-Verbindungen dieses MCP-Prozesses abgeschaltet.

## Sicherheit und Grenzen

- `GITLAB_URL` muss auf eine Self-Managed-Instanz zeigen; `gitlab.com` wird blockiert.
- `GITLAB_TOKEN` wird ausschließlich als `PRIVATE-TOKEN`-Header an die konfigurierte Instanz gesendet und nie in Tool-Antworten ausgegeben.
- Der Server führt nur API-Aufrufe gegen die konfigurierte GitLab-Instanz aus; er akzeptiert keine frei wählbaren URLs in Tool-Eingaben.
- GitLab entscheidet anhand des Tokens über Projektzugriff und Berechtigungen.
- GitLab-Dedicated-Instanzen mit eigener Domain lassen sich technisch nicht zuverlässig von Self-Managed-Instanzen unterscheiden. Verwende für diese Konfiguration ausschließlich die von dir verwaltete Data-Center-Instanz.
