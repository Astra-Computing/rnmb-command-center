// Tests for domain.js — the pure money and stock arithmetic behind host mode.
// Run inside the dev-env container:
//   node --test /workspace/projects/rnmb-command-center/tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../domain.js");

// ---------- fixtures ----------------------------------------------------------

const people = [
  { id: "p-sam", name: "Sam" },
  { id: "p-alex", name: "Alex" },
  { id: "p-jordan", name: "Jordan" }
];

const types = [
  { id: "t-tequila", name: "Tequila", category: "Tequila", abv: 40, measure: "oz", unitOz: null },
  { id: "t-triple", name: "Triple Sec", category: "Liqueur", abv: 30, measure: "oz", unitOz: null },
  { id: "t-lime", name: "Lime Juice", category: "Mixer", abv: 0, measure: "oz", unitOz: null },
  { id: "t-lager", name: "Lager", category: "Beer", abv: 5, measure: "unit", unitOz: 12 }
];

const ae1Bottles = () => [
  { id: "b-tequila", typeId: "t-tequila", size: 25.36, remaining: 25.36, price: 30, buyerId: "p-sam", date: "2026-09-01" },
  { id: "b-triple", typeId: "t-triple", size: 25.36, remaining: 25.36, price: 20, buyerId: "p-alex", date: "2026-09-01" },
  { id: "b-lime", typeId: "t-lime", size: 32, remaining: 32, price: 4, buyerId: "p-jordan", date: "2026-09-01" }
];

const margarita = {
  id: "m-marg",
  name: "Margarita",
  kind: "cocktail",
  ingredients: [
    { typeId: "t-tequila", amount: 2 },
    { typeId: "t-triple", amount: 1 },
    { typeId: "t-lime", amount: 1 }
  ]
};

const ae1Context = (bottles) => ({
  bottles,
  types,
  people,
  markupPercent: 50,
  roundingIncrementCents: 50
});

const sum = (values) => values.reduce((total, value) => total + value, 0);

// ---------- AE1: price and shares ---------------------------------------------

test("AE1: margarita costs about $3.28, prices at 500 cents, shares Sam 361 / Alex 120 / Jordan 19", () => {
  const result = D.priceRingUp(
    [
      { bottleId: "b-tequila", amount: 2 },
      { bottleId: "b-triple", amount: 1 },
      { bottleId: "b-lime", amount: 1 }
    ],
    ae1Context(ae1Bottles())
  );
  assert.equal(Math.round(result.costCents), 328);
  assert.equal(result.priceCents, 500);
  assert.deepEqual(result.lines.map((line) => line.shareCents), [361, 120, 19]);
  assert.deepEqual(result.lines.map((line) => line.buyerName), ["Sam", "Alex", "Jordan"]);
  assert.deepEqual(result.lines.map((line) => line.buyerId), ["p-sam", "p-alex", "p-jordan"]);
  assert.deepEqual(result.lines.map((line) => line.abv), [40, 30, 0]);
  assert.equal(sum(result.lines.map((line) => line.shareCents)), result.priceCents);
});

test("AE1 step by step: marked-up cost is about $4.92 before rounding", () => {
  const bottles = ae1Bottles();
  const cost = D.lineCostCents(bottles[0], 2) + D.lineCostCents(bottles[1], 1) + D.lineCostCents(bottles[2], 1);
  assert.ok(Math.abs(cost * 1.5 - 491.94) < 0.01, `marked up ${cost * 1.5}`);
  assert.equal(D.priceCents(cost, 50, 50), 500);
});

test("unit cost is purchase price over size, in unrounded cents", () => {
  const bottle = { id: "x", typeId: "t-lime", size: 32, remaining: 32, price: 4 };
  assert.equal(D.unitCostCents(bottle), 12.5);
  assert.equal(D.lineCostCents(bottle, 2), 25);
  assert.equal(D.unitCostCents({ size: 10, price: 0 }), 0);
});

// ---------- KTD2 rounding -----------------------------------------------------

test("a cost landing exactly on an increment is not rounded up a further step", () => {
  assert.equal(D.priceCents(500, 0, 50), 500);
  assert.equal(D.priceCents(400, 25, 50), 500);
  // $8 bottle of 3 oz, 1.25 oz poured, 50% markup: floats to 500.00000000000006.
  const cost = D.lineCostCents({ size: 3, price: 8 }, 1.25);
  assert.ok(cost * 1.5 > 500, "fixture must reproduce the floating-point overshoot");
  assert.equal(D.priceCents(cost, 50, 50), 500);
  // $1 bottle of 3 oz, 1.25 oz, 20% markup: floats to 50.00000000000001.
  assert.equal(D.priceCents(D.lineCostCents({ size: 3, price: 1 }, 1.25), 20, 50), 50);
});

