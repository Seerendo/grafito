import { verifyPassword } from "better-auth/crypto";
import { DAV_FAIL_WINDOW_MS, davLockedOut } from "@/domain/dav";
import type { Sql } from "@/lib/db";
import { apiCaller, type ApiCaller } from "@/server/api";
import { TOKEN_PREFIX, resolveToken } from "@/server/api-tokens";
import { recordAudit, requestIp } from "@/server/audit";
import { readUserProfile } from "@/server/profile";

/**
 * Quién llama a WebDAV (solo servidor). En este orden: Basic (usuario y
 * contraseña, o un token personal en la contraseña), Bearer `gft_…`, o la
 * sesión del navegador. Comprobar la contraseña no abre una sesión.
 */

const failures = new Map<string, number[]>();

export function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Grafito", charset="UTF-8"',
      DAV: "1, 2",
      "cache-control": "no-store",
    },
  });
}

function tooMany(): Response {
  return new Response("Demasiados intentos.", {
    status: 429,
    headers: { "retry-after": "600", DAV: "1, 2", "cache-control": "no-store" },
  });
}

function locked(ip: string): boolean {
  const now = Date.now();
  const prev = (failures.get(ip) ?? []).filter((stamp) => now - stamp < DAV_FAIL_WINDOW_MS);
  failures.set(ip, prev);
  return davLockedOut(prev, now);
}

function noteFailure(ip: string): void {
  const now = Date.now();
  const prev = (failures.get(ip) ?? []).filter((stamp) => now - stamp < DAV_FAIL_WINDOW_MS);
  prev.push(now);
  failures.set(ip, prev);
}

async function userByLogin(sql: Sql, login: string): Promise<string | null> {
  const rows = await sql<{ user_id: string }>`
    select user_id from app_user_role where lower(login_name) = lower(${login}) limit 2
  `;
  return rows.length === 1 ? rows[0]!.user_id : null;
}

async function passwordMatches(sql: Sql, userId: string, password: string): Promise<boolean> {
  const rows = await sql<{ password: string | null }>`
    select password from account
    where "userId" = ${userId} and "providerId" = 'credential' and password is not null
    limit 1
  `;
  const hash = rows[0]?.password;
  if (!hash) return false;
  try {
    return await verifyPassword({ hash, password });
  } catch {
    return false;
  }
}

async function callerFor(sql: Sql, userId: string): Promise<ApiCaller | Response> {
  const profile = await readUserProfile(sql, userId);
  // Contraseña inicial o la temporal del correo: primero hay que cambiarla en la web.
  if (profile.mustChangePassword) {
    return new Response("Cambia la contraseña antes de usar WebDAV.", {
      status: 403,
      headers: { DAV: "1, 2" },
    });
  }
  return { sql, userId, profile, via: "token" };
}

function decodeBasic(header: string): { user: string; password: string } | null {
  try {
    const text = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const cut = text.indexOf(":");
    if (cut < 0) return null;
    const user = text.slice(0, cut);
    const password = text.slice(cut + 1);
    if (!user || user.length > 80 || password.length > 500) return null;
    return { user, password };
  } catch {
    return null;
  }
}

async function basicCaller(request: Request, header: string): Promise<ApiCaller | Response> {
  const ip = requestIp(request) || "desconocida";
  if (locked(ip)) return tooMany();
  const decoded = decodeBasic(header);
  const { getSql } = await import("@/lib/db");
  const sql = await getSql();
  const fail = async (login: string) => {
    noteFailure(ip);
    await recordAudit(sql, {
      actorName: login.slice(0, 80),
      action: "webdav",
      outcome: "denied",
      area: "WebDAV",
      detail: "Credenciales rechazadas",
      ip,
    }).catch(() => undefined);
    return unauthorized();
  };
  if (!decoded) return fail("");
  const token = decoded.password.startsWith(TOKEN_PREFIX)
    ? decoded.password
    : decoded.user.startsWith(TOKEN_PREFIX)
      ? decoded.user
      : "";
  if (token) {
    const userId = await resolveToken(sql, token);
    if (!userId) return fail(decoded.user);
    failures.delete(ip);
    const caller = await callerFor(sql, userId);
    return caller instanceof Response ? caller : { ...caller, via: "token" };
  }
  const userId = await userByLogin(sql, decoded.user);
  if (!userId || !(await passwordMatches(sql, userId, decoded.password))) return fail(decoded.user);
  failures.delete(ip);
  const caller = await callerFor(sql, userId);
  return caller instanceof Response ? caller : { ...caller, via: "token" };
}

export async function davCaller(request: Request): Promise<ApiCaller | Response> {
  const header = request.headers.get("authorization") ?? "";
  if (header.toLowerCase().startsWith("basic ")) return basicCaller(request, header);
  try {
    const caller = await apiCaller(request);
    if (caller.profile.mustChangePassword) {
      return new Response("Cambia la contraseña antes de usar WebDAV.", {
        status: 403,
        headers: { DAV: "1, 2" },
      });
    }
    return caller;
  } catch (error) {
    if (error instanceof Response) return error.status === 401 ? unauthorized() : error;
    throw error;
  }
}
