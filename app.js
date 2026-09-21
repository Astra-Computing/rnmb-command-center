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
const POURED_BOTTLE_MESSAGE = "Crew drinks have been poured from this stock item and charged against it, so it cannot be deleted. Set its remaining level to empty instead.";
// Crew balances (crew-balance KTD6): false when the shared database has not run
// supabase/crew-balance.sql -- rnmb_payments answers 404, or rnmb_pours has no
// cost columns (and always when host mode itself is missing). Local mode always
// has them, so this starts true and is reset on every load, like hostModeAvailable.
// While false, no payment, pour-cost or write-off-author column is ever sent.
let crewBalanceAvailable = true;
const CREW_BALANCE_SQL_MESSAGE = "Crew balances are not set up on the shared database yet. Run supabase/crew-balance.sql in Supabase, then reload.";

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
// True from the Open tab submit until that call resolves; the new-tab form is locked meanwhile, so one tap opens one tab.
let openTabPending = false;
// Close-out: the collector picked on each open tab card (tab id -> person id), kept across re-renders.
const registerCollectors = new Map();
// Close-out: the crew member picked to write each open tab off (tab id -> person id); they are charged its cost (0.8.8).
const registerWriters = new Map();

// Quick log on Tonight (0.4.2, KTD8): the person whose drinks are being logged, and
// true while one tap's save is out, so a double tap logs one drink.
let quickLogPersonId = null;
let quickLogPending = false;
// The night quick log writes to. Normally the active night; the recap's "Add a
// missed drink" pins the night it is showing, so a drink added while fixing up
// one night can never land on another (0.4.3).
let quickLogNightId = null;
// Settle-up (0.5.4): true while a payment or a void is being saved.
let paymentPending = false;
// End of night (0.4.3): true while ending a night or voiding from the recap.
let recapPending = false;
// One id per draft (KTD14): a tap or payment that fails keeps its id, so retrying
// the same drink or payment can never save it twice. Forgotten once saved.
const quickLogDraftIds = new Map();
const paymentDraftIds = new Map();

function draftId(drafts, key) {
  if (!drafts.has(key)) drafts.set(key, uid());
  return drafts.get(key);
}

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
const round6 = RNMBDomain.round6;
const hasAtMostTwoDecimals = (value) => Math.abs(value * 100 - Math.round(value * 100)) < RNMBDomain.AMOUNT_EPSILON;

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

/**
 * The night a ring-up goes on (crew-balance KTD6/KTD7, as rnmb_ring_up): guest
 * drinks need an open host night; crew drinks may also go on a crew night,
 * whether or not it has ended. The KTD9 local check applies to host nights only.
 */
function ringUpNightFor(record, local) {
  const night = state.nights.find((entry) => entry.id === record.nightId);
  if (record.kind === "crew" && night && night.kind !== "host") return night;
  return openHostNightFor(record.nightId, local);
}

/** A crew member on the roster, or a refusal with the given message. */
function crewMember(personId, message) {
  const person = personId ? personById(personId) : null;
  if (!person) throw refusal(message);
  return person;
}