test("a cost just above an increment is rounded up one step", () => {
  assert.equal(D.priceCents(500.01, 0, 50), 550);
  assert.equal(D.priceCents(450.5, 0, 25), 475);
});

test("markup 0% and increment 1 cent returns the cost rounded up to the next cent", () => {
  assert.equal(D.priceCents(327.957, 0, 1), 328);
  assert.equal(D.priceCents(327.001, 0, 1), 328);
  assert.equal(D.priceCents(327, 0, 1), 327);
});

test("zero cost prices at zero", () => {
  assert.equal(D.priceCents(0, 50, 50), 0);
});

test("priceCents rejects invalid increments, markups and costs", () => {
  assert.throws(() => D.priceCents(100, 0, 0), RangeError);
  assert.throws(() => D.priceCents(100, 0, -25), RangeError);
  assert.throws(() => D.priceCents(100, 0, 2.5), RangeError);
  assert.throws(() => D.priceCents(100, 0, Number.NaN), RangeError);
  assert.throws(() => D.priceCents(100, -5, 25), RangeError);
  assert.throws(() => D.priceCents(-1, 0, 25), RangeError);
  assert.throws(() => D.priceCents(Number.POSITIVE_INFINITY, 0, 25), RangeError);
});

// ---------- largest-remainder shares -----------------------------------------

