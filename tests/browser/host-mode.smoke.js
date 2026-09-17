// Host-mode browser smoke test. Not a `node --test` file (no ".test." in the name):
// it drives the real page in headless Chromium and exits non-zero on any failure.
//
// Run inside the dev-env container, with the static server already up:
//   cd /workspace/projects/rnmb-command-center && python3 -m http.server 3000
//   PLAYWRIGHT_BROWSERS_PATH=/workspace/tools/playwright/browsers \
//     node /workspace/projects/rnmb-command-center/tests/browser/host-mode.smoke.js [baseUrl]
//
// Adding scenarios (U4-U7): push { name, run } onto `scenarios` below. `run`
// receives { browser, baseUrl } and should open its page with openPage(), which
// gives a fresh browser context (empty localStorage, so the demo data loads),
// auto-accepts confirm() dialogs, records every toast, and fails the scenario on
// any console error or uncaught page error not explicitly allowed.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("/workspace/tools/playwright/node_modules/playwright");

const baseUrl = (process.argv[2] || process.env.RNMB_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// ---------- helpers ------------------------------------------------------------

/** Chrome logs every non-2xx fetch as a console error; allow the ones a scenario expects. */
function resourceStatusError(message, status, urlTest) {
  return message.type() === "error" &&
    message.text().includes(`status of ${status}`) &&
    urlTest(message.location().url || "");
}

async function openPage(browser, options = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: options.viewport || { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  const problems = [];
  const allowConsole = options.allowConsole || (() => false);

  page.on("console", (message) => {
    if (message.type() === "error" && !allowConsole(message)) {
      problems.push(`console error: ${message.text()} (${message.location().url || "no url"})`);
    }
  });
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  page.on("dialog", (dialog) => dialog.accept());

  // Every toast the page shows, in order, so a brief "Save failed" cannot slip by.
  await page.addInitScript(() => {
    window.__toasts = [];
    document.addEventListener("DOMContentLoaded", () => {
      const toast = document.querySelector("#toast");
      if (!toast) return;
      new MutationObserver(() => window.__toasts.push(toast.textContent)).observe(toast, { childList: true, characterData: true, subtree: true });
    });
  });

  if (options.routes) await options.routes(page);
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__rnmb && window.__toasts && window.__toasts.length > 0, null, { timeout: 15000 });

  return {
    page,
    toasts: () => page.evaluate(() => window.__toasts.slice()),
    waitForToast: (text) => page.waitForFunction((expected) => window.__toasts.includes(expected), text, { timeout: 10000 }),
    assertClean() {
      assert.deepEqual(problems, [], `page reported problems:\n${problems.join("\n")}`);
    },
    close: () => context.close()
  };
}

// ---------- scenarios ------------------------------------------------------------

const HOST_COLLECTIONS = ["menuItems", "guestTabs", "ringUps", "stockAdjustments"];
const apiConfig404 = (message) => resourceStatusError(message, 404, (url) => url.endsWith("/api/config"));

/** Start a host night and open one guest tab through the local repository. */
async function startLocalHostNightWithTab(page) {
  return page.evaluate(async () => {
    const r = window.__rnmb;
    const nightId = crypto.randomUUID();
    const tabId = crypto.randomUUID();
    const started = await r.hostAction("Host night started.", (db) => db.startHostNight({ id: nightId, name: "Smoke host night" }));
    const opened = await r.hostAction("Tab opened.", (db) => db.openTab({ id: tabId, nightId, guestName: "Riley" }));
    return { nightId, tabId, started, opened };
  });
}

const scenarios = [
  {
    name: "U3 local boot with no /api/config, Reload demo, Export carries every host-mode collection",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        assert.equal(await page.evaluate(() => window.__rnmb.syncMode), "local");
        assert.equal(await page.textContent("#syncStatus"), "Local browser storage");

        await page.click('.tab-button[data-tab="crew"]');
        const backup = page.waitForEvent("download");
        await page.click("#seedData");
        await backup;
        await session.waitForToast("Demo data reloaded.");

        const downloadPromise = page.waitForEvent("download");
        await page.click("#exportData");
        const download = await downloadPromise;
        const archive = JSON.parse(fs.readFileSync(await download.path(), "utf8"));

        HOST_COLLECTIONS.forEach((key) => assert.ok(Array.isArray(archive[key]), `archive.${key} is a list`));
        ["people", "types", "bottles", "nights"].forEach((key) => assert.ok(Array.isArray(archive[key]), `archive.${key} is a list`));
        assert.equal(typeof archive.markupPercent, "number");
        assert.equal(typeof archive.roundingIncrementCents, "number");
        assert.ok(archive.menuItems.length > 0, "demo data includes a menu");
        assert.ok(archive.menuItems.every((item) => Array.isArray(item.ingredients) && item.ingredients.length > 0));
        assert.ok(archive.bottles.every((bottle) => "size" in bottle && "remaining" in bottle && !("sizeOz" in bottle)));
        assert.ok(archive.nights.every((night) => night.kind === "crew" && night.endedAt === null));
        assert.deepEqual(archive, await page.evaluate(() => window.__rnmb.archiveData()));

        // The existing tabs still render the renamed bottle fields.
        await page.click('.tab-button[data-tab="inventory"]');
        assert.match(await page.textContent("#inventoryList"), /19\.2 of 25\.4 oz/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U3 local repository ring-up then void returns stock and tab total to their start",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { nightId, tabId, started, opened } = await startLocalHostNightWithTab(page);
        assert.equal(started, true);
        assert.equal(opened, true);

        const result = await page.evaluate(async ({ nightId, tabId }) => {
          const r = window.__rnmb;
          const D = window.RNMBDomain;
          const stock = () => Object.fromEntries(r.state.bottles.map((bottle) => [bottle.id, bottle.remaining]));
          const item = r.state.menuItems.find((entry) => entry.name === "Boilermaker");
          const sources = D.preselectSources(item, r.state.bottles).flatMap((ingredient) => ingredient.sources);
          const before = { stock: stock(), total: D.tabTotalCents(tabId, r.state.ringUps) };
          const record = r.buildRingUp({ nightId, kind: "guest", tabId, menuItemId: item.id, sources });
          const rang = await r.hostAction("Rung up.", (db) => db.ringUp(record));
          const middle = { stock: stock(), total: D.tabTotalCents(tabId, r.state.ringUps) };
          const voided = await r.hostAction("Voided.", (db) => db.voidRingUp(record.id));
          const after = { stock: stock(), total: D.tabTotalCents(tabId, r.state.ringUps) };
          const stored = JSON.parse(localStorage.getItem("rnmb-command-center-v1"));
          return { sources, record, rang, voided, before, middle, after, saved: r.state.ringUps[0], storedRingUps: stored.ringUps };
        }, { nightId, tabId });

        assert.equal(result.rang, true);
        assert.equal(result.voided, true);
        assert.equal(result.before.total, 0);
        assert.ok(result.record.priceCents > 0, "the drink has a price");
        assert.equal(result.middle.total, result.record.priceCents);
        result.sources.forEach((source) => {
          assert.equal(
            Math.round((result.before.stock[source.bottleId] - result.middle.stock[source.bottleId]) * 1e6) / 1e6,
            source.amount,
            "the ring-up deducts each source amount"
          );
        });
        assert.deepEqual(result.after.stock, result.before.stock);
        assert.equal(result.after.total, 0);
        assert.equal(result.saved.menuItemName, "Boilermaker");
        assert.ok(result.saved.voidedAt, "the ring-up is voided, not deleted");
        assert.ok(result.saved.lines.every((line) => line.buyerName && line.shareCents >= 0));
        assert.equal(result.storedRingUps.length, 1, "localStorage holds the ring-up");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U3 local repository refuses a ring-up that exceeds stock and leaves state unchanged",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { nightId, tabId } = await startLocalHostNightWithTab(page);
        const result = await page.evaluate(async ({ nightId, tabId }) => {
          const r = window.__rnmb;
          const item = r.state.menuItems.find((entry) => entry.name === "Bourbon Neat");
          const bourbon = r.state.bottles.find((bottle) => bottle.typeId === item.ingredients[0].typeId);
          const beforeState = JSON.stringify(r.state);
          const beforeStored = localStorage.getItem("rnmb-command-center-v1");
          const record = r.buildRingUp({ nightId, kind: "guest", tabId, menuItemId: item.id, sources: [{ bottleId: bourbon.id, amount: 50 }] });
          let message = null;
          try {
            await r.repository.ringUp(record);
          } catch (error) {
            message = error.userMessage;
          }
          const unchangedAfterRepository = JSON.stringify(r.state) === beforeState;
          const viaAction = await r.hostAction("Rung up.", (db) => db.ringUp(record));
          return {
            message,
            unchangedAfterRepository,
            viaAction,
            unchangedAfterAction: JSON.stringify(r.state) === beforeState,
            storedUnchanged: localStorage.getItem("rnmb-command-center-v1") === beforeStored
          };
        }, { nightId, tabId });

        assert.match(result.message || "", /Not enough left in The Briefing Bottle/);
        assert.equal(result.unchangedAfterRepository, true);
        assert.equal(result.viaAction, false);
        assert.equal(result.unchangedAfterAction, true);
        assert.equal(result.storedUnchanged, true);
        await session.waitForToast(result.message);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U3 local repository refuses host nights that were not started in this browser (KTD9)",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const result = await page.evaluate(async () => {
          const r = window.__rnmb;
          // A shared-database host night cached in localStorage has no local mark.
          const nightId = crypto.randomUUID();
          r.state.nights.push(window.RNMBDomain.normalizeNight({ id: nightId, name: "Shared party", date: "2026-09-16", kind: "host" }));
          const before = JSON.stringify(r.state);
          let message = null;
          try {
            await r.repository.openTab({ id: crypto.randomUUID(), nightId, guestName: "Riley" });
          } catch (error) {
            message = error.userMessage;
          }
          return { message, unchanged: JSON.stringify(r.state) === before };
        });
        assert.match(result.message || "", /not connected/);
        assert.equal(result.unchanged, true);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U3 pre-migration database: add a type, start a night, switch nights with no new columns sent",
    async run({ browser }) {
      const NEW_TABLES = ["rnmb_menu_items", "rnmb_recipe_ingredients", "rnmb_guest_tabs", "rnmb_ring_ups", "rnmb_ring_up_lines", "rnmb_stock_adjustments"];
      const NEW_COLUMNS = /"(measure|unit_oz|kind|ended_at|markup_percent|rounding_increment_cents)"\s*:/;
      const store = {
        rnmb_people: [], rnmb_beverage_types: [], rnmb_bottles: [], rnmb_nights: [], rnmb_pours: [],
        rnmb_settings: [{ id: true, active_night_id: null, responsible_mode: true }]
      };
      const served400 = [];
      const unexpected = [];
      const writes = [];

      const routes = async (page) => {
        await page.route("**/api/config", (route) => route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ enabled: true, supabaseUrl: `${baseUrl}/stub-supabase`, supabaseAnonKey: "stub-key" })
        }));
        await page.route("**/stub-supabase/rest/v1/**", (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const path = url.pathname.replace(/^.*\/rest\/v1\//, "");
          const method = request.method();
          const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

          if (path === "rpc/rnmb_authorized") return json(200, true);
          if (path.startsWith("rpc/")) {
            unexpected.push(`${method} ${path}`);
            return json(404, { code: "PGRST202", message: "function not found" });
          }
          if (NEW_TABLES.includes(path)) {
            return json(404, { code: "PGRST205", message: `Could not find the table 'public.${path}' in the schema cache` });
          }
          if (!(path in store)) {
            unexpected.push(`${method} ${path}`);
            return json(404, { code: "PGRST205", message: "unknown table" });
          }
          if (method === "GET") return json(200, store[path]);

          const body = request.postData() || "";
          if (NEW_COLUMNS.test(body)) {
            served400.push(`${method} ${path} ${body}`);
            return json(400, { code: "PGRST204", message: "Could not find a new column in the schema cache" });
          }
          if (method === "POST") {
            const rows = JSON.parse(body);
            writes.push({ table: path, rows });
            if (path === "rnmb_settings") store.rnmb_settings = rows;
            else store[path].push(...rows);
            return route.fulfill({ status: 201, body: "" });
          }
          if (method === "PATCH") {
            writes.push({ table: path, rows: [JSON.parse(body)] });
            if (path === "rnmb_settings") Object.assign(store.rnmb_settings[0], JSON.parse(body));
            return route.fulfill({ status: 204, body: "" });
          }
          unexpected.push(`${method} ${path}`);
          return route.fulfill({ status: 204, body: "" });
        });
      };

      const expected404 = (message) => resourceStatusError(message, 404, (url) => NEW_TABLES.some((table) => url.includes(`/rest/v1/${table}?`)));
      const session = await openPage(browser, { routes, allowConsole: expected404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.syncMode), "supabase");
        assert.equal(await page.evaluate(() => window.__rnmb.hostModeAvailable), false);

        await page.click('.tab-button[data-tab="inventory"]');
        await page.fill("#typeForm [name='name']", "Smoke Rum");
        await page.selectOption("#typeForm [name='category']", "Rum");
        await page.fill("#typeForm [name='abv']", "40");
        await page.click("#typeForm button[type='submit']");
        await session.waitForToast("Beverage type added.");

        await page.click('.tab-button[data-tab="tonight"]');
        await page.fill("#nightForm [name='name']", "Smoke Night One");
        await page.click("#nightForm button[type='submit']");
        await session.waitForToast("Night log started.");
        await page.fill("#nightForm [name='name']", "Smoke Night Two");
        const toastsBefore = (await session.toasts()).length;
        await page.click("#nightForm button[type='submit']");
        await page.waitForFunction((count) => window.__toasts.length > count && window.__toasts.at(-1) === "Night log started.", toastsBefore);

        const firstNightId = store.rnmb_nights[0].id;
        await page.selectOption("#nightSelect", firstNightId);
        await session.waitForToast("Active night switched.");
        assert.equal(store.rnmb_settings[0].active_night_id, firstNightId);

        const toasts = await session.toasts();
        assert.ok(!toasts.some((text) => /Save failed/.test(text)), `no failed save, saw: ${toasts.join(" | ")}`);
        assert.deepEqual(served400, [], "no payload carried a host-mode column");
        assert.deepEqual(unexpected, [], "no unexpected request");
        assert.deepEqual(Object.keys(store.rnmb_beverage_types[0]), ["id", "name", "category", "abv"]);
        store.rnmb_nights.forEach((night) => assert.deepEqual(Object.keys(night), ["id", "name", "date"]));
        assert.deepEqual(Object.keys(store.rnmb_settings[0]), ["id", "active_night_id", "responsible_mode"]);
        assert.ok(writes.length >= 5, "the forms really wrote to the stub");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  }
];

// ---------- runner ---------------------------------------------------------------

async function main() {
  const browser = await chromium.launch();
  let failures = 0;
  try {
    for (const scenario of scenarios) {
      try {
        await scenario.run({ browser, baseUrl });
        console.log(`PASS ${scenario.name}`);
      } catch (error) {
        failures += 1;
        console.log(`FAIL ${scenario.name}\n  ${String(error && error.stack || error).split("\n").join("\n  ")}`);
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`\n${scenarios.length - failures} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

module.exports = { scenarios, openPage, resourceStatusError, startLocalHostNightWithTab };

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
