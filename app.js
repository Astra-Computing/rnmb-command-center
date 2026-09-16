const STORAGE_KEY = "rnmb-command-center-v1";
const STANDARD_DRINK_OZ = 0.6;

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
const emptyState = () => ({
  people: [],
  types: [],
  bottles: [],
  nights: [],
  activeNightId: "",
  responsibleMode: true
});

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
    { id: uid(), typeId: types[0].id, nickname: "The Briefing Bottle", sizeOz: 25.36, remainingOz: 19.2, price: 34.99, buyerId: people[0].id, date: today() },
    { id: uid(), typeId: types[1].id, nickname: "Cooler Battalion", sizeOz: 144, remainingOz: 96, price: 22.5, buyerId: people[1].id, date: today() },
    { id: uid(), typeId: types[2].id, nickname: "Diplomatic Pouch", sizeOz: 25.36, remainingOz: 25.36, price: 18.99, buyerId: people[2].id, date: today() }
  ];
  const nightId = uid();
  return {
    people,
    types,
    bottles,
    nights: [{ id: nightId, name: "Friday Recon", date: today(), pours: [] }],
    activeNightId: nightId,
    responsibleMode: true
  };
};

let state = emptyState();
let repository = createLocalRepository();
let syncMode = "local";
let saveInFlight = false;
let lastSyncedAt = null;

function normalizeState(input) {
  return {
    people: input.people || [],
    types: input.types || [],
    bottles: input.bottles || [],
    nights: input.nights || [],
    activeNightId: input.activeNightId || input.nights?.[0]?.id || "",
    responsibleMode: input.responsibleMode !== false
  };
}

function loadLocalState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  try {
    return raw ? normalizeState(JSON.parse(raw)) : demoData();
  } catch {
    return demoData();
  }
}

