/**
 * LDAP and OIDC SSO sign-in in a real browser against the local test stack started with the
 * auth-test profile (OpenLDAP and Keycloak with dev/auth-test/). Checks the Better Auth upgrade:
 * the SSO provider now goes through signIn.social and /callback/sso, and the old
 * /oauth2/callback/sso address still works. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:8080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   node --test tests/e2e/auth-providers.e2e.mjs
 *
 * It writes the ldap and sso rows of auth_provider and removes them, with the accounts it made.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import pg from "pg";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const playwright = await import(process.env.E2E_PLAYWRIGHT ?? "playwright");
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://grafito:grafito@127.0.0.1:5432/grafito";
const WAIT = 60_000;

async function query(text, values = []) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

const LDAP = {
  url: "ldap://openldap:389",
  bindDn: "cn=admin,dc=grafito,dc=test",
  bindPassword: "grafito-ldap",
  baseDn: "ou=people,dc=grafito,dc=test",
  userFilter: "(uid={{username}})",
  nameAttr: "cn",
  emailAttr: "mail",
  startTls: false,
  allowInsecureTls: false,
};
const SSO = {
  label: "Keycloak",
  issuer: "http://keycloak:8080/realms/grafito",
  clientId: "grafito",
  clientSecret: "grafito-sso-secret",
  scopes: "openid profile email",
};
const EMAILS = ["carla@empresa.test", "sofia@empresa.test"];

async function forgetAccounts() {
  await query(`delete from "user" where email = any($1)`, [EMAILS]);
}

describe("external sign-in after the Better Auth upgrade", () => {
  let browser;
  let saved = [];
  before(async () => {
    saved = await query(`select * from auth_provider where id in ('ldap', 'sso')`);
    await forgetAccounts();
    for (const [id, config] of [
      ["ldap", LDAP],
      ["sso", SSO],
    ])
      await query(
        `insert into auth_provider (id, enabled, config, allowed_domains, updated_at)
         values ($1, true, $2, 'empresa.test', now())
         on conflict (id) do update set enabled = true, config = excluded.config,
           allowed_domains = excluded.allowed_domains, updated_at = now()`,
        [id, JSON.stringify(config)],
      );
    browser = await playwright.chromium.launch({ channel: process.env.E2E_CHANNEL ?? "chrome" });
  });
  after(async () => {
    await browser?.close();
    await forgetAccounts();
    await query(`delete from auth_provider where id in ('ldap', 'sso')`);
    for (const row of saved)
      await query(
        `insert into auth_provider (id, enabled, config, default_role, allowed_domains, updated_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [row.id, row.enabled, row.config, row.default_role, row.allowed_domains, row.updated_at],
      );
  });

  async function loginPage() {
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(WAIT);
    // The provider list is read again every few seconds.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await page.goto(`${base}/login`);
      if (await page.getByRole("button", { name: /Keycloak/ }).count()) break;
      await page.waitForTimeout(2000);
    }
    return page;
  }

  test("LDAP: carla signs in from the directory tab", async () => {
    const page = await loginPage();
    await page.getByRole("tab", { name: "Directorio (LDAP)" }).click();
    await page.getByLabel("Usuario").fill("carla");
    await page.getByLabel("Contraseña").fill("Carla-Ldap-2026");
    await page.locator("form button[type=submit]").click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"));
    const rows = await query(
      `select r.source from "user" u join app_user_role r on r.user_id = u.id where u.email = $1`,
      ["carla@empresa.test"],
    );
    assert.equal(rows[0]?.source, "ldap");
    await page.context().close();
  });

  test("SSO: sofia signs in through Keycloak and comes back signed in", async () => {
    const page = await loginPage();
    await page.getByRole("button", { name: /Keycloak/ }).click();
    await page.waitForURL(/127\.0\.0\.1:8180/);
    await page.locator("#username").fill("sofia");
    await page.locator("#password").fill("Sofia-Sso-2026");
    await page.locator("#kc-login").click();
    await page.waitForURL(
      (url) => url.host === new URL(base).host && !url.pathname.startsWith("/login"),
    );
    const rows = await query(
      `select r.source from "user" u join app_user_role r on r.user_id = u.id where u.email = $1`,
      ["sofia@empresa.test"],
    );
    assert.equal(rows[0]?.source, "sso");
    await page.context().close();
  });

  test("SSO: the callback address of older setups reaches the new one", async () => {
    const response = await fetch(`${base}/api/auth/oauth2/callback/sso?error=access_denied`, {
      redirect: "manual",
    });
    // Handled by Better Auth's callback (a redirect back with the error), not a 404.
    assert.notEqual(response.status, 404);
    assert.ok([302, 303, 307].includes(response.status), String(response.status));
  });
});
