const STORAGE_KEY = "rnmb-command-center-v1";
const ACCESS_STORAGE_KEY = "rnmb-access-key";

// The local calendar date, never the UTC one. toISOString() reports UTC, so
// slicing it returns tomorrow from 8pm Eastern onward -- which dated every night
// log and purchase a day ahead for exactly the hours this app is used.
const today = () => {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

// Person colours are written straight into a style attribute. From the colour
// picker that is always #rrggbb; from an imported archive it is arbitrary text.
const safeColor = (value) => (/^#[0-9a-f]{3,8}$/i.test(String(value || "")) ? value : "#ef4444");
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const money = (value) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value || 0);
const oneDecimal = (value) => Number(value || 0).toFixed(1);
// Every collection, host mode included, with default markup and rounding.
const emptyState = () => RNMBDomain.normalizeState({});

const demoData = () => {
  const people = [
    { id: uid(), name: "Alex", color: "#f97316" },
    { id: uid(), name: "Jordan", color: "#22c55e" },
    { id: uid(), name: "Sam", color: "#38bdf8" },
    { id: uid(), name: "Casey", color: "#facc15" }
  ];
  const types = [
    { id: uid(), name: "House Bourbon", category: "Whiskey", abv: 45 },
    { id: uid(), name: "Crisp Lager", category: "Beer", abv: 5 },
    { id: uid(), name: "Red Blend", category: "Wine", abv: 13.5 },
    { id: uid(), name: "Emergency Tequila", category: "Tequila", abv: 40 }
  ];
  const bottles = [
    { id: uid(), typeId: types[0].id, nickname: "The Briefing Bottle", size: 25.36, remaining: 19.2, price: 34.99, buyerId: people[0].id, date: today() },
    { id: uid(), typeId: types[1].id, nickname: "Cooler Battalion", size: 144, remaining: 96, price: 22.5, buyerId: people[1].id, date: today() },
    { id: uid(), typeId: types[2].id, nickname: "Diplomatic Pouch", size: 25.36, remaining: 25.36, price: 18.99, buyerId: people[2].id, date: today() }
  ];
  // A small menu drawn only from the stock above, so every item is available.
  const menuItems = [
    {
      id: uid(),
      name: "Boilermaker",
      kind: "cocktail",
      ingredients: [
        { id: uid(), typeId: types[0].id, amount: 1.5 },
        { id: uid(), typeId: types[1].id, amount: 12 }
      ]
    },
    { id: uid(), name: "Bourbon Neat", kind: "straight", ingredients: [{ id: uid(), typeId: types[0].id, amount: 2 }] },
    { id: uid(), name: "Glass of Red", kind: "straight", ingredients: [{ id: uid(), typeId: types[2].id, amount: 5 }] }
  ];
  const nightId = uid();
  return normalizeState({
    people,
    types,
    bottles,
    nights: [{ id: nightId, name: "Friday Recon", date: today(), kind: "crew", endedAt: null, pours: [] }],
    menuItems,
    activeNightId: nightId,
    responsibleMode: true
  });
};

let state = emptyState();
let repository = createLocalRepository();
let syncMode = "local";
let accessKey = "";
let saveInFlight = false;
let lastSyncedAt = null;
// KTD8: false only when the shared database answers 404 for a host-mode table,
// i.e. supabase/host-mode.sql has not been run. The local repository always
// runs host mode (KTD9), so this starts true and is reset on every load.
let hostModeAvailable = true;
const HOST_MODE_SQL_MESSAGE = "Host mode is not set up on the shared database yet. Run supabase/host-mode.sql in Supabase, then reload.";
const NOT_SAVING_MESSAGE = "This host night belongs to the shared database, and this browser is not connected to it, so nothing was saved. Reload the page to reconnect, then try again.";
const SOLD_BOTTLE_MESSAGE = "Drinks have been sold from this stock item, so it cannot be deleted. Set its remaining level to empty instead.";

// The bar register (KTD7): the order being built is this one object, never the
// DOM, so every render rebuilds the register from it. See renderRegister().
//   { id, menuItemId, target, sources }
//   id       the ring-up id, made with the draft and reused on every resubmit (KTD14)
//   target   { kind: "guest", tabId } | { kind: "crew", personId } | null
//   sources  one list per recipe ingredient, in RNMBDomain.menuItemIngredients order: [{ bottleId, amount }]
const REGISTER_HASH = "#register";
const REGISTER_CLOSED_MESSAGE = "No host night is running. Start one from Tonight on the dashboard, then open the register.";
let registerDraft = null;
// True from the confirm tap until the ring-up call resolves; every draft control is disabled meanwhile.
let registerPending = false;

function normalizeState(input) {
  return RNMBDomain.normalizeState(input);
}

function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  try {
    return raw ? normalizeState(JSON.parse(raw)) : demoData();
  } catch {
    return demoData();
  }
}

/*
 * Host-mode rules, applied to `state`.
 *
 * The local repository runs these as the whole save (KTD9). The Supabase
 * repository runs them after the database function has accepted the change, to
 * mirror it into this browser without a full reload; if the mirror disagrees
 * (this browser's copy was stale) it reloads instead. Each rule validates
 * everything before it touches `state`, so a refusal leaves state unchanged.
 * `local: true` adds the KTD9 check that a host night was started in this browser.
 */