function createLocalRepository() {
  return {
    async load() {
      const local = loadLocalState();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
      return local;
    },
    async saveAll(nextState) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    }
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
  const baseHeaders = {
    apikey: config.supabaseAnonKey,
    "Content-Type": "application/json"
  };

  async function request(path, options = {}) {
    const response = await fetch(`${restBase}/${path}`, {
      ...options,
      headers: {
        ...baseHeaders,
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Supabase ${options.method || "GET"} ${path} failed: ${body}`);
    }

    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function readTable(table, query = "") {
    return request(`${table}?select=*&${query}`);
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
      body: JSON.stringify([{
        id: true,
        active_night_id: nextState.activeNightId || null,
        responsible_mode: nextState.responsibleMode !== false
      }])
    });
  }

  return {
    async load() {
      const [peopleRows, typeRows, bottleRows, nightRows, pourRows, settingsRows] = await Promise.all([
        readTable("rnmb_people", "order=created_at.asc"),
        readTable("rnmb_beverage_types", "order=created_at.asc"),
        readTable("rnmb_bottles", "order=created_at.asc"),
        readTable("rnmb_nights", "order=date.desc,created_at.desc"),
        readTable("rnmb_pours", "order=poured_at.asc"),
        readTable("rnmb_settings", "id=eq.true")
      ]);

      const nights = nightRows.map((night) => ({
        id: night.id,
        name: night.name,
        date: night.date,
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
          abv: Number(type.abv)
        })),
        bottles: bottleRows.map((bottle) => ({
          id: bottle.id,
          typeId: bottle.type_id,
          nickname: bottle.nickname || "",
          sizeOz: Number(bottle.size_oz),
          remainingOz: Number(bottle.remaining_oz),
          price: Number(bottle.price),
          buyerId: bottle.buyer_id || "",
          date: bottle.purchase_date
        })),
        nights,
        activeNightId: settings.active_night_id || nights[0]?.id || "",
        responsibleMode: settings.responsible_mode !== false
      });
    },
    async saveAll(nextState) {
      await request("rnmb_settings?id=eq.true", {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ active_night_id: null })
      }).catch(() => undefined);

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
      await insertRows("rnmb_beverage_types", nextState.types.map((type) => ({
        id: type.id,
        name: type.name,
        category: type.category,
        abv: type.abv
      })));
      await insertRows("rnmb_nights", nextState.nights.map((night) => ({
        id: night.id,
        name: night.name,
        date: night.date
      })));
      await insertRows("rnmb_bottles", nextState.bottles.map((bottle) => ({
        id: bottle.id,
        type_id: bottle.typeId,
        nickname: bottle.nickname || null,
        size_oz: bottle.sizeOz,
        remaining_oz: bottle.remainingOz,
        price: bottle.price,
        buyer_id: bottle.buyerId || null,
        purchase_date: bottle.date
      })));
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
      await insertRow("rnmb_beverage_types", {
        id: type.id,
        name: type.name,
        category: type.category,
        abv: type.abv
      });
    },
    async addBottle(bottle) {
      await insertRow("rnmb_bottles", {
        id: bottle.id,
        type_id: bottle.typeId,
        nickname: bottle.nickname || null,
        size_oz: bottle.sizeOz,
        remaining_oz: bottle.remainingOz,
        price: bottle.price,
        buyer_id: bottle.buyerId || null,
        purchase_date: bottle.date
      });
    },
    async addNight(night, nextState) {
      await insertRow("rnmb_nights", {
        id: night.id,
        name: night.name,
        date: night.date
      });
      await saveSettings(nextState);
    },
    async addPour(night, pour, remainingOz) {
      await patchWhere("rnmb_bottles", `id=eq.${pour.bottleId}`, { remaining_oz: remainingOz });
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
    async removePour(pour, restoredRemainingOz) {
      await deleteWhere("rnmb_pours", `id=eq.${pour.id}`);
      await patchWhere("rnmb_bottles", `id=eq.${pour.bottleId}`, { remaining_oz: restoredRemainingOz });
    },
    async removeBottle(bottleId) {
      await deleteWhere("rnmb_bottles", `id=eq.${bottleId}`);
    },
    async removePerson(personId) {
      await deleteWhere("rnmb_people", `id=eq.${personId}`);
    }
  };
}

async function init() {
  try {
    repository = await createRepository();
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
    state = await repository.load();
    render();
    showToast("Supabase load failed. Using local browser storage.");
  }
}

async function saveState(message, supabaseOperation) {
  saveInFlight = true;
  try {
    if (syncMode === "supabase" && supabaseOperation) {
      await supabaseOperation(repository);
    } else {
      await repository.saveAll(state);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    render();
    if (message) showToast(message);
  } catch (error) {
    console.error(error);
    if (syncMode === "supabase") {
      try {
        state = await repository.load();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (reloadError) {
        console.error(reloadError);
      }
    }
    render();
    showToast("Save failed. Check Supabase settings and policies.");
  } finally {
    saveInFlight = false;
    lastSyncedAt = new Date();
  }
}

/*
 * Shared state is read once at boot and never again, so two people on the same
 * dashboard never saw each other's pours. There is no realtime subscription
 * here on purpose: the app has no dependencies and adding a websocket client
 * would be the only one. Polling six small tables every 15s is enough for a
 * dashboard a handful of people watch for an evening.
 */
const REFRESH_MS = 15000;
let refreshTimer = null;

/** Never redraw the form a user is mid-way through filling in. */
function isUserBusy() {
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

function standardDrinks(ounces, abv) {
  return (Number(ounces) || 0) * ((Number(abv) || 0) / 100) / STANDARD_DRINK_OZ;
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
  return state.bottles.reduce((sum, bottle) => {
    const type = typeById(bottle.typeId);
    return sum + standardDrinks(bottle.remainingOz, type?.abv || 0);
  }, 0);
}

function activeNightTotals() {
  const night = activeNight();
  const totals = new Map(state.people.map((person) => [person.id, { ounces: 0, drinks: 0 }]));
  let allDrinks = 0;
  let allOunces = 0;

  night?.pours?.forEach((pour) => {
    const bottle = bottleById(pour.bottleId);
    const type = typeById(bottle?.typeId);
    const drinks = standardDrinks(pour.ounces, type?.abv || pour.abv || 0);
    const current = totals.get(pour.personId) || { ounces: 0, drinks: 0 };
    current.ounces += Number(pour.ounces || 0);
    current.drinks += drinks;
    totals.set(pour.personId, current);
    allDrinks += drinks;
    allOunces += Number(pour.ounces || 0);
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
  renderLedger();
  renderCrew();
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

  document.querySelectorAll("select[name='personId'], select[name='buyerId']").forEach((select) => {
    setOptions(select, state.people, (person) => person.name, "Add people first");
  });
  setOptions(document.querySelector("select[name='typeId']"), state.types, (type) => `${type.name} · ${type.abv}%`, "Add types first");
  setOptions(
    document.querySelector("select[name='bottleId']"),
    state.bottles.filter((bottle) => Number(bottle.remainingOz) > 0),
    (bottle) => `${bottleLabel(bottle)} · ${oneDecimal(bottle.remainingOz)} oz left`,
    "No stocked bottles"
  );
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
    .map((bottle) => ({ bottle, ratio: Number(bottle.remainingOz || 0) / Number(bottle.sizeOz || 1) }))
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
    item.innerHTML = `<strong>${escapeHtml(bottleLabel(bottle))}</strong><br><small>${oneDecimal(bottle.remainingOz)} oz left · ${Math.round(ratio * 100)}%</small>`;
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
    const drinks = night.pours.reduce((sum, pour) => {
      const bottle = bottleById(pour.bottleId);
      const type = typeById(bottle?.typeId);
      return sum + standardDrinks(pour.ounces, type?.abv || pour.abv || 0);
    }, 0);
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
        <strong>${escapeHtml(person?.name || "Unknown")} logged ${oneDecimal(pour.ounces)} oz</strong>
        <small>${escapeHtml(type?.name || "Unknown")} · ${oneDecimal(standardDrinks(pour.ounces, type?.abv || pour.abv || 0))} standard drinks</small>
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
      const fill = Math.max(0, Math.min(100, (Number(bottle.remainingOz || 0) / Number(bottle.sizeOz || 1)) * 100));
      const card = document.createElement("article");
      card.className = "inventory-card";
      card.innerHTML = `
        <header>
          <div>
            <strong>${escapeHtml(type?.name || "Unknown")}</strong>
            <small>${escapeHtml(bottle.nickname || type?.category || "Stock")}</small>
          </div>
          <span class="pill">${oneDecimal(type?.abv || 0)}%</span>
        </header>
        <div class="progress"><span style="--fill: ${fill}%"></span></div>
        <small>${oneDecimal(bottle.remainingOz)} of ${oneDecimal(bottle.sizeOz)} oz · ${oneDecimal(standardDrinks(bottle.remainingOz, type?.abv || 0))} standard drinks left</small>
        <small>${money(bottle.price)} paid by ${escapeHtml(buyer?.name || "Unknown")}</small>
        <button class="remove-button" type="button" data-remove-bottle="${bottle.id}" aria-label="Remove bottle">×</button>
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
      chip.innerHTML = `<strong>${escapeHtml(type.name)}</strong><br><small>${escapeHtml(type.category)} · ${oneDecimal(type.abv)}% ABV</small>`;
      typeList.append(chip);
    });
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
  const data = new FormData(event.currentTarget);
  const type = {
    id: uid(),
    name: data.get("name").trim(),
    category: data.get("category"),
    abv: Number(data.get("abv"))
  };
  state.types.push(type);
  event.currentTarget.reset();
  event.currentTarget.abv.value = 40;
  await saveState("Beverage type added.", (db) => db.addType(type));
});

document.querySelector("#bottleForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.people.length || !state.types.length) {
    showToast("Add at least one person and beverage type first.");
    return;
  }
  const data = new FormData(event.currentTarget);
  const sizeOz = Number(data.get("sizeOz"));
  const bottle = {
    id: uid(),
    typeId: data.get("typeId"),
    nickname: data.get("nickname").trim(),
    sizeOz,
    remainingOz: sizeOz,
    price: Number(data.get("price")),
    buyerId: data.get("buyerId"),
    date: data.get("date")
  };
  state.bottles.push(bottle);
  event.currentTarget.reset();
  event.currentTarget.sizeOz.value = 25.36;
  event.currentTarget.price.value = 0;
  event.currentTarget.date.value = today();
  await saveState("Bottle added to inventory.", (db) => db.addBottle(bottle));
});