test("shares sum to the price for 1, 2 and 5 lines, ties broken by line order", () => {
  assert.deepEqual(D.allocateShares(500, [327.9]), [500]);
  assert.deepEqual(D.allocateShares(5, [10, 10]), [3, 2]);
  assert.deepEqual(D.allocateShares(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(D.allocateShares(7, [2, 2, 2, 2, 2]), [2, 2, 1, 1, 1]);
  const five = D.allocateShares(1237, [13.1, 0.7, 250, 99.99, 42]);
  assert.equal(five.length, 5);
  assert.equal(sum(five), 1237);
  five.forEach((share) => assert.ok(Number.isInteger(share) && share >= 0));
  for (let price = 0; price <= 300; price += 7) {
    assert.equal(sum(D.allocateShares(price, [1 / 3, 1 / 3, 1 / 3, 2.2, 0.1])), price);
  }
});

test("a zero-cost line receives a zero share and the others absorb the price", () => {
  const shares = D.allocateShares(501, [100, 0, 100]);
  assert.deepEqual(shares, [251, 0, 250]);
  const result = D.priceRingUp(
    [
      { bottleId: "b-free", amount: 2 },
      { bottleId: "b-lime", amount: 1 }
    ],
    ae1Context([
      { id: "b-free", typeId: "t-tequila", size: 25.36, remaining: 25.36, price: 0, buyerId: "p-sam", date: "2026-09-01" },
      ...ae1Bottles()
    ])
  );
  assert.deepEqual(result.lines.map((line) => line.shareCents), [0, result.priceCents]);
});

test("allocateShares handles empty and zero inputs and rejects nonsense", () => {
  assert.deepEqual(D.allocateShares(0, []), []);
  assert.deepEqual(D.allocateShares(0, [0, 0]), [0, 0]);
  assert.deepEqual(D.allocateShares(0, [5, 5]), [0, 0]);
  assert.throws(() => D.allocateShares(100, []), RangeError);
  assert.throws(() => D.allocateShares(100, [0, 0]), RangeError);
  assert.throws(() => D.allocateShares(-1, [1]), RangeError);
  assert.throws(() => D.allocateShares(10.5, [1]), RangeError);
  assert.throws(() => D.allocateShares(10, [1, -1]), RangeError);
});

// ---------- ring-up building --------------------------------------------------

test("AE9: split tequila 0.5 oz from a $30 bottle and 1.5 oz from a $36 bottle divides by source cost", () => {
  const bottles = [
    { id: "b-a", typeId: "t-tequila", size: 25.36, remaining: 0.5, price: 30, buyerId: "p-sam", date: "2026-08-01" },
    { id: "b-b", typeId: "t-tequila", size: 25.36, remaining: 25.36, price: 36, buyerId: "p-alex", date: "2026-09-01" },
    ...ae1Bottles().slice(1)
  ];
  const draft = [
    { bottleId: "b-a", amount: 0.5 },
    { bottleId: "b-b", amount: 1.5 },
    { bottleId: "b-triple", amount: 1 },
    { bottleId: "b-lime", amount: 1 }
  ];
  const result = D.priceRingUp(draft, ae1Context(bottles));
  const [lineA, lineB] = result.lines;
  assert.ok(Math.abs(lineA.costCents - (3000 / 25.36) * 0.5) < 1e-9);
  assert.ok(Math.abs(lineB.costCents - (3600 / 25.36) * 1.5) < 1e-9);
  assert.equal(sum(result.lines.map((line) => line.shareCents)), result.priceCents);
  // Each source's share is its exact proportional quota rounded by at most one cent.
  result.lines.forEach((line) => {
    const quota = (result.priceCents * line.costCents) / result.costCents;
    assert.ok(Math.abs(line.shareCents - quota) < 1, `${line.bottleId}: ${line.shareCents} vs ${quota}`);
  });
  assert.equal(lineA.buyerName, "Sam");
  assert.equal(lineB.buyerName, "Alex");

  const after = D.applyStockDeltas(bottles, D.stockDeltasForRingUp(result.lines));
  assert.equal(after.find((bottle) => bottle.id === "b-a").remaining, 0);
  assert.equal(after.find((bottle) => bottle.id === "b-b").remaining, 23.86);
});

test("a crew ring-up carries no price and no shares", () => {
  const result = D.priceRingUp([{ bottleId: "b-tequila", amount: 1.5 }], { ...ae1Context(ae1Bottles()), kind: "crew" });
  assert.equal(result.priceCents, null);
  assert.equal(result.lines[0].shareCents, null);
  assert.ok(result.costCents > 0);
});

test("priceRingUp rejects empty drafts, unknown bottles and non-positive amounts", () => {
  const context = ae1Context(ae1Bottles());
  assert.throws(() => D.priceRingUp([], context), /at least one/i);
  assert.throws(() => D.priceRingUp([{ bottleId: "nope", amount: 1 }], context), /unknown stock item/i);
  assert.throws(() => D.priceRingUp([{ bottleId: "b-lime", amount: 0 }], context), RangeError);
  assert.throws(() => D.priceRingUp([{ bottleId: "b-lime", amount: -1 }], context), RangeError);
});

test("a ring-up where every source is free prices at zero with zero shares", () => {
  const bottles = [{ id: "b-free", typeId: "t-tequila", size: 25.36, remaining: 25.36, price: 0, buyerId: "p-sam", date: "2026-09-01" }];
  const result = D.priceRingUp([{ bottleId: "b-free", amount: 2 }], ae1Context(bottles));
  assert.equal(result.priceCents, 0);
  assert.deepEqual(result.lines.map((line) => line.shareCents), [0]);
});

test("a line whose buyer was removed keeps a null buyer and an empty name", () => {
  const bottles = [{ id: "b-orphan", typeId: "t-lime", size: 32, remaining: 32, price: 4, buyerId: "", date: "2026-09-01" }];
  const result = D.priceRingUp([{ bottleId: "b-orphan", amount: 1 }], ae1Context(bottles));
  assert.equal(result.lines[0].buyerId, null);
  assert.equal(result.lines[0].buyerName, "");
});

// ---------- availability and preselection -------------------------------------

test("combinedRemaining totals every item of a type", () => {
  const bottles = [
    { id: "1", typeId: "t-tequila", size: 25.36, remaining: 0.5, date: "2026-01-01" },
    { id: "2", typeId: "t-tequila", size: 25.36, remaining: 1.25, date: "2026-01-02" },
    { id: "3", typeId: "t-lime", size: 32, remaining: 9, date: "2026-01-02" }
  ];
  assert.equal(D.combinedRemaining(bottles, "t-tequila"), 1.75);
  assert.equal(D.combinedRemaining(bottles, "t-unknown"), 0);
});

test("AE5: availability is false when combined remaining of any ingredient type is below its amount", () => {
  const bottles = ae1Bottles();
  bottles[1].remaining = 0.25;
  bottles.push({ id: "b-triple-2", typeId: "t-triple", size: 25.36, remaining: 0.25, price: 20, buyerId: "p-alex", date: "2026-09-02" });
  const result = D.menuItemAvailability(margarita, bottles);
  assert.equal(result.available, false);
  assert.deepEqual(result.shortTypeIds, ["t-triple"]);

  // A hand correction raises one bottle; the margarita becomes available.
  bottles[1].remaining = 12;
  assert.deepEqual(D.menuItemAvailability(margarita, bottles), { available: true, shortTypeIds: [] });
});

test("availability is false for an item with no ingredients or an ingredient type with no stock", () => {
  assert.equal(D.menuItemAvailability({ kind: "cocktail", ingredients: [] }, ae1Bottles()).available, false);
  assert.equal(
    D.menuItemAvailability({ kind: "straight", ingredients: [{ typeId: "t-lager", amount: 1 }] }, ae1Bottles()).available,
    false
  );
});

test("preselection picks the least-remaining item that alone covers the amount; ties go to the earlier purchase", () => {
  const bottles = [
    { id: "full", typeId: "t-tequila", size: 25.36, remaining: 25.36, date: "2026-01-01" },
    { id: "tiny", typeId: "t-tequila", size: 25.36, remaining: 1, date: "2026-01-01" },
    { id: "mid-late", typeId: "t-tequila", size: 25.36, remaining: 5, date: "2026-03-01" },
    { id: "mid-early", typeId: "t-tequila", size: 25.36, remaining: 5, date: "2026-02-01" },
    { id: "exact", typeId: "t-triple", size: 25.36, remaining: 1, date: "2026-02-01" },
    { id: "lime", typeId: "t-lime", size: 32, remaining: 32, date: "2026-02-01" }
  ];
  const picks = D.preselectSources(margarita, bottles);
  assert.equal(picks.length, 3);
  assert.deepEqual(picks[0], {
    typeId: "t-tequila",
    amount: 2,
    sources: [{ bottleId: "mid-early", amount: 2 }],
    short: false,
    available: true
  });
  // An item holding exactly the amount covers it.
  assert.deepEqual(picks[1].sources, [{ bottleId: "exact", amount: 1 }]);
  assert.equal(picks[2].sources[0].bottleId, "lime");
});

test("preselection marks the ingredient short when only the combined stock covers it; availability stays true", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 1.5, date: "2026-02-01" },
    { id: "empty", typeId: "t-tequila", size: 25.36, remaining: 0, date: "2026-01-01" },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 0.5, date: "2026-03-01" },
    { id: "t", typeId: "t-triple", size: 25.36, remaining: 10, date: "2026-02-01" },
    { id: "l", typeId: "t-lime", size: 32, remaining: 10, date: "2026-02-01" }
  ];
  const [tequila] = D.preselectSources(margarita, bottles);
  assert.equal(tequila.short, true);
  assert.equal(tequila.available, true);
  assert.deepEqual(tequila.sources, [{ bottleId: "b", amount: 0.5 }]);
  assert.equal(D.menuItemAvailability(margarita, bottles).available, true);
  // The preselection alone does not validate: confirm stays disabled.
  assert.equal(D.validateSources(margarita.ingredients[0], tequila.sources, bottles).ok, false);
});

