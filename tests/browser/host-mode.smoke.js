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

const SOLD_BOTTLE_MESSAGE = "Drinks have been sold from this stock item, so it cannot be deleted. Set its remaining level to empty instead.";

/** Click, then wait for a toast shown after the click (a repeated message cannot match an earlier one). */
async function clickForToast(session, selector, text) {
  const { page } = session;
  const count = (await session.toasts()).length;
  await page.click(selector);
  await page.waitForFunction(
    ({ count, text }) => window.__toasts.slice(count).includes(text),
    { count, text },
    { timeout: 10000 }
  );
}

/** Add a beverage type through the Inventory tab's Add Type form; returns the saved type. */
async function addTypeViaForm(session, { name, category, measure = "oz", abv, unitOz }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="inventory"]');
  await page.fill("#typeForm [name='name']", name);
  await page.selectOption("#typeForm [name='category']", category);
  await page.selectOption("#typeForm [name='measure']", measure);
  if (unitOz !== undefined) await page.fill("#typeForm [name='unitOz']", String(unitOz));
  await page.fill("#typeForm [name='abv']", String(abv));
  await clickForToast(session, "#typeForm button[type='submit']", "Beverage type added.");
  const type = await page.evaluate((typeName) => window.__rnmb.state.types.find((entry) => entry.name === typeName), name);
  assert.ok(type, `type ${name} was saved`);
  return type;
}

/** Add stock through the Add Stock form; returns the saved bottle. Leave size undefined to keep the form's default. */
async function addStockViaForm(session, { typeId, nickname, size }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="inventory"]');
  await page.selectOption("#bottleForm [name='typeId']", typeId);
  await page.fill("#bottleForm [name='nickname']", nickname);
  if (size !== undefined) await page.fill("#bottleForm [name='sizeOz']", String(size));
  await clickForToast(session, "#bottleForm button[type='submit']", "Bottle added to inventory.");
  const bottle = await page.evaluate((name) => window.__rnmb.state.bottles.find((entry) => entry.nickname === name), nickname);
  assert.ok(bottle, `stock ${nickname} was saved`);
  return bottle;
}

/** A counted Lager can type with a case of 12, and a Mixer with a 32 oz bottle, all through the forms. */
async function addCanAndMixer(session) {
  const can = await addTypeViaForm(session, { name: "Lager can", category: "Beer", measure: "unit", unitOz: 12, abv: 5 });
  const canStock = await addStockViaForm(session, { typeId: can.id, nickname: "Can case", size: 12 });
  const mixer = await addTypeViaForm(session, { name: "Lime juice", category: "Mixer", abv: 0 });
  const mixerStock = await addStockViaForm(session, { typeId: mixer.id, nickname: "Lime bottle", size: 32 });
  return { can, canStock, mixer, mixerStock };
}

const cardText = (page, bottleId) => page.textContent(`#inventoryList [data-bottle-id="${bottleId}"]`);

