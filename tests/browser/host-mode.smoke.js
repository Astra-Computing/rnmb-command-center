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
const POURED_BOTTLE_MESSAGE = "Crew drinks have been poured from this stock item and charged against it, so it cannot be deleted. Set its remaining level to empty instead.";

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
  // rnmb_payments comes from supabase/crew-balance.sql, which needs host-mode.sql first.
  const NEW_TABLES = ["rnmb_menu_items", "rnmb_recipe_ingredients", "rnmb_guest_tabs", "rnmb_ring_ups", "rnmb_ring_up_lines", "rnmb_stock_adjustments", "rnmb_payments"];
  const NEW_COLUMNS = /"(measure|unit_oz|kind|ended_at|markup_percent|rounding_increment_cents)"\s*:/;
  // crew-balance.sql columns (buyer_id alone is not one: rnmb_bottles has always had it).
  const CREW_BALANCE_COLUMNS = /"(cost_cents|buyer_name|written_off_by|written_off_by_name)"\s*:/;
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
      if (method === "GET") {
        if (/cost_cents|buyer_name/.test(url.searchParams.get("select") || "")) {
          served400.push(`${method} ${path}${url.search}`);
          return json(400, { code: "42703", message: `column ${path}.cost_cents does not exist` });
        }
        return json(200, store[path]);
      }

      const body = request.postData() || "";
      if (NEW_COLUMNS.test(body) || (path === "rnmb_pours" && CREW_BALANCE_COLUMNS.test(body))) {
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
const bottleIdOf = (page, nickname) => page.evaluate((name) => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === name).id, nickname);

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

/**
 * Write a tab off from its register card, charged to a crew member (0.7.8); returns
 * the confirm text. The cost is the card's own "Write off $x.xx" figure.
 */
async function writeOffTabViaRegister(session, guestName, writerName = "Casey") {
  const { page } = session;
  const card = tabCard(page, guestName);
  const tabId = await card.getAttribute("data-tab-id");
  await card.locator("select[name='writtenOffBy']").selectOption(await personIdOf(page, writerName));
  const cost = (await card.locator("[data-write-off-tab]").textContent()).trim().replace("Write off ", "");
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, `#registerTabList [data-write-off-tab="${tabId}"]`, `${guestName}'s tab written off by ${writerName}, at ${cost}.`);
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

// ---------- crew balance helpers (U4, U5) ------------------------------------------------

const CREW_BALANCE_SQL_MESSAGE = "Crew balances are not set up on the shared database yet. Run supabase/crew-balance.sql in Supabase, then reload.";

/** AE1's bottle: Sam's $40, 25 oz rye, so every ounce costs 160 cents. */
async function addAe1Balance(session) {
  const rye = await addTypeViaForm(session, { name: "Rye", category: "Whiskey", abv: 45 });
  return addPricedStockViaForm(session, { typeId: rye.id, nickname: "Sam's rye", size: 25, price: 40, buyerName: "Sam" });
}

/** Set a stock level through the repository (the Inventory card has its own scenario). */
async function setLevel(page, bottleId, newRemaining) {
  const ok = await page.evaluate(
    ({ bottleId, newRemaining }) => window.__rnmb.hostAction("", (db) => db.correctStock({ bottleId, newRemaining })),
    { bottleId, newRemaining }
  );
  assert.equal(ok, true, "the level was set");
}

/** Every Ledger balance row as { name: "is owed $3.20 +$3.20" }, straight from the page. */
async function balanceRows(page) {
  await page.click('.tab-button[data-tab="ledger"]');
  const rows = await page.locator("#balanceList .balance-row").evaluateAll((elements) => elements.map((row) => [
    row.dataset.balancePerson,
    `${row.querySelector("[data-balance-status]").textContent} ${row.querySelector("[data-balance-amount]").textContent}`
  ]));
  return Object.fromEntries(rows);
}

/** The suggested payments as they read on screen, in order. */
const suggestionTexts = (page) => page.locator("#paymentSuggestions [data-payment-text]").allTextContents();

/** The balances the domain derives, keyed by name: the numbers behind the Ledger. */
const balanceCents = (page) => page.evaluate(() => Object.fromEntries(window.__rnmb.crewBalances().map((entry) => [entry.name, entry.cents])));

/** Tap Paid on the suggested payment at `index` (confirm is auto-accepted); returns the confirm text. */
async function paySuggestion(session, index, toastText) {
  const { page } = session;
  await page.click('.tab-button[data-tab="ledger"]');
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, `#paymentSuggestions [data-pay-suggestion] >> nth=${index}`, toastText);
  return dialogMessage;
}

/** Record a payment through the Ledger's manual form. */
async function recordPaymentViaForm(session, { fromName, toName, amount, toast }) {
  const { page } = session;
  await page.click('.tab-button[data-tab="ledger"]');
  await page.selectOption("#paymentForm [name='fromPersonId']", await personIdOf(page, fromName));
  await page.selectOption("#paymentForm [name='toPersonId']", await personIdOf(page, toName));
  await page.fill("#paymentForm [name='amount']", amount);
  await clickForToast(session, "#paymentSubmit", toast);
}

/** Pick a person in the quick log, then tap one of their offered drinks by its name. */
async function quickLog(session, personName, itemName, toastText) {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  await page.click(`#quickLogPeople [data-quick-person="${await personIdOf(page, personName)}"]`);
  await clickForToast(session, `#quickLogItems button:has-text("${itemName}")`, toastText);
}

// ---------- end-of-night recap helpers (U6) -----------------------------------------------

/** End the active crew night from Tonight's Wrap Up panel; returns the confirm text. */
async function endCrewNightViaRecap(session, nightName = "Friday Recon") {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(session, "#endCrewNight", `${nightName} ended. Check the recap for anything missed.`);
  return dialogMessage;
}

/** Every recap card as it reads on screen, in order. */
async function recapCards(page) {
  await page.click('.tab-button[data-tab="tonight"]');
  return page.locator("#nightRecapList .recap-card").evaluateAll((cards) => cards.map((card) => ({
    person: card.querySelector(".person-copy strong").textContent,
    total: card.querySelector("[data-recap-cost]").textContent,
    meta: card.querySelector("[data-recap-meta]").textContent,
    drinks: [...card.querySelectorAll(".recap-drink")].map((drink) => `${drink.querySelector("strong").textContent} — ${drink.querySelector("small").textContent}`)
  })));
}

const recapCard = (page, personId) => page.locator(`#nightRecapList .recap-card[data-recap-person="${personId}"]`);

/** Void one drink from a person's recap card; returns the confirm text. */
async function voidFromRecap(session, personId, index = 0) {
  const { page } = session;
  await page.click('.tab-button[data-tab="tonight"]');
  let dialogMessage = "";
  page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
  await clickForToast(
    session,
    `#nightRecapList .recap-card[data-recap-person="${personId}"] [data-recap-void] >> nth=${index}`,
    "Drink voided. Stock and balances are back to where they were."
  );
  return dialogMessage;
}

/** Leave the register for a dashboard tab. */
async function exitRegisterTo(page, tab) {
  await page.click("#exitRegister");
  await page.waitForSelector(".app-shell", { state: "visible" });
  await page.click(`.tab-button[data-tab="${tab}"]`);
}

// ---------- review-fix helpers ------------------------------------------------------------

/**
 * A stub Supabase that HAS run supabase/host-mode.sql: every table answers 200,
 * writes change `store` the way PostgREST would (eq / in / not.in / is filters,
 * merge-duplicates upserts, return=representation), and every request is kept
 * in `log` in order. Set `stub.fail = (entry) => status | null` to fail a request.
 */
function hostModeStub(seed = {}, { crewBalance = true, pourCostColumns = crewBalance } = {}) {
  // crewBalance: false = supabase/crew-balance.sql not run (rnmb_payments answers 404).
  // pourCostColumns: false = rnmb_pours has no cost_cents/buyer_id/buyer_name (a select naming them answers 400).
  // stub.rpc[name] = (payload) => result answers POST rpc/<name>; any other function is unexpected.
  const TABLES = [
    "rnmb_people", "rnmb_beverage_types", "rnmb_bottles", "rnmb_nights", "rnmb_pours", "rnmb_settings",
    "rnmb_menu_items", "rnmb_recipe_ingredients", "rnmb_guest_tabs", "rnmb_ring_ups", "rnmb_ring_up_lines", "rnmb_stock_adjustments",
    ...(crewBalance ? ["rnmb_payments"] : [])
  ];
  const store = Object.fromEntries(TABLES.map((table) => [table, JSON.parse(JSON.stringify(seed[table] || []))]));
  const log = [];
  const unexpected = [];
  const stub = { store, log, unexpected, fail: null, rpc: {} };

  const matches = (row, params) => Array.from(params.entries()).every(([key, value]) => {
    if (["select", "order", "on_conflict"].includes(key)) return true;
    const cell = row[key] === undefined || row[key] === null ? null : String(row[key]);
    const list = (text) => text.replace(/^\(|\)$/g, "").split(",");
    if (value === "is.null") return cell === null;
    if (value === "not.is.null") return cell !== null;
    if (value.startsWith("eq.")) return cell === value.slice(3);
    if (value.startsWith("in.")) return list(value.slice(3)).includes(cell);
    if (value.startsWith("not.in.")) return !list(value.slice(7)).includes(cell);
    unexpected.push(`filter ${key}=${value}`);
    return false;
  });

  stub.routes = async (page) => {
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
      const prefer = request.headers().prefer || "";
      const raw = request.postData() || "";
      const entry = { method, path, query: url.search, prefer, body: raw ? JSON.parse(raw) : null };
      const json = (status, body) => route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

      if (path === "rpc/rnmb_authorized") return json(200, true);
      if (method !== "GET") log.push(entry);
      const failure = stub.fail && stub.fail(entry);
      if (failure) return json(failure, { code: "XX000", message: "Simulated failure" });

      if (path === "rpc/rnmb_start_host_night") {
        const { id, name, date } = entry.body.payload;
        store.rnmb_nights.push({ id, name, date, kind: "host", ended_at: null });
        return json(200, id);
      }
      const rpcName = path.startsWith("rpc/") ? path.slice(4) : null;
      if (rpcName && stub.rpc[rpcName]) return json(200, stub.rpc[rpcName](entry.body.payload));
      if (!crewBalance && path === "rnmb_payments") {
        return json(404, { code: "PGRST205", message: "Could not find the table 'public.rnmb_payments' in the schema cache" });
      }
      if (!pourCostColumns && path === "rnmb_pours" && method === "GET" && /cost_cents/.test(url.searchParams.get("select") || "")) {
        return json(400, { code: "42703", message: "column rnmb_pours.cost_cents does not exist" });
      }
      if (path.startsWith("rpc/") || !TABLES.includes(path)) {
        unexpected.push(`${method} ${path}`);
        return json(404, { code: "PGRST202", message: "not stubbed" });
      }
      const rows = store[path];
      if (method === "GET") return json(200, rows.filter((row) => matches(row, url.searchParams)));
      if (method === "POST") {
        const incoming = Array.isArray(entry.body) ? entry.body : [entry.body];
        const merge = prefer.includes("resolution=merge-duplicates");
        for (const row of incoming) {
          const existing = rows.find((candidate) => String(candidate.id) === String(row.id));
          if (existing && !merge) return json(409, { code: "23505", message: "duplicate key" });
        }
        incoming.forEach((row) => {
          const existing = rows.find((candidate) => String(candidate.id) === String(row.id));
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
        });
        return route.fulfill({ status: 201, body: "" });
      }
      if (method === "PATCH") {
        const hit = rows.filter((row) => matches(row, url.searchParams));
        hit.forEach((row) => Object.assign(row, entry.body));
        return prefer.includes("return=representation") ? json(200, hit) : route.fulfill({ status: 204, body: "" });
      }
      if (method === "DELETE") {
        store[path] = rows.filter((row) => !matches(row, url.searchParams));
        return route.fulfill({ status: 204, body: "" });
      }
      unexpected.push(`${method} ${path}`);
      return route.fulfill({ status: 405, body: "" });
    });
  };
  return stub;
}

/** Seed rows for hostModeStub: two crew nights, a rum and a lime, and a two-line Rum Punch. */
function hostModeSeed() {
  const ids = {
    sam: "11111111-1111-4111-8111-111111111111",
    rum: "22222222-2222-4222-8222-222222222222",
    lime: "33333333-3333-4333-8333-333333333333",
    nightOne: "44444444-4444-4444-8444-444444444444",
    nightTwo: "55555555-5555-4555-8555-555555555555",
    punch: "66666666-6666-4666-8666-666666666666",
    rumLine: "77777777-7777-4777-8777-777777777777",
    limeLine: "88888888-8888-4888-8888-888888888888"
  };
  return {
    ids,
    seed: {
      rnmb_people: [{ id: ids.sam, name: "Sam", color: "#ef4444" }],
      rnmb_beverage_types: [
        { id: ids.rum, name: "Rum", category: "Rum", abv: 40, measure: "oz", unit_oz: null },
        { id: ids.lime, name: "Lime juice", category: "Mixer", abv: 0, measure: "oz", unit_oz: null }
      ],
      rnmb_nights: [
        { id: ids.nightOne, name: "Night One", date: "2026-09-15", kind: "crew", ended_at: null },
        { id: ids.nightTwo, name: "Night Two", date: "2026-09-16", kind: "crew", ended_at: null }
      ],
      rnmb_settings: [{ id: true, active_night_id: ids.nightTwo, responsible_mode: true, markup_percent: 0, rounding_increment_cents: 25 }],
      rnmb_menu_items: [{ id: ids.punch, name: "Rum Punch", kind: "cocktail" }],
      rnmb_recipe_ingredients: [
        { id: ids.rumLine, menu_item_id: ids.punch, type_id: ids.rum, amount: 2, line_no: 0 },
        { id: ids.limeLine, menu_item_id: ids.punch, type_id: ids.lime, amount: 1, line_no: 1 }
      ]
    }
  };
}