test("preselection for an uncovered ingredient offers no sources and is unavailable", () => {
  const bottles = [{ id: "a", typeId: "t-tequila", size: 25.36, remaining: 1, date: "2026-02-01" }];
  const [tequila] = D.preselectSources(margarita, bottles);
  assert.deepEqual(tequila.sources, []);
  assert.equal(tequila.available, false);
  assert.equal(tequila.short, false);
});

// ---------- split validation --------------------------------------------------

test("split validation accepts sources totalling the recipe amount", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.5 },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 25.36 }
  ];
  const ingredient = { typeId: "t-tequila", amount: 2 };
  assert.deepEqual(
    D.validateSources(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: 1.5 }], bottles),
    { ok: true, errors: [] }
  );
  // Floating noise within epsilon still totals exactly.
  assert.equal(
    D.validateSources({ typeId: "t-tequila", amount: 0.3 }, [{ bottleId: "a", amount: 0.1 }, { bottleId: "b", amount: 0.2 }], bottles).ok,
    true
  );
  // Taking every last drop is allowed.
  assert.equal(D.validateSources({ typeId: "t-tequila", amount: 0.5 }, [{ bottleId: "a", amount: 0.5 }], bottles).ok, true);
});

test("split validation rejects totals under or over the recipe amount and sources beyond remaining", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.5 },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 25.36 },
    { id: "lime", typeId: "t-lime", size: 32, remaining: 32 }
  ];
  const ingredient = { typeId: "t-tequila", amount: 2 };
  const under = D.validateSources(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: 1 }], bottles);
  assert.equal(under.ok, false);
  assert.match(under.errors.join(" "), /total/i);
  const over = D.validateSources(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: 2 }], bottles);
  assert.equal(over.ok, false);
  assert.match(over.errors.join(" "), /total/i);
  const beyond = D.validateSources(ingredient, [{ bottleId: "a", amount: 1 }, { bottleId: "b", amount: 1 }], bottles);
  assert.equal(beyond.ok, false);
  assert.match(beyond.errors.join(" "), /remaining/i);
  const wrongType = D.validateSources(ingredient, [{ bottleId: "lime", amount: 2 }], bottles);
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.errors.join(" "), /type/i);
  assert.equal(D.validateSources(ingredient, [], bottles).ok, false);
  assert.equal(D.validateSources(ingredient, [{ bottleId: "ghost", amount: 2 }], bottles).ok, false);
  assert.equal(D.validateSources(ingredient, [{ bottleId: "b", amount: -1 }, { bottleId: "b", amount: 3 }], bottles).ok, false);
  assert.equal(D.validateSources(ingredient, [{ bottleId: "b", amount: 1 }, { bottleId: "b", amount: 1 }], bottles).ok, false);
});

