/*
 * domain.js — pure money and stock arithmetic for RNMB Command Center host mode
 * and the crew running balance.
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
 *             collectorId, collectorName, amountCents, writtenOffBy|null, writtenOffByName|null,
 *             openedAt, closedAt }
 *             writtenOffBy/writtenOffByName: the crew member who wrote the tab off (null before
 *             supabase/crew-balance.sql and on open or paid tabs)
 *   pour    { id, personId, bottleId, ounces (amount in the type's measure), abv, timestamp,
 *             costCents|null, buyerId|null, buyerName|null }   a crew pour, inside night.pours
 *             costCents is WHOLE cents stamped at pour time (pourCostCents) with the bottle's buyer
 *             snapshot; null on pours logged before cost stamping, which move no money
 *   payment { id, fromPersonId, fromName, toPersonId, toName, amountCents (whole, > 0),
 *             paidAt, voidedAt|null }                  crew member to crew member; soft-voided only
 *   balance { personId|null, name, cents }             + = is owed, - = owes
 *   suggestedPayment { fromPersonId|null, fromName, toPersonId|null, toName, amountCents }
 *
 * Crew balances (KTD1-KTD4) are derived on every read and never stored; every money
 * movement is a pair of equal and opposite whole-cent amounts, so they sum to zero.
 *
 * Exported API:
 *   Constants: STANDARD_DRINK_OZ, MEASURE_OZ, MEASURE_UNIT, AMOUNT_EPSILON,
 *              DEFAULT_MARKUP_PERCENT (0), DEFAULT_ROUNDING_INCREMENT_CENTS (25)
 *   normalizeType(type) -> type with numeric abv, measure "oz"|"unit", unitOz number|null
 *   normalizeBottle(bottle) -> bottle with size/remaining (legacy sizeOz/remainingOz mapped and removed)
 *   round6(value) -> value rounded to 6 decimals, with -0 as 0 (collapses float noise on amounts)
 *   standardDrinks(ounces, abv) -> number of US standard drinks
 *   measureAmount(type, amount, abvSnapshot?) -> { ounces, standardDrinks }
 *   linesConsumption(lines, types) -> { ounces, standardDrinks } summed over lines
 *   unitCostCents(bottle) -> unrounded cents per one measure (oz or unit)
 *   lineCostCents(bottle, amount) -> unrounded cents
 *   priceCents(costCents, markupPercent, incrementCents) -> integer cents, rounded up once
 *   allocateShares(priceCents, weights[]) -> integer cents[] summing to priceCents
 *   priceRingUp(draftLines[{bottleId, amount}], { bottles, types, people, markupPercent,
 *               roundingIncrementCents, kind? }) -> { costCents, priceCents|null, lines[line] }
 *   menuItemIngredients(menuItem) -> [{ typeId, amount }] (counted = 1 unit, straight = first ingredient)
 *   combinedRemaining(bottles, typeId) -> number
 *   menuItemAvailability(menuItem, bottles) -> { available, shortTypeIds[] }
 *   preselectSources(menuItem, bottles) -> [{ typeId, amount, sources[source], short, available }]
 *   quoteMenuItem(menuItem, { bottles, types, people, markupPercent, roundingIncrementCents })
 *               -> { available, shortTypeIds[], ingredients[{ typeId, amount, sources[source], short }],
 *                    sources[source], costCents|null, priceCents|null } (the price if rung up now)
 *   validateSources(ingredient, sources, bottles) -> { ok, errors[] }
 *   validateRingUpSources(menuItem, sourcesPerIngredient[[source]], bottles) -> { ok, errors[] }
 *   flattenSources(sourcesPerIngredient[[source]]) -> [source] in recipe order (amounts numeric)
 *   sourcesShortfall(ingredient, sources) -> amount still uncovered (0 when covered or over)
 *   suggestExtraSource(ingredient, sources, bottles) -> source | null (next unused item, shortfall capped)
 *   switchSource(ingredient, sources, index, bottleId, bottles) -> new sources (a lone source takes the recipe amount, capped)
 *   stockDeltasForRingUp(lines) -> [{ bottleId, delta (negative) }]
 *   stockDeltasForVoid(lines) -> [{ bottleId, delta (positive) }]
 *   applyStockDeltas(bottles, deltas) -> new bottles array (throws if out of range)
 *   tabTotalCents(tabId, ringUps) -> integer cents of unvoided guest items
 *   summarizeHostNight({ tabs, ringUps }) -> { collectors[{ collectorId, collectorName, totalCents,
 *               byBuyer[{ buyerId, buyerName, cents }] }], writtenOff{ totalCents, byBuyer[] }, openTabCount }
 *   crewConsumption(ringUps, types, nightId?) -> { ounces, standardDrinks, count, byPerson[{ personId, personName,
 *               ounces, standardDrinks, count }] } over unvoided crew ring-ups (guest ring-ups never count)
 *   pourCostCents(bottle, amount) -> whole cents: unitCostCents x amount rounded half-up once (throws on
 *               a negative or non-numeric amount, or a bottle that cannot be costed)
 *   ringUpCostCents(lines[{ costCents }]) -> { totalCents (unrounded total rounded half-up once),
 *               lineCents[] (allocateShares of the total by line cost; sums to totalCents) }
 *   crewBalances(state) -> [balance]: roster people in roster order (0 included), then anyone no longer
 *               on the roster with a non-zero balance, by name then id, under their snapshot name.
 *               crew pours: drinker -costCents, buyer +costCents; unvoided crew ring-ups: person -total,
 *               line buyers +lineCents; paid tabs: line buyers +shareCents, collector - the same (=
 *               amountCents); written-off tabs: writtenOffBy -each unvoided ring-up's total, buyers
 *               +lineCents; unvoided payments: from +amountCents, to -amountCents. A movement where
 *               either side names nobody (no id and no name) moves nothing; stock adjustments never do.
 *   suggestPayments(balances) -> [suggestedPayment]: the fewest payments (exact, up to 10 non-zero
 *               balances; largest debtor to largest creditor above that); order-independent, ties by
 *               name then id
 *   crewDrinkCostCents(lines) -> whole cents a crew drink (or a written-off guest drink) charges: the owned
 *               lines' cost rounded half-up once, exactly what crewBalances debits
 *   balanceChangesOnRemoval(state, personId) -> [{ personId, name, beforeCents, afterCents }]: everyone else
 *               whose balance would move if that person were deleted (their pours cascade, other references
 *               are set null and keep their name snapshots); includes parties already off the roster,
 *               matched by name snapshot with personId null
 *   parseVolumeOunces(value) -> fluid ounces for a typed volume, to 2dp: a bare number is already
 *               ounces ("1.5"), or name the unit and it converts ("750 ml", "1.5 fl oz", "3cl", "1 L").
 *               null for anything else, including a negative, so a caller can tell empty from wrong
 *   dollarsToCents(value) -> whole cents for a typed dollar amount ("3.20", "$12", ".5"), else null
 *   quickLogAmount(type) -> 1.5 (oz) for poured stock, 1 (unit) for counted stock
 *   nightRecap(state, nightId) -> [{ personId, name, drinks, ounces, standardDrinks, costCents }]: one night's
 *               crew pours and unvoided crew ring-ups grouped by drinker, oldest first, each drink
 *               { kind: "pour"|"ringUp", id, bottleId, typeId, menuItemId, name, amount, ounces, standardDrinks,
 *               costCents (null = charges nobody), at }; roster order first, then anyone removed since
 *   crewDrinksOnNight(state, nightId) -> [{ kind, id, name, personId, personName, costCents, ... }]: the same
 *               drinks nightRecap groups, flattened and newest first, each carrying the drinker. A host night
 *               holds these alongside its guest tabs, and they stay correctable after it ends
 *   recentLogItems(state, personId, limit = 8) -> [{ kind: "bottle"|"menu", id }]: the distinct stock items a
 *               person poured and menu items they had as unvoided crew ring-ups, newest first
 *   normalizeNight / normalizeMenuItem / normalizeTab / normalizeRingUp / normalizeAdjustment /
 *   normalizePayment(record) -> the record with every field present in a fixed order (nulls, numbers, defaults)
 *   normalizePour(pour) -> the pour with costCents (number|null), buyerId and buyerName (null when absent)
 *   normalizeState(input) -> full browser state: people, types, bottles, nights (kind, endedAt on both kinds, pours
 *               normalized, startedLocally only when true), menuItems, guestTabs, ringUps,
 *               stockAdjustments, payments, activeNightId, responsibleMode, markupPercent,
 *               roundingIncrementCents
 *   typeRow(type, hostModeAvailable) -> rnmb_beverage_types row (snake_case)
 *   nightRow(night, hostModeAvailable) -> rnmb_nights row
 *   settingsRow(settings, hostModeAvailable) -> rnmb_settings row
 *   bottleRow(bottle) -> rnmb_bottles row (size/remaining written to size_oz/remaining_oz)
 *   pourRow(pour, nightId, crewBalanceAvailable) -> rnmb_pours row; cost_cents, buyer_id, buyer_name
 *               only when crewBalanceAvailable === true
 *   paymentRow(payment) -> rnmb_payments row
 *   stampPour(pour, bottle, people) -> copy of the pour with costCents (pourCostCents of pour.ounces),
 *               buyerId and buyerName (null unless the bottle's buyer is on the roster)
 *   hasCrewBalanceRecords(state) -> true when state holds payments, cost-stamped pours, write-off
 *               authors or an ended crew night (records a pre-crew-balance database cannot keep)
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
  function preselectIngredient(ingredient, bottles) {
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
  }

  function preselectSources(menuItem, bottles) {
    return menuItemIngredients(menuItem).map(function (ingredient) {
      return preselectIngredient(ingredient, bottles);
    });
  }

  /**
   * The price a menu item would ring up at now, for the Menu tab (2.6.3, 2.6.5).
   * Unavailable items get no sources and a null price. Otherwise each ingredient
   * uses preselectSources' pick; a short ingredient then draws the rest from the
   * next items of its type in preselection order, so the price is one the register
   * could really charge. Ingredients are sourced in recipe order against the stock
   * the earlier ones left, so a type used twice never counts the same ounces twice.
   * context: { bottles, types, people, markupPercent, roundingIncrementCents }.
   */
  function quoteMenuItem(menuItem, context) {
    var ctx = context || {};
    var availability = menuItemAvailability(menuItem, ctx.bottles);
    var unavailable = {
      available: false,
      shortTypeIds: availability.shortTypeIds,
      ingredients: [],
      sources: [],
      costCents: null,
      priceCents: null
    };
    if (!availability.available) return unavailable;

    var working = (ctx.bottles || []).map(function (bottle) { return Object.assign({}, bottle); });
    var workingById = byId(working);
    var ingredients = [];
    var covered = menuItemIngredients(menuItem).every(function (ingredient) {
      var pick = preselectIngredient(ingredient, working);
      if (!pick.available) return false;
      var sources = pick.sources.slice();
      if (pick.short) {
        var left = round6(ingredient.amount - sources[0].amount);
        candidatesFor(working, ingredient.typeId).forEach(function (bottle) {
          if (left <= AMOUNT_EPSILON || bottle.id === sources[0].bottleId) return;
          var take = round6(Math.min(remainingOf(bottle), left));
          sources.push({ bottleId: bottle.id, amount: take });
          left = round6(left - take);
        });
        if (left > AMOUNT_EPSILON) return false;
      }
      sources.forEach(function (source) {
        var bottle = workingById.get(source.bottleId);
        bottle.remaining = round6(remainingOf(bottle) - source.amount);
      });
      ingredients.push({ typeId: ingredient.typeId, amount: ingredient.amount, sources: sources, short: pick.short });
      return true;
    });
    if (!covered) return unavailable;

    var flat = [];
    ingredients.forEach(function (ingredient) {
      ingredient.sources.forEach(function (source) { flat.push(source); });
    });
    var priced = priceRingUp(flat, {
      bottles: ctx.bottles,
      types: ctx.types,
      people: ctx.people,
      markupPercent: ctx.markupPercent,
      roundingIncrementCents: ctx.roundingIncrementCents
    });
    return {
      available: true,
      shortTypeIds: [],
      ingredients: ingredients,
      sources: flat,
      costCents: priced.costCents,
      priceCents: priced.priceCents
    };
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

  // ---------- register draft helpers (1.7.3, 1.7.7) ----------------------------

  /** The register draft keeps sources per ingredient; a ring-up takes them as one list, in recipe order. */
  function flattenSources(sourcesPerIngredient) {
    var flat = [];
    (sourcesPerIngredient || []).forEach(function (sources) {
      (sources || []).forEach(function (source) {
        flat.push({ bottleId: source.bottleId, amount: Number(source.amount) });
      });
    });
    return flat;
  }

  /** How much of the recipe amount the sources leave uncovered: 0 when covered or over. Bad amounts count as nothing. */
  function sourcesShortfall(ingredient, sources) {
    var total = (sources || []).reduce(function (sum, source) {
      var amount = Number(source && source.amount);
      return Number.isFinite(amount) && amount > 0 ? sum + amount : sum;
    }, 0);
    var left = round6(Number(ingredient && ingredient.amount) - total);
    return left > AMOUNT_EPSILON ? left : 0;
  }

  /**
   * The source the register's "add a bottle" control offers: the first item of the
   * ingredient's type, in preselection order, that the sources do not already use,
   * with the shortfall or all it holds if that is less (0 when nothing is short).
   * null when no other item of the type has stock. Never applied without a tap (KTD10).
   */
  function suggestExtraSource(ingredient, sources, bottles) {
    var used = new Set((sources || []).map(function (source) { return source.bottleId; }));
    var next = candidatesFor(bottles, ingredient.typeId).find(function (bottle) { return !used.has(bottle.id); });
    if (!next) return null;
    return { bottleId: next.id, amount: round6(Math.min(remainingOf(next), sourcesShortfall(ingredient, sources))) };
  }

  /**
   * Point source `index` at another stock item; returns a new list. A lone source
   * takes the recipe amount, capped at what the new item holds, so switching a short
   * pick to a fuller bottle covers the drink; one of several keeps the amount typed.
   */
  function switchSource(ingredient, sources, index, bottleId, bottles) {
    var list = (sources || []).map(function (source) { return { bottleId: source.bottleId, amount: source.amount }; });
    if (!list[index]) return list;
    var bottle = byId(bottles).get(bottleId);
    list[index].bottleId = bottleId;
    if (list.length === 1) {
      var amount = Number(ingredient.amount);
      list[index].amount = bottle ? round6(Math.min(amount, Math.max(0, remainingOf(bottle)))) : amount;
    }
    return list;
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

  // ---------- crew consumption from the register (0.4.1, KTD4) -----------------

  /**
   * A crew ring-up is a crew pour: every unvoided one counts toward that person's
   * consumption, measured through linesConsumption. Guest ring-ups never count.
   * nightId limits it to one night; leave it out to count every night. A person
   * removed since keeps their share under the name snapshot (null personId).
   */
  function crewConsumption(ringUps, types, nightId) {
    var result = { ounces: 0, standardDrinks: 0, count: 0, byPerson: [] };
    var index = new Map();
    (ringUps || []).forEach(function (ringUp) {
      if (!ringUp || ringUp.kind !== "crew" || ringUp.voidedAt) return;
      if (nightId !== undefined && nightId !== null && ringUp.nightId !== nightId) return;
      var measured = linesConsumption(ringUp.lines, types);
      var key = ringUp.personId ? "id:" + ringUp.personId : "name:" + (ringUp.personName || "");
      var entry = index.get(key);
      if (!entry) {
        entry = { personId: ringUp.personId || null, personName: ringUp.personName || "", ounces: 0, standardDrinks: 0, count: 0 };
        index.set(key, entry);
        result.byPerson.push(entry);
      }
      [entry, result].forEach(function (total) {
        total.ounces += measured.ounces;
        total.standardDrinks += measured.standardDrinks;
        total.count += 1;
      });
    });
    return result;
  }

  // ---------- crew running balance (0.5.2-0.5.6, 0.8.7, 0.8.8, KTD1-KTD4) ------

  /** Whole cents, half-up, after collapsing float noise (320.4999999999 is 320.5 and becomes 321). */
  function roundHalfUpCents(cents) {
    return Math.floor(round6(cents) + 0.5) + 0;
  }

  /** The integer cents a crew pour is stamped with when logged (KTD2): unit cost x amount, rounded half-up once. */
  function pourCostCents(bottle, amount) {
    var quantity = amount === null || amount === undefined || amount === "" ? NaN : Number(amount);
    if (!Number.isFinite(quantity) || quantity < 0) throw new RangeError("A pour amount must be a finite amount of 0 or more.");
    return roundHalfUpCents(lineCostCents(normalizeBottle(bottle), quantity));
  }

  /**
   * A ring-up's cost in whole cents (KTD2): the unrounded line costs are totalled,
   * rounded half-up ONCE, and the total is split back over the lines by largest
   * remainder, so the lines always add up to exactly the total.
   */
  function ringUpCostCents(lines) {
    var costs = (lines || []).map(function (line) {
      var cost = Number((line && line.costCents) || 0);
      if (!Number.isFinite(cost) || cost < 0) throw new RangeError("A line cost must be a finite amount of 0 or more.");
      return cost;
    });
    var totalCents = roundHalfUpCents(costs.reduce(function (total, cost) { return total + cost; }, 0));
    return { totalCents: totalCents, lineCents: allocateShares(totalCents, costs) };
  }

  /** "id:<id>" for a known id, "name:<name>" for a name snapshot only, null when a record names nobody. */
  function partyKey(id, name) {
    if (id !== undefined && id !== null && id !== "") return "id:" + id;
    if (typeof name === "string" && name !== "") return "name:" + name;
    return null;
  }

  function wholeCentsOrNull(value) {
    var number = numberOrNull(value);
    return number === null ? null : Math.round(number);
  }

  function isOwnedLine(line) {
    return Boolean(line) && partyKey(line.buyerId, line.buyerName) !== null;
  }

  /**
   * What a crew drink's lines charge the drinker: only lines someone bought count
   * (stock nobody bought credits nobody), a missing or negative cost counts as 0,
   * and the total is rounded once and allocated back over those lines (KTD2).
   */
  function crewCharge(lines) {
    var owned = listOf(lines).filter(isOwnedLine);
    var cost = ringUpCostCents(
      owned.map(function (line) {
        var cents = Number(line.costCents);
        return { costCents: Number.isFinite(cents) && cents > 0 ? cents : 0 };
      })
    );
    return { owned: owned, totalCents: cost.totalCents, lineCents: cost.lineCents };
  }

  /** The whole cents crewBalances debits the drinker (or the tab's writer) for one drink's lines. */
  function crewDrinkCostCents(lines) {
    return crewCharge(lines).totalCents;
  }

  function compareParties(a, b) {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    var idA = a.personId === null || a.personId === undefined ? "" : String(a.personId);
    var idB = b.personId === null || b.personId === undefined ? "" : String(b.personId);
    if (idA !== idB) return idA < idB ? -1 : 1;
    return 0;
  }

  /**
   * Every person's running balance in integer cents, derived from the records on
   * every read (KTD1). Positive = the crew owes them; negative = they owe.
   *   crew pour (costCents stamped)    drinker -costCents, the bottle's buyer +costCents
   *   unvoided crew ring-up            person -ringUpCostCents total, each line's buyer +its allocated cents
   *   paid guest tab                   each unvoided line's buyer +shareCents, the collector - the same
   *   written-off guest tab            writtenOffBy - each unvoided ring-up's total, buyers + allocated cents
   *   unvoided payment                 from +amountCents (paying reduces what you owe), to -amountCents
   * Every movement is a pair of equal and opposite amounts, so the balances always
   * sum to zero (0.5.6). A movement where either side names nobody moves nothing:
   * pours logged before cost stamping (costCents null), stock nobody bought (no
   * buyer id or name, excluded from the ring-up total too) and write-offs recorded
   * before their author was. A paid tab debits the collector the shares it credits,
   * which equals amountCents whenever the tab's records are consistent (the database
   * enforces amount_cents = the sum of unvoided prices). Stock adjustments never
   * move money (0.5.5). Output: every roster person in roster order (0 included),
   * then people no longer on the roster with a non-zero balance, by name then id,
   * under their snapshot name.
   */
  function crewBalances(state) {
    var source = state || {};
    var entries = new Map();
    var roster = [];

    listOf(source.people).forEach(function (person) {
      var key = person ? partyKey(person.id, person.name) : null;
      if (key === null || entries.has(key)) return;
      var entry = { personId: person.id === undefined || person.id === "" ? null : person.id, name: person.name || "", cents: 0 };
      entries.set(key, entry);
      roster.push(entry);
    });

    function entryFor(key, id, name) {
      var entry = entries.get(key);
      if (!entry) {
        entry = { personId: id === undefined || id === "" ? null : id, name: "", cents: 0 };
        entries.set(key, entry);
      }
      if (!entry.name && typeof name === "string") entry.name = name;
      return entry;
    }

    /** `from` gives up `cents` to `to`: from -cents, to +cents. Nothing moves unless both sides are named. */
    function move(fromId, fromName, toId, toName, cents) {
      var fromKey = partyKey(fromId, fromName);
      var toKey = partyKey(toId, toName);
      if (fromKey === null || toKey === null || !cents) return;
      entryFor(fromKey, fromId, fromName).cents -= cents;
      entryFor(toKey, toId, toName).cents += cents;
    }

    function chargeCost(personId, personName, lines) {
      if (partyKey(personId, personName) === null) return;
      var charge = crewCharge(lines);
      charge.owned.forEach(function (line, index) {
        move(personId, personName, line.buyerId, line.buyerName, charge.lineCents[index]);
      });
    }

    listOf(source.nights).forEach(function (night) {
      listOf(night && night.pours).forEach(function (pour) {
        if (!pour) return;
        var cents = wholeCentsOrNull(pour.costCents);
        if (cents === null || cents <= 0) return;
        move(pour.personId, pour.personName, pour.buyerId, pour.buyerName, cents);
      });
    });

    var tabMap = byId(source.guestTabs);
    listOf(source.ringUps).forEach(function (ringUp) {
      if (!ringUp || ringUp.voidedAt) return;
      if (ringUp.kind === "crew") {
        chargeCost(ringUp.personId, ringUp.personName, ringUp.lines);
        return;
      }
      var tab = tabMap.get(ringUp.tabId);
      if (!tab) return;
      if (tab.status === "paid") {
        listOf(ringUp.lines).forEach(function (line) {
          if (!line) return;
          var share = wholeCentsOrNull(line.shareCents);
          if (share === null || share <= 0) return;
          move(tab.collectorId, tab.collectorName, line.buyerId, line.buyerName, share);
        });
      } else if (tab.status === "written_off") {
        chargeCost(tab.writtenOffBy, tab.writtenOffByName, ringUp.lines);
      }
    });

    listOf(source.payments).forEach(function (payment) {
      if (!payment || payment.voidedAt) return;
      var cents = wholeCentsOrNull(payment.amountCents);
      if (cents === null || cents <= 0) return;
      // Paying moves the payer toward zero: the payee gives up the credit, the payer gains it.
      move(payment.toPersonId, payment.toName, payment.fromPersonId, payment.fromName, cents);
    });

    var onRoster = new Set(roster);
    var others = [];
    entries.forEach(function (entry) {
      if (!onRoster.has(entry) && entry.cents !== 0) others.push(entry);
    });
    others.sort(compareParties);
    return roster.concat(others).map(function (entry) {
      return { personId: entry.personId, name: entry.name, cents: entry.cents + 0 };
    });
  }

  // Up to this many non-zero balances, suggestPayments searches for the true minimum (KTD3).
  var EXACT_SETTLE_LIMIT = 10;

  /** Largest debtor pays largest creditor until one side is settled. Ties go to the earlier party in the given order. */
  function settleGreedy(parties) {
    var working = parties.map(function (party) { return { party: party, cents: party.cents }; });
    var payments = [];
    for (;;) {
      var debtor = null;
      var creditor = null;
      working.forEach(function (entry) {
        if (entry.cents < 0 && (!debtor || entry.cents < debtor.cents)) debtor = entry;
        if (entry.cents > 0 && (!creditor || entry.cents > creditor.cents)) creditor = entry;
      });
      if (!debtor || !creditor) return payments;
      var amount = Math.min(-debtor.cents, creditor.cents);
      payments.push({
        fromPersonId: debtor.party.personId,
        fromName: debtor.party.name,
        toPersonId: creditor.party.personId,
        toName: creditor.party.name,
        amountCents: amount
      });
      debtor.cents += amount;
      creditor.cents -= amount;
    }
  }

  /**
   * Splits the parties into the most zero-sum groups (a group of k settles in k-1
   * payments, so the most groups means the fewest payments). Subset DP over at most
   * 2^10 masks: best[mask] = the most zero-sum prefixes of any ordering of mask.
   * Walking back down from the full set, always removing the lowest index that keeps
   * the optimum, makes the result depend only on the (sorted) order of parties.
   */
  function zeroSumGroups(parties) {
    var n = parties.length;
    var full = (1 << n) - 1;
    var sums = new Array(full + 1);
    var best = new Array(full + 1);
    sums[0] = 0;
    best[0] = 0;
    for (var mask = 1; mask <= full; mask += 1) {
      var low = mask & -mask;
      sums[mask] = sums[mask ^ low] + parties[31 - Math.clz32(low)].cents;
      var top = 0;
      for (var i = 0; i < n; i += 1) {
        if (mask & (1 << i)) top = Math.max(top, best[mask ^ (1 << i)]);
      }
      best[mask] = top + (sums[mask] === 0 ? 1 : 0);
    }

    var groups = [];
    var current = [];
    var remaining = full;
    while (remaining) {
      var closes = sums[remaining] === 0 ? 1 : 0;
      for (var j = 0; j < n; j += 1) {
        var bit = 1 << j;
        if ((remaining & bit) && best[remaining ^ bit] + closes === best[remaining]) {
          current.push(j);
          remaining ^= bit;
          break;
        }
      }
      if (sums[remaining] === 0) {
        groups.push(current);
        current = [];
      }
    }
    return groups
      .map(function (group) {
        return group.sort(function (a, b) { return a - b; });
      })
      .sort(function (a, b) { return a[0] - b[0]; })
      .map(function (group) {
        return group.map(function (index) { return parties[index]; });
      });
  }

  /**
   * The payments that settle everyone (KTD3). Zero balances are ignored and parties
   * are sorted by name then id first, so any order of the same balances gives the
   * identical list on every device. Up to 10 non-zero balances: the true minimum
   * number of payments. Above 10: largest debtor to largest creditor. Balances are
   * expected to sum to zero (crewBalances always does); if not, what cannot be
   * matched is left unsettled.
   */
  function suggestPayments(balances) {
    var parties = listOf(balances)
      .map(function (entry) {
        var cents = Math.round(Number(entry && entry.cents));
        return {
          personId: entry && entry.personId !== undefined ? entry.personId : null,
          name: entry && entry.name ? String(entry.name) : "",
          cents: Number.isFinite(cents) ? cents : 0
        };
      })
      .filter(function (party) { return party.cents !== 0; })
      .sort(compareParties);
    if (parties.length === 0) return [];
    if (parties.length > EXACT_SETTLE_LIMIT) return settleGreedy(parties);
    var payments = [];
    zeroSumGroups(parties).forEach(function (group) {
      settleGreedy(group).forEach(function (payment) { payments.push(payment); });
    });
    return payments;
  }

  /**
   * The records as the database leaves them once a person is deleted: the pours they
   * drank go with them (on delete cascade), and every other reference to them is set
   * null while its name snapshot stays.
   */
  function withoutPerson(state, personId) {
    var source = state || {};
    var clear = function (id) { return id === personId ? null : id; };
    return Object.assign({}, source, {
      people: listOf(source.people).filter(function (person) { return person && person.id !== personId; }),
      nights: listOf(source.nights).map(function (night) {
        return Object.assign({}, night, {
          pours: listOf(night && night.pours)
            .filter(function (pour) { return pour && pour.personId !== personId; })
            .map(function (pour) { return Object.assign({}, pour, { buyerId: clear(pour.buyerId) }); })
        });
      }),
      ringUps: listOf(source.ringUps).map(function (ringUp) {
        return Object.assign({}, ringUp, {
          personId: clear(ringUp && ringUp.personId),
          lines: listOf(ringUp && ringUp.lines).map(function (line) { return Object.assign({}, line, { buyerId: clear(line && line.buyerId) }); })
        });
      }),
      guestTabs: listOf(source.guestTabs).map(function (tab) {
        return Object.assign({}, tab, { collectorId: clear(tab && tab.collectorId), writtenOffBy: clear(tab && tab.writtenOffBy) });
      }),
      payments: listOf(source.payments).map(function (payment) {
        return Object.assign({}, payment, { fromPersonId: clear(payment && payment.fromPersonId), toPersonId: clear(payment && payment.toPersonId) });
      })
    });
  }

  /**
   * Everyone else whose balance would change if `personId` were removed (KTD9):
   * [{ personId, name, beforeCents, afterCents }], the roster and anyone who has
   * already left it under their name snapshot (personId null). Removing someone
   * deletes the pours they drank, so a person reading $0.00 can still take other
   * people's credit with them; the app refuses the removal while this list is not
   * empty.
   */
  function balanceChangesOnRemoval(state, personId) {
    // Keyed the way crewBalances groups parties — id when known, name otherwise —
    // so a shift that lands on somebody who already left the roster (a name
    // snapshot with no id) is seen too, instead of every such party collapsing
    // onto one null key and being filtered away.
    var keyOf = function (entry) { return partyKey(entry.personId, entry.name); };
    var after = new Map(crewBalances(withoutPerson(state, personId)).map(function (entry) { return [keyOf(entry), entry.cents]; }));
    return crewBalances(state)
      .filter(function (entry) { return entry.personId !== personId; })
      .map(function (entry) {
        var key = keyOf(entry);
        return { personId: entry.personId, name: entry.name, beforeCents: entry.cents, afterCents: after.has(key) ? after.get(key) : 0 };
      })
      .filter(function (entry) { return entry.beforeCents !== entry.afterCents; });
  }

  /**
   * One night's drinks grouped by who drank them (0.4.3): every crew pour on the
   * night plus every unvoided crew ring-up on it, oldest first, each carrying what
   * it drew and the whole cents it charges — exactly the cents crewBalances debits.
   * `costCents` is null when a drink charges nobody (stock nobody bought, or a pour
   * logged before the cost columns existed), so the recap can say so instead of
   * showing $0.00. People who drank nothing are left out; the roster comes first in
   * its own order, then anyone removed since, by name then id.
   */
  function nightRecap(state, nightId) {
    var source = state || {};
    var bottles = byId(source.bottles);
    var typeList = listOf(source.types);
    var typeMap = byId(typeList);
    var rank = new Map();
    var entries = new Map();
    var list = [];

    listOf(source.people).forEach(function (person) {
      var key = person ? partyKey(person.id, person.name) : null;
      if (key === null || rank.has(key)) return;
      rank.set(key, rank.size);
    });

    function entryFor(personId, personName) {
      var key = partyKey(personId, personName);
      if (key === null) key = "nobody";
      var entry = entries.get(key);
      if (!entry) {
        entry = {
          personId: personId === undefined || personId === "" ? null : personId,
          name: personName || "",
          drinks: [],
          ounces: 0,
          standardDrinks: 0,
          costCents: 0,
          rank: rank.has(key) ? rank.get(key) : Infinity
        };
        entries.set(key, entry);
        list.push(entry);
      }
      if (!entry.name && personName) entry.name = personName;
      return entry;
    }

    function add(personId, personName, drink) {
      var entry = entryFor(personId, personName);
      entry.drinks.push(drink);
      entry.ounces = round6(entry.ounces + drink.ounces);
      entry.standardDrinks += drink.standardDrinks;
      if (drink.costCents !== null) entry.costCents += drink.costCents;
    }

    var nameOf = new Map();
    listOf(source.people).forEach(function (person) {
      if (person && person.id) nameOf.set(person.id, person.name || "");
    });

    var night = null;
    listOf(source.nights).forEach(function (entry) {
      if (!night && entry && entry.id === nightId) night = entry;
    });
    if (!night) return [];

    listOf(night.pours).forEach(function (pour) {
      if (!pour) return;
      var bottle = bottles.get(pour.bottleId);
      var typeId = bottle ? bottle.typeId : null;
      var measured = measureAmount(typeMap.get(typeId), pour.ounces, Number(pour.abv) > 0 ? pour.abv : undefined);
      var cents = wholeCentsOrNull(pour.costCents);
      var charged = partyKey(pour.buyerId, pour.buyerName) !== null;
      add(pour.personId, nameOf.get(pour.personId) || "", {
        kind: "pour",
        id: pour.id,
        bottleId: pour.bottleId,
        typeId: typeId,
        menuItemId: null,
        name: "",
        amount: Number(pour.ounces) || 0,
        ounces: measured.ounces,
        standardDrinks: measured.standardDrinks,
        costCents: charged && cents !== null && cents > 0 ? cents : null,
        at: pour.timestamp || ""
      });
    });

    listOf(source.ringUps).forEach(function (ringUp) {
      if (!ringUp || ringUp.kind !== "crew" || ringUp.voidedAt || ringUp.nightId !== nightId) return;
      var measured = linesConsumption(ringUp.lines, typeList);
      var charge = crewCharge(ringUp.lines);
      add(ringUp.personId, ringUp.personName || nameOf.get(ringUp.personId) || "", {
        kind: "ringUp",
        id: ringUp.id,
        bottleId: null,
        typeId: null,
        menuItemId: ringUp.menuItemId === undefined ? null : ringUp.menuItemId,
        name: ringUp.menuItemName || "",
        amount: null,
        ounces: measured.ounces,
        standardDrinks: measured.standardDrinks,
        costCents: charge.owned.length ? charge.totalCents : null,
        at: ringUp.rungAt || ""
      });
    });

    list.forEach(function (entry) {
      entry.drinks.sort(function (a, b) {
        var timeA = timeOf(a.at);
        var timeB = timeOf(b.at);
        return timeA === timeB ? 0 : timeA - timeB;
      });
    });
    list.sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return compareParties(a, b);
    });
    return list.map(function (entry) {
      return { personId: entry.personId, name: entry.name, drinks: entry.drinks, ounces: entry.ounces, standardDrinks: entry.standardDrinks, costCents: entry.costCents };
    });
  }

  // ---------- settle-up form and quick log (0.4.2, 0.5.4, KTD8) -----------------

  var DOLLAR_AMOUNT = /^\$?(?:(\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/;

  /**
   * A typed dollar amount ("3.20", "$12", ".5") as whole cents, read digit by digit
   * so no floating-point product can round it; null for anything else (a sign,
   * more than two decimals, separators, an exponent, an empty field).
   */
  // 1 US fluid ounce, the unit every volume is stored in. A 750 ml bottle is
  // 25.36 oz by this, which is where the stock form's default came from.
  var ML_PER_OUNCE = 29.5735295625;
  var VOLUME_UNITS = {
    oz: 1, ozs: 1, floz: 1, flozs: 1, ounce: 1, ounces: 1, flounce: 1, flounces: 1, fluidounce: 1, fluidounces: 1,
    ml: 1 / ML_PER_OUNCE, mls: 1 / ML_PER_OUNCE, milliliter: 1 / ML_PER_OUNCE, milliliters: 1 / ML_PER_OUNCE,
    millilitre: 1 / ML_PER_OUNCE, millilitres: 1 / ML_PER_OUNCE,
    cl: 10 / ML_PER_OUNCE, cls: 10 / ML_PER_OUNCE, centiliter: 10 / ML_PER_OUNCE, centiliters: 10 / ML_PER_OUNCE,
    centilitre: 10 / ML_PER_OUNCE, centilitres: 10 / ML_PER_OUNCE,
    l: 1000 / ML_PER_OUNCE, liter: 1000 / ML_PER_OUNCE, liters: 1000 / ML_PER_OUNCE,
    litre: 1000 / ML_PER_OUNCE, litres: 1000 / ML_PER_OUNCE
  };

  /**
   * Fluid ounces for a volume somebody typed, rounded to 2dp (the precision every
   * volume input already steps in). A bare number is ounces, so nothing that
   * worked before changes meaning; naming a unit converts it.
   *
   * Bottles are labelled in millilitres and recipes in ounces, so both are
   * accepted rather than making anyone do the arithmetic. Returns null for
   * anything that is not a volume -- empty, a stray word, a negative -- so a
   * caller can tell "typed nothing" from "typed something wrong".
   */
  function parseVolumeOunces(value) {
    if (typeof value === "number") return isFinite(value) && value >= 0 ? round2(value) : null;
    if (typeof value !== "string") return null;
    var text = value.trim().toLowerCase();
    if (!text) return null;
    // "750 ml", "750ml", "1.5 fl oz", "1.5fl.oz." -- the number, then the unit.
    var match = /^([0-9]*\.?[0-9]+)\s*([a-z. ]*)$/.exec(text);
    if (!match) return null;
    var amount = Number(match[1]);
    if (!isFinite(amount) || amount < 0) return null;
    var unit = match[2].replace(/[. ]/g, "");
    if (!unit) return round2(amount);
    if (!Object.prototype.hasOwnProperty.call(VOLUME_UNITS, unit)) return null;
    return round2(amount * VOLUME_UNITS[unit]);
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function dollarsToCents(value) {
    if (typeof value === "number" && !Number.isFinite(value)) return null;
    if (typeof value !== "number" && typeof value !== "string") return null;
    var match = DOLLAR_AMOUNT.exec(String(value).trim());
    if (!match) return null;
    var whole = match[1] || "0";
    var fraction = (match[2] || match[3] || "").padEnd(2, "0");
    return Number(whole) * 100 + Number(fraction);
  }

  /** The amount one quick-log tap pours: a 1.5 oz measure of poured stock, one unit of counted stock. */
  function quickLogAmount(type) {
    return type && type.measure === MEASURE_UNIT ? 1 : 1.5;
  }

  function timeOf(value) {
    var time = Date.parse(value);
    return Number.isFinite(time) ? time : -Infinity;
  }

  /**
   * The last `limit` (default 8) distinct things a person logged, newest first:
   * { kind: "bottle", id } from their crew pours and { kind: "menu", id } from their
   * unvoided crew ring-ups. Items no longer in state are skipped, and a repeat keeps
   * only its newest place. Ties in time keep the later record first.
   */
  /**
   * Every crew drink charged on one night, flattened out of nightRecap and newest
   * first, each carrying who drank it. nightRecap already decides what counts as a
   * crew drink and what it charges, so this stays the same answer in a flat shape.
   *
   * A host night can hold these as well as its guest tabs: a crew pour or a crew
   * ring-up made while the bar was open. They charge a crew member at cost and sit
   * on no tab, which is why they stay correctable after the night ends, and why the
   * Ledger lists them per host night.
   */
  function crewDrinksOnNight(state, nightId) {
    var drinks = [];
    nightRecap(state, nightId).forEach(function (entry) {
      listOf(entry.drinks).forEach(function (drink) {
        drinks.push(Object.assign({}, drink, { personId: entry.personId, personName: entry.name }));
      });
    });
    // nightRecap sorts each person's drinks oldest first; newest first reads better
    // as a list of "what just went wrong". Ties keep a stable order by id.
    drinks.sort(function (a, b) {
      var timeA = timeOf(a.at);
      var timeB = timeOf(b.at);
      if (timeA !== timeB) return timeB - timeA;
      return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
    });
    return drinks;
  }

  function recentLogItems(state, personId, limit) {
    var source = state || {};
    var max = limit === undefined ? 8 : limit;
    if (!personId) return [];
    var bottleIds = new Set(listOf(source.bottles).map(function (bottle) { return bottle && bottle.id; }));
    var menuIds = new Set(listOf(source.menuItems).map(function (item) { return item && item.id; }));
    var logged = [];
    listOf(source.nights).forEach(function (night) {
      listOf(night && night.pours).forEach(function (pour) {
        if (!pour || pour.personId !== personId || !bottleIds.has(pour.bottleId)) return;
        logged.push({ kind: "bottle", id: pour.bottleId, time: timeOf(pour.timestamp), order: logged.length });
      });
    });
    listOf(source.ringUps).forEach(function (ringUp) {
      if (!ringUp || ringUp.kind !== "crew" || ringUp.voidedAt || ringUp.personId !== personId) return;
      if (!menuIds.has(ringUp.menuItemId)) return;
      logged.push({ kind: "menu", id: ringUp.menuItemId, time: timeOf(ringUp.rungAt), order: logged.length });
    });
    logged.sort(function (a, b) {
      if (a.time !== b.time) return b.time - a.time;
      return b.order - a.order;
    });
    var seen = new Set();
    var recent = [];
    logged.forEach(function (entry) {
      var key = entry.kind + ":" + entry.id;
      if (recent.length >= max || seen.has(key)) return;
      seen.add(key);
      recent.push({ kind: entry.kind, id: entry.id });
    });
    return recent;
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

  /** A crew pour keeps its fields and gains costCents (whole cents or null), buyerId and buyerName (null when absent). */
  function normalizePour(pour) {
    var copy = Object.assign({}, pour);
    copy.costCents = numberOrNull(copy.costCents);
    copy.buyerId = orNull(copy.buyerId);
    copy.buyerName = orNull(copy.buyerName);
    return copy;
  }

  /**
   * startedLocally is a browser-only mark (KTD9): kept only when literally true, never sent to the database.
   * Both kinds keep endedAt: a crew night can end too (crew-balance KTD7).
   */
  function normalizeNight(night) {
    var source = night || {};
    var kind = source.kind === "host" ? "host" : "crew";
    var result = {
      id: source.id,
      name: source.name,
      date: source.date,
      kind: kind,
      endedAt: orNull(source.endedAt),
      pours: listOf(source.pours).map(normalizePour)
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
      writtenOffBy: orNull(source.writtenOffBy),
      writtenOffByName: orNull(source.writtenOffByName),
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

  function normalizePayment(payment) {
    var source = payment || {};
    return {
      id: source.id,
      fromPersonId: orNull(source.fromPersonId),
      fromName: source.fromName || "",
      toPersonId: orNull(source.toPersonId),
      toName: source.toName || "",
      amountCents: numberOrZero(source.amountCents),
      paidAt: orNull(source.paidAt),
      voidedAt: orNull(source.voidedAt)
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
      payments: listOf(source.payments).map(normalizePayment),
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

  /**
   * The rnmb_pours row for a crew pour. cost_cents, buyer_id and buyer_name are added
   * only when crewBalanceAvailable is literally true (supabase/crew-balance.sql has run).
   */
  function pourRow(pour, nightId, crewBalanceAvailable) {
    var row = {
      id: pour.id,
      night_id: nightId,
      person_id: pour.personId,
      bottle_id: pour.bottleId,
      ounces: pour.ounces,
      abv_snapshot: pour.abv,
      poured_at: pour.timestamp
    };
    if (crewBalanceAvailable === true) {
      row.cost_cents = numberOrNull(pour.costCents);
      row.buyer_id = orNull(pour.buyerId);
      row.buyer_name = orNull(pour.buyerName);
    }
    return row;
  }

  function paymentRow(payment) {
    var normalized = normalizePayment(payment);
    return {
      id: normalized.id,
      from_person_id: normalized.fromPersonId,
      from_name: normalized.fromName,
      to_person_id: normalized.toPersonId,
      to_name: normalized.toName,
      amount_cents: normalized.amountCents,
      paid_at: normalized.paidAt,
      voided_at: normalized.voidedAt
    };
  }

  /**
   * A copy of the pour stamped the way rnmb_add_crew_pour stamps it (KTD2): whole-cent
   * cost from the bottle's price and size, and the bottle buyer's id and name when that
   * buyer is on the roster (otherwise nobody is credited).
   */
  function stampPour(pour, bottle, people) {
    var buyerId = bottle && bottle.buyerId;
    var buyer = buyerId ? byId(people).get(buyerId) : null;
    return Object.assign({}, pour, {
      costCents: pourCostCents(bottle, pour.ounces),
      buyerId: buyer ? buyer.id : null,
      buyerName: buyer ? buyer.name : null
    });
  }

  /**
   * True when the state holds anything a database without supabase/crew-balance.sql has
   * no column or table for: payments, cost-stamped pours, write-off authors, or an
   * ended crew night. Replacing such a database with this state would lose them.
   */
  function hasCrewBalanceRecords(state) {
    var source = state || {};
    if (listOf(source.payments).length) return true;
    var nights = listOf(source.nights);
    if (nights.some(function (night) { return night && night.kind !== "host" && orNull(night.endedAt) !== null; })) return true;
    if (nights.some(function (night) {
      return listOf(night && night.pours).some(function (pour) {
        return numberOrNull(pour && pour.costCents) !== null || orNull(pour && pour.buyerId) !== null;
      });
    })) return true;
    return listOf(source.guestTabs).some(function (tab) {
      return orNull(tab && tab.writtenOffBy) !== null || orNull(tab && tab.writtenOffByName) !== null;
    });
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
    round6: round6,
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
    quoteMenuItem: quoteMenuItem,
    validateSources: validateSources,
    validateRingUpSources: validateRingUpSources,
    flattenSources: flattenSources,
    sourcesShortfall: sourcesShortfall,
    suggestExtraSource: suggestExtraSource,
    switchSource: switchSource,
    stockDeltasForRingUp: stockDeltasForRingUp,
    stockDeltasForVoid: stockDeltasForVoid,
    applyStockDeltas: applyStockDeltas,
    tabTotalCents: tabTotalCents,
    summarizeHostNight: summarizeHostNight,
    crewConsumption: crewConsumption,
    pourCostCents: pourCostCents,
    ringUpCostCents: ringUpCostCents,
    crewBalances: crewBalances,
    suggestPayments: suggestPayments,
    crewDrinkCostCents: crewDrinkCostCents,
    balanceChangesOnRemoval: balanceChangesOnRemoval,
    dollarsToCents: dollarsToCents,
    parseVolumeOunces: parseVolumeOunces,
    quickLogAmount: quickLogAmount,
    recentLogItems: recentLogItems,
    nightRecap: nightRecap,
    crewDrinksOnNight: crewDrinksOnNight,
    normalizeNight: normalizeNight,
    normalizePour: normalizePour,
    normalizeMenuItem: normalizeMenuItem,
    normalizeTab: normalizeTab,
    normalizeRingUp: normalizeRingUp,
    normalizeAdjustment: normalizeAdjustment,
    normalizePayment: normalizePayment,
    normalizeState: normalizeState,
    typeRow: typeRow,
    nightRow: nightRow,
    settingsRow: settingsRow,
    bottleRow: bottleRow,
    pourRow: pourRow,
    paymentRow: paymentRow,
    stampPour: stampPour,
    hasCrewBalanceRecords: hasCrewBalanceRecords
  });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = RNMBDomain;
}