const hostRules = {
  ringUp(record, { local }) {
    if (state.ringUps.some((entry) => entry.id === record.id)) throw refusal("That ring-up was already saved.");
    const night = ringUpNightFor(record, local);
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
    // A crew night's items stay voidable after it ends (KTD7); host nights keep
    // their locks, but only over guest items. An ended host night freezes the
    // tab totals that were counted against the cash; a crew drink touches no tab
    // and is charged at cost, so leaving it locked would make a wrong person's
    // debit permanent with nowhere to correct it.
    if (night?.kind !== "crew") {
      if (night?.endedAt && ringUp.kind === "guest") throw refusal("This host night has ended, so its items can no longer be voided.");
      if (local && night?.startedLocally !== true) throw refusal(NOT_SAVING_MESSAGE);
    }
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

  closeTab({ id, status, collectorId, amountCents, writtenOffBy }, { local }) {
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
      closed = {
        ...tab, status, collectorId: collector.id, collectorName: collector.name, amountCents,
        writtenOffBy: null, writtenOffByName: null, closedAt: nowIso()
      };
    } else if (status === "written_off") {
      if ((collectorId ?? null) !== null || (amountCents ?? null) !== null) {
        throw refusal("A written-off tab has no collector and no amount.");
      }
      let author = null;
      if (writtenOffBy) {
        author = crewMember(writtenOffBy, "The crew member writing off the tab does not exist.");
      // crew-balance.sql requires the crew member who writes a tab off (0.7.8), and the
      // register asks for one on every open tab card, so the local rules require one too
      // whenever crew balances are on. Before crew-balance.sql the database has nowhere
      // to keep an author, so none is required (or sent).
      } else if (crewBalanceAvailable) {
        throw refusal("A written-off tab needs the crew member who wrote it off.");
      }
      closed = {
        ...tab, status, collectorId: null, collectorName: null, amountCents: null,
        writtenOffBy: author ? author.id : null, writtenOffByName: author ? author.name : null, closedAt: nowIso()
      };
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

  /** rnmb_end_night: a crew night ends straight away; a host night keeps endHostNight's rules. */
  endNight(nightId, { local }) {
    const night = state.nights.find((entry) => entry.id === nightId);
    if (!night) throw refusal("That night does not exist.");
    if (night.kind === "host") return hostRules.endHostNight(nightId, { local });
    if (night.endedAt) throw refusal("This crew night has already ended.");
    const ended = { ...night, endedAt: nowIso() };
    state.nights = state.nights.map((entry) => (entry.id === nightId ? ended : entry));
    return ended;
  },

  /** rnmb_record_payment (0.5.4, KTD5): whole cents above zero between two different crew members, names snapshotted. */
  recordPayment({ id, fromPersonId, toPersonId, amountCents, paidAt }) {
    if (!id) throw refusal("A payment needs an id.");
    if (state.payments.some((entry) => entry.id === id)) throw refusal("That payment was already recorded.");
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw refusal("A payment needs an amount above zero, in whole cents.");
    if (!fromPersonId || !toPersonId) throw refusal("A payment needs the crew member who paid and the one who was paid.");
    if (fromPersonId === toPersonId) throw refusal("A payment must be between two different crew members.");
    const from = crewMember(fromPersonId, "The crew member who paid does not exist.");
    const to = crewMember(toPersonId, "The crew member who was paid does not exist.");
    const saved = RNMBDomain.normalizePayment({
      id,
      fromPersonId: from.id,
      fromName: from.name,
      toPersonId: to.id,
      toName: to.name,
      amountCents,
      paidAt: paidAt || nowIso(),
      voidedAt: null
    });
    state.payments.push(saved);
    return saved;
  },

  /** rnmb_void_payment: a soft void; the payment stays in the history. */
  voidPayment(paymentId) {
    const payment = state.payments.find((entry) => entry.id === paymentId);
    if (!payment) throw refusal("That payment does not exist.");
    if (payment.voidedAt) throw refusal("That payment was already voided.");
    const voided = { ...payment, voidedAt: nowIso() };
    state.payments = state.payments.map((entry) => (entry.id === paymentId ? voided : entry));
    return voided;
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
  // The column is numeric(6, 2): anything finer would be rounded by the database
  // while this browser kept pricing with the unrounded value, and 10000 overflows it.
  if (!hasAtMostTwoDecimals(markup)) throw refusal(`The markup is kept to two decimal places, and ${markup} has more.`);
  if (markup >= 10000) throw refusal("The markup must be below 10000%.");
  // A whole number of cents already, so nothing can be rounded away here.
  if (!Number.isInteger(increment) || increment <= 0) throw refusal("The rounding increment must be a whole number of cents above 0.");
  return { markupPercent: markup, roundingIncrementCents: increment };
}

/**
 * Check a crew pour and build it, without touching state (the caller applies it
 * and saves with saveState + db.addPour). Mirrors rnmb_add_crew_pour: an ended
 * host night takes no pours, but an ended crew night does (KTD7). When crew
 * balances are available the pour is stamped with its whole-cent cost and the
 * bottle buyer (KTD2), as the database function stamps it; otherwise it carries
 * no stamp, because the shared database has nowhere to keep one.
 */
function preparePour(night, { id, personId, bottleId, ounces, timestamp }) {
  if (night?.kind === "host" && night.endedAt) throw refusal("This host night has ended, so no more pours can be logged.");
  const bottle = bottleById(bottleId);
  const type = typeById(bottle?.typeId);
  const amount = Number(ounces);
  if (!bottle || !type || !(amount > 0)) throw refusal("Pick a stocked bottle and a valid pour.");
  if (!(Number(type.abv) > 0)) throw refusal(`${type.name} has no alcohol, so it is not logged as a pour.`);
  if (isCounted(type) && !Number.isInteger(amount)) throw refusal(`${type.name} is counted stock, so log a whole number of units.`);
  if (amount > Number(bottle.remaining)) throw refusal("That pour exceeds the bottle inventory.");
  const pour = {
    id: id || uid(),
    personId,
    bottleId: bottle.id,
    ounces: amount,
    abv: type.abv,
    timestamp: timestamp || new Date().toISOString()
  };
  return RNMBDomain.normalizePour(crewBalanceAvailable ? RNMBDomain.stampPour(pour, bottle, state.people) : pour);
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
    endNight: apply("endNight"),
    recordPayment: apply("recordPayment"),
    voidPayment: apply("voidPayment"),
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

  /*
   * Whether rnmb_pours has the crew-balance cost columns. Selecting a column that
   * does not exist is refused (400, 42703) even when no row matches, and no row
   * ever has a null id, so this reads nothing either way.
   */
  async function pourCostColumnsExist() {
    try {
      await request("rnmb_pours?select=cost_cents,buyer_id,buyer_name&id=is.null");
      return true;
    } catch (error) {
      if ([400, 404].includes(error.status) || ["42703", "PGRST204", "PGRST205", "42P01"].includes(error.code)) return false;
      throw error;
    }
  }

  function requireCrewBalance() {
    if (!crewBalanceAvailable) throw refusal(CREW_BALANCE_SQL_MESSAGE);
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

  /** Insert rows, or update the ones whose id already exists (the primary key). */
  async function upsertRows(table, rows) {
    if (!rows.length) return;
    await request(`${table}?on_conflict=id`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows)
    });
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

  /** The whole settings row from nextState. Only saveAll (which replaces everything) and a missing row use it. */
  async function saveSettings(nextState) {
    await request("rnmb_settings?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([RNMBDomain.settingsRow(nextState, hostModeAvailable)])
    });
  }

  /*
   * Write only the named settings columns. Every device holds its own copy of
   * the settings row, and the copy is often stale (refresh waits while a field
   * is focused or the tab is hidden), so writing the whole row would put back
   * whatever another device changed since: switching the night would reset
   * the markup, and saving the markup would reset the active night.
   * settingsRow already leaves the pricing columns out when host mode is not set
   * up (KTD8), so asking for them then sends nothing for them.
   */
  async function saveSettingsColumns(nextState, columns) {
    const row = RNMBDomain.settingsRow(nextState, hostModeAvailable);
    const patch = Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]]));
    if (!Object.keys(patch).length) return;
    const updated = await request("rnmb_settings?id=eq.true", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch)
    });
    // A database that has never saved settings has no row to update: create it.
    if (Array.isArray(updated) && updated.length === 0) await saveSettings(nextState);
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
        menuItemRows, ingredientRowsRead, tabRows, ringUpRows, lineRows, adjustmentRows, paymentRows
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
        readHostModeTable("rnmb_stock_adjustments", "order=adjusted_at.asc"),
        readHostModeTable("rnmb_payments", "order=paid_at.asc")
      ]);
      const hostTables = [menuItemRows, ingredientRowsRead, tabRows, ringUpRows, lineRows, adjustmentRows];
      hostModeAvailable = hostTables.every((rows) => rows !== null);
      // KTD6: balances need the payments table AND the pour cost columns (crew-balance.sql adds both).
      // Deliberately sequential: this probe names columns a pre-crew-balance database
      // does not have, so it must run only after the reads above prove host mode and
      // the payments table exist. Racing it alongside them costs a pre-migration
      // database a 400 on every load (KTD6).
      crewBalanceAvailable = hostModeAvailable && paymentRows !== null && await pourCostColumnsExist();

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
            timestamp: pour.poured_at,
            costCents: pour.cost_cents,
            buyerId: pour.buyer_id,
            buyerName: pour.buyer_name
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
          writtenOffBy: tab.written_off_by,
          writtenOffByName: tab.written_off_by_name,
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
        payments: (paymentRows || []).map((payment) => ({
          id: payment.id,
          fromPersonId: payment.from_person_id,
          fromName: payment.from_name,
          toPersonId: payment.to_person_id,
          toName: payment.to_name,
          amountCents: payment.amount_cents,
          paidAt: payment.paid_at,
          voidedAt: payment.voided_at
        })),
        activeNightId: settings.active_night_id || nights[0]?.id || "",
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
      if (!crewBalanceAvailable && RNMBDomain.hasCrewBalanceRecords(nextState)) {
        throw refusal(`This data includes crew balance records (payments, drink costs, write-off authors or an ended crew night). ${CREW_BALANCE_SQL_MESSAGE}`);
      }
      // crew-balance.sql requires a written-off tab's author; one without cannot be re-inserted.
      if (crewBalanceAvailable && nextState.guestTabs.some((tab) => tab.status === "written_off" && !tab.writtenOffByName)) {
        throw refusal("This data has a written-off tab with no record of who wrote it off, and the shared database needs one, so nothing was replaced.");
      }

      await request("rnmb_settings?id=eq.true", {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ active_night_id: null })
      }).catch(() => undefined);

      // Children before parents: the host-mode tables reference nights, people,
      // bottles and types, and bottles and tabs refuse deletes while referenced.
      if (crewBalanceAvailable) await deleteAll("rnmb_payments");
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
        (night.pours || []).map((pour) => RNMBDomain.pourRow(
          { ...pour, buyerId: knownId(nextState.people, pour.buyerId) },
          night.id,
          crewBalanceAvailable
        ))
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
          ...(crewBalanceAvailable
            ? { written_off_by: knownId(people, tab.writtenOffBy), written_off_by_name: tab.writtenOffByName || null }
            : {}),
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
      if (crewBalanceAvailable) {
        await insertRows("rnmb_payments", nextState.payments.map((payment) => RNMBDomain.paymentRow({
          ...payment,
          fromPersonId: knownId(nextState.people, payment.fromPersonId),
          toPersonId: knownId(nextState.people, payment.toPersonId)
        })));
      }
      await saveSettings(nextState);
    },
    async updateSettings(nextState, columns = ["active_night_id"]) {
      await saveSettingsColumns(nextState, columns.filter((column) => ["active_night_id"].includes(column)));
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
      await saveSettingsColumns(nextState, ["active_night_id"]);
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
      await insertRow("rnmb_pours", RNMBDomain.pourRow(pour, night.id, crewBalanceAvailable));
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
      // rnmb_ring_up_lines.bottle_id restricts, but rnmb_pours.bottle_id
      // cascades, so a charged crew pour has to be refused before the request.
      const refused = bottleDeleteRefusal(bottleId);
      if (refused) throw refusal(refused);
      try {
        await deleteWhere("rnmb_bottles", `id=eq.${bottleId}`);
      } catch (error) {
        // Another device sold from it since this copy loaded (on delete restrict).
        if (error.status === 409 || error.code === "23503") throw refusal(SOLD_BOTTLE_MESSAGE);
        throw error;
      }
    },
    async removePerson(personId) {
      // KTD9 (0.5.7): the browser's copy of the balances can be minutes old, so
      // the rule that keeps money from being orphaned runs where the rows are.
      // rnmb_remove_person locks the person and refuses while a cost-stamped
      // pour still names them as the drinker, because that is the one reference
      // the delete destroys rather than setting null. Before crew-balance.sql
      // there is no such function, and no pour cost to protect.
      if (crewBalanceAvailable) {
        await rpc("rnmb_remove_person", { id: personId });
        return;
      }
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
          // Always sent, crew lines too: a crew drink's cost is what balances debit (KTD2).
          cost_cents: Number(line.costCents ?? 0),
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
      // A database without crew-balance.sql has nowhere to keep the author, so it is neither sent nor mirrored.
      const kept = crewBalanceAvailable ? closing : { ...closing, writtenOffBy: undefined };
      await rpc("rnmb_close_tab", {
        id: kept.id,
        status: kept.status,
        ...(kept.status === "paid" ? { collector_id: kept.collectorId, amount_cents: kept.amountCents } : {}),
        ...(kept.status === "written_off" && kept.writtenOffBy ? { written_off_by: kept.writtenOffBy } : {})
      });
      return mirror("closeTab", kept);
    },
    async startHostNight(night) {
      await rpc("rnmb_start_host_night", { id: night.id, name: night.name, date: night.date || today() });
      const started = await mirror("startHostNight", night);
      // The function does not touch settings; making the new night active is ours.
      state.activeNightId = night.id;
      await saveSettingsColumns(state, ["active_night_id"]);
      return started;
    },
    async endHostNight(nightId) {
      await rpc("rnmb_end_host_night", { id: nightId });
      return mirror("endHostNight", nightId);
    },
    async endNight(nightId) {
      if (!crewBalanceAvailable) {
        // Before crew-balance.sql only a host night can end, through the older function.
        const night = state.nights.find((entry) => entry.id === nightId);
        if (night?.kind !== "host") throw refusal(hostModeAvailable ? CREW_BALANCE_SQL_MESSAGE : HOST_MODE_SQL_MESSAGE);
        return repositoryApi.endHostNight(nightId);
      }
      await rpc("rnmb_end_night", { id: nightId });
      return mirror("endNight", nightId);
    },
    async recordPayment(payment) {
      requireCrewBalance();
      const withId = { ...payment, id: payment.id || uid() };
      await rpc("rnmb_record_payment", {
        id: withId.id,
        from_person_id: withId.fromPersonId,
        to_person_id: withId.toPersonId,
        amount_cents: withId.amountCents,
        ...(withId.paidAt ? { paid_at: withId.paidAt } : {})
      });
      return mirror("recordPayment", withId);
    },
    async voidPayment(paymentId) {
      requireCrewBalance();
      await rpc("rnmb_void_payment", { id: paymentId });
      return mirror("voidPayment", paymentId);
    },
    async correctStock(correction) {
      const withId = { ...correction, id: correction.id || uid() };
      await rpc("rnmb_correct_stock", { id: withId.id, bottle_id: withId.bottleId, new_remaining: withId.newRemaining });
      return mirror("correctStock", withId);
    },
    // Menu items and recipes are plain table writes; the gated policies allow them.
    // They are separate requests with no transaction, so order them so that a
    // failure part-way never leaves an item with no recipe in the shared database:
    // an item with no ingredients would ring up for nothing and draw no stock.
    async saveMenuItem(menuItem) {
      requireHostMode();
      const exists = state.menuItems.some((entry) => entry.id === menuItem.id);
      // Validate and fill ids first, so the rows sent are the rows kept. An edit
      // keeps each surviving ingredient's id, so the upsert below updates it in place.
      const saved = prepareMenuItem(menuItem);
      const rows = ingredientRows(saved);
      if (exists) {
        // Write the new recipe over the old one first, then drop only the lines it
        // no longer has, then rename: a failure at any step leaves a whole recipe.
        await upsertRows("rnmb_recipe_ingredients", rows);
        const kept = rows.map((row) => row.id).join(",");
        await deleteWhere("rnmb_recipe_ingredients", `menu_item_id=eq.${saved.id}&id=not.in.(${kept})`);
        await patchWhere("rnmb_menu_items", `id=eq.${saved.id}`, { name: saved.name, kind: saved.kind });
      } else {
        await insertRow("rnmb_menu_items", menuItemRow(saved));
        try {
          await insertRows("rnmb_recipe_ingredients", rows);
        } catch (error) {
          // Take the new, recipe-less item back out (its ingredients cascade), then report the failure.
          await deleteWhere("rnmb_menu_items", `id=eq.${saved.id}`).catch(() => undefined);
          throw error;
        }
      }
      return mirror("saveMenuItem", saved);
    },
    async removeMenuItem(menuItemId) {
      requireHostMode();
      await deleteWhere("rnmb_menu_items", `id=eq.${menuItemId}`);
      return mirror("removeMenuItem", menuItemId);
    },
    async updatePricing(pricing) {
      requireHostMode();
      await saveSettingsColumns({ ...state, ...preparePricing(pricing) }, ["markup_percent", "rounding_increment_cents"]);
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
      crewBalanceAvailable = true;
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
    crewBalanceAvailable = true;
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

  // 0.4.1, KTD4: a crew drink rung up on the register is a crew pour. A person
  // removed since still counts toward the night's total, under nobody's card.
  const crew = crewConsumptionOn(night);
  crew.byPerson.forEach((entry) => {
    if (!entry.personId) return;
    const current = totals.get(entry.personId) || { ounces: 0, drinks: 0 };
    current.ounces += entry.ounces;
    current.drinks += entry.standardDrinks;
    totals.set(entry.personId, current);
  });
  allDrinks += crew.standardDrinks;
  allOunces += crew.ounces;

  return { byPerson: totals, allDrinks, allOunces };
}

/** Unvoided crew ring-ups on one night, measured (0.4.1). Guest ring-ups never count. */
function crewConsumptionOn(night) {
  return night
    ? RNMBDomain.crewConsumption(state.ringUps, state.types, night.id)
    : RNMBDomain.crewConsumption([], state.types);
}

/** Pours logged on a night: dashboard pours plus crew drinks rung up on the register. */
function nightPourCount(night) {
  return night ? (night.pours || []).length + crewConsumptionOn(night).count : 0;
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
  renderQuickLog();
  renderTonight();
  renderNightRecap();
  renderInventory();
  renderMenu();
  renderLedger();
  renderHostNights();
  renderCrew();
  renderRegister();
}