test("validateRingUpSources catches two ingredients overdrawing the same item together", () => {
  const bottles = [{ id: "a", typeId: "t-tequila", size: 25.36, remaining: 3 }];
  const item = { kind: "cocktail", ingredients: [{ typeId: "t-tequila", amount: 2 }, { typeId: "t-tequila", amount: 2 }] };
  const result = D.validateRingUpSources(
    item,
    [[{ bottleId: "a", amount: 2 }], [{ bottleId: "a", amount: 2 }]],
    bottles
  );
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /remaining/i);
  const good = D.validateRingUpSources(margarita, D.preselectSources(margarita, ae1Bottles()).map((p) => p.sources), ae1Bottles());
  assert.deepEqual(good, { ok: true, errors: [] });
  assert.equal(D.validateRingUpSources(margarita, [[{ bottleId: "b-tequila", amount: 2 }]], ae1Bottles()).ok, false);
});

// ---------- counted items, mixers and the amount helper -----------------------

test("a counted item consumes exactly 1 unit and its standard drinks come from unit volume x ABV", () => {
  const item = { kind: "counted", ingredients: [{ typeId: "t-lager", amount: 3 }] };
  assert.deepEqual(D.menuItemIngredients(item), [{ typeId: "t-lager", amount: 1 }]);
  const bottles = [{ id: "pack", typeId: "t-lager", size: 12, remaining: 12, price: 18, buyerId: "p-jordan", date: "2026-09-01" }];
  const [pick] = D.preselectSources(item, bottles);
  assert.deepEqual(pick.sources, [{ bottleId: "pack", amount: 1 }]);
  const result = D.priceRingUp(pick.sources, { ...ae1Context(bottles), roundingIncrementCents: 25 });
  assert.equal(result.lines[0].amount, 1);
  assert.equal(result.lines[0].costCents, 150);
  assert.equal(result.priceCents, 225);
  const consumption = D.linesConsumption(result.lines, types);
  assert.equal(consumption.ounces, 12);
  assert.ok(Math.abs(consumption.standardDrinks - 1) < 1e-9);
  const after = D.applyStockDeltas(bottles, D.stockDeltasForRingUp(result.lines));
  assert.equal(after[0].remaining, 11);
});

test("a straight pour item uses only its first ingredient", () => {
  const item = { kind: "straight", ingredients: [{ typeId: "t-tequila", amount: 1.5 }, { typeId: "t-lime", amount: 1 }] };
  assert.deepEqual(D.menuItemIngredients(item), [{ typeId: "t-tequila", amount: 1.5 }]);
  assert.deepEqual(D.menuItemIngredients(margarita), margarita.ingredients);
  assert.deepEqual(D.menuItemIngredients(null), []);
});

test("a mixer line adds cost and zero standard drinks", () => {
  const result = D.priceRingUp(
    [
      { bottleId: "b-tequila", amount: 2 },
      { bottleId: "b-lime", amount: 1 }
    ],
    ae1Context(ae1Bottles())
  );
  const withoutMixer = D.priceRingUp([{ bottleId: "b-tequila", amount: 2 }], ae1Context(ae1Bottles()));
  assert.ok(result.costCents > withoutMixer.costCents);
  assert.equal(result.lines[1].costCents, 12.5);
  assert.ok(result.lines[1].shareCents > 0);
  assert.equal(D.measureAmount(types[2], 1).standardDrinks, 0);
  const consumption = D.linesConsumption(result.lines, types);
  assert.equal(consumption.ounces, 3);
  assert.ok(Math.abs(consumption.standardDrinks - D.linesConsumption([result.lines[0]], types).standardDrinks) < 1e-12);
});

