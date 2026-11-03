import type { Sql } from "@/lib/db";
import { clampRetentionDays } from "@/domain/audit-export";

/**
 * Structured server audit records actor, action, outcome and target. Administration changes
 * also retain the existing short app_log.
 */

export type AuditInput = {
  actorId?: string | null;
  actorName?: string;
  action: string;
  outcome: "ok" | "denied" | "error";
  area: string;
  target?: string;
  detail?: string;
  ip?: string;
};

const SWEEP_MS = 10 * 60 * 1000;
let sweptAt = 0;

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const first = forwarded.split(",")[0]?.trim() ?? "";
  return first.slice(0, 80);
}

/** Record an event without passwords or file contents. */
export async function recordAudit(sql: Sql, input: AuditInput): Promise<void> {
  await sql`
    insert into audit_event (id, actor_id, actor_name, action, outcome, area, target, detail, ip)
    values (
      ${crypto.randomUUID()},
      ${input.actorId ?? null},
      ${clip(input.actorName ?? "", 120)},
      ${clip(input.action, 40)},
      ${input.outcome},
      ${clip(input.area, 40)},
      ${clip(input.target ?? "", 300)},
      ${clip(input.detail ?? "", 500)},
      ${clip(input.ip ?? "", 80)}
    )
  `;
  await sweepAudit(sql);
}

/** Write both short-log and audit entries for administration changes. */
export async function logActivity(
  sql: Sql,
  input: { actorName: string; area: string; message: string; actorId?: string | null },
): Promise<void> {
  await sql`
    insert into app_log (id, actor, area, message)
    values (${crypto.randomUUID()}, ${input.actorName}, ${input.area}, ${input.message})
  `;
  await recordAudit(sql, {
    actorId: input.actorId,
    actorName: input.actorName,
    action: "admin",
    outcome: "ok",
    area: input.area,
    detail: input.message,
  });
}

export async function retentionDays(sql: Sql): Promise<number> {
  const rows = await sql<{
    value: string;
  }>`select value from app_setting where key = 'audit_retention_days' limit 1`;
  const parsed = Number(rows[0]?.value);
  return clampRetentionDays(parsed) ?? 365;
}

export async function setRetentionDays(sql: Sql, days: number): Promise<void> {
  await sql`
    insert into app_setting (key, value) values ('audit_retention_days', ${String(days)})
    on conflict (key) do update set value = excluded.value
  `;
  sweptAt = 0;
  await sweepAudit(sql);
}

/** Prune expired audit entries at most every ten minutes per process. */
export async function sweepAudit(sql: Sql, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - sweptAt < SWEEP_MS) return;
  sweptAt = now;
  const days = await retentionDays(sql);
  await sql`delete from audit_event where at < now() - ${`${days} days`}::interval`;
}
