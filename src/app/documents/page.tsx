import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { listDocuments, buildFolderTree, type FolderTreeNode } from "@/lib/documents";

function FolderNode({ node, depth }: { node: FolderTreeNode; depth: number }) {
  const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
  const docs = [...node.documents].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <li>
      <div className="flex items-center gap-2 py-1">
        <span>📁</span>
        <span className="font-medium">{node.name}</span>
      </div>
      <ul className="ml-5 border-l border-neutral-200 pl-4 dark:border-neutral-800">
        {children.map((child) => (
          <FolderNode key={child.path} node={child} depth={depth + 1} />
        ))}
        {docs.map((doc) => (
          <li key={doc.id} className="flex items-center gap-2 py-1 text-sm">
            <span>📄</span>
            {doc.webUrl ? (
              <a href={doc.webUrl} target="_blank" rel="noreferrer" className="hover:underline">
                {doc.title}
              </a>
            ) : (
              <span>{doc.title}</span>
            )}
            {doc.indexError && (
              <span className="text-xs text-amber-600 dark:text-amber-500">({doc.indexError})</span>
            )}
          </li>
        ))}
      </ul>
    </li>
  );
}

export default async function DocumentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const docs = await listDocuments(session.user.id);
  const tree = buildFolderTree(docs);
  const topLevel = [...tree.children.values()].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Dokumente</h1>
        <p className="text-neutral-500">
          {docs.length} indexierte Dateien, nach Quelle und Ordner gruppiert — eine echte
          Verzeichnisansicht, unabhängig vom Chat.
        </p>
      </div>

      {docs.length === 0 ? (
        <p className="text-neutral-500">
          Noch keine Dokumente indexiert. Stoße unter{" "}
          <a href="/settings" className="hover:underline">
            Einstellungen
          </a>{" "}
          einen Sync an.
        </p>
      ) : (
        <ul>
          {topLevel.map((node) => (
            <FolderNode key={node.path} node={node} depth={0} />
          ))}
        </ul>
      )}
    </div>
  );
}