function refusal(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

const nowIso = () => new Date().toISOString();
const round6 = (value) => Math.round(value * 1e6) / 1e6 + 0;
const hasAtMostTwoDecimals = (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

function stockLabel(bottle) {
  const type = typeById(bottle.typeId);
  return bottle.nickname || type?.name || "that stock item";
}

function checkAmount(amount, type, what) {
  if (!Number.isFinite(amount) || amount <= 0) throw refusal(`${what} needs an amount above zero.`);
  if (!hasAtMostTwoDecimals(amount)) throw refusal(`Amounts are kept to two decimal places, and ${amount} has more.`);
  if (type?.measure === RNMBDomain.MEASURE_UNIT && !Number.isInteger(amount)) {
    throw refusal(`${type.name} is counted stock and is used in whole units.`);
  }
}

function openHostNightFor(nightId, local) {
  const night = state.nights.find((entry) => entry.id === nightId);
  if (!night) throw refusal("That night does not exist.");
  if (night.kind !== "host") throw refusal("Drinks and guest tabs only exist on a host night.");
  if (night.endedAt) throw refusal("This host night has ended, so nothing more can be changed on it.");
  if (local && night.startedLocally !== true) throw refusal(NOT_SAVING_MESSAGE);
  return night;
}

const hostRules = {
  ringUp(record, { local }) {
    if (state.ringUps.some((entry) => entry.id === record.id)) throw refusal("That ring-up was already saved.");
    const night = openHostNightFor(record.nightId, local);
    let person = null;
    if (record.kind === "guest") {
      if (!record.tabId) throw refusal("A guest ring-up needs a tab.");
      if (record.personId) throw refusal("A guest ring-up goes on a tab, not to a crew member.");
      const tab = state.guestTabs.find((entry) => entry.id === record.tabId);
      if (!tab) throw refusal("That tab does not exist.");
      if (tab.nightId !== night.id) throw refusal("That tab belongs to a different night.");
      if (tab.status !== "open") throw refusal("That tab is closed, so nothing more can be added to it.");
      if (!Number.isInteger(record.priceCents) || record.priceCents < 0) throw refusal("A guest ring-up needs a price in cents.");
    } else if (record.kind === "crew") {
      if (record.tabId) throw refusal("Crew members never get a tab; ring up a crew drink to the person.");
      if (record.priceCents !== null && record.priceCents !== undefined) throw refusal("A crew ring-up carries no price.");
      person = personById(record.personId);
      if (!person) throw refusal("That crew member does not exist.");
    } else {
      throw refusal("A ring-up is either for a guest or for a crew member.");
    }
    const menuItem = state.menuItems.find((entry) => entry.id === record.menuItemId);
    if (!menuItem) throw refusal("That menu item does not exist.");

    const lines = record.lines || [];
    if (!lines.length) throw refusal("A ring-up needs at least one ingredient line.");
    if (record.kind === "guest") {
      if (lines.some((line) => !Number.isInteger(line.shareCents) || line.shareCents < 0)) {
        throw refusal("Every line of a guest ring-up needs a share in cents.");
      }
      const shares = lines.reduce((sum, line) => sum + line.shareCents, 0);
      if (shares !== record.priceCents) {
        throw refusal(`The line shares add up to ${shares} cents but the price is ${record.priceCents} cents.`);
      }
    } else if (lines.some((line) => line.shareCents !== null && line.shareCents !== undefined)) {
      throw refusal("A crew ring-up carries no price, so its lines carry no shares.");
    }

    const drawn = new Map();
    lines.forEach((line) => {
      const bottle = bottleById(line.bottleId);
      if (!bottle) throw refusal("A stock item on this ring-up no longer exists.");
      const amount = Number(line.amount);
      checkAmount(amount, typeById(bottle.typeId), "Every line");
      if (record.kind === "guest" && (line.costCents === null || line.costCents === undefined)) {
        throw refusal("Every line of a guest ring-up needs its cost in cents.");
      }
      const cost = Number(line.costCents ?? 0);
      if (!Number.isFinite(cost) || cost < 0) throw refusal("A line cost cannot be negative.");
      drawn.set(bottle.id, (drawn.get(bottle.id) || 0) + amount);
    });
    drawn.forEach((amount, bottleId) => {
      const bottle = bottleById(bottleId);
      if (Number(bottle.remaining) + RNMBDomain.AMOUNT_EPSILON < amount) {
        throw refusal(`Not enough left in ${stockLabel(bottle)} (${bottle.remaining} left, ${round6(amount)} needed), so nothing was rung up.`);
      }
    });
    const nextBottles = RNMBDomain.applyStockDeltas(state.bottles, RNMBDomain.stockDeltasForRingUp(lines));

    // The same snapshots the database function fills in: type, buyer and ABV
    // from the stock item, and the person and menu item names.
    const saved = RNMBDomain.normalizeRingUp({
      ...record,
      tabId: record.kind === "guest" ? record.tabId : null,
      personId: person ? person.id : null,
      personName: person ? person.name : null,
      menuItemName: menuItem.name,
      priceCents: record.kind === "guest" ? record.priceCents : null,
      rungAt: record.rungAt || nowIso(),
      voidedAt: null,
      lines: lines.map((line) => {
        const bottle = bottleById(line.bottleId);
        const buyer = personById(bottle.buyerId);
        return {
          ...line,
          id: line.id || uid(),
          typeId: bottle.typeId,
          costCents: Number(line.costCents ?? 0),
          shareCents: record.kind === "guest" ? line.shareCents : null,
          buyerId: buyer ? buyer.id : null,
          buyerName: buyer ? buyer.name : "",
          abv: Number(typeById(bottle.typeId)?.abv) || 0
        };
      })
    });
    state.bottles = nextBottles;
    state.ringUps.push(saved);
    return saved;
  },

  voidRingUp(ringUpId, { local }) {
    const ringUp = state.ringUps.find((entry) => entry.id === ringUpId);
    if (!ringUp) throw refusal("That ring-up does not exist.");
    if (ringUp.voidedAt) throw refusal("That item was already voided.");
    const night = state.nights.find((entry) => entry.id === ringUp.nightId);
    if (night?.endedAt) throw refusal("This host night has ended, so its items can no longer be voided.");
    if (local && night?.startedLocally !== true) throw refusal(NOT_SAVING_MESSAGE);
    if (ringUp.kind === "guest") {
      const tab = state.guestTabs.find((entry) => entry.id === ringUp.tabId);
      if (tab?.status !== "open") throw refusal("That tab is already closed, so its items can no longer be voided.");
    }
    // Put back exactly what was drawn, never above an item's size (as the database does).
    const restore = new Map(RNMBDomain.stockDeltasForVoid(ringUp.lines).map((entry) => [entry.bottleId, entry.delta]));
    state.bottles = state.bottles.map((bottle) => (
      restore.has(bottle.id)
        ? { ...bottle, remaining: round6(Math.min(Number(bottle.size), Number(bottle.remaining) + restore.get(bottle.id))) }
        : bottle
    ));
    const voided = { ...ringUp, voidedAt: nowIso() };
    state.ringUps = state.ringUps.map((entry) => (entry.id === ringUpId ? voided : entry));
    return voided;
  },

  openTab(tab, { local }) {
    if (state.guestTabs.some((entry) => entry.id === tab.id)) throw refusal("That tab was already opened.");
    const guestName = String(tab.guestName || "").trim();
    if (!guestName) throw refusal("A tab needs the guest's name.");
    openHostNightFor(tab.nightId, local);
    const saved = RNMBDomain.normalizeTab({ id: tab.id, nightId: tab.nightId, guestName, status: "open", openedAt: tab.openedAt || nowIso() });
    state.guestTabs.push(saved);
    return saved;
  },

  closeTab({ id, status, collectorId, amountCents }, { local }) {
    const tab = state.guestTabs.find((entry) => entry.id === id);
    if (!tab) throw refusal("That tab does not exist.");
    if (tab.status !== "open") throw refusal("That tab is already closed.");
    const night = state.nights.find((entry) => entry.id === tab.nightId);
    if (local && night?.startedLocally !== true) throw refusal(NOT_SAVING_MESSAGE);
    let closed;
    if (status === "paid") {
      const collector = personById(collectorId);
      if (!collector) throw refusal("A paid tab needs the crew member who collected the money.");
      const total = RNMBDomain.tabTotalCents(id, state.ringUps);
      if (!Number.isInteger(amountCents) || amountCents !== total) {
        throw refusal(`The amount collected (${amountCents ?? "no"} cents) must equal the tab total (${total} cents).`);
      }
      closed = { ...tab, status, collectorId: collector.id, collectorName: collector.name, amountCents, closedAt: nowIso() };
    } else if (status === "written_off") {
      if ((collectorId ?? null) !== null || (amountCents ?? null) !== null) {
        throw refusal("A written-off tab has no collector and no amount.");
      }
      closed = { ...tab, status, collectorId: null, collectorName: null, amountCents: null, closedAt: nowIso() };
    } else {
      throw refusal("A tab closes as paid or written off.");
    }
    state.guestTabs = state.guestTabs.map((entry) => (entry.id === id ? closed : entry));
    return closed;
  },

  startHostNight({ id, name, date }, { local }) {
    const trimmed = String(name || "").trim();
    if (!trimmed) throw refusal("A host night needs a name.");
    if (state.nights.some((night) => night.kind === "host" && !night.endedAt)) {
      throw refusal("A host night is already running; end it before starting another.");
    }
    if (state.nights.some((night) => night.id === id)) throw refusal("That night already exists.");
    const night = RNMBDomain.normalizeNight({
      id,
      name: trimmed,
      date: date || today(),
      kind: "host",
      endedAt: null,
      pours: [],
      startedLocally: local === true
    });
    state.nights.push(night);
    state.activeNightId = night.id;
    return night;
  },

  endHostNight(nightId, { local }) {
    const night = state.nights.find((entry) => entry.id === nightId);
    if (!night) throw refusal("That night does not exist.");
    if (night.kind !== "host") throw refusal("Only a host night can be ended.");
    if (night.endedAt) throw refusal("This host night has already ended.");
    if (local && night.startedLocally !== true) throw refusal(NOT_SAVING_MESSAGE);
    const open = state.guestTabs.filter((tab) => tab.nightId === nightId && tab.status === "open").length;
    if (open > 0) {
      throw refusal(`${open} tab(s) are still open; close each one as paid or written off before ending the night.`);
    }
    const ended = { ...night, endedAt: nowIso() };
    state.nights = state.nights.map((entry) => (entry.id === nightId ? ended : entry));
    return ended;
  },

  correctStock({ id, bottleId, newRemaining }) {
    const bottle = bottleById(bottleId);
    if (!bottle) throw refusal("That stock item does not exist.");
    const level = Number(newRemaining);
    if (!Number.isFinite(level) || level < 0 || level > Number(bottle.size)) {
      throw refusal(`The new level must be between 0 and ${bottle.size} (the item's size).`);
    }
    if (!hasAtMostTwoDecimals(level)) throw refusal(`Amounts are kept to two decimal places, and ${level} has more.`);
    const type = typeById(bottle.typeId);
    if (type?.measure === RNMBDomain.MEASURE_UNIT && !Number.isInteger(level)) {
      throw refusal(`${type.name} is counted stock and is counted in whole units.`);
    }
    const adjustment = RNMBDomain.normalizeAdjustment({
      id: id || uid(),
      bottleId,
      previousRemaining: Number(bottle.remaining),
      newRemaining: level,
      adjustedAt: nowIso()
    });
    state.bottles = state.bottles.map((entry) => (entry.id === bottleId ? { ...entry, remaining: level } : entry));
    state.stockAdjustments.push(adjustment);
    return adjustment;
  },

  saveMenuItem(menuItem) {
    const saved = prepareMenuItem(menuItem);
    const exists = state.menuItems.some((entry) => entry.id === saved.id);
    state.menuItems = exists
      ? state.menuItems.map((entry) => (entry.id === saved.id ? saved : entry))
      : [...state.menuItems, saved];
    return saved;
  },

  removeMenuItem(menuItemId) {
    if (!state.menuItems.some((entry) => entry.id === menuItemId)) throw refusal("That menu item does not exist.");
    state.menuItems = state.menuItems.filter((entry) => entry.id !== menuItemId);
    // Past ring-ups keep the item's name (KTD6); only the reference goes.
    state.ringUps = state.ringUps.map((ringUp) => (ringUp.menuItemId === menuItemId ? { ...ringUp, menuItemId: null } : ringUp));
  },

  updatePricing(pricing) {
    Object.assign(state, preparePricing(pricing));
  }
};

/** Validate a menu item and fill its ids; returns the normalized item or throws a refusal. Does not touch state. */
function prepareMenuItem(menuItem) {
  const name = String(menuItem.name || "").trim();
  if (!name) throw refusal("A menu item needs a name.");
  if (!["cocktail", "straight", "counted"].includes(menuItem.kind)) {
    throw refusal("A menu item is a cocktail, a straight pour or a counted item.");
  }
  const ingredients = (menuItem.ingredients || []).map((ingredient) => ({
    id: ingredient.id || uid(),
    typeId: ingredient.typeId,
    amount: menuItem.kind === "counted" ? 1 : Number(ingredient.amount)
  }));
  if (!ingredients.length) throw refusal("A menu item needs at least one ingredient.");
  if (menuItem.kind !== "cocktail" && ingredients.length !== 1) {
    throw refusal("A straight pour or counted item has exactly one ingredient.");
  }
  ingredients.forEach((ingredient) => {
    const type = typeById(ingredient.typeId);
    if (!type) throw refusal("Every ingredient needs a stock type.");
    if (menuItem.kind === "counted" && type.measure !== RNMBDomain.MEASURE_UNIT) {
      throw refusal(`A counted item needs a counted stock type, and ${type.name} is poured.`);
    }
    if (menuItem.kind === "straight" && type.measure === RNMBDomain.MEASURE_UNIT) {
      throw refusal(`A straight pour needs a poured stock type, and ${type.name} is counted.`);
    }
    checkAmount(ingredient.amount, type, "Every ingredient");
  });
  return RNMBDomain.normalizeMenuItem({ id: menuItem.id || uid(), name, kind: menuItem.kind, ingredients });
}

/** Validate markup and rounding; returns { markupPercent, roundingIncrementCents } or throws a refusal. */
function preparePricing({ markupPercent, roundingIncrementCents }) {
  const markup = Number(markupPercent);
  const increment = Number(roundingIncrementCents);
  if (!Number.isFinite(markup) || markup < 0) throw refusal("The markup must be a percentage of 0 or more.");
  if (!Number.isInteger(increment) || increment <= 0) throw refusal("The rounding increment must be a whole number of cents above 0.");
  return { markupPercent: markup, roundingIncrementCents: increment };
}

/** Price a draft with the current settings. sources: [{ bottleId, amount }] across every ingredient. */
function buildRingUp({ id, nightId, kind, tabId, personId, menuItemId, sources }) {
  const priced = RNMBDomain.priceRingUp(sources, {
    bottles: state.bottles,
    types: state.types,
    people: state.people,
    markupPercent: state.markupPercent,
    roundingIncrementCents: state.roundingIncrementCents,
    kind
  });
  return {
    id: id || uid(),
    nightId,
    kind,
    tabId: kind === "guest" ? tabId : null,
    personId: kind === "crew" ? personId : null,
    menuItemId,
    priceCents: priced.priceCents,
    rungAt: nowIso(),
    lines: priced.lines.map((line) => ({ id: uid(), ...line }))
  };
}

function persistLocal() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function createLocalRepository() {
  // Every host-mode method validates and applies the change to `state`, then
  // stores it, or throws a readable refusal and changes nothing.
  const apply = (rule) => async (...args) => {
    const result = hostRules[rule](...args, { local: true });
    persistLocal();
    return result;
  };
  return {
    async load() {
      const local = loadLocalState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
      return local;
    },
    async saveAll(nextState) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    },
    ringUp: apply("ringUp"),
    voidRingUp: apply("voidRingUp"),
    openTab: apply("openTab"),
    closeTab: apply("closeTab"),
    startHostNight: apply("startHostNight"),
    endHostNight: apply("endHostNight"),
    correctStock: apply("correctStock"),
    saveMenuItem: apply("saveMenuItem"),
    removeMenuItem: apply("removeMenuItem"),
    updatePricing: apply("updatePricing")
  };
}

async function createRepository() {
  try {
    const response = await fetch("/api/config", { cache: "no-store" });
    if (!response.ok) throw new Error("Supabase config endpoint unavailable");
    const config = await response.json();
    if (!config.enabled || !config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error("Supabase config not set");
    }
    syncMode = "supabase";
    return createSupabaseRepository(config);
  } catch (error) {
    console.info("RNMB Command Center using localStorage fallback:", error.message);
    syncMode = "local";
    return createLocalRepository();
  }
}

function createSupabaseRepository(config) {
  const restBase = `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1`;
  // apikey only. Supabase's publishable keys (sb_publishable_...) are not JWTs,
  // and anything sent on Authorization: Bearer is parsed as one and rejected as
  // "Invalid JWT". apikey alone runs as the anon role for both key formats.
  // x-rnmb-key carries the shared passphrase that every RLS policy checks
  // (supabase/rls-passphrase.sql). Built per request rather than captured once,
  // because the user may type the passphrase after this repository exists.
  function baseHeaders() {
    return {
      apikey: config.supabaseAnonKey,
      "x-rnmb-key": accessKey,
      "Content-Type": "application/json"
    };
  }

  async function request(path, options = {}) {
    const response = await fetch(`${restBase}/${path}`, {
      ...options,
      headers: {
        ...baseHeaders(),
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      const error = new Error(`Supabase ${options.method || "GET"} ${path} failed: ${body}`);
      error.status = response.status;
      try {
        const parsed = JSON.parse(body);
        error.code = parsed?.code;
        // The host-mode functions refuse with a message that starts "RNMB:" and
        // says what to fix; carry it to the toast.
        if (typeof parsed?.message === "string" && parsed.message.startsWith("RNMB:")) {
          error.userMessage = parsed.message;
        }
      } catch {
        // Not JSON; the generic toast is all we can say.
      }
      throw error;
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function readTable(table, query = "") {
    return request(`${table}?select=*&${query}`);
  }

  // A host-mode table that does not exist yet (supabase/host-mode.sql not run)
  // answers 404 / PGRST205. Read it as missing, like checkAccess's "open".
  async function readHostModeTable(table, query) {
    try {
      return await readTable(table, query);
    } catch (error) {
      if (error.status === 404 || ["PGRST205", "42P01"].includes(error.code)) return null;
      throw error;
    }
  }

  async function rpc(name, payload) {
    if (!hostModeAvailable) throw refusal(HOST_MODE_SQL_MESSAGE);
    return request(`rpc/${name}`, { method: "POST", body: JSON.stringify({ payload }) });
  }

  function requireHostMode() {
    if (!hostModeAvailable) throw refusal(HOST_MODE_SQL_MESSAGE);
  }

  // After the database accepted a change, apply the same rule to this browser's
  // copy. If the copy was stale and the rule disagrees, reload instead.
  async function mirror(rule, ...args) {
    try {
      return hostRules[rule](...args, { local: false });
    } catch (error) {
      console.warn("Reloading after a host-mode change this browser could not mirror:", error.message);
      state = await repositoryApi.load();
      return null;
    }
  }

  const knownId = (list, id) => (id && list.some((entry) => entry.id === id) ? id : null);

  function menuItemRow(menuItem) {
    return { id: menuItem.id, name: menuItem.name, kind: menuItem.kind };
  }

  function ingredientRows(menuItem) {
    return (menuItem.ingredients || []).map((ingredient, index) => ({
      id: ingredient.id || uid(),
      menu_item_id: menuItem.id,
      type_id: ingredient.typeId,
      amount: ingredient.amount,
      line_no: index
    }));
  }

  async function deleteAll(table) {
    await request(`${table}?id=not.is.null`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
  }

  async function insertRows(table, rows) {
    if (!rows.length) return;
    await request(table, {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(rows)
    });
  }

  async function insertRow(table, row) {
    await insertRows(table, [row]);
  }

  async function patchWhere(table, filter, row) {
    await request(`${table}?${filter}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(row)
    });
  }

  async function deleteWhere(table, filter) {
    await request(`${table}?${filter}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
  }

  async function saveSettings(nextState) {
    await request("rnmb_settings?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([RNMBDomain.settingsRow(nextState, hostModeAvailable)])
    });
  }

  const repositoryApi = {
    // "open"   - the passphrase gate is not installed in Postgres (yet)
    // "ok"     - the passphrase we are holding is the right one
    // "denied" - a passphrase is required and ours is missing or wrong
    async checkAccess() {
      const response = await fetch(`${restBase}/rpc/rnmb_authorized`, {
        method: "POST",
        headers: baseHeaders(),
        body: "{}"
      });
      if (response.status === 404) return "open";
      if (!response.ok) return "denied";
      return (await response.json()) === true ? "ok" : "denied";
    },

    async load() {
      const [
        peopleRows, typeRows, bottleRows, nightRows, pourRows, settingsRows,
        menuItemRows, ingredientRowsRead, tabRows, ringUpRows, lineRows, adjustmentRows
      ] = await Promise.all([
        readTable("rnmb_people", "order=created_at.asc"),
        readTable("rnmb_beverage_types", "order=created_at.asc"),
        readTable("rnmb_bottles", "order=created_at.asc"),
        readTable("rnmb_nights", "order=date.desc,created_at.desc"),
        readTable("rnmb_pours", "order=poured_at.asc"),
        readTable("rnmb_settings", "id=eq.true"),
        readHostModeTable("rnmb_menu_items", "order=created_at.asc"),
        readHostModeTable("rnmb_recipe_ingredients", "order=line_no.asc,created_at.asc"),
        readHostModeTable("rnmb_guest_tabs", "order=opened_at.asc"),
        readHostModeTable("rnmb_ring_ups", "order=rung_at.asc"),
        readHostModeTable("rnmb_ring_up_lines", "order=line_no.asc"),
        readHostModeTable("rnmb_stock_adjustments", "order=adjusted_at.asc")
      ]);
      const hostTables = [menuItemRows, ingredientRowsRead, tabRows, ringUpRows, lineRows, adjustmentRows];
      hostModeAvailable = hostTables.every((rows) => rows !== null);

      const groupBy = (rows, key) => {
        const groups = new Map();
        (rows || []).forEach((row) => {
          if (!groups.has(row[key])) groups.set(row[key], []);
          groups.get(row[key]).push(row);
        });
        return groups;
      };
      const ingredientsByItem = groupBy(ingredientRowsRead, "menu_item_id");
      const linesByRingUp = groupBy(lineRows, "ring_up_id");

      const nights = nightRows.map((night) => ({
        id: night.id,
        name: night.name,
        date: night.date,
        kind: night.kind,
        endedAt: night.ended_at,
        pours: pourRows
          .filter((pour) => pour.night_id === night.id)
          .map((pour) => ({
            id: pour.id,
            personId: pour.person_id,
            bottleId: pour.bottle_id,
            ounces: Number(pour.ounces),
            abv: Number(pour.abv_snapshot),
            timestamp: pour.poured_at
          }))
      }));

      const settings = settingsRows[0] || {};
      return normalizeState({
        people: peopleRows.map((person) => ({
          id: person.id,
          name: person.name,
          color: person.color
        })),
        types: typeRows.map((type) => ({
          id: type.id,
          name: type.name,
          category: type.category,
          abv: Number(type.abv),
          measure: type.measure,
          unitOz: type.unit_oz
        })),
        bottles: bottleRows.map((bottle) => ({
          id: bottle.id,
          typeId: bottle.type_id,
          nickname: bottle.nickname || "",
          size: Number(bottle.size_oz),
          remaining: Number(bottle.remaining_oz),
          price: Number(bottle.price),
          buyerId: bottle.buyer_id || "",
          date: bottle.purchase_date
        })),
        nights,
        menuItems: (menuItemRows || []).map((item) => ({
          id: item.id,
          name: item.name,
          kind: item.kind,
          ingredients: (ingredientsByItem.get(item.id) || []).map((ingredient) => ({
            id: ingredient.id,
            typeId: ingredient.type_id,
            amount: ingredient.amount
          }))
        })),
        guestTabs: (tabRows || []).map((tab) => ({
          id: tab.id,
          nightId: tab.night_id,
          guestName: tab.guest_name,
          status: tab.status,
          collectorId: tab.collector_id,
          collectorName: tab.collector_name,
          amountCents: tab.amount_cents,
          openedAt: tab.opened_at,
          closedAt: tab.closed_at
        })),
        ringUps: (ringUpRows || []).map((ringUp) => ({
          id: ringUp.id,
          nightId: ringUp.night_id,
          kind: ringUp.kind,
          tabId: ringUp.tab_id,
          personId: ringUp.person_id,
          personName: ringUp.person_name,
          menuItemId: ringUp.menu_item_id,
          menuItemName: ringUp.menu_item_name,
          priceCents: ringUp.price_cents,
          rungAt: ringUp.rung_at,
          voidedAt: ringUp.voided_at,
          lines: (linesByRingUp.get(ringUp.id) || []).map((line) => ({
            id: line.id,
            bottleId: line.bottle_id,
            typeId: line.type_id,
            amount: line.amount,
            costCents: line.cost_cents,
            shareCents: line.share_cents,
            buyerId: line.buyer_id,
            buyerName: line.buyer_name,
            abv: line.abv_snapshot
          }))
        })),
        stockAdjustments: (adjustmentRows || []).map((adjustment) => ({
          id: adjustment.id,
          bottleId: adjustment.bottle_id,
          previousRemaining: adjustment.previous_remaining,
          newRemaining: adjustment.new_remaining,
          adjustedAt: adjustment.adjusted_at
        })),
        activeNightId: settings.active_night_id || nights[0]?.id || "",
        responsibleMode: settings.responsible_mode !== false,
        markupPercent: settings.markup_percent,
        roundingIncrementCents: settings.rounding_increment_cents
      });
    },
    async saveAll(nextState) {
      // Replacing the database would silently drop money and stock history the
      // pre-host-mode schema has nowhere to keep, so refuse before deleting anything.
      const hasHostHistory = nextState.guestTabs.length || nextState.ringUps.length ||
        nextState.stockAdjustments.length || nextState.nights.some((night) => night.kind === "host");
      if (!hostModeAvailable && hasHostHistory) throw refusal(`This data includes host-night records. ${HOST_MODE_SQL_MESSAGE}`);

      await request("rnmb_settings?id=eq.true", {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ active_night_id: null })
      }).catch(() => undefined);

      // Children before parents: the host-mode tables reference nights, people,
      // bottles and types, and bottles and tabs refuse deletes while referenced.
      if (hostModeAvailable) {
        await deleteAll("rnmb_ring_up_lines");
        await deleteAll("rnmb_ring_ups");
        await deleteAll("rnmb_guest_tabs");
        await deleteAll("rnmb_stock_adjustments");
        await deleteAll("rnmb_recipe_ingredients");
        await deleteAll("rnmb_menu_items");
      }
      await deleteAll("rnmb_pours");
      await deleteAll("rnmb_bottles");
      await deleteAll("rnmb_nights");
      await deleteAll("rnmb_beverage_types");
      await deleteAll("rnmb_people");

      await insertRows("rnmb_people", nextState.people.map((person) => ({
        id: person.id,
        name: person.name,
        color: person.color
      })));
      await insertRows("rnmb_beverage_types", nextState.types.map((type) => RNMBDomain.typeRow(type, hostModeAvailable)));
      await insertRows("rnmb_nights", nextState.nights.map((night) => RNMBDomain.nightRow(night, hostModeAvailable)));
      await insertRows("rnmb_bottles", nextState.bottles.map((bottle) => RNMBDomain.bottleRow(bottle)));
      await insertRows("rnmb_pours", nextState.nights.flatMap((night) => (
        (night.pours || []).map((pour) => ({
          id: pour.id,
          night_id: night.id,
          person_id: pour.personId,
          bottle_id: pour.bottleId,
          ounces: pour.ounces,
          abv_snapshot: pour.abv,
          poured_at: pour.timestamp
        }))
      )));

      if (hostModeAvailable) {
        // Every row in one bulk insert must carry the same keys, and person and
        // menu references that no longer exist become null (their names stay).
        const people = nextState.people;
        await insertRows("rnmb_menu_items", nextState.menuItems.map(menuItemRow));
        await insertRows("rnmb_recipe_ingredients", nextState.menuItems.flatMap(ingredientRows));
        await insertRows("rnmb_guest_tabs", nextState.guestTabs.map((tab) => ({
          id: tab.id,
          night_id: tab.nightId,
          guest_name: tab.guestName,
          status: tab.status,
          collector_id: knownId(people, tab.collectorId),
          collector_name: tab.collectorName,
          amount_cents: tab.amountCents,
          opened_at: tab.openedAt || nowIso(),
          closed_at: tab.closedAt
        })));
        await insertRows("rnmb_ring_ups", nextState.ringUps.map((ringUp) => ({
          id: ringUp.id,
          night_id: ringUp.nightId,
          kind: ringUp.kind,
          tab_id: ringUp.kind === "guest" ? ringUp.tabId : null,
          person_id: ringUp.kind === "crew" ? knownId(people, ringUp.personId) : null,
          person_name: ringUp.kind === "crew" ? ringUp.personName || "Unknown" : null,
          menu_item_id: knownId(nextState.menuItems, ringUp.menuItemId),
          menu_item_name: ringUp.menuItemName || "Unknown",
          price_cents: ringUp.kind === "guest" ? ringUp.priceCents : null,
          rung_at: ringUp.rungAt || nowIso(),
          voided_at: ringUp.voidedAt
        })));
        await insertRows("rnmb_ring_up_lines", nextState.ringUps.flatMap((ringUp) => ringUp.lines.map((line, index) => ({
          id: line.id || uid(),
          ring_up_id: ringUp.id,
          line_no: index + 1,
          bottle_id: line.bottleId,
          type_id: line.typeId,
          amount: line.amount,
          cost_cents: line.costCents,
          share_cents: ringUp.kind === "guest" ? line.shareCents : null,
          buyer_id: knownId(people, line.buyerId),
          buyer_name: line.buyerName || null,
          abv_snapshot: line.abv
        }))));
        await insertRows("rnmb_stock_adjustments", nextState.stockAdjustments.map((adjustment) => ({
          id: adjustment.id,
          bottle_id: adjustment.bottleId,
          previous_remaining: adjustment.previousRemaining,
          new_remaining: adjustment.newRemaining,
          adjusted_at: adjustment.adjustedAt || nowIso()
        })));
      }
      await saveSettings(nextState);
    },
    async updateSettings(nextState) {
      await saveSettings(nextState);
    },
    async addPerson(person) {
      await insertRow("rnmb_people", {
        id: person.id,
        name: person.name,
        color: person.color
      });
    },
    async addType(type) {
      await insertRow("rnmb_beverage_types", RNMBDomain.typeRow(type, hostModeAvailable));
    },
    async addBottle(bottle) {
      await insertRow("rnmb_bottles", RNMBDomain.bottleRow(bottle));
    },
    async addNight(night, nextState) {
      await insertRow("rnmb_nights", RNMBDomain.nightRow(night, hostModeAvailable));
      await saveSettings(nextState);
    },
    async addPour(night, pour, remaining) {
      if (hostModeAvailable) {
        // KTD13: one call that takes the amount off the level in the database
        // right now, so a stale copy here cannot undo another device's sales.
        await rpc("rnmb_add_crew_pour", {
          id: pour.id,
          night_id: night.id,
          person_id: pour.personId,
          bottle_id: pour.bottleId,
          ounces: pour.ounces,
          poured_at: pour.timestamp
        });
        return;
      }
      await patchWhere("rnmb_bottles", `id=eq.${pour.bottleId}`, { remaining_oz: remaining });
      await insertRow("rnmb_pours", {
        id: pour.id,
        night_id: night.id,
        person_id: pour.personId,
        bottle_id: pour.bottleId,
        ounces: pour.ounces,
        abv_snapshot: pour.abv,
        poured_at: pour.timestamp
      });
    },
    async removePour(pour, restoredRemaining) {
      if (hostModeAvailable) {
        await rpc("rnmb_remove_crew_pour", { id: pour.id });
        return;
      }
      await deleteWhere("rnmb_pours", `id=eq.${pour.id}`);
      await patchWhere("rnmb_bottles", `id=eq.${pour.bottleId}`, { remaining_oz: restoredRemaining });
    },
    async removeBottle(bottleId) {
      if (bottleHasSales(bottleId)) throw refusal(SOLD_BOTTLE_MESSAGE);
      try {
        await deleteWhere("rnmb_bottles", `id=eq.${bottleId}`);
      } catch (error) {
        // Another device sold from it since this copy loaded (on delete restrict).
        if (error.status === 409 || error.code === "23503") throw refusal(SOLD_BOTTLE_MESSAGE);
        throw error;
      }
    },
    async removePerson(personId) {
      await deleteWhere("rnmb_people", `id=eq.${personId}`);
    },

    // ---- host mode: one database function call each (KTD3), then mirrored ----
    async ringUp(record) {
      await rpc("rnmb_ring_up", {
        id: record.id,
        night_id: record.nightId,
        kind: record.kind,
        ...(record.kind === "guest" ? { tab_id: record.tabId, price_cents: record.priceCents } : { person_id: record.personId }),
        menu_item_id: record.menuItemId,
        rung_at: record.rungAt,
        lines: record.lines.map((line) => ({
          id: line.id,
          bottle_id: line.bottleId,
          amount: line.amount,
          cost_cents: line.costCents,
          ...(record.kind === "guest" ? { share_cents: line.shareCents } : {})
        }))
      });
      return mirror("ringUp", record);
    },
    async voidRingUp(ringUpId) {
      await rpc("rnmb_void_ring_up", { id: ringUpId });
      return mirror("voidRingUp", ringUpId);
    },
    async openTab(tab) {
      await rpc("rnmb_open_tab", { id: tab.id, night_id: tab.nightId, guest_name: tab.guestName, opened_at: tab.openedAt || nowIso() });
      return mirror("openTab", tab);
    },
    async closeTab(closing) {
      await rpc("rnmb_close_tab", {
        id: closing.id,
        status: closing.status,
        ...(closing.status === "paid" ? { collector_id: closing.collectorId, amount_cents: closing.amountCents } : {})
      });
      return mirror("closeTab", closing);
    },
    async startHostNight(night) {
      await rpc("rnmb_start_host_night", { id: night.id, name: night.name, date: night.date || today() });
      const started = await mirror("startHostNight", night);
      // The function does not touch settings; making the new night active is ours.
      state.activeNightId = night.id;
      await saveSettings(state);
      return started;
    },
    async endHostNight(nightId) {
      await rpc("rnmb_end_host_night", { id: nightId });
      return mirror("endHostNight", nightId);
    },
    async correctStock(correction) {
      const withId = { ...correction, id: correction.id || uid() };
      await rpc("rnmb_correct_stock", { id: withId.id, bottle_id: withId.bottleId, new_remaining: withId.newRemaining });
      return mirror("correctStock", withId);
    },
    // Menu items and recipes are plain table writes; the gated policies allow them.
    async saveMenuItem(menuItem) {
      requireHostMode();
      const exists = state.menuItems.some((entry) => entry.id === menuItem.id);
      // Validate and fill ids first, so the rows sent are the rows kept.
      const saved = prepareMenuItem(menuItem);
      if (exists) {
        await patchWhere("rnmb_menu_items", `id=eq.${saved.id}`, { name: saved.name, kind: saved.kind });
        await deleteWhere("rnmb_recipe_ingredients", `menu_item_id=eq.${saved.id}`);
      } else {
        await insertRow("rnmb_menu_items", menuItemRow(saved));
      }
      await insertRows("rnmb_recipe_ingredients", ingredientRows(saved));
      return mirror("saveMenuItem", saved);
    },
    async removeMenuItem(menuItemId) {
      requireHostMode();
      await deleteWhere("rnmb_menu_items", `id=eq.${menuItemId}`);
      return mirror("removeMenuItem", menuItemId);
    },
    async updatePricing(pricing) {
      requireHostMode();
      await saveSettings({ ...state, ...preparePricing(pricing) });
      return mirror("updatePricing", pricing);
    }
  };
  return repositoryApi;
}

// The shared passphrase gates every table (supabase/rls-passphrase.sql). Ask for
// it once and remember it. A wrong passphrase otherwise reads as an empty
// dashboard, because a denied SELECT returns [] with a 200 rather than an error.
// "open" means the SQL has not been run yet, so this deploy is safe to ship
// before the migration - and safe to ship after it too.
async function unlockSupabase() {
  accessKey = localStorage.getItem(ACCESS_STORAGE_KEY) || "";
  let status = await repository.checkAccess();
  if (status === "open" || status === "ok") return true;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = window.prompt("RNMB passphrase:");
    if (entry === null) break;
    accessKey = entry.trim();
    status = await repository.checkAccess();
    if (status === "ok") {
      localStorage.setItem(ACCESS_STORAGE_KEY, accessKey);
      return true;
    }
    showToast("That passphrase was not recognised.");
  }

  accessKey = "";
  localStorage.removeItem(ACCESS_STORAGE_KEY);
  return false;
}

async function init() {
  try {
    repository = await createRepository();
    if (syncMode === "supabase" && !(await unlockSupabase())) {
      repository = createLocalRepository();
      syncMode = "local";
      hostModeAvailable = true;
      showToast("No passphrase. Using local browser storage.");
    }
    state = await repository.load();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    lastSyncedAt = new Date();
    render();
    startAutoRefresh();
    showToast(syncMode === "supabase" ? "Connected to Supabase." : "Using local browser storage.");
  } catch (error) {
    console.error(error);
    repository = createLocalRepository();
    syncMode = "local";
    hostModeAvailable = true;
    state = await repository.load();
    render();
    showToast("Supabase load failed. Using local browser storage.");
  }
}

/*
 * Two ways to save. saveState is today's pattern: the handler has already
 * changed `state`, Supabase mode sends one targeted write and local mode stores
 * the whole state. hostAction is for host-mode changes (ring-ups, tabs, host
 * nights, stock corrections, menu and pricing): the repository itself checks the
 * rules and applies the change to `state` in both modes, so the handler must
 * not change `state` first. Both return true on success and false on failure.
 */
async function saveState(message, supabaseOperation) {
  return commitSave(message, async () => {
    if (syncMode === "supabase" && supabaseOperation) {
      await supabaseOperation(repository);
    } else {
      await repository.saveAll(state);
    }
  });
}

async function hostAction(message, operation) {
  return commitSave(message, () => operation(repository));
}

async function commitSave(message, write) {
  saveInFlight = true;
  try {
    await write();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
    if (message) showToast(message);
    return true;
  } catch (error) {
    // A refusal is the app working as intended (a rule said no), not a bug.
    if (error.userMessage) console.warn(error.message);
    else console.error(error);
    if (syncMode === "supabase") {
      try {
        state = await repository.load();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (reloadError) {
        console.error(reloadError);
      }
    }
    render();
    showToast(error.userMessage || "Save failed. Check Supabase settings and policies.");
    return false;
  } finally {
    saveInFlight = false;
    lastSyncedAt = new Date();
  }
}

/*
 * Shared state is read once at boot and never again, so two people on the same
 * dashboard never saw each other's pours. There is no realtime subscription
 * here on purpose: the app has no dependencies and adding a websocket client
 * would be the only one. Polling a dozen small tables every 15s is enough for a
 * dashboard a handful of people watch for an evening.
 */
const REFRESH_MS = 15000;
let refreshTimer = null;

/** Never redraw the form a user is mid-way through filling in, or swap state under a half-built register order. */
function isUserBusy() {
  if (registerDraftUnfinished()) return true;
  const el = document.activeElement;
  return Boolean(el) && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName);
}

async function refreshFromServer() {
  if (syncMode !== "supabase" || saveInFlight) return;
  // No "force" escape hatch on purpose: the one caller that wanted it was the
  // tab regaining focus, which is exactly when a restored cursor sits in a
  // half-typed field. Waiting one interval costs nothing; eating the draft does.
  if (isUserBusy() || document.hidden) return;

  try {
    const incoming = await repository.load();
    lastSyncedAt = new Date();
    // render() rebuilds every panel from innerHTML, so redraw only on a real
    // change: an unconditional repaint every 15s would fight the user's scroll.
    if (JSON.stringify(incoming) !== JSON.stringify(state)) {
      state = incoming;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      render();
      showToast("Updated from the shared dashboard.");
    } else {
      renderTopline();
    }
  } catch (error) {
    console.error(error);
  }
}

function startAutoRefresh() {
  if (refreshTimer) window.clearInterval(refreshTimer);
  if (syncMode !== "supabase") return;
  refreshTimer = window.setInterval(refreshFromServer, REFRESH_MS);
}

// A tab left open all evening is the normal case here, so catch up the moment
// it comes back to the front rather than waiting out the interval.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshFromServer();
});

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function typeById(id) {
  return state.types.find((type) => type.id === id);
}

function personById(id) {
  return state.people.find((person) => person.id === id);
}

function bottleById(id) {
  return state.bottles.find((bottle) => bottle.id === id);
}

function activeNight() {
  return state.nights.find((night) => night.id === state.activeNightId) || state.nights[0];
}

/*
 * Amounts are in the stock type's measure: ounces for poured stock, whole units
 * for counted stock (KTD5). Every ounce and standard-drink figure goes through
 * RNMBDomain.measureAmount, so a can counts as its unit volume, not as "1 oz".
 */
function isCounted(type) {
  return type?.measure === RNMBDomain.MEASURE_UNIT;
}

/** "1.5 oz", "1 unit", "12 units". */
function amountText(type, amount) {
  if (!isCounted(type)) return `${oneDecimal(amount)} oz`;
  const count = Math.round(Number(amount) || 0);
  return `${count} ${count === 1 ? "unit" : "units"}`;
}

/** "19.2 of 25.4 oz" or "11 of 12 units". */
function levelText(type, remaining, size) {
  const figure = isCounted(type) ? String(Math.round(Number(remaining) || 0)) : oneDecimal(remaining);
  return `${figure} of ${amountText(type, size)}`;
}

/** A crew pour in ounces and standard drinks. Its ABV snapshot wins; a missing (0) snapshot falls back to the type. */
function measurePour(pour) {
  const type = typeById(bottleById(pour.bottleId)?.typeId);
  const snapshot = Number(pour.abv) > 0 ? Number(pour.abv) : undefined;
  return RNMBDomain.measureAmount(type, pour.ounces, snapshot);
}

/** What is left in a stock item, in ounces and standard drinks. */
function measureRemaining(bottle) {
  return RNMBDomain.measureAmount(typeById(bottle.typeId), bottle.remaining);
}

function bottleLabel(bottle) {
  const type = typeById(bottle.typeId);
  const nickname = bottle.nickname ? `: ${bottle.nickname}` : "";
  return `${type?.name || "Unknown"}${nickname}`;
}

function totalSpend() {
  return state.bottles.reduce((sum, bottle) => sum + Number(bottle.price || 0), 0);
}

function totalRemainingStandardDrinks() {
  return state.bottles.reduce((sum, bottle) => sum + measureRemaining(bottle).standardDrinks, 0);
}

function activeNightTotals() {
  const night = activeNight();
  const totals = new Map(state.people.map((person) => [person.id, { ounces: 0, drinks: 0 }]));
  let allDrinks = 0;
  let allOunces = 0;

  night?.pours?.forEach((pour) => {
    const measured = measurePour(pour);
    const current = totals.get(pour.personId) || { ounces: 0, drinks: 0 };
    current.ounces += measured.ounces;
    current.drinks += measured.standardDrinks;
    totals.set(pour.personId, current);
    allDrinks += measured.standardDrinks;
    allOunces += measured.ounces;
  });

  return { byPerson: totals, allDrinks, allOunces };
}

function spendByPerson() {
  const totals = new Map(state.people.map((person) => [person.id, 0]));
  state.bottles.forEach((bottle) => {
    // Only money with a live buyer lands on a person. A blank buyerId (left
    // behind when someone is removed) or an id whose person no longer exists
    // used to create a Map key matching nobody: the money stayed in the total
    // and in everyone's share, but appeared in no bar and no settle-up row, so
    // the deltas silently stopped summing to zero.
    if (!totals.has(bottle.buyerId)) return;
    totals.set(bottle.buyerId, totals.get(bottle.buyerId) + Number(bottle.price || 0));
  });
  return totals;
}

/** Money on bottles whose buyer is blank or has been removed. Counted in the total, credited to no one. */
function unassignedSpend() {
  const known = new Set(state.people.map((person) => person.id));
  return state.bottles
    .filter((bottle) => !known.has(bottle.buyerId))
    .reduce((sum, bottle) => sum + Number(bottle.price || 0), 0);
}

function statusForDrinks(drinks) {
  if (drinks >= 4) return { label: "Water order", className: "hot", meta: "Hydration desk is opening a case file." };
  if (drinks >= 2.5) return { label: "Pace check", className: "warn", meta: "Snack bureau recommends a pause." };
  return { label: "Green", className: "", meta: "Within dashboard comfort range." };
}

function setOptions(select, items, labeler, emptyLabel) {
  select.innerHTML = "";
  if (!items.length && emptyLabel) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    return;
  }
  items.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = labeler(item);
    select.append(option);
  });
}

