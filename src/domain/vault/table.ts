/**
 * Tablas de datos: columnas con tipo y filas, como una hoja de cálculo
 * sencilla dentro de la bóveda. La tabla es un archivo `.tabla` (así hereda
 * portafolios, compartir, espacios de trabajo y papelera); sus datos viven
 * en el servidor (`server/table.ts`). La fase 2 añade relación entre tablas,
 * adjuntos, formularios y el texto que se indexa para buscar. La fase 3
 * añade la vista (tablero, galería, calendario), las fórmulas, el historial
 * de cada fila y lo que expone la API. Sin `@/` en los imports: se prueba
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

export const FIELD_TYPES = ["text", "number", "date", "select", "checkbox", "link", "relation", "file", "formula"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** Los que un enlace público puede pedir. Vínculo, relación y adjunto necesitan la bóveda. */
export const PUBLIC_FIELD_TYPES = ["text", "number", "date", "select", "checkbox"] as const;
export type PublicFieldType = (typeof PUBLIC_FIELD_TYPES)[number];

export function isPublicField(type: FieldType): type is PublicFieldType {
  return (PUBLIC_FIELD_TYPES as readonly string[]).includes(type);
}

export type TableField = {
  id: string;
  name: string;
  type: FieldType;
  /** Las opciones de una columna de selección. */
  choices?: string[];
  /** Tabla destino de una columna de relación (el documento `.tabla`). */
  relatedTableId?: string | null;
  /** Expresión de una columna fórmula (ver `formula.ts`). No se guarda en la celda. */
  formula?: string | null;
  position: number;
  width?: number | null;
};

/** Una celda de vínculo o de adjunto apunta a notas, archivos o portafolios. */
export type VaultRef = { id: string; kind: "document" | "portfolio" };

/** Una celda de relación apunta a filas de otra tabla. */
export type RowRef = { tableId: string; rowId: string };

export type CellValue = string | number | boolean | VaultRef[] | RowRef[] | null;

export type TableRow = {
  id: string;
  position: number;
  cells: Record<string, CellValue>;
  updatedAt: number;
  updatedBy: string;
};

/** Un formulario de la tabla: qué columnas pide y si tiene enlace público. */
export type TableForm = {
  title: string;
  description: string;
  /** Columnas que se piden, en orden, y si son obligatorias. */
  fields: { id: string; required: boolean }[];
  publicToken: string | null;
  enabled: boolean;
  /** Cuándo se creó el enlace vigente, y hasta cuándo vale (`null`: no caduca). */
  openedAt?: number | null;
  expiresAt?: number | null;
  revokedAt?: number | null;
};

/** Lo que ve quien abre un formulario (sin filas). */
export type FormFieldView = {
  id: string;
  name: string;
  type: FieldType;
  choices?: string[];
  required: boolean;
  relatedTableId?: string | null;
};

export const MAX_TEXT = 10_000;
export const MAX_LINKS = 50;
export const MAX_FIELDS = 100;
export const MAX_ROWS = 20_000;
export const MAX_FORM_TEXT = 4_000;

export const VIEW_MODES = ["grid", "kanban", "gallery", "calendar"] as const;
export type ViewMode = (typeof VIEW_MODES)[number];

/** Cómo se está viendo la tabla. El tablero agrupa por una selección; el calendario, por una fecha. */
export type TableLayout = {
  mode: ViewMode;
  kanbanFieldId: string | null;
  calendarFieldId: string | null;
};

export function cleanLayout(value: unknown): TableLayout {
  const raw = value && typeof value === "object" ? (value as Partial<TableLayout>) : {};
  const mode = (VIEW_MODES as readonly string[]).includes(raw.mode ?? "") ? (raw.mode as ViewMode) : "grid";
  const id = (item: unknown) => (typeof item === "string" && item.length > 0 && item.length <= 80 ? item : null);
  return { mode, kanbanFieldId: id(raw.kanbanFieldId), calendarFieldId: id(raw.calendarFieldId) };
}

export function isVaultRef(value: unknown): value is VaultRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as VaultRef;
  return typeof ref.id === "string" && ref.id.length > 0 && ref.id.length <= 80 && (ref.kind === "document" || ref.kind === "portfolio");
}

export function isRowRef(value: unknown): value is RowRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as RowRef;
  return (
    typeof ref.tableId === "string" &&
    typeof ref.rowId === "string" &&
    ref.tableId.length > 0 &&
    ref.rowId.length > 0 &&
    ref.tableId.length <= 80 &&
    ref.rowId.length <= 80
  );
}

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
    case "link":
    case "file": {
      if (!Array.isArray(value)) return null;
      const refs = value
        .filter(isVaultRef)
        .filter((ref) => type === "link" || ref.kind === "document")
        .map((ref) => ({ id: ref.id, kind: ref.kind }));
      const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()].slice(0, MAX_LINKS);
      return unique.length ? unique : null;
    }
    case "relation": {
      if (!Array.isArray(value)) return null;
      const refs = value.filter(isRowRef).map((ref) => ({ tableId: ref.tableId, rowId: ref.rowId }));
      const unique = [...new Map(refs.map((ref) => [`${ref.tableId}:${ref.rowId}`, ref])).values()].slice(0, MAX_LINKS);
      return unique.length ? unique : null;
    }
    case "formula":
      return null;
  }
}

/** Para ordenar y filtrar: el valor como texto, o número/fecha comparables. */
export function sortKey(
  type: FieldType,
  value: CellValue,
  title: (ref: VaultRef) => string,
  rowTitle: (ref: RowRef) => string = (ref) => ref.rowId,
): string | number {
  if (value === null || value === undefined) return "";
  if (type === "number" && typeof value === "number") return value;
  if (type === "checkbox") return value ? 1 : 0;
  if (type === "formula") {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    return value === null ? "" : String(value);
  }
  if ((type === "link" || type === "file") && Array.isArray(value)) return value.filter(isVaultRef).map(title).join(", ");
  if (type === "relation" && Array.isArray(value)) return value.filter(isRowRef).map(rowTitle).join(", ");
  return String(value);
}

export function compareKeys(a: string | number, b: string | number): number {
  // Las vacías van al final, ordene como ordene.
  if (a === "" && b !== "") return 1;
  if (b === "" && a !== "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

/** Texto plano de una celda, para buscar (sin ids). */
export function plainCell(type: FieldType, value: CellValue, label: (ref: VaultRef | RowRef) => string = () => ""): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value ? "sí" : "";
  if (type === "formula") {
    if (typeof value === "boolean") return value ? "sí" : "";
    return value === null || Array.isArray(value) ? "" : String(value);
  }
  if ((type === "link" || type === "file" || type === "relation") && Array.isArray(value)) {
    return value.map((ref) => label(ref as VaultRef | RowRef)).filter(Boolean).join(" ");
  }
  return String(value);
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
