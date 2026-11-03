import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  auditToCsv,
  auditToJson,
  clampRetentionDays,
  type AuditExportRow,
} from "@/domain/audit-export";
import { authMiddleware } from "@/lib/auth/middleware";
import { requireLease } from "@/server/lease";
import { allows, readUserProfile } from "@/server/profile";
import { logActivity, retentionDays, setRetentionDays } from "@/server/audit";

/** Consulta, exportación y plazo de la auditoría (Administración → Auditoría). */

type Sql = Awaited<ReturnType<typeof import("@/lib/db").getSql>>;

const filter = z.object({
  action: z.string().max(40).optional(),
  outcome: z.enum(["ok", "denied", "error", ""]).optional(),
  actor: z.string().max(120).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});

type Filter = z.infer<typeof filter>;

const EMPTY: AuditExportRow[] = [];

function like(value: string): string {
  return `%${value.trim().replace(/[\\%_]/g, "")}%`;
}

function when(value: string | undefined): string {
  if (!value?.trim()) return "";
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

async function reader(userId: string): Promise<{ sql: Sql; ok: boolean; actor: string }> {
  const sql = await requireLease(userId);
  const profile = await readUserProfile(sql, userId);
  return {
    sql,
    ok: allows(profile, "monitor.view"),
    actor: profile.loginName || profile.displayName,
  };
}

async function rows(sql: Sql, input: Filter, limit: number): Promise<AuditExportRow[]> {
  const action = input.action?.trim() ?? "";
  const outcome = input.outcome?.trim() ?? "";
  const actor = input.actor?.trim() ?? "";
  const from = when(input.from);
  const to = when(input.to);
  const found = await sql<{
    at: string;
    actor_name: string;
    action: string;
    outcome: string;
    area: string;
    target: string;
    detail: string;
    ip: string;
  }>`
    select at::text as at, actor_name, action, outcome, area, target, detail, ip
    from audit_event
    where (${action === ""} or action = ${action})
      and (${outcome === ""} or outcome = ${outcome})
      and (${actor === ""} or actor_name ilike ${actor ? like(actor) : ""})
      and (${from === ""} or at >= ${from || "1970-01-01"}::timestamptz)
      and (${to === ""} or at <= ${to || "1970-01-01"}::timestamptz)
    order by at desc
    limit ${limit}
  `;
  return found.map((row) => ({
    at: String(row.at),
    actor: row.actor_name,
    action: row.action,
    outcome: row.outcome,
    area: row.area,
    target: row.target,
    detail: row.detail,
    ip: row.ip,
  }));
}

export const auditPage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => filter.parse(input ?? {}))
  .handler(async ({ context, data }) => {
    const gate = await reader(context.userId);
    if (!gate.ok) return { ok: false as const, rows: EMPTY, retention: 365 };
    return {
      ok: true as const,
      rows: await rows(gate.sql, data, 200),
      retention: await retentionDays(gate.sql),
    };
  });

export const auditExport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => filter.extend({ format: z.enum(["csv", "json"]) }).parse(input))
  .handler(async ({ context, data }) => {
    const gate = await reader(context.userId);
    if (!gate.ok) return { ok: false as const, error: "Sin permiso." };
    const list = await rows(gate.sql, data, 5000);
    const body = data.format === "csv" ? auditToCsv(list) : auditToJson(list);
    const stamp = new Date().toISOString().slice(0, 10);
    return {
      ok: true as const,
      filename: `auditoria-${stamp}.${data.format}`,
      type: data.format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
      body,
    };
  });

export const saveAuditRetention = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: unknown) => z.object({ days: z.number().int() }).parse(input))
  .handler(async ({ context, data }) => {
    const gate = await reader(context.userId);
    const days = clampRetentionDays(data.days);
    if (!gate.ok || days === null)
      return { ok: false as const, error: "La retención tiene que estar entre 7 y 3650 días." };
    await setRetentionDays(gate.sql, days);
    await logActivity(gate.sql, {
      actorId: context.userId,
      actorName: gate.actor,
      area: "Auditoría",
      message: `Conserva la auditoría ${days} días`,
    });
    return { ok: true as const, days };
  });
