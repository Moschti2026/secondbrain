# Notizen mit Obsidian einrichten

Secondbrain hat keinen eigenen Notizen-Editor. Stattdessen schreibst du Notizen in [Obsidian](https://obsidian.md) — einer kostenlosen App für dein Gerät — und ein kleiner Sync-Client lädt sie automatisch in Secondbrain hoch, damit sie im Chat durchsuchbar sind.

Das dauert insgesamt ca. 10 Minuten und muss nur einmal eingerichtet werden.

## 1. Obsidian installieren

1. [obsidian.md](https://obsidian.md/download) öffnen, die Version für dein Betriebssystem (Windows/Mac/Linux/iOS/Android) herunterladen und installieren.
2. Obsidian öffnen → **"Create new vault"** (neuen Tresor erstellen).
3. Einen Namen vergeben (z.B. `Secondbrain`) und einen Speicherort auf deinem Rechner wählen — merk dir diesen Ordnerpfad, den brauchst du gleich noch einmal.
4. Fertig. Du kannst jetzt in Obsidian ganz normal Notizen anlegen (`Strg/Cmd+N`) und mit `[[Notiztitel]]` andere Notizen verlinken.

## 2. API-Key in Secondbrain erzeugen

1. In Secondbrain (der Web-App) anmelden → **Einstellungen**.
2. Unter "Lokaler Sync-Client" auf **"+ Neuen API-Key erzeugen"** klicken.
3. Den angezeigten Key (beginnt mit `sb_...`) kopieren — er wird nur dieses eine Mal angezeigt.

## 3. Sync-Client einrichten

Auf dem Rechner, auf dem der Obsidian-Vault liegt, ein Terminal öffnen:

```bash
git clone https://github.com/moschti2026/secondbrain.git
cd secondbrain/local-sync-cli
npm install
```

Dann starten und dabei auf den Vault-Ordner aus Schritt 1 zeigen:

```bash
SECONDBRAIN_URL="https://<deine-secondbrain-domain>" \
SECONDBRAIN_API_KEY="sb_dein-key-aus-schritt-2" \
SECONDBRAIN_WATCH_DIR="/pfad/zu/deinem/Obsidian/Vault" \
npm run dev
```

Das Fenster offen lassen (oder als Hintergrunddienst einrichten, siehe [local-sync-cli/README.md](./local-sync-cli/README.md)). Ab jetzt gilt:

- Jede Notiz, die schon im Vault liegt, wird beim ersten Start einmal hochgeladen.
- Jede neue oder geänderte Notiz wird automatisch mit hochgeladen, sobald du sie in Obsidian speicherst.
- Im Chat von Secondbrain sind deine Notizen ab dann mit durchsuchbar, genau wie deine Drive- und Microsoft-365-Dateien.

## Was sich dadurch nicht ändert

- Obsidian selbst läuft weiterhin komplett normal und lokal — Verlinkungen (`[[...]]`), Graph-Ansicht, Plugins, alles wie gewohnt. Secondbrain liest nur mit, es verändert deine Notizen nicht.
- Willst du mehrere Geräte mit demselben Vault nutzen (z.B. Laptop + Handy), brauchst du dafür weiterhin eine eigene Lösung wie [Obsidian Sync](https://obsidian.md/sync) (kostenpflichtig) oder einen Sync über iCloud/Git/Syncthing — das ist unabhängig von Secondbrain.

## Bekannte Grenzen

- Löschst du eine Notiz in Obsidian, wird sie **nicht** automatisch aus Secondbrain entfernt (siehe `local-sync-cli/README.md`, Abschnitt "Known limitations").
- Der Sync-Client muss laufen, damit Änderungen ankommen — läuft er nicht (z.B. Laptop ist aus), werden Änderungen erst beim nächsten Start nachgeholt.
