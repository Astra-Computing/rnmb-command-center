/*
 * domain.js — pure money and stock arithmetic for RNMB Command Center host mode.
 *
 * A classic browser script (no build step, no imports). It defines ONE global,
 * `RNMBDomain`, and when loaded by Node (`require("./domain.js")`) exports the
 * same object, so the tests in tests/domain.test.js exercise exactly the code the
 * page runs. Nothing here touches the DOM, the network, storage or the clock.
 *
 * Money is integer cents (KTD2). Ingredient cost stays UNROUNDED cents; the
 * marked-up total is rounded up to the increment exactly once; buyer shares split
 * the final price by largest remainder in proportion to unrounded line cost.
 * Amounts are in the stock type's measure: ounces for poured types, whole units
 * for counted types (KTD5).
 *
 * Browser shapes (camelCase):
 *   type    { id, name, category, abv, measure: "oz"|"unit", unitOz: number|null }
 *   bottle  { id, typeId, nickname, size, remaining, price (dollars), buyerId, date "YYYY-MM-DD" }
 *   person  { id, name }
 *   menu    { id, name, kind: "cocktail"|"straight"|"counted", ingredients: [{ typeId, amount }] }
 *   source  { bottleId, amount }                      one stock item an ingredient draws from
 *   line    { bottleId, typeId, amount, costCents, shareCents, buyerId, buyerName, abv }
 *   ringUp  { id, nightId, kind: "guest"|"crew", tabId, personId, personName, menuItemName,
 *             priceCents|null, rungAt, voidedAt|null, lines: [line] }
 *   tab     { id, nightId, guestName, status: "open"|"paid"|"written_off",
 *             collectorId, collectorName, amountCents, closedAt }
 *
 * Exported API:
 *   Constants: STANDARD_DRINK_OZ, MEASURE_OZ, MEASURE_UNIT, AMOUNT_EPSILON,
 *              DEFAULT_MARKUP_PERCENT (0), DEFAULT_ROUNDING_INCREMENT_CENTS (25)
 *   normalizeType(type) -> type with numeric abv, measure "oz"|"unit", unitOz number|null
 *   normalizeBottle(bottle) -> bottle with size/remaining (legacy sizeOz/remainingOz mapped and removed)
 *   standardDrinks(ounces, abv) -> number of US standard drinks
 *   measureAmount(type, amount, abvSnapshot?) -> { ounces, standardDrinks }
 *   linesConsumption(lines, types) -> { ounces, standardDrinks } summed over lines
 *   unitCostCents(bottle) -> unrounded cents per one measure (oz or unit)
 *   lineCostCents(bottle, amount) -> unrounded cents
 *   priceCents(costCents, markupPercent, incrementCents) -> integer cents, rounded up once
 *   allocateShares(priceCents, weights[]) -> integer cents[] summing to priceCents
 *   priceRingUp(draftLines[{bottleId, amount}], { bottles, types, people, markupPercent,
 *               roundingIncrementCents, kind? }) -> { costCents, priceCents|null, lines[line] }
 *   menuItemIngredients(menuItem) -> [{ typeId, amount }] (counted = 1 unit, pour = first ingredient)
 *   combinedRemaining(bottles, typeId) -> number
 *   menuItemAvailability(menuItem, bottles) -> { available, shortTypeIds[] }
 *   preselectSources(menuItem, bottles) -> [{ typeId, amount, sources[source], short, available }]
 *   validateSources(ingredient, sources, bottles) -> { ok, errors[] }
 *   validateRingUpSources(menuItem, sourcesPerIngredient[[source]], bottles) -> { ok, errors[] }
 *   stockDeltasForRingUp(lines) -> [{ bottleId, delta (negative) }]
 *   stockDeltasForVoid(lines) -> [{ bottleId, delta (positive) }]
 *   applyStockDeltas(bottles, deltas) -> new bottles array (throws if out of range)
 *   tabTotalCents(tabId, ringUps) -> integer cents of unvoided guest items
 *   summarizeHostNight({ tabs, ringUps }) -> { collectors[{ collectorId, collectorName, totalCents,
 *               byBuyer[{ buyerId, buyerName, cents }] }], writtenOff{ totalCents, byBuyer[] }, openTabCount }
 *   normalizeNight / normalizeMenuItem / normalizeTab / normalizeRingUp / normalizeAdjustment(record)
 *               -> the record with every field present in a fixed order (nulls, numbers, defaults)
 *   normalizeState(input) -> full browser state: people, types, bottles, nights (kind, endedAt, pours,
 *               startedLocally only when true), menuItems, guestTabs, ringUps, stockAdjustments,
 *               activeNightId, responsibleMode, markupPercent, roundingIncrementCents
 *   typeRow(type, hostModeAvailable) -> rnmb_beverage_types row (snake_case)
 *   nightRow(night, hostModeAvailable) -> rnmb_nights row
 *   settingsRow(settings, hostModeAvailable) -> rnmb_settings row
 *   bottleRow(bottle) -> rnmb_bottles row (size/remaining written to size_oz/remaining_oz)
 *
 * The row builders add the host-mode columns (measure, unit_oz, kind, ended_at,
 * markup_percent, rounding_increment_cents) only when hostModeAvailable is literally
 * true, so a database without supabase/host-mode.sql receives today's payloads (KTD8).
 */