function render() {
  renderTopline();
  renderForms();
  renderOverview();
  renderTonight();
  renderInventory();
  renderMenu();
  renderLedger();
  renderCrew();
  renderRegister();
}

function renderTopline() {
  const night = activeNight();
  document.querySelector("#activeNightName").textContent = night?.name || "No active night";
  document.querySelector("#activeNightMeta").textContent = night ? `${night.date} · ${night.pours.length} pours logged` : "Create a night log to start tracking pours.";
  document.querySelector("#responsibleMode").checked = state.responsibleMode;
  const syncStatus = document.querySelector("#syncStatus");
  if (syncMode === "supabase") {
    const stamp = lastSyncedAt
      ? lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "not yet";
    syncStatus.textContent = "Supabase shared DB";
    syncStatus.title = `Checks for other people's changes every ${REFRESH_MS / 1000}s`;
    document.querySelector("#syncMeta").textContent = `Synced ${stamp}`;
  } else {
    syncStatus.textContent = "Local browser storage";
    syncStatus.title = "This browser only. Nothing is shared.";
    document.querySelector("#syncMeta").textContent = "Private to this browser";
  }
}

function renderForms() {
  document.querySelector("[name='date']").value ||= today();
  document.querySelector("#bottleForm [name='date']").value ||= today();

  setOptions(document.querySelector("#nightSelect"), state.nights, (night) => `${night.date} · ${night.name}`, "No nights yet");
  document.querySelector("#nightSelect").value = state.activeNightId || "";

  document.querySelectorAll("#pourForm select[name='personId'], #bottleForm select[name='buyerId']").forEach((select) => {
    setOptions(select, state.people, (person) => person.name, "Add people first");
  });
  // Options are rebuilt on every render; keep the chosen type and bottle when they still exist.
  const typeSelect = document.querySelector("#bottleForm select[name='typeId']");
  const chosenType = typeSelect.value;
  setOptions(typeSelect, state.types, (type) => `${type.name} · ${type.abv}%${isCounted(type) ? " · counted" : ""}`, "Add types first");
  if (state.types.some((type) => type.id === chosenType)) typeSelect.value = chosenType;
  syncBottleSizeField();

  // Crew pours are alcohol only (mixers are ingredients, not drinks), and only from stock that has some left.
  const bottleSelect = document.querySelector("#pourForm select[name='bottleId']");
  const chosenBottle = bottleSelect.value;
  const pourable = state.bottles.filter((bottle) => Number(typeById(bottle.typeId)?.abv) > 0 && Number(bottle.remaining) > 0);
  setOptions(
    bottleSelect,
    pourable,
    (bottle) => `${bottleLabel(bottle)} · ${amountText(typeById(bottle.typeId), bottle.remaining)} left`,
    "No stocked bottles"
  );
  if (pourable.some((bottle) => bottle.id === chosenBottle)) bottleSelect.value = chosenBottle;
  syncPourAmountField();
}

