/**
 * Typed data tables are .tabla vault files inheriting portfolios, sharing, workspaces and
 * trash, with rows stored in server/table.ts. Relations, attachments, forms and search text
 * extend the model; layouts, formulas and row history support richer views. Relative imports
 * permit direct Node tests.
 */

export const TABLE_MIME = "application/vnd.grafito.table+json";
export const TABLE_EXTENSION = ".tabla";

export function isTableName(name: string): boolean {
  return /\.tabla$/i.test(name);
}

/** File content only identifies a table; its data is stored separately. */
export function emptyTableFile(): string {
  return JSON.stringify({ type: "grafito-table", version: 1 });
}

export const FIELD_TYPES = [
  "text",
  "identifier",
  "number",
  "date",
  "time",
  "select",
  "checkbox",
  "link",
  "relation",
  "file",
  "formula",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Public-form field types. Links, relations and formulas require vault access; attachments are
 * handled separately.
 */
export const PUBLIC_FIELD_TYPES = [
  "text",
  "identifier",
  "number",
  "date",
  "time",
  "select",
  "checkbox",
] as const;
export type PublicFieldType = (typeof PUBLIC_FIELD_TYPES)[number];

export function isPublicField(type: FieldType): type is PublicFieldType {
  return (PUBLIC_FIELD_TYPES as readonly string[]).includes(type);
}

export type TableField = {
  id: string;
  name: string;
  type: FieldType;
  /** Selection-column choices. */
  choices?: string[];
  /** Related table's .tabla document ID. */
  relatedTableId?: string | null;
  /** Formula expression belongs to the column, not individual cells; see formula.ts. */
  formula?: string | null;
  position: number;
  width?: number | null;
};

/** Link or attachment cells reference notes, files or portfolios. */
export type VaultRef = { id: string; kind: "document" | "portfolio" };

/** Relation cells reference rows in another table. */
export type RowRef = { tableId: string; rowId: string };

export type CellValue = string | number | boolean | VaultRef[] | RowRef[] | null;

export type TableRow = {
  id: string;
  position: number;
  cells: Record<string, CellValue>;
  updatedAt: number;
  updatedBy: string;
};

/** Table form configuration and public-link availability. */
export type TableForm = {
  title: string;
  description: string;
  /** Ordered requested columns and required flags. */
  fields: { id: string; required: boolean }[];
  publicToken: string | null;
  enabled: boolean;
  /** Current link creation and expiry; null means no expiry. */
  openedAt?: number | null;
  expiresAt?: number | null;
  revokedAt?: number | null;
  /** Authenticated invitation link, unavailable to arbitrary visitors. */
  inviteToken: string | null;
  invites: FormInvite[];
};

/** Invitation to fill a form without granting table access. */
export type FormInvite = { kind: "user" | "org"; subjectId: string };

/** Form view excludes existing rows. */
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

/** Table layout: boards group by selection and calendars by date. */
export type TableLayout = {
  mode: ViewMode;
  kanbanFieldId: string | null;
  calendarFieldId: string | null;
};

export function cleanLayout(value: unknown): TableLayout {
  const raw = value && typeof value === "object" ? (value as Partial<TableLayout>) : {};
  const mode = (VIEW_MODES as readonly string[]).includes(raw.mode ?? "")
    ? (raw.mode as ViewMode)
    : "grid";
  const id = (item: unknown) =>
    typeof item === "string" && item.length > 0 && item.length <= 80 ? item : null;
  return { mode, kanbanFieldId: id(raw.kanbanFieldId), calendarFieldId: id(raw.calendarFieldId) };
}

export function isVaultRef(value: unknown): value is VaultRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as VaultRef;
  return (
    typeof ref.id === "string" &&
    ref.id.length > 0 &&
    ref.id.length <= 80 &&
    (ref.kind === "document" || ref.kind === "portfolio")
  );
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
 * Normalize a cell for its type, returning null for empty/invalid values so the server never
 * stores mismatched types.
 */
export function cleanCell(type: FieldType, value: unknown): CellValue {
  if (value === null || value === undefined || value === "") return null;
  switch (type) {
    case "text":
    case "select":
      return typeof value === "string" || typeof value === "number"
        ? String(value).slice(0, MAX_TEXT)
        : null;
    case "identifier": {
      if (typeof value !== "string" && typeof value !== "number") return null;
      const text = String(value).trim().slice(0, MAX_TEXT);
      return text || null;
    }
    case "number": {
      const number =
        typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
      return Number.isFinite(number) ? number : null;
    }
    case "date": {
      const text = String(value).trim();
      const match =
        /^(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      if (!match) return null;
      const [year, month, day] = text.includes("/")
        ? [match[3], match[2], match[1]]
        : [match[1], match[2], match[3]];
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? null : iso;
    }
    case "time":
      return cleanTime(value);
    case "checkbox":
      if (typeof value === "boolean") return value;
      return ["1", "true", "sí", "si", "x", "yes"].includes(String(value).trim().toLowerCase())
        ? true
        : null;
    case "link":
    case "file": {
      if (!Array.isArray(value)) return null;
      const refs = value
        .filter(isVaultRef)
        .filter((ref) => type === "link" || ref.kind === "document")
        .map((ref) => ({ id: ref.id, kind: ref.kind }));
      const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()].slice(
        0,
        MAX_LINKS,
      );
      return unique.length ? unique : null;
    }
    case "relation": {
      if (!Array.isArray(value)) return null;
      const refs = value
        .filter(isRowRef)
        .map((ref) => ({ tableId: ref.tableId, rowId: ref.rowId }));
      const unique = [
        ...new Map(refs.map((ref) => [`${ref.tableId}:${ref.rowId}`, ref])).values(),
      ].slice(0, MAX_LINKS);
      return unique.length ? unique : null;
    }
    case "formula":
      return null;
  }
}

/** Normalize 24-hour HH:MM time, accepting values such as 14:30, 14:30:00 and 2:05. */
export function cleanTime(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** Trimmed case-insensitive identifier key; empty values do not count. */
export function identifierKey(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().toLocaleLowerCase("es");
}

/** First duplicate identifier, excluding empty values, or null. */
export function duplicateIdentifier(values: unknown[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const cleaned = cleanCell("identifier", value);
    if (typeof cleaned !== "string") continue;
    const key = identifierKey(cleaned);
    if (!key) continue;
    if (seen.has(key)) return cleaned;
    seen.add(key);
  }
  return null;
}

/** Comparable text, number or date for filtering and sorting. */
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
  if ((type === "link" || type === "file") && Array.isArray(value))
    return value.filter(isVaultRef).map(title).join(", ");
  if (type === "relation" && Array.isArray(value))
    return value.filter(isRowRef).map(rowTitle).join(", ");
  return String(value);
}

export function compareKeys(a: string | number, b: string | number): number {
  // Empty cells sort last in either direction.
  if (a === "" && b !== "") return 1;
  if (b === "" && a !== "") return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "es", { numeric: true, sensitivity: "base" });
}