function renderTopline() {
  const night = activeNight();
  document.querySelector("#activeNightName").textContent = night?.name || "No active night";
  document.querySelector("#activeNightMeta").textContent = night ? `${night.date} · ${nightPourCount(night)} pours logged` : "Create a night log to start tracking pours.";
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
    // stockLabel, not bottleLabel: "House Bourbon: The Briefing Bottle" needed
    // 382px of dropdown and never got it. The nickname alone identifies it.
    (bottle) => `${stockLabel(bottle)} · ${amountText(typeById(bottle.typeId), bottle.remaining)} left`,
    "No stocked bottles"
  );
  if (pourable.some((bottle) => bottle.id === chosenBottle)) bottleSelect.value = chosenBottle;
  syncPourAmountField();
}

/**
 * Point one amount field at a volume or at a count. A volume is a text field with
 * a unit dropdown beside it, so the box holds a number and the unit is picked
 * rather than typed. A count is a whole number of units and has no dropdown at
 * all -- "12 ml of cans" is not a thing -- so it keeps the number spinner.
 */
function setVolumeField(input, { volume, min, step }) {
  input.type = volume ? "text" : "number";
  if (volume) {
    input.inputMode = "decimal";
    input.autocomplete = "off";
    input.removeAttribute("min");
    input.removeAttribute("step");
  } else {
    input.min = min;
    input.step = step;
  }
  const unit = unitSelectFor(input);
  if (unit) {
    unit.hidden = !volume;
    unit.disabled = !volume || input.disabled;
  }
}

/** The unit dropdown that belongs to an amount box, if it has one. */
function unitSelectFor(input) {
  return input?.parentElement?.querySelector?.(`[data-unit-for="${input.name}"]`) || null;
}

/**
 * Ounces from an amount box: the number in the box read in the unit picked
 * beside it. A unit typed into the box still wins, so a pasted "750 ml" works
 * whatever the dropdown says. Returns null when it is not a volume at all.
 */
function readVolumeField(input) {
  const unit = unitSelectFor(input);
  return RNMBDomain.parseVolumeOunces(input.value, unit && !unit.hidden ? unit.value : undefined);
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
  // Counted stock is a whole number of units, so it keeps the number spinner. A
  // volume is typed, because a number input throws away "750 ml" before we see it.
  setVolumeField(input, { volume: !counted, min: "1", step: "1" });
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
  setVolumeField(input, { volume: !counted, min: "1", step: "1" });
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
  document.querySelector("#metricSpend").textContent = money(totalSpend());
  document.querySelector("#metricSpendMeta").textContent = `${state.bottles.length} purchases logged`;
  document.querySelector("#metricConsumed").textContent = oneDecimal(totals.allDrinks);
  document.querySelector("#metricInventory").textContent = state.bottles.length;
  document.querySelector("#metricInventoryMeta").textContent = `${oneDecimal(totalRemainingStandardDrinks())} standard drinks remaining`;
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
    const drinks = night.pours.reduce((sum, pour) => sum + measurePour(pour).standardDrinks, 0) + crewConsumptionOn(night).standardDrinks;
    const item = document.createElement("button");
    item.type = "button";
    item.className = "stack-item";
    item.innerHTML = `<strong>${escapeHtml(night.name)}</strong><br><small>${night.date} · ${oneDecimal(drinks)} standard drinks</small>`;
    item.addEventListener("click", async () => {
      state.activeNightId = night.id;
      await saveState("Active night switched.", (db) => db.updateSettings(state, ["active_night_id"]));
      activateTab("tonight");
    });
    target.append(item);
  });
}

/*
 * Quick log (0.4.2, KTD8): pick a person, tap what they are drinking, done. A
 * bottle logs a crew pour of one sensible measure through the same preparePour +
 * addPour path as the pour form; a menu item logs a crew ring-up on the active
 * night, preselected from stock like the register. Everything is charged at cost
 * to the drinker and credited to whoever bought the stock.
 */
function quickLogChoices(personId) {
  const recent = RNMBDomain.recentLogItems(state, personId);
  if (recent.length) return { recent: true, items: recent };
  const bottles = state.bottles
    .filter((bottle) => Number(typeById(bottle.typeId)?.abv) > 0 && Number(bottle.remaining) > RNMBDomain.AMOUNT_EPSILON)
    .map((bottle) => ({ kind: "bottle", id: bottle.id }));
  const menuItems = state.menuItems
    .filter((item) => RNMBDomain.menuItemAvailability(item, state.bottles).available)
    .map((item) => ({ kind: "menu", id: item.id }));
  return { recent: false, items: [...bottles, ...menuItems] };
}

/** What one tap on a bottle pours, and what it costs the drinker; null cost when it cannot be priced. */
function quickLogBottleOffer(bottle) {
  const type = typeById(bottle.typeId);
  const amount = RNMBDomain.quickLogAmount(type);
  const enough = Number(bottle.remaining) + RNMBDomain.AMOUNT_EPSILON >= amount;
  let costCents = null;
  try {
    costCents = RNMBDomain.pourCostCents(bottle, amount);
  } catch (error) {
    costCents = null;
  }
  return { amount, type, enough, costCents };
}

/** What one tap on a menu item rings up: the preselected sources, its cost, and why it cannot be logged. */
function quickLogMenuOffer(menuItem) {
  const ingredients = RNMBDomain.menuItemIngredients(menuItem);
  const picks = RNMBDomain.preselectSources(menuItem, state.bottles);
  const missing = picks.findIndex((pick) => !pick.available);
  if (missing >= 0) {
    const type = typeById(ingredients[missing].typeId);
    return { ok: false, label: "Out of stock", reason: `There is not enough ${type?.name || "stock"} left for ${menuItem.name}, so nothing was logged.` };
  }
  const short = picks.findIndex((pick) => pick.short);
  if (short >= 0) {
    const type = typeById(ingredients[short].typeId);
    const shortfall = RNMBDomain.sourcesShortfall(ingredients[short], picks[short].sources);
    return {
      ok: false,
      label: "Needs two bottles",
      reason: `${type?.name || "An ingredient"} is short ${exactAmountText(type, shortfall)} in every single bottle, so ${menuItem.name} was not logged. Ring it up on the register to split it, or top that bottle's level up.`
    };
  }
  const sources = RNMBDomain.flattenSources(picks.map((pick) => pick.sources));
  try {
    const priced = RNMBDomain.priceRingUp(sources, {
      bottles: state.bottles,
      types: state.types,
      people: state.people,
      markupPercent: state.markupPercent,
      roundingIncrementCents: state.roundingIncrementCents,
      kind: "crew"
    });
    return { ok: true, sources, costCents: RNMBDomain.crewDrinkCostCents(priced.lines) };
  } catch (error) {
    return { ok: false, label: "Unavailable", reason: error.userMessage || error.message };
  }
}

/** The night quick log writes to: the recap's pinned night while it still exists, else the active one. */
function quickLogNight() {
  const pinned = quickLogNightId ? state.nights.find((night) => night.id === quickLogNightId) : null;
  if (!pinned) quickLogNightId = null;
  return pinned || activeNight();
}