const POURED_SIZE_DEFAULT = 25.36;
const COUNTED_SIZE_DEFAULT = 12;

/** Add Stock: the size is ounces for poured types and whole units for counted ones. */
function syncBottleSizeField() {
  const form = document.querySelector("#bottleForm");
  const input = form.querySelector("[name='sizeOz']");
  const counted = isCounted(typeById(form.querySelector("[name='typeId']").value));
  const measure = counted ? RNMBDomain.MEASURE_UNIT : RNMBDomain.MEASURE_OZ;
  // Swap the default only when the measure changes, so a typed size survives a re-render.
  if (input.dataset.measure !== measure) input.value = counted ? COUNTED_SIZE_DEFAULT : POURED_SIZE_DEFAULT;
  input.dataset.measure = measure;
  input.min = "1";
  input.step = counted ? "1" : "0.01";
  document.querySelector("#bottleSizeLabel").textContent = counted ? "Size units" : "Size oz";
}

/** Log Consumption: a count for counted stock, ounces for poured stock. */
function syncPourAmountField() {
  const form = document.querySelector("#pourForm");
  const input = form.querySelector("[name='ounces']");
  const counted = isCounted(typeById(bottleById(form.querySelector("[name='bottleId']").value)?.typeId));
  const measure = counted ? RNMBDomain.MEASURE_UNIT : RNMBDomain.MEASURE_OZ;
  if (input.dataset.measure !== measure) input.value = counted ? 1 : 1.5;
  input.dataset.measure = measure;
  input.min = counted ? "1" : "0.1";
  input.step = counted ? "1" : "0.1";
  document.querySelector("#pourAmountLabel").textContent = counted ? "Units consumed" : "Ounces consumed";
}

/** Add Type: unit volume is shown, required and submitted only for counted types. */
function syncTypeMeasureField() {
  const form = document.querySelector("#typeForm");
  const counted = form.querySelector("[name='measure']").value === RNMBDomain.MEASURE_UNIT;
  const unitOz = form.querySelector("[name='unitOz']");
  document.querySelector("#typeUnitOzField").hidden = !counted;
  unitOz.disabled = !counted;
  unitOz.required = counted;
}

function renderOverview() {
  const totals = activeNightTotals();
  const maxPersonDrinks = Math.max(0, ...Array.from(totals.byPerson.values()).map((entry) => entry.drinks));
  const check = statusForDrinks(maxPersonDrinks);
  const alertCard = document.querySelector(".alert-card");

  document.querySelector("#metricSpend").textContent = money(totalSpend());
  document.querySelector("#metricSpendMeta").textContent = `${state.bottles.length} purchases logged`;
  document.querySelector("#metricConsumed").textContent = oneDecimal(totals.allDrinks);
  document.querySelector("#metricInventory").textContent = state.bottles.length;
  document.querySelector("#metricInventoryMeta").textContent = `${oneDecimal(totalRemainingStandardDrinks())} standard drinks remaining`;
  document.querySelector("#metricCheck").textContent = check.label;
  document.querySelector("#metricCheckMeta").textContent = check.meta;
  alertCard.classList.toggle("is-caution", check.className === "warn");
  alertCard.classList.toggle("is-red", check.className === "hot");

  renderSpendBars();
  renderLowSupply();
  renderRecentNights();
}

