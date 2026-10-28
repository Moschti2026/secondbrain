# Secondbrain aus KI-Tools abfragen

Voraussetzung: Secondbrain ist deployt (siehe [DEPLOYMENT.md](./DEPLOYMENT.md)) und unter einer öffentlichen HTTPS-Adresse erreichbar, zum Beispiel `https://secondbrain-navy-pi.vercel.app`.

Lege unter **Einstellungen → API-Keys** für jedes Programm einen eigenen Key an und benenne ihn (Claude, Cursor, Grok, ChatGPT, Lokaler Sync). Widerrufene Keys verlieren sofort den Zugriff. Dieselbe MCP-Adresse gilt überall — der Key ist Teil der URL, ein zusätzliches Login ist nicht nötig:

```text
https://<deine-domain>/api/mcp/<dein-api-key>
```

Die Werkzeuge heißen immer `ask_secondbrain` (Antwort mit Quellen), `search_secondbrain` (Titel, Link und Textauszug zum Zitieren) und `list_documents` (Ordner und Dateien).

Die bereits eingerichtete Verbindung über mcp-remote bleibt gültig. Befehl, exakt so:

```text
npx -y mcp-remote "https://<deine-domain>/api/mcp/<dein-api-key>" --transport http-only
```

## Grok (mcp-remote)

Den Befehl oben als MCP-Server eintragen. Transport ist Streamable HTTP (`--transport http-only`). Kein OAuth, der Key bleibt in der URL.

## Claude Desktop

In der Claude-Konfiguration (`claude_desktop_config.json`) unter `mcpServers`:

```json
{
  "mcpServers": {
    "secondbrain": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://<deine-domain>/api/mcp/<dein-api-key>",
        "--transport",
        "http-only"
      ]
    }
  }
}
```

Claude neu starten. Die drei Werkzeuge sollten erscheinen.

## claude.ai

1. Eigenen API-Key erzeugen.
2. **Customize → Connectors** (Team/Enterprise: Organization Settings → Connectors) → **Add custom connector**.
3. Server-URL: `https://<deine-domain>/api/mcp/<dein-api-key>`.
4. Authentifizierung: **No sign-in** / ohne Anmeldung. Die URL ist der Schlüssel.
5. Im Chat den Connector einschalten.

Menüpfade bei Anthropic ändern sich gelegentlich. OAuth ist für diesen Weg nicht nötig. Falls ein Workspace nur OAuth-Connectoren erlaubt, ist das ein späterer Ausbauschritt und hier noch nicht enthalten.

## Cursor

1. Eigenen API-Key erzeugen.
2. **Settings → MCP → Add new MCP server**.
3. Typ **URL** bzw. **HTTP** (Streamable HTTP), nicht der alte SSE-Transport.
4. URL: `https://<deine-domain>/api/mcp/<dein-api-key>`. Kein zusätzlicher Header.

## Langdock

1. Eigenen API-Key erzeugen.
2. Neue Integration vom Typ **MCP**, Transport **Streamable HTTP**.
3. Server-URL: `https://<deine-domain>/api/mcp/<dein-api-key>`.
4. Authentifizierung **None** / keine. Der Key steckt in der URL.
5. Verbindung testen. Die drei Werkzeuge auswählen und speichern.

## ChatGPT

Zwei Wege:

- **Custom GPT Action** (funktioniert heute): [`openapi/secondbrain-chatgpt-action.yaml`](./openapi/secondbrain-chatgpt-action.yaml) öffnen, `servers.url` auf die eigene Domain setzen, unter **Explore GPTs → Create → Configure → Actions** einfügen. Authentication: API Key, Header `x-api-key` (oder Bearer — beides wird akzeptiert).
- **Offizieller MCP-Connector** in ChatGPT verlangt in der Regel OAuth und keine Secrets in der URL. Das ist bewusst noch nicht gebaut. Wenn ein Client die MCP-URL ohne Anmeldung annimmt, reicht dieselbe Adresse wie oben.

## Bekannte Grenzen

- Jeder Key liest alle indexierten Dokumente des Kontos.
- Gemini und NotebookLM können diese Schnittstelle derzeit nicht einbinden.
- Ein OAuth-Server nur für ChatGPT oder eingeschränkte Claude-Workspaces wäre ein möglicher Folgeschritt. Die URL mit Key bleibt dann weiterhin gültig.
