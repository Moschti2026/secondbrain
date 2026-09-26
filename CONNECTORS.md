# Secondbrain in ChatGPT, Claude.ai und Langdock nutzen

Voraussetzung für alles hier: Secondbrain muss deployt sein (siehe [DEPLOYMENT.md](./DEPLOYMENT.md)) und unter einer öffentlichen HTTPS-Domain erreichbar sein.

Alle drei Wege nutzen denselben API-Key, den du in Secondbrain unter **Einstellungen → Lokaler Sync-Client → "+ Neuen API-Key erzeugen"** erzeugst (derselbe Key-Typ, der auch der lokale Sync-Client nutzt). Erzeuge dir für jede Anbindung ruhig einen eigenen Key mit sprechendem Namen (z.B. "Claude", "ChatGPT"), damit du sie später einzeln widerrufen kannst.

Zwei Wege, wie ein externes Tool Secondbrain befragen kann:
- **MCP-Connector** (Claude.ai, Langdock): das Tool "entdeckt" automatisch zwei Werkzeuge — `ask_secondbrain` (Frage → Antwort mit Zitaten) und `search_secondbrain` (rohe Fundstellen zum selbst Weiterverarbeiten).
- **ChatGPT Custom GPT Action**: eine einzelne Aktion, die `/api/chat` aufruft.

## Claude.ai

1. In Secondbrain einen API-Key erzeugen (s.o.), Wert kopieren.
2. In claude.ai: **Customize → Connectors** (Team/Enterprise: **Organization Settings → Connectors**) → **Add custom connector**.
3. Als Server-URL eintragen: `https://<deine-domain>/api/mcp/<dein-api-key>` (der Key steckt direkt in der URL — sicher aufbewahren wie ein Passwort).
4. Bei der Authentifizierungs-Auswahl **"No sign-in"** wählen (die URL selbst ist bereits der Schlüssel, es ist kein OAuth nötig).
5. Speichern. Im Chat über den **+**-Button unter "Connectors" einschalten.

*(Menüpfade können sich bei Anthropic gelegentlich ändern — falls etwas nicht passt, unter Settings nach "Connectors" suchen.)*

## Langdock

1. API-Key wie oben erzeugen.
2. In Langdock eine neue Integration vom Typ **MCP** anlegen, Transport **Streamable HTTP**.
3. Server-URL: `https://<deine-domain>/api/mcp/<dein-api-key>`.
4. Bei der Authentifizierungsmethode, falls eine Pflichtangabe verlangt wird, **"None"/keine zusätzliche Authentifizierung** wählen — der Key ist bereits Teil der URL. (Langdock bietet zusätzlich reine Header-Authentifizierung an; das ist hier nicht nötig.)
5. **Test connection** klicken — Langdock sollte die zwei Werkzeuge `ask_secondbrain` und `search_secondbrain` automatisch finden. Beide auswählen und speichern.

## ChatGPT (Custom GPT Action)

1. API-Key wie oben erzeugen.
2. Die Datei [`openapi/secondbrain-chatgpt-action.yaml`](./openapi/secondbrain-chatgpt-action.yaml) öffnen und `servers.url` auf deine echte Domain ändern (z.B. `https://secondbrain.example.com`).
3. In ChatGPT: **Explore GPTs → Create → Configure → Actions → Create new action**.
4. Die geänderte YAML-Datei einfügen ("Import from URL" geht nicht, da die Domain vorher angepasst werden muss — Inhalt stattdessen direkt einfügen).
5. Unter **Authentication**: **API Key** wählen, als Auth-Typ **Custom** mit Header-Name `x-api-key` (falls "Custom" nicht angeboten wird, **Bearer** wählen — Secondbrain akzeptiert beides). Als Wert deinen API-Key eintragen.
6. Speichern, mit einer Testfrage ausprobieren.

## Bekannte Grenzen

- Gemini (Google) und NotebookLM bieten aktuell keine Möglichkeit, eine eigene externe Datenquelle/Aktion wie oben einzubinden — dort bliebe nur manueller Export/Import von Inhalten.
- Jeder erzeugte API-Key hat vollen Lesezugriff auf alle deine indexierten Daten. Widerrufe Keys, die du nicht mehr nutzt, unter Einstellungen.
