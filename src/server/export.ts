import type { Sql } from "@/lib/db";
import { getBlob } from "./blobs";
import { decodeDataUrl } from "./files";
import { safeName, uniqueName, ZIP_LIMIT, ZIP_MAX_ENTRIES, type ZipEntry } from "./zip";
import { VaultError } from "./vault";

/**
 * Un portafolio entero (con sus subportafolios) o toda la bóveda (`ALL`) como
 * entradas de un .zip (solo servidor): cada portafolio es una carpeta, cada
 * nota un `.md` y cada archivo va tal cual. Ver `zip.ts`.
 */

export const ALL = "all";

type Row = {
  id: string;
  title: string;
  kind: "markdown" | "file";
  portfolio_id: string | null;
  content: string;
  file_name: string | null;
  file_data: string | null;
  file_key: string | null;
  file_size: unknown;
  updated_at: unknown;
};

export type ExportPlan = { name: string; entries: ZipEntry[] };

export async function planExport(
  sql: Sql,
  userId: string,
  portfolioId: string,
  allow: { notes: boolean; files: boolean },
): Promise<ExportPlan> {
  const portfolios = await sql<{ id: string; name: string; parent_id: string | null }>`
    select id, name, parent_id from vault_portfolio where user_id = ${userId} and not deleted
  `;
  const byId = new Map(portfolios.map((row) => [row.id, row]));
  const whole = portfolioId === ALL;
  const root = whole ? null : byId.get(portfolioId);
  if (!whole && !root) throw new VaultError("Ese portafolio no existe.", 404);

  // Carpeta de cada portafolio dentro del zip (relativa a la raíz exportada).
  const folders = new Map<string | null, string>([[whole ? null : portfolioId, ""]]);
  const names = new Map<string, Set<string>>();
  const taken = (folder: string) => {
    let set = names.get(folder);
    if (!set) names.set(folder, (set = new Set()));
    return set;
  };
  const folderOf = (id: string | null, seen = new Set<string>()): string | null => {
    if (folders.has(id)) return folders.get(id)!;
    if (id === null) return null;
    const row = byId.get(id);
    if (!row || seen.has(id)) return null;
    seen.add(id);
    const parent = folderOf(row.parent_id, seen);
    if (parent === null) return null;
    const folder = `${parent}${uniqueName(safeName(row.name, "Portafolio"), taken(parent))}/`;
    folders.set(id, folder);
    return folder;
  };
  // Primero las carpetas, en orden de nombre, para que los nombres repetidos sean estables.
  for (const row of [...portfolios].sort((a, b) => a.name.localeCompare(b.name))) folderOf(row.id);

  const docs = await sql<Row>`
    select id, title, kind, portfolio_id, content, file_name, file_data, file_key, file_size, updated_at
    from vault_doc where user_id = ${userId} and not deleted
    order by title
  `;
  const entries: ZipEntry[] = [];
  let total = 0;
  for (const doc of docs) {
    const folder = folderOf(doc.portfolio_id);
    if (folder === null) continue;
    const modified = Number(doc.updated_at);
    if (doc.kind === "markdown") {
      if (!allow.notes) continue;
      const bytes = new TextEncoder().encode(doc.content);
      total += bytes.length;
      entries.push({
        path: folder + uniqueName(`${safeName(doc.title, "Nota")}.md`, taken(folder)),
        modified,
        read: async () => bytes,
      });
      continue;
    }
    if (!allow.files || !doc.file_name) continue;
    const key = doc.file_key;
    const dataUrl = doc.file_data;
    total += Number(doc.file_size ?? 0);
    entries.push({
      path: folder + uniqueName(safeName(doc.file_name, "archivo"), taken(folder)),
      modified,
      read: async () => {
        if (key) return (await getBlob(sql, key))?.body ?? null;
        const decoded = dataUrl ? decodeDataUrl(dataUrl) : null;
        return decoded ? new Uint8Array(decoded.bytes) : null;
      },
    });
  }
  if (entries.length > ZIP_MAX_ENTRIES || total > ZIP_LIMIT * 0.98) {
    throw new VaultError("Es demasiado grande para un solo .zip (más de 4 GB o de 65.535 documentos).", 413);
  }
  return { name: whole ? "Grafito" : safeName(root!.name, "Portafolio"), entries };
}