function renderSpendBars() {
  const target = document.querySelector("#spendBars");
  const spends = spendByPerson();
  const unassigned = unassignedSpend();
  const max = Math.max(1, unassigned, ...Array.from(spends.values()));
  target.innerHTML = "";
  target.classList.toggle("empty-state", state.bottles.length === 0);
  if (!state.bottles.length) {
    target.textContent = "No receipts have entered evidence.";
    return;
  }

  state.people.forEach((person) => {
    const spent = spends.get(person.id) || 0;
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-meta"><strong>${escapeHtml(person.name)}</strong><span>${money(spent)}</span></div>
      <div class="bar-track"><span class="bar-fill" style="--bar-width: ${(spent / max) * 100}%; --person-color: ${safeColor(person.color)}"></span></div>
    `;
    target.append(row);
  });

  if (unassigned > 0) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <div class="bar-meta"><strong>Unassigned</strong><span>${money(unassigned)}</span></div>
      <div class="bar-track"><span class="bar-fill" style="--bar-width: ${(unassigned / max) * 100}%; --person-color: var(--muted)"></span></div>
    `;
    target.append(row);
  }
}

function renderLowSupply() {
  const target = document.querySelector("#lowSupplyList");
  const low = state.bottles
    .map((bottle) => ({ bottle, ratio: Number(bottle.remaining || 0) / Number(bottle.size || 1) }))
    .filter((entry) => entry.ratio <= 0.25)
    .sort((a, b) => a.ratio - b.ratio);

  target.innerHTML = "";
  target.classList.toggle("empty-state", low.length === 0);
  if (!low.length) {
    target.textContent = "No bottles are filing a distress report.";
    return;
  }

  low.forEach(({ bottle, ratio }) => {
    const item = document.createElement("div");
    item.className = "stack-item";
    item.innerHTML = `<strong>${escapeHtml(bottleLabel(bottle))}</strong><br><small>${amountText(typeById(bottle.typeId), bottle.remaining)} left · ${Math.round(ratio * 100)}%</small>`;
    target.append(item);
  });
}

function renderRecentNights() {
  const target = document.querySelector("#recentNights");
  const nights = [...state.nights].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5);
  target.innerHTML = "";
  target.classList.toggle("empty-state", nights.length === 0);
  if (!nights.length) {
    target.textContent = "No missions logged yet.";
    return;
  }

  nights.forEach((night) => {
    const drinks = night.pours.reduce((sum, pour) => sum + measurePour(pour).standardDrinks, 0);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "stack-item";
    item.innerHTML = `<strong>${escapeHtml(night.name)}</strong><br><small>${night.date} · ${oneDecimal(drinks)} standard drinks</small>`;
    item.addEventListener("click", async () => {
      state.activeNightId = night.id;
      await saveState("Active night switched.", (db) => db.updateSettings(state));
      activateTab("tonight");
    });
    target.append(item);
  });
}

function renderTonight() {
  const target = document.querySelector("#personConsumption");
  const timeline = document.querySelector("#pourTimeline");
  const night = activeNight();
  const totals = activeNightTotals();

  target.innerHTML = "";
  target.classList.toggle("empty-state", state.people.length === 0 || !night?.pours?.length);
  if (!state.people.length || !night?.pours?.length) {
    target.textContent = "No pours logged for the active night.";
  } else {
    state.people.forEach((person) => {
      const entry = totals.byPerson.get(person.id) || { ounces: 0, drinks: 0 };
      const status = statusForDrinks(entry.drinks);
      const card = document.createElement("article");
      card.className = "consumption-card";
      card.innerHTML = `
        <div class="person-card">
          <span class="avatar" style="--person-color: ${safeColor(person.color)}">${initials(person.name)}</span>
          <div class="person-copy"><strong>${escapeHtml(person.name)}</strong><small>${oneDecimal(entry.ounces)} oz total</small></div>
        </div>
        <strong>${oneDecimal(entry.drinks)}</strong>
        <span class="pill ${status.className}">${status.label}</span>
      `;
      target.append(card);
    });
  }

  timeline.innerHTML = "";
  const pours = [...(night?.pours || [])].reverse().slice(0, 12);
  timeline.classList.toggle("empty-state", pours.length === 0);
  if (!pours.length) {
    timeline.textContent = "The logbook is still clean.";
    return;
  }

  pours.forEach((pour) => {
    const person = personById(pour.personId);
    const bottle = bottleById(pour.bottleId);
    const type = typeById(bottle?.typeId);
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(person?.name || "Unknown")} logged ${amountText(type, pour.ounces)}</strong>
        <small>${escapeHtml(type?.name || "Unknown")} · ${oneDecimal(measurePour(pour).standardDrinks)} standard drinks</small>
      </div>
      <button class="remove-button" type="button" data-remove-pour="${pour.id}" aria-label="Remove pour">×</button>
    `;
    timeline.append(item);
  });
}

function renderInventory() {
  const inventory = document.querySelector("#inventoryList");
  const typeList = document.querySelector("#typeList");

  inventory.innerHTML = "";
  inventory.classList.toggle("empty-state", state.bottles.length === 0);
  if (!state.bottles.length) {
    inventory.textContent = "No bottles logged yet.";
  } else {
    state.bottles.forEach((bottle) => {
      const type = typeById(bottle.typeId);
      const buyer = personById(bottle.buyerId);
      const fill = Math.max(0, Math.min(100, (Number(bottle.remaining || 0) / Number(bottle.size || 1)) * 100));
      const counted = isCounted(type);
      // Mixers carry no alcohol, so they get no standard-drink figure at all (1.3.2).
      const drinksLeft = Number(type?.abv) > 0
        ? `${oneDecimal(measureRemaining(bottle).standardDrinks)} standard drinks left`
        : "no alcohol";
      const level = counted ? Math.round(Number(bottle.remaining) || 0) : Math.round((Number(bottle.remaining) || 0) * 100) / 100;
      const card = document.createElement("article");
      card.className = "inventory-card";
      card.dataset.bottleId = bottle.id;
      card.innerHTML = `
        <header>
          <div>
            <strong>${escapeHtml(type?.name || "Unknown")}</strong>
            <small>${escapeHtml(bottle.nickname || type?.category || "Stock")}</small>
          </div>
          <span class="pill">${oneDecimal(type?.abv || 0)}%</span>
        </header>
        <div class="progress"><span style="--fill: ${fill}%"></span></div>
        <small>${levelText(type, bottle.remaining, bottle.size)} · ${drinksLeft}</small>
        <small>${money(bottle.price)} paid by ${escapeHtml(buyer?.name || "Unknown")}</small>
        <form class="level-form" data-level-form="${escapeHtml(bottle.id)}">
          <label>
            <span>Set level (${counted ? "units" : "oz"})</span>
            <input name="level" type="number" min="0" max="${Number(bottle.size) || 0}" step="${counted ? "1" : "0.01"}" value="${level}" required>
          </label>
          <button type="submit">Set</button>
        </form>
        <button class="remove-button" type="button" data-remove-bottle="${escapeHtml(bottle.id)}" aria-label="Remove bottle">×</button>
      `;
      inventory.append(card);
    });
  }

  typeList.innerHTML = "";
  typeList.classList.toggle("empty-state", state.types.length === 0);
  if (!state.types.length) {
    typeList.textContent = "Add beverage types to build the menu.";
  } else {
    state.types.forEach((type) => {
      const chip = document.createElement("div");
      chip.className = "type-chip";
      const measure = isCounted(type) ? ` · counted, ${oneDecimal(type.unitOz)} oz each` : "";
      chip.innerHTML = `<strong>${escapeHtml(type.name)}</strong><br><small>${escapeHtml(type.category)} · ${oneDecimal(type.abv)}% ABV${measure}</small>`;
      typeList.append(chip);
    });
  }
}

/*
 * Menu tab (2.6.1-2.6.3, 2.6.5, 2.9.1). The menu item form's ingredient rows are
 * built by hand and never rebuilt by render(), so a half-built recipe survives a
 * save elsewhere or a background refresh; render() only refreshes each row's type
 * options. Saves go through hostAction: the repository validates and applies.
 */
const MENU_KIND_LABELS = { cocktail: "Cocktail", straight: "Straight pour", counted: "Counted item" };
const ONE_INGREDIENT_MESSAGES = {
  straight: "A straight pour has exactly one ingredient.",
  counted: "A counted item has exactly one ingredient."
};

/** The price a menu item would ring up at now (RNMBDomain.quoteMenuItem), or null when it cannot be costed. */
function menuItemQuote(menuItem) {
  try {
    return RNMBDomain.quoteMenuItem(menuItem, {
      bottles: state.bottles,
      types: state.types,
      people: state.people,
      markupPercent: state.markupPercent,
      roundingIncrementCents: state.roundingIncrementCents
    });
  } catch {
    // A stock item with no size cannot be costed; show that rather than fail the render.
    return null;
  }
}

function menuItemFormField(name) {
  return document.querySelector(`#menuItemForm [name='${name}']`);
}

function ingredientRows() {
  return Array.from(document.querySelectorAll("#ingredientRows [data-ingredient-row]"));
}

/** Rebuild one row's type options, keeping the chosen type while it exists. */
function fillIngredientTypeOptions(row, preferredTypeId) {
  const select = row.querySelector("select[name='ingredientType']");
  const chosen = preferredTypeId || select.value;
  setOptions(select, state.types, (type) => `${type.name}${isCounted(type) ? " · counted" : ""}`, "Add types first");
  if (state.types.some((type) => type.id === chosen)) select.value = chosen;
}

/** Amount label and limits follow the row's type; a counted item is always exactly 1 unit. */
function syncIngredientRow(row) {
  const kind = menuItemFormField("kind").value;
  const type = typeById(row.querySelector("select[name='ingredientType']").value);
  const input = row.querySelector("input[name='ingredientAmount']");
  const label = row.querySelector("[data-amount-label]");
  if (kind === "counted") {
    input.value = "1";
    input.readOnly = true;
    input.min = "1";
    input.step = "1";
    label.textContent = "Units";
    return;
  }
  input.readOnly = false;
  input.min = isCounted(type) ? "1" : "0.01";
  input.step = isCounted(type) ? "1" : "0.01";
  label.textContent = isCounted(type) ? "Amount units" : "Amount oz";
}

function addIngredientRow({ id = "", typeId = "", amount = 1 } = {}) {
  const row = document.createElement("div");
  row.className = "ingredient-row";
  row.dataset.ingredientRow = "";
  row.dataset.ingredientId = id || "";
  row.innerHTML = `
    <label>
      <span>Type</span>
      <select name="ingredientType"></select>
    </label>
    <label>
      <span data-amount-label>Amount oz</span>
      <input name="ingredientAmount" type="number" min="0.01" step="0.01" value="${escapeHtml(String(amount))}">
    </label>
    <button class="remove-button" type="button" data-remove-ingredient aria-label="Remove ingredient">×</button>
  `;
  document.querySelector("#ingredientRows").append(row);
  fillIngredientTypeOptions(row, typeId);
  syncIngredientRow(row);
  row.querySelectorAll("select, input, button").forEach((control) => {
    control.disabled = !hostModeAvailable;
  });
  return row;
}

function setMenuItemFormMode(editing) {
  document.querySelector("#menu-title").textContent = editing ? "Edit Menu Item" : "Add Menu Item";
  document.querySelector("#menuItemSubmit").textContent = editing ? "Save Changes" : "Add Menu Item";
  document.querySelector("#menuItemCancel").hidden = !editing;
}

function resetMenuItemForm() {
  menuItemFormField("menuItemId").value = "";
  menuItemFormField("name").value = "";
  menuItemFormField("kind").value = "cocktail";
  document.querySelector("#ingredientRows").innerHTML = "";
  addIngredientRow();
  setMenuItemFormMode(false);
}

function loadMenuItemIntoForm(menuItem) {
  menuItemFormField("menuItemId").value = menuItem.id;
  menuItemFormField("name").value = menuItem.name;
  menuItemFormField("kind").value = menuItem.kind;
  document.querySelector("#ingredientRows").innerHTML = "";
  menuItem.ingredients.forEach((ingredient) => addIngredientRow(ingredient));
  if (!menuItem.ingredients.length) addIngredientRow();
  setMenuItemFormMode(true);
  document.querySelector("#menuItemForm").scrollIntoView({ block: "nearest" });
}

/** Read the menu item form; returns { menuItem } or { error } with the toast to show (2.6.1). */
function menuItemDraftFromForm() {
  const name = menuItemFormField("name").value.trim();
  const kind = menuItemFormField("kind").value;
  const rows = ingredientRows();
  if (!name) return { error: "A menu item needs a name." };
  if (!MENU_KIND_LABELS[kind]) return { error: "A menu item is a cocktail, a straight pour or a counted item." };
  if (!rows.length) return { error: "Add at least one ingredient." };
  if (kind !== "cocktail" && rows.length !== 1) return { error: ONE_INGREDIENT_MESSAGES[kind] };
  const ingredients = [];
  for (const row of rows) {
    const type = typeById(row.querySelector("select[name='ingredientType']").value);
    if (!type) return { error: "Pick a stock type for every ingredient." };
    if (kind === "counted" && !isCounted(type)) return { error: `A counted item needs a counted stock type, and ${type.name} is poured.` };
    if (kind === "straight" && isCounted(type)) return { error: `A straight pour needs a poured stock type, and ${type.name} is counted.` };
    const raw = row.querySelector("input[name='ingredientAmount']").value.trim();
    const amount = kind === "counted" ? 1 : Number(raw);
    if (!Number.isFinite(amount) || amount <= 0 || (kind !== "counted" && raw === "")) {
      return { error: "Every ingredient needs an amount above zero." };
    }
    if (isCounted(type) && !Number.isInteger(amount)) return { error: `${type.name} is counted stock, so use a whole number of units.` };
    ingredients.push({ id: row.dataset.ingredientId || undefined, typeId: type.id, amount });
  }
  return { menuItem: { id: menuItemFormField("menuItemId").value || undefined, name, kind, ingredients } };
}

function renderMenu() {
  // KTD8: connected to a database without supabase/host-mode.sql, say so and lock the forms.
  const locked = !hostModeAvailable;
  const notice = document.querySelector("#menuHostModeNotice");
  notice.hidden = !locked;
  notice.textContent = locked ? HOST_MODE_SQL_MESSAGE : "";

  ingredientRows().forEach((row) => {
    fillIngredientTypeOptions(row);
    syncIngredientRow(row);
  });
  const pricing = document.querySelector("#pricingForm");
  // Never overwrite settings the user is part-way through changing.
  if (pricing.dataset.dirty !== "true") {
    pricing.querySelector("[name='markupPercent']").value = String(state.markupPercent);
    pricing.querySelector("[name='roundingIncrement']").value = (state.roundingIncrementCents / 100).toFixed(2);
  }
  ["#menuItemForm", "#pricingForm"].forEach((selector) => {
    Array.from(document.querySelector(selector).elements).forEach((control) => {
      control.disabled = locked;
    });
  });

  const target = document.querySelector("#menuList");
  target.innerHTML = "";
  target.classList.toggle("empty-state", state.menuItems.length === 0);
  if (!state.menuItems.length) {
    target.textContent = locked ? "The menu appears here once host mode is set up." : "No menu items yet.";
    return;
  }
  state.menuItems.forEach((item) => {
    const quote = menuItemQuote(item);
    const recipe = RNMBDomain.menuItemIngredients(item).map((ingredient) => {
      const type = typeById(ingredient.typeId);
      return `<li>${amountText(type, ingredient.amount)} ${escapeHtml(type?.name || "Unknown type")}</li>`;
    }).join("");
    let price;
    let detail;
    if (!quote) {
      price = `<span class="pill warn" data-menu-price>No price</span>`;
      detail = "A stock item for this recipe has no size, so it cannot be costed.";
    } else if (!quote.available) {
      // 2.6.5: the combined stock of an ingredient type cannot cover the recipe.
      const short = quote.shortTypeIds.map((typeId) => typeById(typeId)?.name || "an unknown type");
      price = `<span class="pill hot" data-menu-price>Unavailable</span>`;
      detail = short.length ? `Not enough ${short.join(", ")} in stock.` : "This item has no ingredients.";
    } else {
      const split = quote.ingredients.some((ingredient) => ingredient.short) ? " · poured from more than one bottle" : "";
      price = `<span class="pill price-pill" data-menu-price>${money(quote.priceCents / 100)}</span>`;
      detail = `Cost ${money(quote.costCents / 100)} · ${state.markupPercent}% markup${split}`;
    }
    const card = document.createElement("article");
    card.className = "inventory-card menu-card";
    card.dataset.menuItemId = item.id;
    card.innerHTML = `
      <header>
        <div>
          <strong>${escapeHtml(item.name)}</strong>
          <small>${MENU_KIND_LABELS[item.kind] || "Menu item"}</small>
        </div>
        ${price}
      </header>
      <ul class="recipe-lines">${recipe}</ul>
      <small data-menu-detail>${escapeHtml(detail)}</small>
      <div class="card-actions">
        <button class="secondary-button" type="button" data-edit-menu-item="${escapeHtml(item.id)}"${locked ? " disabled" : ""}>Edit</button>
        <button class="remove-button" type="button" data-remove-menu-item="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(item.name)}"${locked ? " disabled" : ""}>×</button>
      </div>
    `;
    target.append(card);
  });
}

/*
 * Bar register (3.7.1, 3.7.2, 1.7.3, 1.7.7, 2.7.4, 2.7.5, 4.7.6; KTD7, KTD9, KTD10,
 * KTD14). A full-screen view on #register while a host night is open. Every render
 * rebuilds it from `registerDraft`, so a save elsewhere or a background refresh
 * cannot lose a half-built order, and isUserBusy() holds refreshes off meanwhile.
 * Writes go through hostAction: the repository validates and applies.
 */
function isRegisterRoute() {
  return location.hash === REGISTER_HASH;
}

/** The one open host night (the database allows at most one), or null. */
function openHostNight() {
  return state.nights.find((night) => night.kind === "host" && !night.endedAt) || null;
}

/** KTD9: in local mode, a host night this browser did not start belongs to the shared database. */
function hostNightNotSaving(night) {
  return Boolean(night) && syncMode !== "supabase" && night.startedLocally !== true;
}

function openTabsFor(night) {
  return night ? state.guestTabs.filter((tab) => tab.nightId === night.id && tab.status === "open") : [];
}

/** Items still on a tab (voided ones are gone from it). Crew ring-ups never have a tab. */
function tabItems(tabId) {
  return state.ringUps.filter((ringUp) => ringUp.kind === "guest" && ringUp.tabId === tabId && !ringUp.voidedAt);
}

function registerDraftUnfinished() {
  return Boolean(registerDraft && (registerDraft.menuItemId || registerDraft.target));
}

function ensureRegisterDraft() {
  if (!registerDraft) registerDraft = { id: uid(), menuItemId: null, target: null, sources: [] };
  return registerDraft;
}

function registerMenuItem() {
  return registerDraft?.menuItemId ? state.menuItems.find((item) => item.id === registerDraft.menuItemId) || null : null;
}

/** "0.25 oz" rather than amountText's one decimal, for shortfalls where the hundredths matter. */
function exactAmountText(type, amount) {
  return isCounted(type) ? amountText(type, amount) : `${Math.round(Number(amount) * 100) / 100} oz`;
}

/** What the bartender needs to tell two bottles apart: nickname, buyer, what is left. */
function registerSourceText(bottle) {
  if (!bottle) return "Unknown stock item";
  const type = typeById(bottle.typeId);
  const buyer = personById(bottle.buyerId);
  return `${bottle.nickname || type?.name || "Stock"} · ${buyer?.name || "no buyer"} · ${levelText(type, bottle.remaining, bottle.size)} left`;
}

/** Drop references a save or refresh has made stale: a removed menu item, a closed tab, a removed person. */
function reconcileRegisterDraft(night) {
  if (!registerDraft) return;
  const item = registerMenuItem();
  if (!item) {
    registerDraft.menuItemId = null;
    registerDraft.sources = [];
  } else if (registerDraft.sources.length !== RNMBDomain.menuItemIngredients(item).length) {
    // The recipe changed under the draft; start its sources over.
    registerDraft.sources = RNMBDomain.preselectSources(item, state.bottles).map((pick) => pick.sources.map((source) => ({ ...source })));
  }
  const target = registerDraft.target;
  if (target?.kind === "guest" && !openTabsFor(night).some((tab) => tab.id === target.tabId)) registerDraft.target = null;
  if (target?.kind === "crew" && !personById(target.personId)) registerDraft.target = null;
}

/** Whether the draft can be rung up now: { ok, reason } or { ok, night, menuItem, target, priced }. */
function registerDraftCheck() {
  const night = openHostNight();
  if (!night) return { ok: false, reason: REGISTER_CLOSED_MESSAGE };
  if (hostNightNotSaving(night)) return { ok: false, reason: NOT_SAVING_MESSAGE };
  const menuItem = registerMenuItem();
  if (!menuItem) return { ok: false, reason: "Pick a drink." };
  const ingredients = RNMBDomain.menuItemIngredients(menuItem);
  const sources = registerDraft.sources;
  const shortIndex = ingredients.findIndex((ingredient, index) => RNMBDomain.sourcesShortfall(ingredient, sources[index]) > 0);
  if (shortIndex >= 0) {
    const ingredient = ingredients[shortIndex];
    const type = typeById(ingredient.typeId);
    const shortfall = RNMBDomain.sourcesShortfall(ingredient, sources[shortIndex]);
    return { ok: false, reason: `${type?.name || "An ingredient"} is short ${exactAmountText(type, shortfall)}. Add a bottle to make up the rest.` };
  }
  const validation = RNMBDomain.validateRingUpSources(menuItem, sources, state.bottles);
  if (!validation.ok) return { ok: false, reason: validation.errors[0] };
  const target = registerDraft.target;
  if (!target) return { ok: false, reason: "Pick a guest tab or a crew member." };
  let priced;
  try {
    priced = RNMBDomain.priceRingUp(RNMBDomain.flattenSources(sources), {
      bottles: state.bottles,
      types: state.types,
      people: state.people,
      markupPercent: state.markupPercent,
      roundingIncrementCents: state.roundingIncrementCents,
      kind: target.kind
    });
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true, night, menuItem, target, priced };
}

function renderRegister() {
  const night = openHostNight();

  // Tonight: the way in, while a host night runs.
  document.querySelector("#hostNightNotice").hidden = !night;
  if (night) document.querySelector("#hostNightNoticeText").textContent = `Host night running: ${night.name}.`;

  const shown = isRegisterRoute();
  document.body.classList.toggle("is-register", shown);
  document.querySelector("#register").hidden = !shown;
  if (!shown) return;

  const notSaving = hostNightNotSaving(night);
  // 4.7.6: unmistakable, at every register state, whenever nothing is shared.
  document.querySelector("#registerLocalBanner").hidden = syncMode === "supabase";
  document.querySelector("#registerNightMeta").textContent = night ? `${night.name} · ${night.date}` : "No host night running";
  document.querySelector("#registerClosed").hidden = Boolean(night);
  document.querySelector("#registerClosedMessage").textContent = hostModeAvailable ? REGISTER_CLOSED_MESSAGE : HOST_MODE_SQL_MESSAGE;
  document.querySelector("#registerNotSaving").hidden = !notSaving;
  document.querySelector("#registerNotSavingMessage").textContent = notSaving ? NOT_SAVING_MESSAGE : "";
  const work = document.querySelector("#registerWork");
  work.hidden = !night || notSaving;
  if (!night || notSaving) {
    document.querySelector("#registerConfirm").disabled = true;
    return;
  }

  // The static controls are not rebuilt below, so unlock them explicitly once a ring-up resolves.
  work.querySelectorAll("#registerTabForm input, #registerOpenTab, #registerClear").forEach((control) => {
    control.disabled = registerPending;
  });
  reconcileRegisterDraft(night);
  renderRegisterMenu();
  renderRegisterTargets(night);
  renderRegisterIngredients();
  renderRegisterTabList(night);
  updateRegisterSummary();
  if (registerPending) {
    work.querySelectorAll("button, input, select").forEach((control) => {
      control.disabled = true;
    });
  }
}

function renderRegisterMenu() {
  const target = document.querySelector("#registerMenu");
  target.innerHTML = "";
  if (!state.menuItems.length) {
    target.innerHTML = `<p class="empty-state">No menu items yet. Add them in the Menu tab.</p>`;
    return;
  }
  state.menuItems.forEach((item) => {
    const quote = menuItemQuote(item);
    const available = Boolean(quote?.available);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "register-choice";
    button.dataset.registerItem = item.id;
    button.setAttribute("aria-pressed", String(registerDraft?.menuItemId === item.id));
    button.disabled = !available;
    button.innerHTML = `<strong>${escapeHtml(item.name)}</strong><span data-register-price>${available ? money(quote.priceCents / 100) : "Unavailable"}</span>`;
    target.append(button);
  });
}

function renderRegisterTargets(night) {
  const tabsTarget = document.querySelector("#registerTabs");
  const tabs = openTabsFor(night);
  tabsTarget.innerHTML = tabs.length ? "" : `<p class="empty-state">No open tabs. Open one by name below.</p>`;
  tabs.forEach((tab) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "register-choice";
    button.dataset.registerTab = tab.id;
    button.setAttribute("aria-pressed", String(registerDraft?.target?.kind === "guest" && registerDraft.target.tabId === tab.id));
    button.innerHTML = `<strong>${escapeHtml(tab.guestName)}</strong><span>${money(RNMBDomain.tabTotalCents(tab.id, state.ringUps) / 100)}</span>`;
    tabsTarget.append(button);
  });

  const crewTarget = document.querySelector("#registerCrew");
  crewTarget.innerHTML = state.people.length ? "" : `<p class="empty-state">No crew on the roster.</p>`;
  state.people.forEach((person) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "register-choice register-crew";
    button.dataset.registerCrew = person.id;
    button.setAttribute("aria-pressed", String(registerDraft?.target?.kind === "crew" && registerDraft.target.personId === person.id));
    button.style.setProperty("--person-color", safeColor(person.color));
    button.innerHTML = `<strong>${escapeHtml(person.name)}</strong><span>Crew · no charge</span>`;
    crewTarget.append(button);
  });
}

