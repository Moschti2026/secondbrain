import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. See .env.example.");
  }
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export interface RetrievedChunk {
  documentTitle: string;
  documentWebUrl: string | null;
  content: string;
}

const SYSTEM_PROMPT = `Du bist der persönliche Secondbrain-Assistent des Nutzers. Du beantwortest Fragen ausschließlich anhand der bereitgestellten Ausschnitte aus seinen eigenen Dokumenten und Notizen (Google Drive, Microsoft 365/SharePoint, lokale Dateien, Notizen).

Regeln:
- Nutze nur Informationen aus den bereitgestellten Quellen. Wenn die Antwort dort nicht enthalten ist, sage das ehrlich.
- Verweise bei jeder inhaltlichen Aussage auf die Quelle in eckigen Klammern, z.B. [1], [2], passend zur nummerierten Quellenliste.
- Antworte auf Deutsch, präzise und ohne Floskeln.`;

export async function answerWithCitations(
  question: string,
  chunks: RetrievedChunk[]
): Promise<string> {
  const context = chunks
    .map(
      (c, i) =>
        `[${i + 1}] ${c.documentTitle}${c.documentWebUrl ? ` (${c.documentWebUrl})` : ""}\n${c.content}`
    )
    .join("\n\n---\n\n");

  const message = await getClient().messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Quellen:\n\n${context || "(keine passenden Quellen gefunden)"}\n\n---\n\nFrage: ${question}`,
      },
    ],
  });

  const textBlock = message.content.find((block) => block.type === "text");
  return textBlock && textBlock.type === "text" ? textBlock.text : "";
}
