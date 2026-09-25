import chokidar from "chokidar";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
};

function readConfig() {
  const url = process.env.SECONDBRAIN_URL;
  const key = process.env.SECONDBRAIN_API_KEY;
  const dir = process.env.SECONDBRAIN_WATCH_DIR ?? process.cwd();

  if (!url || !key) {
    console.error(
      "Missing config. Set SECONDBRAIN_URL and SECONDBRAIN_API_KEY (get a key from the Settings page), " +
        "and optionally SECONDBRAIN_WATCH_DIR (defaults to the current directory)."
    );
    process.exit(1);
  }

  return { url: url.replace(/\/$/, ""), key, dir: path.resolve(dir) };
}

async function uploadFile(config: ReturnType<typeof readConfig>, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext];
  if (!mimeType) return; // not a type the server knows how to index

  const relativePath = path.relative(config.dir, filePath).split(path.sep).join("/");
  const buffer = await readFile(filePath);

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), path.basename(filePath));
  form.append("localPath", relativePath);
  form.append("title", path.basename(filePath));

  const res = await fetch(`${config.url}/api/ingest`, {
    method: "POST",
    headers: { "x-api-key": config.key },
    body: form,
  });

  if (!res.ok) {
    console.error(`[error] ${relativePath}: ${res.status} ${await res.text()}`);
    return;
  }

  const body = (await res.json()) as { skipped: boolean; chunkCount: number };
  console.log(
    body.skipped
      ? `[unchanged] ${relativePath}`
      : `[synced] ${relativePath} (${body.chunkCount} chunks)`
  );
}

function main() {
  const config = readConfig();
  console.log(`Secondbrain sync watching ${config.dir} -> ${config.url}`);

  const watcher = chokidar.watch(config.dir, {
    ignored: (filePath) => {
      const base = path.basename(filePath);
      return (
        base === "node_modules" ||
        base === ".git" ||
        base.startsWith(".") ||
        base === "Thumbs.db"
      );
    },
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on("add", (filePath) => uploadFile(config, filePath).catch(console.error));
  watcher.on("change", (filePath) => uploadFile(config, filePath).catch(console.error));
}

main();
