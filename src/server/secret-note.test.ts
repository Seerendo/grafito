import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "@/lib/db";
import { createNote, dropNote, takeNote, validNoteToken } from "./secret-note.ts";

/**
 * Notas secretas del correo de acceso, sin Redis (van a `app_secret_note`):
 * una sola lectura, nada legible guardado, token equivocado y caducidad.
 */

delete process.env.REDIS_URL;

type Row = { id: string; sealed: string; expires_at: number };

/** Una base mínima que entiende las tres consultas de `secret-note.ts`. */
function fakeSql(rows: Map<string, Row>): Sql {
  const run = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.startsWith("insert into app_secret_note")) {
      const [id, sealed, expires] = values as [string, string, number];
      rows.set(id, { id, sealed, expires_at: expires });
      return Promise.resolve([]);
    }
    if (text.includes("returning sealed")) {
      const row = rows.get(values[0] as string);
      rows.delete(values[0] as string);
      return Promise.resolve(row ? [row] : []);
    }
    if (text.startsWith("delete from app_secret_note where id")) {
      rows.delete(values[0] as string);
      return Promise.resolve([]);
    }
    throw new Error(`consulta no prevista: ${text}`);
  };
  return run as unknown as Sql;
}

test("se lee una sola vez y lo guardado no contiene el secreto", async () => {
  const rows = new Map<string, Row>();
  const sql = fakeSql(rows);
  const note = await createNote(sql, "Contraseña-Temporal-123", Date.now() + 60_000);
  assert.ok(validNoteToken(note.token));
  const stored = [...rows.values()][0]!;
  assert.ok(!stored.sealed.includes("Contraseña"));
  assert.ok(!stored.id.includes(note.token));
  assert.equal(await takeNote(sql, note.token), "Contraseña-Temporal-123");
  assert.equal(await takeNote(sql, note.token), null);
  assert.equal(rows.size, 0);
});

test("un token equivocado no la abre ni la destruye", async () => {
  const rows = new Map<string, Row>();
  const sql = fakeSql(rows);
  const note = await createNote(sql, "secreto", Date.now() + 60_000);
  const wrong = `${note.token.slice(0, -1)}${note.token.endsWith("A") ? "B" : "A"}`;
  assert.equal(await takeNote(sql, wrong), null);
  assert.equal(await takeNote(sql, "no-es-un-token"), null);
  assert.equal(await takeNote(sql, note.token), "secreto");
});

test("vencida o anulada, ya no se abre", async () => {
  const rows = new Map<string, Row>();
  const sql = fakeSql(rows);
  const expired = await createNote(sql, "viejo", Date.now() - 1);
  assert.equal(await takeNote(sql, expired.token), null);
  const dropped = await createNote(sql, "anulado", Date.now() + 60_000);
  await dropNote(sql, dropped.id);
  assert.equal(await takeNote(sql, dropped.token), null);
});
