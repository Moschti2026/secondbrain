# secondbrain-sync

Watches a local folder and uploads new/changed files to your Secondbrain instance so they show up in chat search alongside your Drive and Microsoft 365 files.

## Setup

```bash
cd local-sync-cli
npm install
```

Get an API key from your Secondbrain instance's **Settings** page ("Lokalen Sync-Client verbinden"), then run:

```bash
SECONDBRAIN_URL="https://your-secondbrain-instance.example" \
SECONDBRAIN_API_KEY="sb_..." \
SECONDBRAIN_WATCH_DIR="/path/to/folder/you/want/synced" \
npm run dev
```

Leave it running in a terminal (or set it up as a background service / login item) and it will:
- upload every matching file already in the folder on startup,
- then keep watching and upload any file that's added or changed.

## Supported file types

`.pdf`, `.docx`, `.txt`, `.md`/`.markdown`, `.csv`, `.json`. Other file types are ignored.

## Known limitations (v1)

- Deleting a local file does **not** remove it from Secondbrain yet — remove it manually from the app if needed.
- One CLI instance watches one folder. Run multiple instances (with different `SECONDBRAIN_WATCH_DIR`) to sync several folders.
- No file-size limit is enforced client-side; the server caps ingestion at 20&nbsp;MB per file.

## Running it as a background process

For a persistent setup, build it once and run the compiled output with a process manager (`pm2`, a systemd unit, or a login item on macOS/Windows):

```bash
npm run build
node dist/index.js
```
