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
      // The boot toast can land before this listener runs; record it rather than waiting forever for a change.
      if (toast.textContent) window.__toasts.push(toast.textContent);
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

/**
 * A stub Supabase whose database has never run supabase/host-mode.sql: the
 * host-mode tables answer 404, and any write carrying a host-mode column gets 400.
 */
function preMigrationStub() {
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
        if (method !== "GET") unexpected.push(`${method} ${path}`);
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
  return { store, served400, unexpected, writes, routes, expected404 };
}

const HOST_MODE_SQL_MESSAGE = "Host mode is not set up on the shared database yet. Run supabase/host-mode.sql in Supabase, then reload.";

/** Add priced stock through the Add Stock form, bought by a named crew member. */
async function addPricedStockViaForm(session, { typeId, nickname, size, price, buyerName }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="inventory"]');
  const buyerId = await page.evaluate((name) => window.__rnmb.state.people.find((person) => person.name === name)?.id, buyerName);
  assert.ok(buyerId, `${buyerName} is on the roster`);
  await page.selectOption("#bottleForm [name='buyerId']", buyerId);
  await page.fill("#bottleForm [name='price']", String(price));
  return addStockViaForm(session, { typeId, nickname, size });
}

const menuCard = (page, name) => page.locator("#menuList .menu-card", { hasText: name });
const menuItemCount = (page) => page.evaluate(() => window.__rnmb.state.menuItems.length);

/** Fill ingredient row `index` (0-based) with a type and, unless locked, an amount. */
async function fillIngredientRow(page, index, { typeId, amount }) {
  const row = page.locator("#ingredientRows [data-ingredient-row]").nth(index);
  await row.locator("select[name='ingredientType']").selectOption(typeId);
  if (amount !== undefined) await row.locator("input[name='ingredientAmount']").fill(String(amount));
}

/** Set markup and rounding through the Pricing form. */
async function setPricingViaForm(session, { markupPercent, increment }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="menu"]');
  await page.fill("#pricingForm [name='markupPercent']", String(markupPercent));
  await page.fill("#pricingForm [name='roundingIncrement']", String(increment));
  await clickForToast(session, "#pricingForm button[type='submit']", "Pricing saved.");
}

/** The AE1 stock: tequila (Sam), triple sec (Alex) and lime juice (Jordan), through the forms. */
async function addAe1Stock(session) {
  const tequila = await addTypeViaForm(session, { name: "Tequila", category: "Tequila", abv: 40 });
  const tripleSec = await addTypeViaForm(session, { name: "Triple Sec", category: "Liqueur", abv: 30 });
  const lime = await addTypeViaForm(session, { name: "Lime juice", category: "Mixer", abv: 0 });
  await addPricedStockViaForm(session, { typeId: tequila.id, nickname: "Sam's tequila", size: 25.36, price: 30, buyerName: "Sam" });
  await addPricedStockViaForm(session, { typeId: tripleSec.id, nickname: "Alex's triple sec", size: 25.36, price: 20, buyerName: "Alex" });
  await addPricedStockViaForm(session, { typeId: lime.id, nickname: "Jordan's lime", size: 32, price: 4, buyerName: "Jordan" });
  return { tequila, tripleSec, lime };
}

// ---------- U6 register helpers ------------------------------------------------------

const HOST_NIGHT_STARTED = "Host night started. Open the register to ring up drinks.";
const NOT_SAVING_MESSAGE = "This host night belongs to the shared database, and this browser is not connected to it, so nothing was saved. Reload the page to reconnect, then try again.";

/** Start a host night through Tonight's form (kind "host"); returns the confirm dialog's text and the night. */
async function startHostNightViaForm(session, name = "Smoke host night") {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  await page.fill("#nightForm [name='name']", name);
  await page.selectOption("#nightForm [name='kind']", "host");
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, "#nightForm button[type='submit']", HOST_NIGHT_STARTED);
  const night = await page.evaluate(() => window.__rnmb.state.nights.find((entry) => entry.kind === "host" && !entry.endedAt));
  assert.ok(night, "the host night was saved");
  return { dialogMessage, night };
}

/** Follow Tonight's "Open register" link and wait for the working register. */
async function openRegister(session) {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  await page.click("#openRegisterLink");
  await page.waitForSelector("#registerWork", { state: "visible" });
  assert.equal(await page.isVisible(".app-shell"), false, "the dashboard is hidden behind the register");
}

/** Open a guest tab from the register's new-tab form. */
async function openTabViaRegister(session, guestName) {
  await session.page.fill("#registerTabForm [name='guestName']", guestName);
  await clickForToast(session, "#registerOpenTab", `Tab opened for ${guestName}.`);
}

const registerItem = (page, name) => page.locator("#registerMenu [data-register-item]", { hasText: name });
const registerTab = (page, guestName) => page.locator("#registerTabs [data-register-tab]", { hasText: guestName });
const registerCrew = (page, name) => page.locator("#registerCrew [data-register-crew]", { hasText: name });
const tabCard = (page, guestName) => page.locator("#registerTabList .register-tab-card", { hasText: guestName });
const stockOf = (page, bottleId) => page.evaluate((id) => window.__rnmb.state.bottles.find((bottle) => bottle.id === id).remaining, bottleId);

/** Save a menu item and set stock levels through the repository (the Menu and Inventory UIs have their own scenarios). */
async function saveMenuItemAndLevels(page, { menuItem, levels = [] }) {
  const ok = await page.evaluate(async ({ menuItem, levels }) => {
    const r = window.__rnmb;
    for (const { bottleId, newRemaining } of levels) {
      if (!(await r.hostAction("", (db) => db.correctStock({ bottleId, newRemaining })))) return false;
    }
    return r.hostAction("", (db) => db.saveMenuItem(menuItem));
  }, { menuItem, levels });
  assert.equal(ok, true, "menu item and levels saved");
}

/** Two tequila bottles priced $30 (Sam) and $60 (Alex), through the forms. */
async function addTwoTequilas(session) {
  const tequila = await addTypeViaForm(session, { name: "Tequila", category: "Tequila", abv: 40 });
  const sams = await addPricedStockViaForm(session, { typeId: tequila.id, nickname: "Sam's tequila", size: 25.36, price: 30, buyerName: "Sam" });
  const alexs = await addPricedStockViaForm(session, { typeId: tequila.id, nickname: "Alex's tequila", size: 25.36, price: 60, buyerName: "Alex" });
  return { tequila, sams, alexs };
}

// ---------- U7 close-out helpers ---------------------------------------------------------

const REGISTER_CLOSED_MESSAGE = "No host night is running. Start one from Tonight on the dashboard, then open the register.";
const hostNightCard = (page, name) => page.locator("#hostNightList .host-night-card", { hasText: name });
const squash = (text) => text.replace(/\s+/g, " ").trim();
const personIdOf = (page, name) => page.evaluate((personName) => window.__rnmb.state.people.find((person) => person.name === personName).id, name);
const tabOf = (page, guestName) => page.evaluate((name) => window.__rnmb.state.guestTabs.find((tab) => tab.guestName === name), guestName);

/** Ring up a menu item to a guest's open tab from the register. */
async function ringUpToTab(session, itemName, guestName) {
  const { page } = session;
  await registerItem(page, itemName).click();
  await registerTab(page, guestName).click();
  await clickForToast(session, "#registerConfirm", `${itemName} rung up to ${guestName}.`);
}

/** Close a tab as paid from its register card; returns the confirm text. */
async function payTabViaRegister(session, guestName, collectorName) {
  const { page } = session;
  const card = tabCard(page, guestName);
  const tabId = await card.getAttribute("data-tab-id");
  const total = (await card.locator("[data-tab-total]").textContent()).trim();
  await card.locator("select[name='collectorId']").selectOption(await personIdOf(page, collectorName));
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, `#registerTabList [data-pay-tab="${tabId}"]`, `${guestName}'s tab paid: ${total} collected by ${collectorName}.`);
  return dialogMessage;
}

/** Write a tab off from its register card; returns the confirm text. */
async function writeOffTabViaRegister(session, guestName) {
  const { page } = session;
  const tabId = await tabCard(page, guestName).getAttribute("data-tab-id");
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, `#registerTabList [data-write-off-tab="${tabId}"]`, `${guestName}'s tab written off.`);
  return dialogMessage;
}

/** The buyer lines under a collector (or under the write-off) in a host night's Ledger card, whitespace squashed. */
async function hostNightRows(page, nightName, groupSelector) {
  return (await hostNightCard(page, nightName).locator(`${groupSelector} li`).allTextContents()).map(squash);
}

