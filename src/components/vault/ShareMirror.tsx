import { useEffect } from "react";
import { loadMyShares, setMyShares, useMyShares } from "@/app/shares";
import { useVault } from "@/app/vault/store";
import { coveredByAll } from "@/domain/share";
import { useCurrentUser } from "@/lib/auth/use-current-user";
import { publishShared } from "@/server/share.functions";

const DELAY_MS = 2500;

let lastPublished = "";

/**
 * Mantiene al día la copia de solo lectura de lo que el usuario comparte. Las
 * notas viven en su navegador; cada cambio en algo compartido se publica unos
 * segundos después. Solo publica la bóveda que pertenece a la sesión.
 */
export function ShareMirror() {
  const userId = useCurrentUser()?.id;
  const owner = useVault((state) => state.owner);
  const documents = useVault((state) => state.documents);
  const portfolios = useVault((state) => state.portfolios);
  const shares = useMyShares();

  useEffect(() => {
    if (userId) void loadMyShares();
  }, [userId]);

  useEffect(() => {
    if (!userId || owner !== userId || shares.length === 0) return;
    const covered = coveredByAll(shares, portfolios, documents);
    const payload = {
      documentIds: documents.map((document) => document.id),
      portfolios: portfolios.map(({ id, name, parentId }) => ({ id, name, parentId })),
      documents: documents
        .filter((document) => covered.documentIds.has(document.id))
        .map((document) => ({
          id: document.id,
          title: document.title,
          kind: document.kind,
          portfolioId: document.portfolioId,
          content: document.kind === "markdown" ? document.content : "",
          // La copia de respaldo no lleva los bytes: se sirven desde el almacén.
          file: document.file ? { name: document.file.name, mime: document.file.mime } : null,
          updatedBy: document.updatedBy,
          updatedAt: new Date(document.updatedAt).toISOString(),
        })),
    };
    const key = `${userId}:${JSON.stringify(shares.map((share) => [share.id, share.visibility]))}:${JSON.stringify(payload)}`;
    if (key === lastPublished) return;
    const timer = window.setTimeout(() => {
      lastPublished = key;
      void publishShared({ data: payload })
        .then((result) => setMyShares(result.shares))
        .catch(() => {
          lastPublished = "";
        });
    }, DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [userId, owner, documents, portfolios, shares]);

  return null;
}