function renderQuickLog() {
  const night = quickLogNight();
  const peopleTarget = document.querySelector("#quickLogPeople");
  const itemsTarget = document.querySelector("#quickLogItems");
  const label = document.querySelector("#quickLogItemsLabel");
  if (quickLogPersonId && !personById(quickLogPersonId)) quickLogPersonId = null;
  const person = personById(quickLogPersonId);

  document.querySelector("#quickLogNight").textContent = night
    ? `Logging to ${night.name}${night.endedAt ? " (ended)" : ""}. Every drink is charged at cost to whoever drinks it, and credited to whoever bought the bottle.`
    : "Start a night log below, then every drink is two taps away.";

  peopleTarget.innerHTML = "";
  if (!state.people.length) {
    peopleTarget.innerHTML = `<p class="empty-state">Add the crew first, over in the Crew tab.</p>`;
  }
  state.people.forEach((entry) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-log-choice quick-log-person";
    button.dataset.quickPerson = entry.id;
    button.disabled = quickLogPending;
    button.setAttribute("aria-pressed", String(entry.id === quickLogPersonId));
    button.style.setProperty("--person-color", safeColor(entry.color));
    button.style.setProperty("--person-ink", RNMBDomain.contrastInk(safeColor(entry.color)));
    button.innerHTML = `<span class="avatar" style="--person-color: ${safeColor(entry.color)}; --person-ink: ${RNMBDomain.contrastInk(safeColor(entry.color))}">${initials(entry.name)}</span><strong>${escapeHtml(entry.name)}</strong>`;
    peopleTarget.append(button);
  });

  itemsTarget.innerHTML = "";
  if (!person) {
    label.textContent = "2. What are they having?";
    itemsTarget.innerHTML = `<p class="empty-state">Tap a name to see their usual.</p>`;
    return;
  }
  const choices = quickLogChoices(person.id);
  label.textContent = choices.recent
    ? `2. ${person.name}'s usual`
    : `2. Nothing logged for ${person.name} yet, so here is the shelf`;
  if (!choices.items.length) {
    itemsTarget.innerHTML = `<p class="empty-state">Nothing is in stock to log. Add stock in Inventory.</p>`;
    return;
  }
  choices.items.forEach((choice) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-log-choice";
    let title = "";
    let detail = "";
    if (choice.kind === "bottle") {
      const bottle = bottleById(choice.id);
      if (!bottle) return;
      const offer = quickLogBottleOffer(bottle);
      button.dataset.quickBottle = bottle.id;
      button.disabled = quickLogPending || !offer.enough || !night;
      title = stockLabel(bottle);
      detail = offer.enough
        ? `${amountText(offer.type, offer.amount)}${offer.costCents === null ? "" : ` · ${centsText(offer.costCents)}`}`
        : `Only ${amountText(offer.type, bottle.remaining)} left`;
    } else {
      const item = state.menuItems.find((entry) => entry.id === choice.id);
      if (!item) return;
      const offer = quickLogMenuOffer(item);
      button.dataset.quickMenu = item.id;
      button.disabled = quickLogPending || !night;
      title = item.name;
      detail = offer.ok ? `${centsText(offer.costCents)} at cost` : offer.label;
      if (!offer.ok) button.classList.add("is-short");
    }
    button.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`;
    itemsTarget.append(button);
  });
}

/**
 * The night a quick-logged drink goes on, or a refusal toast explaining why there
 * is none. `night` names one explicitly: the recap passes the night it is showing
 * so a missed drink lands there, whatever the active night is by the time of the tap.
 */
function quickLogTarget(night = quickLogNight()) {
  if (!night) {
    showToast("Start a night log first, then tap away.");
    return null;
  }
  if (!personById(quickLogPersonId)) {
    showToast("Tap who is drinking first.");
    return null;
  }
  return { night, person: personById(quickLogPersonId) };
}

/** One tap on a bottle: a crew pour of one measure, through the same path as the pour form. */
async function quickLogBottle(bottleId, onNight) {
  const target = quickLogTarget(onNight);
  const bottle = bottleById(bottleId);
  if (!target || !bottle) return;
  const { night, person } = target;
  const offer = quickLogBottleOffer(bottle);
  const key = `pour|${night.id}|${person.id}|${bottle.id}`;
  let pour;
  try {
    pour = preparePour(night, { id: draftId(quickLogDraftIds, key), personId: person.id, bottleId: bottle.id, ounces: offer.amount });
  } catch (error) {
    showToast(error.userMessage || "That pour could not be logged.");
    return;
  }
  bottle.remaining = round6(Math.max(0, Number(bottle.remaining) - pour.ounces));
  night.pours.push(pour);
  const cost = pour.costCents !== null && pour.buyerName ? `${centsText(pour.costCents)} at cost` : "no charge (nobody on the roster bought it)";
  const message = `Logged ${amountText(offer.type, pour.ounces)} of ${stockLabel(bottle)} for ${person.name} · ${cost}.`;
  quickLogPending = true;
  renderQuickLog();
  let saved = false;
  try {
    saved = await saveState(message, (db) => db.addPour(night, pour, bottle.remaining));
  } finally {
    quickLogPending = false;
  }
  if (saved) quickLogDraftIds.delete(key);
  renderQuickLog();
}

/** One tap on a menu item: a crew ring-up on the active night, drawing every ingredient at once (0.7.9). */
async function quickLogMenuItem(menuItemId, onNight) {
  const target = quickLogTarget(onNight);
  const menuItem = state.menuItems.find((entry) => entry.id === menuItemId);
  if (!target || !menuItem) return;
  const { night, person } = target;
  if (!hostModeAvailable) {
    showToast(HOST_MODE_SQL_MESSAGE);
    return;
  }
  if (night.kind !== "host" && !crewBalanceAvailable) {
    showToast(CREW_BALANCE_SQL_MESSAGE);
    return;
  }
  const offer = quickLogMenuOffer(menuItem);
  if (!offer.ok) {
    showToast(offer.reason);
    return;
  }
  const key = `menu|${night.id}|${person.id}|${menuItem.id}`;
  const record = buildRingUp({
    id: draftId(quickLogDraftIds, key),
    nightId: night.id,
    kind: "crew",
    personId: person.id,
    menuItemId: menuItem.id,
    sources: offer.sources
  });
  quickLogPending = true;
  renderQuickLog();
  let saved = false;
  try {
    saved = await hostAction(
      `Logged ${menuItem.name} for ${person.name} · ${centsText(RNMBDomain.crewDrinkCostCents(record.lines))} at cost.`,
      (db) => db.ringUp(record)
    );
  } finally {
    quickLogPending = false;
  }
  if (saved) quickLogDraftIds.delete(key);
  renderQuickLog();
}

/**
 * Where a crew drink's liquor came from, for the Tonight timeline. Nothing records
 * whether a drink was rung up at the register or tapped into quick log, so the
 * timeline used to call every one of them "Bar register", which was often untrue.
 * It names the stock it drew instead — which is both known and more useful.
 */
function crewDrinkSource(ringUp) {
  const names = [];
  (ringUp.lines || []).forEach((line) => {
    const bottle = bottleById(line.bottleId);
    const name = bottle ? stockLabel(bottle) : typeById(line.typeId)?.name;
    if (name && !names.includes(name)) names.push(name);
  });
  return names.length ? names.join(", ") : "Crew drink";
}

function renderTonight() {
  const target = document.querySelector("#personConsumption");
  const timeline = document.querySelector("#pourTimeline");
  const night = activeNight();
  const totals = activeNightTotals();

  const anyPours = nightPourCount(night) > 0;
  target.innerHTML = "";
  target.classList.toggle("empty-state", state.people.length === 0 || !anyPours);
  if (!state.people.length || !anyPours) {
    target.textContent = "No pours logged for the active night.";
  } else {
    state.people.forEach((person) => {
      const entry = totals.byPerson.get(person.id) || { ounces: 0, drinks: 0 };
      const card = document.createElement("article");
      card.className = "consumption-card";
      card.innerHTML = `
        <div class="person-card">
          <span class="avatar" style="--person-color: ${safeColor(person.color)}; --person-ink: ${RNMBDomain.contrastInk(safeColor(person.color))}">${initials(person.name)}</span>
          <div class="person-copy"><strong>${escapeHtml(person.name)}</strong><small>${oneDecimal(entry.ounces)} oz total</small></div>
        </div>
        <strong>${oneDecimal(entry.drinks)}</strong>
        <span class="pill">standard drinks</span>
      `;
      target.append(card);
    });
  }

  timeline.innerHTML = "";
  const pours = [...(night?.pours || [])].reverse().slice(0, 12);
  // Crew drinks rung up on the register or tapped into quick log, newest first. They are
  // voided on the register (Crew drinks) or in the night's recap, not removed here.
  const registerDrinks = night
    ? state.ringUps.filter((ringUp) => ringUp.kind === "crew" && ringUp.nightId === night.id && !ringUp.voidedAt).reverse().slice(0, 12)
    : [];
  timeline.classList.toggle("empty-state", pours.length === 0 && registerDrinks.length === 0);
  if (!pours.length && !registerDrinks.length) {
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

  registerDrinks.forEach((ringUp) => {
    const person = personById(ringUp.personId);
    const item = document.createElement("div");
    item.className = "timeline-item";
    item.dataset.registerDrink = ringUp.id;
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(person?.name || ringUp.personName || "Unknown")} had ${escapeHtml(ringUp.menuItemName || "a drink")}</strong>
        <small>${escapeHtml(crewDrinkSource(ringUp))} · ${oneDecimal(RNMBDomain.linesConsumption(ringUp.lines, state.types).standardDrinks)} standard drinks</small>
      </div>
    `;
    timeline.append(item);
  });
}

/*
 * End of night and recap (0.4.3, KTD7). Ending a crew night is a review step, not a
 * confirmation gate: every balance already moved when each drink was logged, and an
 * ended crew night stays editable so the recap can add a missed drink or void a
 * wrong one. Host nights are not touched here — they end in the register, where
 * ending still needs every tab closed and locks the night afterwards.
 */

/** The active night when it is a crew night, else null (a host night has no recap here). */
function recapNight() {
  const night = activeNight();
  return night && night.kind !== "host" ? night : null;
}

/** What one recap line says: what was drunk, how much of it, and what it charged. */
function recapDrinkLines(drink) {
  const cost = drink.costCents === null ? "no charge" : `${centsText(drink.costCents)} at cost`;
  if (drink.kind === "pour") {
    const bottle = bottleById(drink.bottleId);
    return {
      name: bottle ? stockLabel(bottle) : "Stock since removed",
      detail: `${amountText(typeById(drink.typeId), drink.amount)} · ${cost}`
    };
  }
  return { name: drink.name || "Drink", detail: `${oneDecimal(drink.ounces)} oz · ${cost}` };
}

function renderNightRecap() {
  const panel = document.querySelector("#nightRecapPanel");
  const night = recapNight();
  panel.hidden = !night;
  if (!night) return;

  const ended = Boolean(night.endedAt);
  const endButton = document.querySelector("#endCrewNight");
  const note = document.querySelector("#nightRecapNote");
  const list = document.querySelector("#nightRecapList");
  endButton.hidden = ended;
  endButton.disabled = recapPending;
  list.innerHTML = "";
  list.hidden = !ended;

  if (!ended) {
    note.textContent = `Ending ${night.name} opens the recap: every drink, who drank it and what it cost, with a tap to add a missed one or void a wrong one. Balances are already up to date, so nothing is waiting on this.`;
    return;
  }

  note.textContent = `${night.name} ended. Add a missed drink or void a wrong one — an ended crew night stays editable, and every fix moves the balances straight away.`;
  const recap = RNMBDomain.nightRecap(state, night.id);
  if (!recap.length) {
    list.classList.add("empty-state");
    list.textContent = "Nobody logged a drink on this night.";
    return;
  }
  list.classList.remove("empty-state");

  recap.forEach((entry) => {
    const person = personById(entry.personId);
    const card = document.createElement("article");
    card.className = "recap-card";
    card.dataset.recapPerson = entry.personId || "";
    const drinkCount = `${entry.drinks.length} ${entry.drinks.length === 1 ? "drink" : "drinks"}`;
    const lines = entry.drinks.map((drink) => {
      const text = recapDrinkLines(drink);
      return `
        <li class="recap-drink" data-recap-drink="${escapeHtml(drink.id)}">
          <div class="recap-drink-copy">
            <strong>${escapeHtml(text.name)}</strong>
            <small>${escapeHtml(text.detail)}</small>
          </div>
          <button type="button" class="secondary-button" data-recap-void="${escapeHtml(drink.id)}" data-recap-kind="${drink.kind}"${recapPending ? " disabled" : ""}>Void</button>
        </li>`;
    }).join("");
    // Someone removed from the roster keeps their drinks here under the name the
    // records snapshotted, but there is nobody left to log a new drink for.
    const add = person
      ? `<button type="button" class="secondary-button recap-add" data-recap-add="${escapeHtml(person.id)}"${recapPending ? " disabled" : ""}>Add a missed drink</button>`
      : `<small class="form-note">No longer on the crew, so nothing new can be logged for them.</small>`;
    card.innerHTML = `
      <header class="recap-header">
        <div class="person-card">
          <span class="avatar" style="--person-color: ${safeColor(person?.color)}; --person-ink: ${RNMBDomain.contrastInk(safeColor(person?.color))}">${initials(entry.name || "?")}</span>
          <div class="person-copy">
            <strong>${escapeHtml(entry.name || "Unknown")}</strong>
            <small data-recap-meta>${drinkCount} · ${oneDecimal(entry.ounces)} oz · ${oneDecimal(entry.standardDrinks)} standard drinks</small>
          </div>
        </div>
        <strong class="recap-total" data-recap-cost>${centsText(entry.costCents)}</strong>
      </header>
      <ul class="recap-drinks">${lines}</ul>
      ${add}
    `;
    list.append(card);
  });
}

/** End a crew night: confirm, then open the recap. Nothing is locked (KTD7). */
async function endCrewNight() {
  const night = recapNight();
  if (!night || night.endedAt || recapPending) return;
  if (!crewBalanceAvailable) {
    showToast(CREW_BALANCE_SQL_MESSAGE);
    return;
  }
  if (!confirm(`End ${night.name}? The recap opens so you can add a missed drink or void a wrong one — an ended crew night stays editable, and every balance is already up to date.`)) return;
  recapPending = true;
  renderNightRecap();
  try {
    await hostAction(`${night.name} ended. Check the recap for anything missed.`, (db) => db.endNight(night.id));
  } finally {
    recapPending = false;
  }
  renderNightRecap();
}

