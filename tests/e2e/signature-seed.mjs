/**
 * Seed data for the PDF signature browser test (pdf-signatures.e2e.mjs). It writes only rows and
 * objects whose ids start with "e2esig-", in the local test stack (project grafito-e2e), and
 * removes the previous run's rows before writing.
 */
import { randomUUID } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { hashPassword } from "better-auth/crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
import pg from "pg";

export const PASSWORD = process.env.E2E_PASSWORD ?? "Prueba-Firma-2026";
export const USERS = ["e2esig-owner", "e2esig-signer", "e2esig-outsider"];

/** @param {string} name @param {string} fallback */
function env(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

/** Two A4 pages and one Letter page, so boxes are checked on pages with different sizes. */
async function samplePdf() {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  /** @type {[number, number][]} */
  const sizes = [
    [595, 842],
    [595, 842],
    [612, 792],
  ];
  for (const [index, size] of sizes.entries()) {
    const page = pdf.addPage(size);
    page.drawText(`Contrato de prueba, pagina ${index + 1}`, { x: 60, y: size[1] - 80, font });
  }
  return Buffer.from(await pdf.save());
}

/**
 * A password account written straight to the test database, as Better Auth stores it. Public
 * sign-up is closed (src/lib/auth/signup-guard.ts), so the test cannot register over HTTP.
 * @param {pg.Client} client @param {string} login
 */
async function ensureAccount(client, login) {
  const email = `${login}@grafito.app`;
  const known = await client.query(`select id from "user" where email = $1`, [email]);
  if (known.rows[0]) return String(known.rows[0].id);
  const id = `e2esig-${randomUUID()}`;
  await client.query(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     values ($1, $2, $3, false, now(), now())`,
    [id, login, email],
  );
  await client.query(
    `insert into account (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
     values ($1, $2, 'credential', $2, $3, now(), now())`,
    [randomUUID(), id, await hashPassword(PASSWORD)],
  );
  return id;
}

/**
 * Create three members (owner, signer, outsider), one PDF owned by the owner, shared for reading
 * with the signer, and signature rectangles as the app leaves them (at most one pending request
 * per signer): the owner's own pending one on page 1, an earlier declined request of the signer
 * and a signature by the outsider, who no longer has access, on page 2.
 */
export async function seed() {
  const client = new pg.Client({
    connectionString: env("DATABASE_URL", "postgres://grafito:grafito@127.0.0.1:15432/grafito"),
  });
  await client.connect();
  try {
    /** @type {Record<string, string>} */
    const ids = {};
    for (const login of USERS) {
      ids[login] = await ensureAccount(client, login);
      await client.query(
        `insert into app_user_role (user_id, role_id, login_name) values ($1, 'miembro', $2)
         on conflict (user_id) do update set role_id = 'miembro'`,
        [ids[login], login],
      );
    }
    const owner = ids["e2esig-owner"];
    const signer = ids["e2esig-signer"];
    await client.query(`delete from doc_signature where doc_id like 'e2esig-%'`);
    await client.query(`delete from doc_signature_file where doc_id like 'e2esig-%'`);
    await client.query(`delete from share_item where id like 'e2esig-%'`);
    await client.query(`delete from vault_doc where id like 'e2esig-%'`);

    const bytes = await samplePdf();
    const key = `vault/${owner}/e2esig-${randomUUID()}`;
    const s3 = new AwsClient({
      accessKeyId: env("S3_ACCESS_KEY", "grafito"),
      secretAccessKey: env("S3_SECRET_KEY", "grafito-secret"),
      service: "s3",
      region: env("S3_REGION", "us-east-1"),
    });
    const put = await s3.fetch(
      `${env("S3_ENDPOINT", "http://127.0.0.1:19000")}/${env("S3_BUCKET", "grafito")}/${key}`,
      { method: "PUT", body: bytes, headers: { "content-type": "application/pdf" } },
    );
    if (!put.ok) throw new Error(`upload: ${put.status}`);

    const now = Date.now();
    // The shared tree follows vault_state.revision; documents newer than the cached revision appear.
    const state = await client.query(
      `insert into vault_state (user_id, revision) values ($1, 1)
       on conflict (user_id) do update set revision = vault_state.revision + 1
       returning revision`,
      [owner],
    );
    const rev = Number(state.rows[0].revision);
    const docId = "e2esig-doc";
    const otherId = "e2esig-other";
    await client.query(
      `insert into vault_doc (user_id, id, title, kind, content, file_name, file_mime, file_key,
         file_size, created_at, updated_at, created_by, updated_by, rev)
       values ($1, $2, 'Contrato e2e', 'file', '', 'contrato-e2e.pdf', 'application/pdf', $3,
         $4, $5, $5, $1, $1, $7),
              ($1, $6, 'Otra nota e2e', 'markdown', 'Texto', null, null, null, null, $5, $5, $1, $1, $7)`,
      [owner, docId, key, bytes.length, now, otherId, rev],
    );
    const shareId = "e2esig-share";
    const otherShare = "e2esig-share-other";
    await client.query(
      `insert into share_item (id, owner_id, kind, target_id, title, visibility, access)
       values ($1, $2, 'document', $3, 'Contrato e2e', 'shared', 'read'),
              ($4, $2, 'document', $5, 'Otra nota e2e', 'shared', 'read')`,
      [shareId, owner, docId, otherShare, otherId],
    );
    await client.query(
      `insert into share_grant (share_id, user_id, granted_at) values ($1, $3, $4), ($2, $3, $4)`,
      [shareId, otherShare, signer, now],
    );
    const outsider = ids["e2esig-outsider"];
    const boxes = [
      ["e2esig-owner-box", owner, "e2esig-owner", "pending", 1, 0.55, 0.1, 0.3, 0.1],
      ["e2esig-signed", outsider, "e2esig-outsider", "signed", 2, 0.1, 0.2, 0.3, 0.1],
      ["e2esig-declined", signer, "e2esig-signer", "declined", 2, 0.5, 0.5, 0.3, 0.1],
    ];
    for (const [id, who, name, status, page, x, y, w, h] of boxes) {
      await client.query(
        `insert into doc_signature (id, owner_id, doc_id, signer_id, signer_name, status,
           requested_by, requested_by_name, requested_at, decided_at, page, box_x, box_y, box_w, box_h)
         values ($1, $2, $3, $4, $5, $6, $2, 'e2esig-owner', $7, $8, $9, $10, $11, $12, $13)`,
        [
          id,
          owner,
          docId,
          who,
          name,
          status,
          now,
          status === "pending" ? null : now,
          page,
          x,
          y,
          w,
          h,
        ],
      );
    }
    return { ids, docId, otherId, shareId, otherShare, boxes };
  } finally {
    await client.end();
  }
}
