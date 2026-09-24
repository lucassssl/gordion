# Microsoft-365-Anbindung ohne Versand

Stand: 23.09.2026. Einrichtungsweg für ein Microsoft-365-Benutzerpostfach, auch bei GoDaddy. Keine Signatur und kein automatischer Versand. Die Anleitung enthält keine realen Mandanten- oder Benutzerkennungen.

`config/microsoft-365.example.json` lokal nach `config/microsoft-365.json` kopieren und mit geprüfter Tenant-ID, Benutzer-Objekt-ID, möglichen Absenderadressen und dem tatsächlich erreichbaren Administrator befüllen. Die echte Konfiguration und persönliche Aufgabenblätter sind Git-ignoriert. Primäre SMTP-Adresse anhand von Entra-Proxyadressen und anschließend Exchange prüfen; Benutzername und Alias sind kein Ersatz für diesen Abgleich.

Bei GoDaddy kann das normale Microsoft-365-Konto bereits Administrator sein. Im Email-&-Office-Dashboard prüfen und den Exchange-Zugang damit testen. Kein zusätzliches unbekanntes Admin-Konto und kein Passwortreset sind zwingend erforderlich. Ein erfolgreicher Portalzugang beweist noch nicht die erfolgreiche Vergabe von Application RBAC. Den objekt-ID-basierten Einrichtungsabgleich liefert der Exchange-Export.

Für den Negativtest wird ein tatsächlich vorhandenes zweites Postfach desselben Tenants benötigt. Ist nur das Outreach-Postfach vorhanden, bleibt der reale Negativtest offen. Nicht automatisch ein weiteres Postfach anlegen oder einen Benutzer einer anderen Organisation als Kontrollziel verwenden.

## Berechtigungen: Korrektur der ursprünglichen Anleitung

Die frühere Empfehlung, tenantweite Graph-Mailrechte mit Admin Consent zu erteilen und anschließend durch Exchange Application RBAC einzuschränken, war falsch: Beide Berechtigungswege wirken additiv. Breite Entra-Grants würden die Einschränkung umgehen.

Für die dedizierte Outreach-App werden Mailrechte ausschließlich über Exchange Application RBAC erteilt. Keine tenantweiten Entra-Application-Grants für Mail, SMTP oder EWS. App-Registrierung und Zertifikat authentifizieren die App; die Exchange-Rollenzuweisung autorisiert sie. Kein `User.Read.All` für die Outreach-App erforderlich.

| Phase | Exchange-Rolle im exakten Postfachscope | Laufzeit |
| --- | --- | --- |
| Jetzt: Verbindung prüfen | `Application Mail.Read` | `GRAPH_ACCESS_STAGE=read_only`, `LIVE_SEND_ENABLED=false` |
| Später: Entwürfe | `Application Mail.ReadWrite` (enthält Lesen) | `GRAPH_ACCESS_STAGE=drafts` |
| Später: aktivierter Versand | zusätzlich `Application Mail.Send` | `GRAPH_ACCESS_STAGE=send` und weitere Versandfreigaben |

Der Adapter blockiert in der aktuellen Phase sämtliche Graph-Schreiboperationen. Der Diagnosetest liest ausschließlich die ID des Inbox-Ordners. Der normale Inbox-Sync liest dagegen Mailmetadaten/Vorschauen und wird für diesen Test nicht gestartet.

## 1. Identität prüfen

PowerShell 7 und ExchangeOnlineManagement-Modul, im Ordner `outreach-machine`:

```powershell
./scripts/inspect-mailbox.ps1
```

Das Skript meldet sich mit dem angegebenen Admin an, prüft den Tenant und löst das Postfach anhand seiner Objekt-ID auf. Es liest PrimarySmtpAddress, EmailAddresses, UPN und Postfachart. Beide Kandidaten werden als primär, Alias oder nicht auf diesem Postfach ausgewiesen.

