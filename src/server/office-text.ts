import { inflateRawSync } from "node:zlib";

/**
 * Texto de los documentos de Office (solo servidor), para que la IA pueda
 * leerlos: Word, Excel y PowerPoint (OOXML) y OpenDocument son archivos ZIP
 * con XML dentro. Sin dependencias: un lector ZIP mínimo y el XML de cada
 * formato pasado a texto plano. Sin `@/` en los imports: se prueba con
 * `node --test`.
 */

/** Tope de lo que se descomprime de una entrada (contra bombas ZIP). */
const MAX_ENTRY = 24 * 1024 * 1024;

type Entry = { name: string; method: number; size: number; compressed: number; offset: number };

function entries(zip: Uint8Array): Map<string, Entry> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const found = new Map<string, Entry>();
  // Fin del directorio central: firma 0x06054b50, en los últimos 64 KB.
  let end = -1;
  for (let index = zip.byteLength - 22; index >= Math.max(0, zip.byteLength - 65_557); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) return found;
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  for (let index = 0; index < count && cursor + 46 <= zip.byteLength; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(zip.subarray(cursor + 46, cursor + 46 + nameLength));
    found.set(name, { name, method, size, compressed, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

function read(zip: Uint8Array, entry: Entry): string | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (entry.offset + 30 > zip.byteLength || view.getUint32(entry.offset, true) !== 0x04034b50) return null;
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = zip.subarray(start, start + entry.compressed);
  if (entry.size > MAX_ENTRY) return null;
  try {
    const bytes = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_ENTRY }) : null;
    return bytes ? new TextDecoder().decode(bytes) : null;
  } catch {
    return null;
  }
}

function decode(xml: string): string {
  return xml
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

/** El texto de un XML: los saltos donde terminan párrafos o filas, sin etiquetas. */
function plain(xml: string, breaks: RegExp, tabs?: RegExp): string {
  let text = xml.replace(breaks, "\n");
  if (tabs) text = text.replace(tabs, "\t");
  text = decode(text.replace(/<[^>]+>/g, ""));
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function numbered(names: string[], pattern: RegExp): string[] {
  return names
    .map((name) => ({ name, number: Number(pattern.exec(name)?.[1]) }))
    .filter((item) => Number.isFinite(item.number) && pattern.test(item.name))
    .sort((a, b) => a.number - b.number)
    .map((item) => item.name);
}

function word(zip: Uint8Array, files: Map<string, Entry>): string | null {
  const body = files.get("word/document.xml");
  const xml = body ? read(zip, body) : null;
  return xml ? plain(xml, /<\/w:p>|<w:br\/>/g, /<w:tab\/>/g) : null;
}

function slides(zip: Uint8Array, files: Map<string, Entry>): string | null {
  const names = numbered([...files.keys()], /^ppt\/slides\/slide(\d+)\.xml$/);
  if (names.length === 0) return null;
  return names
    .map((name, index) => {
      const xml = read(zip, files.get(name)!);
      return `— Diapositiva ${index + 1} —\n${xml ? plain(xml, /<\/a:p>/g) : ""}`;
    })
    .join("\n\n");
}

function sheets(zip: Uint8Array, files: Map<string, Entry>): string | null {
  const shared: string[] = [];
  const strings = files.get("xl/sharedStrings.xml");
  const stringsXml = strings ? read(zip, strings) : null;
  if (stringsXml) {
    for (const item of stringsXml.match(/<si>[\s\S]*?<\/si>/g) ?? []) {
      shared.push(decode((item.match(/<t[^>]*>[\s\S]*?<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("")));
    }
  }
  const workbook = files.get("xl/workbook.xml");
  const workbookXml = workbook ? read(zip, workbook) : null;
  const titles = [...(workbookXml?.matchAll(/<sheet[^>]*name="([^"]*)"/g) ?? [])].map((match) => decode(match[1] ?? ""));
  const names = numbered([...files.keys()], /^xl\/worksheets\/sheet(\d+)\.xml$/);
  if (names.length === 0) return null;
  return names
    .map((name, index) => {
      const xml = read(zip, files.get(name)!) ?? "";
      const rows = (xml.match(/<row[\s\S]*?<\/row>/g) ?? []).map((row) =>
        (row.match(/<c\b[\s\S]*?(?:\/>|<\/c>)/g) ?? [])
          .map((cell) => {
            const type = /\bt="([^"]+)"/.exec(cell)?.[1];
            const value = /<v>([\s\S]*?)<\/v>/.exec(cell)?.[1];
            if (type === "s" && value !== undefined) return shared[Number(value)] ?? "";
            if (type === "inlineStr") return decode((cell.match(/<t[^>]*>([\s\S]*?)<\/t>/) ?? [])[1] ?? "");
            return value === undefined ? "" : decode(value);
          })
          .join("\t")
          .replace(/\t+$/, ""),
      );
      return `— Hoja «${titles[index] ?? index + 1}» —\n${rows.filter((row) => row.trim()).join("\n")}`;
    })
    .join("\n\n");
}

function openDocument(zip: Uint8Array, files: Map<string, Entry>): string | null {
  const content = files.get("content.xml");
  const xml = content ? read(zip, content) : null;
  return xml ? plain(xml, /<\/text:p>|<\/text:h>|<\/table:table-row>|<text:line-break\/>/g, /<\/table:table-cell>|<text:tab\/>/g) : null;
}

/** Texto de un documento de Office u OpenDocument, o `null` si no lo es o no se puede leer. */
export function officeText(name: string, bytes: Uint8Array): string | null {
  const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  if (!["docx", "docm", "pptx", "xlsx", "xlsm", "odt", "ods", "odp"].includes(extension)) return null;
  const files = entries(bytes);
  if (files.size === 0) return null;
  if (extension.startsWith("doc")) return word(bytes, files);
  if (extension === "pptx") return slides(bytes, files);
  if (extension.startsWith("xls")) return sheets(bytes, files);
  return openDocument(bytes, files);
}
