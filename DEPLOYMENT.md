# Secondbrain deployen

Das hier sind die Schritte, die nur du selbst machen kannst (eigene Accounts, eigenes Zahlungsmittel/Login) — ich kann sie nicht stellvertretend für dich klicken. Insgesamt ca. 30–45 Minuten, in dieser Reihenfolge (wichtig wegen der Redirect-URLs, siehe Schritt 6).

## 1. Supabase-Projekt (Datenbank)

1. [supabase.com](https://supabase.com) → registrieren/anmelden → **New project**.
2. Name, Region (am besten nah an deinem Vercel-Deployment, z.B. Frankfurt), Datenbank-Passwort vergeben → warten, bis das Projekt bereit ist (~2 Min).
3. **Project Settings → Database → Connection string → URI**. Für Vercel/serverless den **"Transaction" Pooler**-Connection-String nehmen (Port 6543). Das ist dein `DATABASE_URL`.
4. `pgvector` musst du nicht manuell aktivieren — das übernimmt die erste Migration (`CREATE EXTENSION IF NOT EXISTS vector`) automatisch.

## 2. Google-OAuth-Client

1. [console.cloud.google.com](https://console.cloud.google.com) → neues Projekt (oder bestehendes nutzen).
2. **APIs & Services → Library** → "Google Drive API" suchen → **Enable**.
3. **APIs & Services → OAuth consent screen** → einrichten (External reicht; solange die App im Testmodus ist, dich selbst als Testnutzer eintragen).
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Typ **Web application**.
5. Redirect-URI erstmal mit einem Platzhalter eintragen, z.B. `https://placeholder.vercel.app/api/auth/callback/google` — das korrigierst du in Schritt 6, sobald du deine echte Domain kennst.
6. Client-ID und Client-Secret notieren → `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.

## 3. Microsoft-Entra-ID-App-Registrierung

1. [portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID → App registrations → New registration**.
2. Name vergeben, "Accounts in any organizational directory and personal Microsoft accounts" auswählen.
3. Redirect URI (Web) erstmal mit Platzhalter: `https://placeholder.vercel.app/api/auth/callback/microsoft-entra-id`.
4. **Certificates & secrets → New client secret** → Wert sofort kopieren (wird nur einmal angezeigt) → `AUTH_MICROSOFT_ENTRA_ID_SECRET`.
5. **Overview** → Application (client) ID kopieren → `AUTH_MICROSOFT_ENTRA_ID_ID`.
6. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: `Files.Read.All`, `Sites.Read.All`, `User.Read`, `offline_access` hinzufügen. Falls dein Tenant das verlangt, admin consent erteilen (bei einem privaten/persönlichen Microsoft-Konto meist nicht nötig).

## 4. Anthropic-API-Key (Claude, für Chat-Antworten)

[console.anthropic.com](https://console.anthropic.com) → **API Keys → Create Key** → `ANTHROPIC_API_KEY`.

## 5. Voyage-AI-API-Key (Embeddings)

[dash.voyageai.com](https://dash.voyageai.com) → **API Keys → Create** → `VOYAGE_API_KEY`.

## 6. Auf Vercel deployen

1. [vercel.com](https://vercel.com) → anmelden (Login mit GitHub geht direkt) → **Add New → Project → Import Git Repository** → `moschti2026/secondbrain` auswählen.
2. Unter **Environment Variables** erstmal alle Werte aus `.env.example` eintragen — für `AUTH_GOOGLE_*` und `AUTH_MICROSOFT_ENTRA_ID_*` reichen vorerst die Platzhalter-Werte aus Schritt 2/3, den Rest (DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY) schon echt eintragen. `AUTH_SECRET` und `CRON_SECRET` selbst erzeugen:
   ```bash
   openssl rand -base64 32   # AUTH_SECRET
   openssl rand -hex 32      # CRON_SECRET
   ```
3. **Deploy** klicken. Der Build läuft auch mit den Platzhalter-OAuth-Werten erfolgreich durch (Login funktioniert danach noch nicht, das ist erwartet).
4. Nach dem ersten Deploy zeigt Vercel deine echte Domain an, z.B. `https://secondbrain-xyz.vercel.app` (oder eine eigene Domain, falls verbunden).
5. **Jetzt zurück zu Google (Schritt 2) und Microsoft (Schritt 3)**: die Platzhalter-Redirect-URIs durch die echten ersetzen:
   - `https://<deine-domain>/api/auth/callback/google`
   - `https://<deine-domain>/api/auth/callback/microsoft-entra-id`
6. In Vercel unter **Project Settings → Environment Variables** die `AUTH_GOOGLE_*`/`AUTH_MICROSOFT_ENTRA_ID_*`-Werte falls nötig aktualisieren, dann **Deployments → ⋯ → Redeploy**, damit die Umgebungsvariablen aktiv werden.

## 7. Datenbank-Migration ausführen

Einmalig, von einem Rechner mit Zugriff auf `DATABASE_URL` aus (lokal, oder ich mache es hier in dieser Session, wenn du mir den Connection-String gibst):

```bash
npm install
npx drizzle-kit migrate
```

## 8. Cron-Job für automatischen Re-Sync

`vercel.json` ist bereits auf alle 6 Stunden konfiguriert. Vercels Cron-Jobs unterstützen je nach Tarif (Hobby/Pro) unterschiedliche Mindestintervalle — prüf das kurz in deinem Vercel-Dashboard unter **Settings → Cron Jobs**, ob die 6h-Frequenz auf deinem Plan läuft. Falls nicht: alternativ ein kostenloser externer Cron-Dienst (z.B. cron-job.org), der `GET https://<deine-domain>/api/cron/sync` mit Header `Authorization: Bearer <dein CRON_SECRET>` aufruft.

## 9. Loslegen

1. Deployte URL öffnen → mit Google oder Microsoft anmelden.
2. **Einstellungen** → Drive/Microsoft 365 verbinden, ersten Sync anstoßen.
3. Notizen einrichten: [OBSIDIAN_SETUP.md](./OBSIDIAN_SETUP.md).
4. KI-Tools anbinden: [CONNECTORS.md](./CONNECTORS.md).