Das Ergebnis liegt in `.outreach-data/mailbox-evidence.json` (Git-ignoriert). Dieses Betreiber-Prüfprotokoll wird gegen Tenant, Objekt-ID, primäre Adresse und Aktualität geprüft; es ist kein signierter Identitätsnachweis. Die Laufzeit akzeptiert vorerst ausschließlich die primäre SMTP-Adresse. Aliasversand benötigt eine spätere eigene Prüfung.

Ein Admin-Benutzer ist nicht zwangsläufig ein Exchange-Postfach. Für den Negativtest ein tatsächlich vorhandenes zweites Postfach außerhalb des Scopes bestimmen. Ohne dieses bleibt der Negativtest offen. HTTP 404 gilt nicht als bestandene Zugriffsbeschränkung.

## 2. Single-Tenant-App und Zertifikat

Im angegebenen Tenant eine dedizierte App `Gordion Outreach` registrieren, nur für Konten dieses Organisationsverzeichnisses. Kein Redirect URI für den App-only-Dienst nötig. Festhalten:

- Application (client) ID aus App-Registrierungen.
- Object ID der zugehörigen Enterprise Application / Unternehmensanwendung. Diese ist weder die Objekt-ID der App-Registrierung noch eine Benutzer-ID.
- Öffentliches RSA-X.509-Zertifikat unter „Certificates & secrets“ hochladen; privaten Schlüssel außerhalb des Repositorys im Secret Store der Laufzeit halten.

MSAL unterstützt Zertifikatanmeldung; die Implementierung prüft Zusammengehörigkeit von Schlüssel/Zertifikat, RSA mindestens 2048 Bit und Gültigkeitszeitraum. Ein Client Secret wird für diesen Einrichtungsweg nicht benötigt. Keine Mailrechte unter Entra „API permissions“ erteilen.

## 3. Postfachbeschränkung vorbereiten

PowerShell-Module: ExchangeOnlineManagement, Microsoft.Graph.Applications und Microsoft.Graph.Authentication. Der Administrator braucht Exchange-Rollenzuweisungsrechte. Für das Lesen bestehender App-Grants meldet das Skript den Administrator separat mit delegated `Directory.Read.All` an. Diese Prüfberechtigung gehört nicht zur Outreach-App; eine nötige Zustimmung im Admin-Login ist gesondert zu behandeln.

```powershell
./scripts/prepare-exchange-rbac.ps1 -ClientId <APP-CLIENT-ID> -ServicePrincipalObjectId <ENTERPRISE-APP-OBJECT-ID> -ControlMailboxObjectId <EXISTING-CONTROL-MAILBOX-ID>
```

Ohne `-Apply` nur Prüfung/Plan. Das Skript verlangt für diese dedizierte App einen leeren Satz Entra-App-Rollengrants, prüft App-ID-Zuordnung und einen Filter auf exakt die Outreach-Objekt-ID. Bestehende Exchange-Rollenzuweisungen oder abweichende Scopes führen zur manuellen Prüfung; bestehende Berechtigungen werden nicht gelöscht.

Mit denselben Parametern und `-Apply` legt es Exchange-Service-Principal, Scope und ausschließlich `Application Mail.Read` an. Danach muss `Test-ServicePrincipalAuthorization` das Ziel im Scope und das Kontrollpostfach außerhalb zeigen. Teilweise abgeschlossene Einrichtung wird nicht automatisch zurückgerollt; vor Wiederholung vorhandene Objekte prüfen.

Die tatsächliche API kann Änderungen erst nach bis zu zwei Stunden sehen. Der RBAC-Test allein berücksichtigt keine Entra-Grants; daher sind Grantprüfung und tatsächlicher Negativtest beide nötig.

## 4. Konfiguration und lesender Verbindungstest

Die Beispielwerte in `.env.example` sind fiktiv. Nur lokal als `.env` kopieren, mit der geprüften Konfiguration abgleichen oder Umgebungsvariablen im Secret Store der Laufzeit verwenden. Ergänzen:

