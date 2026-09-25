# Secondbrain

Ein persönlicher Cloud-Assistent, der Google Drive, Microsoft 365/SharePoint, lokale Dateien und eigene Notizen durchsuchbar macht: Chat mit Quellenangaben (RAG) plus ein Notizsystem mit `[[Wiki-Links]]`.

Details zur Architektur: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Features

- **Chat/RAG** – Frage stellen, Antwort mit Zitaten aus deinen eigenen Dokumenten (`/chat`)
- **Google Drive** – inkrementeller Sync über die Changes API
- **Microsoft 365 / OneDrive** – inkrementeller Sync über die Graph Delta-API
- **Lokale Dateien** – kleines CLI-Tool (`local-sync-cli/`) synchronisiert einen Ordner auf deinem Rechner
- **Notizen** – Markdown-Notizen mit `[[Verlinkung]]` und Backlinks (`/notes`)
- Unterstützte Dateitypen: PDF, DOCX, TXT, Markdown, CSV, JSON (Google Docs/Sheets/Slides werden automatisch exportiert)

## Stack

- Next.js 16 (App Router, TypeScript, Tailwind)
- Postgres + [pgvector](https://github.com/pgvector/pgvector) via Drizzle ORM (empfohlen: [Supabase](https://supabase.com), da Postgres+pgvector+Storage+Auth aus einer Hand)
- [Auth.js](https://authjs.dev) mit Google- und Microsoft-Entra-ID-Providern (gleichzeitig Login und OAuth-Zugriff auf Drive/Graph)
- [Claude](https://www.anthropic.com/claude) (Anthropic API) für Chat-Antworten, [Voyage AI](https://www.voyageai.com/) für Embeddings

## Setup

### 1. Datenbank

Ein Supabase-Projekt anlegen (oder eine eigene Postgres-Instanz mit `pgvector`). Verbindungsstring in `DATABASE_URL` eintragen.

### 2. Umgebungsvariablen

```bash
cp .env.example .env.local
```

Alle Werte in `.env.local` eintragen (Anleitung zu jedem Wert steht als Kommentar in `.env.example`):

- Google-OAuth-Client (Google Cloud Console, Drive API aktivieren)
- Microsoft-Entra-ID-App-Registrierung (Azure Portal)
- Anthropic-API-Key
- Voyage-AI-API-Key

### 3. Abhängigkeiten & Migration

```bash
npm install
npx drizzle-kit migrate
```

### 4. Entwicklung

```bash
npm run dev
```

### 5. Lokale Dateien synchronisieren (optional)

Siehe [local-sync-cli/README.md](./local-sync-cli/README.md). Den API-Key dafür erzeugst du in der App unter **Einstellungen**.

### 6. Deployment

Für Vercel: Repo importieren, Umgebungsvariablen setzen, `CRON_SECRET` setzen (für den in `vercel.json` konfigurierten periodischen Sync alle 6 Stunden).

## Bekannte Grenzen (v1)

- SharePoint-Bibliotheken (nur OneDrive) und das Löschen lokal entfernter Dateien sind noch nicht angebunden – siehe ARCHITECTURE.md, Abschnitt "Nicht enthalten / nächste Schritte".
- Kein automatisches Zusammenführen von Duplikaten über Quellen hinweg (z.B. dieselbe Datei in Drive und lokal).
- Keine Volltextsuche als Fallback, wenn die Vektorsuche nichts Relevantes findet – die Antwort sagt dann ehrlich, dass nichts gefunden wurde.
