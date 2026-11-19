const IGNORED_UPLOAD = new Set([".DS_Store", "Thumbs.db"]);

/** System-generated folder files excluded from upload. */
export function ignoredUpload(path: string): boolean {
  const base = path.replaceAll("\\", "/").split("/").pop() ?? path;
  return IGNORED_UPLOAD.has(base);
}

/** Path parts without empty or "." parts; null when it climbs with "..". */
function cleanParts(raw: string): string[] | null {
  const parts = raw
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part.length > 0 && part !== ".");
  return parts.some((part) => part === "..") ? null : parts;
}

/**
 * Plan folder imports from outermost to innermost and assign files to folders. Empty folder
 * denotes the destination portfolio. Ignore traversal paths containing dot-dot. emptyFolders
 * are folder paths with nothing inside that are created too.
 */
export function folderPlan(
  paths: readonly string[],
  emptyFolders: readonly string[] = [],
): {
  folders: string[];
  files: { relativePath: string; folder: string }[];
} {
  const folders = new Set<string>();
  const files: { relativePath: string; folder: string }[] = [];
  for (const raw of emptyFolders) {
    const parts = cleanParts(raw);
    if (!parts) continue;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      folders.add(acc);
    }
  }
  for (const raw of paths) {
    const parts = cleanParts(raw);
    if (!parts || parts.length === 0) continue;
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