```dotenv
GRAPH_CLIENT_ID=<client-id>
GRAPH_CERTIFICATE_PATH=<absolute certificate path>
GRAPH_PRIVATE_KEY_PATH=<absolute private-key path>
GRAPH_MAILBOX_EVIDENCE_PATH=.outreach-data/mailbox-evidence.json
GRAPH_SENDER_ADDRESS=<verified PrimarySmtpAddress>
GRAPH_CONTROL_MAILBOX_OBJECT_ID=<verified existing second mailbox>
GRAPH_ACCESS_STAGE=read_only
LIVE_SEND_ENABLED=false
MAIL_PROVIDER=simulated
```

Der Diagnosebefehl ist unabhängig vom Versandworker, der Datenbank und von Webhooks:

```bash
npm run graph:check
npm run graph:check -- --connect
```

Der erste Befehl meldet fehlende Angaben ohne Netzwerkzugriff. `--connect` holt ein Token über MSAL und macht zwei GET-Anfragen auf die Inbox-Ordner-ID. Ziel: HTTP 200; bestehendes Kontrollpostfach: HTTP 403 mit ErrorAccessDenied. Andere Fehler beweisen keine Einschränkung. Tokens, Schlüssel und Mailinhalte werden nicht ausgegeben. Keine Nachricht/Subscription wird erstellt und kein Versand ausgelöst.

In einem Tenant mit nur einem Postfach kann `npm run graph:check -- --connect --target-only` zunächst die Zertifikatanmeldung und den Zielzugriff prüfen. Dieser Modus meldet ausdrücklich `mailboxIsolationVerified: false` und `controlDenied: null`. Er ersetzt weder die Kontrolle der Entra-Grants und des RBAC-Filters noch den ausstehenden Negativtest und aktiviert keinen Worker.

## Grenzen dieses Stands

Die PowerShell-Skripte benötigen eine Adminanmeldung. Der Identitäts-Export wurde bei der Einrichtung erfolgreich gegen Exchange geprüft. Ein lesender, exakt auf das Zielpostfach begrenzter RBAC-Scope wurde nach manueller Prüfung der Entra-App-Grants eingerichtet und mit `Test-ServicePrincipalAuthorization` positiv geprüft. Das vollständige Automationsskript einschließlich zweitem Kontrollpostfach ist noch nicht live abgenommen. Konkrete IDs und Prüfprotokolle bleiben lokal. Der Lesetest beweist keine Schreib-/Sendeberechtigung; eine erfolgreiche Zertifikat-/Graph-Verbindung darf erst nach dem tatsächlichen API-Test behauptet werden.

Wenn die Gerätecode-Anmeldung mit `AADSTS530035` scheitert, keine Sicherheitsstandards abschalten. Den regulären interaktiven Browser-Login von `Connect-ExchangeOnline` verwenden. Falls auch dieser blockiert wird, die konkrete Microsoft-Anmeldung administrativ prüfen lassen.

Für späteren Produktivversand bleiben eigene Abnahmen nötig, insbesondere Worker-Absturz während Provideroperationen, Sperren zwischen Lease und Send, Follow-up-Threading und Sync-Ausfälle. Der bisherige lokale Simulator-Durchlauf allein ist dafür kein Nachweis.

## Offizielle Quellen

- [Exchange Application RBAC einschließlich additiver Entra-Grants](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)
- [Get-EXOMailbox und ExternalDirectoryObjectId](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/get-exomailbox?view=exchange-ps)
- [Filterbare Exchange-Empfängereigenschaften](https://learn.microsoft.com/en-us/powershell/exchange/recipientfilter-properties?view=exchange-ps)
- [MSAL Node Zertifikatanmeldung](https://learn.microsoft.com/en-us/entra/msal/javascript/node/certificate-credentials)
- [Interaktive Anmeldung bei Exchange Online PowerShell](https://learn.microsoft.com/powershell/exchange/connect-to-exchange-online-powershell?view=exchange-ps)