var RNMBDomain = (function () {
  "use strict";

  var STANDARD_DRINK_OZ = 0.6;
  var MEASURE_OZ = "oz";
  var MEASURE_UNIT = "unit";
  // Amounts and cents closer than this are equal. Stock is stored to 2 decimals,
  // so this only ever absorbs binary floating-point noise.
  var AMOUNT_EPSILON = 1e-6;
  var DEFAULT_MARKUP_PERCENT = 0;
  var DEFAULT_ROUNDING_INCREMENT_CENTS = 25;

  // ---------- small helpers ----------------------------------------------------

  function round6(value) {
    return Math.round(value * 1e6) / 1e6 + 0; // "+ 0" turns -0 into 0
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function byId(list) {
    var map = new Map();
    (list || []).forEach(function (item) {
      if (item && item.id !== undefined) map.set(item.id, item);
    });
    return map;
  }

  function remainingOf(bottle) {
    return Number(bottle && bottle.remaining) || 0;
  }

  // ---------- normalizers ------------------------------------------------------

  function normalizeType(type) {
    var copy = Object.assign({}, type);
    copy.abv = Number(copy.abv) || 0;
    copy.measure = copy.measure === MEASURE_UNIT ? MEASURE_UNIT : MEASURE_OZ;
    var unitOz = Number(copy.unitOz);
    copy.unitOz = copy.measure === MEASURE_UNIT && Number.isFinite(unitOz) && unitOz > 0 ? unitOz : null;
    return copy;
  }

  function normalizeBottle(bottle) {
    var copy = Object.assign({}, bottle);
    if (copy.size === undefined && copy.sizeOz !== undefined) copy.size = Number(copy.sizeOz);
    if (copy.remaining === undefined && copy.remainingOz !== undefined) copy.remaining = Number(copy.remainingOz);
    delete copy.sizeOz;
    delete copy.remainingOz;
    return copy;
  }

  // ---------- amounts and standard drinks (KTD5) -------------------------------

  function standardDrinks(ounces, abv) {
    return ((Number(ounces) || 0) * ((Number(abv) || 0) / 100)) / STANDARD_DRINK_OZ;
  }

  /** Amount of a type in its measure -> ounces and standard drinks. A provided ABV snapshot wins over the type's current ABV. */
  function measureAmount(type, amount, abvSnapshot) {
    var quantity = Number(amount) || 0;
    var counted = Boolean(type) && type.measure === MEASURE_UNIT;
    var ounces = counted ? quantity * (Number(type.unitOz) || 0) : quantity;
    var hasSnapshot = abvSnapshot !== null && abvSnapshot !== undefined && abvSnapshot !== "" && Number.isFinite(Number(abvSnapshot));
    var abv = hasSnapshot ? Number(abvSnapshot) : Number(type && type.abv) || 0;
    return { ounces: ounces + 0, standardDrinks: standardDrinks(ounces, abv) + 0 };
  }

  function linesConsumption(lines, types) {
    var typeMap = byId(types);
    return (lines || []).reduce(
      function (total, line) {
        var measured = measureAmount(typeMap.get(line.typeId), line.amount, line.abv);
        return { ounces: total.ounces + measured.ounces, standardDrinks: total.standardDrinks + measured.standardDrinks };
      },
      { ounces: 0, standardDrinks: 0 }
    );
  }

  // ---------- cost and price (KTD2) --------------------------------------------

  function unitCostCents(bottle) {
    var size = Number(bottle && bottle.size);
    var price = Number((bottle && bottle.price) || 0);
    if (!Number.isFinite(size) || size <= 0) throw new RangeError("A stock item needs a size above 0 to be costed.");
    if (!Number.isFinite(price) || price < 0) throw new RangeError("A stock item's purchase price cannot be negative.");
    // Purchase prices are stored to the cent; rounding here keeps e.g. $0.07 from becoming 7.000000000000001.
    return Math.round(price * 100) / size;
  }

  function lineCostCents(bottle, amount) {
    return unitCostCents(bottle) * Number(amount);
  }

  /** Unrounded cost -> markup -> round UP to the increment, once. An exact multiple (within floating noise) stays put. */
  function priceCents(costCents, markupPercent, incrementCents) {
    if (!isFiniteNumber(incrementCents) || !Number.isInteger(incrementCents) || incrementCents <= 0) {
      throw new RangeError("The rounding increment must be a whole number of cents above 0.");
    }
    if (!isFiniteNumber(markupPercent) || markupPercent < 0) {
      throw new RangeError("The markup must be a percentage of 0 or more.");
    }
    if (!isFiniteNumber(costCents) || costCents < 0) {
      throw new RangeError("A cost must be a finite amount of 0 or more.");
    }
    var marked = (costCents * (100 + markupPercent)) / 100;
    var steps = marked / incrementCents;
    var nearest = Math.round(steps);
    if (Math.abs(marked - nearest * incrementCents) <= AMOUNT_EPSILON) return nearest * incrementCents;
    return Math.ceil(steps) * incrementCents;
  }

  /** Largest-remainder split of integer cents in proportion to weights. Ties go to the earlier line; zero weights get 0. */
  function allocateShares(totalCents, weights) {
    if (!isFiniteNumber(totalCents) || !Number.isInteger(totalCents) || totalCents < 0) {
      throw new RangeError("A price to share must be a whole number of cents, 0 or more.");
    }
    var list = weights || [];
    list.forEach(function (weight) {
      if (!isFiniteNumber(weight) || weight < 0) throw new RangeError("Share weights must be finite and 0 or more.");
    });
    if (totalCents === 0) return list.map(function () { return 0; });
    var totalWeight = list.reduce(function (sum, weight) { return sum + weight; }, 0);
    if (!(totalWeight > 0)) throw new RangeError("A non-zero price cannot be shared across lines that cost nothing.");

    var shares = [];
    var fractions = [];
    var allocated = 0;
    list.forEach(function (weight, index) {
      var quota = (totalCents * weight) / totalWeight;
      var floor = Math.floor(quota + 1e-9);
      shares.push(floor);
      fractions.push({ index: index, fraction: Math.max(0, quota - floor), positive: weight > 0 });
      allocated += floor;
    });

    var order = fractions
      .filter(function (entry) { return entry.positive; })
      .sort(function (a, b) {
        if (Math.abs(a.fraction - b.fraction) > 1e-9) return b.fraction - a.fraction;
        return a.index - b.index;
      });
    var remainder = totalCents - allocated;
    for (var i = 0; remainder > 0; i += 1, remainder -= 1) shares[order[i % order.length].index] += 1;
    // Only reachable through float noise pushing several floors up; take back from the smallest fractions.
    for (var j = order.length - 1; remainder < 0; j = (j - 1 + order.length) % order.length) {
      if (shares[order[j].index] > 0) {
        shares[order[j].index] -= 1;
        remainder += 1;
      }
    }
    return shares;
  }

  /** Cost, price and cent shares for the chosen sources. Crew ring-ups (kind "crew") carry no price and no shares. */
  function priceRingUp(draftLines, context) {
    var ctx = context || {};
    var lines = draftLines || [];
    if (lines.length === 0) throw new Error("A ring-up needs at least one ingredient line.");
    var bottleMap = byId(ctx.bottles);
    var typeMap = byId(ctx.types);
    var peopleMap = byId(ctx.people);

    var priced = lines.map(function (draft) {
      var amount = Number(draft.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new RangeError("Every ingredient amount must be above 0.");
      var raw = bottleMap.get(draft.bottleId);
      if (!raw) throw new Error("Unknown stock item: " + draft.bottleId);
      var bottle = normalizeBottle(raw);
      var type = typeMap.get(bottle.typeId);
      var buyer = bottle.buyerId ? peopleMap.get(bottle.buyerId) : undefined;
      return {
        bottleId: bottle.id,
        typeId: bottle.typeId,
        amount: amount,
        costCents: lineCostCents(bottle, amount),
        shareCents: null,
        buyerId: buyer ? buyer.id : null,
        buyerName: buyer ? buyer.name : "",
        abv: type ? Number(type.abv) || 0 : 0
      };
    });

    var costCents = priced.reduce(function (sum, line) { return sum + line.costCents; }, 0);
    if (ctx.kind === "crew") return { costCents: costCents, priceCents: null, lines: priced };

    var markup = ctx.markupPercent === undefined || ctx.markupPercent === null ? DEFAULT_MARKUP_PERCENT : Number(ctx.markupPercent);
    var increment =
      ctx.roundingIncrementCents === undefined || ctx.roundingIncrementCents === null
        ? DEFAULT_ROUNDING_INCREMENT_CENTS
        : Number(ctx.roundingIncrementCents);
    var price = priceCents(costCents, markup, increment);
    var shares = allocateShares(price, priced.map(function (line) { return line.costCents; }));
    priced.forEach(function (line, index) { line.shareCents = shares[index]; });
    return { costCents: costCents, priceCents: price, lines: priced };
  }

  // ---------- availability and preselection (2.6.5, KTD10) ---------------------

  function menuItemIngredients(menuItem) {
    var ingredients = (menuItem && menuItem.ingredients) || [];
    var mapped = ingredients.map(function (ingredient) {
      return { typeId: ingredient.typeId, amount: Number(ingredient.amount) };
    });
    if (!menuItem) return [];
    if (menuItem.kind === "counted") return mapped.slice(0, 1).map(function (i) { return { typeId: i.typeId, amount: 1 }; });
    if (menuItem.kind === "straight") return mapped.slice(0, 1);
    return mapped;
  }

  function combinedRemaining(bottles, typeId) {
    return round6(
      (bottles || []).reduce(function (sum, bottle) {
        return bottle && bottle.typeId === typeId ? sum + Math.max(0, remainingOf(bottle)) : sum;
      }, 0)
    );
  }

  function menuItemAvailability(menuItem, bottles) {
    var ingredients = menuItemIngredients(menuItem);
    if (ingredients.length === 0) return { available: false, shortTypeIds: [] };
    var needed = new Map();
    ingredients.forEach(function (ingredient) {
      needed.set(ingredient.typeId, (needed.get(ingredient.typeId) || 0) + ingredient.amount);
    });
    var shortTypeIds = [];
    needed.forEach(function (amount, typeId) {
      if (combinedRemaining(bottles, typeId) + AMOUNT_EPSILON < amount) shortTypeIds.push(typeId);
    });
    return { available: shortTypeIds.length === 0, shortTypeIds: shortTypeIds };
  }

  function candidatesFor(bottles, typeId) {
    return (bottles || [])
      .filter(function (bottle) { return bottle && bottle.typeId === typeId && remainingOf(bottle) > AMOUNT_EPSILON; })
      .map(function (bottle, index) { return { bottle: bottle, index: index }; })
      .sort(function (a, b) {
        var diff = remainingOf(a.bottle) - remainingOf(b.bottle);
        if (Math.abs(diff) > AMOUNT_EPSILON) return diff;
        var dateA = a.bottle.date || "￿";
        var dateB = b.bottle.date || "￿";
        if (dateA !== dateB) return dateA < dateB ? -1 : 1;
        return a.index - b.index;
      })
      .map(function (entry) { return entry.bottle; });
  }

  /**
   * Per ingredient: the least-remaining item that alone covers the amount (ties: earliest purchase).
   * If only the combined stock covers it, the least-remaining item with all it holds, marked short.
   * If even the combined stock cannot, no sources and available false.
   */
  function preselectSources(menuItem, bottles) {
    return menuItemIngredients(menuItem).map(function (ingredient) {
      var candidates = candidatesFor(bottles, ingredient.typeId);
      var covering = candidates.find(function (bottle) { return remainingOf(bottle) + AMOUNT_EPSILON >= ingredient.amount; });
      var result = { typeId: ingredient.typeId, amount: ingredient.amount, sources: [], short: false, available: false };
      if (covering) {
        result.sources = [{ bottleId: covering.id, amount: ingredient.amount }];
        result.available = true;
      } else if (candidates.length && combinedRemaining(candidates, ingredient.typeId) + AMOUNT_EPSILON >= ingredient.amount) {
        result.sources = [{ bottleId: candidates[0].id, amount: round6(Math.min(remainingOf(candidates[0]), ingredient.amount)) }];
        result.short = true;
        result.available = true;
      }
      return result;
    });
  }

  // ---------- split validation (1.7.7) -----------------------------------------

  function validateSources(ingredient, sources, bottles) {
    var errors = [];
    var list = sources || [];
    var bottleMap = byId(bottles);
    if (list.length === 0) errors.push("Choose at least one stock item for this ingredient.");
    var seen = new Set();
    var total = 0;
    list.forEach(function (source) {
      var amount = Number(source.amount);
      var bottle = bottleMap.get(source.bottleId);
      if (seen.has(source.bottleId)) errors.push("A stock item is listed more than once for this ingredient.");
      seen.add(source.bottleId);
      if (!Number.isFinite(amount) || amount <= 0) {
        errors.push("Each amount must be above 0.");
        return;
      }
      total += amount;
      if (!bottle) {
        errors.push("Unknown stock item: " + source.bottleId);
        return;
      }
      if (bottle.typeId !== ingredient.typeId) errors.push("A chosen stock item is not the ingredient's type.");
      if (amount > remainingOf(bottle) + AMOUNT_EPSILON) errors.push("An amount is more than that stock item has remaining.");
    });
    if (list.length && Math.abs(total - Number(ingredient.amount)) > AMOUNT_EPSILON) {
      errors.push("Amounts total " + round6(total) + " but the recipe needs " + Number(ingredient.amount) + ".");
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function validateRingUpSources(menuItem, sourcesPerIngredient, bottles) {
    var ingredients = menuItemIngredients(menuItem);
    var perIngredient = sourcesPerIngredient || [];
    var errors = [];
    if (ingredients.length === 0) errors.push("This menu item has no ingredients.");
    if (perIngredient.length !== ingredients.length) errors.push("Every ingredient needs its stock items chosen.");
    var drawn = new Map();
    ingredients.forEach(function (ingredient, index) {
      var sources = perIngredient[index] || [];
      validateSources(ingredient, sources, bottles).errors.forEach(function (error) { errors.push(error); });
      sources.forEach(function (source) {
        var amount = Number(source.amount);
        if (Number.isFinite(amount) && amount > 0) drawn.set(source.bottleId, (drawn.get(source.bottleId) || 0) + amount);
      });
    });
    var bottleMap = byId(bottles);
    drawn.forEach(function (amount, bottleId) {
      var bottle = bottleMap.get(bottleId);
      if (bottle && amount > remainingOf(bottle) + AMOUNT_EPSILON) {
        errors.push("Together the ingredients draw more than a stock item has remaining.");
      }
    });
    errors = errors.filter(function (error, index) { return errors.indexOf(error) === index; });
    return { ok: errors.length === 0, errors: errors };
  }

  // ---------- stock deltas (1.3.3) ---------------------------------------------

  function totalsByBottle(lines) {
    var totals = new Map();
    (lines || []).forEach(function (line) {
      totals.set(line.bottleId, (totals.get(line.bottleId) || 0) + Number(line.amount || 0));
    });
    return totals;
  }

  function stockDeltasForRingUp(lines) {
    var deltas = [];
    totalsByBottle(lines).forEach(function (amount, bottleId) {
      deltas.push({ bottleId: bottleId, delta: round6(-amount) });
    });
    return deltas;
  }

  function stockDeltasForVoid(lines) {
    var deltas = [];
    totalsByBottle(lines).forEach(function (amount, bottleId) {
      deltas.push({ bottleId: bottleId, delta: round6(amount) });
    });
    return deltas;
  }

  /** Returns a new bottles array; untouched bottles are returned as-is. Bottles must use size/remaining. */
  function applyStockDeltas(bottles, deltas) {
    var change = new Map();
    var known = new Set((bottles || []).map(function (bottle) { return bottle.id; }));
    (deltas || []).forEach(function (entry) {
      if (!known.has(entry.bottleId)) throw new Error("Unknown stock item: " + entry.bottleId);
      change.set(entry.bottleId, (change.get(entry.bottleId) || 0) + Number(entry.delta));
    });
    return (bottles || []).map(function (bottle) {
      if (!change.has(bottle.id)) return bottle;
      var next = remainingOf(bottle) + change.get(bottle.id);
      var size = Number(bottle.size);
      if (next < -AMOUNT_EPSILON) throw new RangeError("Not enough remaining in stock item " + bottle.id + ".");
      if (Number.isFinite(size) && next > size + AMOUNT_EPSILON) {
        throw new RangeError("Stock item " + bottle.id + " would hold more than its size.");
      }
      next = Math.max(0, next);
      if (Number.isFinite(size)) next = Math.min(size, next);
      return Object.assign({}, bottle, { remaining: round6(next) });
    });
  }

  // ---------- tabs and the host-night summary (2.8.5, 2.8.6) -------------------

  function isLiveGuestItem(ringUp) {
    return Boolean(ringUp) && ringUp.kind !== "crew" && !ringUp.voidedAt;
  }

  function tabTotalCents(tabId, ringUps) {
    return (ringUps || []).reduce(function (sum, ringUp) {
      return isLiveGuestItem(ringUp) && ringUp.tabId === tabId ? sum + (Number(ringUp.priceCents) || 0) : sum;
    }, 0);
  }

  function addToBuyer(group, line) {
    var cents = Number(line.shareCents) || 0;
    var key = line.buyerId ? "id:" + line.buyerId : "name:" + (line.buyerName || "");
    var entry = group.index.get(key);
    if (!entry) {
      entry = { buyerId: line.buyerId || null, buyerName: line.buyerName || "", cents: 0 };
      group.index.set(key, entry);
      group.byBuyer.push(entry);
    }
    entry.cents += cents;
    group.totalCents += cents;
  }

  function summarizeHostNight(input) {
    var tabs = (input && input.tabs) || [];
    var ringUps = (input && input.ringUps) || [];
    var tabMap = byId(tabs);
    var collectors = [];
    var collectorIndex = new Map();
    var writtenOff = { totalCents: 0, byBuyer: [], index: new Map() };

    function collectorFor(tab) {
      var key = tab.collectorId ? "id:" + tab.collectorId : "name:" + (tab.collectorName || "");
      var group = collectorIndex.get(key);
      if (!group) {
        group = { collectorId: tab.collectorId || null, collectorName: tab.collectorName || "", totalCents: 0, byBuyer: [], index: new Map() };
        collectorIndex.set(key, group);
        collectors.push(group);
      }
      return group;
    }

    tabs.forEach(function (tab) {
      if (tab.status === "paid") collectorFor(tab);
    });
    ringUps.forEach(function (ringUp) {
      if (!isLiveGuestItem(ringUp)) return;
      var tab = tabMap.get(ringUp.tabId);
      if (!tab) return;
      var group = tab.status === "paid" ? collectorFor(tab) : tab.status === "written_off" ? writtenOff : null;
      if (!group) return;
      (ringUp.lines || []).forEach(function (line) { addToBuyer(group, line); });
    });

    return {
      collectors: collectors.map(function (group) {
        return { collectorId: group.collectorId, collectorName: group.collectorName, totalCents: group.totalCents, byBuyer: group.byBuyer };
      }),
      writtenOff: { totalCents: writtenOff.totalCents, byBuyer: writtenOff.byBuyer },
      openTabCount: tabs.filter(function (tab) { return tab.status === "open"; }).length
    };
  }

  // ---------- whole-state normalizer (archives, localStorage, database loads) ---

  var MENU_KINDS = ["cocktail", "straight", "counted"];
  var TAB_STATUSES = ["open", "paid", "written_off"];

  function listOf(value) {
    return Array.isArray(value) ? value : [];
  }

  function orNull(value) {
    return value === undefined || value === null || value === "" ? null : value;
  }

  function numberOrNull(value) {
    if (value === undefined || value === null || value === "") return null;
    var number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function numberOrZero(value) {
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  /** startedLocally is a browser-only mark (KTD9): kept only when literally true, never sent to the database. */
  function normalizeNight(night) {
    var source = night || {};
    var kind = source.kind === "host" ? "host" : "crew";
    var result = {
      id: source.id,
      name: source.name,
      date: source.date,
      kind: kind,
      endedAt: kind === "host" ? orNull(source.endedAt) : null,
      pours: listOf(source.pours)
    };
    if (source.startedLocally === true) result.startedLocally = true;
    return result;
  }

  function normalizeMenuItem(menuItem) {
    var source = menuItem || {};
    return {
      id: source.id,
      name: source.name,
      kind: MENU_KINDS.indexOf(source.kind) >= 0 ? source.kind : "cocktail",
      ingredients: listOf(source.ingredients).map(function (ingredient) {
        return { id: orNull(ingredient.id), typeId: ingredient.typeId, amount: numberOrZero(ingredient.amount) };
      })
    };
  }

  function normalizeTab(tab) {
    var source = tab || {};
    return {
      id: source.id,
      nightId: source.nightId,
      guestName: source.guestName,
      status: TAB_STATUSES.indexOf(source.status) >= 0 ? source.status : "open",
      collectorId: orNull(source.collectorId),
      collectorName: orNull(source.collectorName),
      amountCents: numberOrNull(source.amountCents),
      openedAt: orNull(source.openedAt),
      closedAt: orNull(source.closedAt)
    };
  }

  function normalizeLine(line) {
    var source = line || {};
    return {
      id: orNull(source.id),
      bottleId: source.bottleId,
      typeId: source.typeId,
      amount: numberOrZero(source.amount),
      costCents: numberOrZero(source.costCents),
      shareCents: numberOrNull(source.shareCents),
      buyerId: orNull(source.buyerId),
      buyerName: source.buyerName || "",
      abv: numberOrZero(source.abv)
    };
  }

  function normalizeRingUp(ringUp) {
    var source = ringUp || {};
    return {
      id: source.id,
      nightId: source.nightId,
      kind: source.kind === "crew" ? "crew" : "guest",
      tabId: orNull(source.tabId),
      personId: orNull(source.personId),
      personName: orNull(source.personName),
      menuItemId: orNull(source.menuItemId),
      menuItemName: source.menuItemName || "",
      priceCents: numberOrNull(source.priceCents),
      rungAt: orNull(source.rungAt),
      voidedAt: orNull(source.voidedAt),
      lines: listOf(source.lines).map(normalizeLine)
    };
  }

  function normalizeAdjustment(adjustment) {
    var source = adjustment || {};
    return {
      id: source.id,
      bottleId: source.bottleId,
      previousRemaining: numberOrZero(source.previousRemaining),
      newRemaining: numberOrZero(source.newRemaining),
      adjustedAt: orNull(source.adjustedAt)
    };
  }

  /** Any archive, localStorage copy or database load -> the full browser state, host-mode collections included. */
  function normalizeState(input) {
    var source = input || {};
    var nights = listOf(source.nights).map(normalizeNight);
    var markup = Number(source.markupPercent);
    var increment = Number(source.roundingIncrementCents);
    return {
      people: listOf(source.people),
      types: listOf(source.types).map(normalizeType),
      bottles: listOf(source.bottles).map(normalizeBottle),
      nights: nights,
      menuItems: listOf(source.menuItems).map(normalizeMenuItem),
      guestTabs: listOf(source.guestTabs).map(normalizeTab),
      ringUps: listOf(source.ringUps).map(normalizeRingUp),
      stockAdjustments: listOf(source.stockAdjustments).map(normalizeAdjustment),
      activeNightId: source.activeNightId || (nights[0] && nights[0].id) || "",
      responsibleMode: source.responsibleMode !== false,
      markupPercent:
        source.markupPercent !== undefined && source.markupPercent !== null && Number.isFinite(markup) && markup >= 0
          ? markup
          : DEFAULT_MARKUP_PERCENT,
      roundingIncrementCents: Number.isInteger(increment) && increment > 0 ? increment : DEFAULT_ROUNDING_INCREMENT_CENTS
    };
  }

  // ---------- payload builders for existing tables (KTD8) ----------------------

  function typeRow(type, hostModeAvailable) {
    var row = { id: type.id, name: type.name, category: type.category, abv: type.abv };
    if (hostModeAvailable === true) {
      var normalized = normalizeType(type);
      row.measure = normalized.measure;
      row.unit_oz = normalized.unitOz;
    }
    return row;
  }

  function nightRow(night, hostModeAvailable) {
    var row = { id: night.id, name: night.name, date: night.date };
    if (hostModeAvailable === true) {
      row.kind = night.kind || "crew";
      row.ended_at = night.endedAt || null;
    }
    return row;
  }

  function settingsRow(settings, hostModeAvailable) {
    var source = settings || {};
    var row = {
      id: true,
      active_night_id: source.activeNightId || null,
      responsible_mode: source.responsibleMode !== false
    };
    if (hostModeAvailable === true) {
      var markup = Number(source.markupPercent);
      var increment = Number(source.roundingIncrementCents);
      row.markup_percent = source.markupPercent !== undefined && Number.isFinite(markup) && markup >= 0 ? markup : DEFAULT_MARKUP_PERCENT;
      row.rounding_increment_cents =
        source.roundingIncrementCents !== undefined && Number.isInteger(increment) && increment > 0
          ? increment
          : DEFAULT_ROUNDING_INCREMENT_CENTS;
    }
    return row;
  }

  function bottleRow(bottle) {
    var normalized = normalizeBottle(bottle);
    return {
      id: normalized.id,
      type_id: normalized.typeId,
      nickname: normalized.nickname || null,
      size_oz: normalized.size,
      remaining_oz: normalized.remaining,
      price: normalized.price,
      buyer_id: normalized.buyerId || null,
      purchase_date: normalized.date
    };
  }

  return Object.freeze({
    STANDARD_DRINK_OZ: STANDARD_DRINK_OZ,
    MEASURE_OZ: MEASURE_OZ,
    MEASURE_UNIT: MEASURE_UNIT,
    AMOUNT_EPSILON: AMOUNT_EPSILON,
    DEFAULT_MARKUP_PERCENT: DEFAULT_MARKUP_PERCENT,
    DEFAULT_ROUNDING_INCREMENT_CENTS: DEFAULT_ROUNDING_INCREMENT_CENTS,
    normalizeType: normalizeType,
    normalizeBottle: normalizeBottle,
    standardDrinks: standardDrinks,
    measureAmount: measureAmount,
    linesConsumption: linesConsumption,
    unitCostCents: unitCostCents,
    lineCostCents: lineCostCents,
    priceCents: priceCents,
    allocateShares: allocateShares,
    priceRingUp: priceRingUp,
    menuItemIngredients: menuItemIngredients,
    combinedRemaining: combinedRemaining,
    menuItemAvailability: menuItemAvailability,
    preselectSources: preselectSources,
    validateSources: validateSources,
    validateRingUpSources: validateRingUpSources,
    stockDeltasForRingUp: stockDeltasForRingUp,
    stockDeltasForVoid: stockDeltasForVoid,
    applyStockDeltas: applyStockDeltas,
    tabTotalCents: tabTotalCents,
    summarizeHostNight: summarizeHostNight,
    normalizeNight: normalizeNight,
    normalizeMenuItem: normalizeMenuItem,
    normalizeTab: normalizeTab,
    normalizeRingUp: normalizeRingUp,
    normalizeAdjustment: normalizeAdjustment,
    normalizeState: normalizeState,
    typeRow: typeRow,
    nightRow: nightRow,
    settingsRow: settingsRow,
    bottleRow: bottleRow
  });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = RNMBDomain;
}