document.querySelector("#nightForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const night = { id: uid(), name: data.get("name").trim(), date: data.get("date"), pours: [] };
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
  const ounces = Number(data.get("ounces"));
  if (!bottle || !type || ounces <= 0) {
    showToast("Pick a stocked bottle and a valid pour.");
    return;
  }
  if (ounces > Number(bottle.remainingOz)) {
    showToast("That pour exceeds the bottle inventory.");
    return;
  }

  bottle.remainingOz = Math.max(0, Number(bottle.remainingOz) - ounces);
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
  await saveState(message, (db) => db.addPour(night, pour, bottle.remainingOz));
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
      bottle.remainingOz = Math.min(Number(bottle.sizeOz), Number(bottle.remainingOz) + Number(pour.ounces));
      night.pours = night.pours.filter((entry) => entry.id !== pourId);
      await saveState("Pour removed and inventory restored.", (db) => db.removePour(pour, bottle.remainingOz));
    }
  }

  if (bottleId && confirm("Remove this bottle and its receipt from the dashboard?")) {
    state.bottles = state.bottles.filter((bottle) => bottle.id !== bottleId);
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
    await saveState("Person removed.", (db) => db.removePerson(personId));
  }
});

function downloadArchive(label) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `rnmb-command-center-${label}-${today()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/*
 * Import, Reload demo and Clear are the only actions that do not write a single
 * targeted row: they go through saveAll, which deletes every row in all five
 * tables and re-inserts. Connected to Supabase that is everyone's data, not
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

init();