test("amount helper: 1 unit of a 12 oz 5% counted type is 12 oz and 1.0 standard drink; 1.5 oz at 40% is 1.0", () => {
  const counted = D.measureAmount({ measure: "unit", unitOz: 12, abv: 5 }, 1);
  assert.equal(counted.ounces, 12);
  assert.ok(Math.abs(counted.standardDrinks - 1) < 1e-9);
  const poured = D.measureAmount({ measure: "oz", abv: 40 }, 1.5);
  assert.equal(poured.ounces, 1.5);
  assert.ok(Math.abs(poured.standardDrinks - 1) < 1e-9);
});

test("amount helper prefers the ABV snapshot, including a snapshot of 0, and tolerates a missing type", () => {
  assert.ok(Math.abs(D.measureAmount({ measure: "oz", abv: 80 }, 1.5, 40).standardDrinks - 1) < 1e-9);
  assert.equal(D.measureAmount({ measure: "oz", abv: 40 }, 1.5, 0).standardDrinks, 0);
  assert.ok(Math.abs(D.measureAmount({ measure: "oz", abv: 40 }, 1.5, null).standardDrinks - 1) < 1e-9);
  assert.ok(Math.abs(D.measureAmount(undefined, 1.5, 40).standardDrinks - 1) < 1e-9);
  assert.deepEqual(D.measureAmount({ measure: "oz", abv: 40 }, 0), { ounces: 0, standardDrinks: 0 });
  // A legacy type with no measure is poured stock.
  assert.equal(D.measureAmount({ abv: 5 }, 12).ounces, 12);
  assert.ok(Math.abs(D.standardDrinks(12, 5) - 1) < 1e-9);
});

// ---------- stock deltas and void ---------------------------------------------

test("void deltas exactly reverse ring-up deltas for every source", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.5, price: 30 },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 23.36, price: 36 },
    { id: "c", typeId: "t-lime", size: 32, remaining: 0.7, price: 4 },
    { id: "untouched", typeId: "t-lime", size: 32, remaining: 12.34, price: 4 }
  ];
  const lines = [
    { bottleId: "a", amount: 0.5 },
    { bottleId: "b", amount: 1.5 },
    { bottleId: "c", amount: 0.1 },
    { bottleId: "c", amount: 0.2 }
  ];
  const ringDeltas = D.stockDeltasForRingUp(lines);
  const voidDeltas = D.stockDeltasForVoid(lines);
  assert.deepEqual(ringDeltas, [
    { bottleId: "a", delta: -0.5 },
    { bottleId: "b", delta: -1.5 },
    { bottleId: "c", delta: -0.3 }
  ]);
  assert.deepEqual(voidDeltas, ringDeltas.map((entry) => ({ bottleId: entry.bottleId, delta: -entry.delta })));
  const rung = D.applyStockDeltas(bottles, ringDeltas);
  assert.deepEqual(rung.map((bottle) => bottle.remaining), [0, 21.86, 0.4, 12.34]);
  assert.deepEqual(D.applyStockDeltas(rung, voidDeltas), bottles);
  // Pure: the input array is untouched.
  assert.equal(bottles[0].remaining, 0.5);
});

test("applyStockDeltas refuses to drive stock negative, above size, or touch an unknown item", () => {
  const bottles = [{ id: "a", typeId: "t-tequila", size: 25.36, remaining: 1 }];
  assert.throws(() => D.applyStockDeltas(bottles, [{ bottleId: "a", delta: -1.01 }]), RangeError);
  assert.throws(() => D.applyStockDeltas(bottles, [{ bottleId: "a", delta: 25 }]), RangeError);
  assert.throws(() => D.applyStockDeltas(bottles, [{ bottleId: "ghost", delta: -1 }]), /unknown stock item/i);
  assert.deepEqual(D.applyStockDeltas(bottles, []), bottles);
});

// ---------- host-night summary ------------------------------------------------

