/**
 * Exportación y plazo de la auditoría. Sin base de datos: el servidor arma
 * las filas y esto las convierte a CSV o JSON.
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

/** Entre 7 días y 10 años. Otro valor no se guarda. */
export function clampRetentionDays(value: number): number | null {
  if (!Number.isInteger(value) || value < 7 || value > 3650) return null;
  return value;
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** CSV con BOM para que una hoja de cálculo abra los acentos. */
export function auditToCsv(rows: readonly AuditExportRow[]): string {
  const lines = [COLUMNS.join(",")];
  for (const row of rows) lines.push(COLUMNS.map((key) => csvCell(row[key])).join(","));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function auditToJson(rows: readonly AuditExportRow[]): string {
  return JSON.stringify(rows);
}
