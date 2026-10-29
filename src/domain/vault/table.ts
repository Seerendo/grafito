/**
 * Tablas de datos (fase 1): columnas con tipo y filas, como una hoja de
 * cálculo sencilla dentro de la bóveda. La tabla es un archivo `.tabla` (así
 * hereda portafolios, compartir, espacios de trabajo y papelera); sus datos
 * viven en el servidor (`server/table.ts`). Sin `@/` en los imports: se prueba
 * con `node --test`.
 */

export const TABLE_MIME = "application/vnd.grafito.table+json";
export const TABLE_EXTENSION = ".tabla";

export function isTableName(name: string): boolean {
  return /\.tabla$/i.test(name);
}

/** Lo que guarda el archivo: solo marca que es una tabla (los datos van aparte). */
export function emptyTableFile(): string {
  return JSON.stringify({ type: "grafito-table", version: 1 });
}

export const FIELD_TYPES = ["text", "number", "date", "select", "checkbox", "link"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export type TableField = {
  id: string;
  name: string;
  type: FieldType;
  /** Las opciones de una columna de selección. */
  choices?: string[];
  position: number;
  width?: number | null;
};

/** Una celda de vínculo apunta a notas, archivos o portafolios de la misma bóveda. */
export type VaultRef = { id: string; kind: "document" | "portfolio" };

export type CellValue = string | number | boolean | VaultRef[] | null;

export type TableRow = {
  id: string;
  position: number;
  cells: Record<string, CellValue>;
  updatedAt: number;
  updatedBy: string;
};

export const MAX_TEXT = 10_000;
export const MAX_LINKS = 50;
export const MAX_FIELDS = 100;
export const MAX_ROWS = 20_000;

/**
 * El valor de una celda limpio para su tipo, o `null` (vacía). Lo que no
 * encaja se descarta: el servidor nunca guarda un tipo equivocado.
 */
export function cleanCell(type: FieldType, value: unknown): CellValue {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "text":
    case "select":
      return typeof value === "string" || typeof value === "number" ? String(value).slice(0, MAX_TEXT) : null;
    case "number": {
      const number = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
      return Number.isFinite(number) ? number : null;
    }
    case "date": {
      const text = String(value).trim();
      const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (!match) return null;
      const [year, month, day] = text.includes("/") ? [match[3], match[2], match[1]] : [match[1], match[2], match[3]];
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
    }
    case "checkbox":
      if (typeof value === "boolean") return value;
      return ["1", "true", "sí", "si", "x", "yes"].includes(String(value).trim().toLowerCase()) ? true : null;
    case "link": {
      if (!Array.isArray(value)) return null;
      const refs = value
        .filter(
          (ref): ref is VaultRef =>
            Boolean(ref) && typeof ref.id === "string" && ref.id.length <= 80 && (ref.kind === "document" || ref.kind === "portfolio"),
        )
        .map((ref) => ({ id: ref.id, kind: ref.kind }));
      const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()].slice(0, MAX_LINKS);
      return unique.length ? unique : null;
    }
  }
}

/** Para ordenar y filtrar: el valor como texto, o número/fecha comparables. */
export function sortKey(type: FieldType, value: CellValue, title: (ref: VaultRef) => string): string | number {
  if (value === null || value === undefined) return "";
  if (type === "number" && typeof value === "number") return value;
  if (type === "checkbox") return value ? 1 : 0;
  if (type === "link" && Array.isArray(value)) return value.map(title).join(", ");
  return String(value);
}

export function compareKeys(a: string | number, b: string | number): number {
  // Las vacías van al final, ordene como ordene.
  if (a === "" && b !== "") return 1;
  if (b === "" && a !== "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

// ---------------------------------------------------------------------------
// CSV

/** Marca de UTF-8 al principio: Excel la necesita para leer bien las tildes. */
const BOM = String.fromCharCode(0xfeff);

/** Lee un CSV (comas o punto y coma, comillas dobles, saltos dentro de comillas). */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === separator) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((line) => line.some((value) => value.trim() !== ""));
}

/** Un CSV con comas, con comillas donde hace falta (abre bien en Excel y LibreOffice). */
export function toCsv(rows: string[][]): string {
  const quote = (value: string) => (/[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return `${BOM}${rows.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

/** Adivina el tipo de una columna importada por sus valores. */
export function guessType(values: string[]): FieldType {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (filled.length === 0) return "text";
  if (filled.every((value) => cleanCell("number", value) !== null && /^-?[\d.,\s]+$/.test(value))) return "number";
  if (filled.every((value) => cleanCell("date", value) !== null)) return "date";
  if (filled.every((value) => ["sí", "si", "no", "true", "false", "x", "1", "0", "yes"].includes(value.toLowerCase()))) return "checkbox";
  return "text";
}