/** Void one drink from the recap: a pour comes back through removePour, a crew ring-up through voidRingUp. */
async function voidRecapDrink(id, kind) {
  const night = recapNight();
  if (!night || recapPending) return;

  if (kind === "ringUp") {
    const ringUp = state.ringUps.find((entry) => entry.id === id);
    if (!ringUp) return;
    const name = ringUp.personName || personById(ringUp.personId)?.name || "crew";
    if (!confirm(`Void ${ringUp.menuItemName || "this drink"} for ${name}? What it poured goes back into stock, and ${name}'s balance goes back to where it was.`)) return;
    recapPending = true;
    renderNightRecap();
    try {
      await hostAction("Drink voided. Stock and balances are back to where they were.", (db) => db.voidRingUp(ringUp.id));
    } finally {
      recapPending = false;
    }
    renderNightRecap();
    return;
  }

  const pour = (night.pours || []).find((entry) => entry.id === id);
  const bottle = bottleById(pour?.bottleId);
  if (!pour || !bottle) return;
  const name = personById(pour.personId)?.name || "crew";
  const measure = amountText(typeById(bottle.typeId), pour.ounces);
  if (!confirm(`Void ${measure} of ${stockLabel(bottle)} for ${name}? It goes back into stock, and ${name}'s balance goes back to where it was.`)) return;
  recapPending = true;
  renderNightRecap();
  try {
    // saveState's pattern: change state first, then persist. A failure reloads it.
    bottle.remaining = round6(Math.min(Number(bottle.size), Number(bottle.remaining) + Number(pour.ounces)));
    night.pours = night.pours.filter((entry) => entry.id !== id);
    await saveState("Drink voided. Stock and balances are back to where they were.", (db) => db.removePour(pour, bottle.remaining));
  } finally {
    recapPending = false;
  }
  renderNightRecap();
}

