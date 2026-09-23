# Gordion Outreach Machine

Interne Outreach-Anwendung für den kontrollierten B2B-Funnel über Outlook/Microsoft Graph. Sie ist bewusst vom öffentlichen statischen Webauftritt getrennt.

## Sicherheitszustand beim Start

- `MAIL_PROVIDER=simulated`: alle Aktionen bleiben lokal.
- `LIVE_SEND_ENABLED=false`: selbst mit gültigen Graph-Zugangsdaten ist `send` gesperrt.
- Kampagnen beginnen als `draft` und Kontakte als `needs_review`.
- Eine Nachricht kann nur nach dokumentierter Freigabe, außerhalb jeder Sperre und innerhalb aller Limits geleast werden.

## Lokal starten

```bash
cp .env.example .env
cp config/microsoft-365.example.json config/microsoft-365.json
docker compose up -d postgres
npm install
npm run db:migrate
npm test
npm run dev
```

Der API-Prozess läuft standardmäßig auf `http://127.0.0.1:4310`. Der Worker ist ein separater Prozess (`npm run dev:worker`), damit API-Neustarts keine Versandjobs duplizieren.

`npm run smoke:worker` darf nur auf einer separaten, entbehrlichen lokalen Datenbank mit dem Namenssuffix `_test` laufen. Er verändert den globalen Pausenzustand und legt synthetische Datensätze an. Die CI nutzt dafür einen frischen PostgreSQL-Service und ausschließlich den Simulator; keine Microsoft-Anmeldung oder Secrets sind nötig.

## Verzeichnisstruktur

- `docs/architecture.md`: Systemgrenzen, Funnel und Fehlermodelle
- `docs/microsoft-graph-setup.md`: Microsoft-Einrichtung und Berechtigungsprüfung
- `config/microsoft-365.example.json`: Vorlage; echte Konfiguration bleibt lokal und Git-ignoriert
- `migrations/`: PostgreSQL-Schema als technische Quelle der Wahrheit
- `src/domain/`: Zustände und reine Versandregeln
- `src/mail/`: Provider-Schnittstelle, Simulator und Graph-Adapter
- `src/repositories/`: transaktionale Queue- und Audit-Zugriffe
- `src/services/`: Versand- und Inbox-Orchestrierung
- `src/http/`: interne API und Graph-Webhook

## Noch bewusst nicht aktiviert

Es gibt keine echte Empfängerliste und keine Live-Kampagne. Microsoft-Zugangsdaten und konkrete Tenant-Konfiguration gehören nicht ins Repository. Dieser PR liefert ein Backend-Fundament, keine produktionsreife Versandmaschine und keine fertige Review-Oberfläche.

## Microsoft 365 – aktueller Einrichtungsstand

Kontotyp und IDs werden lokal in `config/microsoft-365.json` hinterlegt. Der Graph-Adapter startet zusätzlich im Modus `read_only` und blockiert Schreiboperationen unmittelbar am API-Zugriff. Eine geschäftliche Signatur bleibt offen.

`npm run graph:check` zeigt fehlende Einrichtungswerte ohne Netzwerkzugriff. Fehlt die lokale Tenant-Konfiguration, wird die Beispielvorlage mit `configured: false` angezeigt und eine Verbindung verweigert. Start-, Migrations- und Diagnosebefehle laden optionale `.env`-Werte selbst. Mit `-- --connect` führt die Diagnose nach Zertifikateinrichtung einen Lese- und Negativtest durch. Anleitung: `docs/microsoft-graph-setup.md`.
