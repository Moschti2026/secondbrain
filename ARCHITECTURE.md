# Architektur

## Überblick

```
                     ┌─────────────────────┐
                     │   Next.js App        │
                     │  (Vercel, App Router) │
                     └──────────┬───────────┘
                                │
        ┌───────────────┬─────────┬──────────────┴──────┐
        │               │         │                     │
   Auth.js          Chat/RAG API  MCP-Server        Ingest API
 (Google/MS OAuth)   /api/chat   /api/mcp/[key]     /api/ingest
        │               │         │                     │
        │               └────┬────┘                     │
        │                    │  ▲                        │
        │                    │  └── Claude.ai / Langdock  │
        │                    │      / ChatGPT (Action)    │
        └───────┬────────────┴──────────────────────────┘
                │
         ┌──────▼──────┐ ┌───────────┐        ┌─────────────────┐
         │  Postgres    │ │  Claude   │        │ Voyage AI        │
         │  + pgvector  │ │  (Chat)   │        │ (Embeddings)     │
         │  (Supabase)  │ └───────────┘        └─────────────────┘
         └──────┬───────┘
                │
   ┌────────────┼─────────────────┐
   │            │                 │
Google Drive  Microsoft Graph   local-sync-cli
(Changes API) (Delta query)     (auf dem eigenen Rechner, z.B.
                                  auf den Obsidian-Vault gerichtet)
```

## Datenmodell (`src/db/schema.ts`)

Alles, was durchsuchbar sein soll — eine Drive-Datei, eine OneDrive-Datei oder eine lokal synchronisierte Datei (Notizen aus Obsidian eingeschlossen: das sind einfach Markdown-Dateien im synchronisierten Ordner) — wird als **`documents`**-Zeile abgebildet. Das hält die RAG-Suche über alle Quellen hinweg einheitlich: `chunks` referenziert immer ein `document`, egal woher es kommt. Es gibt bewusst keine separate Notizen-Tabelle — siehe [OBSIDIAN_SETUP.md](./OBSIDIAN_SETUP.md).

- `users` / `accounts` / `sessions` / `verificationTokens` — Auth.js-Standardschema (`@auth/drizzle-adapter`). `accounts` speichert die OAuth-Access-/Refresh-Tokens für Google und Microsoft — dieselben Tokens, mit denen sich der Nutzer anmeldet, werden für die Hintergrund-Syncs wiederverwendet (kein zweiter OAuth-Flow nötig).
- `documents` — ein Dokument jeder Art (`kind`: `google_drive` | `microsoft365` | `local`), mit `contentHash` zur Erkennung unveränderter Dateien und `folderPath` (z.B. `"Google Drive/Projekte/Verträge"`) für die Dokumenten-/Ordneransicht (siehe unten) — getrennt von der semantischen RAG-Suche, die keine Struktur, nur Textinhalt kennt.
- `chunks` — Text-Chunks mit Embedding (`vector(1024)`, HNSW-Index für Cosine-Similarity), Grundlage für die RAG-Suche.
- `sync_state` — Cursor pro Nutzer/Provider (Drive `startPageToken`, Graph `deltaLink`), damit ein erneuter Sync nur tatsächliche Änderungen abholt.
- `sync_keys` — gehashte API-Keys für den lokalen Sync-Client.

## Ingestion-Pipeline (`src/lib/ingest.ts`)

1. **Extrahieren** (`src/lib/extract.ts`): PDF (`unpdf` — keine nativen Dependencies, wichtig für Vercel/Serverless), DOCX (`mammoth`), Text/Markdown/CSV/JSON direkt, HTML (OneNote-Seiten) über einen minimalen HTML→Text-Konverter. Unbekannte Typen werden übersprungen (Dokument-Zeile bleibt, aber ohne Chunks).
2. **Chunking** (`src/lib/chunking.ts`): Absatzweise mit ~1800 Zeichen pro Chunk und Überlappung, damit Kontext an Chunk-Grenzen nicht verloren geht.
3. **Embedding** (`src/lib/embeddings.ts`): Voyage AI (`voyage-3`), batchweise (max. 64 Texte pro Request).
4. **Speichern**: alte Chunks des Dokuments löschen, neue einfügen, `documents.indexedAt` setzen.