function renderRegisterIngredients() {
  const container = document.querySelector("#registerIngredients");
  container.innerHTML = "";
  const menuItem = registerMenuItem();
  if (!menuItem) {
    container.innerHTML = `<p class="empty-state">Pick a drink to see which bottles it pours from.</p>`;
    return;
  }
  RNMBDomain.menuItemIngredients(menuItem).forEach((ingredient, index) => {
    const type = typeById(ingredient.typeId);
    const counted = isCounted(type);
    const sources = registerDraft.sources[index] || [];
    const stocked = state.bottles.filter((bottle) => bottle.typeId === ingredient.typeId && Number(bottle.remaining) > RNMBDomain.AMOUNT_EPSILON);
    const rows = sources.map((source, sourceIndex) => {
      const bottle = bottleById(source.bottleId);
      // Keep the chosen item listed even if it has since run dry, so the select shows the truth.
      const choices = bottle && !stocked.includes(bottle) ? [bottle, ...stocked] : stocked;
      const options = choices.map((choice) => (
        `<option value="${escapeHtml(choice.id)}"${choice.id === source.bottleId ? " selected" : ""}>${escapeHtml(registerSourceText(choice))}</option>`
      )).join("");
      const amount = Number(source.amount);
      const refs = `data-ingredient="${index}" data-source="${sourceIndex}"`;
      return `
        <div class="register-source" ${refs}>
          <label>
            <span class="field-label">Bottle</span>
            <select name="sourceBottle" ${refs}>${options}</select>
          </label>
          <label>
            <span class="field-label">${counted ? "Units" : "Oz"}</span>
            <input name="sourceAmount" type="number" inputmode="decimal" min="${counted ? "1" : "0.01"}" step="${counted ? "1" : "0.01"}" value="${Number.isFinite(amount) ? escapeHtml(String(amount)) : ""}" ${refs}>
          </label>
          ${sourceIndex > 0 ? `<button class="register-secondary register-remove" type="button" data-remove-source ${refs} aria-label="Remove this bottle">Remove</button>` : ""}
          <small class="register-source-detail" data-source-detail>${escapeHtml(bottle ? `${type?.name || "Stock"}: ${registerSourceText(bottle)}` : "Unknown stock item")}</small>
        </div>`;
    }).join("");
    const extra = RNMBDomain.suggestExtraSource(ingredient, sources, state.bottles);
    const block = document.createElement("div");
    block.className = "register-ingredient";
    block.dataset.ingredientIndex = String(index);
    block.innerHTML = `
      <div class="register-ingredient-head">
        <strong>${escapeHtml(type?.name || "Unknown type")}</strong>
        <span>${amountText(type, ingredient.amount)}</span>
        <span class="pill hot" data-short-marker hidden></span>
      </div>
      ${rows}
      <button class="register-secondary register-add-source" type="button" data-add-source data-ingredient="${index}"${extra ? "" : " disabled"}>Add a bottle</button>
      <small class="register-error" data-ingredient-error></small>
    `;
    container.append(block);
  });
}

/** Short markers, per-ingredient errors and the confirm button; cheap enough to run on every keystroke. */
function updateRegisterSummary() {
  const menuItem = registerMenuItem();
  if (menuItem) {
    RNMBDomain.menuItemIngredients(menuItem).forEach((ingredient, index) => {
      const block = document.querySelector(`#registerIngredients [data-ingredient-index="${index}"]`);
      if (!block) return;
      const type = typeById(ingredient.typeId);
      const sources = registerDraft.sources[index] || [];
      const shortfall = RNMBDomain.sourcesShortfall(ingredient, sources);
      const marker = block.querySelector("[data-short-marker]");
      marker.hidden = shortfall <= 0;
      marker.textContent = shortfall > 0 ? `Short ${exactAmountText(type, shortfall)}` : "";
      block.classList.toggle("is-short", shortfall > 0);
      const errors = shortfall > 0 ? [] : RNMBDomain.validateSources(ingredient, sources, state.bottles).errors;
      block.querySelector("[data-ingredient-error]").textContent = errors[0] || "";
    });
  }

  const check = registerDraftCheck();
  const confirmButton = document.querySelector("#registerConfirm");
  confirmButton.disabled = registerPending || !check.ok;
  let label = "Ring up";
  if (registerPending) {
    label = "Ringing up…";
  } else if (check.ok && check.target.kind === "guest") {
    const tab = state.guestTabs.find((entry) => entry.id === check.target.tabId);
    label = `Ring up ${money(check.priced.priceCents / 100)} to ${tab?.guestName || "the tab"}`;
  } else if (check.ok) {
    label = `Pour for ${personById(check.target.personId)?.name || "crew"} · no charge`;
  }
  confirmButton.textContent = label;
  document.querySelector("#registerHint").textContent = registerPending ? "Saving…" : check.ok ? "" : check.reason;
}