/** Chrome logs a failed fetch, and commitSave logs the non-refusal error; both are expected when a scenario fails a request on purpose. */
const simulatedFailure = (message) => message.type() === "error" &&
  (message.text().includes("status of 500") || message.text().includes("Simulated failure"));

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
        assert.equal((await page.locator("#ingredientRows [data-amount-label]").nth(0).textContent()).trim(), "Amount", "the unit lives in the dropdown now, not the label");
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
        assert.equal(await row.nth(0).locator("select[name='ingredientType']").inputValue(), original.ingredients[0].typeId);
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
        assert.equal((await page.textContent("#registerConfirm")).trim(), "Pour for Casey · $2.76 at cost");
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey · $2.76 at cost.");

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
    name: "U7 AE8 a paid and a written-off tab show the collector's money by buyer and the write-off by buyer, and both land in Crew Balances",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const balancesBefore = await balanceRows(page);
        assert.deepEqual(Object.values(balancesBefore), new Array(4).fill("all square $0.00"), "every demo balance starts square");
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

        // AE3's shape: the collector carries what they collected, the buyers are credited
        // their share, and Casey (who wrote Riley's tab off) covers the red's $3.74 of cost.
        assert.deepEqual(await balanceRows(page), {
          Alex: "is owed $5.10 +$5.10",
          Jordan: "owes $5.10 -$5.10",
          Sam: "is owed $3.74 +$3.74",
          Casey: "owes $3.74 -$3.74"
        });
        const cents = await balanceCents(page);
        assert.equal(Object.values(cents).reduce((sum, value) => sum + value, 0), 0, "balances sum to zero");
        assert.deepEqual(await suggestionTexts(page), ["Jordan pays Alex $5.10", "Casey pays Sam $3.74"]);
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
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey · $2.76 at cost.");
        await exitRegisterTo(page, "tonight");
        const after = await figures();
        assert.equal(after.consumptionEmpty, false);
        assert.equal(after.casey, "1.5", "Casey's Tonight standard drinks");
        assert.equal(after.consumed, "1.5", "Overview Tonight Consumed");
        assert.match(after.recent, /1\.5 standard drinks/, "Recent Logs night total");
        assert.match(after.crew, /· 1 pours/, "one register drink is one pour");
        assert.match(after.meta, /1 pours logged/);
        // The timeline names the stock a crew drink drew, not where it was rung up:
        // nothing records whether a drink came from the register or from quick log.
        assert.match(after.timeline, /Casey had Bourbon Neat The Briefing Bottle · 1\.5 standard drinks/);

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
          for (const selector of [
            "#registerEndNight",
            "#registerTabList select[name='collectorId']",
            "#registerTabList select[name='writtenOffBy']",
            "#registerTabList [data-pay-tab]",
            "#registerTabList [data-write-off-tab]"
          ]) {
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
            "#balanceList .balance-row",
            "#balanceList [data-balance-amount]",
            "#paymentSuggestions [data-pay-suggestion]"
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
  },

  {
    name: "Review #1 shared database: a failed recipe write while editing a menu item leaves the old recipe whole; a good edit upserts, then prunes, then renames",
    async run({ browser }) {
      const { ids, seed } = hostModeSeed();
      const stub = hostModeStub(seed);
      const session = await openPage(browser, { routes: stub.routes, allowConsole: simulatedFailure });
      const { page } = session;
      const recipe = () => stub.store.rnmb_recipe_ingredients
        .filter((row) => row.menu_item_id === ids.punch)
        .map((row) => ({ id: row.id, type_id: row.type_id, amount: Number(row.amount) }));
      const edit = (ingredients, name = "Rum Punch") => page.evaluate(({ ids, ingredients, name }) => window.__rnmb.hostAction(
        "Menu item updated.",
        (db) => db.saveMenuItem({ id: ids.punch, name, kind: "cocktail", ingredients })
      ), { ids, ingredients, name });
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.hostModeAvailable), true);
        const original = recipe();
        assert.equal(original.length, 2);

        // The recipe write fails, whatever the order the repository sends things in.
        stub.fail = (entry) => (entry.method === "POST" && entry.path === "rnmb_recipe_ingredients" ? 500 : null);
        const failed = await edit([{ id: ids.rumLine, typeId: ids.rum, amount: 3 }, { typeId: ids.lime, amount: 1.5 }], "Rum Punch Deluxe");
        assert.equal(failed, false, "the save reports failure");
        assert.deepEqual(recipe(), original, "the shared recipe survives a failed ingredient write");
        const reloaded = await page.evaluate((id) => window.__rnmb.state.menuItems.find((item) => item.id === id), ids.punch);
        assert.equal(reloaded.ingredients.length, 2, "this browser reloads the intact recipe");
        assert.equal(reloaded.name, "Rum Punch", "the rename did not land before the recipe did");

        // A good edit: keep the rum line (new amount), replace the lime line.
        stub.fail = null;
        const logStart = stub.log.length;
        const saved = await edit([{ id: ids.rumLine, typeId: ids.rum, amount: 3 }, { typeId: ids.lime, amount: 1.5 }], "Rum Punch Deluxe");
        assert.equal(saved, true);
        const writes = stub.log.slice(logStart);
        const upsert = writes.findIndex((entry) => entry.method === "POST" && entry.path === "rnmb_recipe_ingredients");
        const prune = writes.findIndex((entry) => entry.method === "DELETE" && entry.path === "rnmb_recipe_ingredients");
        const rename = writes.findIndex((entry) => entry.method === "PATCH" && entry.path === "rnmb_menu_items");
        assert.ok(upsert >= 0 && prune > upsert && rename > prune, `upsert, then prune, then rename (got ${writes.map((entry) => `${entry.method} ${entry.path}`).join(", ")})`);
        assert.match(writes[upsert].prefer, /resolution=merge-duplicates/);
        assert.match(decodeURIComponent(writes[prune].query), new RegExp(`id=not\\.in\\.\\(.*${ids.rumLine}`), "the prune keeps the lines still in the recipe");
        const stored = recipe();
        assert.equal(stored.length, 2);
        assert.deepEqual(stored.find((row) => row.id === ids.rumLine), { id: ids.rumLine, type_id: ids.rum, amount: 3 }, "the kept line keeps its id");
        assert.equal(stored.some((row) => row.id === ids.limeLine), false, "the replaced line is gone");
        const state = await page.evaluate((id) => window.__rnmb.state.menuItems.find((item) => item.id === id), ids.punch);
        assert.equal(state.name, "Rum Punch Deluxe");
        assert.deepEqual(state.ingredients.map((ingredient) => ingredient.id).sort(), stored.map((row) => row.id).sort(), "this browser holds the ids the database holds");
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Review #2 shared database: night and host-night saves never send pricing or responsible_mode, and a pricing save sends only pricing",
    async run({ browser }) {
      const { ids, seed } = hostModeSeed();
      const stub = hostModeStub(seed);
      const session = await openPage(browser, { routes: stub.routes });
      const { page } = session;
      const PRICING = ["markup_percent", "rounding_increment_cents"];
      const settingsWritesSince = (start) => stub.log.slice(start).filter((entry) => entry.path.startsWith("rnmb_settings"));
      const settingsKeys = (entry) => Object.keys(Array.isArray(entry.body) ? entry.body[0] : entry.body).filter((key) => key !== "id").sort();
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.hostModeAvailable), true);
        // Another device raises the markup after this page loaded.
        Object.assign(stub.store.rnmb_settings[0], { markup_percent: 50, rounding_increment_cents: 50 });

        let start = stub.log.length;
        await page.click('.tab-button[data-tab="tonight"]');
        await page.selectOption("#nightSelect", ids.nightOne);
        await session.waitForToast("Active night switched.");
        let sent = settingsWritesSince(start);
        assert.ok(sent.length >= 1, "the switch wrote settings");
        sent.forEach((entry) => assert.deepEqual(settingsKeys(entry).filter((key) => PRICING.includes(key)), [], `the night switch sent no pricing: ${JSON.stringify(entry.body)}`));
        assert.equal(stub.store.rnmb_settings[0].active_night_id, ids.nightOne);
        assert.equal(Number(stub.store.rnmb_settings[0].markup_percent), 50, "the other device's markup survives a night switch");

        // Hydration reminders were removed, so nothing writes responsible_mode any
        // more. The column keeps whatever it held; the client never sends it.
        assert.equal(await page.locator("#responsibleMode").count(), 0, "the hydration toggle is gone");
        settingsWritesSince(0).forEach((entry) => assert.ok(
          !settingsKeys(entry).includes("responsible_mode"),
          `no settings write sends responsible_mode: ${JSON.stringify(entry.body)}`
        ));

        start = stub.log.length;
        await page.fill("#nightForm [name='name']", "Night Three");
        await clickForToast(session, "#nightForm button[type='submit']", "Night log started.");
        sent = settingsWritesSince(start);
        assert.ok(sent.length >= 1, "a new night becomes active");
        sent.forEach((entry) => assert.deepEqual(settingsKeys(entry).filter((key) => PRICING.includes(key)), [], "a new crew night sent no pricing"));

        start = stub.log.length;
        await startHostNightViaForm(session, "Review host night");
        sent = settingsWritesSince(start);
        assert.ok(sent.length >= 1, "the host night becomes active");
        sent.forEach((entry) => assert.deepEqual(settingsKeys(entry).filter((key) => PRICING.includes(key)), [], "starting a host night sent no pricing"));
        assert.equal(Number(stub.store.rnmb_settings[0].markup_percent), 50, "the markup is still the other device's");
        assert.equal(Number(stub.store.rnmb_settings[0].rounding_increment_cents), 50);

        // The other way round: another device switches the night, then this one saves pricing.
        stub.store.rnmb_settings[0].active_night_id = ids.nightTwo;
        start = stub.log.length;
        await setPricingViaForm(session, { markupPercent: 25, increment: "0.25" });
        sent = settingsWritesSince(start);
        assert.equal(sent.length, 1, "one pricing write");
        assert.deepEqual(settingsKeys(sent[0]), PRICING, `pricing sends only pricing: ${JSON.stringify(sent[0].body)}`);
        assert.equal(stub.store.rnmb_settings[0].active_night_id, ids.nightTwo, "the other device's active night survives a pricing save");
        assert.equal(Number(stub.store.rnmb_settings[0].markup_percent), 25);

        // A database with no settings row yet still gets one.
        stub.store.rnmb_settings = [];
        await page.click('.tab-button[data-tab="tonight"]');
        await page.selectOption("#nightSelect", ids.nightOne);
        await page.waitForFunction(() => window.__toasts.at(-1) === "Active night switched.");
        assert.equal(stub.store.rnmb_settings.length, 1, "the settings row was created");
        assert.equal(stub.store.rnmb_settings[0].active_night_id, ids.nightOne);
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Review #4 a crew ring-up is voided from the register: it asks first, stock comes back and the crew figures drop",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session, "Crew void night");
        const bourbon = await page.evaluate(() => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "The Briefing Bottle").id);
        const stockBefore = await stockOf(page, bourbon);
        await page.click('.tab-button[data-tab="tonight"]');
        const consumedBefore = (await page.textContent("#metricConsumed")).trim();

        await openRegister(session);
        await registerItem(page, "Bourbon Neat").click();
        await registerCrew(page, "Casey").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey · $2.76 at cost.");
        const ringUpId = await page.evaluate(() => window.__rnmb.state.ringUps[0].id);
        assert.equal(await stockOf(page, bourbon), Math.round((stockBefore - 2) * 100) / 100);

        const voidButton = `#registerWork [data-void-ring-up="${ringUpId}"]`;
        assert.equal(await page.locator(voidButton).count(), 1, "the crew drink has a Void control on the register");
        let dialogMessage = "";
        page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
        await clickForToast(session, voidButton, "Item voided and its stock restored.");
        assert.match(dialogMessage, /Void Bourbon Neat poured for Casey\?/);
        assert.equal(await stockOf(page, bourbon), stockBefore, "the bourbon comes back");
        const voided = await page.evaluate((id) => window.__rnmb.state.ringUps.find((ringUp) => ringUp.id === id), ringUpId);
        assert.ok(voided.voidedAt, "voided, not deleted");
        assert.equal(await page.locator(voidButton).count(), 0, "a voided crew drink leaves the list");

        await exitRegisterTo(page, "tonight");
        assert.equal((await page.textContent("#metricConsumed")).trim(), consumedBefore, "crew consumption is back where it was");
        assert.match(await page.textContent("#personConsumption"), /No pours logged for the active night/);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Review #5 tapping Open tab again while the first call is pending opens exactly one tab",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session);
        await openRegister(session);
        await page.evaluate(() => {
          const repo = window.__rnmb.repository;
          const original = repo.openTab;
          window.__openTabCalls = 0;
          repo.openTab = async (tab) => {
            window.__openTabCalls += 1;
            await new Promise((resolve) => { window.__releaseOpenTab = resolve; });
            return original(tab);
          };
        });
        await page.fill("#registerTabForm [name='guestName']", "Riley");
        await page.click("#registerOpenTab");
        await page.waitForFunction(() => typeof window.__releaseOpenTab === "function");
        const pending = await page.evaluate(() => {
          document.querySelector("#registerTabForm").requestSubmit();
          document.querySelector("#registerOpenTab").click();
          return {
            calls: window.__openTabCalls,
            buttonDisabled: document.querySelector("#registerOpenTab").disabled,
            inputDisabled: document.querySelector("#registerTabForm [name='guestName']").disabled
          };
        });
        assert.equal(pending.calls, 1, "a second submit while pending makes no second call");
        assert.equal(pending.buttonDisabled, true, "Open tab is disabled while pending");
        assert.equal(pending.inputDisabled, true, "the guest name is locked while pending");

        const toastCount = (await session.toasts()).length;
        await page.evaluate(() => window.__releaseOpenTab());
        await page.waitForFunction((count) => window.__toasts.slice(count).includes("Tab opened for Riley."), toastCount);
        const tabs = await page.evaluate(() => window.__rnmb.state.guestTabs.filter((tab) => tab.guestName === "Riley").length);
        assert.equal(tabs, 1, "exactly one tab for Riley");
        assert.equal(await page.evaluate(() => window.__openTabCalls), 1);
        assert.equal(await page.isEnabled("#registerOpenTab"), true, "Open tab is usable again");
        assert.equal(await page.isEnabled("#registerTabForm [name='guestName']"), true, "the guest name is usable again");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Review #6 a markup with more than two decimals, or of 10000% or more, is refused and nothing is saved",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      const pricing = () => page.evaluate(() => {
        const stored = JSON.parse(localStorage.getItem("rnmb-command-center-v1"));
        const live = window.__rnmb.state;
        return { live: [live.markupPercent, live.roundingIncrementCents], stored: [stored.markupPercent, stored.roundingIncrementCents] };
      });
      try {
        const before = await pricing();
        await page.click('.tab-button[data-tab="menu"]');
        for (const [markup, message] of [
          ["12.345", "The markup is kept to two decimal places, and 12.345 has more."],
          ["10000", "The markup must be below 10000%."]
        ]) {
          await page.fill("#pricingForm [name='markupPercent']", markup);
          await page.fill("#pricingForm [name='roundingIncrement']", "0.50");
          await clickForToast(session, "#pricingForm button[type='submit']", message);
          assert.deepEqual(await pricing(), before, `markup ${markup} saved nothing`);
        }
        assert.ok(!(await session.toasts()).includes("Pricing saved."), "no pricing save was reported");
        await setPricingViaForm(session, { markupPercent: "12.35", increment: "0.50" });
        assert.equal(await page.evaluate(() => window.__rnmb.state.markupPercent), 12.35, "two decimals are still accepted");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  // ---------- crew running balance: U3 state and repositories ----------

  {
    name: "Crew U3 local: recording then voiding a payment moves both balances by the amount and returns crewBalances to their start; refusals save nothing",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        assert.equal(await page.evaluate(() => window.__rnmb.crewBalanceAvailable), true, "local mode always has crew balances");
        const result = await page.evaluate(async () => {
          const r = window.__rnmb;
          const idOf = (name) => r.state.people.find((person) => person.name === name).id;
          const cents = () => Object.fromEntries(r.crewBalances().map((entry) => [entry.name, entry.cents]));
          const stored = () => JSON.parse(localStorage.getItem("rnmb-command-center-v1")).payments;
          const alex = idOf("Alex");
          const sam = idOf("Sam");
          const id = crypto.randomUUID();
          const start = cents();
          const recorded = await r.hostAction("Payment recorded.", (db) => db.recordPayment({ id, fromPersonId: alex, toPersonId: sam, amountCents: 320 }));
          const middle = cents();
          const storedMiddle = stored();
          const refusals = [];
          for (const attempt of [
            { id, fromPersonId: alex, toPersonId: sam, amountCents: 320 },
            { id: crypto.randomUUID(), fromPersonId: alex, toPersonId: alex, amountCents: 320 },
            { id: crypto.randomUUID(), fromPersonId: alex, toPersonId: sam, amountCents: 0 },
            { id: crypto.randomUUID(), fromPersonId: alex, toPersonId: sam, amountCents: 12.5 },
            { id: crypto.randomUUID(), fromPersonId: alex, toPersonId: crypto.randomUUID(), amountCents: 100 }
          ]) {
            refusals.push(await r.hostAction("Payment recorded.", (db) => db.recordPayment(attempt)));
          }
          const afterRefusals = { count: r.state.payments.length, cents: cents() };
          const voided = await r.hostAction("Payment voided.", (db) => db.voidPayment(id));
          const voidTwice = await r.hostAction("Payment voided.", (db) => db.voidPayment(id));
          return { start, recorded, middle, storedMiddle, refusals, afterRefusals, voided, voidTwice, end: cents(), payments: r.state.payments, storedEnd: stored(), alex, sam };
        });
        assert.equal(result.recorded, true);
        assert.equal(result.middle.Alex, result.start.Alex + 320, "the payer's balance rises by the amount");
        assert.equal(result.middle.Sam, result.start.Sam - 320, "the payee's balance falls by the amount");
        assert.equal(result.storedMiddle.length, 1, "localStorage holds the payment");
        assert.deepEqual(result.refusals, [false, false, false, false, false]);
        assert.deepEqual(result.afterRefusals, { count: 1, cents: result.middle }, "refused payments changed nothing");
        assert.equal(result.voided, true);
        assert.equal(result.voidTwice, false);
        assert.deepEqual(result.end, result.start, "voiding returns every balance to its start");
        assert.equal(result.payments.length, 1, "the voided payment stays in the history");
        const [payment] = result.payments;
        assert.deepEqual(
          { ...payment, paidAt: typeof payment.paidAt, voidedAt: typeof payment.voidedAt },
          { id: payment.id, fromPersonId: result.alex, fromName: "Alex", toPersonId: result.sam, toName: "Sam", amountCents: 320, paidAt: "string", voidedAt: "string" }
        );
        assert.ok(result.storedEnd[0].voidedAt, "localStorage holds the void");
        const toasts = await session.toasts();
        for (const message of [
          "That payment was already recorded.",
          "A payment must be between two different crew members.",
          "A payment needs an amount above zero, in whole cents.",
          "The crew member who was paid does not exist.",
          "That payment was already voided."
        ]) {
          assert.ok(toasts.includes(message), `refusal toast "${message}" shown`);
        }
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U3 local: a crew pour logged through the form is stamped with its cost and buyer from the bottle, debiting the drinker and crediting the buyer",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const bottle = await page.evaluate(() => window.__rnmb.state.bottles.find((entry) => entry.nickname === "The Briefing Bottle"));
        const before = await page.evaluate(() => Object.fromEntries(window.__rnmb.crewBalances().map((entry) => [entry.name, entry.cents])));
        await logPourViaForm(session, { personName: "Sam", bottleId: bottle.id, amount: 1.5 });
        const result = await page.evaluate((bottleId) => {
          const r = window.__rnmb;
          const night = r.state.nights.find((entry) => entry.id === r.state.activeNightId);
          const pour = night.pours.find((entry) => entry.bottleId === bottleId);
          const stored = JSON.parse(localStorage.getItem("rnmb-command-center-v1"));
          const storedPour = stored.nights.flatMap((entry) => entry.pours).find((entry) => entry.id === pour.id);
          return {
            pour,
            storedPour,
            alexId: r.state.people.find((person) => person.name === "Alex").id,
            cents: Object.fromEntries(r.crewBalances().map((entry) => [entry.name, entry.cents]))
          };
        }, bottle.id);
        // $34.99 / 25.36 oz x 1.5 oz = 206.96 cents, rounded half-up once.
        assert.equal(result.pour.costCents, 207);
        assert.equal(result.pour.buyerId, result.alexId);
        assert.equal(result.pour.buyerName, "Alex");
        assert.deepEqual(
          { costCents: result.storedPour.costCents, buyerId: result.storedPour.buyerId, buyerName: result.storedPour.buyerName },
          { costCents: 207, buyerId: result.alexId, buyerName: "Alex" },
          "localStorage keeps the stamp"
        );
        assert.equal(result.cents.Sam, before.Sam - 207);
        assert.equal(result.cents.Alex, before.Alex + 207);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U3 local: an ended crew night still takes crew ring-ups, voids and pours but never guest drinks; an ended host night stays locked; a write-off records its author",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const crew = await page.evaluate(async () => {
          const r = window.__rnmb;
          const D = window.RNMBDomain;
          const nightId = r.state.activeNightId;
          const jordan = r.state.people.find((person) => person.name === "Jordan").id;
          const item = r.state.menuItems.find((entry) => entry.name === "Bourbon Neat");
          const sources = () => D.preselectSources(item, r.state.bottles).flatMap((ingredient) => ingredient.sources);
          const crewDrink = () => r.buildRingUp({ nightId, kind: "crew", personId: jordan, menuItemId: item.id, sources: sources() });
          const first = crewDrink();
          const openRingUp = await r.hostAction("Crew drink.", (db) => db.ringUp(first));
          const ended = await r.hostAction("Night ended.", (db) => db.endNight(nightId));
          const endedAt = r.state.nights.find((night) => night.id === nightId).endedAt;
          const endTwice = await r.hostAction("Night ended.", (db) => db.endNight(nightId));
          const late = crewDrink();
          const lateRingUp = await r.hostAction("Crew drink.", (db) => db.ringUp(late));
          const lateVoid = await r.hostAction("Voided.", (db) => db.voidRingUp(late.id));
          const guest = r.buildRingUp({ nightId, kind: "guest", tabId: crypto.randomUUID(), menuItemId: item.id, sources: sources() });
          const guestRingUp = await r.hostAction("Guest drink.", (db) => db.ringUp(guest));
          const saved = r.state.ringUps.find((entry) => entry.id === first.id);
          return {
            openRingUp, ended, endedAt, endTwice, lateRingUp, lateVoid, guestRingUp,
            lateVoided: Boolean(r.state.ringUps.find((entry) => entry.id === late.id)?.voidedAt),
            firstLineCosts: saved.lines.map((line) => line.costCents),
            guestSaved: r.state.ringUps.some((entry) => entry.id === guest.id),
            jordanCents: r.crewBalances().find((entry) => entry.name === "Jordan").cents,
            storedEndedAt: JSON.parse(localStorage.getItem("rnmb-command-center-v1")).nights.find((night) => night.id === nightId).endedAt
          };
        });
        assert.equal(crew.openRingUp, true, "a crew ring-up on an open crew night is accepted");
        assert.equal(crew.ended, true);
        assert.ok(crew.endedAt, "the crew night has an end time");
        assert.equal(crew.storedEndedAt, crew.endedAt, "localStorage keeps the crew night's end time");
        assert.equal(crew.endTwice, false);
        assert.equal(crew.lateRingUp, true, "an ended crew night still takes a crew ring-up");
        assert.equal(crew.lateVoid, true, "and voids it");
        assert.equal(crew.lateVoided, true);
        assert.equal(crew.guestRingUp, false, "a guest ring-up on a crew night is refused");
        assert.equal(crew.guestSaved, false);
        assert.ok(crew.firstLineCosts.every((cost) => cost > 0), "crew lines carry their cost");
        assert.ok(crew.jordanCents < 0, "the crew drink debits Jordan");

        // The active night is the ended crew night: the pour form still logs to it.
        const bottle = await page.evaluate(() => window.__rnmb.state.bottles.find((entry) => entry.nickname === "The Briefing Bottle"));
        await logPourViaForm(session, { personName: "Casey", bottleId: bottle.id, amount: 1 });

        const { nightId, tabId, started, opened } = await startLocalHostNightWithTab(page);
        assert.equal(started && opened, true);
        const host = await page.evaluate(async ({ nightId, tabId }) => {
          const r = window.__rnmb;
          const D = window.RNMBDomain;
          const casey = r.state.people.find((person) => person.name === "Casey").id;
          const skyId = crypto.randomUUID();
          const skyOpened = await r.hostAction("Tab opened.", (db) => db.openTab({ id: skyId, nightId, guestName: "Sky" }));
          const unknownAuthor = await r.hostAction("Written off.", (db) => db.closeTab({ id: tabId, status: "written_off", writtenOffBy: crypto.randomUUID() }));
          const authored = await r.hostAction("Written off.", (db) => db.closeTab({ id: tabId, status: "written_off", writtenOffBy: casey }));
          const riley = r.state.guestTabs.find((tab) => tab.id === tabId);
          const noAuthor = await r.hostAction("Written off.", (db) => db.closeTab({ id: skyId, status: "written_off" }));
          const skyAuthored = await r.hostAction("Written off.", (db) => db.closeTab({ id: skyId, status: "written_off", writtenOffBy: casey }));
          const sky = r.state.guestTabs.find((tab) => tab.id === skyId);
          const ended = await r.hostAction("Host night ended.", (db) => db.endNight(nightId));
          const item = r.state.menuItems.find((entry) => entry.name === "Bourbon Neat");
          const sources = D.preselectSources(item, r.state.bottles).flatMap((ingredient) => ingredient.sources);
          const lockedRingUp = await r.hostAction("Crew drink.", (db) => db.ringUp(r.buildRingUp({ nightId, kind: "crew", personId: casey, menuItemId: item.id, sources })));
          let lockedPour = null;
          try {
            r.preparePour(r.state.nights.find((night) => night.id === nightId), { personId: casey, bottleId: sources[0].bottleId, ounces: 1 });
          } catch (error) {
            lockedPour = error.userMessage;
          }
          return {
            skyOpened, unknownAuthor, authored, noAuthor, skyAuthored, ended, lockedRingUp, lockedPour, casey,
            riley: { status: riley.status, writtenOffBy: riley.writtenOffBy, writtenOffByName: riley.writtenOffByName },
            sky: { status: sky.status, writtenOffBy: sky.writtenOffBy, writtenOffByName: sky.writtenOffByName }
          };
        }, { nightId, tabId });
        assert.equal(host.skyOpened, true);
        assert.equal(host.unknownAuthor, false, "an unknown author is refused");
        assert.equal(host.authored, true);
        assert.deepEqual(host.riley, { status: "written_off", writtenOffBy: host.casey, writtenOffByName: "Casey" });
        assert.equal(host.noAuthor, false, "a write-off with no author is refused while crew balances are on (0.7.8)");
        assert.equal(host.skyAuthored, true);
        assert.deepEqual(host.sky, { status: "written_off", writtenOffBy: host.casey, writtenOffByName: "Casey" });
        assert.equal(host.ended, true, "endNight ends a host night once its tabs are closed");
        assert.equal(host.lockedRingUp, false, "an ended host night takes no crew ring-up");
        assert.equal(host.lockedPour, "This host night has ended, so no more pours can be logged.");

        const toasts = await session.toasts();
        for (const message of [
          "This crew night has already ended.",
          "Drinks and guest tabs only exist on a host night.",
          "The crew member writing off the tab does not exist.",
          "A written-off tab needs the crew member who wrote it off.",
          "This host night has ended, so nothing more can be changed on it."
        ]) {
          assert.ok(toasts.includes(message), `refusal toast "${message}" shown`);
        }
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U3 pre-migration database: rnmb_payments 404 turns crew balances off, a logged pour sends no cost columns, and payments and replacing with payment history are refused",
    async run({ browser }) {
      const { store, served400, unexpected, writes, routes, expected404 } = preMigrationStub();
      const sam = "11111111-1111-4111-8111-111111111111";
      const rum = "22222222-2222-4222-8222-222222222222";
      const bottleId = "33333333-3333-4333-8333-333333333333";
      const nightId = "44444444-4444-4444-8444-444444444444";
      store.rnmb_people.push({ id: sam, name: "Sam", color: "#ef4444" }, { id: "99999999-9999-4999-8999-999999999999", name: "Alex", color: "#f97316" });
      store.rnmb_beverage_types.push({ id: rum, name: "Rum", category: "Rum", abv: 40 });
      store.rnmb_bottles.push({ id: bottleId, type_id: rum, nickname: "Sam's rum", size_oz: 25, remaining_oz: 25, price: 40, buyer_id: sam, purchase_date: "2026-09-16" });
      store.rnmb_nights.push({ id: nightId, name: "Crew night", date: "2026-09-16" });
      store.rnmb_settings[0].active_night_id = nightId;
      const CREW_BALANCE_SQL_MESSAGE = "Crew balances are not set up on the shared database yet. Run supabase/crew-balance.sql in Supabase, then reload.";
      const session = await openPage(browser, { routes, allowConsole: expected404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.deepEqual(
          await page.evaluate(() => [window.__rnmb.syncMode, window.__rnmb.hostModeAvailable, window.__rnmb.crewBalanceAvailable]),
          ["supabase", false, false]
        );

        await logPourViaForm(session, { personName: "Alex", bottleId, amount: 2 });
        const pourWrites = writes.filter((write) => write.table === "rnmb_pours");
        assert.equal(pourWrites.length, 1, "the pour was inserted");
        assert.deepEqual(Object.keys(pourWrites[0].rows[0]).sort(), ["abv_snapshot", "bottle_id", "id", "night_id", "ounces", "person_id", "poured_at"]);
        const pour = await page.evaluate(() => window.__rnmb.state.nights[0].pours[0]);
        assert.deepEqual([pour.costCents, pour.buyerId, pour.buyerName], [null, null, null], "no cost stamp the database cannot keep");

        const outcome = await page.evaluate(async () => {
          const r = window.__rnmb;
          const [a, b] = r.state.people;
          const recorded = await r.hostAction("Payment recorded.", (db) => db.recordPayment({ id: crypto.randomUUID(), fromPersonId: a.id, toPersonId: b.id, amountCents: 100 }));
          const endCrew = await r.hostAction("Night ended.", (db) => db.endNight(r.state.activeNightId));
          let replaceRefusal = null;
          try {
            await r.repository.saveAll({
              ...r.state,
              payments: [window.RNMBDomain.normalizePayment({ id: crypto.randomUUID(), fromPersonId: a.id, fromName: a.name, toPersonId: b.id, toName: b.name, amountCents: 100 })]
            });
          } catch (error) {
            replaceRefusal = error.userMessage;
          }
          return { recorded, endCrew, replaceRefusal, payments: r.state.payments.length };
        });
        assert.equal(outcome.recorded, false);
        assert.equal(outcome.endCrew, false);
        assert.equal(outcome.payments, 0);
        assert.equal(
          outcome.replaceRefusal,
          `This data includes crew balance records (payments, drink costs, write-off authors or an ended crew night). ${CREW_BALANCE_SQL_MESSAGE}`
        );
        const toasts = await session.toasts();
        assert.ok(toasts.includes(CREW_BALANCE_SQL_MESSAGE), "the payment refusal names crew-balance.sql");
        assert.ok(toasts.includes(HOST_MODE_SQL_MESSAGE), "ending a crew night without host mode names host-mode.sql");
        assert.ok(!toasts.some((text) => /Save failed/.test(text)), `no failed save, saw: ${toasts.join(" | ")}`);
        assert.deepEqual(served400, [], "no payload or read named a crew-balance column");
        assert.deepEqual(unexpected, [], "no function call, payments write or delete was sent");
        assert.ok(!writes.some((write) => write.table === "rnmb_payments"));
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U3 host-mode database without crew-balance.sql: payments 404 or missing pour cost columns turn crew balances off; ending a host night uses rnmb_end_host_night and a write-off sends no author",
    async run({ browser }) {
      const CREW_BALANCE_SQL_MESSAGE = "Crew balances are not set up on the shared database yet. Run supabase/crew-balance.sql in Supabase, then reload.";
      const { ids, seed } = hostModeSeed();
      const stub = hostModeStub(seed, { crewBalance: false });
      stub.rpc.rnmb_open_tab = (payload) => {
        stub.store.rnmb_guest_tabs.push({ id: payload.id, night_id: payload.night_id, guest_name: payload.guest_name, status: "open", opened_at: payload.opened_at });
        return payload.id;
      };
      stub.rpc.rnmb_close_tab = (payload) => {
        Object.assign(stub.store.rnmb_guest_tabs.find((tab) => tab.id === payload.id), { status: payload.status, closed_at: new Date().toISOString() });
        return payload.id;
      };
      stub.rpc.rnmb_end_host_night = (payload) => {
        stub.store.rnmb_nights.find((night) => night.id === payload.id).ended_at = new Date().toISOString();
        return payload.id;
      };
      const payments404 = (message) => resourceStatusError(message, 404, (url) => url.includes("/rest/v1/rnmb_payments?"));
      const session = await openPage(browser, { routes: stub.routes, allowConsole: payments404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.deepEqual(await page.evaluate(() => [window.__rnmb.hostModeAvailable, window.__rnmb.crewBalanceAvailable]), [true, false]);
        const outcome = await page.evaluate(async ({ crewNightId }) => {
          const r = window.__rnmb;
          const sam = r.state.people[0].id;
          const nightId = crypto.randomUUID();
          const tabId = crypto.randomUUID();
          const steps = [];
          steps.push(await r.hostAction("Host night started.", (db) => db.startHostNight({ id: nightId, name: "Party" })));
          steps.push(await r.hostAction("Tab opened.", (db) => db.openTab({ id: tabId, nightId, guestName: "Riley" })));
          steps.push(await r.hostAction("Written off.", (db) => db.closeTab({ id: tabId, status: "written_off", writtenOffBy: sam })));
          const tab = r.state.guestTabs.find((entry) => entry.id === tabId);
          steps.push(await r.hostAction("Host night ended.", (db) => db.endNight(nightId)));
          const endCrew = await r.hostAction("Night ended.", (db) => db.endNight(crewNightId));
          const recorded = await r.hostAction("Payment recorded.", (db) => db.recordPayment({ id: crypto.randomUUID(), fromPersonId: sam, toPersonId: sam, amountCents: 1 }));
          return {
            steps, endCrew, recorded,
            tab: [tab.status, tab.writtenOffBy, tab.writtenOffByName],
            hostEnded: Boolean(r.state.nights.find((night) => night.id === nightId).endedAt)
          };
        }, { crewNightId: ids.nightOne });
        assert.deepEqual(outcome.steps, [true, true, true, true]);
        assert.deepEqual(outcome.tab, ["written_off", null, null], "no author is kept where the database has no column for it");
        assert.equal(outcome.hostEnded, true);
        assert.equal(outcome.endCrew, false, "a crew night cannot end before crew-balance.sql");
        assert.equal(outcome.recorded, false);
        const rpcCalls = stub.log.filter((entry) => entry.path.startsWith("rpc/"));
        assert.deepEqual(rpcCalls.map((entry) => entry.path), ["rpc/rnmb_start_host_night", "rpc/rnmb_open_tab", "rpc/rnmb_close_tab", "rpc/rnmb_end_host_night"]);
        assert.deepEqual(Object.keys(rpcCalls[2].body.payload).sort(), ["id", "status"], "the write-off sends no author");
        const toasts = await session.toasts();
        assert.equal(toasts.filter((text) => text === CREW_BALANCE_SQL_MESSAGE).length, 2, "the crew night end and the payment name crew-balance.sql");
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }

      // Payments present but rnmb_pours lacks the cost columns: still off.
      const partial = hostModeStub(hostModeSeed().seed, { pourCostColumns: false });
      const probe400 = (message) => resourceStatusError(message, 400, (url) => url.includes("/rest/v1/rnmb_pours?select=cost_cents"));
      const second = await openPage(browser, { routes: partial.routes, allowConsole: probe400 });
      try {
        await second.waitForToast("Connected to Supabase.");
        assert.deepEqual(await second.page.evaluate(() => [window.__rnmb.hostModeAvailable, window.__rnmb.crewBalanceAvailable]), [true, false]);
        assert.deepEqual(partial.unexpected, []);
        second.assertClean();
      } finally {
        await second.close();
      }
    }
  },

  {
    name: "Crew U3 migrated database: payments, pour costs and write-off authors load into state; record, void and end-night call the new functions; replacing the data rewrites payments around people",
    async run({ browser }) {
      const { ids, seed } = hostModeSeed();
      const alex = "99999999-9999-4999-8999-999999999999";
      const bottle = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const hostNight = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const payment = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      seed.rnmb_people.push({ id: alex, name: "Alex", color: "#f97316" });
      seed.rnmb_bottles = [{ id: bottle, type_id: ids.rum, nickname: "Sam's rum", size_oz: 25, remaining_oz: 23, price: 40, buyer_id: ids.sam, purchase_date: "2026-09-15" }];
      seed.rnmb_pours = [{
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", night_id: ids.nightOne, person_id: alex, bottle_id: bottle, ounces: 2, abv_snapshot: 40,
        poured_at: "2026-09-15T21:00:00Z", cost_cents: 320, buyer_id: ids.sam, buyer_name: "Sam"
      }];
      seed.rnmb_nights.push({ id: hostNight, name: "Old party", date: "2026-09-10", kind: "host", ended_at: "2026-09-11T03:00:00Z" });
      seed.rnmb_guest_tabs = [{
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", night_id: hostNight, guest_name: "Quinn", status: "written_off", collector_id: null, collector_name: null,
        amount_cents: null, written_off_by: alex, written_off_by_name: "Alex", opened_at: "2026-09-10T20:00:00Z", closed_at: "2026-09-11T01:00:00Z"
      }];
      seed.rnmb_payments = [{
        id: payment, from_person_id: ids.sam, from_name: "Sam", to_person_id: alex, to_name: "Alex", amount_cents: 500, paid_at: "2026-09-12T12:00:00Z", voided_at: null
      }];
      const stub = hostModeStub(seed);
      const personName = (id) => stub.store.rnmb_people.find((person) => person.id === id).name;
      stub.rpc.rnmb_record_payment = (p) => {
        stub.store.rnmb_payments.push({ id: p.id, from_person_id: p.from_person_id, from_name: personName(p.from_person_id), to_person_id: p.to_person_id, to_name: personName(p.to_person_id), amount_cents: p.amount_cents, paid_at: new Date().toISOString(), voided_at: null });
        return p.id;
      };
      stub.rpc.rnmb_void_payment = (p) => {
        stub.store.rnmb_payments.find((row) => row.id === p.id).voided_at = new Date().toISOString();
        return p.id;
      };
      stub.rpc.rnmb_end_night = (p) => {
        stub.store.rnmb_nights.find((night) => night.id === p.id).ended_at = new Date().toISOString();
        return p.id;
      };
      const session = await openPage(browser, { routes: stub.routes });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        const loaded = await page.evaluate(({ nightOne }) => {
          const r = window.__rnmb;
          return {
            flags: [r.hostModeAvailable, r.crewBalanceAvailable],
            payments: r.state.payments,
            pour: r.state.nights.find((night) => night.id === nightOne).pours[0],
            tab: r.state.guestTabs[0],
            cents: Object.fromEntries(r.crewBalances().map((entry) => [entry.name, entry.cents]))
          };
        }, { nightOne: ids.nightOne });
        assert.deepEqual(loaded.flags, [true, true]);
        assert.deepEqual(loaded.payments, [{ id: payment, fromPersonId: ids.sam, fromName: "Sam", toPersonId: alex, toName: "Alex", amountCents: 500, paidAt: "2026-09-12T12:00:00Z", voidedAt: null }]);
        assert.deepEqual([loaded.pour.costCents, loaded.pour.buyerId, loaded.pour.buyerName], [320, ids.sam, "Sam"]);
        assert.deepEqual([loaded.tab.writtenOffBy, loaded.tab.writtenOffByName], [alex, "Alex"]);
        assert.deepEqual(loaded.cents, { Sam: 820, Alex: -820 }, "Sam paid Alex $5.00 and Alex drank $3.20 of Sam's rum");

        const logStart = stub.log.length;
        const actions = await page.evaluate(async ({ sam, alex, nightOne }) => {
          const r = window.__rnmb;
          const cents = () => Object.fromEntries(r.crewBalances().map((entry) => [entry.name, entry.cents]));
          const id = crypto.randomUUID();
          const recorded = await r.hostAction("Payment recorded.", (db) => db.recordPayment({ id, fromPersonId: alex, toPersonId: sam, amountCents: 820 }));
          const settled = cents();
          const voided = await r.hostAction("Payment voided.", (db) => db.voidPayment(id));
          const unsettled = cents();
          const ended = await r.hostAction("Night ended.", (db) => db.endNight(nightOne));
          return { id, recorded, settled, voided, unsettled, ended, endedAt: r.state.nights.find((night) => night.id === nightOne).endedAt };
        }, { sam: ids.sam, alex, nightOne: ids.nightOne });
        assert.deepEqual([actions.recorded, actions.voided, actions.ended], [true, true, true]);
        assert.deepEqual(actions.settled, { Sam: 0, Alex: 0 });
        assert.deepEqual(actions.unsettled, { Sam: 820, Alex: -820 });
        assert.ok(actions.endedAt, "the crew night ended");
        const calls = stub.log.slice(logStart);
        assert.deepEqual(calls.map((entry) => entry.path), ["rpc/rnmb_record_payment", "rpc/rnmb_void_payment", "rpc/rnmb_end_night"]);
        assert.deepEqual(calls[0].body.payload, { id: actions.id, from_person_id: alex, to_person_id: ids.sam, amount_cents: 820 });
        assert.deepEqual(calls[1].body.payload, { id: actions.id });
        assert.deepEqual(calls[2].body.payload, { id: ids.nightOne });

        const replaceStart = stub.log.length;
        await page.evaluate(() => window.__rnmb.repository.saveAll(window.__rnmb.state));
        const replace = stub.log.slice(replaceStart).map((entry) => ({ ...entry, key: `${entry.method} ${entry.path}` }));
        const at = (key) => replace.findIndex((entry) => entry.key === key);
        assert.ok(at("DELETE rnmb_payments") >= 0 && at("DELETE rnmb_payments") < at("DELETE rnmb_people"), "payments are deleted before people");
        assert.ok(at("POST rnmb_payments") > at("POST rnmb_people"), "payments are inserted after people");
        const paymentRows = replace[at("POST rnmb_payments")].body;
        assert.equal(paymentRows.length, 2, "both payments, the voided one included, are written back");
        assert.deepEqual(Object.keys(paymentRows[0]), ["id", "from_person_id", "from_name", "to_person_id", "to_name", "amount_cents", "paid_at", "voided_at"]);
        const pourRow = replace[at("POST rnmb_pours")].body[0];
        assert.deepEqual([pourRow.cost_cents, pourRow.buyer_id, pourRow.buyer_name], [320, ids.sam, "Sam"]);
        const tabRow = replace[at("POST rnmb_guest_tabs")].body[0];
        assert.deepEqual([tabRow.written_off_by, tabRow.written_off_by_name], [alex, "Alex"]);
        assert.equal(stub.store.rnmb_payments.length, 2);
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U4 AE1, AE2 the Ledger reads Alex owes $3.20, suggests one payment, and Paid settles both to $0.00",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const bottle = await addAe1Balance(session);
        await logPourViaForm(session, { personName: "Alex", bottleId: bottle.id, amount: 2 });
        await logPourViaForm(session, { personName: "Sam", bottleId: bottle.id, amount: 1 });

        assert.deepEqual(await balanceRows(page), {
          Alex: "owes $3.20 -$3.20",
          Jordan: "all square $0.00",
          Sam: "is owed $3.20 +$3.20",
          Casey: "all square $0.00"
        }, "Sam's own 1 oz costs him nothing; Alex's 2 oz is $3.20 of Sam's bottle");
        assert.deepEqual(await balanceCents(page), { Alex: -320, Jordan: 0, Sam: 320, Casey: 0 });
        assert.match(await page.textContent("#balanceSummary"), /1 owed · 1 owes · everything nets to \$0\.00\./);
        assert.deepEqual(await suggestionTexts(page), ["Alex pays Sam $3.20"]);

        const confirmText = await paySuggestion(session, 0, "Payment recorded: Alex paid Sam $3.20.");
        assert.match(confirmText, /^Record that Alex paid Sam \$3\.20\?/);
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: 0, Sam: 0, Casey: 0 }, "AE2: both read $0.00");
        assert.deepEqual(await balanceRows(page), {
          Alex: "all square $0.00",
          Jordan: "all square $0.00",
          Sam: "all square $0.00",
          Casey: "all square $0.00"
        });
        assert.match(await page.textContent("#balanceSummary"), /Everyone's square/);
        assert.match(await page.textContent("#paymentSuggestions"), /Nothing to settle/);
        assert.deepEqual(await page.locator("#paymentList [data-payment-text]").allTextContents(), ["Alex paid Sam $3.20"]);
        const payments = await page.evaluate(() => window.__rnmb.state.payments);
        assert.equal(payments.length, 1, "one payment, saved once");
        assert.deepEqual([payments[0].fromName, payments[0].toName, payments[0].amountCents, payments[0].voidedAt], ["Alex", "Sam", 320, null]);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U4 a payment recorded by hand can be voided, which puts both balances back; bad amounts save nothing",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const bottle = await addAe1Balance(session);
        await logPourViaForm(session, { personName: "Alex", bottleId: bottle.id, amount: 2 });
        const before = await balanceCents(page);

        await page.click('.tab-button[data-tab="ledger"]');
        await page.selectOption("#paymentForm [name='fromPersonId']", await personIdOf(page, "Alex"));
        await page.selectOption("#paymentForm [name='toPersonId']", await personIdOf(page, "Alex"));
        await page.fill("#paymentForm [name='amount']", "3.20");
        await clickForToast(session, "#paymentSubmit", "A payment goes between two different crew members.");
        await page.selectOption("#paymentForm [name='toPersonId']", await personIdOf(page, "Sam"));
        await page.fill("#paymentForm [name='amount']", "3.205");
        await clickForToast(session, "#paymentSubmit", "Enter the amount in dollars, like 3.20.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.payments.length), 0, "no refused payment was saved");
        assert.deepEqual(await balanceCents(page), before);

        await recordPaymentViaForm(session, { fromName: "Alex", toName: "Sam", amount: "3.20", toast: "Payment recorded: Alex paid Sam $3.20." });
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: 0, Sam: 0, Casey: 0 });
        assert.equal(await page.inputValue("#paymentForm [name='amount']"), "", "the amount field is cleared for the next one");

        let voidText = "";
        page.once("dialog", (dialog) => { voidText = dialog.message(); });
        await clickForToast(session, "#paymentList [data-void-payment]", "Payment voided. Both balances are back where they were.");
        assert.match(voidText, /^Void Alex's \$3\.20 payment to Sam\?/);
        assert.deepEqual(await balanceCents(page), before, "voiding restores both balances");
        assert.deepEqual(await suggestionTexts(page), ["Alex pays Sam $3.20"], "and the suggestion comes back");
        assert.equal(await page.locator("#paymentList .payment-row.is-voided").count(), 1, "the voided payment stays in the history");
        assert.equal(await page.locator("#paymentList [data-void-payment]").count(), 0, "with no second Void");
        assert.ok(await page.evaluate(() => window.__rnmb.state.payments[0].voidedAt), "the void is recorded, not deleted");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U4 AE5 removing a crew member at -$5.00 is refused, and works once they are settled",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        // Sam sent Casey $5.00, so Casey is $5.00 down until she pays it back.
        await recordPaymentViaForm(session, { fromName: "Sam", toName: "Casey", amount: "5.00", toast: "Payment recorded: Sam paid Casey $5.00." });
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: 0, Sam: 500, Casey: -500 });

        const removeCasey = async () => {
          await page.click('.tab-button[data-tab="crew"]');
          const caseyId = await personIdOf(page, "Casey");
          return page.locator(`#personList [data-remove-person="${caseyId}"]`).click();
        };
        await removeCasey();
        await session.waitForToast("Casey owes $5.00, so they stay on the roster for now. Settle up in the Ledger until they read $0.00, then remove them.");
        assert.ok(await page.evaluate(() => window.__rnmb.state.people.some((person) => person.name === "Casey")), "Casey is still on the roster");

        assert.deepEqual(await suggestionTexts(page), ["Casey pays Sam $5.00"]);
        await paySuggestion(session, 0, "Payment recorded: Casey paid Sam $5.00.");
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: 0, Sam: 0, Casey: 0 });

        await removeCasey();
        await session.waitForToast("Person removed.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.people.some((person) => person.name === "Casey")), false, "a settled person can leave");
        const cents = await balanceCents(page);
        assert.equal(cents.Casey, undefined, "Casey is gone from the balances");
        assert.deepEqual(cents, { Alex: 0, Jordan: 0, Sam: 0 }, "and nobody else moved");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U4 Ledger balances, suggestions, the payment form and its history have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          const bottle = await addAe1Balance(session);
          await logPourViaForm(session, { personName: "Alex", bottleId: bottle.id, amount: 2 });
          await recordPaymentViaForm(session, { fromName: "Jordan", toName: "Casey", amount: "1.00", toast: "Payment recorded: Jordan paid Casey $1.00." });

          for (const selector of [
            "#balanceList .balance-row",
            "#balanceList [data-balance-status]",
            "#balanceList [data-balance-amount]",
            "#paymentSuggestions [data-pay-suggestion]",
            "#paymentForm select",
            "#paymentForm [name='amount']",
            "#paymentSubmit",
            "#paymentList .payment-row",
            "#paymentList [data-void-payment]"
          ]) {
            const count = await page.locator(selector).count();
            assert.ok(count > 0, `${selector} is present at ${viewport.width}px`);
            for (let index = 0; index < count; index += 1) {
              const locator = page.locator(selector).nth(index);
              await locator.scrollIntoViewIfNeeded();
              const box = await locator.boundingBox();
              assert.ok(box && box.width > 0 && box.height > 0, `${selector} #${index} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
            }
          }
          const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
          assert.ok(widths.scroll <= widths.client, `no horizontal scroll on Ledger at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          session.assertClean();
        } finally {
          await session.close();
        }
      }
    }
  },

  {
    name: "Crew U4 pre-migration database: the Ledger names supabase/crew-balance.sql, shows no balances and locks the payment form",
    async run({ browser }) {
      const { seed } = hostModeSeed();
      const stub = hostModeStub(seed, { crewBalance: false });
      const payments404 = (message) => resourceStatusError(message, 404, (url) => url.includes("/rest/v1/rnmb_payments?"));
      const session = await openPage(browser, { routes: stub.routes, allowConsole: payments404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.crewBalanceAvailable), false);
        await page.click('.tab-button[data-tab="ledger"]');
        assert.equal(await page.isVisible("#balanceNotice"), true, "the notice is on screen");
        assert.equal(squash(await page.textContent("#balanceNotice")), CREW_BALANCE_SQL_MESSAGE);
        assert.equal(await page.locator("#balanceList .balance-row").count(), 0, "no balances are shown while they would be wrong");
        assert.match(await page.textContent("#balanceList"), /Balances show up here once crew balances are set up/);
        assert.match(await page.textContent("#paymentSuggestions"), /No suggestions until then/);
        assert.match(await page.textContent("#paymentList"), /Payments can be recorded once crew balances are set up/);
        assert.equal(squash(await page.textContent("#balanceSummary")), "");
        for (const selector of ["#paymentForm [name='fromPersonId']", "#paymentForm [name='toPersonId']", "#paymentForm [name='amount']", "#paymentSubmit"]) {
          assert.equal(await page.isDisabled(selector), true, `${selector} is locked`);
        }
        assert.deepEqual(stub.unexpected, [], "no payment call was sent");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U5 quick log at 400px: two taps log a 1.5 oz pour at cost, and the bottle becomes that person's usual",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404, viewport: { width: 400, height: 900 } });
      const { page } = session;
      try {
        const bottle = await page.evaluate(() => window.__rnmb.state.bottles.find((entry) => entry.nickname === "The Briefing Bottle"));
        await page.click('.tab-button[data-tab="tonight"]');
        assert.match(await page.textContent("#quickLogItems"), /Tap a name to see their usual/);
        assert.match(await page.textContent("#quickLogNight"), /Logging to Friday Recon\./);

        // Tap one: who is drinking. Tap two: what they are drinking.
        await page.click(`#quickLogPeople [data-quick-person="${await personIdOf(page, "Sam")}"]`);
        assert.match(await page.textContent("#quickLogItemsLabel"), /Nothing logged for Sam yet, so here is the shelf/);
        const button = page.locator(`#quickLogItems [data-quick-bottle="${bottle.id}"]`);
        assert.equal(squash(await button.textContent()), "The Briefing Bottle1.5 oz · $2.07", "the tap shows what it pours and what it costs");
        await clickForToast(session, `#quickLogItems [data-quick-bottle="${bottle.id}"]`, "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");

        const logged = await page.evaluate((bottleId) => {
          const r = window.__rnmb;
          const night = r.state.nights.find((entry) => entry.id === r.state.activeNightId);
          return {
            pours: night.pours.length,
            pour: night.pours[0],
            remaining: r.state.bottles.find((entry) => entry.id === bottleId).remaining,
            stored: JSON.parse(localStorage.getItem("rnmb-command-center-v1")).nights.flatMap((entry) => entry.pours).length
          };
        }, bottle.id);
        assert.equal(logged.pours, 1, "one tap, one pour");
        assert.equal(logged.stored, 1);
        assert.equal(logged.pour.ounces, 1.5);
        assert.equal(logged.pour.costCents, 207);
        assert.equal(logged.remaining, 17.7, "the bottle drops by the poured measure");
        // Alex bought the Briefing Bottle, so the cost moves from Sam to Alex.
        assert.deepEqual(await balanceCents(page), { Alex: 207, Jordan: 0, Sam: -207, Casey: 0 });

        await page.click('.tab-button[data-tab="tonight"]');
        assert.match(await page.textContent("#quickLogItemsLabel"), /Sam's usual/);
        assert.deepEqual(
          await page.locator("#quickLogItems button").evaluateAll((buttons) => buttons.map((entry) => entry.querySelector("strong").textContent)),
          ["The Briefing Bottle"],
          "what they logged is what they are offered next time"
        );
        const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        assert.ok(widths.scroll <= widths.client, `no horizontal scroll on Tonight at 400px (scrollWidth ${widths.scroll} > ${widths.client})`);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U5 quick log controls have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          await page.click('.tab-button[data-tab="tonight"]');
          await page.click(`#quickLogPeople [data-quick-person="${await personIdOf(page, "Casey")}"]`);
          for (const selector of ["#quickLogPeople [data-quick-person]", "#quickLogItems button", "#quickLogNight", "#quickLogItemsLabel"]) {
            const count = await page.locator(selector).count();
            assert.ok(count > 0, `${selector} is present at ${viewport.width}px`);
            for (let index = 0; index < count; index += 1) {
              const locator = page.locator(selector).nth(index);
              await locator.scrollIntoViewIfNeeded();
              const box = await locator.boundingBox();
              assert.ok(box && box.width > 0 && box.height > 0, `${selector} #${index} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
              if (selector.includes("button") || selector.includes("quick-person")) {
                assert.ok(box.height >= 44, `${selector} #${index} is a thumb-sized target at ${viewport.width}px (height ${box.height})`);
              }
            }
          }
          const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
          assert.ok(widths.scroll <= widths.client, `no horizontal scroll on Tonight at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          session.assertClean();
        } finally {
          await session.close();
        }
      }
    }
  },

  {
    name: "Crew U5 a margarita quick-logged on a crew night is one crew ring-up drawing three bottles; a split ingredient is refused, never auto-split",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404, viewport: { width: 400, height: 900 } });
      const { page } = session;
      try {
        const types = await addAe1Margarita(session);
        const stock = await page.evaluate(() => Object.fromEntries(window.__rnmb.state.bottles.map((bottle) => [bottle.nickname, bottle.remaining])));

        await quickLog(session, "Alex", "Margarita", "Logged Margarita for Alex · $3.28 at cost.");
        const result = await page.evaluate(() => {
          const r = window.__rnmb;
          const ringUp = r.state.ringUps[0];
          return {
            count: r.state.ringUps.length,
            ringUp,
            nightKind: r.state.nights.find((night) => night.id === ringUp.nightId).kind,
            stock: Object.fromEntries(r.state.bottles.map((bottle) => [bottle.nickname, bottle.remaining])),
            pours: r.state.nights.flatMap((night) => night.pours).length
          };
        });
        assert.equal(result.count, 1, "one tap, one crew ring-up");
        assert.equal(result.pours, 0, "a menu item is a ring-up, not a pour");
        assert.equal(result.nightKind, "crew", "crew ring-ups are allowed on a crew night");
        assert.equal(result.ringUp.kind, "crew");
        assert.equal(result.ringUp.personName, "Alex");
        assert.equal(result.ringUp.priceCents, null, "a crew drink carries no guest price");
        assert.equal(result.ringUp.lines.length, 3, "one line per ingredient");
        assert.deepEqual(result.ringUp.lines.map((line) => line.buyerName).sort(), ["Alex", "Jordan", "Sam"]);
        assert.equal(result.stock["Sam's tequila"], Math.round((stock["Sam's tequila"] - 2) * 100) / 100);
        assert.equal(result.stock["Alex's triple sec"], Math.round((stock["Alex's triple sec"] - 1) * 100) / 100);
        assert.equal(result.stock["Jordan's lime"], Math.round((stock["Jordan's lime"] - 1) * 100) / 100);
        // Tequila $2.37, triple sec $0.79, lime $0.12 of cost: Alex pays $3.28 and gets $0.79 of it back.
        assert.deepEqual(await balanceCents(page), { Alex: -249, Jordan: 12, Sam: 237, Casey: 0 });
        assert.equal(Object.values(await balanceCents(page)).reduce((sum, value) => sum + value, 0), 0, "balances still sum to zero");

        // Only 1 oz left in each tequila bottle: together they cover the 2 oz, but no single
        // bottle does, and quick log never splits an ingredient on its own (KTD10).
        const second = await addPricedStockViaForm(session, { typeId: types.tequila.id, nickname: "Backup tequila", size: 25.36, price: 30, buyerName: "Casey" });
        const tequilaId = await page.evaluate(() => window.__rnmb.state.bottles.find((bottle) => bottle.nickname === "Sam's tequila").id);
        await setLevel(page, tequilaId, 1);
        await setLevel(page, second.id, 1);
        await page.click('.tab-button[data-tab="tonight"]');
        await page.click(`#quickLogPeople [data-quick-person="${await personIdOf(page, "Jordan")}"]`);
        await clickForToast(
          session,
          '#quickLogItems button:has-text("Margarita")',
          "Tequila is short 1 oz in every single bottle, so Margarita was not logged. Ring it up on the register to split it, or top that bottle's level up."
        );
        assert.equal(await page.evaluate(() => window.__rnmb.state.ringUps.length), 1, "nothing was logged and nothing was split");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U5 the register refuses a write-off with nobody named, and charges the crew member who writes it off",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session, "Write-off night");
        await openRegister(session);
        await openTabViaRegister(session, "Quinn");
        await ringUpToTab(session, "Bourbon Neat", "Quinn");

        const tabId = await tabCard(page, "Quinn").getAttribute("data-tab-id");
        assert.equal(
          squash(await tabCard(page, "Quinn").locator("[data-write-off-tab]").textContent()),
          "Write off $2.76",
          "the button shows what the write-off costs, not the guest price"
        );
        await clickForToast(
          session,
          `#registerTabList [data-write-off-tab="${tabId}"]`,
          "Pick who is writing off Quinn's tab. Whoever writes it off covers what its drinks cost."
        );
        assert.equal((await tabOf(page, "Quinn")).status, "open", "nothing closed without an author");

        const confirmText = await writeOffTabViaRegister(session, "Quinn", "Jordan");
        assert.match(confirmText, /Write off Quinn's tab \(\$3\.00\)\? Jordan is charged \$2\.76, what its drinks cost\./);
        const tab = await tabOf(page, "Quinn");
        assert.equal(tab.status, "written_off");
        assert.equal(tab.writtenOffByName, "Jordan");
        assert.equal(tab.writtenOffBy, await personIdOf(page, "Jordan"));
        // The bourbon is Alex's, so Jordan covers its cost and Alex is made whole.
        assert.deepEqual(await balanceCents(page), { Alex: 276, Jordan: -276, Sam: 0, Casey: 0 });
        assert.deepEqual(await suggestionTexts(page), ["Jordan pays Alex $2.76"]);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U6 ending a crew night shows each person's drinks and cost totals, and the balances never waited on it",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await quickLog(session, "Sam", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");
        await quickLog(session, "Jordan", "Glass of Red", "Logged Glass of Red for Jordan · $3.74 at cost.");
        // Sam drank Alex's bourbon; Jordan drank Sam's red. Both balances moved on the tap.
        const before = await balanceCents(page);
        assert.deepEqual(before, { Alex: 207, Jordan: -374, Sam: 167, Casey: 0 });

        await page.click('.tab-button[data-tab="tonight"]');
        assert.equal(await page.locator("#nightRecapPanel").isVisible(), true, "a crew night gets the Wrap Up panel");
        // Computed display, not isVisible: an empty grid has no box either way.
        assert.equal(await page.locator("#nightRecapList").evaluate((list) => getComputedStyle(list).display), "none", "and no recap until it ends");
        assert.match(await page.textContent("#nightRecapNote"), /Ending Friday Recon opens the recap/);

        const confirmText = await endCrewNightViaRecap(session);
        assert.match(confirmText, /^End Friday Recon\? The recap opens so you can add a missed drink or void a wrong one/);
        assert.equal(await page.locator("#endCrewNight").evaluate((button) => getComputedStyle(button).display), "none", "an ended night has nothing left to end");
        assert.equal(await page.evaluate(() => Boolean(window.__rnmb.state.nights.find((night) => night.name === "Friday Recon").endedAt)), true);

        assert.deepEqual(await recapCards(page), [
          { person: "Jordan", total: "$3.74", meta: "1 drink · 5.0 oz · 1.1 standard drinks", drinks: ["Glass of Red — 5.0 oz · $3.74 at cost"] },
          { person: "Sam", total: "$2.07", meta: "1 drink · 1.5 oz · 1.1 standard drinks", drinks: ["The Briefing Bottle — 1.5 oz · $2.07 at cost"] }
        ], "one card per person who drank, in roster order; Alex and Casey drank nothing and get none");

        assert.deepEqual(await balanceCents(page), before, "ending a night moves no money: nothing waited on the recap (KTD7)");

        // A host night keeps its own end-night flow in the register, so it gets no Wrap Up panel.
        await startHostNightViaForm(session, "Smoke host night");
        await page.click('.tab-button[data-tab="tonight"]');
        assert.equal(await page.locator("#nightRecapPanel").evaluate((panel) => getComputedStyle(panel).display), "none");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U6 adding a missed drink from the recap lands it on that night and moves the balance straight away",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404, viewport: { width: 400, height: 900 } });
      const { page } = session;
      try {
        const bourbon = await bottleIdOf(page, "The Briefing Bottle");
        await quickLog(session, "Sam", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");
        await endCrewNightViaRecap(session);
        const samId = await personIdOf(page, "Sam");

        await clickForToast(
          session,
          `#nightRecapList .recap-card[data-recap-person="${samId}"] [data-recap-add]`,
          "Quick log is ready for Sam. Tap what they had and it lands on Friday Recon."
        );
        assert.equal(await page.getAttribute(`#quickLogPeople [data-quick-person="${samId}"]`, "aria-pressed"), "true", "quick log is pointed at Sam");
        assert.match(await page.textContent("#quickLogNight"), /Logging to Friday Recon \(ended\)\./);

        await clickForToast(session, `#quickLogItems [data-quick-bottle="${bourbon}"]`, "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");

        const logged = await page.evaluate(() => {
          const night = window.__rnmb.state.nights.find((entry) => entry.name === "Friday Recon");
          return { pours: night.pours.length, ended: Boolean(night.endedAt) };
        });
        assert.equal(logged.pours, 2, "the missed drink landed on the night the recap was showing");
        assert.equal(logged.ended, true, "which is still ended: the recap fixes a night up, it does not reopen it");
        assert.equal(await stockOf(page, bourbon), 16.2, "and it drew from stock like any other drink");
        assert.deepEqual(await balanceCents(page), { Alex: 414, Jordan: 0, Sam: -414, Casey: 0 }, "the balance moved on the tap, with nothing left to confirm");

        assert.deepEqual(await recapCards(page), [{
          person: "Sam",
          total: "$4.14",
          meta: "2 drinks · 3.0 oz · 2.3 standard drinks",
          drinks: ["The Briefing Bottle — 1.5 oz · $2.07 at cost", "The Briefing Bottle — 1.5 oz · $2.07 at cost"]
        }], "the recap redraws with the missed drink on it");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U6 voiding a drink from the recap puts the stock and the balances back, whether it was a pour or a crew ring-up",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const bourbon = await bottleIdOf(page, "The Briefing Bottle");
        const red = await bottleIdOf(page, "Diplomatic Pouch");
        await quickLog(session, "Sam", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");
        await quickLog(session, "Jordan", "Glass of Red", "Logged Glass of Red for Jordan · $3.74 at cost.");
        await endCrewNightViaRecap(session);
        const samId = await personIdOf(page, "Sam");
        const jordanId = await personIdOf(page, "Jordan");

        // A pour goes back through removePour.
        const pourConfirm = await voidFromRecap(session, samId);
        assert.match(pourConfirm, /^Void 1\.5 oz of The Briefing Bottle for Sam\? It goes back into stock, and Sam's balance goes back to where it was\./);
        assert.equal(await stockOf(page, bourbon), 19.2, "the bourbon is back where it started");
        assert.equal(await page.evaluate(() => window.__rnmb.state.nights.find((night) => night.name === "Friday Recon").pours.length), 0);
        assert.equal(await recapCard(page, samId).count(), 0, "with nothing left of theirs, Sam's card goes");
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: -374, Sam: 374, Casey: 0 }, "Alex is square again");

        // A crew ring-up goes back through voidRingUp.
        const ringUpConfirm = await voidFromRecap(session, jordanId);
        assert.match(ringUpConfirm, /^Void Glass of Red for Jordan\? What it poured goes back into stock, and Jordan's balance goes back to where it was\./);
        assert.equal(await stockOf(page, red), 25.36, "the red blend is back where it started");
        assert.equal(await page.evaluate(() => Boolean(window.__rnmb.state.ringUps[0].voidedAt)), true, "money history is voided, never deleted");
        assert.deepEqual(await balanceCents(page), { Alex: 0, Jordan: 0, Sam: 0, Casey: 0 });
        assert.match(await page.textContent("#nightRecapList"), /Nobody logged a drink on this night\./);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew U6 the end-night control and the recap have non-zero bounding boxes at 1440 and 400 widths, with no horizontal scroll",
    async run({ browser }) {
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 400, height: 900 }]) {
        const session = await openPage(browser, { allowConsole: apiConfig404, viewport });
        const { page } = session;
        try {
          const boxes = async (selectors) => {
            for (const selector of selectors) {
              const count = await page.locator(selector).count();
              assert.ok(count > 0, `${selector} is present at ${viewport.width}px`);
              for (let index = 0; index < count; index += 1) {
                const locator = page.locator(selector).nth(index);
                await locator.scrollIntoViewIfNeeded();
                const box = await locator.boundingBox();
                assert.ok(box && box.width > 0 && box.height > 0, `${selector} #${index} has a non-zero box at ${viewport.width}px (got ${JSON.stringify(box)})`);
                if (selector.includes("button") || selector.includes("recap-void") || selector.includes("recap-add")) {
                  assert.ok(box.height >= 44, `${selector} #${index} is a thumb-sized target at ${viewport.width}px (height ${box.height})`);
                }
              }
            }
            const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
            assert.ok(widths.scroll <= widths.client, `no horizontal scroll on Tonight at ${viewport.width}px (scrollWidth ${widths.scroll} > ${widths.client})`);
          };

          await page.click('.tab-button[data-tab="tonight"]');
          await boxes(["#nightRecapPanel button#endCrewNight", "#nightRecapNote"]);

          await quickLog(session, "Sam", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Sam · $2.07 at cost.");
          await quickLog(session, "Jordan", "Glass of Red", "Logged Glass of Red for Jordan · $3.74 at cost.");
          await endCrewNightViaRecap(session);
          await boxes([
            "#nightRecapList .recap-card",
            "#nightRecapList [data-recap-meta]",
            "#nightRecapList [data-recap-cost]",
            "#nightRecapList .recap-drink",
            "#nightRecapList [data-recap-void]",
            "#nightRecapList [data-recap-add]"
          ]);
          session.assertClean();
        } finally {
          await session.close();
        }
      }
    }
  },

  {
    name: "Crew review #1 a stock item a crew pour was charged against cannot be deleted; an untouched one still can",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const pouchId = await bottleIdOf(page, "Diplomatic Pouch");
        const coolerId = await bottleIdOf(page, "Cooler Battalion");
        await logPourViaForm(session, { personName: "Casey", bottleId: pouchId, amount: 5 });
        const before = await balanceCents(page);
        assert.ok(before.Casey < 0 && before.Sam > 0, "the pour charges Casey and credits Sam, who bought the wine");

        await page.click('.tab-button[data-tab="inventory"]');
        await clickForToast(session, `#inventoryList [data-bottle-id="${pouchId}"] [data-remove-bottle]`, POURED_BOTTLE_MESSAGE);
        const after = await page.evaluate((id) => ({
          kept: window.__rnmb.state.bottles.some((bottle) => bottle.id === id),
          pours: window.__rnmb.state.nights.flatMap((night) => night.pours).filter((pour) => pour.bottleId === id).length
        }), pouchId);
        assert.deepEqual(after, { kept: true, pours: 1 }, "the stock item and the pour it was charged for both stay");
        assert.deepEqual(await balanceCents(page), before, "nobody's balance moved");

        // A stock item nothing has been drawn from is still deleted, as before.
        const count = await page.evaluate(() => window.__rnmb.state.bottles.length);
        await clickForToast(session, `#inventoryList [data-bottle-id="${coolerId}"] [data-remove-bottle]`, "Bottle removed.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.bottles.length), count - 1);
        assert.equal(await page.locator(`#inventoryList [data-bottle-id="${coolerId}"]`).count(), 0);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew review #4 without crew-balance.sql the register write-off asks for no author and claims no charge",
    async run({ browser }) {
      const { seed } = hostModeSeed();
      const stub = hostModeStub(seed, { crewBalance: false });
      stub.rpc.rnmb_open_tab = (payload) => {
        stub.store.rnmb_guest_tabs.push({ id: payload.id, night_id: payload.night_id, guest_name: payload.guest_name, status: "open", opened_at: payload.opened_at });
        return payload.id;
      };
      stub.rpc.rnmb_close_tab = (payload) => {
        Object.assign(stub.store.rnmb_guest_tabs.find((tab) => tab.id === payload.id), { status: payload.status, closed_at: new Date().toISOString() });
        return payload.id;
      };
      const payments404 = (message) => resourceStatusError(message, 404, (url) => url.includes("/rest/v1/rnmb_payments?"));
      const session = await openPage(browser, { routes: stub.routes, allowConsole: payments404 });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        assert.equal(await page.evaluate(() => window.__rnmb.crewBalanceAvailable), false);
        await startHostNightViaForm(session, "Pre-migration night");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");

        const card = tabCard(page, "Riley");
        assert.equal(await card.locator("select[name='writtenOffBy']").count(), 0, "no author picker without crew balances");
        assert.equal(squash(await card.locator("[data-write-off-tab]").textContent()), "Write off", "and no cost on the button");
        assert.equal(await card.locator("select[name='collectorId']").count(), 1, "the collector picker is untouched");

        const tabId = await card.getAttribute("data-tab-id");
        let dialogMessage = "";
        page.once("dialog", (dialog) => { dialogMessage = dialog.message(); });
        await clickForToast(session, `#registerTabList [data-write-off-tab="${tabId}"]`, "Riley's tab written off.");
        assert.equal(dialogMessage, "Write off Riley's tab ($0.00)? Nobody collects it, and it cannot be reopened.");
        assert.ok(!/charged/.test(dialogMessage), "the confirm claims no charge");

        const closeCall = stub.log.find((entry) => entry.path === "rpc/rnmb_close_tab");
        assert.deepEqual(Object.keys(closeCall.body.payload).sort(), ["id", "status"], "no author is sent");
        assert.deepEqual(await page.evaluate(() => {
          const tab = window.__rnmb.state.guestTabs.find((entry) => entry.guestName === "Riley");
          return [tab.status, tab.writtenOffBy, tab.writtenOffByName];
        }), ["written_off", null, null]);
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Crew review #5 an ended host night keeps its guest items locked but its crew drinks correctable",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { night } = await startHostNightViaForm(session, "Locked night");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Bourbon Neat", "Riley");
        const bourbon = await bottleIdOf(page, "The Briefing Bottle");

        await registerItem(page, "Bourbon Neat").click();
        await registerCrew(page, "Casey").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey · $2.76 at cost.");
        const charged = await balanceCents(page);
        assert.equal(charged.Casey, -276, "the crew drink debits Casey at cost");

        await payTabViaRegister(session, "Riley", "Jordan");
        await clickForToast(session, "#registerEndNight", "Locked night ended. Its summary is under Host nights in Ledger.");
        assert.ok(await page.evaluate((id) => window.__rnmb.state.nights.find((entry) => entry.id === id).endedAt, night.id));

        const stockBefore = await stockOf(page, bourbon);
        const outcome = await page.evaluate(async () => {
          const r = window.__rnmb;
          const crew = r.state.ringUps.find((entry) => entry.kind === "crew");
          const guest = r.state.ringUps.find((entry) => entry.kind === "guest");
          const guestVoid = await r.hostAction("Guest item voided.", (db) => db.voidRingUp(guest.id));
          const crewVoid = await r.hostAction("Crew drink voided.", (db) => db.voidRingUp(crew.id));
          return {
            guestVoid,
            crewVoid,
            guestVoided: Boolean(r.state.ringUps.find((entry) => entry.id === guest.id).voidedAt),
            crewVoided: Boolean(r.state.ringUps.find((entry) => entry.id === crew.id).voidedAt)
          };
        });
        assert.equal(outcome.guestVoid, false, "a guest item on an ended host night stays frozen");
        assert.equal(outcome.guestVoided, false);
        assert.equal(outcome.crewVoid, true, "a crew drink charged at cost stays correctable");
        assert.equal(outcome.crewVoided, true);
        assert.equal(await stockOf(page, bourbon), Math.round((stockBefore + 2) * 100) / 100, "the crew drink's stock comes back");
        assert.equal((await balanceCents(page)).Casey, 0, "and so does Casey's balance");

        const toasts = await session.toasts();
        assert.ok(toasts.includes("This host night has ended, so its items can no longer be voided."), "the guest refusal is still shown");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "Crew review #5 follow-up: an ended host night's crew drinks can be voided from Ledger, its guest items cannot",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { night } = await startHostNightViaForm(session, "Ledger fix night");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        await ringUpToTab(session, "Bourbon Neat", "Riley");
        const bourbon = await bottleIdOf(page, "The Briefing Bottle");

        // A crew drink rung up to the wrong person while the bar was open.
        await registerItem(page, "Bourbon Neat").click();
        await registerCrew(page, "Casey").click();
        await clickForToast(session, "#registerConfirm", "Bourbon Neat poured for Casey · $2.76 at cost.");
        assert.equal((await balanceCents(page)).Casey, -276, "the crew drink debits Casey at cost");

        await payTabViaRegister(session, "Riley", "Jordan");
        await clickForToast(session, "#registerEndNight", "Ledger fix night ended. Its summary is under Host nights in Ledger.");

        // The register goes with the night, which is why this fix had to live elsewhere.
        await page.evaluate(() => { location.hash = "#register"; });
        await page.waitForSelector("#registerClosed:not([hidden])");
        assert.equal(await page.locator("#registerWork").isHidden(), true, "no register once the night has ended");
        await page.evaluate(() => { location.hash = ""; });

        // The Ledger's host-night card lists the crew drink, and only the crew drink.
        await page.click('.tab-button[data-tab="ledger"]');
        const card = page.locator(`.host-night-card[data-host-night-id="${night.id}"]`);
        await card.waitFor();
        const listed = await card.locator("[data-crew-drinks] li").allTextContents();
        assert.equal(listed.length, 1, `one crew drink listed, and the guest item is not among them; got ${JSON.stringify(listed)}`);
        assert.ok(listed[0].includes("Casey"), `expected the drinker named, got: ${listed[0]}`);
        assert.ok(listed[0].includes("$2.76"), `expected the cost shown, got: ${listed[0]}`);
        const note = await card.locator("[data-crew-drinks] .form-note").textContent();
        assert.ok(note.includes("charged at cost and can still be put right"), `expected the ended-night note, got: ${note}`);

        const stockBefore = await stockOf(page, bourbon);
        await clickForToast(session, `.host-night-card[data-host-night-id="${night.id}"] [data-void-crew-drink]`, "Drink voided. Stock and balances are back to where they were.");

        assert.equal((await balanceCents(page)).Casey, 0, "Casey's balance goes back");
        assert.equal(await stockOf(page, bourbon), Math.round((stockBefore + 2) * 100) / 100, "and the stock comes back");
        assert.equal(await card.locator("[data-crew-drinks] li").count(), 0, "the voided drink leaves the list");
        assert.equal(await card.locator("[data-crew-drinks] small").textContent(), "No crew drinks charged.");

        // The guest item on the same ended night is still frozen, and its money still counted.
        const guestVoid = await page.evaluate(async () => {
          const r = window.__rnmb;
          const guest = r.state.ringUps.find((entry) => entry.kind === "guest");
          const ok = await r.hostAction("Guest item voided.", (db) => db.voidRingUp(guest.id));
          return { ok, voided: Boolean(r.state.ringUps.find((entry) => entry.id === guest.id).voidedAt) };
        });
        assert.equal(guestVoid.ok, false, "a guest item on an ended host night stays frozen");
        assert.equal(guestVoid.voided, false);

        const toasts = await session.toasts();
        assert.ok(toasts.includes("This host night has ended, so its items can no longer be voided."), "the guest refusal is still shown");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "Crew review #5 follow-up: a running host night lists its crew pours in Ledger, and voiding one there puts the stock and balance back",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const { night } = await startHostNightViaForm(session, "Running night");
        const bourbon = await bottleIdOf(page, "The Briefing Bottle");

        // Starting a host night makes it the active night, so quick log lands a
        // crew POUR on it — the other kind of crew drink a host night can hold.
        await quickLog(session, "Casey", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Casey · $2.07 at cost.");

        await page.click('.tab-button[data-tab="ledger"]');
        const card = page.locator(`.host-night-card[data-host-night-id="${night.id}"]`);
        await card.waitFor();
        assert.equal(await card.locator("[data-host-night-status]").textContent(), "Running · 0 open tabs");
        const listed = await card.locator("[data-crew-drinks] li").allTextContents();
        assert.equal(listed.length, 1, `the pour is listed while the night runs; got ${JSON.stringify(listed)}`);
        assert.ok(listed[0].includes("Casey"), `expected the drinker named, got: ${listed[0]}`);
        assert.ok(listed[0].includes("The Briefing Bottle"), `expected the stock named, got: ${listed[0]}`);
        assert.equal(await card.locator("[data-crew-drinks] .form-note").count(), 0, "no ended-night note while it runs");

        const stockBefore = await stockOf(page, bourbon);
        assert.equal((await balanceCents(page)).Casey, -207, "the pour charges Casey at cost");

        await clickForToast(session, `.host-night-card[data-host-night-id="${night.id}"] [data-void-crew-drink]`, "Drink voided. Stock and balances are back to where they were.");
        assert.equal(await stockOf(page, bourbon), Math.round((stockBefore + 1.5) * 100) / 100, "the poured stock comes back");
        assert.equal((await balanceCents(page)).Casey, 0, "and Casey's balance with it");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "Both End night buttons carry the accent, the same orange as the register's primary action",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const bg = (selector) => page.evaluate(
          (sel) => getComputedStyle(document.querySelector(sel)).backgroundColor,
          selector
        );

        // The crew recap's End night, while a crew night is the active one.
        await page.click('.tab-button[data-tab="tonight"]');
        await page.waitForSelector("#endCrewNight:not([hidden])");
        const crewEnd = await bg("#endCrewNight");

        // Starting a host night makes it active, which hides the crew recap.
        await startHostNightViaForm(session, "Accent night");
        await openRegister(session);
        await openTabViaRegister(session, "Riley");
        const registerEnd = await bg("#registerEndNight");
        const registerPay = await bg(".register-pay");
        const registerOther = await bg("#registerClear");

        assert.equal(registerEnd, registerPay, "the register's End night matches its primary action");
        assert.equal(crewEnd, registerPay, "and so does the crew recap's End night");
        assert.notEqual(registerEnd, registerOther, "and neither reads as a plain secondary button");

        // Pin the token itself, so a theme change has to be deliberate.
        assert.equal(registerPay, "rgb(249, 115, 22)", "--accent is #f97316");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "Every volume field takes millilitres as well as ounces, and counted stock still takes only whole units",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        const tequila = await page.evaluate(() => window.__rnmb.state.types.find((type) => type.name === "Emergency Tequila").id);

        // 1. Stock size: type the number, pick the unit beside it.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.selectOption("#bottleForm [name='typeId']", tequila);
        await page.fill("#bottleForm [name='nickname']", "Metric bottle");
        await page.fill("#bottleForm [name='sizeOz']", "750");
        await page.selectOption("#bottleForm [name='sizeOzUnit']", "ml");
        await clickForToast(session, "#bottleForm button[type='submit']", "Bottle added to inventory.");
        const metric = await page.evaluate(() => window.__rnmb.state.bottles.find((b) => b.nickname === "Metric bottle"));
        assert.ok(metric, "the metric bottle was saved");
        assert.equal(metric.size, 25.36, "750 picked as ml is stored as 25.36 oz");
        assert.equal(metric.remaining, 25.36);

        // 2. A pour in millilitres comes off the same bottle in ounces.
        await page.click('.tab-button[data-tab="tonight"]');
        await page.selectOption("#pourForm [name='personId']", await personIdOf(page, "Sam"));
        await page.selectOption("#pourForm [name='bottleId']", metric.id);
        await page.fill("#pourForm [name='ounces']", "44");
        await page.selectOption("#pourForm [name='ouncesUnit']", "ml");
        await clickForToast(session, "#pourForm button[type='submit']", "Pour logged.");
        assert.equal(await stockOf(page, metric.id), 23.87, "44 ml is 1.49 oz off a 25.36 oz bottle");

        // 3. Set level, judged against the label rather than converted by hand.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.fill(`#inventoryList [data-level-form="${metric.id}"] [name='level']`, "500");
        await page.selectOption(`#inventoryList [data-level-form="${metric.id}"] [name='levelUnit']`, "ml");
        await clickForToast(session, `#inventoryList [data-level-form="${metric.id}"] button[type='submit']`, "Stock level set.");
        assert.equal(await stockOf(page, metric.id), 16.91, "500 ml is 16.91 oz");

        // 4. A counted type's unit volume is a volume: a can is labelled 355 ml.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.fill("#typeForm [name='name']", "Metric can");
        await page.selectOption("#typeForm [name='category']", "Beer");
        await page.selectOption("#typeForm [name='measure']", "unit");
        await page.fill("#typeForm [name='unitOz']", "355");
        await page.selectOption("#typeForm [name='unitOzUnit']", "ml");
        await page.fill("#typeForm [name='abv']", "5");
        await clickForToast(session, "#typeForm button[type='submit']", "Beverage type added.");
        const can = await page.evaluate(() => window.__rnmb.state.types.find((x) => x.name === "Metric can"));
        assert.equal(can.unitOz, 12, "355 picked as ml is 12 oz per unit");

        // 5. But the COUNT of those cans is a count, not a volume: the field stays
        //    a number input, so "12 ml" cannot even be typed into it.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.selectOption("#bottleForm [name='typeId']", can.id);
        assert.equal(await page.locator("#bottleForm [name='sizeOz']").getAttribute("type"), "number", "a counted size keeps the number spinner");
        assert.equal(await page.locator("#bottleForm [name='sizeOzUnit']").isHidden(), true, "and offers no unit dropdown -- a count is not a volume");
        await page.selectOption("#bottleForm [name='typeId']", tequila);
        assert.equal(await page.locator("#bottleForm [name='sizeOz']").getAttribute("type"), "text", "a poured size is a volume");
        assert.equal(await page.locator("#bottleForm [name='sizeOzUnit']").isVisible(), true, "so its unit dropdown comes back");

        // 6. A recipe ingredient in millilitres.
        await page.click('.tab-button[data-tab="menu"]');
        await page.fill("#menuItemForm [name='name']", "Metric shot");
        await page.selectOption("#menuItemForm [name='kind']", "straight");
        const row = page.locator("#ingredientRows [data-ingredient-row]").first();
        await row.locator("select[name='ingredientType']").selectOption(tequila);
        await row.locator("input[name='ingredientAmount']").fill("44");
        await row.locator("select[name='ingredientAmountUnit']").selectOption("ml");
        await clickForToast(session, "#menuItemSubmit", "Menu item added.");
        const saved = await page.evaluate(() => window.__rnmb.state.menuItems.find((item) => item.name === "Metric shot"));
        assert.equal(saved.ingredients[0].amount, 1.49, "the recipe stores 1.49 oz");

        // 7. A unit typed into the box still wins over the dropdown.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.selectOption("#bottleForm [name='typeId']", tequila);
        await page.fill("#bottleForm [name='nickname']", "Pasted bottle");
        await page.fill("#bottleForm [name='sizeOz']", "1 L");
        await page.selectOption("#bottleForm [name='sizeOzUnit']", "oz");
        await clickForToast(session, "#bottleForm button[type='submit']", "Bottle added to inventory.");
        const pasted = await page.evaluate(() => window.__rnmb.state.bottles.find((b) => b.nickname === "Pasted bottle"));
        assert.equal(pasted.size, 33.81, "\"1 L\" typed in the box beats the dropdown saying oz");

        // 8. Nonsense is refused rather than guessed at, and nothing is saved.
        await page.click('.tab-button[data-tab="inventory"]');
        await page.selectOption("#bottleForm [name='typeId']", tequila);
        await page.fill("#bottleForm [name='nickname']", "Bad units");
        await page.fill("#bottleForm [name='sizeOz']", "5 gallons");
        await clickForToast(session, "#bottleForm button[type='submit']", "Pick a type and a size above zero.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.bottles.some((entry) => entry.nickname === "Bad units")), false, "nothing was saved");

        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "A crew member's initials stay readable on any colour, light or dark",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        // A very dark colour is the case a fixed dark ink got wrong.
        await page.click('.tab-button[data-tab="crew"]');
        await page.fill("#personForm [name='name']", "Midnight");
        await page.evaluate(() => {
          const input = document.querySelector("#personForm [name='color']");
          input.value = "#1e3a8a";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await clickForToast(session, "#personForm button[type='submit']", "Person added to the roster.");

        await page.fill("#personForm [name='name']", "Daylight");
        await page.evaluate(() => {
          const input = document.querySelector("#personForm [name='color']");
          input.value = "#facc15";
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await clickForToast(session, "#personForm button[type='submit']", "Person added to the roster.");

        const inkFor = (name) => page.evaluate((who) => {
          const card = Array.from(document.querySelectorAll("#personList .person-card"))
            .find((entry) => entry.textContent.includes(who));
          const avatar = card && card.querySelector(".avatar");
          return avatar ? getComputedStyle(avatar).color : null;
        }, name);

        assert.equal(await inkFor("Midnight"), "rgb(255, 255, 255)", "white initials on a dark navy");
        assert.equal(await inkFor("Daylight"), "rgb(17, 17, 17)", "dark initials on a bright yellow");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "The register stacks its three dependent steps in one column and keeps anytime work in the other",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await startHostNightViaForm(session, "Layout night");
        await openRegister(session);

        const box = (selector) => page.locator(selector).boundingBox();
        const menu = await box(".register-menu-panel");
        const target = await box(".register-target-panel");
        const pour = await box(".register-pour-panel");
        const tabs = await box(".register-tabs-panel");

        // 1 -> 2 -> 3 read downwards, each below the last, all in the same column.
        assert.ok(menu.y < target.y, `1. Drink sits above 2. For (${menu.y} vs ${target.y})`);
        assert.ok(target.y < pour.y, `2. For sits above 3. Pour from (${target.y} vs ${pour.y})`);
        assert.equal(Math.round(menu.x), Math.round(target.x), "1 and 2 share a column");
        assert.equal(Math.round(menu.x), Math.round(pour.x), "and so does 3");

        // Open tabs is anytime work, so it sits beside the sequence, not inside it.
        assert.ok(tabs.x > menu.x + menu.width - 1, `open tabs is in the other column (${tabs.x} vs ${menu.x + menu.width})`);
        assert.ok(tabs.y <= target.y, "and starts alongside the sequence rather than after it");

        // Each step says what it is for.
        const notes = await page.locator("#registerWork .step-note").allTextContents();
        assert.ok(notes.length >= 3, `every step carries a note, got ${notes.length}`);
        assert.ok(notes.some((note) => note.includes("charged at cost")), "the For step explains the two kinds of target");

        // On a phone the same order survives as one column.
        await page.setViewportSize({ width: 400, height: 900 });
        const narrow = {
          menu: await box(".register-menu-panel"),
          target: await box(".register-target-panel"),
          pour: await box(".register-pour-panel"),
          tabs: await box(".register-tabs-panel")
        };
        assert.ok(narrow.menu.y < narrow.target.y && narrow.target.y < narrow.pour.y && narrow.pour.y < narrow.tabs.y,
          "at 400px the panels stack 1, 2, 3, then the anytime column");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "and nothing scrolls sideways");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "Inventory shows the type on the first line and the nickname on the second, neither wrapping",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.click('.tab-button[data-tab="inventory"]');
        const identity = page.locator("#inventoryList .stock-identity").first();
        await identity.waitFor();

        const shape = await identity.evaluate((el) => {
          const name = el.querySelector("strong");
          const nick = el.querySelector("small");
          const box = (node) => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; };
          const style = (node) => { const s = getComputedStyle(node); return { whiteSpace: s.whiteSpace, overflow: s.overflow, textOverflow: s.textOverflow, lineHeight: s.lineHeight }; };
          return { name: { text: name.textContent, ...box(name), ...style(name) }, nick: { text: nick.textContent, ...box(nick), ...style(nick) } };
        });

        assert.equal(shape.name.text, "House Bourbon");
        assert.equal(shape.nick.text, "The Briefing Bottle");
        assert.ok(shape.nick.top >= shape.name.bottom - 1,
          `the nickname sits below the name (name bottom ${shape.name.bottom}, nickname top ${shape.nick.top})`);
        for (const part of ["name", "nick"]) {
          assert.equal(shape[part].whiteSpace, "nowrap", `${part} does not wrap`);
          assert.equal(shape[part].textOverflow, "ellipsis", `${part} truncates rather than wrapping`);
        }

        // A long name must still hold one line each rather than growing the card.
        await page.evaluate(() => {
          const r = window.__rnmb;
          const type = r.state.types.find((t) => t.name === "House Bourbon");
          type.name = "Extremely Overlong Small Batch Bourbon Whiskey Reserve";
          const bottle = r.state.bottles.find((b) => b.nickname === "The Briefing Bottle");
          bottle.nickname = "The Briefing Bottle That Nobody Could Ever Name Briefly";
          r.render();
        });
        const after = await identity.evaluate((el) => {
          const lines = Array.from(el.children).map((node) => Math.round(node.getBoundingClientRect().height));
          const card = el.closest(".inventory-card");
          return { lines, cardOverflows: card.scrollWidth > card.clientWidth + 1 };
        });
        assert.equal(after.lines.length, 2, "still exactly two lines");
        assert.equal(after.cardOverflows, false, "and the card does not overflow");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },
  {
    name: "A crew member who owes money reads in light red, not caution yellow",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        // Casey drinks Alex's bourbon, so Casey owes and Alex is owed.
        await quickLog(session, "Casey", "The Briefing Bottle", "Logged 1.5 oz of The Briefing Bottle for Casey · $2.07 at cost.");
        await page.click('.tab-button[data-tab="ledger"]');

        const colours = await page.evaluate(() => {
          const read = (who) => {
            const row = Array.from(document.querySelectorAll("#balanceList .balance-row"))
              .find((entry) => entry.dataset.balancePerson === who);
            if (!row) return null;
            return {
              classes: row.className,
              amount: getComputedStyle(row.querySelector("[data-balance-amount]")).color,
              border: getComputedStyle(row).borderLeftColor
            };
          };
          return { owes: read("Casey"), owed: read("Alex") };
        });

        const YELLOW = "rgb(250, 204, 21)";
        const LIGHT_RED = "rgb(252, 165, 165)";
        assert.ok(colours.owes.classes.includes("is-owes"), `Casey owes: ${colours.owes.classes}`);
        assert.equal(colours.owes.amount, LIGHT_RED, "the amount owed is light red");
        assert.equal(colours.owes.border, LIGHT_RED, "and so is the row's edge");
        assert.notEqual(colours.owes.amount, YELLOW, "not the caution yellow it used to be");

        // Being owed is unchanged, so the two states stay distinguishable.
        assert.ok(colours.owed.classes.includes("is-owed"), `Alex is owed: ${colours.owed.classes}`);
        assert.equal(colours.owed.amount, "rgb(34, 197, 94)", "being owed stays green");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  }
];

// ---------- quotebook (unit 11) --------------------------------------------------
// Every book below is a committed SYNTHETIC fixture or an inline line made up for
// the test (KTD14). No check here is ever driven with the crew's real quotebook.

const QUOTEBOOK_KEY = "rnmb-quotebook-v1";
const quotebookFixture = (name) => fs.readFileSync(`${__dirname}/../fixtures/parser/${name}`, "utf8");

/** Run an action, then wait for a toast shown after it (a repeat of an earlier toast still counts). */
async function actionForToast(session, action, text) {
  const count = (await session.toasts()).length;
  await action();
  await session.page.waitForFunction(
    ({ count, text }) => window.__toasts.slice(count).includes(text),
    { count, text },
    { timeout: 10000 }
  );
}

/** Upload a book through the Crew tab's widget and wait for the given toast. */
async function uploadQuotebook(session, name, contents, toast) {
  const { page } = session;
  await page.click('.tab-button[data-tab="crew"]');
  await actionForToast(session, () => page.setInputFiles("#quotebookFile", {
    name,
    mimeType: "text/plain",
    buffer: Buffer.from(contents, "utf8")
  }), toast);
}

/** A stored book, seeded before the page's own scripts run (the widget is tested separately). */
function seedQuotebook(text, fileName = "seeded.txt") {
  const { book } = require("../../quotebook.js").prepareBook(text, fileName);
  return async (page) => {
    await page.addInitScript(({ key, value }) => {
      // Only on the first load of this context, so a reload after clearing stays cleared.
      if (!sessionStorage.getItem("quotebook-seeded")) {
        localStorage.setItem(key, value);
        sessionStorage.setItem("quotebook-seeded", "1");
      }
    }, { key: QUOTEBOOK_KEY, value: JSON.stringify(book) });
  };
}

// Five short, distinct, synthetic quotes -- every one fits the card at any width.
const SHORT_BOOK = [
  '"The keg is a mood." - Alex',
  '"The lime is a personality." - jordan',
  '"Ice is a love language." - Unknown',
  '"Garnish or perish." - Marguerite',
  'Sam: "Bring the good cups."   Casey: "There are no good cups."'
].join("\n");

const quoteCard = (page) => page.evaluate(() => {
  const card = document.querySelector("#quoteCard");
  const text = document.querySelector("#quoteText");
  return {
    hidden: card.hidden,
    display: getComputedStyle(card).display,
    text: text.textContent,
    author: document.querySelector("#quoteAuthor").textContent,
    tint: card.style.getPropertyValue("--person-color"),
    overflows: text.scrollHeight > text.clientHeight + 1,
    cards: Array.from(document.querySelectorAll(".metric-grid > .metric-card")).filter((el) => getComputedStyle(el).display !== "none").length
  };
});

const quotebookWidget = (page) => page.evaluate(() => ({
  status: document.querySelector("#quotebookStatus").textContent,
  clearHidden: document.querySelector("#quotebookClear").hidden,
  stored: localStorage.getItem("rnmb-quotebook-v1")
}));

scenarios.push(
  {
    name: "Quotebook widget loads, replaces, refuses an empty file without losing the book, and clears",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await page.click('.tab-button[data-tab="crew"]');
        let widget = await quotebookWidget(page);
        assert.equal(widget.status, "No quotebook is loaded in this browser.", "never a blank status line");
        assert.equal(widget.clearHidden, true, "nothing to clear");
        assert.equal(widget.stored, null);

        await uploadQuotebook(session, "StressTest.txt", quotebookFixture("StressTest.txt"), "Quotebook loaded: 10 quotes from StressTest.txt.");
        widget = await quotebookWidget(page);
        assert.equal(widget.status, "StressTest.txt: 10 quotes loaded in this browser.");
        assert.equal(widget.clearHidden, false);
        assert.equal(JSON.parse(widget.stored).count, 10);

        // A second upload replaces the first; the stated count changes with it.
        const longCount = (await page.evaluate((text) => window.RNMBQuotebook.parseQuotebook(text).length, quotebookFixture("LongQuotes.txt")));
        await uploadQuotebook(session, "LongQuotes.txt", quotebookFixture("LongQuotes.txt"), `Quotebook loaded: ${longCount} quotes from LongQuotes.txt.`);
        widget = await quotebookWidget(page);
        assert.equal(widget.status, `LongQuotes.txt: ${longCount} quotes loaded in this browser.`);
        assert.equal(JSON.parse(widget.stored).fileName, "LongQuotes.txt", "the second book replaced the first");

        // Both fixtures happen to hold 10, so prove the stated count follows the book.
        await uploadQuotebook(session, "three.txt", '"One." - Ines\n"Two." - Bram\n"Three." - Ines', "Quotebook loaded: 3 quotes from three.txt.");
        assert.equal((await quotebookWidget(page)).status, "three.txt: 3 quotes loaded in this browser.");
        await uploadQuotebook(session, "LongQuotes.txt", quotebookFixture("LongQuotes.txt"), `Quotebook loaded: ${longCount} quotes from LongQuotes.txt.`);
        widget = await quotebookWidget(page);

        // A file with no quotes is a failed upload, not an empty book: the loaded one survives.
        const refused = "No quotes were found in that file, so the quotebook was not changed. Put one quote per line.";
        await uploadQuotebook(session, "blank.txt", "\r\n   \r\n\t\r\n", refused);
        const afterRefusal = await quotebookWidget(page);
        assert.equal(afterRefusal.status, widget.status, "the stated book is unchanged");
        assert.equal(afterRefusal.stored, widget.stored, "the stored book is unchanged");

        // Picking the same filename again still fires the handler (the input was reset).
        await uploadQuotebook(session, "blank.txt", "\r\n   \r\n\t\r\n", refused);

        // The book persists across a reload, in this browser only.
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => window.__rnmb && window.__toasts && window.__toasts.length > 0);
        await page.click('.tab-button[data-tab="crew"]');
        assert.equal((await quotebookWidget(page)).status, `LongQuotes.txt: ${longCount} quotes loaded in this browser.`);

        // Clearing is local and quiet: no confirm, no backup download, app state untouched.
        const appStateBefore = await page.evaluate(() => localStorage.getItem("rnmb-command-center-v1"));
        let downloaded = false;
        page.on("download", () => { downloaded = true; });
        await actionForToast(session, () => page.click("#quotebookClear"), "Quotebook cleared from this browser.");
        widget = await quotebookWidget(page);
        assert.equal(widget.status, "No quotebook is loaded in this browser.");
        assert.equal(widget.clearHidden, true);
        assert.equal(widget.stored, null);
        assert.equal(await page.evaluate(() => localStorage.getItem("rnmb-command-center-v1")), appStateBefore);
        assert.equal(downloaded, false, "clearing the quotebook takes no backup");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quotebook widget refuses a book over the size cap and keeps the one loaded",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        await uploadQuotebook(session, "small.txt", '"The keg is a mood." - Ines', "Quotebook loaded: 1 quote from small.txt.");
        const before = await quotebookWidget(page);

        const line = `"${"x".repeat(200)}" - Bram\n`;
        const huge = line.repeat(Math.ceil((256 * 1024 * 1.2) / line.length));
        await uploadQuotebook(session, "huge.txt", huge, "That quotebook is too large to keep in this browser (the limit is 256 KB), so it was not loaded.");
        assert.deepEqual(await quotebookWidget(page), before);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quote card: no book, no card (AE5); a loaded book shows one; clearing removes it without a reload",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404 });
      const { page } = session;
      try {
        let card = await quoteCard(page);
        assert.equal(card.hidden, true);
        assert.equal(card.display, "none", "KTD7: the hidden card is not painted as an empty box");
        assert.equal(card.cards, 3, "exactly three cards without a book");

        await uploadQuotebook(session, "short.txt", SHORT_BOOK, "Quotebook loaded: 5 quotes from short.txt.");
        await page.click('.tab-button[data-tab="overview"]');
        card = await quoteCard(page);
        assert.equal(card.hidden, false);
        assert.equal(card.cards, 4);
        assert.ok(card.text.length > 0 && card.author.length > 0, "a quote and its author are showing");
        assert.equal(card.overflows, false);
        const leftmost = await page.evaluate(() => document.querySelector(".metric-grid").firstElementChild.id);
        assert.equal(leftmost, "quoteCard", "6.9.4: leftmost in the metric grid");

        await page.click('.tab-button[data-tab="crew"]');
        await actionForToast(session, () => page.click("#quotebookClear"), "Quotebook cleared from this browser.");
        assert.equal((await quoteCard(page)).hidden, true, "hidden at once, before the Overview is shown again");
        await page.click('.tab-button[data-tab="overview"]');
        card = await quoteCard(page);
        assert.equal(card.display, "none");
        assert.equal(card.cards, 3);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quote card renders a boobytrapped quote as literal text and runs nothing (AE6)",
    async run({ browser }) {
      const trap = '"<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>" - <b onmouseover="window.__pwned=3">Alex</b>';
      const session = await openPage(browser, { allowConsole: apiConfig404, routes: seedQuotebook(trap) });
      const { page } = session;
      try {
        const result = await page.evaluate(() => ({
          text: document.querySelector("#quoteText").textContent,
          author: document.querySelector("#quoteAuthor").textContent,
          elements: document.querySelectorAll("#quoteCard img, #quoteCard script, #quoteCard b").length,
          pwned: window.__pwned
        }));
        assert.ok(result.text.includes("<img src=x"), `the tag shows as characters: ${result.text}`);
        assert.ok(result.text.includes("<script>"));
        assert.ok(result.author.includes("<b"), `the author is text too: ${result.author}`);
        assert.equal(result.elements, 0, "no element was created from the quote");
        await page.hover("#quoteCard");
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => window.__pwned), undefined, "no handler ran");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quote card is a keyboard control that shows another quote on Enter, Space and tap, tinted by the roster",
    async run({ browser }) {
      const session = await openPage(browser, { allowConsole: apiConfig404, routes: seedQuotebook(SHORT_BOOK) });
      const { page } = session;
      try {
        const first = (await quoteCard(page)).text;
        assert.ok(first, "boot picks a quote once state has loaded");

        await page.focus("#quoteCard");
        assert.equal(await page.evaluate(() => document.activeElement.id), "quoteCard", "the card takes focus");
        await page.keyboard.press("Enter");
        const second = (await quoteCard(page)).text;
        assert.notEqual(second, first, "Enter shows another quote");
        await page.keyboard.press("Space");
        const third = (await quoteCard(page)).text;
        assert.notEqual(third, second, "Space shows another quote");
        await page.click("#quoteCard");
        assert.notEqual((await quoteCard(page)).text, third, "a tap shows another quote");

        // KTD9: tap through the book and record each author's tint.
        const tints = new Map();
        for (let i = 0; i < 40 && tints.size < 5; i += 1) {
          const card = await quoteCard(page);
          tints.set(card.author, card.tint);
          await page.click("#quoteCard");
        }
        const roster = await page.evaluate(() => Object.fromEntries(window.__rnmb.state.people.map((person) => [person.name, person.color])));
        assert.equal(tints.get("Alex"), roster.Alex, "a roster match takes that member's colour");
        assert.equal(tints.get("jordan"), roster.Jordan, "matching ignores case");
        assert.equal(tints.get("Unknown"), "", "Unknown never matches");
        assert.equal(tints.get("Marguerite"), "", "someone not on the roster falls back to the default");
        assert.equal(tints.get("Sam, Casey"), "", "a multi-speaker exchange falls back to the default");

        // 6.9.8: the exchange renders one turn per line.
        for (let i = 0; i < 40 && (await quoteCard(page)).author !== "Sam, Casey"; i += 1) await page.click("#quoteCard");
        // A long turn may wrap; what matters is that each turn starts a line of its own.
        const exchange = await page.evaluate(() => {
          const text = document.querySelector("#quoteText");
          const node = text.firstChild;
          const top = (offset) => {
            const range = document.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + 1);
            return range.getBoundingClientRect().top;
          };
          const lastOfFirstTurn = node.textContent.indexOf("\n") - 1;
          return {
            text: text.textContent,
            whiteSpace: getComputedStyle(text).whiteSpace,
            secondTurnStartsBelow: top(lastOfFirstTurn + 2) > top(lastOfFirstTurn),
            secondTurnStartsAtLeft: Math.abs(
              (() => { const r = document.createRange(); r.setStart(node, lastOfFirstTurn + 2); r.setEnd(node, lastOfFirstTurn + 3); return r.getBoundingClientRect().left; })() -
              (() => { const r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 1); return r.getBoundingClientRect().left; })()
            ) < 1
          };
        });
        assert.equal(exchange.text, '"Bring the good cups."\n"There are no good cups."');
        assert.equal(exchange.whiteSpace, "pre-wrap");
        assert.ok(exchange.secondTurnStartsBelow && exchange.secondTurnStartsAtLeft, "the second turn starts its own line");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quote card holds its quote through a save and a differing poll (AE4), and re-picks when the Overview shows again",
    async run({ browser }) {
      const { ids, seed } = hostModeSeed();
      const bottleId = "99999999-0000-4000-8000-000000000001";
      seed.rnmb_bottles = [{ id: bottleId, type_id: ids.rum, nickname: "Rum bottle", size_oz: 25, remaining_oz: 25, price: 40, buyer_id: ids.sam, purchase_date: "2026-09-16" }];
      const stub = hostModeStub(seed);
      // Host mode logs a crew pour through one function that also takes it off the level.
      stub.rpc.rnmb_add_crew_pour = (payload) => {
        stub.store.rnmb_pours.push({ id: payload.id, night_id: payload.night_id, person_id: payload.person_id, bottle_id: payload.bottle_id, ounces: payload.ounces, poured_at: payload.poured_at });
        const bottle = stub.store.rnmb_bottles.find((row) => row.id === payload.bottle_id);
        bottle.remaining_oz -= payload.ounces;
        return payload.id;
      };
      const session = await openPage(browser, {
        routes: async (page) => {
          await stub.routes(page);
          await seedQuotebook(SHORT_BOOK)(page);
        }
      });
      const { page } = session;
      try {
        await session.waitForToast("Connected to Supabase.");
        const showing = (await quoteCard(page)).text;
        assert.ok(showing);

        // A pour saved from the Overview: the form submits in place, the dashboard redraws.
        await actionForToast(session, () => page.evaluate(({ personId, bottleId }) => {
          const form = document.querySelector("#pourForm");
          form.querySelector("[name='personId']").value = personId;
          form.querySelector("[name='bottleId']").value = bottleId;
          form.querySelector("[name='ounces']").value = "1.5";
          form.requestSubmit();
        }, { personId: ids.sam, bottleId }), "Pour logged.");
        assert.ok(stub.log.some((entry) => entry.path === "rpc/rnmb_add_crew_pour"), "the pour reached the shared database");
        assert.equal((await quoteCard(page)).text, showing, "a save keeps the quote");

        // Another device changes something; the next poll differs and redraws everything.
        stub.store.rnmb_people.push({ id: "99999999-0000-4000-8000-000000000002", name: "Riley", color: "#38bdf8" });
        await actionForToast(session, () => page.evaluate(() => refreshFromServer()), "Updated from the shared dashboard.");
        assert.equal(await page.evaluate(() => window.__rnmb.state.people.length), 2, "the poll really redrew");
        assert.equal((await quoteCard(page)).text, showing, "a differing poll keeps the quote");

        // KTD5: each way the Overview becomes visible picks again.
        await page.click('.tab-button[data-tab="tonight"]');
        await page.click('.tab-button[data-tab="overview"]');
        const afterTab = (await quoteCard(page)).text;
        assert.notEqual(afterTab, showing, "coming back from another tab");

        await page.evaluate(() => { location.hash = "#register"; });
        await page.waitForFunction(() => document.body.classList.contains("is-register"));
        await page.evaluate(() => { location.hash = ""; });
        await page.waitForFunction(() => !document.body.classList.contains("is-register"));
        const afterRegister = (await quoteCard(page)).text;
        assert.notEqual(afterRegister, afterTab, "leaving the register");

        await page.evaluate(() => {
          const setHidden = (value) => Object.defineProperty(document, "hidden", { value, configurable: true });
          setHidden(true);
          document.dispatchEvent(new Event("visibilitychange"));
          setHidden(false);
          document.dispatchEvent(new Event("visibilitychange"));
        });
        assert.notEqual((await quoteCard(page)).text, afterRegister, "the browser tab coming back to the front");
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    // U6, AE3: the only automated guard on the plan's privacy requirement (5.11.3).
    name: "Quotebook containment: no quote reaches stored app state, any request, or an exported archive (AE3)",
    async run({ browser }) {
      const { ids, seed } = hostModeSeed();
      const bottleId = "99999999-0000-4000-8000-000000000001";
      seed.rnmb_bottles = [{ id: bottleId, type_id: ids.rum, nickname: "Rum bottle", size_oz: 25, remaining_oz: 25, price: 40, buyer_id: ids.sam, purchase_date: "2026-09-16" }];
      const stub = hostModeStub(seed);
      stub.rpc.rnmb_add_crew_pour = (payload) => payload.id;
      const session = await openPage(browser, { routes: stub.routes });
      const { page } = session;

      // Every request the page makes, to any host, with its URL and body.
      const sent = [];
      page.on("request", (request) => sent.push(`${request.method()} ${request.url()}\n${request.postData() || ""}`));

      const book = quotebookFixture("LongQuotes.txt");
      const quotes = require("../../quotebook.js").parseQuotebook(book);
      // A quote can sit in a haystack raw (an archive, a URL) or JSON-escaped (a body, stored state).
      const leaked = (haystack) => quotes
        .filter((quote) => haystack.includes(quote.text) || haystack.includes(JSON.stringify(quote.text).slice(1, -1)))
        .map((quote) => quote.text.slice(0, 30));

      const readDownload = async (download) => fs.readFileSync(await download.path(), "utf8");

      try {
        await session.waitForToast("Connected to Supabase.");
        await uploadQuotebook(session, "LongQuotes.txt", book, `Quotebook loaded: ${quotes.length} quotes from LongQuotes.txt.`);
        await page.click('.tab-button[data-tab="overview"]');
        const showing = (await quoteCard(page)).text;
        assert.ok(quotes.some((quote) => quote.text === showing), "the book is loaded and a quote from it is on screen");

        // Writes of every shape: a crew pour, a new crew member, and a whole-state replace.
        await actionForToast(session, () => page.evaluate(({ personId, bottleId }) => {
          const form = document.querySelector("#pourForm");
          form.querySelector("[name='personId']").value = personId;
          form.querySelector("[name='bottleId']").value = bottleId;
          form.querySelector("[name='ounces']").value = "1.5";
          form.requestSubmit();
        }, { personId: ids.sam, bottleId }), "Pour logged.");
        await page.click('.tab-button[data-tab="crew"]');
        await page.fill("#personForm [name='name']", "Riley");
        await actionForToast(session, () => page.click("#personForm button[type='submit']"), "Person added to the roster.");

        const backupPromise = page.waitForEvent("download");
        await actionForToast(session, () => page.click("#seedData"), "Demo data reloaded.");
        const backup = await readDownload(await backupPromise);

        const exportPromise = page.waitForEvent("download");
        await page.click("#exportData");
        const exported = await readDownload(await exportPromise);

        const stored = await page.evaluate(() => localStorage.getItem("rnmb-command-center-v1"));
        const bodies = stub.log.map((entry) => JSON.stringify(entry));

        assert.ok(stub.log.some((entry) => entry.path === "rpc/rnmb_add_crew_pour"), "the pour was sent");
        assert.ok(stub.log.some((entry) => entry.path === "rnmb_people" && entry.method === "POST"), "the new person was sent");
        assert.ok(stub.log.some((entry) => entry.method === "DELETE"), "the whole-state replace was sent");
        assert.ok(sent.length > 0);

        assert.deepEqual(leaked(stored), [], "stored app state holds no quote");
        assert.deepEqual(leaked(bodies.join("\n")), [], "no Supabase request body holds a quote");
        assert.deepEqual(leaked(sent.join("\n")), [], "no request of any kind carries a quote");
        for (const [name, archive] of [["the export", exported], ["the backup before Reload demo", backup]]) {
          assert.deepEqual(leaked(archive), [], `${name} holds no quote`);
          const keys = Object.keys(JSON.parse(archive));
          assert.ok(!keys.some((key) => /quote/i.test(key)), `${name} has no quotebook key: ${keys.join(", ")}`);
        }

        // And the book is still there, untouched by the replace.
        assert.equal(JSON.parse(await page.evaluate((key) => localStorage.getItem(key), QUOTEBOOK_KEY)).count, quotes.length);
        assert.deepEqual(stub.unexpected, []);
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  },

  {
    name: "Quote card shows the shortest quote at the floor size when no quote fits",
    async run({ browser }) {
      const huge = (n) => `"${"word ".repeat(n).trim()}" - Alex`;
      const book = [huge(400), huge(300), huge(350)].join("\n");
      const session = await openPage(browser, { allowConsole: apiConfig404, routes: seedQuotebook(book) });
      const { page } = session;
      try {
        const card = await quoteCard(page);
        assert.equal(card.hidden, false, "a loaded book always paints something");
        assert.equal(card.text.split(" ").length, 300, "the shortest of the three");
        assert.equal(await page.evaluate(() => document.querySelector("#quoteCard").style.getPropertyValue("--quote-size")), "0.72rem");
        session.assertClean();
      } finally {
        await session.close();
      }
    }
  }
);

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