/** Point quick log at one person and at the night the recap is showing, then scroll to it. */
function addMissedDrink(personId) {
  const night = recapNight();
  const person = personById(personId);
  if (!night || !person) return;
  quickLogPersonId = person.id;
  quickLogNightId = night.id;
  renderQuickLog();
  document.querySelector("#quickLogItems").scrollIntoView({ block: "center" });
  showToast(`Quick log is ready for ${person.name}. Tap what they had and it lands on ${night.name}.`);
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
            <span>Set level</span>
            ${counted
              ? `<input name="level" type="number" min="0" max="${Number(bottle.size) || 0}" step="1" value="${level}" required>`
              : `<span class="amount-field"><input name="level" type="text" inputmode="decimal" autocomplete="off" value="${level}" required><select class="unit-select" name="levelUnit" data-unit-for="level" aria-label="Unit"><option value="oz" selected>oz</option><option value="ml">ml</option><option value="cl">cl</option><option value="l">L</option></select></span>`}
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

function ingredientRowElements() {
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
    setVolumeField(input, { volume: false, min: "1", step: "1" });
    label.textContent = "Units";
    return;
  }
  input.readOnly = false;
  const counted = isCounted(type);
  setVolumeField(input, { volume: !counted, min: "1", step: "1" });
  label.textContent = counted ? "Amount (units)" : "Amount";
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
      <span data-amount-label>Amount</span>
      <span class="amount-field">
        <input name="ingredientAmount" type="text" inputmode="decimal" autocomplete="off" value="${escapeHtml(String(amount))}">
        <select class="unit-select" name="ingredientAmountUnit" data-unit-for="ingredientAmount" aria-label="Unit">
          <option value="oz" selected>oz</option>
          <option value="ml">ml</option>
          <option value="cl">cl</option>
          <option value="l">L</option>
        </select>
      </span>
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
  const rows = ingredientRowElements();
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
    const amountField = row.querySelector("input[name='ingredientAmount']");
    const raw = amountField.value.trim();
    // Counted ingredients are always one unit; a poured one is a volume, read in
    // whatever unit the dropdown beside the box is set to.
    const amount = kind === "counted" ? 1 : (isCounted(type) ? Number(raw) : readVolumeField(amountField));
    if (amount === null || !Number.isFinite(amount) || amount <= 0 || (kind !== "counted" && raw === "")) {
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

  ingredientRowElements().forEach((row) => {
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

/**
 * What the bartender needs to tell two bottles apart: nickname, buyer, what is
 * left. `compact` drops the bottle's full size, which a dropdown has no room for
 * -- the detail line under the select still shows it.
 */
function registerSourceText(bottle, { compact = false } = {}) {
  if (!bottle) return "Unknown stock item";
  const type = typeById(bottle.typeId);
  const buyer = personById(bottle.buyerId);
  const left = compact
    ? `${amountText(type, bottle.remaining)} left`
    : `${levelText(type, bottle.remaining, bottle.size)} left`;
  return `${bottle.nickname || type?.name || "Stock"} · ${buyer?.name || "no buyer"} · ${left}`;
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
  work.querySelectorAll("#registerClear, #registerEndNight").forEach((control) => {
    control.disabled = registerPending;
  });
  work.querySelectorAll("#registerTabForm input, #registerOpenTab").forEach((control) => {
    control.disabled = registerPending || openTabPending;
  });
  reconcileRegisterDraft(night);
  // Forget collectors picked for tabs that have since closed (here or on another device).
  const openIds = new Set(openTabsFor(night).map((tab) => tab.id));
  [registerCollectors, registerWriters].forEach((picked) => {
    Array.from(picked.keys()).forEach((tabId) => {
      if (!openIds.has(tabId)) picked.delete(tabId);
    });
  });
  renderRegisterMenu();
  renderRegisterTargets(night);
  renderRegisterIngredients();
  renderRegisterTabList(night);
  renderRegisterCrewDrinks(night);
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
    button.style.setProperty("--person-ink", RNMBDomain.contrastInk(safeColor(person.color)));
    button.innerHTML = `<strong>${escapeHtml(person.name)}</strong><span>Crew · at cost</span>`;
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
        `<option value="${escapeHtml(choice.id)}"${choice.id === source.bottleId ? " selected" : ""}>${escapeHtml(registerSourceText(choice, { compact: true }))}</option>`
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
    // A crew drink carries no guest price, but it does debit the drinker what it costs (0.7.9).
    label = `Pour for ${personById(check.target.personId)?.name || "crew"} · ${centsText(RNMBDomain.crewDrinkCostCents(check.priced.lines))} at cost`;
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
    const total = money(RNMBDomain.tabTotalCents(tab.id, state.ringUps) / 100);
    // The chosen collector survives a re-render (a save elsewhere, a refresh) until the tab closes.
    const chosen = personById(registerCollectors.get(tab.id)) ? registerCollectors.get(tab.id) : "";
    // The same for the crew member writing the tab off, who is charged what its drinks cost (0.7.8, 0.8.8).
    const writer = personById(registerWriters.get(tab.id)) ? registerWriters.get(tab.id) : "";
    const peopleOptions = (selected) => state.people.map((person) => (
      `<option value="${escapeHtml(person.id)}"${person.id === selected ? " selected" : ""}>${escapeHtml(person.name)}</option>`
    )).join("");
    const collectors = peopleOptions(chosen);
    const writers = peopleOptions(writer);
    // Before crew-balance.sql the database has nowhere to keep the author and no
    // balance for the charge to land on, so neither is offered or claimed.
    const writeOffCost = centsText(tabWriteOffCostCents(tab.id));
    const writerField = crewBalanceAvailable ? `
        <label>
          <span class="field-label">Written off by</span>
          <select name="writtenOffBy" data-writer-for="${escapeHtml(tab.id)}">
            <option value=""${writer ? "" : " selected"}>Pick a crew member</option>
            ${writers}
          </select>
        </label>` : "";
    const writeOffLabel = crewBalanceAvailable ? `Write off ${writeOffCost}` : "Write off";
    card.innerHTML = `
      <header>
        <strong>${escapeHtml(tab.guestName)}</strong>
        <span class="pill price-pill" data-tab-total>${total}</span>
      </header>
      ${items.length ? `<ul class="register-tab-items">${lines}</ul>` : "<small>No drinks yet.</small>"}
      <div class="register-close">
        <label>
          <span class="field-label">Collected by</span>
          <select name="collectorId" data-collector-for="${escapeHtml(tab.id)}">
            <option value=""${chosen ? "" : " selected"}>Pick a crew member</option>
            ${collectors}
          </select>
        </label>
        <button class="register-primary register-pay" type="button" data-pay-tab="${escapeHtml(tab.id)}">Paid ${total}</button>${writerField}
        <button class="register-secondary register-write-off" type="button" data-write-off-tab="${escapeHtml(tab.id)}">${writeOffLabel}</button>
      </div>
    `;
    list.append(card);
  });
}

/** Crew drinks still standing on this night, newest first, each with a Void control (a wrong person or drink is undone here). */
function renderRegisterCrewDrinks(night) {
  const list = document.querySelector("#registerCrewDrinkList");
  const drinks = night
    ? state.ringUps.filter((ringUp) => ringUp.kind === "crew" && ringUp.nightId === night.id && !ringUp.voidedAt).reverse()
    : [];
  if (!drinks.length) {
    list.innerHTML = `<p class="empty-state">No crew drinks yet.</p>`;
    return;
  }
  const lines = drinks.map((drink) => `
    <li data-ring-up-id="${escapeHtml(drink.id)}">
      <span>${escapeHtml(drink.menuItemName || "Drink")}</span>
      <span>${escapeHtml(drink.personName || personById(drink.personId)?.name || "Crew")}</span>
      <button class="register-secondary register-void" type="button" data-void-ring-up="${escapeHtml(drink.id)}" aria-label="Void ${escapeHtml(drink.menuItemName || "this drink")} for ${escapeHtml(drink.personName || "crew")}">Void</button>
    </li>`).join("");
  list.innerHTML = `<ul class="register-tab-items">${lines}</ul>`;
}

/** 2.8.3: close a tab as paid (the amount is the tab total, KTD assumption) by the chosen collector, after a confirm. */
async function payRegisterTab(tabId) {
  const tab = state.guestTabs.find((entry) => entry.id === tabId && entry.status === "open");
  if (!tab) return;
  const collector = personById(registerCollectors.get(tabId));
  if (!collector) {
    showToast(`Pick who collected the money for ${tab.guestName}'s tab.`);
    return;
  }
  const amountCents = RNMBDomain.tabTotalCents(tab.id, state.ringUps);
  const amount = money(amountCents / 100);
  if (!confirm(`Close ${tab.guestName}'s tab as paid: ${amount} collected by ${collector.name}?`)) return;
  const closed = await hostAction(
    `${tab.guestName}'s tab paid: ${amount} collected by ${collector.name}.`,
    (db) => db.closeTab({ id: tab.id, status: "paid", collectorId: collector.id, amountCents })
  );
  if (closed) registerCollectors.delete(tabId);
}

/** What a written-off tab costs its author (0.8.8): the cost of the stock its drinks drew, per drink. */
function tabWriteOffCostCents(tabId) {
  return tabItems(tabId).reduce((total, item) => total + RNMBDomain.crewDrinkCostCents(item.lines), 0);
}

/**
 * 2.8.3, 0.7.8: write a tab off, after a confirm. Its drinks stay on record, valued
 * against their buyers, and the crew member who wrote it off covers what they cost.
 */
async function writeOffRegisterTab(tabId) {
  const tab = state.guestTabs.find((entry) => entry.id === tabId && entry.status === "open");
  if (!tab) return;
  // No crew balances means no author column and no balance to charge: the tab is
  // written off plainly, and nothing claims a charge that is never recorded.
  const writer = crewBalanceAvailable ? personById(registerWriters.get(tabId)) : null;
  if (!writer && crewBalanceAvailable) {
    showToast(`Pick who is writing off ${tab.guestName}'s tab. Whoever writes it off covers what its drinks cost.`);
    return;
  }
  const amount = money(RNMBDomain.tabTotalCents(tab.id, state.ringUps) / 100);
  const cost = centsText(tabWriteOffCostCents(tabId));
  const charge = writer ? ` ${writer.name} is charged ${cost}, what its drinks cost.` : "";
  if (!confirm(`Write off ${tab.guestName}'s tab (${amount})?${charge} Nobody collects it, and it cannot be reopened.`)) return;
  const closed = await hostAction(
    writer ? `${tab.guestName}'s tab written off by ${writer.name}, at ${cost}.` : `${tab.guestName}'s tab written off.`,
    (db) => db.closeTab({ id: tab.id, status: "written_off", writtenOffBy: writer ? writer.id : undefined })
  );
  if (closed) {
    registerCollectors.delete(tabId);
    registerWriters.delete(tabId);
  }
}

/** 2.8.4: a host night ends only once every tab is closed; the refusal names the guests still open. */
async function endRegisterNight() {
  const night = openHostNight();
  if (!night || hostNightNotSaving(night)) {
    showToast(night ? NOT_SAVING_MESSAGE : REGISTER_CLOSED_MESSAGE);
    return;
  }
  const open = openTabsFor(night);
  if (open.length) {
    showToast(`Close every tab before ending the night. Still open: ${open.map((tab) => tab.guestName).join(", ")}.`);
    return;
  }
  if (!confirm(`End "${night.name}"? The register closes and nothing more can be rung up or voided on this night.`)) return;
  const ended = await hostAction(`${night.name} ended. Its summary is under Host nights in Ledger.`, (db) => db.endHostNight(night.id));
  if (ended) {
    registerDraft = null;
    registerCollectors.clear();
    registerWriters.clear();
    renderRegister();
  }
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
    : `${menuItem.name} poured for ${personById(target.personId)?.name || "crew"} · ${centsText(RNMBDomain.crewDrinkCostCents(check.priced.lines))} at cost.`;
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

  renderBalances();
  renderPayments();
}

const centsText = (cents) => money(cents / 100);

/** A balance in words: who is owed, who owes, who is square, with a friendly nudge (0.9.2). */
function balanceWords(cents) {
  if (cents > 0) return { className: "is-owed", status: `is owed ${centsText(cents)}`, amount: `+${centsText(cents)}`, quip: "Their bottles are doing the heavy lifting." };
  if (cents < 0) return { className: "is-owes", status: `owes ${centsText(-cents)}`, amount: `-${centsText(-cents)}`, quip: "Next Venmo is on them. No rush, no drama." };
  return { className: "is-square", status: "all square", amount: centsText(0), quip: "Clean slate. Cheers to that." };
}

/*
 * Crew Balances (0.5.2, 0.9.2, KTD1, KTD3): each person's running balance and the
 * fewest payments that settle everyone, both derived from the records on every
 * render. Before crew-balance.sql the numbers would be wrong (no drink costs), so
 * the panel shows the notice and no figures at all.
 */
function renderBalances() {
  const notice = document.querySelector("#balanceNotice");
  const summary = document.querySelector("#balanceSummary");
  const list = document.querySelector("#balanceList");
  const suggestions = document.querySelector("#paymentSuggestions");
  notice.hidden = crewBalanceAvailable;
  notice.textContent = crewBalanceAvailable ? "" : CREW_BALANCE_SQL_MESSAGE;
  list.innerHTML = "";
  suggestions.innerHTML = "";
  if (!crewBalanceAvailable) {
    summary.textContent = "";
    list.innerHTML = `<p class="empty-state">Balances show up here once crew balances are set up.</p>`;
    suggestions.innerHTML = `<p class="empty-state">No suggestions until then.</p>`;
    return;
  }

  const balances = RNMBDomain.crewBalances(state);
  if (!balances.length) {
    summary.textContent = "";
    list.innerHTML = `<p class="empty-state">Add the crew first, then every drink keeps score here.</p>`;
    suggestions.innerHTML = `<p class="empty-state">Nothing to settle.</p>`;
    return;
  }
  const owed = balances.filter((entry) => entry.cents > 0).length;
  const owing = balances.filter((entry) => entry.cents < 0).length;
  const net = balances.reduce((sum, entry) => sum + entry.cents, 0);
  // Pours logged before drink costs existed move no money; say so rather than look wrong.
  const uncosted = state.nights.reduce((count, night) => count + (night.pours || []).filter((pour) => pour.costCents === null).length, 0);
  summary.textContent = [
    owed || owing ? `${owed} owed · ${owing} ${owing === 1 ? "owes" : "owe"} · everything nets to ${centsText(net)}.` : "Everyone's square. The ledger has never looked so peaceful.",
    uncosted ? `${uncosted} older ${uncosted === 1 ? "pour was" : "pours were"} logged before drink costs, so ${uncosted === 1 ? "it counts" : "they count"} as $0.00.` : ""
  ].filter(Boolean).join(" ");

  balances.forEach((entry) => {
    const person = entry.personId ? personById(entry.personId) : null;
    const words = balanceWords(entry.cents);
    const row = document.createElement("article");
    row.className = `balance-row ${words.className}`;
    row.dataset.balancePerson = entry.name;
    row.innerHTML = `
      <span class="avatar" style="--person-color: ${safeColor(person?.color)}; --person-ink: ${RNMBDomain.contrastInk(safeColor(person?.color))}">${initials(entry.name || "?")}</span>
      <div class="person-copy">
        <strong>${escapeHtml(entry.name || "Unknown")}${person ? "" : " <small class=\"balance-gone\">(no longer on the roster)</small>"}</strong>
        <small data-balance-status>${escapeHtml(words.status)}</small>
        <small class="balance-quip">${escapeHtml(words.quip)}</small>
      </div>
      <strong class="balance-amount" data-balance-amount>${escapeHtml(words.amount)}</strong>
    `;
    list.append(row);
  });

  const payments = RNMBDomain.suggestPayments(balances);
  if (!payments.length) {
    suggestions.innerHTML = `<p class="empty-state">Nothing to settle. Pour one for the ledger.</p>`;
    return;
  }
  payments.forEach((payment) => {
    const payable = Boolean(personById(payment.fromPersonId) && personById(payment.toPersonId));
    const row = document.createElement("div");
    row.className = "payment-row";
    row.dataset.suggestedPayment = "";
    row.innerHTML = `
      <span class="payment-copy">
        <strong data-payment-text>${escapeHtml(`${payment.fromName} pays ${payment.toName} ${centsText(payment.amountCents)}`)}</strong>
        <small>${payable ? "Send the Venmo, then tap Paid." : "Someone here is no longer on the roster, so this one is settled outside the app."}</small>
      </span>
      <button class="payment-button" type="button" data-pay-suggestion data-from="${escapeHtml(payment.fromPersonId || "")}" data-to="${escapeHtml(payment.toPersonId || "")}" data-amount="${payment.amountCents}"${payable && !paymentPending ? "" : " disabled"}>Paid</button>
    `;
    suggestions.append(row);
  });
}

/** The manual payment form and the recent payments, each with Void (0.5.4, KTD5). */
function renderPayments() {
  const form = document.querySelector("#paymentForm");
  const locked = !crewBalanceAvailable || paymentPending;
  [["fromPersonId", "Who paid?"], ["toPersonId", "Who got paid?"]].forEach(([name, prompt]) => {
    const select = form.querySelector(`select[name='${name}']`);
    const chosen = select.value;
    select.innerHTML = `<option value="">${prompt}</option>${state.people.map((person) => (
      `<option value="${escapeHtml(person.id)}">${escapeHtml(person.name)}</option>`
    )).join("")}`;
    if (personById(chosen)) select.value = chosen;
  });
  form.querySelectorAll("select, input, button").forEach((control) => {
    control.disabled = locked;
  });

  const list = document.querySelector("#paymentList");
  if (!crewBalanceAvailable) {
    list.innerHTML = `<p class="empty-state">Payments can be recorded once crew balances are set up.</p>`;
    return;
  }
  const recent = [...state.payments]
    .sort((a, b) => String(b.paidAt || "").localeCompare(String(a.paidAt || "")))
    .slice(0, 10);
  if (!recent.length) {
    list.innerHTML = `<p class="empty-state">No payments yet. The first Venmo is always the hardest.</p>`;
    return;
  }
  list.innerHTML = "";
  recent.forEach((payment) => {
    const when = payment.paidAt ? new Date(payment.paidAt) : null;
    const date = when && !Number.isNaN(when.getTime()) ? when.toLocaleDateString([], { month: "short", day: "numeric" }) : "";
    const row = document.createElement("div");
    row.className = `payment-row${payment.voidedAt ? " is-voided" : ""}`;
    row.dataset.paymentId = payment.id;
    row.innerHTML = `
      <span class="payment-copy">
        <strong data-payment-text>${escapeHtml(`${payment.fromName} paid ${payment.toName} ${centsText(payment.amountCents)}`)}</strong>
        <small>${escapeHtml(date)}${payment.voidedAt ? " · voided, so it no longer counts" : ""}</small>
      </span>
      ${payment.voidedAt
        ? `<span class="pill">Voided</span>`
        : `<button class="payment-button is-quiet" type="button" data-void-payment="${escapeHtml(payment.id)}"${paymentPending ? " disabled" : ""}>Void</button>`}
    `;
    list.append(row);
  });
}

/** Record one payment through the repository, keeping one id per payment draft until it saves. */
async function savePayment(from, to, amountCents) {
  const key = `${from.id}|${to.id}|${amountCents}`;
  const id = draftId(paymentDraftIds, key);
  paymentPending = true;
  renderLedger();
  let saved = false;
  try {
    saved = await hostAction(
      `Payment recorded: ${from.name} paid ${to.name} ${centsText(amountCents)}.`,
      (db) => db.recordPayment({ id, fromPersonId: from.id, toPersonId: to.id, amountCents })
    );
  } finally {
    paymentPending = false;
  }
  if (saved) paymentDraftIds.delete(key);
  renderLedger();
  return saved;
}

/** Paid on a suggested payment (0.9.2): confirm first, then record it. */
async function recordSuggestedPayment(button) {
  if (paymentPending) return;
  if (!crewBalanceAvailable) {
    showToast(CREW_BALANCE_SQL_MESSAGE);
    return;
  }
  const from = personById(button.dataset.from);
  const to = personById(button.dataset.to);
  const amountCents = Number(button.dataset.amount);
  if (!from || !to || !Number.isInteger(amountCents) || amountCents <= 0) {
    showToast("Both people need to be on the roster to record this payment.");
    return;
  }
  if (!confirm(`Record that ${from.name} paid ${to.name} ${centsText(amountCents)}? Tap OK once the Venmo has actually gone through.`)) return;
  await savePayment(from, to, amountCents);
}

async function voidPayment(paymentId) {
  if (paymentPending) return;
  const payment = state.payments.find((entry) => entry.id === paymentId);
  if (!payment || payment.voidedAt) return;
  if (!confirm(`Void ${payment.fromName}'s ${centsText(payment.amountCents)} payment to ${payment.toName}? Both balances go back to how they were before it.`)) return;
  paymentPending = true;
  renderLedger();
  try {
    await hostAction("Payment voided. Both balances are back where they were.", (db) => db.voidPayment(payment.id));
  } finally {
    paymentPending = false;
  }
  renderLedger();
}

/*
 * Host nights in Ledger (2.8.5, 2.8.6, 0.5.1): per host night, running or ended,
 * who holds the money guests paid and whose stock it belongs to (margin included),
 * and the value written off per buyer. The same tabs feed Crew Balances (0.8.7, 0.8.8).
 */
function renderHostNights() {
  const target = document.querySelector("#hostNightList");
  const nights = state.nights
    .filter((night) => night.kind === "host")
    // Newest first: by date, then a running night before ended ones, then the latest ending.
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) ||
      Number(Boolean(a.endedAt)) - Number(Boolean(b.endedAt)) ||
      String(b.endedAt || "").localeCompare(String(a.endedAt || "")));
  target.innerHTML = "";
  target.classList.toggle("empty-state", nights.length === 0);
  if (!nights.length) {
    target.textContent = "No host nights yet.";
    return;
  }

  const buyerName = (entry) => personById(entry.buyerId)?.name || entry.buyerName || "No buyer";
  const buyerRows = (byBuyer, label) => byBuyer.map((entry) => `
    <li data-buyer="${escapeHtml(buyerName(entry))}">
      <span>${escapeHtml(label(buyerName(entry)))}</span>
      <strong>${money(entry.cents / 100)}</strong>
    </li>`).join("");

  nights.forEach((night) => {
    const tabs = state.guestTabs.filter((tab) => tab.nightId === night.id);
    const summary = RNMBDomain.summarizeHostNight({
      tabs,
      ringUps: state.ringUps.filter((ringUp) => ringUp.nightId === night.id)
    });
    const status = night.endedAt
      ? "Ended"
      : `Running · ${summary.openTabCount} open ${summary.openTabCount === 1 ? "tab" : "tabs"}`;
    const closedCount = tabs.filter((tab) => tab.status !== "open").length;
    const collected = summary.collectors.length
      ? summary.collectors.map((group) => {
        const name = personById(group.collectorId)?.name || group.collectorName || "Unknown";
        return `
          <div class="host-night-group" data-collector="${escapeHtml(name)}">
            <div class="host-night-row"><strong>${escapeHtml(name)} holds</strong><strong data-collector-total>${money(group.totalCents / 100)}</strong></div>
            <ul class="host-night-buyers">${buyerRows(group.byBuyer, (buyer) => `for ${buyer}`)}</ul>
          </div>`;
      }).join("")
      : "<small>No tabs paid yet.</small>";
    const writtenOff = summary.writtenOff.byBuyer.length
      ? `
          <div class="host-night-group" data-written-off-group>
            <div class="host-night-row"><strong>Value of drinks</strong><strong data-written-off-total>${money(summary.writtenOff.totalCents / 100)}</strong></div>
            <ul class="host-night-buyers">${buyerRows(summary.writtenOff.byBuyer, (buyer) => `from ${buyer}'s stock`)}</ul>
          </div>`
      : "<small>Nothing written off.</small>";

    const card = document.createElement("article");
    card.className = "host-night-card";
    card.dataset.hostNightId = night.id;
    card.innerHTML = `
      <header>
        <div>
          <strong>${escapeHtml(night.name)}</strong>
          <small>${escapeHtml(night.date || "")} · ${closedCount} of ${tabs.length} ${tabs.length === 1 ? "tab" : "tabs"} closed</small>
        </div>
        <span class="pill${night.endedAt ? "" : " warn"}" data-host-night-status>${status}</span>
      </header>
      <div class="host-night-section" data-collected>
        <span class="field-label">Collected</span>
        ${collected}
      </div>
      <div class="host-night-section" data-written-off>
        <span class="field-label">Written off</span>
        ${writtenOff}
      </div>
      <div class="host-night-section" data-crew-drinks>
        <span class="field-label">Crew drinks</span>
        ${hostNightCrewDrinks(night)}
      </div>
    `;
    target.append(card);
  });
}

/*
 * Crew drinks charged on a host night (0.4.3, KTD7). The bar register only exists
 * while the night runs, so once it ends this is the only way to undo a drink rung
 * up to the wrong crew member. That is allowed where a guest item is not: a guest
 * item sits on a tab whose total was counted against the cash when the night
 * closed, while a crew drink is charged at cost straight to a person's balance and
 * touches no tab. Before crew-balance.sql the database still locks the whole
 * ended night, so there the drinks are listed and the button says why it cannot.
 */
function hostNightCrewDrinks(night) {
  const drinks = RNMBDomain.crewDrinksOnNight(state, night.id);
  if (!drinks.length) return "<small>No crew drinks charged.</small>";
  const locked = Boolean(night.endedAt) && !crewBalanceAvailable;
  const rows = drinks.map((drink) => {
    const who = drink.personName || personById(drink.personId)?.name || "Crew";
    const what = drink.kind === "pour"
      ? (bottleById(drink.bottleId) ? stockLabel(bottleById(drink.bottleId)) : "Stock since removed")
      : (drink.name || "Drink");
    const cost = drink.costCents === null ? "no charge" : `${centsText(drink.costCents)} at cost`;
    return `
      <li data-crew-drink="${escapeHtml(drink.id)}" data-crew-drink-kind="${drink.kind}">
        <span>${escapeHtml(what)} · ${escapeHtml(who)}</span>
        <span>${escapeHtml(cost)}</span>
        <button type="button" class="secondary-button" data-void-crew-drink="${escapeHtml(drink.id)}" data-void-crew-kind="${drink.kind}" data-void-crew-night="${escapeHtml(night.id)}"${locked ? " disabled" : ""} aria-label="Void ${escapeHtml(what)} for ${escapeHtml(who)}">Void</button>
      </li>`;
  }).join("");
  const note = locked
    ? `<small class="form-note">${escapeHtml(CREW_BALANCE_SQL_MESSAGE)}</small>`
    : (night.endedAt ? "<small class=\"form-note\">This night has ended, so its guest tabs are settled — but a crew drink is charged at cost and can still be put right.</small>" : "");
  return `<ul class="host-night-crew-drinks">${rows}</ul>${note}`;
}

/** Void one crew drink charged on a host night: stock and the drinker's balance both go back. */
async function voidHostNightCrewDrink(id, kind, nightId) {
  const night = state.nights.find((entry) => entry.id === nightId);
  if (!night) return;

  if (kind === "ringUp") {
    const ringUp = state.ringUps.find((entry) => entry.id === id && entry.kind === "crew");
    if (!ringUp) return;
    const who = ringUp.personName || personById(ringUp.personId)?.name || "crew";
    if (!confirm(`Void ${ringUp.menuItemName || "this drink"} for ${who}? What it poured goes back into stock, and ${who}'s balance goes back to where it was.`)) return;
    await hostAction("Drink voided. Stock and balances are back to where they were.", (db) => db.voidRingUp(ringUp.id));
    return;
  }

  const pour = (night.pours || []).find((entry) => entry.id === id);
  const bottle = bottleById(pour?.bottleId);
  if (!pour || !bottle) return;
  const who = pour.personName || personById(pour.personId)?.name || "crew";
  const measure = amountText(typeById(bottle.typeId), pour.ounces);
  if (!confirm(`Void ${measure} of ${stockLabel(bottle)} for ${who}? It goes back into stock, and ${who}'s balance goes back to where it was.`)) return;
  // saveState's pattern: change state first, then persist. A failure reloads it.
  bottle.remaining = round6(Math.min(Number(bottle.size), Number(bottle.remaining) + Number(pour.ounces)));
  night.pours = night.pours.filter((entry) => entry.id !== id);
  await saveState("Drink voided. Stock and balances are back to where they were.", (db) => db.removePour(pour, bottle.remaining));
}

function renderCrew() {
  const target = document.querySelector("#personList");
  target.innerHTML = "";
  target.classList.toggle("empty-state", state.people.length === 0);
  if (!state.people.length) {
    target.textContent = "No people added yet.";
    return;
  }
  // A crew drink rung up on the register counts as one pour, on every night (0.4.1).
  const registerPours = new Map(RNMBDomain.crewConsumption(state.ringUps, state.types).byPerson.map((entry) => [entry.personId, entry.count]));
  state.people.forEach((person) => {
    const pours = state.nights.flatMap((night) => night.pours || []).filter((pour) => pour.personId === person.id);
    const pourCount = pours.length + (registerPours.get(person.id) || 0);
    const spent = spendByPerson().get(person.id) || 0;
    const card = document.createElement("div");
    card.className = "person-card";
    card.innerHTML = `
      <span class="avatar" style="--person-color: ${safeColor(person.color)}; --person-ink: ${RNMBDomain.contrastInk(safeColor(person.color))}">${initials(person.name)}</span>
      <div class="person-copy">
        <strong>${escapeHtml(person.name)}</strong>
        <small>${money(spent)} logged · ${pourCount} pours</small>
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
  // The volume of one unit, so a can labelled 355 ml can be typed that way.
  const unitOz = measure === RNMBDomain.MEASURE_UNIT
    ? readVolumeField(event.currentTarget.querySelector("[name='unitOz']"))
    : null;
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
  const stockType = typeById(data.get("typeId"));
  // Counted stock is a count; a poured size is a volume, so "750 ml" is accepted.
  const sizeField = event.currentTarget.querySelector("[name='sizeOz']");
  const size = stockType && isCounted(stockType) ? Number(data.get("sizeOz")) : readVolumeField(sizeField);
  if (!stockType || size === null || !Number.isFinite(size) || size <= 0) {
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
  quickLogNightId = null;
  await saveState("Active night switched.", (db) => db.updateSettings(state, ["active_night_id"]));
});

document.querySelector("#pourForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const night = activeNight();
  if (!night) {
    showToast("Create a night log first.");
    return;
  }
  const data = new FormData(event.currentTarget);
  let pour;
  try {
    // In the type's measure: ounces, or a count for counted stock (KTD5). The
    // field keeps its old name, and so does the pour's `ounces` property.
    const bottleForPour = bottleById(data.get("bottleId"));
    const amountField = event.currentTarget.querySelector("[name='ounces']");
    const amount = isCounted(typeById(bottleForPour?.typeId)) ? Number(data.get("ounces")) : readVolumeField(amountField);
    if (amount === null) {
      showToast("Enter how much was drunk as a number, and pick its unit beside the box.");
      return;
    }
    pour = preparePour(night, { personId: data.get("personId"), bottleId: data.get("bottleId"), ounces: amount });
  } catch (error) {
    showToast(error.userMessage || "Pick a stocked bottle and a valid pour.");
    return;
  }
  const bottle = bottleById(pour.bottleId);
  bottle.remaining = Math.max(0, Number(bottle.remaining) - pour.ounces);
  night.pours.push(pour);

  await saveState("Pour logged.", (db) => db.addPour(night, pour, bottle.remaining));
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
  // sold from — or that crew pours were charged against — stays. Checked here
  // for both repositories, before anything changes.
  const bottleRefusal = bottleId ? bottleDeleteRefusal(bottleId) : null;
  if (bottleRefusal) {
    showToast(bottleRefusal);
  } else if (bottleId && confirm("Remove this bottle and its receipt from the dashboard?")) {
    state.bottles = state.bottles.filter((bottle) => bottle.id !== bottleId);
    state.stockAdjustments = state.stockAdjustments.filter((adjustment) => adjustment.bottleId !== bottleId);
    state.nights.forEach((night) => {
      night.pours = night.pours.filter((pour) => pour.bottleId !== bottleId);
    });
    await saveState("Bottle removed.", (db) => db.removeBottle(bottleId));
  }

  // KTD9 (0.5.7): nobody leaves the roster with money still riding on them.
  const unsettled = personId && crewBalanceAvailable
    ? RNMBDomain.crewBalances(state).find((entry) => entry.personId === personId && entry.cents !== 0)
    : null;
  // Removing someone also deletes the pours they drank, which can move other people's
  // balances even when theirs reads $0.00; that is refused the same way.
  const shifted = personId && crewBalanceAvailable && !unsettled ? RNMBDomain.balanceChangesOnRemoval(state, personId) : [];
  if (unsettled) {
    const words = balanceWords(unsettled.cents);
    showToast(`${unsettled.name} ${words.status}, so they stay on the roster for now. Settle up in the Ledger until they read $0.00, then remove them.`);
  } else if (shifted.length) {
    const name = personById(personId)?.name || "This person";
    showToast(`${name} drank from other people's bottles, and removing ${name} would erase those drinks and change ${shifted.map((entry) => entry.name).join(", ")}'s balance. ${name} stays on the roster.`);
  } else if (personId && confirm("Remove this person and related pours? Receipts remain unassigned.")) {
    state.people = state.people.filter((person) => person.id !== personId);
    state.bottles.forEach((bottle) => {
      if (bottle.buyerId === personId) bottle.buyerId = "";
    });
    state.nights.forEach((night) => {
      night.pours = night.pours
        .filter((pour) => pour.personId !== personId)
        .map((pour) => (pour.buyerId === personId ? { ...pour, buyerId: null } : pour));
    });
    // As the database does (on delete set null): the reference goes, the name
    // snapshot stays on every pour, tab, ring-up, line and payment.
    state.guestTabs = state.guestTabs.map((tab) => ({
      ...tab,
      collectorId: tab.collectorId === personId ? null : tab.collectorId,
      writtenOffBy: tab.writtenOffBy === personId ? null : tab.writtenOffBy
    }));
    state.payments = state.payments.map((payment) => ({
      ...payment,
      fromPersonId: payment.fromPersonId === personId ? null : payment.fromPersonId,
      toPersonId: payment.toPersonId === personId ? null : payment.toPersonId
    }));
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
  const levelField = form.querySelector("[name='level']");
  const raw = levelField.value.trim();
  // A level in the bottle is a volume unless the stock is counted, so it reads
  // millilitres too -- handy when what is left is judged against the label.
  const newRemaining = isCounted(type) ? Number(raw) : readVolumeField(levelField);
  if (raw === "" || newRemaining === null || !Number.isFinite(newRemaining) || newRemaining < 0 || newRemaining > Number(bottle.size)) {
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
  ingredientRowElements().forEach(syncIngredientRow);
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
  if (kind !== "cocktail" && ingredientRowElements().length >= 1) {
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
// ---- Tonight: quick log (0.4.2) ----
document.querySelector("#quickLogPeople").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-quick-person]");
  if (!button || button.disabled) return;
  // Tapping the chosen person again clears the choice, so the panel never logs to the wrong one.
  quickLogPersonId = quickLogPersonId === button.dataset.quickPerson ? null : button.dataset.quickPerson;
  // Choosing a person here is a fresh start, so any night the recap pinned is let go.
  quickLogNightId = null;
  renderQuickLog();
});

document.querySelector("#quickLogItems").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled || quickLogPending) return;
  // Read the night once, here, so a refresh mid-tap cannot move the drink to another night.
  const night = quickLogNight();
  if (button.dataset.quickBottle) await quickLogBottle(button.dataset.quickBottle, night);
  else if (button.dataset.quickMenu) await quickLogMenuItem(button.dataset.quickMenu, night);
});

// ---- Tonight: end of night and recap (0.4.3) ----
document.querySelector("#nightRecapPanel").addEventListener("click", async (event) => {
  const control = event.target.closest("button");
  if (!control || control.disabled || recapPending) return;
  if (control.id === "endCrewNight") {
    await endCrewNight();
    return;
  }
  if (control.dataset.recapAdd) {
    addMissedDrink(control.dataset.recapAdd);
    return;
  }
  if (control.dataset.recapVoid) await voidRecapDrink(control.dataset.recapVoid, control.dataset.recapKind);
});

// ---- Ledger: settle up (0.5.4, 0.9.2) ----
document.querySelector("#ledger").addEventListener("click", async (event) => {
  const control = event.target.closest("button");
  if (!control || control.disabled) return;
  if (control.hasAttribute("data-pay-suggestion")) {
    await recordSuggestedPayment(control);
    return;
  }
  if (control.dataset.voidCrewDrink) {
    // The Host nights panel is inside #ledger, so it is handled here too.
    await voidHostNightCrewDrink(control.dataset.voidCrewDrink, control.dataset.voidCrewKind, control.dataset.voidCrewNight);
    return;
  }
  if (control.dataset.voidPayment) await voidPayment(control.dataset.voidPayment);
});

document.querySelector("#paymentForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (paymentPending) return;
  if (!crewBalanceAvailable) {
    showToast(CREW_BALANCE_SQL_MESSAGE);
    return;
  }
  const form = event.currentTarget;
  const from = personById(form.fromPersonId.value);
  const to = personById(form.toPersonId.value);
  const amountCents = RNMBDomain.dollarsToCents(form.amount.value);
  if (!from || !to) {
    showToast("Pick who paid and who got paid.");
    return;
  }
  if (from.id === to.id) {
    showToast("A payment goes between two different crew members.");
    return;
  }
  if (amountCents === null || amountCents <= 0) {
    showToast("Enter the amount in dollars, like 3.20.");
    return;
  }
  if (await savePayment(from, to, amountCents)) form.amount.value = "";
});

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

  if (control.id === "registerEndNight") {
    await endRegisterNight();
    return;
  }
  if (control.dataset.payTab) {
    await payRegisterTab(control.dataset.payTab);
    return;
  }
  if (control.dataset.writeOffTab) {
    await writeOffRegisterTab(control.dataset.writeOffTab);
    return;
  }

  const ringUpId = control.dataset.voidRingUp;
  if (ringUpId) {
    const ringUp = state.ringUps.find((entry) => entry.id === ringUpId);
    if (!ringUp) return;
    let question;
    if (ringUp.kind === "crew") {
      // A crew drink has no tab; name the person so the right mistake is undone.
      const name = ringUp.personName || personById(ringUp.personId)?.name || "crew";
      question = `Void ${ringUp.menuItemName || "this drink"} poured for ${name}? What it poured goes back into stock, and it no longer counts toward ${name}'s drinks.`;
    } else {
      const tab = state.guestTabs.find((entry) => entry.id === ringUp.tabId);
      if (!tab) return;
      question = `Void ${ringUp.menuItemName || "this drink"} (${money((Number(ringUp.priceCents) || 0) / 100)}) from ${tab.guestName}'s tab? What it poured goes back into stock.`;
    }
    if (!confirm(question)) return;
    await hostAction("Item voided and its stock restored.", (db) => db.voidRingUp(ringUp.id));
  }
});

