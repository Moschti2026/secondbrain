# Architektur

## Überblick

```
                     ┌─────────────────────┐
                     │   Next.js App        │
                     │  (Vercel, App Router) │
                     └──────────┬───────────┘
                                │
        ┌───────────────┬──────────────┴──────┐
        │               │                     │
   Auth.js          Chat/RAG API          Ingest API
 (Google/MS OAuth)   /api/chat           /api/ingest
        │               │                     │
        └───────┬───────┴─────────────────────┘
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
- `documents` — ein Dokument jeder Art (`kind`: `google_drive` | `microsoft365` | `local`), mit `contentHash` zur Erkennung unveränderter Dateien.
- `chunks` — Text-Chunks mit Embedding (`vector(1024)`, HNSW-Index für Cosine-Similarity), Grundlage für die RAG-Suche.
- `sync_state` — Cursor pro Nutzer/Provider (Drive `startPageToken`, Graph `deltaLink`), damit ein erneuter Sync nur tatsächliche Änderungen abholt.
- `sync_keys` — gehashte API-Keys für den lokalen Sync-Client.

## Ingestion-Pipeline (`src/lib/ingest.ts`)

1. **Extrahieren** (`src/lib/extract.ts`): PDF (`pdf-parse`), DOCX (`mammoth`), Text/Markdown/CSV/JSON direkt. Unbekannte Typen werden übersprungen (Dokument-Zeile bleibt, aber ohne Chunks).
2. **Chunking** (`src/lib/chunking.ts`): Absatzweise mit ~1800 Zeichen pro Chunk und Überlappung, damit Kontext an Chunk-Grenzen nicht verloren geht.
3. **Embedding** (`src/lib/embeddings.ts`): Voyage AI (`voyage-3`), batchweise (max. 64 Texte pro Request).
4. **Speichern**: alte Chunks des Dokuments löschen, neue einfügen, `documents.indexedAt` setzen.

Ein `contentHash` (SHA-256) verhindert unnötiges Re-Embedding unveränderter Dateien — ein erneuter Sync ist für unveränderte Inhalte nahezu kostenlos.

## Connectoren

- **Google Drive** (`src/lib/connectors/google-drive.ts`): nutzt die [Changes API](https://developers.google.com/drive/api/guides/manage-changes) — nach dem ersten vollständigen Sync werden nur noch tatsächliche Änderungen abgeholt. Google-native Formate (Docs/Sheets/Slides) werden über den Export-Endpunkt als Text/CSV geholt, da sie keine Rohbytes haben.
- **Microsoft 365 / OneDrive** (`src/lib/connectors/microsoft365.ts`): nutzt die [Graph Delta Query](https://learn.microsoft.com/en-us/graph/delta-query-overview) auf `me/drive`. SharePoint-Site-Bibliotheken sind vorbereitet (Scope `Sites.Read.All` wird bereits angefragt), aber noch nicht angebunden — siehe unten.
- Beide Connectoren laufen serverseitig ohne aktive Browser-Session (`src/lib/oauth.ts` erneuert abgelaufene Access-Tokens selbstständig über den gespeicherten Refresh-Token), damit der Cron-Job (`src/app/api/cron/sync/route.ts`, alle 6h über `vercel.json`) unabhängig von eingeloggten Nutzern läuft.

## Lokale Dateien (`local-sync-cli/`)

Eine Cloud-App kann nicht direkt auf den Rechner des Nutzers zugreifen. Der lokale Sync-Client ist ein kleines Node-Skript, das mit `chokidar` einen Ordner beobachtet und jede neue/geänderte Datei per `multipart/form-data` an `/api/ingest` schickt (Auth über einen in den Einstellungen erzeugten API-Key statt einer Browser-Session). Der `localPath` identifiziert die Datei eindeutig, damit wiederholte Uploads derselben Datei dasselbe `document` aktualisieren statt Duplikate zu erzeugen.

## Chat/RAG (`src/app/api/chat/route.ts`)

1. Nutzerfrage wird mit Voyage AI eingebettet (`input_type: "query"`, eigens dafür optimiert).
2. Cosine-Similarity-Suche über `chunks` des angemeldeten Nutzers (pgvector `<=>`-Operator über Drizzles `cosineDistance`), Top 8, gefiltert auf Similarity ≥ 0.3.
3. Gefundene Chunks werden nummeriert an Claude gegeben; das System-Prompt verlangt Zitate `[1]`, `[2]`, … und verbietet Antworten außerhalb der Quellen.
4. Antwort + Quellenliste (Titel, Link) gehen an die UI.

## Sicherheit / Mandantentrennung

Jede Abfrage ist über `userId` gescoped (Chunks, Dokumente, Sync-State, API-Keys). Es gibt aktuell keine Multi-Tenant-Freigabe zwischen Nutzern — jeder Account sieht ausschließlich seine eigenen Daten.

## Nicht enthalten / nächste Schritte

- **SharePoint-Bibliotheken**: Der OAuth-Scope ist vorhanden, der Connector müsste um `sites.list` + Delta-Query pro Site erweitert werden.
- **Löschung bei lokalen Dateien**: Der lokale Sync-Client erkennt aktuell nur neue/geänderte Dateien, keine Löschungen (`chokidar`'s `unlink`-Event ist nicht verdrahtet).
- **Volltextsuche als Fallback**: Aktuell rein vektorbasiert; eine Kombination mit Postgres-Volltextsuche (`tsvector`) würde exakte Begriffe (Namen, IDs) zuverlässiger treffen.
- **Übergreifende Duplikaterkennung**: Dieselbe Datei in mehreren Quellen (z.B. Drive und lokal synchronisiert) erzeugt aktuell zwei `documents`-Zeilen.
