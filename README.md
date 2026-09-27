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

Setze die Zugangsdaten in der Shell, aus der du Gemini CLI startest. Den Token nicht in `.gemini/settings.json` oder im Quellcode speichern.

```sh
export GITLAB_URL="https://gitlab.firma.example"
export GITLAB_TOKEN="<dein-token>"
gemini
```

Die Projektkonfiguration in `.gemini/settings.json` startet `dist/index.js` mit Gemini CLI. Führe Gemini aus dem Projektverzeichnis aus. Nach Änderungen an der TypeScript-Quelle `npm run build` erneut ausführen.

Für eine GitLab-Instanz mit URL-Unterpfad kann `GITLAB_URL` zum Beispiel `https://gitlab.firma.example/gitlab` lauten. `/api/v4` wird vom Server ergänzt.

## Tools

Die Tools folgen der Liste aus [`tools.md`](./tools.md): Projekte, Repository-Baum/Dateien/Suche/Commits, Branches/Tags/Releases, Merge Requests und Diskussionen, Issues, Pipelines und CI-Jobs. Listen liefern eine Seite mit `items`, `total_count`, `has_more` und `next_page`. Pro Aufruf sind bis zu 100 Einträge möglich.

Schreibende Operationen sind als MCP-Tools mit Schreibhinweisen markiert. Dazu gehören Branches, Commits, Merge Requests, Kommentare, Issues und das Starten von Pipelines.

## Gemini CLI

Die enthaltene Projektkonfiguration definiert den Server `gitlab-datacenter`. Prüfe die Verbindung in Gemini CLI mit `/mcp list`; Tools erscheinen mit dem Präfix `mcp_gitlab-datacenter_`, zum Beispiel `mcp_gitlab-datacenter_list_projects`.

Bei fehlenden oder ungültigen Zugangsdaten gibt der Server die Ursache über `stderr` aus. `stdout` bleibt für das MCP-Protokoll reserviert.

## Sicherheit und Grenzen

- `GITLAB_URL` muss auf eine Self-Managed-Instanz zeigen; `gitlab.com` wird blockiert.
- `GITLAB_TOKEN` wird ausschließlich als `PRIVATE-TOKEN`-Header an die konfigurierte Instanz gesendet und nie in Tool-Antworten ausgegeben.
- Der Server führt nur API-Aufrufe gegen die konfigurierte GitLab-Instanz aus; er akzeptiert keine frei wählbaren URLs in Tool-Eingaben.
- GitLab entscheidet anhand des Tokens über Projektzugriff und Berechtigungen.
- GitLab-Dedicated-Instanzen mit eigener Domain lassen sich technisch nicht zuverlässig von Self-Managed-Instanzen unterscheiden. Verwende für diese Konfiguration ausschließlich die von dir verwaltete Data-Center-Instanz.
