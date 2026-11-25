/**
 * The trash (T13–T21) in a real browser against the local test stack (project grafito-e2e):
 * deleting one or several documents and a nested portfolio, a reload, restoring a document and
 * a portfolio, deleting while a synchronization is held, two sessions of the same person, and
 * restarting the app container. Not part of `npm test`.
 *
 *   E2E_BASE_URL=http://127.0.0.1:18080 \
 *   E2E_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
 *   E2E_COMPOSE="docker compose -p grafito-e2e -f docker-compose.test.yml" \
 *   node --test tests/e2e/trash.e2e.mjs
 *
 * Each run creates fresh "e2etr-" members. T21 restarts the test stack's app container.
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import {
  base,
  destination,
  dropTree,
  engines,
  gate,
  jobEnds,
  member,
  pdf,
  playwright,
  query,
  signIn,
  until,
} from "./vault-harness.mjs";

const COMPOSE =
  process.env.E2E_COMPOSE ?? "docker compose -p grafito-e2e -f docker-compose.test.yml";

/** A destination of person holding Obra/{planos/[p1,p2], a1, a2} and two loose notes. */
async function stocked(browser, person) {
  const who = await destination(person);
  const session = await signIn(browser, who);
  const bytes = await pdf("papelera");
  await dropTree(session.page, who.dest, {
    Obra: {
      folder: {
        planos: { folder: { "p1.pdf": { file: [0, bytes] }, "p2.pdf": { file: [0, bytes] } } },
        "a1.pdf": { file: [0, bytes] },
        "a2.pdf": { file: [0, bytes] },
      },
    },
    "suelta-1.md": { file: [0, Buffer.from("# Uno").toString("base64")] },
    "suelta-2.md": { file: [0, Buffer.from("# Dos").toString("base64")] },
  });
  await jobEnds(session.page);
  const ids = Object.fromEntries(
    (
      await query(
        `with recursive tree(id) as (
           select id from vault_portfolio where user_id = $1 and id = $2
           union all
           select p.id from vault_portfolio p join tree t on p.parent_id = t.id where p.user_id = $1
         )
         select d.id, d.title from vault_doc d join tree t on d.portfolio_id = t.id
         where d.user_id = $1 and not d.deleted
         union all
         select p.id, p.name from vault_portfolio p join tree t on p.id = t.id where p.user_id = $1`,
        [who.userId, who.dest],
      )
    )
      // Note titles are unique across the vault ("suelta-1 2" in a later test): keyed without it.
      .map((row) => [row.title.replace(/ \d+$/, ""), row.id]),
  );
  return { who, ...session, ids };
}

/** Pick sidebar rows with Ctrl+click, press Delete and confirm. */
async function deleteRows(page, keys) {
  for (const key of keys)
    await page
      .locator(`[data-ui="sidebar"] [data-pick="${key}"]`)
      .first()
      .click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click();
}

async function openTrash(page) {
  await page.locator('[data-ui="sidebar"]').getByRole("button", { name: "Papelera" }).click();
  await page.locator('[data-ui="trash"]').waitFor();
}

function trashRows(page) {
  return page.locator("[data-trash-row]");
}

/** The trash row of one document or portfolio. */
function row(page, id) {
  return page.locator(`[data-trash-row][data-trash-id="${id}"]`);
}

async function trashCount(page) {
  await page.locator('[data-ui="trash-list"]').waitFor();
  return trashRows(page).count();
}

async function deletedOnServer(userId, ids) {
  const rows = await query(
    `select id from vault_doc where user_id = $1 and deleted and deleted_at is not null and id = any($2)
     union all
     select id from vault_portfolio where user_id = $1 and deleted and deleted_at is not null and id = any($2)`,
    [userId, ids],
  );
  return rows.length;
}