document.querySelector("#register").addEventListener("change", (event) => {
  if (event.target.matches("select[data-collector-for]")) {
    // Remembered only; nothing is saved until Paid is confirmed.
    if (event.target.value) registerCollectors.set(event.target.dataset.collectorFor, event.target.value);
    else registerCollectors.delete(event.target.dataset.collectorFor);
    return;
  }
  if (event.target.matches("select[data-writer-for]")) {
    // Likewise: remembered until Write off is confirmed (0.7.8).
    if (event.target.value) registerWriters.set(event.target.dataset.writerFor, event.target.value);
    else registerWriters.delete(event.target.dataset.writerFor);
    return;
  }
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
  // Each submit makes a new tab id, so a second tap (or Enter then a tap) during a slow call would open a second tab.
  if (registerPending || openTabPending) return;
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
  openTabPending = true;
  renderRegister();
  let opened = false;
  try {
    opened = await hostAction(`Tab opened for ${guestName}.`, (db) => db.openTab({ id: tabId, nightId: night.id, guestName }));
  } finally {
    openTabPending = false;
  }
  if (opened) {
    input.value = "";
    // The new tab is who the next drink is for.
    if (state.guestTabs.some((tab) => tab.id === tabId && tab.status === "open")) {
      ensureRegisterDraft().target = { kind: "guest", tabId };
    }
  }
  // Unlock the form whether or not the tab opened.
  renderRegister();
});