test("AE8: summary returns collector holdings by buyer and write-off value by buyer, ignoring voided items", () => {
  const tabs = [
    { id: "tab-paid", nightId: "n1", guestName: "Riley", status: "paid", collectorId: "p-jordan", collectorName: "Jordan", amountCents: 3000 },
    { id: "tab-off", nightId: "n1", guestName: "Morgan", status: "written_off", collectorId: null, collectorName: "", amountCents: null },
    { id: "tab-open", nightId: "n1", guestName: "Drew", status: "open" }
  ];
  const line = (buyerId, buyerName, shareCents) => ({ bottleId: `b-${buyerId}`, buyerId, buyerName, shareCents, amount: 1, costCents: shareCents });
  const ringUps = [
    { id: "r1", nightId: "n1", kind: "guest", tabId: "tab-paid", priceCents: 2000, voidedAt: null, lines: [line("p-sam", "Sam", 1500), line("p-alex", "Alex", 500)] },
    { id: "r2", nightId: "n1", kind: "guest", tabId: "tab-paid", priceCents: 1000, voidedAt: null, lines: [line("p-sam", "Sam", 600), line(null, "Casey", 400)] },
    { id: "r-void", nightId: "n1", kind: "guest", tabId: "tab-paid", priceCents: 900, voidedAt: "2026-09-16T22:00:00Z", lines: [line("p-alex", "Alex", 900)] },
    { id: "r3", nightId: "n1", kind: "guest", tabId: "tab-off", priceCents: 800, voidedAt: null, lines: [line("p-alex", "Alex", 550), line("p-jordan", "Jordan", 250)] },
    { id: "r-open", nightId: "n1", kind: "guest", tabId: "tab-open", priceCents: 500, voidedAt: null, lines: [line("p-sam", "Sam", 500)] },
    { id: "r-crew", nightId: "n1", kind: "crew", personId: "p-sam", personName: "Sam", priceCents: null, voidedAt: null, lines: [{ bottleId: "x", buyerId: "p-alex", buyerName: "Alex", shareCents: null, amount: 1.5 }] }
  ];
  const summary = D.summarizeHostNight({ tabs, ringUps });
  assert.deepEqual(summary.collectors, [
    {
      collectorId: "p-jordan",
      collectorName: "Jordan",
      totalCents: 3000,
      byBuyer: [
        { buyerId: "p-sam", buyerName: "Sam", cents: 2100 },
        { buyerId: "p-alex", buyerName: "Alex", cents: 500 },
        { buyerId: null, buyerName: "Casey", cents: 400 }
      ]
    }
  ]);
  assert.deepEqual(summary.writtenOff, {
    totalCents: 800,
    byBuyer: [
      { buyerId: "p-alex", buyerName: "Alex", cents: 550 },
      { buyerId: "p-jordan", buyerName: "Jordan", cents: 250 }
    ]
  });
  assert.equal(summary.openTabCount, 1);
});

test("summary groups two tabs by the same collector and handles an empty night", () => {
  const tabs = [
    { id: "t1", status: "paid", collectorId: "p-sam", collectorName: "Sam", amountCents: 500 },
    { id: "t2", status: "paid", collectorId: "p-sam", collectorName: "Sam", amountCents: 300 }
  ];
  const ringUps = [
    { id: "r1", kind: "guest", tabId: "t1", priceCents: 500, lines: [{ buyerId: "p-alex", buyerName: "Alex", shareCents: 500 }] },
    { id: "r2", kind: "guest", tabId: "t2", priceCents: 300, lines: [{ buyerId: "p-alex", buyerName: "Alex", shareCents: 300 }] }
  ];
  const summary = D.summarizeHostNight({ tabs, ringUps });
  assert.equal(summary.collectors.length, 1);
  assert.equal(summary.collectors[0].totalCents, 800);
  assert.deepEqual(summary.collectors[0].byBuyer, [{ buyerId: "p-alex", buyerName: "Alex", cents: 800 }]);
  assert.deepEqual(D.summarizeHostNight({ tabs: [], ringUps: [] }), {
    collectors: [],
    writtenOff: { totalCents: 0, byBuyer: [] },
    openTabCount: 0
  });
});

test("tabTotalCents sums unvoided guest items on a tab", () => {
  const ringUps = [
    { tabId: "t1", kind: "guest", priceCents: 500, voidedAt: null },
    { tabId: "t1", kind: "guest", priceCents: 250, voidedAt: "2026-09-16T21:00:00Z" },
    { tabId: "t1", kind: "guest", priceCents: 325 },
    { tabId: "t2", kind: "guest", priceCents: 999 }
  ];
  assert.equal(D.tabTotalCents("t1", ringUps), 825);
  assert.equal(D.tabTotalCents("none", ringUps), 0);
});

// ---------- KTD8 payload builders ---------------------------------------------