/** Plain cell text for search, excluding IDs. */
export function plainCell(
  type: FieldType,
  value: CellValue,
  label: (ref: VaultRef | RowRef) => string = () => "",
): string {
  if (value === null || value === undefined) return "";
  if (type === "checkbox") return value ? "sí" : "";
  if (type === "formula") {
    if (typeof value === "boolean") return value ? "sí" : "";
    return value === null || Array.isArray(value) ? "" : String(value);
  }
  if ((type === "link" || type === "file" || type === "relation") && Array.isArray(value)) {
    return value
      .map((ref) => label(ref as VaultRef | RowRef))
      .filter(Boolean)
      .join(" ");
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// CSV

/** UTF-8 BOM lets Excel decode accented characters correctly. */
const BOM = String.fromCharCode(0xfeff);

/** Parse comma/semicolon CSV with escaped quotes and multiline quoted fields. */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith(BOM) ? text.slice(1) : text;
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
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

/** Generate comma-separated CSV with necessary quoting for Excel and LibreOffice. */
export function toCsv(rows: string[][]): string {
  const quote = (value: string) =>
    /[",\n\r;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return `${BOM}${rows.map((row) => row.map(quote).join(",")).join("\r\n")}\r\n`;
}

/** Infer an imported column's type from its values. */
export function guessType(values: string[]): FieldType {
  const filled = values.map((value) => value.trim()).filter(Boolean);
  if (filled.length === 0) return "text";
  if (filled.every((value) => cleanCell("number", value) !== null && /^-?[\d.,\s]+$/.test(value)))
    return "number";
  if (filled.every((value) => cleanCell("date", value) !== null)) return "date";
  if (filled.every((value) => cleanCell("time", value) !== null)) return "time";
  if (
    filled.every((value) =>
      ["sí", "si", "no", "true", "false", "x", "1", "0", "yes"].includes(value.toLowerCase()),
    )
  )
    return "checkbox";
  return "text";
}
