const IGNORED_UPLOAD = new Set([".DS_Store", "Thumbs.db"]);

/** Archivos que el sistema mete en una carpeta y no hay que subir. */
export function ignoredUpload(path: string): boolean {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return IGNORED_UPLOAD.has(base);
}

/**
 * Una carpeta soltada o elegida en el equipo: las subcarpetas que hay que
 * crear (de fuera hacia dentro) y en cuál va cada archivo. `folder` vacío es
 * el portafolio de destino. Se ignoran rutas que salen de la carpeta (`..`).
 */
export function folderPlan(paths: readonly string[]): {
  folders: string[];
  files: { relativePath: string; folder: string }[];
} {
  const folders = new Set<string>();
  const files: { relativePath: string; folder: string }[] = [];
  for (const raw of paths) {
    const relativePath = raw.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
    const parts = relativePath.split("/").filter((part) => part.length > 0 && part !== ".");
    if (parts.length === 0 || parts.some((part) => part === "..")) continue;
    const folderParts = parts.slice(0, -1);
    let acc = "";
    for (const part of folderParts) {
      acc = acc ? `${acc}/${part}` : part;
      folders.add(acc);
    }
    files.push({ relativePath: parts.join("/"), folder: folderParts.join("/") });
  }
  const ordered = [...folders].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b, "es"),
  );
  return { folders: ordered, files };
}
