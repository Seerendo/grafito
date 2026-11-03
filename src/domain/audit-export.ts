/**
 * Pure audit export and retention logic. The server supplies rows; this module converts them to
 * CSV or JSON.
 */

export type AuditExportRow = {
  at: string;
  actor: string;
  action: string;
  outcome: string;
  area: string;
  target: string;
  detail: string;
  ip: string;
};

const COLUMNS = ["at", "actor", "action", "outcome", "area", "target", "detail", "ip"] as const;

/** Accept retention from seven days to ten years; reject other values. */
export function clampRetentionDays(value: number): number | null {
  if (!Number.isInteger(value) || value < 7 || value > 3650) return null;
  return value;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** CSV with a BOM so spreadsheet applications decode accented text correctly. */
export function auditToCsv(rows: readonly AuditExportRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((key) => csvCell(row[key])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function auditToJson(rows: readonly AuditExportRow[]): string {
  return JSON.stringify(rows);
}
