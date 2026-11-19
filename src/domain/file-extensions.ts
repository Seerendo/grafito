/**
 * File extension rules. Administrators block extensions from upload, or let them upload but keep
 * them out of the search index. Extensions are stored lowercase without the dot.
 */

export type ExtensionGroup = { label: string; extensions: string[] };

/** Common extensions offered as checkboxes; any other extension can be typed in. */
export const EXTENSION_GROUPS: ExtensionGroup[] = [
  {
    label: "Comprimidos e imágenes de disco",
    extensions: [
      "zip",
      "rar",
      "7z",
      "tar",
      "gz",
      "tgz",
      "bz2",
      "xz",
      "zst",
      "cab",
      "iso",
      "img",
      "dmg",
      "vhd",
      "vhdx",
      "vmdk",
      "ova",
    ],
  },
  {
    label: "Ejecutables y scripts",
    extensions: [
      "exe",
      "msi",
      "msix",
      "dll",
      "com",
      "scr",
      "bat",
      "cmd",
      "ps1",
      "vbs",
      "js",
      "jar",
      "sh",
      "apk",
      "appimage",
      "deb",
      "rpm",
      "pkg",
      "bin",
    ],
  },
  {
    label: "Documentos",
    extensions: [
      "pdf",
      "doc",
      "docx",
      "odt",
      "rtf",
      "txt",
      "md",
      "xls",
      "xlsx",
      "ods",
      "csv",
      "ppt",
      "pptx",
      "odp",
      "epub",
    ],
  },
  {
    label: "Imágenes",
    extensions: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "svg", "heic", "psd"],
  },
  {
    label: "Audio y video",
    extensions: ["mp3", "wav", "flac", "ogg", "m4a", "mp4", "mkv", "avi", "mov", "wmv", "webm"],
  },
  {
    label: "Datos y código",
    extensions: ["json", "xml", "yaml", "yml", "sql", "db", "sqlite", "log", "html", "css"],
  },
];

export type ExtensionRules = { upload: string[]; index: string[] };

export const NO_RULES: ExtensionRules = { upload: [], index: [] };

/** Last extension of a file name, lowercase, or "" when there is none. */
export function extensionOf(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Clean extensions typed by people: accepts ".RAR", "rar, iso" or "*.iso"; drops anything that
 * is not letters, digits, + or -, removes duplicates and sorts.
 */
export function normalizeExtensions(input: string | readonly string[]): string[] {
  const parts = typeof input === "string" ? input.split(/[\s,;]+/) : input;
  const out = new Set<string>();
  for (const part of parts) {
    const ext = part
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, "");
    if (/^[a-z0-9+-]{1,16}$/.test(ext)) out.add(ext);
  }
  return [...out].sort();
}

/** Upload blocks also keep an extension out of the index; index blocks stay separate. */
export function parseRules(upload: string, index: string): ExtensionRules {
  return { upload: normalizeExtensions(upload), index: normalizeExtensions(index) };
}

export function uploadBlocked(name: string, rules: ExtensionRules): boolean {
  const ext = extensionOf(name);
  return ext !== "" && rules.upload.includes(ext);
}

export function indexBlocked(name: string, rules: ExtensionRules): boolean {
  const ext = extensionOf(name);
  return ext !== "" && rules.index.includes(ext);
}

/** Spanish message shown when an upload is refused for its extension. */
export function blockedMessage(name: string): string {
  return `No se permite subir archivos .${extensionOf(name)} («${name}»).`;
}