function renderRegisterTabList(night) {
  const list = document.querySelector("#registerTabList");
  const tabs = openTabsFor(night);
  list.innerHTML = tabs.length ? "" : `<p class="empty-state">No open tabs.</p>`;
  tabs.forEach((tab) => {
    const items = tabItems(tab.id);
    const card = document.createElement("article");
    card.className = "register-tab-card";
    card.dataset.tabId = tab.id;
    const lines = items.map((item) => `
      <li data-ring-up-id="${escapeHtml(item.id)}">
        <span>${escapeHtml(item.menuItemName || "Drink")}</span>
        <span>${money((Number(item.priceCents) || 0) / 100)}</span>
        <button class="register-secondary register-void" type="button" data-void-ring-up="${escapeHtml(item.id)}" aria-label="Void ${escapeHtml(item.menuItemName || "this drink")}">Void</button>
      </li>`).join("");
    card.innerHTML = `
      <header>
        <strong>${escapeHtml(tab.guestName)}</strong>
        <span class="pill price-pill" data-tab-total>${money(RNMBDomain.tabTotalCents(tab.id, state.ringUps) / 100)}</span>
      </header>
      ${items.length ? `<ul class="register-tab-items">${lines}</ul>` : "<small>No drinks yet.</small>"}
    `;
    list.append(card);
  });
}

/** Ring up the draft once (KTD14): every draft control is disabled until the call resolves, and the id is the draft's. */
async function confirmRegisterRingUp() {
  if (registerPending) return;
  const check = registerDraftCheck();
  if (!check.ok) {
    showToast(check.reason);
    return;
  }
  const draft = registerDraft;
  const { night, menuItem, target } = check;
  const message = target.kind === "guest"
    ? `${menuItem.name} rung up to ${state.guestTabs.find((tab) => tab.id === target.tabId)?.guestName || "the tab"}.`
    : `${menuItem.name} poured for ${personById(target.personId)?.name || "crew"}. No charge.`;
  registerPending = true;
  renderRegister();
  let saved = false;
  try {
    saved = await hostAction(message, (db) => db.ringUp(buildRingUp({
      id: draft.id,
      nightId: night.id,
      kind: target.kind,
      tabId: target.tabId,
      personId: target.personId,
      menuItemId: menuItem.id,
      sources: RNMBDomain.flattenSources(draft.sources)
    })));
  } finally {
    registerPending = false;
  }
  // Success starts a fresh draft (a new id next time); a failure keeps this one to fix and resubmit.
  if (saved && registerDraft === draft) registerDraft = null;
  renderRegister();
}

/** KTD9: starting a host night in local mode names the scope first. */
async function startHostNightFromForm(form, name, date) {
  if (!name) {
    showToast("A host night needs a name.");
    return;
  }
  if (!hostModeAvailable) {
    showToast(HOST_MODE_SQL_MESSAGE);
    return;
  }
  if (syncMode !== "supabase" && !confirm(`Start "${name}" as a host night in THIS BROWSER ONLY?

This dashboard is not connected to the shared database. Tabs, drinks and stock changes rung up on the register are saved only in this browser, and no other device will see them.`)) {
    showToast("Host night not started.");
    return;
  }
  const started = await hostAction("Host night started. Open the register to ring up drinks.", (db) => db.startHostNight({ id: uid(), name, date: date || today() }));
  if (started) {
    form.reset();
    form.date.value = today();
  }
}

function renderLedger() {
  const ledger = document.querySelector("#ledgerList");
  const settle = document.querySelector("#settleList");
  const spends = spendByPerson();
  const share = state.people.length ? totalSpend() / state.people.length : 0;

  ledger.innerHTML = "";
  ledger.classList.toggle("empty-state", state.bottles.length === 0);
  if (!state.bottles.length) {
    ledger.textContent = "No purchases logged yet.";
  } else {
    [...state.bottles].sort((a, b) => b.date.localeCompare(a.date)).forEach((bottle) => {
      const buyer = personById(bottle.buyerId);
      const item = document.createElement("div");
      item.className = "ledger-item";
      item.innerHTML = `
        <div>
          <strong>${escapeHtml(bottleLabel(bottle))}</strong>
          <small>${bottle.date} · paid by ${escapeHtml(buyer?.name || "Unknown")}</small>
        </div>
        <strong>${money(bottle.price)}</strong>
      `;
      ledger.append(item);
    });
  }

  settle.innerHTML = "";
  settle.classList.toggle("empty-state", state.people.length === 0 || totalSpend() === 0);
  if (!state.people.length || totalSpend() === 0) {
    settle.textContent = "Need people and receipts first.";
    return;
  }
  state.people.forEach((person) => {
    const delta = (spends.get(person.id) || 0) - share;
    const item = document.createElement("div");
    item.className = "stack-item";
    item.innerHTML = `<strong>${escapeHtml(person.name)}</strong><br><small>${delta >= 0 ? "is owed" : "owes"} ${money(Math.abs(delta))}</small>`;
    settle.append(item);
  });

  // Without this line the figures above look wrong rather than incomplete: money
  // on a bottle with no live buyer still inflates everyone's share but credits
  // no one, so the deltas come to -unassigned instead of zero. Say so on screen.
  const unassigned = unassignedSpend();
  if (unassigned > 0) {
    const note = document.createElement("div");
    note.className = "stack-item";
    note.innerHTML = `<strong>Unassigned purchases</strong><br><small>${money(unassigned)} has no buyer on the roster, so nobody is credited for it. Re-add the buyer, or subtract it before settling.</small>`;
    settle.append(note);
  }
}

function renderCrew() {
  const target = document.querySelector("#personList");
  target.innerHTML = "";
  target.classList.toggle("empty-state", state.people.length === 0);
  if (!state.people.length) {
    target.textContent = "No people added yet.";
    return;
  }
  state.people.forEach((person) => {
    const pours = state.nights.flatMap((night) => night.pours || []).filter((pour) => pour.personId === person.id);
    const spent = spendByPerson().get(person.id) || 0;
    const card = document.createElement("div");
    card.className = "person-card";
    card.innerHTML = `
      <span class="avatar" style="--person-color: ${safeColor(person.color)}">${initials(person.name)}</span>
      <div class="person-copy">
        <strong>${escapeHtml(person.name)}</strong>
        <small>${money(spent)} logged · ${pours.length} pours</small>
      </div>
      <button class="remove-button" type="button" data-remove-person="${person.id}" aria-label="Remove person">×</button>
    `;
    target.append(card);
  });
}

function activateTab(tabId) {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.id === tabId);
  });
  document.querySelector("#pageTitle").textContent = document.querySelector(`[data-tab="${tabId}"]`).textContent;
}

function initials(name) {
  return escapeHtml(name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase());
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

document.querySelectorAll(".tab-button").forEach((button) => {
  button.addEventListener("click", () => activateTab(button.dataset.tab));
});

document.querySelector("#responsibleMode").addEventListener("change", async (event) => {
  state.responsibleMode = event.target.checked;
  await saveState(
    event.target.checked ? "Hydration reminders on." : "Hydration reminders muted.",
    (db) => db.updateSettings(state)
  );
});

document.querySelector("#personForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const person = { id: uid(), name: data.get("name").trim(), color: data.get("color") };
  state.people.push(person);
  event.currentTarget.reset();
  event.currentTarget.color.value = "#ef4444";
  await saveState("Person added to the roster.", (db) => db.addPerson(person));
});

document.querySelector("#typeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const measure = data.get("measure") === RNMBDomain.MEASURE_UNIT ? RNMBDomain.MEASURE_UNIT : RNMBDomain.MEASURE_OZ;
  const abv = Number(data.get("abv"));
  const unitOz = measure === RNMBDomain.MEASURE_UNIT ? Number(data.get("unitOz")) : null;
  if (!Number.isFinite(abv) || abv < 0 || abv > 95) {
    showToast("ABV must be between 0 and 95 percent.");
    return;
  }
  if (measure === RNMBDomain.MEASURE_UNIT && !(Number.isFinite(unitOz) && unitOz > 0)) {
    showToast("A counted type needs the volume of one unit, in ounces.");
    return;
  }
  // A database without supabase/host-mode.sql has no measure column and still
  // requires ABV above 0, so a counted type would silently save as poured (KTD8).
  if (syncMode === "supabase" && !hostModeAvailable && (measure === RNMBDomain.MEASURE_UNIT || abv === 0)) {
    showToast(HOST_MODE_SQL_MESSAGE);
    return;
  }
  const type = RNMBDomain.normalizeType({
    id: uid(),
    name: data.get("name").trim(),
    category: data.get("category"),
    abv,
    measure,
    unitOz
  });
  state.types.push(type);
  form.reset();
  form.abv.value = 40;
  syncTypeMeasureField();
  await saveState("Beverage type added.", (db) => db.addType(type));
});

document.querySelector("#typeForm [name='measure']").addEventListener("change", syncTypeMeasureField);

// A mixer has no alcohol; start its ABV at 0 rather than the spirit default.
document.querySelector("#typeForm [name='category']").addEventListener("change", (event) => {
  if (event.target.value === "Mixer") event.currentTarget.form.abv.value = 0;
});

document.querySelector("#bottleForm [name='typeId']").addEventListener("change", syncBottleSizeField);
document.querySelector("#pourForm [name='bottleId']").addEventListener("change", syncPourAmountField);

document.querySelector("#bottleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.people.length || !state.types.length) {
    showToast("Add at least one person and beverage type first.");
    return;
  }
  const data = new FormData(event.currentTarget);
  // The form field keeps its old name; the amount is in the type's measure (KTD5).
  const size = Number(data.get("sizeOz"));
  const stockType = typeById(data.get("typeId"));
  if (!stockType || !Number.isFinite(size) || size <= 0) {
    showToast("Pick a type and a size above zero.");
    return;
  }
  if (isCounted(stockType) && !Number.isInteger(size)) {
    showToast(`${stockType.name} is counted stock, so its size is a whole number of units.`);
    return;
  }
  const bottle = {
    id: uid(),
    typeId: data.get("typeId"),
    nickname: data.get("nickname").trim(),
    size,
    remaining: size,
    price: Number(data.get("price")),
    buyerId: data.get("buyerId"),
    date: data.get("date")
  };
  state.bottles.push(bottle);
  event.currentTarget.reset();
  event.currentTarget.sizeOz.value = POURED_SIZE_DEFAULT;
  event.currentTarget.sizeOz.dataset.measure = RNMBDomain.MEASURE_OZ;
  event.currentTarget.price.value = 0;
  event.currentTarget.date.value = today();
  await saveState("Bottle added to inventory.", (db) => db.addBottle(bottle));
});

document.querySelector("#nightForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  if (data.get("kind") === "host") {
    await startHostNightFromForm(event.currentTarget, data.get("name").trim(), data.get("date"));
    return;
  }
  const night = { id: uid(), name: data.get("name").trim(), date: data.get("date"), kind: "crew", endedAt: null, pours: [] };
  state.nights.push(night);
  state.activeNightId = night.id;
  event.currentTarget.reset();
  event.currentTarget.date.value = today();
  await saveState("Night log started.", (db) => db.addNight(night, state));
});

document.querySelector("#nightSelect").addEventListener("change", async (event) => {
  state.activeNightId = event.target.value;
  await saveState("Active night switched.", (db) => db.updateSettings(state));
});

document.querySelector("#pourForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const night = activeNight();
  if (!night) {
    showToast("Create a night log first.");
    return;
  }
  const data = new FormData(event.currentTarget);
  const bottle = bottleById(data.get("bottleId"));
  const type = typeById(bottle?.typeId);
  // In the type's measure: ounces, or a count for counted stock (KTD5). The
  // field keeps its old name, and so does the pour's `ounces` property.
  const ounces = Number(data.get("ounces"));
  if (!bottle || !type || !(ounces > 0)) {
    showToast("Pick a stocked bottle and a valid pour.");
    return;
  }
  if (!(Number(type.abv) > 0)) {
    showToast(`${type.name} has no alcohol, so it is not logged as a pour.`);
    return;
  }
  if (isCounted(type) && !Number.isInteger(ounces)) {
    showToast(`${type.name} is counted stock, so log a whole number of units.`);
    return;
  }
  if (ounces > Number(bottle.remaining)) {
    showToast("That pour exceeds the bottle inventory.");
    return;
  }

  bottle.remaining = Math.max(0, Number(bottle.remaining) - ounces);
  const pour = {
    id: uid(),
    personId: data.get("personId"),
    bottleId: bottle.id,
    ounces,
    abv: type.abv,
    timestamp: new Date().toISOString()
  };
  night.pours.push(pour);

  const personTotal = activeNightTotals().byPerson.get(data.get("personId"))?.drinks || 0;
  const status = statusForDrinks(personTotal);
  const message = state.responsibleMode && status.className ? `${status.label}: ${status.meta}` : "Pour logged.";
  await saveState(message, (db) => db.addPour(night, pour, bottle.remaining));
});