/** Log a crew pour through the Tonight tab's form. */
async function logPourViaForm(session, { personName, bottleId, amount }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  const personId = await page.evaluate((name) => window.__rnmb.state.people.find((person) => person.name === name).id, personName);
  await page.selectOption("#pourForm [name='personId']", personId);
  await page.selectOption("#pourForm [name='bottleId']", bottleId);
  if (amount !== undefined) await page.fill("#pourForm [name='ounces']", String(amount));
  await clickForToast(session, "#pourForm button[type='submit']", "Pour logged.");
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
  },

  {
    name: "U4 a counted type \"Lager can\" (12 oz unit volume) with 12 units of stock shows \"12 of 12 units\"",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.click('.tab-button[data-tab="inventory"]');
        assert.equal(await page.isVisible("#typeUnitOzField"), false, "unit volume is hidden for poured types");
        await page.selectOption("#typeForm [name='measure']", "unit");
        assert.equal(await page.isVisible("#typeUnitOzField"), true, "unit volume shows for counted types");
        await page.selectOption("#typeForm [name='measure']", "oz");

        const can = await addTypeViaForm(session, { name: "Lager can", category: "Beer", measure: "unit", unitOz: 12, abv: 5 });
        assert.equal(can.measure, "unit");
        assert.equal(can.unitOz, 12);
        assert.equal(can.abv, 5);

        await page.selectOption("#bottleForm [name='typeId']", can.id);
        assert.equal((await page.textContent("#bottleSizeLabel")).trim(), "Size units");
        assert.equal(await page.inputValue("#bottleForm [name='sizeOz']"), "12", "counted stock defaults to 12 units");
        assert.equal(await page.getAttribute("#bottleForm [name='sizeOz']", "step"), "1");

        const stock = await addStockViaForm(session, { typeId: can.id, nickname: "Can case", size: 12 });
        assert.equal(stock.size, 12);
        assert.equal(stock.remaining, 12);
        const text = await cardText(page, stock.id);
        assert.match(text, /12 of 12 units/);
        assert.match(text, /12\.0 standard drinks left/, "12 cans x 12 oz x 5% = 12.0 standard drinks");

        // Switching back to a poured type restores the ounce label and default.
        const bourbonId = await page.evaluate(() => window.__rnmb.state.types.find((type) => type.name === "House Bourbon").id);
        await page.selectOption("#bottleForm [name='typeId']", bourbonId);
        assert.equal((await page.textContent("#bottleSizeLabel")).trim(), "Size oz");
        assert.equal(await page.inputValue("#bottleForm [name='sizeOz']"), "25.36");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 a Mixer type with ABV 0 saves and its stock shows no standard drinks",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const drinksBefore = await page.textContent("#metricInventoryMeta");
        const mixer = await addTypeViaForm(session, { name: "Lime juice", category: "Mixer", abv: 0 });
        assert.equal(mixer.abv, 0);
        assert.equal(mixer.category, "Mixer");
        assert.equal(mixer.measure, "oz");
        const stock = await addStockViaForm(session, { typeId: mixer.id, nickname: "Lime bottle", size: 32 });
        const text = await cardText(page, stock.id);
        assert.match(text, /32\.0 of 32\.0 oz/);
        assert.doesNotMatch(text, /standard drink/i);
        assert.match(text, /no alcohol/);
        assert.equal(await page.textContent("#metricInventoryMeta"), drinksBefore, "a mixer adds no standard drinks to the Overview");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 AE5 setting a triple sec bottle from 0.5 to 20 oz updates the card, records one adjustment and makes the margarita available",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const tripleSec = await addTypeViaForm(session, { name: "Triple Sec", category: "Liqueur", abv: 30 });
        const bottle = await addStockViaForm(session, { typeId: tripleSec.id, nickname: "Shelf triple sec" });
        assert.equal(bottle.size, 25.36);

        // The record says 0.5 oz, and a margarita needs 1 oz of triple sec.
        const setup = await page.evaluate(async ({ bottleId, typeId }) => {
          const r = window.__rnmb;
          const low = await r.hostAction("", (db) => db.correctStock({ bottleId, newRemaining: 0.5 }));
          const menu = await r.hostAction("", (db) => db.saveMenuItem({ name: "Margarita", kind: "cocktail", ingredients: [{ typeId, amount: 1 }] }));
          const item = r.state.menuItems.find((entry) => entry.name === "Margarita");
          return { low, menu, available: window.RNMBDomain.menuItemAvailability(item, r.state.bottles).available, adjustments: r.state.stockAdjustments.length };
        }, { bottleId: bottle.id, typeId: tripleSec.id });
        assert.deepEqual(setup, { low: true, menu: true, available: false, adjustments: 1 });
        assert.match(await cardText(page, bottle.id), /0\.5 of 25\.4 oz/);

        const form = `#inventoryList [data-bottle-id="${bottle.id}"] .level-form`;
        assert.equal(await page.inputValue(`${form} input[name='level']`), "0.5", "the control starts at the recorded level");
        await page.fill(`${form} input[name='level']`, "20");
        await clickForToast(session, `${form} button[type='submit']`, "Stock level set.");

        assert.match(await cardText(page, bottle.id), /20\.0 of 25\.4 oz/);
        const after = await page.evaluate((bottleId) => {
          const r = window.__rnmb;
          const item = r.state.menuItems.find((entry) => entry.name === "Margarita");
          return {
            remaining: r.state.bottles.find((entry) => entry.id === bottleId).remaining,
            adjustments: r.state.stockAdjustments.filter((entry) => entry.bottleId === bottleId),
            available: window.RNMBDomain.menuItemAvailability(item, r.state.bottles).available,
            ringUps: r.state.ringUps.length,
            pours: r.state.nights.reduce((sum, night) => sum + night.pours.length, 0)
          };
        }, bottle.id);
        assert.equal(after.remaining, 20);
        assert.equal(after.adjustments.length, 2, "one adjustment for the setup, exactly one for the set-level control");
        assert.equal(after.adjustments[1].previousRemaining, 0.5);
        assert.equal(after.adjustments[1].newRemaining, 20);
        assert.equal(after.available, true, "the margarita becomes available");
        assert.equal(after.ringUps, 0, "a correction is not a sale");
        assert.equal(after.pours, 0, "a correction is not a pour");

        // Setting the level it already has records nothing.
        await page.fill(`${form} input[name='level']`, "20");
        await clickForToast(session, `${form} button[type='submit']`, "That stock item is already at that level.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.stockAdjustments.length), 2);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 removing a bottle a ring-up used shows the refusal toast and the bottle remains",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { nightId, tabId } = await startLocalHostNightWithTab(page);
        const bourbonId = await page.evaluate(async ({ nightId, tabId }) => {
          const r = window.__rnmb;
          const item = r.state.menuItems.find((entry) => entry.name === "Bourbon Neat");
          const bourbon = r.state.bottles.find((bottle) => bottle.typeId === item.ingredients[0].typeId);
          const record = r.buildRingUp({ nightId, kind: "guest", tabId, menuItemId: item.id, sources: [{ bottleId: bourbon.id, amount: 2 }] });
          const rang = await r.hostAction("Rung up.", (db) => db.ringUp(record));
          if (!rang) throw new Error("ring-up failed");
          return bourbon.id;
        }, { nightId, tabId });

        await page.click('.tab-button[data-tab="inventory"]');
        const bottlesBefore = await page.evaluate(() => window.__rnmb.state.bottles.length);
        await clickForToast(session, `#inventoryList [data-bottle-id="${bourbonId}"] [data-remove-bottle]`, SOLD_BOTTLE_MESSAGE);
        const after = await page.evaluate((id) => ({
          count: window.__rnmb.state.bottles.length,
          kept: window.__rnmb.state.bottles.some((bottle) => bottle.id === id)
        }), bourbonId);
        assert.deepEqual(after, { count: bottlesBefore, kept: true });
        assert.equal(await page.locator(`#inventoryList [data-bottle-id="${bourbonId}"]`).count(), 1, "the card is still shown");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 the crew pour form excludes the mixer and, for the can, logs 1 unit and deducts 1 unit",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { canStock, mixerStock } = await addCanAndMixer(session);
        await page.click('.tab-button[data-tab="tonight"]');
        const options = await page.$$eval("#pourForm [name='bottleId'] option", (list) => list.map((option) => option.value));
        assert.ok(!options.includes(mixerStock.id), "the mixer is not offered as a pour");
        assert.ok(options.includes(canStock.id), "the can is offered");

        await page.selectOption("#pourForm [name='bottleId']", canStock.id);
        assert.equal((await page.textContent("#pourAmountLabel")).trim(), "Units consumed");
        assert.equal(await page.getAttribute("#pourForm [name='ounces']", "step"), "1");
        assert.equal(await page.inputValue("#pourForm [name='ounces']"), "1");

        await logPourViaForm(session, { personName: "Alex", bottleId: canStock.id, amount: 1 });
        const result = await page.evaluate((bottleId) => {
          const r = window.__rnmb;
          const night = r.state.nights.find((entry) => entry.id === r.state.activeNightId);
          return { remaining: r.state.bottles.find((bottle) => bottle.id === bottleId).remaining, pours: night.pours };
        }, canStock.id);
        assert.equal(result.remaining, 11);
        assert.equal(result.pours.length, 1);
        assert.equal(result.pours[0].ounces, 1, "the pour is stored in the type's measure (units)");
        assert.equal(result.pours[0].abv, 5);
        assert.match(await page.textContent("#pourTimeline"), /Alex logged 1 unit/);

        await page.click('.tab-button[data-tab="inventory"]');
        assert.match(await cardText(page, canStock.id), /11 of 12 units/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 logging 1 Lager can (12 oz, 5%) adds 1.0 standard drink and 12.0 oz to that person's Tonight card",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { canStock } = await addCanAndMixer(session);
        const bourbonId = await page.evaluate(() => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "The Briefing Bottle").id);
        // A 1.5 oz bourbon pour first, so the can's figures add to an existing total.
        await logPourViaForm(session, { personName: "Jordan", bottleId: bourbonId, amount: 1.5 });
        const card = () => page.locator("#personConsumption .consumption-card", { hasText: "Jordan" }).textContent();
        assert.match(await card(), /1\.5 oz total/);
        assert.match(await card(), /1\.1\b/, "1.5 oz of 45% bourbon is 1.1 standard drinks");

        await logPourViaForm(session, { personName: "Jordan", bottleId: canStock.id, amount: 1 });
        assert.match(await card(), /13\.5 oz total/, "12.0 oz added");
        assert.match(await card(), /2\.1\b/, "1.0 standard drink added");
        assert.match(await page.textContent("#metricConsumed"), /^2\.1$/);
        assert.match(await page.textContent("#pourTimeline"), /Lager can · 1\.0 standard drinks/);
        assert.match(await page.textContent("#recentNights"), /2\.1 standard drinks/);

        await page.click('.tab-button[data-tab="inventory"]');
        assert.match(await cardText(page, canStock.id), /11 of 12 units · 11\.0 standard drinks left/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U4 new stock controls have non-zero bounding boxes at 1440 and 400 widths",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          const { canStock } = await addCanAndMixer(session);
          await page.click('.tab-button[data-tab="inventory"]');
          await page.selectOption("#typeForm [name='measure']", "unit");
          await page.selectOption("#bottleForm [name='typeId']", await page.evaluate((id) => window.__rnmb.state.bottles.find((b) => b.id === id).typeId, canStock.id));
          const selectors = [
            "#typeForm [name='measure']",
            "#typeForm [name='unitOz']",
            "#typeForm [name='abv']",
            "#bottleSizeLabel",
            "#bottleForm [name='sizeOz']"
          ];
          const cards = await page.$$eval("#inventoryList .inventory-card", (list) => list.map((card) => card.dataset.bottleId));
          assert.ok(cards.length >= 5, "every stock item has a card");
          cards.forEach((id) => {
            selectors.push(`#inventoryList [data-bottle-id="${id}"] .level-form input[name='level']`);
            selectors.push(`#inventoryList [data-bottle-id="${id}"] .level-form button[type='submit']`);
            selectors.push(`#inventoryList [data-bottle-id="${id}"] [data-remove-bottle]`);
          });
          for (const selector of selectors) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const box = await page.locator(selector).boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0, `${selector} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
          }
          // The level control stays inside its card.
          const overflow = await page.$$eval("#inventoryList .inventory-card", (list) => list
            .map((card) => {
              const cardBox = card.getBoundingClientRect();
              const button = card.querySelector(".level-form button").getBoundingClientRect();
              return button.right <= cardBox.right + 0.5 ? null : card.dataset.bottleId;
            })
            .filter(Boolean));
          assert.deepEqual(overflow, [], `level controls overflow their cards at ${viewport.width}px`);

          await page.click('.tab-button[data-tab="tonight"]');
          for (const selector of ["#pourAmountLabel", "#pourForm [name='ounces']"]) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const box = await page.locator(selector).boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0, `${selector} has a non-zero box at ${viewport.width}px`);
          }
          session.assertClean();
        } finally {
          await session.close();
        }
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