Ein `contentHash` (SHA-256) verhindert unnötiges Re-Embedding unveränderter Dateien — ein erneuter Sync ist für unveränderte Inhalte nahezu kostenlos.

## Connectoren

- **Google Drive** (`src/lib/connectors/google-drive.ts`): nutzt die [Changes API](https://developers.google.com/drive/api/guides/manage-changes) — nach dem ersten vollständigen Sync werden nur noch tatsächliche Änderungen abgeholt. Google-native Formate (Docs/Sheets/Slides) werden über den Export-Endpunkt als Text/CSV geholt, da sie keine Rohbytes haben.
- **Microsoft 365 / OneDrive** (`src/lib/connectors/microsoft365.ts`): nutzt die [Graph Delta Query](https://learn.microsoft.com/en-us/graph/delta-query-overview) auf `me/drive`. SharePoint-Site-Bibliotheken sind vorbereitet (Scope `Sites.Read.All` wird bereits angefragt), aber noch nicht angebunden — siehe unten.
- **OneNote** (`src/lib/connectors/onenote.ts`): eigene Graph-API (`me/onenote/pages`), getrennt von OneDrive, eigener Scope `Notes.Read`. Kein Delta-Endpoint verfügbar, daher voller Re-Scan bei jedem Sync — der `contentHash`-Vergleich in `ingestFile` macht das für unveränderte Seiten trotzdem billig (kein erneutes Embedding). Seiteninhalt kommt als HTML (`me/onenote/pages/{id}/content`) und wird über einen minimalen HTML→Text-Konverter in `src/lib/extract.ts` extrahiert. Gelöschte OneNote-Seiten werden nicht automatisch aus Secondbrain entfernt (gleiche Einschränkung wie beim lokalen Sync-Client).
- Alle Connectoren laufen serverseitig ohne aktive Browser-Session (`src/lib/oauth.ts` erneuert abgelaufene Access-Tokens selbstständig über den gespeicherten Refresh-Token), damit der Cron-Job (`src/app/api/cron/sync/route.ts`, täglich über `vercel.json` — Vercel-Hobby-Plan-Limit) unabhängig von eingeloggten Nutzern läuft. Alle drei sind zudem zeitlich begrenzt (45s je Aufruf, Resume-Cursor in `sync_state`) und brechen einen großen Ersteinlese-Lauf kontrolliert ab, statt am Plattform-Timeout zu scheitern.
- Jeder Connector löst zusätzlich einen menschenlesbaren **Ordnerpfad** auf und speichert ihn in `documents.folderPath`: Google Drive über einen (gecachten) Walk der `parents`-Kette, OneDrive direkt aus `parentReference.path`, OneNote aus der übergeordneten Section, lokale Dateien aus dem Verzeichnisanteil von `localPath`. Das ist getrennt von der RAG-Suche unten — eine Frage wie "welche Ordner gibt es" ist eine strukturelle Auflistung, kein Inhalts-Treffer, den die Vektorsuche finden könnte.

## Lokale Dateien (`local-sync-cli/`)

Eine Cloud-App kann nicht direkt auf den Rechner des Nutzers zugreifen. Der lokale Sync-Client ist ein kleines Node-Skript, das mit `chokidar` einen Ordner beobachtet und jede neue/geänderte Datei per `multipart/form-data` an `/api/ingest` schickt (Auth über einen in den Einstellungen erzeugten API-Key statt einer Browser-Session). Der `localPath` identifiziert die Datei eindeutig, damit wiederholte Uploads derselben Datei dasselbe `document` aktualisieren statt Duplikate zu erzeugen.

## Chat/RAG (`src/app/api/chat/route.ts`)

1. Nutzerfrage wird mit Voyage AI eingebettet (`input_type: "query"`, eigens dafür optimiert).
2. Cosine-Similarity-Suche über `chunks` des angemeldeten Nutzers (pgvector `<=>`-Operator über Drizzles `cosineDistance`), Top 8, gefiltert auf Similarity ≥ 0.3.
3. Gefundene Chunks werden nummeriert an Claude gegeben; das System-Prompt verlangt Zitate `[1]`, `[2]`, … und verbietet Antworten außerhalb der Quellen.
4. Antwort + Quellenliste (Titel, Link) gehen an die UI.

Die eigentliche Such-/Antwortlogik steckt in `src/lib/ask.ts` (`askSecondbrain` für die volle RAG-Antwort, `searchSecondbrain` für rohe Fundstellen ohne LLM-Synthese) — sowohl die Chat-UI als auch die externen Anbindungen unten rufen dieselben Funktionen auf, damit alle drei dieselbe Antwort geben.

## Dokumenten-/Ordneransicht (`/documents`, `src/lib/documents.ts`)

Ergänzt den Chat um eine strukturelle Sicht: `listDocuments()` liefert alle Dokumente mit `folderPath`, `buildFolderTree()` baut daraus einen verschachtelten Baum, den die Seite `/documents` als echte Ordneransicht rendert (📁/📄, nach Quelle gruppiert: "Google Drive/…", "OneDrive/…", "OneNote/…", "Lokal/…"). Das API-Äquivalent `/api/documents` (gleiche Auth wie `/api/chat`) macht dieselbe Liste auch für externe Tools verfügbar — siehe unten.

## Externe Anbindungen (Claude.ai, Langdock, ChatGPT)

Setup-Anleitung: [CONNECTORS.md](./CONNECTORS.md).

- **Remote-MCP-Server** (`src/app/api/mcp/[key]/route.ts`): Streamable-HTTP-MCP-Server (`@modelcontextprotocol/sdk`, `WebStandardStreamableHTTPServerTransport`, zustandslos — pro Request wird ein frischer Server erzeugt). Stellt drei Tools bereit: `ask_secondbrain` und `search_secondbrain` (inhaltliche Fragen) sowie `list_documents` (strukturelle Fragen: welche Ordner/Dateien gibt es). Die Authentifizierung steckt bewusst im URL-Pfad (`/api/mcp/<api-key>`) statt in einem Header, damit die Anbindung unabhängig von Claude.ai's (teils Beta-gated) Header-Auth oder einem OAuth-Setup funktioniert. Claude.ai und Langdock unterstützen beide MCP über Streamable HTTP und verbinden sich direkt mit dieser URL.
- **ChatGPT Custom GPT Action** (`openapi/secondbrain-chatgpt-action.yaml`): OpenAPI-Spezifikation für `/api/chat` (Inhalt) und `/api/documents` (Struktur), Auth über den gleichen API-Key als `x-api-key`-Header oder `Authorization: Bearer`.
- **Gemini / NotebookLM**: bieten aktuell keine Möglichkeit, eine eigene externe Datenquelle/Aktion einzubinden — keine Anbindung vorgesehen.

## Sicherheit / Mandantentrennung

Jede Abfrage ist über `userId` gescoped (Chunks, Dokumente, Sync-State, API-Keys). Es gibt aktuell keine Multi-Tenant-Freigabe zwischen Nutzern — jeder Account sieht ausschließlich seine eigenen Daten.

## Nicht enthalten / nächste Schritte

- **SharePoint-Bibliotheken**: Der OAuth-Scope ist vorhanden, der Connector müsste um `sites.list` + Delta-Query pro Site erweitert werden.
- **Löschung bei lokalen Dateien**: Der lokale Sync-Client erkennt aktuell nur neue/geänderte Dateien, keine Löschungen (`chokidar`'s `unlink`-Event ist nicht verdrahtet).
- **Volltextsuche als Fallback**: Aktuell rein vektorbasiert; eine Kombination mit Postgres-Volltextsuche (`tsvector`) würde exakte Begriffe (Namen, IDs) zuverlässiger treffen.
- **Übergreifende Duplikaterkennung**: Dieselbe Datei in mehreren Quellen (z.B. Drive und lokal synchronisiert) erzeugt aktuell zwei `documents`-Zeilen.