function bottleHasSales(bottleId) {
  return state.ringUps.some((ringUp) => ringUp.lines.some((line) => line.bottleId === bottleId));
}

/**
 * Crew pours drawn from this stock item that carry a cost. Deleting the item
 * deletes them (rnmb_pours.bottle_id cascades in the shared database, and the
 * local handler filters them out), which would take the drinker's debit and the
 * buyer's credit with it — a silent shift in somebody else's balance.
 */
function bottleHasCostedPours(bottleId) {
  return state.nights.some((night) => (night.pours || []).some((pour) => (
    pour.bottleId === bottleId && pour.costCents !== null && pour.costCents !== undefined
  )));
}

/**
 * KTD6: why a stock item can no longer be deleted, or null when it can be.
 * Money history is never destroyed — a sold drink or a charged crew pour keeps
 * the item, which is emptied instead.
 */
function bottleDeleteRefusal(bottleId) {
  if (bottleHasSales(bottleId)) return SOLD_BOTTLE_MESSAGE;
  if (bottleHasCostedPours(bottleId)) return POURED_BOTTLE_MESSAGE;
  return null;
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
    const hostCollections = ["menuItems", "guestTabs", "ringUps", "stockAdjustments", "payments"];
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
    state = normalizeState(imported);
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
  get crewBalanceAvailable() { return crewBalanceAvailable; },
  crewBalances: () => RNMBDomain.crewBalances(state),
  preparePour,
  get registerDraft() { return registerDraft; },
  archiveData,
  buildRingUp,
  hostAction,
  isUserBusy,
  render
});

init();
