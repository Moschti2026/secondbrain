import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents } from "@/db/schema";

export interface DocumentSummary {
  id: string;
  title: string;
  folderPath: string | null;
  webUrl: string | null;
  indexedAt: Date | null;
  indexError: string | null;
}

/**
 * Lists every indexed document with its folder path — a structural listing,
 * as opposed to askSecondbrain/searchSecondbrain's semantic content search.
 * "What folders/files do I have" is a listing question, not a content
 * match, so it needs this rather than the RAG chat.
 */
export async function listDocuments(userId: string): Promise<DocumentSummary[]> {
  return db
    .select({
      id: documents.id,
      title: documents.title,
      folderPath: documents.folderPath,
      webUrl: documents.webUrl,
      indexedAt: documents.indexedAt,
      indexError: documents.indexError,
    })
    .from(documents)
    .where(eq(documents.userId, userId))
    .orderBy(asc(documents.folderPath), asc(documents.title));
}

export interface FolderTreeNode {
  name: string;
  path: string;
  children: Map<string, FolderTreeNode>;
  documents: DocumentSummary[];
}

function createNode(name: string, path: string): FolderTreeNode {
  return { name, path, children: new Map(), documents: [] };
}

/** Turns the flat folderPath strings ("Google Drive/Projekte/X") into a
 * nested tree for rendering as an actual folder view. */
export function buildFolderTree(docs: DocumentSummary[]): FolderTreeNode {
  const root = createNode("", "");

  for (const doc of docs) {
    const segments = (doc.folderPath ?? "Unbekannt").split("/").filter(Boolean);
    let node = root;
    let path = "";
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      let child = node.children.get(segment);
      if (!child) {
        child = createNode(segment, path);
        node.children.set(segment, child);
      }
      node = child;
    }
    node.documents.push(doc);
  }

  return root;
}