document.body.addEventListener("click", async (event) => {
  const pourId = event.target.dataset.removePour;
  const bottleId = event.target.dataset.removeBottle;
  const personId = event.target.dataset.removePerson;

  if (pourId) {
    const night = activeNight();
    const pour = night?.pours.find((entry) => entry.id === pourId);
    const bottle = bottleById(pour?.bottleId);
    if (pour && bottle) {
      bottle.remaining = Math.min(Number(bottle.size), Number(bottle.remaining) + Number(pour.ounces));
      night.pours = night.pours.filter((entry) => entry.id !== pourId);
      await saveState("Pour removed and inventory restored.", (db) => db.removePour(pour, bottle.remaining));
    }
  }

  // KTD6: money history is never destroyed, so a stock item that drinks were
  // sold from stays. Checked here for both repositories, before anything changes.
  if (bottleId && bottleHasSales(bottleId)) {
    showToast(SOLD_BOTTLE_MESSAGE);
  } else if (bottleId && confirm("Remove this bottle and its receipt from the dashboard?")) {
    state.bottles = state.bottles.filter((bottle) => bottle.id !== bottleId);
    state.stockAdjustments = state.stockAdjustments.filter((adjustment) => adjustment.bottleId !== bottleId);
    state.nights.forEach((night) => {
      night.pours = night.pours.filter((pour) => pour.bottleId !== bottleId);
    });
    await saveState("Bottle removed.", (db) => db.removeBottle(bottleId));
  }

  if (personId && confirm("Remove this person and related pours? Receipts remain unassigned.")) {
    state.people = state.people.filter((person) => person.id !== personId);
    state.bottles.forEach((bottle) => {
      if (bottle.buyerId === personId) bottle.buyerId = "";
    });
    state.nights.forEach((night) => {
      night.pours = night.pours.filter((pour) => pour.personId !== personId);
    });
    // As the database does (on delete set null): the reference goes, the name
    // snapshot stays on every tab, ring-up and line.
    state.guestTabs = state.guestTabs.map((tab) => (tab.collectorId === personId ? { ...tab, collectorId: null } : tab));
    state.ringUps = state.ringUps.map((ringUp) => ({
      ...ringUp,
      personId: ringUp.personId === personId ? null : ringUp.personId,
      lines: ringUp.lines.map((line) => (line.buyerId === personId ? { ...line, buyerId: null } : line))
    }));
    await saveState("Person removed.", (db) => db.removePerson(personId));
  }
});

// Set level on an inventory card (1.3.4, KTD12). The cards are rebuilt on every
// render, so listen once on the body. The repository validates, records the
// adjustment and changes the level, so state is not touched here first.
document.body.addEventListener("submit", async (event) => {
  const form = event.target.closest?.("[data-level-form]");
  if (!form) return;
  event.preventDefault();
  const bottle = bottleById(form.dataset.levelForm);
  if (!bottle) return;
  const type = typeById(bottle.typeId);
  const raw = form.querySelector("[name='level']").value.trim();
  const newRemaining = Number(raw);
  if (raw === "" || !Number.isFinite(newRemaining) || newRemaining < 0 || newRemaining > Number(bottle.size)) {
    showToast(`Set a level from 0 to ${amountText(type, bottle.size)}.`);
    return;
  }
  if (isCounted(type) && !Number.isInteger(newRemaining)) {
    showToast(`${type.name} is counted stock, so its level is a whole number of units.`);
    return;
  }
  if (Math.abs(newRemaining - Number(bottle.remaining)) < RNMBDomain.AMOUNT_EPSILON) {
    showToast("That stock item is already at that level.");
    return;
  }
  // No second tap while the call is out; render() rebuilds the card either way.
  form.querySelector("button[type='submit']").disabled = true;
  await hostAction("Stock level set.", (db) => db.correctStock({ bottleId: bottle.id, newRemaining }));
});

// ---- Menu tab ----
document.querySelector("#menuItemForm [name='kind']").addEventListener("change", () => {
  ingredientRows().forEach(syncIngredientRow);
});

document.querySelector("#ingredientRows").addEventListener("change", (event) => {
  const row = event.target.closest("[data-ingredient-row]");
  if (row && event.target.matches("select[name='ingredientType']")) syncIngredientRow(row);
});

document.querySelector("#ingredientRows").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-ingredient]");
  if (button) button.closest("[data-ingredient-row]").remove();
});

document.querySelector("#addIngredientRow").addEventListener("click", () => {
  const kind = menuItemFormField("kind").value;
  // 2.6.1: only a cocktail has more than one ingredient.
  if (kind !== "cocktail" && ingredientRows().length >= 1) {
    showToast(ONE_INGREDIENT_MESSAGES[kind]);
    return;
  }
  addIngredientRow();
});

document.querySelector("#menuItemCancel").addEventListener("click", resetMenuItemForm);

document.querySelector("#menuItemForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!hostModeAvailable) {
    showToast(HOST_MODE_SQL_MESSAGE);
    return;
  }
  const draft = menuItemDraftFromForm();
  if (draft.error) {
    showToast(draft.error);
    return;
  }
  const editing = Boolean(draft.menuItem.id);
  const saved = await hostAction(editing ? "Menu item updated." : "Menu item added.", (db) => db.saveMenuItem(draft.menuItem));
  if (saved) resetMenuItemForm();
});

document.querySelector("#pricingForm").addEventListener("input", (event) => {
  event.currentTarget.dataset.dirty = "true";
});

document.querySelector("#pricingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!hostModeAvailable) {
    showToast(HOST_MODE_SQL_MESSAGE);
    return;
  }
  const markupRaw = form.querySelector("[name='markupPercent']").value.trim();
  const incrementRaw = form.querySelector("[name='roundingIncrement']").value.trim();
  const markupPercent = Number(markupRaw);
  const incrementDollars = Number(incrementRaw);
  if (markupRaw === "" || !Number.isFinite(markupPercent) || markupPercent < 0) {
    showToast("The markup must be a percentage of 0 or more.");
    return;
  }
  // Stored as whole cents above zero (KTD11): $0.25 is 25.
  const roundingIncrementCents = Math.round(incrementDollars * 100);
  if (incrementRaw === "" || !Number.isFinite(incrementDollars) || roundingIncrementCents <= 0 ||
    Math.abs(incrementDollars * 100 - roundingIncrementCents) > 1e-6) {
    showToast("Round up to a whole number of cents, $0.01 or more (for example 0.25).");
    return;
  }
  const saved = await hostAction("Pricing saved.", (db) => db.updatePricing({ markupPercent, roundingIncrementCents }));
  if (saved) {
    delete form.dataset.dirty;
    renderMenu();
  }
});

document.querySelector("#menuList").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-menu-item]");
  const removeButton = event.target.closest("[data-remove-menu-item]");
  if (editButton) {
    const item = state.menuItems.find((entry) => entry.id === editButton.dataset.editMenuItem);
    if (item) loadMenuItemIntoForm(item);
    return;
  }
  if (!removeButton) return;
  const item = state.menuItems.find((entry) => entry.id === removeButton.dataset.removeMenuItem);
  if (!item || !confirm(`Remove ${item.name} from the menu? Drinks already rung up keep their name and price.`)) return;
  const removed = await hostAction("Menu item removed.", (db) => db.removeMenuItem(item.id));
  if (removed && menuItemFormField("menuItemId").value === item.id) resetMenuItemForm();
});

resetMenuItemForm();

// ---- Bar register ----
window.addEventListener("hashchange", () => {
  // Leaving the register drops an unfinished order, so the dashboard's refresh is not held off by it.
  if (!isRegisterRoute() && !registerPending) registerDraft = null;
  renderRegister();
  window.scrollTo(0, 0);
});

document.querySelector("#register").addEventListener("click", async (event) => {
  const control = event.target.closest("button");
  if (!control || control.disabled) return;
  if (control.id === "registerRetry") {
    location.reload();
    return;
  }
  if (control.id === "registerConfirm") {
    await confirmRegisterRingUp();
    return;
  }
  if (registerPending) return;

  if (control.id === "registerClear") {
    registerDraft = null;
    renderRegister();
    return;
  }

  if (control.dataset.registerItem) {
    const item = state.menuItems.find((entry) => entry.id === control.dataset.registerItem);
    if (!item) return;
    // KTD10: start from the preselected sources; the chosen target stays.
    const draft = ensureRegisterDraft();
    draft.menuItemId = item.id;
    draft.sources = RNMBDomain.preselectSources(item, state.bottles).map((pick) => pick.sources.map((source) => ({ ...source })));
    renderRegister();
    return;
  }
  if (control.dataset.registerTab) {
    ensureRegisterDraft().target = { kind: "guest", tabId: control.dataset.registerTab };
    renderRegister();
    return;
  }
  if (control.dataset.registerCrew) {
    ensureRegisterDraft().target = { kind: "crew", personId: control.dataset.registerCrew };
    renderRegister();
    return;
  }

  const item = registerMenuItem();
  const index = Number(control.dataset.ingredient);
  const ingredient = item ? RNMBDomain.menuItemIngredients(item)[index] : null;
  if (ingredient && control.hasAttribute("data-add-source")) {
    const sources = registerDraft.sources[index] || [];
    const extra = RNMBDomain.suggestExtraSource(ingredient, sources, state.bottles);
    if (!extra) {
      showToast(`No other ${typeById(ingredient.typeId)?.name || "stock"} has any left.`);
      return;
    }
    registerDraft.sources[index] = [...sources, extra];
    renderRegister();
    return;
  }
  if (ingredient && control.hasAttribute("data-remove-source")) {
    registerDraft.sources[index] = (registerDraft.sources[index] || []).filter((_, sourceIndex) => sourceIndex !== Number(control.dataset.source));
    renderRegister();
    return;
  }

  const ringUpId = control.dataset.voidRingUp;
  if (ringUpId) {
    const ringUp = state.ringUps.find((entry) => entry.id === ringUpId);
    const tab = state.guestTabs.find((entry) => entry.id === ringUp?.tabId);
    if (!ringUp || !tab) return;
    if (!confirm(`Void ${ringUp.menuItemName || "this drink"} (${money((Number(ringUp.priceCents) || 0) / 100)}) from ${tab.guestName}'s tab? What it poured goes back into stock.`)) return;
    await hostAction("Item voided and its stock restored.", (db) => db.voidRingUp(ringUp.id));
  }
});

document.querySelector("#register").addEventListener("change", (event) => {
  if (registerPending || !event.target.matches("select[name='sourceBottle']")) return;
  const item = registerMenuItem();
  const index = Number(event.target.dataset.ingredient);
  const ingredient = item ? RNMBDomain.menuItemIngredients(item)[index] : null;
  if (!ingredient) return;
  registerDraft.sources[index] = RNMBDomain.switchSource(
    ingredient,
    registerDraft.sources[index] || [],
    Number(event.target.dataset.source),
    event.target.value,
    state.bottles
  );
  renderRegister();
});

// Typing an amount updates the draft and the summary only, so the field keeps focus.
document.querySelector("#register").addEventListener("input", (event) => {
  if (registerPending || !event.target.matches("input[name='sourceAmount']") || !registerDraft) return;
  const source = registerDraft.sources[Number(event.target.dataset.ingredient)]?.[Number(event.target.dataset.source)];
  if (!source) return;
  source.amount = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value);
  updateRegisterSummary();
});

document.querySelector("#registerTabForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (registerPending) return;
  const night = openHostNight();
  if (!night || hostNightNotSaving(night)) {
    showToast(night ? NOT_SAVING_MESSAGE : REGISTER_CLOSED_MESSAGE);
    return;
  }
  const input = event.currentTarget.querySelector("[name='guestName']");
  const guestName = input.value.trim();
  if (!guestName) {
    showToast("Type the guest's name to open a tab.");
    return;
  }
  const tabId = uid();
  const opened = await hostAction(`Tab opened for ${guestName}.`, (db) => db.openTab({ id: tabId, nightId: night.id, guestName }));
  if (!opened) return;
  input.value = "";
  // The new tab is who the next drink is for.
  if (state.guestTabs.some((tab) => tab.id === tabId && tab.status === "open")) {
    ensureRegisterDraft().target = { kind: "guest", tabId };
  }
  renderRegister();
});

function bottleHasSales(bottleId) {
  return state.ringUps.some((ringUp) => ringUp.lines.some((line) => line.bottleId === bottleId));
}

/** The export archive: the whole state, every host-mode collection included. */
function archiveData() {
  return JSON.parse(JSON.stringify(state));
}

function downloadArchive(label) {
  const blob = new Blob([JSON.stringify(archiveData(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `rnmb-command-center-${label}-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/*
 * Import, Reload demo and Clear are the only actions that do not write a single
 * targeted row: they go through saveAll, which deletes every row in every
 * table and re-inserts. Connected to Supabase that is everyone's data, not
 * this browser's copy -- and Clear's old wording ("from this browser") said the
 * opposite. Name the real scope, and take a backup on the way out, because the
 * deletes and inserts are separate requests with no transaction around them.
 */
function confirmDestructive(action) {
  const scope = syncMode === "supabase"
    ? "This replaces the SHARED Supabase database. Everyone using this dashboard loses the current data."
    : "This replaces the copy stored in this browser. Nothing shared is affected.";
  return confirm(`${action}

${scope}

A backup file will download first.`);
}

document.querySelector("#exportData").addEventListener("click", () => {
  downloadArchive("export");
  showToast("Dashboard archive exported.");
});

document.querySelector("#importData").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported.people) || !Array.isArray(imported.types) || !Array.isArray(imported.bottles) || !Array.isArray(imported.nights)) {
      throw new Error("Invalid archive");
    }
    // Host-mode collections are optional (older archives have none), but when
    // present they must be lists, and every ring-up must carry its lines.
    const hostCollections = ["menuItems", "guestTabs", "ringUps", "stockAdjustments"];
    if (hostCollections.some((key) => imported[key] !== undefined && !Array.isArray(imported[key]))) {
      throw new Error("Invalid archive");
    }
    if ((imported.ringUps || []).some((ringUp) => !ringUp || !Array.isArray(ringUp.lines))) {
      throw new Error("Invalid archive");
    }
    if ((imported.menuItems || []).some((item) => !item || (item.ingredients !== undefined && !Array.isArray(item.ingredients)))) {
      throw new Error("Invalid archive");
    }
    if (!confirmDestructive(`Import ${file.name}?`)) {
      event.target.value = "";
      return;
    }
    downloadArchive("backup-before-import");
    state = normalizeState({ ...imported, responsibleMode: imported.responsibleMode !== false });
    await saveState("Dashboard archive imported.");
  } catch {
    showToast("That archive could not be imported.");
  } finally {
    event.target.value = "";
  }
});

document.querySelector("#seedData").addEventListener("click", async () => {
  if (!confirmDestructive("Reload demo data and replace the current dashboard?")) return;
  downloadArchive("backup-before-demo-data");
  state = demoData();
  await saveState("Demo data reloaded.");
});

document.querySelector("#clearData").addEventListener("click", async () => {
  if (!confirmDestructive("Clear all dashboard data?")) return;
  downloadArchive("backup-before-clear");
  state = emptyState();
  await saveState("Dashboard cleared.");
});

// Read-mostly handle for the browser smoke tests (tests/browser/host-mode.smoke.js)
// and later UI units. It exposes nothing the console could not already reach.
window.__rnmb = Object.freeze({
  get state() { return state; },
  get repository() { return repository; },
  get syncMode() { return syncMode; },
  get hostModeAvailable() { return hostModeAvailable; },
  get registerDraft() { return registerDraft; },
  archiveData,
  buildRingUp,
  hostAction,
  isUserBusy,
  render
});

init();