/** The AE1 margarita at 50% markup and $0.50 rounding. */
async function addAe1Margarita(session) {
  const types = await addAe1Stock(session);
  await setPricingViaForm(session, { markupPercent: 50, increment: "0.50" });
  await saveMenuItemAndLevels(session.page, {
    menuItem: {
      name: "Margarita",
      kind: "cocktail",
      ingredients: [
        { typeId: types.tequila.id, amount: 2 },
        { typeId: types.tripleSec.id, amount: 1 },
        { typeId: types.lime.id, amount: 1 }
      ]
    }
  });
  return types;
}

/** Leave the register for a dashboard tab. */
async function exitRegisterTo(page, tab) {
  await page.click("#exitRegister");
  await page.waitForSelector(".app-shell", { state: "visible" });
  await page.click(`.tab-button[data-tab="${tab}"]`);
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
      const { store, served400, unexpected, writes, routes, expected404 } = preMigrationStub();
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
  },

  {
    name: "U5 AE1 a margarita built in the Menu tab shows $5.00 at 50% / $0.50, and 0% markup reprices the list at once",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const people = await page.evaluate(() => window.__rnmb.state.people.map((person) => person.name));
        ["Sam", "Alex", "Jordan"].forEach((name) => assert.ok(people.includes(name), `demo roster has ${name}`));
        const { tequila, tripleSec, lime } = await addAe1Stock(session);

        await page.click('.tab-button[data-tab="menu"]');
        assert.equal(await page.textContent("#pageTitle"), "Menu", "the page title follows the Menu tab");
        assert.equal(await page.isVisible("#menu"), true);
        assert.equal(await page.isVisible("#menuHostModeNotice"), false, "no host-mode notice in local mode");

        await setPricingViaForm(session, { markupPercent: 50, increment: "0.50" });
        assert.deepEqual(
          await page.evaluate(() => ({ markup: window.__rnmb.state.markupPercent, cents: window.__rnmb.state.roundingIncrementCents })),
          { markup: 50, cents: 50 },
          "the increment is stored as integer cents"
        );
        assert.equal(await page.inputValue("#pricingForm [name='roundingIncrement']"), "0.50");

        const before = await menuItemCount(page);
        await page.fill("#menuItemForm [name='name']", "Margarita");
        assert.equal(await page.inputValue("#menuItemForm [name='kind']"), "cocktail");
        await fillIngredientRow(page, 0, { typeId: tequila.id, amount: 2 });
        await page.click("#addIngredientRow");
        await fillIngredientRow(page, 1, { typeId: tripleSec.id, amount: 1 });
        await page.click("#addIngredientRow");
        await fillIngredientRow(page, 2, { typeId: lime.id, amount: 1 });
        assert.equal((await page.locator("#ingredientRows [data-amount-label]").nth(0).textContent()).trim(), "Amount oz");
        await clickForToast(session, "#menuItemSubmit", "Menu item added.");

        const saved = await page.evaluate(() => window.__rnmb.state.menuItems.find((item) => item.name === "Margarita"));
        assert.equal(await menuItemCount(page), before + 1);
        assert.equal(saved.kind, "cocktail");
        assert.deepEqual(saved.ingredients.map(({ typeId, amount }) => ({ typeId, amount })), [
          { typeId: tequila.id, amount: 2 },
          { typeId: tripleSec.id, amount: 1 },
          { typeId: lime.id, amount: 1 }
        ]);
        assert.equal(await page.locator("#ingredientRows [data-ingredient-row]").count(), 1, "the form resets to one empty row");
        assert.equal(await page.inputValue("#menuItemForm [name='name']"), "");

        const card = menuCard(page, "Margarita");
        assert.equal((await card.locator("[data-menu-price]").textContent()).trim(), "$5.00");
        const text = await card.textContent();
        assert.match(text, /Cocktail/);
        assert.match(text, /2\.0 oz Tequila/);
        assert.match(text, /1\.0 oz Triple Sec/);
        assert.match(text, /1\.0 oz Lime juice/);
        assert.match(text, /Cost \$3\.28 · 50% markup/);
        const bourbonBefore = (await menuCard(page, "Bourbon Neat").locator("[data-menu-price]").textContent()).trim();

        // 0% markup: $3.28 rounds up to $3.50, and every listed price follows.
        await setPricingViaForm(session, { markupPercent: 0, increment: "0.50" });
        assert.equal((await card.locator("[data-menu-price]").textContent()).trim(), "$3.50");
        assert.match(await card.textContent(), /0% markup/);
        const bourbonAfter = (await menuCard(page, "Bourbon Neat").locator("[data-menu-price]").textContent()).trim();
        assert.notEqual(bourbonAfter, bourbonBefore, "other items reprice too");
        assert.equal(await page.inputValue("#pricingForm [name='markupPercent']"), "0");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U5 a straight pour refuses a second ingredient and a counted item refuses a poured type, saving nothing",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const can = await addTypeViaForm(session, { name: "Lager can", category: "Beer", measure: "unit", unitOz: 12, abv: 5 });
        const bourbonId = await page.evaluate(() => window.__rnmb.state.types.find((type) => type.name === "House Bourbon").id);
        await page.click('.tab-button[data-tab="menu"]');
        const before = await menuItemCount(page);
        const rows = page.locator("#ingredientRows [data-ingredient-row]");

        // Straight pour: the add control refuses a second row.
        await page.fill("#menuItemForm [name='name']", "Double pour");
        await page.selectOption("#menuItemForm [name='kind']", "straight");
        await fillIngredientRow(page, 0, { typeId: bourbonId, amount: 2 });
        await clickForToast(session, "#addIngredientRow", "A straight pour has exactly one ingredient.");
        assert.equal(await rows.count(), 1);

        // Two rows built as a cocktail, then switched to a straight pour: submit refuses.
        await page.selectOption("#menuItemForm [name='kind']", "cocktail");
        await page.click("#addIngredientRow");
        await fillIngredientRow(page, 1, { typeId: bourbonId, amount: 1 });
        assert.equal(await rows.count(), 2);
        await page.selectOption("#menuItemForm [name='kind']", "straight");
        await clickForToast(session, "#menuItemSubmit", "A straight pour has exactly one ingredient.");
        assert.equal(await menuItemCount(page), before, "nothing saved");

        // A straight pour of a counted type is refused too.
        await rows.nth(1).locator("[data-remove-ingredient]").click();
        await fillIngredientRow(page, 0, { typeId: can.id });
        await clickForToast(session, "#menuItemSubmit", "A straight pour needs a poured stock type, and Lager can is counted.");
        assert.equal(await menuItemCount(page), before, "nothing saved");

        // Counted item: the amount is locked to 1 unit, and a poured type is refused.
        await page.selectOption("#menuItemForm [name='kind']", "counted");
        await fillIngredientRow(page, 0, { typeId: bourbonId });
        const amount = rows.nth(0).locator("input[name='ingredientAmount']");
        assert.equal(await amount.inputValue(), "1");
        assert.equal(await amount.evaluate((input) => input.readOnly), true, "the counted amount is locked");
        assert.equal((await rows.nth(0).locator("[data-amount-label]").textContent()).trim(), "Units");
        await clickForToast(session, "#addIngredientRow", "A counted item has exactly one ingredient.");
        await clickForToast(session, "#menuItemSubmit", "A counted item needs a counted stock type, and House Bourbon is poured.");
        assert.equal(await menuItemCount(page), before, "nothing saved");
        assert.equal(await page.evaluate(() => localStorage.getItem("rnmb-command-center-v1").includes("Double pour")), false);

        // With a counted type it saves, as exactly 1 unit.
        await fillIngredientRow(page, 0, { typeId: can.id });
        await page.fill("#menuItemForm [name='name']", "Can of lager");
        await clickForToast(session, "#menuItemSubmit", "Menu item added.");
        const saved = await page.evaluate(() => window.__rnmb.state.menuItems.find((item) => item.name === "Can of lager"));
        assert.equal(saved.kind, "counted");
        assert.deepEqual(saved.ingredients.map(({ typeId, amount }) => ({ typeId, amount })), [{ typeId: can.id, amount: 1 }]);
        assert.match(await menuCard(page, "Can of lager").textContent(), /1 unit Lager can/);
        assert.equal((await menuCard(page, "Can of lager").locator("[data-menu-price]").textContent()).trim(), "Unavailable", "no can stock yet");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U5 AE5 a margarita whose triple sec totals 0.5 oz shows Unavailable, and after a hand correction is priced across both bottles",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const tripleSec = await addTypeViaForm(session, { name: "Triple Sec", category: "Liqueur", abv: 30 });
        const a = await addPricedStockViaForm(session, { typeId: tripleSec.id, nickname: "Triple A", size: 25.36, price: 20, buyerName: "Alex" });
        const b = await addPricedStockViaForm(session, { typeId: tripleSec.id, nickname: "Triple B", size: 25.36, price: 40, buyerName: "Sam" });
        const setLevel = async (bottleId, level) => {
          const form = `#inventoryList [data-bottle-id="${bottleId}"] .level-form`;
          await page.click('.tab-button[data-tab="inventory"]');
          await page.fill(`${form} input[name='level']`, String(level));
          await clickForToast(session, `${form} button[type='submit']`, "Stock level set.");
        };
        await setLevel(a.id, 0.25);
        await setLevel(b.id, 0.25);

        await page.click('.tab-button[data-tab="menu"]');
        await page.fill("#menuItemForm [name='name']", "Margarita");
        await fillIngredientRow(page, 0, { typeId: tripleSec.id, amount: 1 });
        await clickForToast(session, "#menuItemSubmit", "Menu item added.");
        const card = menuCard(page, "Margarita");
        assert.equal((await card.locator("[data-menu-price]").textContent()).trim(), "Unavailable");
        assert.match(await card.locator("[data-menu-detail]").textContent(), /Not enough Triple Sec in stock/);

        // Corrected by hand: 0.25 + 0.75 = 1 oz combined. 0.25 oz at $20 and 0.75 oz at $40 per 25.36 oz
        // cost 138 cents, which rounds up to $1.50 at 0% / $0.25 (either bottle alone would be $1.00 or $1.75).
        await setLevel(b.id, 0.75);
        await page.click('.tab-button[data-tab="menu"]');
        assert.equal((await card.locator("[data-menu-price]").textContent()).trim(), "$1.50");
        assert.match(await card.locator("[data-menu-detail]").textContent(), /more than one bottle/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U5 editing a menu item keeps its id and changes its recipe; removing it asks first and takes it off the list",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.click('.tab-button[data-tab="menu"]');
        const original = await page.evaluate(() => window.__rnmb.state.menuItems.find((item) => item.name === "Bourbon Neat"));
        const count = await menuItemCount(page);

        await menuCard(page, "Bourbon Neat").locator("[data-edit-menu-item]").click();
        assert.equal((await page.textContent("#menu-title")).trim(), "Edit Menu Item");
        assert.equal(await page.isVisible("#menuItemCancel"), true);
        assert.equal(await page.inputValue("#menuItemForm [name='name']"), "Bourbon Neat");
        assert.equal(await page.inputValue("#menuItemForm [name='kind']"), "straight");
        const row = page.locator("#ingredientRows [data-ingredient-row]");
        assert.equal(await row.count(), 1);
        assert.equal(await row.nth(0).locator("select").inputValue(), original.ingredients[0].typeId);
        assert.equal(await row.nth(0).locator("input[name='ingredientAmount']").inputValue(), "2");

        await page.fill("#menuItemForm [name='name']", "Bourbon Short");
        await row.nth(0).locator("input[name='ingredientAmount']").fill("1.5");
        await clickForToast(session, "#menuItemSubmit", "Menu item updated.");
        const edited = await page.evaluate((id) => window.__rnmb.state.menuItems.find((item) => item.id === id), original.id);
        assert.equal(await menuItemCount(page), count, "an edit does not add an item");
        assert.equal(edited.name, "Bourbon Short");
        assert.equal(edited.ingredients.length, 1);
        assert.equal(edited.ingredients[0].amount, 1.5);
        assert.equal((await page.textContent("#menu-title")).trim(), "Add Menu Item", "the form leaves edit mode");
        assert.equal(await page.isVisible("#menuItemCancel"), false);
        assert.match(await menuCard(page, "Bourbon Short").textContent(), /1\.5 oz House Bourbon/);
        assert.equal(await menuCard(page, "Bourbon Neat").count(), 0);

        let dialogMessage = "";
        page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
        await clickForToast(session, `#menuList [data-remove-menu-item="${original.id}"]`, "Menu item removed.");
        assert.match(dialogMessage, /Remove Bourbon Short from the menu\?/);
        assert.equal(await menuItemCount(page), count - 1);
        assert.equal(await menuCard(page, "Bourbon Short").count(), 0);
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("rnmb-command-center-v1")).menuItems.map((item) => item.id));
        assert.ok(!stored.includes(original.id), "the removal is stored");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U5 Menu tab controls have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          await page.click('.tab-button[data-tab="menu"]');
          await page.click("#addIngredientRow");
          const cards = await page.$$eval("#menuList .menu-card", (list) => list.map((card) => card.dataset.menuItemId));
          assert.ok(cards.length >= 3, "every demo menu item has a card");
          await page.click(`#menuList [data-edit-menu-item="${cards[0]}"]`);
          await page.selectOption("#menuItemForm [name='kind']", "cocktail");
          await page.click("#addIngredientRow");

          const selectors = [
            '.tab-button[data-tab="menu"]',
            "#menuItemForm [name='name']",
            "#menuItemForm [name='kind']",
            "#ingredientRows [data-ingredient-row]:nth-child(1) select[name='ingredientType']",
            "#ingredientRows [data-ingredient-row]:nth-child(1) input[name='ingredientAmount']",
            "#ingredientRows [data-ingredient-row]:nth-child(2) select[name='ingredientType']",
            "#ingredientRows [data-ingredient-row]:nth-child(2) input[name='ingredientAmount']",
            "#ingredientRows [data-ingredient-row]:nth-child(2) [data-remove-ingredient]",
            "#addIngredientRow",
            "#menuItemSubmit",
            "#menuItemCancel",
            "#pricingForm [name='markupPercent']",
            "#pricingForm [name='roundingIncrement']",
            "#pricingForm button[type='submit']"
          ];
          cards.forEach((id) => {
            selectors.push(`#menuList [data-menu-item-id="${id}"] [data-menu-price]`);
            selectors.push(`#menuList [data-edit-menu-item="${id}"]`);
            selectors.push(`#menuList [data-remove-menu-item="${id}"]`);
          });
          for (const selector of selectors) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            const box = await page.locator(selector).boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0, `${selector} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
          }
          const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
          assert.ok(widths.scroll <= widths.client, `no horizontal scroll at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          // Ingredient controls stay inside the form.
          const overflow = await page.$$eval("#ingredientRows [data-ingredient-row]", (rows) => rows
            .map((row, index) => (row.querySelector("[data-remove-ingredient]").getBoundingClientRect().right <= document.querySelector("#menuItemForm").getBoundingClientRect().right + 0.5 ? null : index))
            .filter((index) => index !== null));
          assert.deepEqual(overflow, [], `ingredient rows overflow the form at ${viewport.width}px`);
          session.assertClean();
        } finally {
          await session.close();
        }
      }
    }
  },

  {
    name: "U5 pre-migration database: the Menu tab names supabase/host-mode.sql and its forms are disabled",
    async run({ browser }) {
      const { writes, served400, unexpected, routes, expected404 } = preMigrationStub();
      const session = await openPage(browser, { routes, allowConsole: expected404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.hostModeAvailable), false);
        await page.click('.tab-button[data-tab="menu"]');
        assert.equal(await page.textContent("#pageTitle"), "Menu");
        assert.equal(await page.isVisible("#menuHostModeNotice"), true);
        assert.equal((await page.textContent("#menuHostModeNotice")).trim(), HOST_MODE_SQL_MESSAGE);

        const controls = await page.$$eval("#menuItemForm input, #menuItemForm select, #menuItemForm button, #pricingForm input, #pricingForm button", (list) => list
          .map((control) => ({ name: control.name || control.id || control.textContent.trim(), disabled: control.disabled })));
        assert.ok(controls.length >= 8, "the Menu forms have their controls");
        assert.deepEqual(controls.filter((control) => !control.disabled), [], "every Menu form control is disabled");
        assert.match(await page.textContent("#menuList"), /once host mode is set up/);

        // Even a submit that bypasses the disabled button saves nothing and names the fix.
        const writesBefore = writes.length;
        const count = (await session.toasts()).length;
        await page.evaluate(() => document.querySelector("#pricingForm").requestSubmit());
        await page.waitForFunction(({ count, text }) => window.__toasts.slice(count).includes(text), { count, text: HOST_MODE_SQL_MESSAGE });
        assert.equal(writes.length, writesBefore, "no write was sent");
        assert.deepEqual(served400, []);
        assert.deepEqual(unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 local mode: starting a host night asks first (cancel starts nothing), and the red banner shows on the closed and open register",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        // No host night yet: #register is the closed message, still with the banner, and no way to ring up.
        assert.equal(await page.isVisible("#openRegisterLink"), false, "no register link without a host night");
        await page.evaluate(() => { location.hash = "#register"; });
        await page.waitForSelector("#registerClosed", { state: "visible" });
        assert.equal(await page.isVisible(".app-shell"), false);
        assert.equal(await page.isVisible("#registerWork"), false, "the register itself is not shown");
        assert.match(await page.textContent("#registerClosedMessage"), /No host night is running/);
        assert.equal(await page.isVisible("#registerLocalBanner"), true, "banner on the closed register");
        assert.match(await page.textContent("#registerLocalBanner"), /This browser only/);
        await page.click("#registerBack");
        await page.waitForSelector(".app-shell", { state: "visible" });
        assert.equal(await page.isVisible("#register"), false);

        // Cancelling the scope confirm starts nothing.
        page.removeAllListeners("dialog");
        let cancelled = "";
        page.once("dialog", (dialog) => { cancelled = dialog.message(); dialog.dismiss(); });
        await page.click('.tab-button[data-tab="tonight"]');
        await page.fill("#nightForm [name='name']", "Cancelled party");
        await page.selectOption("#nightForm [name='kind']", "host");
        await clickForToast(session, "#nightForm button[type='submit']", "Host night not started.");
        assert.match(cancelled, /THIS BROWSER ONLY/);
        assert.equal(await page.evaluate(() => window.__rnmb.state.nights.some((night) => night.kind === "host")), false);
        page.on("dialog", (dialog) => dialog.accept());

        const { dialogMessage, night } = await startHostNightViaForm(session, "Saturday party");
        assert.match(dialogMessage, /Saturday party/);
        assert.match(dialogMessage, /THIS BROWSER ONLY/);
        assert.match(dialogMessage, /not connected to the shared database/);
        assert.equal(night.startedLocally, true);
        assert.equal(await page.evaluate(() => window.__rnmb.state.activeNightId), night.id);
        assert.equal(await page.inputValue("#nightForm [name='kind']"), "crew", "the form resets");
        assert.equal(await page.isVisible("#openRegisterLink"), true, "Open register appears while the host night runs");
        assert.match(await page.textContent("#hostNightNoticeText"), /Saturday party/);

        await openRegister(session);
        assert.equal(await page.isVisible("#registerLocalBanner"), true, "banner on the open register");
        assert.equal(await page.isVisible("#registerClosed"), false);
        assert.match(await page.textContent("#registerNightMeta"), /Saturday party/);
        assert.equal(await page.isDisabled("#registerConfirm"), true, "nothing chosen, nothing to confirm");
        await page.click("#exitRegister");
        await page.waitForSelector(".app-shell", { state: "visible" });
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 AE3 switching the preselected tequila to the other bottle and confirming deducts only the chosen bottle",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { tequila, sams, alexs } = await addTwoTequilas(session);
        // Sam's bottle has less left, so it is preselected (KTD10); the bartender is pouring from Alex's.
        await saveMenuItemAndLevels(page, {
          menuItem: { name: "Tequila Shot", kind: "straight", ingredients: [{ typeId: tequila.id, amount: 2 }] },
          levels: [{ bottleId: sams.id, newRemaining: 10 }]
        });
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        assert.equal(await registerTab(page, "Riley").getAttribute("aria-pressed"), "true", "a new tab becomes the target");

        await registerItem(page, "Tequila Shot").click();
        assert.equal(await registerItem(page, "Tequila Shot").getAttribute("aria-pressed"), "true");
        const select = page.locator("#registerIngredients select[name='sourceBottle']");
        assert.equal(await select.count(), 1);
        assert.equal(await select.inputValue(), sams.id, "the least-remaining bottle that covers the pour is preselected");
        const detail = await page.textContent("#registerIngredients [data-source-detail]");
        assert.match(detail, /Sam's tequila · Sam · 10\.0 of 25\.4 oz left/, "the preselected source is shown plainly");
        assert.equal(await page.isEnabled("#registerConfirm"), true);

        await select.selectOption(alexs.id);
        assert.equal(await page.locator("#registerIngredients select[name='sourceBottle']").inputValue(), alexs.id);
        assert.equal(await page.inputValue("#registerIngredients input[name='sourceAmount']"), "2");
        assert.match(await page.textContent("#registerIngredients [data-source-detail]"), /Alex's tequila · Alex/);
        // 2 oz of a $60, 25.36 oz bottle costs 473 cents: $4.75 at 0% / $0.25.
        assert.equal((await page.textContent("#registerConfirm")).trim(), "Ring up $4.75 to Riley");

        await clickForToast(session, "#registerConfirm", "Tequila Shot rung up to Riley.");
        assert.equal(await stockOf(page, sams.id), 10, "the preselected bottle is untouched");
        assert.equal(await stockOf(page, alexs.id), 23.36, "only the switched-to bottle loses 2 oz");
        const ringUp = await page.evaluate(() => window.__rnmb.state.ringUps[0]);
        assert.equal(ringUp.priceCents, 475);
        assert.deepEqual(ringUp.lines.map(({ bottleId, amount, buyerName, shareCents }) => ({ bottleId, amount, buyerName, shareCents })), [
          { bottleId: alexs.id, amount: 2, buyerName: "Alex", shareCents: 475 }
        ]);
        assert.equal(await page.evaluate(() => window.__rnmb.registerDraft), null, "the draft is cleared after a ring-up");
        assert.equal((await tabCard(page, "Riley").locator("[data-tab-total]").textContent()).trim(), "$4.75");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 AE9 a short tequila keeps confirm disabled until a second bottle makes up 2 oz; A reads 0, B loses 1.5, shares split by cost",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { tequila, sams, alexs } = await addTwoTequilas(session);
        // Neither bottle alone covers 2 oz, but together they do.
        await saveMenuItemAndLevels(page, {
          menuItem: { name: "Tequila Shot", kind: "straight", ingredients: [{ typeId: tequila.id, amount: 2 }] },
          levels: [{ bottleId: sams.id, newRemaining: 0.5 }, { bottleId: alexs.id, newRemaining: 1.5 }]
        });
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await registerItem(page, "Tequila Shot").click();

        const ingredient = page.locator("#registerIngredients [data-ingredient-index='0']");
        const marker = ingredient.locator("[data-short-marker]");
        assert.equal(await page.locator("#registerIngredients select[name='sourceBottle']").inputValue(), sams.id);
        assert.equal(await page.inputValue("#registerIngredients input[name='sourceAmount']"), "0.5");
        assert.equal(await marker.isVisible(), true, "the tequila line is marked short");
        assert.equal((await marker.textContent()).trim(), "Short 1.5 oz");
        assert.equal(await page.isDisabled("#registerConfirm"), true, "confirm is disabled while short");
        assert.match(await page.textContent("#registerHint"), /Tequila is short 1\.5 oz/);
        assert.equal(await page.evaluate(() => window.__rnmb.registerDraft.sources[0].length), 1, "the split is never applied without a tap");

        await ingredient.locator("[data-add-source]").click();
        const amounts = page.locator("#registerIngredients input[name='sourceAmount']");
        assert.equal(await amounts.count(), 2);
        assert.equal(await page.locator("#registerIngredients select[name='sourceBottle']").nth(1).inputValue(), alexs.id);
        assert.equal(await amounts.nth(1).inputValue(), "1.5", "the added bottle offers the shortfall");
        assert.equal(await marker.isVisible(), false);
        assert.equal(await page.isEnabled("#registerConfirm"), true);

        // Typing a smaller amount is short again; typing it back enables confirm.
        await amounts.nth(1).fill("1");
        assert.equal(await marker.isVisible(), true);
        assert.equal((await marker.textContent()).trim(), "Short 0.5 oz");
        assert.equal(await page.isDisabled("#registerConfirm"), true);
        await amounts.nth(1).fill("1.5");
        assert.equal(await marker.isVisible(), false);
        assert.equal(await page.isEnabled("#registerConfirm"), true);

        await clickForToast(session, "#registerConfirm", "Tequila Shot rung up to Riley.");
        assert.equal(await stockOf(page, sams.id), 0, "A reads 0 oz");
        assert.equal(await stockOf(page, alexs.id), 0, "B loses 1.5 oz");
        const result = await page.evaluate(() => {
          const ringUp = window.__rnmb.state.ringUps[0];
          return { ringUp, expected: window.RNMBDomain.allocateShares(ringUp.priceCents, ringUp.lines.map((line) => line.costCents)) };
        });
        const lines = result.ringUp.lines;
        assert.deepEqual(lines.map((line) => [line.bottleId, line.amount, line.buyerName]), [[sams.id, 0.5, "Sam"], [alexs.id, 1.5, "Alex"]]);
        assert.deepEqual(lines.map((line) => line.shareCents), result.expected, "shares follow each bottle's cost");
        assert.equal(lines[0].shareCents + lines[1].shareCents, result.ringUp.priceCents);
        assert.ok(lines[0].shareCents > 0 && lines[1].shareCents > lines[0].shareCents, `Sam and Alex both get a share, Alex more (${lines[0].shareCents}/${lines[1].shareCents})`);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 opening a tab by name then ringing up two items shows the running total and both items; unavailable items are disabled",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const lowered = await page.evaluate(() => {
          const r = window.__rnmb;
          const red = r.state.bottles.find((bottle) => bottle.nickname === "Diplomatic Pouch");
          return r.hostAction("", (db) => db.correctStock({ bottleId: red.id, newRemaining: 2 }));
        });
        assert.equal(lowered, true);
        await startHostNightViaForm(session);
        await openRegister(session);
        const glass = registerItem(page, "Glass of Red");
        assert.equal(await glass.isDisabled(), true, "Glass of Red (5 oz) is unavailable with 2 oz left");
        assert.match(await glass.textContent(), /Unavailable/);

        await clickForToast(session, "#registerOpenTab", "Type the guest's name to open a tab.");
        await openTabViaRegister(session, "Morgan");
        assert.equal(await page.inputValue("#registerTabForm [name='guestName']"), "", "the name field clears");
        const tab = await page.evaluate(() => window.__rnmb.state.guestTabs[0]);
        assert.equal(tab.guestName, "Morgan");
        assert.equal(tab.status, "open");

        // Boilermaker: 1.5 oz bourbon ($34.99 / 25.36 oz) + 12 oz lager ($22.50 / 144 oz) = 394 cents, $4.00.
        await registerItem(page, "Boilermaker").click();
        assert.match(await registerItem(page, "Boilermaker").textContent(), /\$4\.00/, "the menu button shows the price");
        await clickForToast(session, "#registerConfirm", "Boilermaker rung up to Morgan.");
        // Bourbon Neat: 2 oz bourbon = 276 cents, $3.00. The target is chosen again after the draft cleared.
        await registerItem(page, "Bourbon Neat").click();
        assert.equal(await page.isDisabled("#registerConfirm"), true, "no target yet");
        assert.match(await page.textContent("#registerHint"), /Pick a guest tab or a crew member/);
        await registerTab(page, "Morgan").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat rung up to Morgan.");

        const card = tabCard(page, "Morgan");
        assert.equal((await card.locator("[data-tab-total]").textContent()).trim(), "$7.00");
        const items = await card.locator(".register-tab-items li").allTextContents();
        assert.equal(items.length, 2);
        assert.match(items[0], /Boilermaker\s*\$4\.00/);
        assert.match(items[1], /Bourbon Neat\s*\$3\.00/);
        assert.match(await registerTab(page, "Morgan").textContent(), /\$7\.00/, "the target button shows the running total");
        const ids = await page.evaluate(() => window.__rnmb.state.ringUps.map((ringUp) => ringUp.id));
        assert.equal(new Set(ids).size, 2, "each draft had its own ring-up id");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 AE4 voiding an item asks first, removes its price from the tab and restores every source bottle",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        const ids = await page.evaluate(() => ({
          bourbon: window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "The Briefing Bottle").id,
          lager: window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "Cooler Battalion").id
        }));
        await registerItem(page, "Bourbon Neat").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat rung up to Riley.");
        const before = { bourbon: await stockOf(page, ids.bourbon), lager: await stockOf(page, ids.lager) };

        await registerItem(page, "Boilermaker").click();
        await registerTab(page, "Riley").click();
        await clickForToast(session, "#registerConfirm", "Boilermaker rung up to Riley.");
        assert.equal(await stockOf(page, ids.lager), before.lager - 12);
        const card = tabCard(page, "Riley");
        assert.equal((await card.locator("[data-tab-total]").textContent()).trim(), "$7.00");

        const boilermaker = await page.evaluate(() => window.__rnmb.state.ringUps.find((ringUp) => ringUp.menuItemName === "Boilermaker").id);
        let dialogMessage = "";
        page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
        await clickForToast(session, `#registerTabList [data-void-ring-up="${boilermaker}"]`, "Item voided and its stock restored.");
        assert.match(dialogMessage, /Void Boilermaker \(\$4\.00\) from Riley's tab\?/);

        assert.equal((await card.locator("[data-tab-total]").textContent()).trim(), "$3.00", "the price leaves the tab");
        const items = await card.locator(".register-tab-items li").allTextContents();
        assert.equal(items.length, 1);
        assert.match(items[0], /Bourbon Neat/);
        assert.equal(await stockOf(page, ids.bourbon), before.bourbon, "the bourbon comes back");
        assert.equal(await stockOf(page, ids.lager), before.lager, "the lager comes back");
        const voided = await page.evaluate((id) => window.__rnmb.state.ringUps.find((ringUp) => ringUp.id === id), boilermaker);
        assert.ok(voided.voidedAt, "voided, not deleted");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 AE7 a crew shot records no price, deducts the bottle and appears in no tab",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        const bourbon = await page.evaluate(() => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "The Briefing Bottle").id);
        const before = await stockOf(page, bourbon);

        await registerItem(page, "Bourbon Neat").click();
        await registerCrew(page, "Casey").click();
        assert.equal(await registerCrew(page, "Casey").getAttribute("aria-pressed"), "true");
        assert.equal(await registerTab(page, "Riley").getAttribute("aria-pressed"), "false", "a crew member replaces the tab as target");
        assert.equal((await page.textContent("#registerConfirm")).trim(), "Pour for Casey · no charge");
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey. No charge.");

        const result = await page.evaluate(() => {
          const r = window.__rnmb;
          const ringUp = r.state.ringUps[0];
          return { ringUp, drinks: window.RNMBDomain.linesConsumption(ringUp.lines, r.state.types).standardDrinks, stored: JSON.parse(localStorage.getItem("rnmb-command-center-v1")).ringUps.length };
        });
        assert.equal(result.ringUp.kind, "crew");
        assert.equal(result.ringUp.priceCents, null, "no price");
        assert.equal(result.ringUp.tabId, null, "no tab");
        assert.equal(result.ringUp.personName, "Casey");
        assert.ok(result.ringUp.lines.every((line) => line.shareCents === null), "no shares");
        assert.ok(result.drinks > 0, "the shot counts as consumption");
        assert.equal(result.stored, 1);
        assert.equal(await stockOf(page, bourbon), Math.round((before - 2) * 100) / 100, "the bottle is depleted");
        assert.equal(await page.locator(`#registerTabList [data-ring-up-id="${result.ringUp.id}"]`).count(), 0, "not on any tab");
        const card = tabCard(page, "Riley");
        assert.equal((await card.locator("[data-tab-total]").textContent()).trim(), "$0.00");
        assert.match(await card.textContent(), /No drinks yet/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 a re-render or save during an unfinished draft keeps the selected item and target, and counts as busy",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await page.evaluate(() => document.activeElement.blur());
        assert.equal(await page.evaluate(() => window.__rnmb.isUserBusy()), true, "a chosen target alone is an unfinished draft");
        await registerItem(page, "Boilermaker").click();
        await page.evaluate(() => document.activeElement.blur());
        const draftId = await page.evaluate(() => window.__rnmb.registerDraft.id);
        assert.equal(await page.evaluate(() => window.__rnmb.isUserBusy()), true, "the refresh is held off");

        // A save elsewhere (another tab opened) re-renders everything, then a bare render as a refresh would.
        const opened = await page.evaluate(async () => {
          const r = window.__rnmb;
          const night = r.state.nights.find((entry) => entry.kind === "host");
          return r.hostAction("Tab opened.", (db) => db.openTab({ id: crypto.randomUUID(), nightId: night.id, guestName: "Sky" }));
        });
        assert.equal(opened, true);
        await page.evaluate(() => window.__rnmb.render());
        assert.equal(await registerTab(page, "Sky").count(), 1, "the new tab rendered");
        assert.equal(await registerItem(page, "Boilermaker").getAttribute("aria-pressed"), "true", "item kept");
        assert.equal(await registerTab(page, "Riley").getAttribute("aria-pressed"), "true", "target kept");
        assert.equal(await page.locator("#registerIngredients [data-ingredient-index]").count(), 2, "ingredient panel kept");
        assert.equal(await page.evaluate(() => window.__rnmb.registerDraft.id), draftId, "same draft id");

        await page.click("#registerClear");
        assert.equal(await page.evaluate(() => window.__rnmb.isUserBusy()), false, "no draft, not busy");
        assert.equal(await registerTab(page, "Riley").getAttribute("aria-pressed"), "false");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 localStorage holding an open host night not started here: the register shows the not-saving message and cannot ring up",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.evaluate(() => {
          const stored = JSON.parse(localStorage.getItem("rnmb-command-center-v1"));
          stored.nights.push({ id: crypto.randomUUID(), name: "Shared party", date: "2026-09-16", kind: "host", endedAt: null, pours: [] });
          localStorage.setItem("rnmb-command-center-v1", JSON.stringify(stored));
          location.hash = "#register";
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__rnmb && window.__toasts && window.__toasts.length > 0, null, { timeout: 15000 });
        await page.waitForSelector("#registerNotSaving", { state: "visible" });
        assert.equal(await page.evaluate(() => window.__rnmb.syncMode), "local");
        assert.equal((await page.textContent("#registerNotSavingMessage")).trim(), NOT_SAVING_MESSAGE);
        assert.equal(await page.isVisible("#registerLocalBanner"), true, "banner on the not-saving register");
        assert.equal(await page.isVisible("#registerRetry"), true);
        assert.equal(await page.isVisible("#registerWork"), false, "no menu, targets or confirm");
        assert.equal(await page.isVisible("#registerClosed"), false);
        assert.equal(await page.isDisabled("#registerConfirm"), true);

        const attempt = await page.evaluate(() => {
          document.querySelector("#registerConfirm").click();
          document.querySelector("#registerTabForm").requestSubmit();
          return new Promise((resolve) => setTimeout(() => resolve({
            ringUps: window.__rnmb.state.ringUps.length,
            tabs: window.__rnmb.state.guestTabs.length
          }), 300));
        });
        assert.deepEqual(attempt, { ringUps: 0, tabs: 0 }, "nothing can be rung up or opened");

        // Retry reloads the page.
        const reloaded = page.waitForEvent("load");
        await page.click("#registerRetry");
        await reloaded;
        await page.waitForSelector("#registerNotSaving", { state: "visible" });
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 a second confirm tap while the ring-up is pending creates no second ring-up; a failed ring-up keeps its draft id",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session);
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await registerItem(page, "Bourbon Neat").click();
        const bourbon = await page.evaluate(() => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "The Briefing Bottle").id);
        const before = await stockOf(page, bourbon);
        const draftId = await page.evaluate(() => window.__rnmb.registerDraft.id);

        // First attempt fails: the draft, its id and its selections survive and confirm comes back.
        await page.evaluate(() => {
          const repo = window.__rnmb.repository;
          const original = repo.ringUp;
          window.__ringUpIds = [];
          repo.ringUp = async (record) => {
            window.__ringUpIds.push(record.id);
            if (window.__ringUpIds.length === 1) {
              const error = new Error("Simulated refusal");
              error.userMessage = "Simulated refusal";
              throw error;
            }
            await new Promise((resolve) => { window.__releaseRingUp = resolve; });
            return original(record);
          };
        });
        await clickForToast(session, "#registerConfirm", "Simulated refusal");
        assert.equal(await page.evaluate(() => window.__rnmb.registerDraft?.id), draftId, "the draft survives a failure");
        assert.equal(await page.isEnabled("#registerConfirm"), true, "confirm is usable again");
        assert.equal(await registerItem(page, "Bourbon Neat").getAttribute("aria-pressed"), "true");

        // Second attempt is slow: double tap, then a scripted click while pending.
        await page.dblclick("#registerConfirm");
        await page.waitForFunction(() => typeof window.__releaseRingUp === "function");
        const pending = await page.evaluate(() => {
          document.querySelector("#registerConfirm").click();
          return {
            calls: window.__ringUpIds.length,
            confirmDisabled: document.querySelector("#registerConfirm").disabled,
            enabledControls: Array.from(document.querySelectorAll("#registerWork button, #registerWork input, #registerWork select"))
              .filter((control) => !control.disabled).map((control) => control.outerHTML.slice(0, 60))
          };
        });
        assert.equal(pending.calls, 2, "one failed call and exactly one pending call");
        assert.equal(pending.confirmDisabled, true);
        assert.deepEqual(pending.enabledControls, [], "every draft control is disabled while pending");
        const toastCount = (await session.toasts()).length;
        await page.evaluate(() => window.__releaseRingUp());
        await page.waitForFunction((count) => window.__toasts.slice(count).includes("Bourbon Neat rung up to Riley."), toastCount);

        const after = await page.evaluate(() => ({ ringUps: window.__rnmb.state.ringUps.map((ringUp) => ringUp.id), ids: window.__ringUpIds }));
        assert.deepEqual(after.ringUps, [draftId], "one ring-up, with the draft's id");
        assert.deepEqual(after.ids, [draftId, draftId], "the resubmit reused the draft id (KTD14)");
        assert.equal(await stockOf(page, bourbon), Math.round((before - 2) * 100) / 100, "stock deducted once");
        assert.equal((await tabCard(page, "Riley").locator("[data-tab-total]").textContent()).trim(), "$3.00");
        // Once the call resolves, nothing stays locked: the next order can start at once.
        const locked = await page.evaluate(() => Array.from(document.querySelectorAll("#registerWork button, #registerWork input, #registerWork select"))
          .filter((control) => control.disabled && !["registerConfirm"].includes(control.id) && !control.matches("[data-register-item]"))
          .map((control) => control.id || control.name || control.outerHTML.slice(0, 60)));
        assert.deepEqual(locked, [], "every control is usable again after the ring-up");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U6 register controls have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          // A second bourbon bottle, so a split (add and remove) can be shown.
          const bourbonType = await page.evaluate(() => window.__rnmb.state.types.find((type) => type.name === "House Bourbon").id);
          await addStockViaForm(session, { typeId: bourbonType, nickname: "Backup bourbon" });
          await startHostNightViaForm(session);
          await page.click('.tab-button[data-tab="tonight"]');
          await page.locator("#openRegisterLink").scrollIntoViewIfNeeded();
          const link = await page.locator("#openRegisterLink").boundingBox();
          assert.ok(link && link.width > 0 && link.height > 0, `#openRegisterLink has a box at ${viewport.width}px`);
          await openRegister(session);
          await openTabViaRegister(session, "Riley");
          await registerItem(page, "Bourbon Neat").click();
          await clickForToast(session, "#registerConfirm", "Bourbon Neat rung up to Riley.");
          await registerItem(page, "Boilermaker").click();
          await registerTab(page, "Riley").click();
          await page.locator("#registerIngredients [data-ingredient-index='0'] [data-add-source]").click();
          assert.equal(await page.locator("#registerIngredients [data-remove-source]").count(), 1);

          const selectors = [
            "#exitRegister",
            "#registerLocalBanner",
            "#registerTabForm [name='guestName']",
            "#registerOpenTab",
            "#registerClear",
            "#registerConfirm",
            "#registerHint"
          ];
          const groups = [
            "#registerMenu [data-register-item]",
            "#registerTabs [data-register-tab]",
            "#registerCrew [data-register-crew]",
            "#registerIngredients select[name='sourceBottle']",
            "#registerIngredients input[name='sourceAmount']",
            "#registerIngredients [data-add-source]",
            "#registerIngredients [data-remove-source]",
            "#registerIngredients [data-source-detail]",
            "#registerTabList [data-tab-total]",
            "#registerTabList [data-void-ring-up]"
          ];
          const checked = [];
          const check = async (locator, label) => {
            await locator.scrollIntoViewIfNeeded();
            const box = await locator.boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0, `${label} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
            checked.push(label);
          };
          for (const selector of selectors) await check(page.locator(selector), selector);
          for (const selector of groups) {
            const count = await page.locator(selector).count();
            assert.ok(count > 0, `${selector} is present`);
            for (let index = 0; index < count; index += 1) await check(page.locator(selector).nth(index), `${selector} #${index}`);
          }
          assert.ok(checked.length >= 25, `checked ${checked.length} controls`);
          const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
          assert.ok(widths.scroll <= widths.client, `no horizontal scroll at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          session.assertClean();
        } finally {
          await session.close();
        }
      }
    }
  },

  {
    name: "U7 AE6 ending the night with open tabs is refused and names those guests; after closing them it ends and the register shows closed",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { night } = await startHostNightViaForm(session, "Porch party");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Bourbon Neat", "Riley");
        await openTabViaRegister(session, "Sky");

        // Paid needs a collector first; nothing closes without one.
        const rileyId = await tabCard(page, "Riley").getAttribute("data-tab-id");
        await clickForToast(session, `#registerTabList [data-pay-tab="${rileyId}"]`, "Pick who collected the money for Riley's tab.");
        assert.equal((await tabOf(page, "Riley")).status, "open");
        assert.match(squash(await tabCard(page, "Riley").locator("[data-pay-tab]").textContent()), /^Paid \$3\.00$/, "Paid shows the tab total");

        await clickForToast(session, "#registerEndNight", "Close every tab before ending the night. Still open: Riley, Sky.");
        assert.equal(await page.evaluate((id) => window.__rnmb.state.nights.find((entry) => entry.id === id).endedAt, night.id), null, "the night is still running");
        assert.equal(await page.isVisible("#registerWork"), true);
        assert.equal(squash(await hostNightCard(page, "Porch party").locator("[data-host-night-status]").textContent()), "Running · 2 open tabs");

        const writeOffText = await writeOffTabViaRegister(session, "Sky");
        assert.match(writeOffText, /Write off Sky's tab \(\$0\.00\)\?/);
        assert.equal(await tabCard(page, "Sky").count(), 0, "a closed tab leaves the open list");
        assert.equal((await tabOf(page, "Sky")).status, "written_off");
        await clickForToast(session, "#registerEndNight", "Close every tab before ending the night. Still open: Riley.");
        assert.equal(await page.evaluate((id) => window.__rnmb.state.nights.find((entry) => entry.id === id).endedAt, night.id), null);

        const payText = await payTabViaRegister(session, "Riley", "Casey");
        assert.equal(payText, "Close Riley's tab as paid: $3.00 collected by Casey?");
        assert.equal(await tabCard(page, "Riley").count(), 0);
        const riley = await tabOf(page, "Riley");
        assert.deepEqual({ status: riley.status, amountCents: riley.amountCents, collectorName: riley.collectorName }, { status: "paid", amountCents: 300, collectorName: "Casey" });
        assert.match(await page.textContent("#registerTabList"), /No open tabs/);

        let endText = "";
        page.once("dialog", (dialog) => { endText = dialog.message(); });
        await clickForToast(session, "#registerEndNight", "Porch party ended. Its summary is under Host nights in Ledger.");
        assert.match(endText, /End "Porch party"\?/);
        const ended = await page.evaluate((id) => window.__rnmb.state.nights.find((entry) => entry.id === id), night.id);
        assert.ok(ended.endedAt, "the night has an ended time");
        await page.waitForSelector("#registerClosed", { state: "visible" });
        assert.equal(await page.isVisible("#registerWork"), false, "the register shows its closed state");
        assert.equal((await page.textContent("#registerClosedMessage")).trim(), REGISTER_CLOSED_MESSAGE);
        assert.equal(await page.isVisible("#registerLocalBanner"), true, "the banner stays on the closed register");
        assert.equal(squash(await hostNightCard(page, "Porch party").locator("[data-host-night-status]").textContent()), "Ended");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("rnmb-command-center-v1")).nights.find((entry) => entry.kind === "host").endedAt !== null), true, "stored");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 AE8 a paid and a written-off tab show the collector's money by buyer and the write-off by buyer; Settle Up reads exactly as before",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.click('.tab-button[data-tab="ledger"]');
        const settleBefore = { lines: (await page.locator("#settleList .stack-item").allTextContents()).map(squash), html: await page.innerHTML("#settleList") };
        assert.ok(settleBefore.lines.length >= 4, "demo Settle Up has a line per person");
        assert.match(await page.textContent("#hostNightList"), /No host nights yet/);

        await startHostNightViaForm(session, "Guest party");
        await openRegister(session);
        await openTabViaRegister(session, "Morgan");
        await ringUpToTab(session, "Boilermaker", "Morgan");
        await ringUpToTab(session, "Bourbon Neat", "Morgan");
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Glass of Red", "Riley");
        await payTabViaRegister(session, "Morgan", "Jordan");
        const writeOffText = await writeOffTabViaRegister(session, "Riley");
        assert.match(writeOffText, /Write off Riley's tab \(\$3\.75\)\?/);
        await clickForToast(session, "#registerEndNight", "Guest party ended. Its summary is under Host nights in Ledger.");

        await exitRegisterTo(page, "ledger");
        assert.equal(await page.locator("#hostNightList .host-night-card").count(), 1, "only host nights are listed");
        const card = hostNightCard(page, "Guest party");
        assert.equal(squash(await card.locator("[data-host-night-status]").textContent()), "Ended");
        assert.match(squash(await card.locator("header").textContent()), /2 of 2 tabs closed/);
        // Boilermaker $4.00: bourbon (Alex) 206.96c and lager (Jordan) 187.5c of cost -> 210 / 190. Bourbon Neat $3.00 -> Alex.
        assert.equal(squash(await card.locator('[data-collector="Jordan"] [data-collector-total]').textContent()), "$7.00");
        assert.deepEqual(await hostNightRows(page, "Guest party", '[data-collector="Jordan"]'), ["for Alex $5.10", "for Jordan $1.90"]);
        // Glass of Red $3.75 from Sam's red.
        assert.equal(squash(await card.locator("[data-written-off-total]").textContent()), "$3.75");
        assert.deepEqual(await hostNightRows(page, "Guest party", "[data-written-off-group]"), ["from Sam's stock $3.75"]);

        const settleAfter = { lines: (await page.locator("#settleList .stack-item").allTextContents()).map(squash), html: await page.innerHTML("#settleList") };
        assert.deepEqual(settleAfter.lines, settleBefore.lines, "every Settle Up line reads the same");
        assert.equal(settleAfter.html, settleBefore.html, "Settle Up output is byte-identical");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 AE1 paying the margarita tab attributes $5.00 as Sam $3.61, Alex $1.20, Jordan $0.19 under the collector",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await addAe1Margarita(session);
        await startHostNightViaForm(session, "Margarita night");
        await openRegister(session);
        await openTabViaRegister(session, "Quinn");
        assert.match(await registerItem(page, "Margarita").textContent(), /\$5\.00/);
        await ringUpToTab(session, "Margarita", "Quinn");
        assert.equal((await tabCard(page, "Quinn").locator("[data-tab-total]").textContent()).trim(), "$5.00");
        await payTabViaRegister(session, "Quinn", "Casey");
        assert.equal((await tabOf(page, "Quinn")).amountCents, 500);

        await exitRegisterTo(page, "ledger");
        const card = hostNightCard(page, "Margarita night");
        assert.equal(squash(await card.locator("[data-host-night-status]").textContent()), "Running · 0 open tabs", "not ended yet");
        assert.equal(squash(await card.locator('[data-collector="Casey"] [data-collector-total]').textContent()), "$5.00");
        assert.deepEqual(await hostNightRows(page, "Margarita night", '[data-collector="Casey"]'), ["for Sam $3.61", "for Alex $1.20", "for Jordan $0.19"]);
        assert.match(squash(await card.locator("[data-written-off]").textContent()), /Nothing written off/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 AE2 editing the tequila price and the markup after ring-up leaves the open tab total and the attribution unchanged",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await addAe1Margarita(session);
        await startHostNightViaForm(session, "Price change night");
        await openRegister(session);
        await openTabViaRegister(session, "Quinn");
        await ringUpToTab(session, "Margarita", "Quinn");

        // The tequila's purchase price doubles (as a sync from another device would), and the markup drops to 0%.
        await exitRegisterTo(page, "menu");
        await page.evaluate(() => {
          const r = window.__rnmb;
          r.state.bottles.find((bottle) => bottle.nickname === "Sam's tequila").price = 60;
          localStorage.setItem("rnmb-command-center-v1", JSON.stringify(r.state));
          r.render();
        });
        await setPricingViaForm(session, { markupPercent: 0, increment: "0.50" });
        // 2 oz of $60 tequila 473.2c + triple sec 78.9c + lime 12.5c = 564.6c -> $6.00 at 0%.
        assert.equal((await menuCard(page, "Margarita").locator("[data-menu-price]").textContent()).trim(), "$6.00", "new ring-ups use the new figures");

        await openRegister(session);
        assert.match(await registerItem(page, "Margarita").textContent(), /\$6\.00/);
        assert.equal((await tabCard(page, "Quinn").locator("[data-tab-total]").textContent()).trim(), "$5.00", "the open tab still shows $5.00");
        assert.match(await registerTab(page, "Quinn").textContent(), /\$5\.00/);
        assert.match(squash(await tabCard(page, "Quinn").locator("[data-pay-tab]").textContent()), /^Paid \$5\.00$/);
        await payTabViaRegister(session, "Quinn", "Casey");
        assert.equal((await tabOf(page, "Quinn")).amountCents, 500);

        await exitRegisterTo(page, "ledger");
        assert.deepEqual(await hostNightRows(page, "Price change night", '[data-collector="Casey"]'), ["for Sam $3.61", "for Alex $1.20", "for Jordan $0.19"], "the attribution is unchanged");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 a crew register shot raises Tonight, Overview, Recent Logs and Crew counts; guest and voided crew ring-ups add nothing",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session, "Crew check night");
        const figures = async () => {
          await page.click('.tab-button[data-tab="tonight"]');
          const casey = page.locator("#personConsumption .consumption-card", { hasText: "Casey" });
          return {
            casey: (await casey.count()) ? squash(await casey.locator(":scope > strong").textContent()) : null,
            consumptionEmpty: /No pours logged for the active night/.test(await page.textContent("#personConsumption")),
            timeline: squash(await page.textContent("#pourTimeline")),
            consumed: (await page.textContent("#metricConsumed")).trim(),
            recent: squash(await page.locator("#recentNights .stack-item", { hasText: "Crew check night" }).textContent()),
            crew: squash(await page.locator("#personList .person-card", { hasText: "Casey" }).textContent()),
            meta: squash(await page.textContent("#activeNightMeta"))
          };
        };
        const before = await figures();
        assert.equal(before.consumptionEmpty, true);
        assert.equal(before.consumed, "0.0");
        assert.match(before.recent, /0\.0 standard drinks/);
        assert.match(before.crew, /· 0 pours/);

        // A guest's Bourbon Neat is not crew consumption.
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Bourbon Neat", "Riley");
        await exitRegisterTo(page, "tonight");
        assert.deepEqual(await figures(), before, "a guest ring-up changes no crew figure");

        // Casey's Bourbon Neat on the register: 2 oz at 45% = 1.5 standard drinks.
        await openRegister(session);
        await registerItem(page, "Bourbon Neat").click();
        await registerCrew(page, "Casey").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey. No charge.");
        await exitRegisterTo(page, "tonight");
        const after = await figures();
        assert.equal(after.consumptionEmpty, false);
        assert.equal(after.casey, "1.5", "Casey's Tonight standard drinks");
        assert.equal(after.consumed, "1.5", "Overview Tonight Consumed");
        assert.match(after.recent, /1\.5 standard drinks/, "Recent Logs night total");
        assert.match(after.crew, /· 1 pours/, "one register drink is one pour");
        assert.match(after.meta, /1 pours logged/);
        assert.match(after.timeline, /Casey had Bourbon Neat Bar register · 1\.5 standard drinks/);

        // A second crew shot, voided, contributes nothing.
        const second = await page.evaluate(async () => {
          const r = window.__rnmb;
          const night = r.state.nights.find((entry) => entry.kind === "host" && !entry.endedAt);
          const casey = r.state.people.find((person) => person.name === "Casey");
          const bottle = r.state.bottles.find((entry) => entry.nickname === "The Briefing Bottle");
          const menuItem = r.state.menuItems.find((item) => item.name === "Bourbon Neat");
          const record = r.buildRingUp({ nightId: night.id, kind: "crew", personId: casey.id, menuItemId: menuItem.id, sources: [{ bottleId: bottle.id, amount: 2 }] });
          const rung = await r.hostAction("", (db) => db.ringUp(record));
          return { id: record.id, rung };
        });
        assert.equal(second.rung, true);
        assert.equal((await figures()).casey, "3.0", "the second shot counts while it stands");
        assert.equal(await page.evaluate((id) => window.__rnmb.hostAction("", (db) => db.voidRingUp(id)), second.id), true);
        assert.deepEqual(await figures(), after, "a voided crew ring-up contributes nothing");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 a voided guest item contributes nothing to the tab total, the amount collected or the summary",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session, "Void night");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Bourbon Neat", "Riley");
        await ringUpToTab(session, "Boilermaker", "Riley");
        await openTabViaRegister(session, "Sky");
        await ringUpToTab(session, "Glass of Red", "Sky");

        const voidItem = async (name) => {
          const id = await page.evaluate((itemName) => window.__rnmb.state.ringUps.find((ringUp) => ringUp.menuItemName === itemName).id, name);
          await clickForToast(session, `#registerTabList [data-void-ring-up="${id}"]`, "Item voided and its stock restored.");
        };
        await voidItem("Boilermaker");
        await voidItem("Glass of Red");
        assert.equal((await tabCard(page, "Riley").locator("[data-tab-total]").textContent()).trim(), "$3.00");
        await payTabViaRegister(session, "Riley", "Jordan");
        assert.equal((await tabOf(page, "Riley")).amountCents, 300, "the voided Boilermaker is not collected");
        await writeOffTabViaRegister(session, "Sky");

        await exitRegisterTo(page, "ledger");
        assert.equal(squash(await hostNightCard(page, "Void night").locator('[data-collector="Jordan"] [data-collector-total]').textContent()), "$3.00");
        assert.deepEqual(await hostNightRows(page, "Void night", '[data-collector="Jordan"]'), ["for Alex $3.00"], "no lager share from the voided Boilermaker");
        assert.match(squash(await hostNightCard(page, "Void night").locator("[data-written-off]").textContent()), /Nothing written off/, "the voided red is worth nothing written off");
        assert.equal(await hostNightCard(page, "Void night").locator("[data-written-off-group]").count(), 0);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "U7 close-out, end-night and Host nights controls have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          const checked = [];
          const check = async (selector) => {
            const count = await page.locator(selector).count();
            assert.ok(count > 0, `${selector} is present at ${viewport.width}px`);
            for (let index = 0; index < count; index += 1) {
              const locator = page.locator(selector).nth(index);
              await locator.scrollIntoViewIfNeeded();
              const box = await locator.boundingBox();
              assert.ok(box && box.width > 0 && box.height > 0, `${selector} #${index} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
              checked.push(selector);
            }
          };
          const noHorizontalScroll = async (where) => {
            const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
            assert.ok(widths.scroll <= widths.client, `no horizontal scroll on ${where} at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          };

          await startHostNightViaForm(session, "A host night with a rather long name for narrow screens");
          await openRegister(session);
          await openTabViaRegister(session, "Riley Montgomery-Fitzgerald");
          await ringUpToTab(session, "Boilermaker", "Riley Montgomery-Fitzgerald");
          await openTabViaRegister(session, "Sky");
          await ringUpToTab(session, "Glass of Red", "Sky");
          for (const selector of ["#registerEndNight", "#registerTabList select[name='collectorId']", "#registerTabList [data-pay-tab]", "#registerTabList [data-write-off-tab]"]) {
            await check(selector);
          }
          await noHorizontalScroll("the register");

          await payTabViaRegister(session, "Riley Montgomery-Fitzgerald", "Jordan");
          await writeOffTabViaRegister(session, "Sky");
          await exitRegisterTo(page, "ledger");
          for (const selector of [
            "#hostNightList .host-night-card",
            "#hostNightList [data-host-night-status]",
            "#hostNightList [data-collector] [data-collector-total]",
            "#hostNightList [data-collector] li",
            "#hostNightList [data-written-off-total]",
            "#hostNightList [data-written-off-group] li",
            "#settleList .stack-item"
          ]) {
            await check(selector);
          }
          assert.ok(checked.length >= 13, `checked ${checked.length} elements`);
          await noHorizontalScroll("Ledger");
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