for (const engine of engines) {
  describe(`trash (${engine})`, () => {
    let browser;
    let person;
    before(async () => {
      person = await member("e2etr");
      browser = await playwright[engine].launch();
    });
    after(async () => {
      await browser?.close();
    });

    test("T13/T14/T16 one and several documents: in the trash at once, still there after a reload", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      await openTrash(page);
      await deleteRows(page, [`doc:${ids["suelta-1"]}`]);
      // The open trash shows it as soon as the server confirms; no reload, no restart.
      await row(page, ids["suelta-1"]).waitFor();
      await deleteRows(page, [`doc:${ids.a1}`, `doc:${ids.a2}`, `doc:${ids["suelta-2"]}`]);
      for (const title of ["a1", "a2", "suelta-2"]) await row(page, ids[title]).waitFor();
      assert.equal(await page.locator('[data-ui="trash-pending"]').count(), 0, "nothing pending");
      assert.equal(
        await deletedOnServer(who.userId, [ids["suelta-1"], ids.a1, ids.a2, ids["suelta-2"]]),
        4,
      );
      await page.reload();
      await openTrash(page);
      await page.locator('[data-ui="trash-list"]').waitFor();
      for (const title of ["suelta-1", "a1", "a2", "suelta-2"])
        assert.equal(await row(page, ids[title]).count(), 1, `${title} after reload`);
      assert.equal(
        await page.locator(`[data-pick="doc:${ids.a1}"]`).count(),
        0,
        "gone from the tree",
      );
      await context.close();
    });

    test("T16b a copy of the vault saved before the deletion does not bring it back", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      // The browser's copy as it was before deleting, as a reload can still read it (Firefox
      // may not have written the newer one yet when the next page starts).
      const key = `grafito.v2:${who.userId}`;
      const stale = await page.evaluate((name) => localStorage.getItem(name), key);
      assert.ok(stale?.includes(ids.a1), "the copy holds a1");
      await deleteRows(page, [`doc:${ids.a1}`, `port:${ids.planos}`]);
      await until(
        async () => (await deletedOnServer(who.userId, [ids.a1, ids.planos])) === 2,
        "deleted",
      );
      await context.addInitScript(
        ({ name, value }) => {
          if (sessionStorage.getItem("stale-copy")) return;
          sessionStorage.setItem("stale-copy", "1");
          localStorage.setItem(name, value);
        },
        { name: key, value: stale },
      );
      await page.reload();
      await openTrash(page);
      await row(page, ids.a1).waitFor();
      await row(page, ids.planos).waitFor();
      await page.locator(`[data-pick="doc:${ids.a1}"]`).waitFor({ state: "detached" });
      assert.equal(await deletedOnServer(who.userId, [ids.a1, ids.planos, ids.p1, ids.p2]), 4);
      await context.close();
    });

    test("T15/T18 a nested portfolio goes as one entry and comes back whole; an earlier deletion stays", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      await openTrash(page);
      // p1 is deleted on its own first, then the whole portfolio.
      await deleteRows(page, [`doc:${ids.p1}`]);
      await row(page, ids.p1).waitFor();
      await deleteRows(page, [`port:${ids.Obra}`]);
      const entry = row(page, ids.Obra);
      await entry.waitFor();
      assert.equal(await row(page, ids.planos).count(), 0, "inside Obra");
      assert.ok(await row(page, ids.p1).count(), "p1 keeps its own entry");
      await entry.click();
      await page.getByRole("button", { name: "Recuperar 1" }).click();
      await page.locator(`[data-ui="sidebar"] [data-pick="port:${ids.Obra}"]`).waitFor();
      const back = await query(
        `select id from vault_doc where user_id = $1 and not deleted and id = any($2)`,
        [who.userId, [ids.a1, ids.a2, ids.p2]],
      );
      assert.equal(back.length, 3, "a1, a2 and p2 restored with Obra");
      const planos = await query(
        `select parent_id from vault_portfolio where user_id = $1 and id = $2 and not deleted`,
        [who.userId, ids.planos],
      );
      assert.equal(planos[0]?.parent_id, ids.Obra, "planos back inside Obra");
      assert.ok(await row(page, ids.p1).count(), "p1 still in the trash");
      await context.close();
    });

    test("T17b links other items had to what was deleted come back with it", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      // a1 links to p1 and Obra links to planos (manual links, as the link dialog writes them).
      const state = await query(
        `update vault_state set revision = revision + 1 where user_id = $1 returning revision`,
        [who.userId],
      );
      const rev = Number(state[0].revision);
      const toDoc = { targetId: ids.p1, kind: "referencia" };
      const toFolder = { targetId: ids.planos, kind: "referencia", target: "portfolio" };
      await query(`update vault_doc set links_json = $3, rev = $4 where user_id = $1 and id = $2`, [
        who.userId,
        ids.a1,
        JSON.stringify([toDoc]),
        rev,
      ]);
      await query(
        `update vault_portfolio set links_json = $3, rev = $4 where user_id = $1 and id = $2`,
        [who.userId, ids.Obra, JSON.stringify([toFolder]), rev],
      );
      await page.reload();
      await openTrash(page);
      const links = async (table, id) =>
        JSON.parse(
          (
            await query(`select links_json from ${table} where user_id = $1 and id = $2`, [
              who.userId,
              id,
            ])
          )[0].links_json,
        );
      await deleteRows(page, [`port:${ids.planos}`]);
      await row(page, ids.planos).waitFor();
      // Taken out of their sources while their targets are in the trash, and kept.
      await until(async () => (await links("vault_doc", ids.a1)).length === 0, "a1 link detached");
      assert.deepEqual(await links("vault_portfolio", ids.Obra), []);
      await row(page, ids.planos).click();
      await page.getByRole("button", { name: "Recuperar 1" }).click();
      await page.locator(`[data-ui="sidebar"] [data-pick="port:${ids.planos}"]`).waitFor();
      assert.deepEqual(await links("vault_doc", ids.a1), [toDoc]);
      assert.deepEqual(await links("vault_portfolio", ids.Obra), [toFolder]);
      const kept = await query(`select count(*)::int as n from trash_link where user_id = $1`, [
        who.userId,
      ]);
      assert.equal(kept[0].n, 0, "nothing left waiting");
      // The browser has them too.
      await until(
        () =>
          page.evaluate(
            ({ key, id, target }) =>
              JSON.parse(localStorage.getItem(key) ?? "{}")
                .documents?.find((doc) => doc.id === id)
                ?.links?.some((link) => link.targetId === target) ?? false,
            { key: `grafito.v2:${who.userId}`, id: ids.a1, target: ids.p1 },
          ),
        "browser copy has the link again",
      );
      await context.close();
    });

    test("T17 restoring a document brings back its folder, title and file", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      await openTrash(page);
      await deleteRows(page, [`doc:${ids.p2}`]);
      const deleted = row(page, ids.p2);
      await deleted.waitFor();
      await deleted.click();
      await page.getByRole("button", { name: "Recuperar 1" }).click();
      await page.locator(`[data-ui="sidebar"] [data-pick="doc:${ids.p2}"]`).waitFor();
      const doc = await query(
        `select title, portfolio_id, file_key, deleted from vault_doc where user_id = $1 and id = $2`,
        [who.userId, ids.p2],
      );
      assert.equal(doc[0].deleted, false);
      assert.equal(doc[0].portfolio_id, ids.planos);
      assert.equal(doc[0].title, "p2");
      assert.ok(doc[0].file_key);
      await context.close();
    });

    test("T19 deleted while a synchronization is held: pending, then confirmed", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      await openTrash(page);
      // Hold every pull: the synchronization that would send the deletion waits behind it.
      const pulls = await gate(page, "**/_serverFn/**", { pass: 0 });
      await deleteRows(page, [`doc:${ids["suelta-1"]}`]);
      await page.locator('[data-ui="trash-pending"][data-state="pending"]').waitFor();
      assert.equal(
        await deletedOnServer(who.userId, [ids["suelta-1"]]),
        0,
        "not yet on the server",
      );
      await pulls.close();
      await row(page, ids["suelta-1"]).waitFor();
      await until(
        async () => (await page.locator('[data-ui="trash-pending"]').count()) === 0,
        "confirmed",
      );
      assert.equal(await deletedOnServer(who.userId, [ids["suelta-1"]]), 1);
      await context.close();
    });

    test("T20 two sessions of the same person converge, and neither brings the item back", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      const other = await signIn(browser, who, { fresh: true });
      await other.page.locator(`[data-pick="doc:${ids.a2}"]`).first().waitFor();
      await deleteRows(page, [`doc:${ids.a2}`]);
      await until(async () => (await deletedOnServer(who.userId, [ids.a2])) === 1, "deleted");
      // The second session synchronizes when it comes back to the foreground.
      await other.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await other.page.locator(`[data-pick="doc:${ids.a2}"]`).waitFor({ state: "detached" });
      await openTrash(other.page);
      await row(other.page, ids.a2).waitFor();
      await other.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      assert.equal(await deletedOnServer(who.userId, [ids.a2]), 1, "still deleted");
      await other.context.close();
      await context.close();
    });

    test("T21 after restarting the app container the trash is the same, without restarting again", async () => {
      const { who, context, page, ids } = await stocked(browser, person);
      await openTrash(page);
      await deleteRows(page, [`doc:${ids.a1}`, `port:${ids.planos}`]);
      await row(page, ids.planos).waitFor();
      const before = await trashCount(page);
      execSync(`${COMPOSE} restart app`, { stdio: "ignore" });
      await until(async () => {
        try {
          return (await fetch(`${base}/login`)).ok;
        } catch {
          return false;
        }
      }, "app back");
      await page.reload();
      await openTrash(page);
      assert.equal(await trashCount(page), before);
      assert.equal(await deletedOnServer(who.userId, [ids.a1, ids.planos]), 2);
      await context.close();
    });
  });
}