test("with host mode unavailable, type, night and settings rows contain exactly today's keys", () => {
  const type = { id: "t1", name: "Lager", category: "Beer", abv: 5, measure: "unit", unitOz: 12 };
  assert.deepEqual(D.typeRow(type, false), { id: "t1", name: "Lager", category: "Beer", abv: 5 });
  const night = { id: "n1", name: "Party", date: "2026-09-16", kind: "host", endedAt: null, pours: [] };
  assert.deepEqual(D.nightRow(night, false), { id: "n1", name: "Party", date: "2026-09-16" });
  const settings = { activeNightId: "n1", responsibleMode: false, markupPercent: 50, roundingIncrementCents: 50 };
  assert.deepEqual(D.settingsRow(settings, false), { id: true, active_night_id: "n1", responsible_mode: false });
  assert.deepEqual(D.settingsRow({}, false), { id: true, active_night_id: null, responsible_mode: true });
});

test("with host mode available, rows include measure, unit volume, kind, ended time, markup and increment", () => {
  assert.deepEqual(D.typeRow({ id: "t1", name: "Lager", category: "Beer", abv: 5, measure: "unit", unitOz: 12 }, true), {
    id: "t1", name: "Lager", category: "Beer", abv: 5, measure: "unit", unit_oz: 12
  });
  assert.deepEqual(D.typeRow({ id: "t2", name: "Rum", category: "Rum", abv: 40 }, true), {
    id: "t2", name: "Rum", category: "Rum", abv: 40, measure: "oz", unit_oz: null
  });
  assert.deepEqual(D.nightRow({ id: "n1", name: "Party", date: "2026-09-16", kind: "host", endedAt: "2026-09-17T02:00:00Z" }, true), {
    id: "n1", name: "Party", date: "2026-09-16", kind: "host", ended_at: "2026-09-17T02:00:00Z"
  });
  assert.deepEqual(D.nightRow({ id: "n2", name: "Crew", date: "2026-09-16" }, true), {
    id: "n2", name: "Crew", date: "2026-09-16", kind: "crew", ended_at: null
  });
  assert.deepEqual(D.settingsRow({ activeNightId: "", markupPercent: 50, roundingIncrementCents: 50 }, true), {
    id: true, active_night_id: null, responsible_mode: true, markup_percent: 50, rounding_increment_cents: 50
  });
  assert.deepEqual(D.settingsRow({}, true), {
    id: true, active_night_id: null, responsible_mode: true,
    markup_percent: D.DEFAULT_MARKUP_PERCENT, rounding_increment_cents: D.DEFAULT_ROUNDING_INCREMENT_CENTS
  });
  assert.equal(D.DEFAULT_MARKUP_PERCENT, 0);
  assert.equal(D.DEFAULT_ROUNDING_INCREMENT_CENTS, 25);
});

test("payload builders are strict about the flag: only a literal true adds new columns", () => {
  const type = { id: "t1", name: "Lager", category: "Beer", abv: 5, measure: "unit", unitOz: 12 };
  assert.deepEqual(Object.keys(D.typeRow(type, undefined)), ["id", "name", "category", "abv"]);
  assert.deepEqual(Object.keys(D.typeRow(type, "yes")), ["id", "name", "category", "abv"]);
});

test("bottleRow writes size and remaining into the existing ounce-named columns", () => {
  assert.deepEqual(
    D.bottleRow({ id: "b1", typeId: "t1", nickname: "", size: 12, remaining: 11, price: 18, buyerId: "", date: "2026-09-16" }),
    { id: "b1", type_id: "t1", nickname: null, size_oz: 12, remaining_oz: 11, price: 18, buyer_id: null, purchase_date: "2026-09-16" }
  );
});

// ---------- legacy normalizers ------------------------------------------------

test("normalizeBottle maps legacy sizeOz/remainingOz to size/remaining without overwriting new fields", () => {
  assert.deepEqual(
    D.normalizeBottle({ id: "b1", typeId: "t1", sizeOz: 25.36, remainingOz: 19.2, price: 34.99 }),
    { id: "b1", typeId: "t1", size: 25.36, remaining: 19.2, price: 34.99 }
  );
  assert.deepEqual(
    D.normalizeBottle({ id: "b2", size: 12, remaining: 3, sizeOz: 144, remainingOz: 96 }),
    { id: "b2", size: 12, remaining: 3 }
  );
});

test("normalizeType defaults legacy types to poured ounces with no unit volume", () => {
  assert.deepEqual(D.normalizeType({ id: "t1", name: "Bourbon", category: "Whiskey", abv: 45 }), {
    id: "t1", name: "Bourbon", category: "Whiskey", abv: 45, measure: "oz", unitOz: null
  });
  assert.deepEqual(D.normalizeType({ id: "t2", name: "Lager", abv: "5", measure: "unit", unitOz: "12" }), {
    id: "t2", name: "Lager", abv: 5, measure: "unit", unitOz: 12
  });
});
