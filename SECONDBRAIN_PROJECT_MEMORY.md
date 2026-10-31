# Secondbrain — Projekt-Gedächtnis

Diese Datei fasst zusammen, warum das Projekt so aufgebaut ist, wie es aufgebaut ist, und was als Nächstes ansteht. Sie ersetzt kein Nachlesen von `ARCHITECTURE.md` (technisches Detail), sondern dokumentiert die Entscheidungen und den Verlauf dahinter, damit spätere Sessions (menschlich oder KI) nicht wieder bei null anfangen.

**Wichtig:** Diese Datei enthält absichtlich **keine** Passwörter, Client-Secrets oder API-Keys — nur Verweise darauf, wo sie konfiguriert sind (siehe Abschnitt "Secrets"). Das gilt auch für spätere Ergänzungen.

## Ausgangslage

Andreas nutzt Google Drive, Microsoft 365 (zwei Konten: `mostafa@lifeperformance.de` für 365, `mail@andreas-mostafa.com` als zugeordnete Adresse), OneNote und lokale Dateien auf seinem Rechner parallel und wollte das in einer einzigen durchsuchbaren Wissensbasis zusammenführen — mit Chat-Zugriff, der auch aus ChatGPT, Claude.ai und Langdock funktioniert, ohne bei jedem Tool-Wechsel Kontext neu hochzuladen.

Dies ist **kein Teil von Sindbad** (dem bestehenden B2B-Research/Outreach-Repo) — bewusst ein neues, eigenständiges Projekt/Repo: `moschti2026/secondbrain`.

## Zentrale Entscheidungen

- **Notizen: Obsidian statt Custom-Editor.** Kostenlos für die private Nutzung (kommerzielle Lizenz seit 2025 optional, nicht mehr Pflicht), lokale Markdown-Dateien, kein Vendor-Lock-in. Notizen laufen über denselben `local-sync-cli`-Mechanismus wie beliebige andere lokale Dateien — keine separate Notizen-Tabelle im Schema, kein zweiter Sync-Pfad. Mobile Nutzung/Sync zwischen Geräten ist optional Obsidians eigener (kostenpflichtiger) Sync-Dienst oder iCloud/Dropbox-Ordner — das ist Andreas' eigene Wahl, nicht Teil dieser App.
- **Supabase statt Self-Hosted-Postgres:** managed Postgres + `pgvector`-Extension, keine eigene DB-Administration. Genutzt wird nur die reine Postgres-Verbindung (`postgres`-npm-Paket über die "Transaction"-Pooler-Connection, Port 6543) — **nicht** Supabase Auth, Storage oder der PostgREST-Client. Row-Level-Security ist trotzdem aktiv, um die Tabellen abzusichern, falls sie je über PostgREST/den anon-Key erreichbar wären; die App selbst verbindet sich über die `postgres`-Rolle und umgeht RLS wie vorgesehen.
- **Vercel als Hosting:** Next.js-App + Cron-Job (täglicher Re-Sync, Hobby-Plan-Limit) + serverless API-Routen für Ingest/Chat/MCP.
- **Auth.js (Google + Microsoft Entra ID) statt separatem "Connect"-Schritt:** dieselben OAuth-Scopes, mit denen man sich einloggt, erlauben auch den Hintergrund-Sync (Drive/Graph-API). Kein zweiter OAuth-Flow für "Datenquelle verbinden" nötig. Tokens werden bei Bedarf über den gespeicherten Refresh-Token erneuert (`src/lib/oauth.ts`), damit der tägliche Cron auch ohne eingeloggte Browser-Session läuft.
- **Externe KI-Anbindung über MCP (Streamable HTTP) + ChatGPT Custom GPT Action**, nicht über OAuth-basierte Connector-Flows: Auth über einen in der URL eingebetteten API-Key (`/api/mcp/<key>`) bzw. `x-api-key`-Header — das umgeht Claudes teils beta-gated Header-Auth und vermeidet einen eigenen OAuth-Server nur für diesen Zweck.
- **Resumable/time-geboxte Sync-Connectoren** (45s Budget pro Aufruf, persistierter Resume-Cursor in `sync_state`): eine notwendige Reaktion auf serverlose Laufzeitlimits bei großen Erstsyncs (z.B. viele bestehende Drive-Dateien oder ein großes OneNote-Notizbuch), nicht nur Bugfix, sondern bewusstes Architekturprinzip für alle drei Connectoren.

Technisches Detail zu jedem Punkt: siehe `ARCHITECTURE.md`.

## Verlauf: aufgetretene Probleme und Fixes

Chronologisch, damit dieselben Fehler nicht wiederholt werden:

1. **GitHub-Repo-Erstellung über die GitHub-API schlug fehl** (403, "Resource not accessible by integration"). Andreas hat das Repo manuell über github.com/new angelegt, danach wurde es per `add_repo`/`register_repo_root` angebunden.
2. **`.enableRLS()` auf den Auth.js-Tabellen verursachte einen TypeScript-Fehler** (`@auth/drizzle-adapter`s `DrizzleAdapter()`-Typsignatur ist mit dem dadurch veränderten Rückgabetyp inkompatibel). Fix: `.enableRLS()` nur auf den 4 App-Tabellen (`documents`, `chunks`, `sync_state`, `sync_keys`), nicht auf den 4 Auth.js-Tabellen (`users`, `accounts`, `sessions`, `verificationTokens`) — dafür wird RLS für diese vier manuell per SQL aktiviert (siehe `DEPLOYMENT.md`, Schritt 7). Das ist so beabsichtigt, keine offene TODO.
3. **`npx drizzle-kit migrate` funktioniert nicht aus dieser Sandbox-Umgebung** — nur HTTPS-Egress über einen Policy-Proxy, keine rohe Postgres-TCP-Verbindung möglich. Deshalb dokumentiert `DEPLOYMENT.md` den SQL-Editor-Weg als gleichwertige Alternative (Migrationsdateien manuell in Supabase ausführen + Migrations-Tracking-Tabelle von Hand nachtragen).
4. **Sicherheitsvorfall:** Andreas hat versehentlich das Datenbank-Passwort im Klartext in den Chat eingefügt. Er hat es sofort selbst rotiert. Gelerntes Prinzip für zukünftige Arbeit an diesem Projekt: **niemals danach fragen, ein Secret im Chat einzufügen** — wo immer möglich, den Nutzer bitten, Werte direkt im jeweiligen Provider-UI einzutragen (Supabase, Vercel Environment Variables, etc.), statt sie hier durchzureichen.
5. **Vercel-Deploy #1 schlug fehl:** `cron_jobs_limits_reached` — der Hobby-Plan erlaubt nur tägliche Cron-Jobs. Fix: `vercel.json` von `"0 */6 * * *"` auf `"0 3 * * *"` geändert.
6. **Vercel-Deploy #2 schlug beim Typecheck fehl:** `local-sync-cli/src/index.ts` — `Cannot find module 'chokidar'`. Ursache: der App-eigene `tsconfig.json` hat versehentlich auch das separate `local-sync-cli`-Paket eingelesen (dessen Dependencies nicht Teil von `npm install` der Haupt-App sind). Fix: `"local-sync-cli"` in `tsconfig.json`s `exclude` aufgenommen.
7. **Erster echter Google-Drive-Sync verarbeitete 0 Dateien.** Ursache: die Google Drive Changes API kennt von sich aus keine "bestehenden Dateien", nur zukünftige Änderungen. Fix: `ingestExistingFiles()`-Backfill für den allerersten Sync ergänzt (`src/lib/connectors/google-drive.ts`).
8. **Client-Absturz im Sync-Button** bei einer Nicht-JSON-Serverantwort (`Unexpected end of JSON input`). Fix: `SyncButton.tsx` liest zuerst `.text()`, parsed danach mit Try/Catch.
9. **Hartnäckiger Sync-Fehler (Drive UND Microsoft 365), auch nach den obigen Fixes:** beide Connectoren riefen `ingestFile()` → `extractText()` → `pdf-parse` auf, welches über `@napi-rs/canvas` eine native Node-Erweiterung lädt, die beim Modul-Import auf Vercel crasht — noch bevor irgendein Try/Catch greifen kann. Das erklärte, warum Login/Dashboard funktionierten (die nie `ingest.ts` importieren), Sync/Ingest-Routen aber sofort und unabhängig von der Dateizahl fehlschlugen. **Fix:** `pdf-parse` durch `unpdf` ersetzt (keine nativen Dependencies, für Serverless/Edge gebaut) — siehe `src/lib/extract.ts`. Das war der eigentliche Root-Cause der Sync-Probleme.
10. **OneNote 20258 und Office-Sperrdateien (erster Produktions-Sync nach PR #4).** Manche Abschnitte (z.B. in Alina.one, Allerlei.one, Allgemein) antworten dauerhaft mit Graph 422 / Code 20258, "Sync of this section is not supported". Sie stehen im OneNote-Cursor in `sync_state.cursor` (keine neue Tabelle, keine Migration) und werden übersprungen. Neuversuch einmal pro Woche oder früher, wenn `lastModifiedDateTime` sich ändert. Sie zählen als `unsupportedSections`, nicht als Fehler. Dateien `~$*` und `~*.tmp` in Google Drive und OneDrive sind Word-Sperren bzw. Office-Temp-Dateien und werden nicht eingelesen. Bestehende Dokumentzeilen dazu bleiben erhalten; der Extraktionsfehler wird durch „Office-Sperrdatei, nicht indexiert“ ersetzt und der Retry-Zähler steht auf dem Maximum, damit die Warteschlange sie nicht erneut lädt. Chunks werden nicht gelöscht. Echte DOCX mit demselben Extraktionsfehler (z.B. beschädigter Download) laufen weiter über den normalen Retry.

## Deployment-Status (Stand dieser Notiz, 31.10.2026)

- Produktiv live unter `https://secondbrain-navy-pi.vercel.app` (erreichbar, Login-Redirect bestätigt).
- Alle 6 externen Accounts eingerichtet: Supabase, Google Cloud, Azure/Entra ID, Anthropic, Voyage AI, Vercel.
- **Seit der letzten Notiz wurden 5 weitere PRs gemerged (`#1`–`#5`, Commits `2f55e74`…`3ee9fcb`) — nicht von dieser Claude-Session, sondern von Andreas zusammen mit einem Cursor-Agent.** Reale, substanzielle Fixes, u.a.:
  - Ungültige Google-Drive-Page-Tokens wurden roh gespeichert und ließen den Sync jede Nacht fehlschlagen — behoben.
  - Embeddings, die ein Rate-Limit trafen, wurden fälschlich als "unverändert" verbucht statt erneut versucht — tausende Dateien wurden so nie indexiert. Jetzt mit Retry (`index-queue.ts`, `ingest-plan.ts`).
  - OneDrive-Dateien wurden gelistet, aber nicht heruntergeladen — behoben.
  - Markdown-Dateien mit generischem MIME-Typ von Drive wurden fälschlich verworfen — behoben.
  - Build-/Dependency-/Cache-Ordner (`node_modules`, `.git`, `.next`, `dist`, `build`, `out`, `.wrangler` u.ä.) werden jetzt beim Sync übersprungen (`sync-filters.ts`) — vorher wurden Tool-Output-Ordner mit eingelesen.
  - OneNote: Graph-Limit 20266 (globale Seiten-Collection) durch seitenweises Abfragen pro Section behoben (`onenote-pages.ts`); Sections, die dauerhaft mit Graph-Fehler 20258 antworten ("Sync of this section is not supported"), werden erkannt, im Cursor gemerkt und übersprungen statt den ganzen Lauf zum Scheitern zu bringen.
  - Duplikate (gleicher Content-Hash an mehreren Stellen) werden jetzt auf ein Dokument verlinkt statt doppelt eingebettet.
  - Word-Sperrdateien (`~$*`) und Office-Temp-Dateien (`~*.tmp`) werden nicht mehr indexiert.
  - Dedizierte Test-Dateien ergänzt (`*.test.ts` für sync-filters, onenote-pages, extract, ingest-plan, text-sanitize).
  - Neu: `src/lib/mcp-server.ts`/`mcp-http.ts` (MCP-Pfad-Key-URL-Fix für `mcp-remote`-Kompatibilität), `src/lib/sync-control.ts`, `src/lib/drive-cursor.ts`/`graph-cursor.ts`, `src/lib/index-queue.ts`, `src/lib/text-sanitize.ts`.
- **Nicht von dieser Session verifiziert:** ob der aktuelle Vercel-Produktions-Deploy wirklich auf dem neuesten Commit (`3ee9fcb`) steht (kein Vercel-API-Zugriff in diesem frischen Container) — sehr wahrscheinlich ja, da die Git-Integration automatisch deployt, aber ungeprüft. Ebenso unbekannt: aktueller Dokumenten-Count, ob der Ersteinlese-Lauf komplett durch ist, ob die frühere Mietvertrag-Suche inzwischen Treffer liefert — dafür fehlt dieser Session der Zugriff auf Andreas' eingeloggte Session/DB.

## Secrets

Nirgendwo im Repo, nur als Platzhalter in `.env.example` benannt und echt in **Vercel → Project Settings → Environment Variables** gepflegt:
`DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET`, `AUTH_MICROSOFT_ENTRA_ID_ID`/`_SECRET`/`_ISSUER`/`_TENANT`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, `CRON_SECRET`. Details und wo man sie herbekommt: `DEPLOYMENT.md`.

Das Supabase-DB-Passwort wurde einmal rotiert (siehe Verlauf, Punkt 4) — aktueller Wert ausschließlich in der Vercel-`DATABASE_URL` und in Supabase selbst, nirgendwo sonst.

## Automatischer Fortlauf beim Ersteinlesen (ergänzt nach dieser Notiz)

Ein großes Drive/OneDrive braucht mehrere Zeitscheiben (~45s je Aufruf), bis der Ersteinlese-Lauf komplett durch ist — bisher musste man dafür manuell mehrfach auf den Sync-Button klicken. Jetzt:

- `SyncSummary` (in `src/lib/connectors/types.ts`) hat ein `done`-Feld — `false` heißt "Zeitbudget erreicht, es gibt noch mehr zu tun".
- **`SyncButton.tsx`** ruft den Sync-Endpunkt jetzt automatisch wiederholt auf, bis `done: true` zurückkommt (Sicherheitsgrenze: max. 300 Runden), zeigt live den kumulierten Fortschritt und hat einen "Stoppen"-Button.
- **Der tägliche Cron-Job** (`src/app/api/cron/sync/route.ts`) macht dasselbe intern für jeden Nutzer, begrenzt auf ein Gesamt-Zeitbudget von ~250s pro Cron-Lauf (bleibt unter `maxDuration`), damit auch ohne Klicken über ein paar Nächte hinweg zuverlässig fertig eingelesen wird, ohne dass ein Nutzer mit einem riesigen Drive den ganzen Lauf blockiert (Deadline-Check vor jedem Nutzer).
- `/api/chat` hat zusätzlich `maxDuration = 60` bekommen und einen try/catch — vorher konnte eine langsame Antwort (Embedding + Suche + Claude-Generierung) das 10s-Standardlimit von Vercel reißen, was der Chat als kryptischen "Unexpected end of JSON input"-Fehler anzeigte statt einer echten Fehlermeldung. `ChatPanel.tsx` parst die Antwort jetzt genauso defensiv wie `SyncButton.tsx`.

## Ordner-/Dokumentenansicht (ergänzt nach dieser Notiz)

Der Chat beantwortet nur inhaltliche Fragen (semantische Suche über Text-Chunks) — für "welche Ordner/Dateien habe ich" gibt es keinen passenden Textinhalt zu finden, das ist strukturell, nicht inhaltlich. Ergänzt:

- `documents.folderPath` (Migration `0002_odd_leopardon.sql`) — pro Connector aufgelöst: Google Drive über die `parents`-Kette (gecacht je Sync-Lauf), OneDrive direkt aus `parentReference.path`, OneNote aus der Section, lokale Dateien aus dem Verzeichnisanteil von `localPath`.
- Neue Seite **`/documents`**: echte, nach Quelle/Ordner gruppierte Verzeichnisansicht.
- Neue API `/api/documents` + neues MCP-Tool `list_documents` + ergänzter ChatGPT-Action-Endpoint, damit auch externe KI-Tools strukturelle Fragen beantworten können.
- `ingestFile()` aktualisiert jetzt auch bei unverändertem Inhalt (gleicher `contentHash`) Titel/Ordnerpfad/Link, statt komplett zu überspringen — sonst hätten bereits synchronisierte Dateien nie einen Ordnerpfad bekommen.
- **Migration muss einmalig nachgetragen werden** (Datenbank existierte vor dieser Änderung): SQL in `DEPLOYMENT.md`, Abschnitt "Nachträgliches Schema-Update".
- Nach der Migration einmal neu synchronisieren, damit bestehende Dokumente einen `folderPath` bekommen (automatisch beim nächsten Sync-Klick oder Cron-Lauf, kein Neu-Einlesen des Inhalts nötig).

## Offene / nächste Schritte

1. **Aktuellen Live-Status prüfen:** Dokumenten-Count unter `/documents`, ob der Ersteinlese-Lauf fertig ist, ob die Mietvertrag-Suche jetzt Treffer liefert (siehe oben — seit den 5 PRs unverifiziert).
2. Obsidian auf Andreas' Rechner einrichten, verbunden mit `local-sync-cli` → Anleitung: `OBSIDIAN_SETUP.md` (noch nicht begonnen).
3. ChatGPT Custom GPT Action und/oder Claude.ai-/Langdock-MCP-Connector mit der echten Produktions-Domain einrichten → Anleitung: `CONNECTORS.md` (noch nicht begonnen).
4. Nicht angebunden, aber vorbereitet: SharePoint-Site-Bibliotheken (Scope `Sites.Read.All` wird bereits anfragt, Connector-Code fehlt noch) — siehe `ARCHITECTURE.md`, Abschnitt "Nicht enthalten".

## Pflegehinweis

Bei künftigen relevanten Entscheidungen oder dauerhaft wichtigen Änderungen an diesem Projekt: hier nachtragen (analog zum `SINDBAD_PROJECT_MEMORY.md`-Muster im Sindbad-Repo), statt nur im Chat-Verlauf stehen zu lassen.
