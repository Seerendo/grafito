import { useEffect } from "react";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { heldAdminId } from "@/app/vault-hold";
import { useVault } from "@/app/vault/store";
import { useTableIndex } from "@/app/table-index";
import { syncDocuments } from "@/server/admin.functions";

let lastMirrored = "";

export function VaultMirror() {
  const user = useCurrentUser();
  const documents = useVault((state) => state.documents);
  const owner = useVault((state) => state.owner);
  const tableText = useTableIndex((state) => state.text);
  const userId = user?.id;

  useEffect(() => {
    // Solo se replica la bóveda que pertenece a la sesión actual.
    if (!userId || owner !== userId) return;
    const held = heldAdminId();
    if (held && held !== userId) return;
    const docs = documents.slice(0, 300).map((document) => ({
      id: document.id,
      title: document.title.slice(0, 200),
      kind: document.kind,
      portfolioId: document.portfolioId,
      body: `${document.kind === "markdown" ? document.content : (document.file?.name ?? "")}\n${tableText[document.id] ?? ""}`.slice(0, 4000),
      links: document.links.slice(0, 80),
    }));
    const payload = `${userId}:${JSON.stringify(docs)}`;
    if (payload === lastMirrored) return;
    const timer = window.setTimeout(() => {
      lastMirrored = payload;
      void syncDocuments({ data: { docs } }).catch(() => undefined);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [userId, owner, documents, tableText]);

  return null;
}
