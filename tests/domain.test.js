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

// ---------- current menu price (the Menu tab's "as it would ring up now") -----

test("AE1: quoteMenuItem prices the margarita at 500 cents from the preselected sources", () => {
  const bottles = ae1Bottles();
  const quote = D.quoteMenuItem(margarita, ae1Context(bottles));
  assert.equal(quote.available, true);
  assert.deepEqual(quote.shortTypeIds, []);
  assert.equal(quote.priceCents, 500);
  assert.equal(Math.round(quote.costCents), 328);
  assert.deepEqual(quote.ingredients.map((ingredient) => ingredient.sources), D.preselectSources(margarita, bottles).map((pick) => pick.sources));
  assert.deepEqual(quote.sources, quote.ingredients.flatMap((ingredient) => ingredient.sources));
  assert.deepEqual(quote.ingredients.map((ingredient) => ingredient.short), [false, false, false]);
  // The same settings at 0% markup: 328 cents rounds up to 350.
  assert.equal(D.quoteMenuItem(margarita, { ...ae1Context(bottles), markupPercent: 0 }).priceCents, 350);
  // Nothing in the input is changed.
  assert.deepEqual(bottles, ae1Bottles());
});

test("quoteMenuItem prices a short ingredient from the preselected item and then the next items in preselection order", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.25, price: 20, buyerId: "p-sam", date: "2026-02-01" },
    { id: "c", typeId: "t-tequila", size: 25.36, remaining: 1, price: 60, buyerId: "p-jordan", date: "2026-01-01" },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 0.75, price: 40, buyerId: "p-alex", date: "2026-03-01" }
  ];
  const item = { kind: "cocktail", ingredients: [{ typeId: "t-tequila", amount: 1.5 }] };
  const quote = D.quoteMenuItem(item, { bottles, types, people, markupPercent: 0, roundingIncrementCents: 25 });
  assert.equal(quote.available, true);
  assert.equal(quote.ingredients[0].short, true);
  assert.deepEqual(quote.ingredients[0].sources, [
    { bottleId: "a", amount: 0.25 },
    { bottleId: "b", amount: 0.75 },
    { bottleId: "c", amount: 0.5 }
  ]);
  const expected = D.priceRingUp(quote.sources, { bottles, types, people, markupPercent: 0, roundingIncrementCents: 25 });
  assert.equal(quote.priceCents, expected.priceCents);
  assert.equal(quote.costCents, expected.costCents);
  assert.equal(D.validateSources(item.ingredients[0], quote.ingredients[0].sources, bottles).ok, true);
});

test("AE5: quoteMenuItem reports an item unavailable, with no price, when combined stock of a type is short", () => {
  const bottles = ae1Bottles();
  bottles[1].remaining = 0.25;
  bottles.push({ id: "b-triple-2", typeId: "t-triple", size: 25.36, remaining: 0.25, price: 20, buyerId: "p-alex", date: "2026-09-02" });
  const quote = D.quoteMenuItem(margarita, ae1Context(bottles));
  assert.equal(quote.available, false);
  assert.deepEqual(quote.shortTypeIds, ["t-triple"]);
  assert.equal(quote.priceCents, null);
  assert.equal(quote.costCents, null);
  assert.deepEqual(quote.sources, []);
  assert.equal(D.quoteMenuItem({ kind: "cocktail", ingredients: [] }, ae1Context(ae1Bottles())).available, false);
});

test("quoteMenuItem draws a type used twice from stock that is still left after the first use", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 3, price: 30, buyerId: "p-sam", date: "2026-01-01" },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 3, price: 30, buyerId: "p-alex", date: "2026-02-01" }
  ];
  const item = { kind: "cocktail", ingredients: [{ typeId: "t-tequila", amount: 2 }, { typeId: "t-tequila", amount: 2 }] };
  const quote = D.quoteMenuItem(item, { bottles, types, people, markupPercent: 0, roundingIncrementCents: 1 });
  assert.equal(quote.available, true);
  assert.deepEqual(quote.ingredients.map((ingredient) => ingredient.sources), [[{ bottleId: "a", amount: 2 }], [{ bottleId: "b", amount: 2 }]]);
  assert.deepEqual(D.validateRingUpSources(item, quote.ingredients.map((ingredient) => ingredient.sources), bottles), { ok: true, errors: [] });
});

test("quoteMenuItem prices a counted item at one unit", () => {
  const bottles = [{ id: "pack", typeId: "t-lager", size: 12, remaining: 12, price: 18, buyerId: "p-jordan", date: "2026-09-01" }];
  const item = { kind: "counted", ingredients: [{ typeId: "t-lager", amount: 3 }] };
  const quote = D.quoteMenuItem(item, { ...ae1Context(bottles), roundingIncrementCents: 25 });
  assert.deepEqual(quote.sources, [{ bottleId: "pack", amount: 1 }]);
  assert.equal(quote.priceCents, 225);
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

// ---------- register draft helpers (1.7.3, 1.7.7, KTD10) ----------------------

test("flattenSources lists every ingredient's sources in recipe order with numeric amounts", () => {
  assert.deepEqual(
    D.flattenSources([
      [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: "1.5" }],
      [],
      [{ bottleId: "lime", amount: 1 }]
    ]),
    [
      { bottleId: "a", amount: 0.5 },
      { bottleId: "b", amount: 1.5 },
      { bottleId: "lime", amount: 1 }
    ]
  );
  assert.deepEqual(D.flattenSources(undefined), []);
  assert.deepEqual(D.flattenSources([undefined, null]), []);
});

test("sourcesShortfall is what the sources still leave uncovered, never negative, ignoring bad amounts", () => {
  const ingredient = { typeId: "t-tequila", amount: 2 };
  assert.equal(D.sourcesShortfall(ingredient, [{ bottleId: "a", amount: 0.5 }]), 1.5);
  assert.equal(D.sourcesShortfall(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: 1.5 }]), 0);
  assert.equal(D.sourcesShortfall(ingredient, [{ bottleId: "a", amount: 0.1 }, { bottleId: "b", amount: 1.9 }]), 0, "float noise is not a shortfall");
  assert.equal(D.sourcesShortfall(ingredient, [{ bottleId: "b", amount: 3 }]), 0, "over is not short");
  assert.equal(D.sourcesShortfall(ingredient, []), 2);
  assert.equal(D.sourcesShortfall(ingredient, [{ bottleId: "a", amount: Number.NaN }, { bottleId: "b", amount: -1 }]), 2);
});

test("AE9: suggestExtraSource offers the next unused item of the type with the shortfall, capped at what it holds", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.5, date: "2026-09-01" },
    { id: "c", typeId: "t-tequila", size: 25.36, remaining: 1, date: "2026-09-01" },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 25.36, date: "2026-09-02" },
    { id: "empty", typeId: "t-tequila", size: 25.36, remaining: 0, date: "2026-08-01" },
    { id: "lime", typeId: "t-lime", size: 32, remaining: 32 }
  ];
  const ingredient = { typeId: "t-tequila", amount: 2 };
  // Preselection order is least remaining first: a (used), then c.
  assert.deepEqual(D.suggestExtraSource(ingredient, [{ bottleId: "a", amount: 0.5 }], bottles), { bottleId: "c", amount: 1 });
  assert.deepEqual(
    D.suggestExtraSource(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "c", amount: 1 }], bottles),
    { bottleId: "b", amount: 0.5 }
  );
  // Nothing short: the next item is offered with amount 0 for the bartender to fill in.
  assert.deepEqual(D.suggestExtraSource(ingredient, [{ bottleId: "b", amount: 2 }], bottles), { bottleId: "a", amount: 0 });
  // No other item of the type with stock left.
  assert.equal(
    D.suggestExtraSource(ingredient, [{ bottleId: "a", amount: 0.5 }, { bottleId: "c", amount: 1 }, { bottleId: "b", amount: 0.5 }], bottles),
    null
  );
  assert.equal(D.suggestExtraSource({ typeId: "t-ghost", amount: 1 }, [], bottles), null);
});

test("AE3: switchSource gives a lone source the recipe amount capped at the new item, and keeps a split source's amount", () => {
  const bottles = [
    { id: "a", typeId: "t-tequila", size: 25.36, remaining: 0.5 },
    { id: "b", typeId: "t-tequila", size: 25.36, remaining: 25.36 },
    { id: "c", typeId: "t-tequila", size: 25.36, remaining: 1 }
  ];
  const ingredient = { typeId: "t-tequila", amount: 2 };
  const lone = [{ bottleId: "c", amount: 1 }];
  assert.deepEqual(D.switchSource(ingredient, lone, 0, "b", bottles), [{ bottleId: "b", amount: 2 }]);
  assert.deepEqual(D.switchSource(ingredient, [{ bottleId: "b", amount: 2 }], 0, "a", bottles), [{ bottleId: "a", amount: 0.5 }]);
  assert.deepEqual(lone, [{ bottleId: "c", amount: 1 }], "the input is not changed");
  const split = [{ bottleId: "a", amount: 0.5 }, { bottleId: "c", amount: 1.5 }];
  assert.deepEqual(D.switchSource(ingredient, split, 1, "b", bottles), [{ bottleId: "a", amount: 0.5 }, { bottleId: "b", amount: 1.5 }]);
  // An index that does not exist changes nothing.
  assert.deepEqual(D.switchSource(ingredient, split, 5, "b", bottles), split);
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

// ---------- crew consumption from the register (0.4.1, KTD4) ------------------

const crewLine = (typeId, amount, abv) => ({ bottleId: `b-${typeId}`, typeId, amount, abv, costCents: 0, shareCents: null, buyerId: null, buyerName: "" });

test("0.4.1: crew consumption counts unvoided crew ring-ups on the night, per person; guest and voided ring-ups count nothing", () => {
  const ringUps = [
    // A tequila shot for Sam: 1.5 oz at 40% = 1.0 standard drink.
    { id: "c1", nightId: "n1", kind: "crew", personId: "p-sam", personName: "Sam", priceCents: null, voidedAt: null, lines: [crewLine("t-tequila", 1.5, 40)] },
    // A margarita for Sam: 2 oz at 40% + 1 oz at 30% + 1 oz lime at 0% = (0.8 + 0.3) / 0.6 standard drinks, 4 oz.
    { id: "c2", nightId: "n1", kind: "crew", personId: "p-sam", personName: "Sam", priceCents: null, voidedAt: null, lines: [crewLine("t-tequila", 2, 40), crewLine("t-triple", 1, 30), crewLine("t-lime", 1, 0)] },
    // A lager for Alex: 1 unit of 12 oz at 5% = 1.0 standard drink.
    { id: "c3", nightId: "n1", kind: "crew", personId: "p-alex", personName: "Alex", priceCents: null, voidedAt: null, lines: [crewLine("t-lager", 1, 5)] },
    { id: "c-void", nightId: "n1", kind: "crew", personId: "p-alex", personName: "Alex", priceCents: null, voidedAt: "2026-09-16T22:00:00Z", lines: [crewLine("t-tequila", 3, 40)] },
    { id: "g1", nightId: "n1", kind: "guest", tabId: "tab-1", personId: null, priceCents: 500, voidedAt: null, lines: [{ ...crewLine("t-tequila", 2, 40), shareCents: 500 }] },
    { id: "c-other", nightId: "n2", kind: "crew", personId: "p-sam", personName: "Sam", priceCents: null, voidedAt: null, lines: [crewLine("t-tequila", 1.5, 40)] }
  ];
  const result = D.crewConsumption(ringUps, types, "n1");
  const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} vs ${expected}`);

  assert.equal(result.count, 3);
  close(result.ounces, 1.5 + 4 + 12, "night ounces");
  close(result.standardDrinks, 1 + 1.1 / 0.6 + 1, "night standard drinks");
  assert.deepEqual(result.byPerson.map(({ personId, personName, count }) => ({ personId, personName, count })), [
    { personId: "p-sam", personName: "Sam", count: 2 },
    { personId: "p-alex", personName: "Alex", count: 1 }
  ]);
  close(result.byPerson[0].standardDrinks, 1 + 1.1 / 0.6, "Sam's standard drinks");
  close(result.byPerson[0].ounces, 5.5, "Sam's ounces");
  close(result.byPerson[1].standardDrinks, 1, "Alex's standard drinks (voided shot excluded)");
  close(result.byPerson[1].ounces, 12, "Alex's ounces");
});

test("crew consumption across every night, with a removed person kept by name, and an empty input", () => {
  const ringUps = [
    { id: "c1", nightId: "n1", kind: "crew", personId: "p-sam", personName: "Sam", voidedAt: null, lines: [crewLine("t-tequila", 1.5, 40)] },
    { id: "c2", nightId: "n2", kind: "crew", personId: "p-sam", personName: "Sam", voidedAt: null, lines: [crewLine("t-tequila", 1.5, 40)] },
    { id: "c3", nightId: "n2", kind: "crew", personId: null, personName: "Drew", voidedAt: null, lines: [crewLine("t-tequila", 3, 40)] }
  ];
  const all = D.crewConsumption(ringUps, types);
  assert.equal(all.count, 3);
  assert.ok(Math.abs(all.standardDrinks - 4) < 1e-9);
  assert.deepEqual(all.byPerson.map(({ personId, personName, count }) => ({ personId, personName, count })), [
    { personId: "p-sam", personName: "Sam", count: 2 },
    { personId: null, personName: "Drew", count: 1 }
  ]);
  assert.deepEqual(D.crewConsumption([], types, "n1"), { ounces: 0, standardDrinks: 0, count: 0, byPerson: [] });
  assert.deepEqual(D.crewConsumption(undefined, types), { ounces: 0, standardDrinks: 0, count: 0, byPerson: [] });
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

// ---------- whole-state normalizer (U3: archives, localStorage, database loads) --

test("normalizeState maps a legacy archive's sizeOz/remainingOz onto size/remaining with the same values", () => {
  const legacy = {
    people: [{ id: "p1", name: "Alex", color: "#f97316" }],
    types: [{ id: "t1", name: "Bourbon", category: "Whiskey", abv: 45 }],
    bottles: [{ id: "b1", typeId: "t1", nickname: "Old", sizeOz: 25.36, remainingOz: 19.2, price: 34.99, buyerId: "p1", date: "2026-09-01" }],
    nights: [{ id: "n1", name: "Friday", date: "2026-09-01", pours: [] }],
    activeNightId: "n1",
    responsibleMode: true
  };
  const state = D.normalizeState(legacy);
  assert.equal(state.bottles[0].size, 25.36);
  assert.equal(state.bottles[0].remaining, 19.2);
  assert.equal("sizeOz" in state.bottles[0], false);
  assert.equal("remainingOz" in state.bottles[0], false);
  assert.equal(state.types[0].measure, "oz");
  assert.equal(state.types[0].unitOz, null);
});

test("normalizeState on an archive with no host-mode collections yields empty collections and default markup and increment", () => {
  const state = D.normalizeState({
    people: [],
    types: [],
    bottles: [],
    nights: [{ id: "n1", name: "Friday", date: "2026-09-01" }]
  });
  assert.deepEqual(state.menuItems, []);
  assert.deepEqual(state.guestTabs, []);
  assert.deepEqual(state.ringUps, []);
  assert.deepEqual(state.stockAdjustments, []);
  assert.equal(state.markupPercent, 0);
  assert.equal(state.roundingIncrementCents, 25);
  assert.equal(state.activeNightId, "n1");
  assert.equal(state.responsibleMode, true);
  assert.deepEqual(state.nights[0], { id: "n1", name: "Friday", date: "2026-09-01", kind: "crew", endedAt: null, pours: [] });
});

test("normalizeState on nothing at all is an empty state", () => {
  const state = D.normalizeState({});
  assert.deepEqual(state, {
    people: [], types: [], bottles: [], nights: [],
    menuItems: [], guestTabs: [], ringUps: [], stockAdjustments: [], payments: [],
    activeNightId: "", responsibleMode: true, markupPercent: 0, roundingIncrementCents: 25
  });
});

test("normalizeState keeps host nights, the browser-only local mark only when literally true, and valid settings", () => {
  const state = D.normalizeState({
    nights: [
      { id: "h1", name: "Party", date: "2026-09-16", kind: "host", endedAt: null, pours: [], startedLocally: true },
      { id: "h2", name: "Old party", date: "2026-09-01", kind: "host", endedAt: "2026-09-02T03:00:00Z", startedLocally: "yes" },
      { id: "c1", name: "Crew", date: "2026-09-01", kind: "weird", endedAt: "2026-09-02T03:00:00Z" }
    ],
    activeNightId: "h1",
    responsibleMode: false,
    markupPercent: "50",
    roundingIncrementCents: 50
  });
  assert.deepEqual(state.nights[0], { id: "h1", name: "Party", date: "2026-09-16", kind: "host", endedAt: null, pours: [], startedLocally: true });
  assert.deepEqual(state.nights[1], { id: "h2", name: "Old party", date: "2026-09-01", kind: "host", endedAt: "2026-09-02T03:00:00Z", pours: [] });
  assert.deepEqual(state.nights[2], { id: "c1", name: "Crew", date: "2026-09-01", kind: "crew", endedAt: null, pours: [] });
  assert.equal(state.responsibleMode, false);
  assert.equal(state.markupPercent, 50);
  assert.equal(state.roundingIncrementCents, 50);

  const bad = D.normalizeState({ markupPercent: -5, roundingIncrementCents: 12.5 });
  assert.equal(bad.markupPercent, 0);
  assert.equal(bad.roundingIncrementCents, 25);
});

test("normalizeState normalizes menu items, tabs, ring-ups with their lines, and stock adjustments", () => {
  const state = D.normalizeState({
    menuItems: [
      { id: "m1", name: "Margarita", kind: "cocktail", ingredients: [{ id: "i1", typeId: "t-tequila", amount: "2" }] },
      { id: "m2", name: "Odd", kind: "nonsense" }
    ],
    guestTabs: [{ id: "g1", nightId: "h1", guestName: "Riley" }],
    ringUps: [{
      id: "r1", nightId: "h1", kind: "guest", tabId: "g1", menuItemId: "m1", menuItemName: "Margarita",
      priceCents: "500", rungAt: "2026-09-16T22:00:00Z",
      lines: [{ id: "l1", bottleId: "b1", typeId: "t-tequila", amount: "2", costCents: "236.59", shareCents: "500", buyerId: "p1", buyerName: "Sam", abv: "40" }]
    }, {
      id: "r2", nightId: "h1", kind: "crew", personId: "p2", personName: "Alex", menuItemId: null, menuItemName: "Shot",
      priceCents: null, rungAt: "2026-09-16T22:05:00Z", voidedAt: "2026-09-16T22:06:00Z",
      lines: [{ bottleId: "b1", typeId: "t-tequila", amount: 1.5, costCents: 177.4, shareCents: null, buyerId: null, buyerName: null, abv: 40 }]
    }],
    stockAdjustments: [{ id: "a1", bottleId: "b1", previousRemaining: "10", newRemaining: "8.5", adjustedAt: "2026-09-16T23:00:00Z" }]
  });

  assert.deepEqual(state.menuItems[0], { id: "m1", name: "Margarita", kind: "cocktail", ingredients: [{ id: "i1", typeId: "t-tequila", amount: 2 }] });
  assert.deepEqual(state.menuItems[1], { id: "m2", name: "Odd", kind: "cocktail", ingredients: [] });
  assert.deepEqual(state.guestTabs[0], {
    id: "g1", nightId: "h1", guestName: "Riley", status: "open",
    collectorId: null, collectorName: null, amountCents: null, writtenOffBy: null, writtenOffByName: null,
    openedAt: null, closedAt: null
  });
  assert.deepEqual(state.ringUps[0], {
    id: "r1", nightId: "h1", kind: "guest", tabId: "g1", personId: null, personName: null,
    menuItemId: "m1", menuItemName: "Margarita", priceCents: 500, rungAt: "2026-09-16T22:00:00Z", voidedAt: null,
    lines: [{ id: "l1", bottleId: "b1", typeId: "t-tequila", amount: 2, costCents: 236.59, shareCents: 500, buyerId: "p1", buyerName: "Sam", abv: 40 }]
  });
  assert.equal(state.ringUps[1].kind, "crew");
  assert.equal(state.ringUps[1].priceCents, null);
  assert.equal(state.ringUps[1].voidedAt, "2026-09-16T22:06:00Z");
  assert.deepEqual(state.ringUps[1].lines[0], {
    id: null, bottleId: "b1", typeId: "t-tequila", amount: 1.5, costCents: 177.4, shareCents: null, buyerId: null, buyerName: "", abv: 40
  });
  assert.deepEqual(state.stockAdjustments[0], { id: "a1", bottleId: "b1", previousRemaining: 10, newRemaining: 8.5, adjustedAt: "2026-09-16T23:00:00Z" });
});

test("normalizeState is idempotent", () => {
  const once = D.normalizeState({
    bottles: [{ id: "b1", typeId: "t1", sizeOz: 12, remainingOz: 6, price: 10 }],
    nights: [{ id: "h1", name: "Party", date: "2026-09-16", kind: "host", startedLocally: true }],
    ringUps: [{ id: "r1", nightId: "h1", kind: "guest", tabId: "g1", priceCents: 100, lines: [{ bottleId: "b1", amount: 1 }] }]
  });
  assert.deepEqual(D.normalizeState(JSON.parse(JSON.stringify(once))), once);
});

// ---------- crew running balance (U1: KTD1-KTD4) ------------------------------

const crew = [
  { id: "p-sam", name: "Sam" },
  { id: "p-alex", name: "Alex" },
  { id: "p-jordan", name: "Jordan" },
  { id: "p-casey", name: "Casey" }
];

// Sam's $40, 25 oz bottle: 160 cents per ounce.
const samBottle = () => ({ id: "b-sam", typeId: "t-tequila", size: 25, remaining: 22, price: 40, buyerId: "p-sam", date: "2026-09-01" });

const crewPour = (id, personId, costCents, buyerId, buyerName, extra) =>
  Object.assign({ id, personId, bottleId: "b-sam", ounces: 1, abv: 40, timestamp: "2026-09-17T20:00:00Z", costCents, buyerId, buyerName }, extra);

const centsOf = (balances, key) => {
  const entry = balances.find((row) => row.personId === key || (row.personId === null && row.name === key));
  return entry ? entry.cents : undefined;
};

const ae1State = () => ({
  people: crew,
  bottles: [samBottle()],
  nights: [{
    id: "n1", name: "Friday", date: "2026-09-17", kind: "crew", endedAt: null,
    pours: [
      crewPour("x1", "p-alex", 320, "p-sam", "Sam", { ounces: 2 }),
      crewPour("x2", "p-sam", 160, "p-sam", "Sam", { ounces: 1 })
    ]
  }],
  ringUps: [],
  guestTabs: [],
  payments: []
});

test("pourCostCents is the unit cost times the amount, rounded half-up once", () => {
  assert.equal(D.pourCostCents(samBottle(), 2), 320);
  assert.equal(D.pourCostCents(samBottle(), 1), 160);
  // $1 over 4 oz is 25 cents an ounce: half an ounce is 12.5 cents and rounds up to 13.
  assert.equal(D.pourCostCents({ size: 4, price: 1 }, 0.5), 13);
  // $10 over 3 oz: 3 oz is 999.999... in floating point and must still be 1000.
  assert.equal(D.pourCostCents({ size: 3, price: 10 }, 3), 1000);
  assert.equal(D.pourCostCents({ size: 3, price: 10 }, 0.5), 167);
  assert.equal(D.pourCostCents({ size: 12, price: 18 }, 1), 150); // 1 unit of a counted 12-pack
  assert.equal(D.pourCostCents({ sizeOz: 25, price: 40 }, 1), 160); // legacy bottle shape
  assert.equal(D.pourCostCents(samBottle(), 0), 0);
  assert.throws(() => D.pourCostCents(samBottle(), -1), RangeError);
  assert.throws(() => D.pourCostCents(samBottle(), Number.NaN), RangeError);
  assert.throws(() => D.pourCostCents({ size: 0, price: 10 }, 1), RangeError);
});

test("ringUpCostCents rounds the unrounded total once and allocates it back to the lines", () => {
  const result = D.ringUpCostCents([{ costCents: 33.5 }, { costCents: 33.5 }, { costCents: 33.5 }]);
  // Rounding each line would give 34 + 34 + 34 = 102; the total 100.5 rounds once to 101.
  assert.equal(result.totalCents, 101);
  assert.deepEqual(result.lineCents, [34, 34, 33]);
  const uneven = D.ringUpCostCents([{ costCents: 100.4 }, { costCents: 50.35 }, { costCents: 30.3 }]);
  assert.equal(uneven.totalCents, 181);
  assert.equal(sum(uneven.lineCents), 181);
  assert.ok(uneven.lineCents.every(Number.isInteger));
  assert.deepEqual(D.ringUpCostCents([]), { totalCents: 0, lineCents: [] });
  assert.deepEqual(D.ringUpCostCents([{ costCents: 0.2 }]), { totalCents: 0, lineCents: [0] });
});

test("AE1: two pours from Sam's 160-cent-per-ounce bottle give Alex -320 and Sam +320", () => {
  const balances = D.crewBalances(ae1State());
  assert.equal(centsOf(balances, "p-alex"), -320);
  assert.equal(centsOf(balances, "p-sam"), 320);
  assert.equal(centsOf(balances, "p-jordan"), 0);
  assert.equal(centsOf(balances, "p-casey"), 0);
  assert.equal(sum(balances.map((row) => row.cents)), 0);
  assert.deepEqual(balances.map((row) => row.name), ["Sam", "Alex", "Jordan", "Casey"]);
  assert.deepEqual(balances[0], { personId: "p-sam", name: "Sam", cents: 320 });
});

test("AE2: a recorded 320-cent payment from Alex to Sam zeroes both; a voided payment has no effect", () => {
  const payment = {
    id: "pay1", fromPersonId: "p-alex", fromName: "Alex", toPersonId: "p-sam", toName: "Sam",
    amountCents: 320, paidAt: "2026-09-17T23:00:00Z", voidedAt: null
  };
  const paid = Object.assign(ae1State(), { payments: [payment] });
  const balances = D.crewBalances(paid);
  assert.equal(centsOf(balances, "p-alex"), 0);
  assert.equal(centsOf(balances, "p-sam"), 0);

  const voided = Object.assign(ae1State(), { payments: [Object.assign({}, payment, { voidedAt: "2026-09-17T23:05:00Z" })] });
  assert.deepEqual(D.crewBalances(voided), D.crewBalances(ae1State()));
});

const ae3State = () => {
  const margarita = D.priceRingUp(
    [
      { bottleId: "b-tequila", amount: 2 },
      { bottleId: "b-triple", amount: 1 },
      { bottleId: "b-lime", amount: 1 }
    ],
    ae1Context(ae1Bottles())
  );
  const samLine = (costCents) => ({ bottleId: "b-tequila", typeId: "t-tequila", amount: 1, costCents, shareCents: 125, buyerId: "p-sam", buyerName: "Sam", abv: 40 });
  return {
    people: crew,
    bottles: ae1Bottles(),
    nights: [{ id: "h1", name: "Party", date: "2026-09-17", kind: "host", endedAt: null, pours: [] }],
    guestTabs: [
      { id: "g-paid", nightId: "h1", guestName: "Riley", status: "paid", collectorId: "p-casey", collectorName: "Casey", amountCents: 500, writtenOffBy: null, writtenOffByName: null },
      { id: "g-off", nightId: "h1", guestName: "Quinn", status: "written_off", collectorId: null, collectorName: null, amountCents: null, writtenOffBy: "p-jordan", writtenOffByName: "Jordan" },
      { id: "g-open", nightId: "h1", guestName: "Morgan", status: "open", collectorId: null, collectorName: null, amountCents: null, writtenOffBy: null, writtenOffByName: null }
    ],
    ringUps: [
      { id: "r1", nightId: "h1", kind: "guest", tabId: "g-paid", priceCents: 500, voidedAt: null, lines: margarita.lines },
      // Two written-off drinks whose costs round to 120 each: $2.40 from Sam's bottle.
      { id: "r2", nightId: "h1", kind: "guest", tabId: "g-off", priceCents: 250, voidedAt: null, lines: [samLine(119.6)] },
      { id: "r3", nightId: "h1", kind: "guest", tabId: "g-off", priceCents: 250, voidedAt: null, lines: [samLine(120.4)] },
      { id: "r4", nightId: "h1", kind: "guest", tabId: "g-off", priceCents: 900, voidedAt: "2026-09-17T21:00:00Z", lines: [samLine(700)] },
      { id: "r5", nightId: "h1", kind: "guest", tabId: "g-open", priceCents: 500, voidedAt: null, lines: margarita.lines }
    ],
    payments: []
  };
};

test("AE3: the paid and written-off tabs give Sam +601, Alex +120, Jordan -221, Casey -500", () => {
  const balances = D.crewBalances(ae3State());
  assert.equal(centsOf(balances, "p-sam"), 601);
  assert.equal(centsOf(balances, "p-alex"), 120);
  assert.equal(centsOf(balances, "p-jordan"), -221);
  assert.equal(centsOf(balances, "p-casey"), -500);
  assert.equal(sum(balances.map((row) => row.cents)), 0);
});

test("AE4: a stock adjustment changes no balance", () => {
  const before = D.crewBalances(ae1State());
  const corrected = ae1State();
  corrected.bottles[0].remaining = 6;
  corrected.stockAdjustments = [{ id: "a1", bottleId: "b-sam", previousRemaining: 10, newRemaining: 6, adjustedAt: "2026-09-17T22:00:00Z" }];
  assert.deepEqual(D.crewBalances(corrected), before);
});

test("a three-bottle crew ring-up with fractional line costs debits the rounded total and credits lines summing exactly to it", () => {
  const line = (bottleId, buyerId, buyerName) => ({ bottleId, typeId: "t-tequila", amount: 1, costCents: 33.5, shareCents: null, buyerId, buyerName, abv: 40 });
  const state = {
    people: crew,
    ringUps: [
      {
        id: "c1", nightId: "n1", kind: "crew", personId: "p-casey", personName: "Casey", priceCents: null, voidedAt: null,
        lines: [line("b1", "p-sam", "Sam"), line("b2", "p-alex", "Alex"), line("b3", "p-jordan", "Jordan")]
      },
      {
        id: "c2", nightId: "n1", kind: "crew", personId: "p-casey", personName: "Casey", priceCents: null, voidedAt: "2026-09-17T21:00:00Z",
        lines: [line("b1", "p-sam", "Sam")]
      }
    ]
  };
  const balances = D.crewBalances(state);
  assert.equal(centsOf(balances, "p-casey"), -101);
  assert.equal(centsOf(balances, "p-sam") + centsOf(balances, "p-alex") + centsOf(balances, "p-jordan"), 101);
  assert.deepEqual([centsOf(balances, "p-sam"), centsOf(balances, "p-alex"), centsOf(balances, "p-jordan")], [34, 34, 33]);
});

test("a drink from one's own bottle nets to zero", () => {
  const state = {
    people: crew,
    nights: [{ id: "n1", pours: [crewPour("x1", "p-sam", 480, "p-sam", "Sam", { ounces: 3 })] }],
    ringUps: [{
      id: "c1", nightId: "n1", kind: "crew", personId: "p-alex", personName: "Alex", voidedAt: null,
      lines: [{ bottleId: "b-triple", typeId: "t-triple", amount: 1, costCents: 78.87, shareCents: null, buyerId: "p-alex", buyerName: "Alex", abv: 30 }]
    }]
  };
  assert.ok(D.crewBalances(state).every((row) => row.cents === 0));
});

test("people missing from the roster still appear by snapshot name; records without cost, buyer or author move no money", () => {
  const state = {
    people: crew,
    nights: [{
      id: "n1",
      pours: [
        crewPour("legacy", "p-alex", null, null, null), // logged before cost stamping
        crewPour("unowned", "p-alex", 200, null, null) // a bottle nobody bought
      ]
    }],
    ringUps: [
      {
        id: "c1", nightId: "n1", kind: "crew", personId: null, personName: "Pat", voidedAt: null,
        lines: [
          { bottleId: "b1", typeId: "t-tequila", amount: 1, costCents: 150, shareCents: null, buyerId: null, buyerName: "Riley", abv: 40 },
          { bottleId: "b2", typeId: "t-lime", amount: 1, costCents: 99, shareCents: null, buyerId: null, buyerName: "", abv: 0 }
        ]
      },
      {
        id: "c2", nightId: "n1", kind: "crew", personId: "p-gone", personName: "Drew", voidedAt: null,
        lines: [{ bottleId: "b1", typeId: "t-tequila", amount: 0.5, costCents: 75, shareCents: null, buyerId: "p-sam", buyerName: "Sam", abv: 40 }]
      },
      { id: "g1", nightId: "n1", kind: "guest", tabId: "t-legacy", priceCents: 300, voidedAt: null, lines: [{ bottleId: "b1", amount: 1, costCents: 150, shareCents: 300, buyerId: "p-sam", buyerName: "Sam" }] }
    ],
    guestTabs: [
      // A write-off from before the author was recorded: nobody to debit.
      { id: "t-legacy", nightId: "n1", guestName: "Old", status: "written_off", writtenOffBy: null, writtenOffByName: null }
    ],
    payments: []
  };
  const balances = D.crewBalances(state);
  assert.equal(centsOf(balances, "Pat"), -150);
  assert.equal(centsOf(balances, "Riley"), 150);
  assert.deepEqual(balances.find((row) => row.personId === "p-gone"), { personId: "p-gone", name: "Drew", cents: -75 });
  assert.equal(centsOf(balances, "p-sam"), 75);
  assert.equal(centsOf(balances, "p-alex"), 0);
  assert.equal(sum(balances.map((row) => row.cents)), 0);
  // Roster first, in roster order, then everyone else by name.
  assert.deepEqual(balances.map((row) => row.name), ["Sam", "Alex", "Jordan", "Casey", "Drew", "Pat", "Riley"]);
});

test("crewBalances of an empty or partial state lists the roster at zero", () => {
  assert.deepEqual(D.crewBalances({}), []);
  assert.deepEqual(D.crewBalances({ people: [{ id: "p1", name: "Sam" }] }), [{ personId: "p1", name: "Sam", cents: 0 }]);
});

// ---------- suggested payments (KTD3) ------------------------------------------

const row = (personId, name, cents) => ({ personId, name, cents });

const settle = (balances, payments) => {
  const left = new Map(balances.map((entry) => [entry.personId, entry.cents]));
  payments.forEach((payment) => {
    assert.ok(Number.isInteger(payment.amountCents) && payment.amountCents > 0, "payments are positive whole cents");
    left.set(payment.fromPersonId, left.get(payment.fromPersonId) + payment.amountCents);
    left.set(payment.toPersonId, left.get(payment.toPersonId) - payment.amountCents);
  });
  return [...left.values()];
};

// Seeded Mulberry32: the same 200 fixtures on every run.
const prng = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const shuffled = (list, random) => {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

test("{+500, +300, -500, -300} suggests two payments, and shuffled inputs give the identical list", () => {
  const balances = [row("a", "Alex", 500), row("b", "Blair", 300), row("c", "Casey", -500), row("d", "Drew", -300)];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 2);
  assert.deepEqual(
    payments.map((p) => [p.fromPersonId, p.toPersonId, p.amountCents]).sort(),
    [["c", "a", 500], ["d", "b", 300]]
  );
  assert.deepEqual(Object.keys(payments[0]), ["fromPersonId", "fromName", "toPersonId", "toName", "amountCents"]);
  assert.ok(settle(balances, payments).every((cents) => cents === 0));
  const random = prng(7);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(D.suggestPayments(shuffled(balances, random)), payments);
});

test("{+700, -300, -400} suggests two payments, and shuffled inputs give the identical list", () => {
  const balances = [row("s", "Sam", 700), row("a", "Alex", -300), row("j", "Jordan", -400)];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 2);
  assert.deepEqual(
    payments.map((p) => [p.fromName, p.toName, p.amountCents]).sort(),
    [["Alex", "Sam", 300], ["Jordan", "Sam", 400]]
  );
  const random = prng(11);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(D.suggestPayments(shuffled(balances, random)), payments);
});

test("the exact search finds fewer payments than greedy would: {+600, +500, -500, -400, -200} settles in three", () => {
  const balances = [row("a", "Avery", 600), row("b", "Blair", 500), row("c", "Casey", -500), row("d", "Drew", -400), row("e", "Emery", -200)];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 3); // greedy (largest debtor to largest creditor) needs four
  assert.ok(settle(balances, payments).every((cents) => cents === 0));
});

test("people with the same name tie-break by id, so the list is still identical when shuffled", () => {
  const balances = [row("p2", "Sam", 500), row("p1", "Sam", 500), row("p3", "Alex", -500), row("p4", "Alex", -500)];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 2);
  const random = prng(3);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(D.suggestPayments(shuffled(balances, random)), payments);
});

test("zero balances are ignored and nothing to settle suggests nothing", () => {
  assert.deepEqual(D.suggestPayments([]), []);
  assert.deepEqual(D.suggestPayments([row("a", "Alex", 0), row("b", "Blair", 0)]), []);
  assert.deepEqual(D.suggestPayments(undefined), []);
  const payments = D.suggestPayments([row("a", "Alex", 0), row("b", "Blair", -250), row("c", "Casey", 250)]);
  assert.deepEqual(payments, [{ fromPersonId: "b", fromName: "Blair", toPersonId: "c", toName: "Casey", amountCents: 250 }]);
});

test("a removed person (null id) can pay and be paid by name", () => {
  const payments = D.suggestPayments([row(null, "Pat", -150), row(null, "Riley", 150)]);
  assert.deepEqual(payments, [{ fromPersonId: null, fromName: "Pat", toPersonId: null, toName: "Riley", amountCents: 150 }]);
});

test("more than 10 non-zero balances uses the greedy fallback and still settles everyone", () => {
  // The exact minimum here is 6 payments ({+600,-400,-200}, {+500,-500} and three 100-cent pairs);
  // largest-debtor-to-largest-creditor needs 7 (500, 400, then Emery's 200 split across two 100s).
  const balances = [
    row("a", "Avery", 600), row("b", "Blair", 500), row("c", "Casey", -500), row("d", "Drew", -400), row("e", "Emery", -200),
    row("f", "Finley", 100), row("g", "Gray", 100), row("h", "Harper", 100),
    row("i", "Indy", -100), row("j", "Jules", -100), row("k", "Kai", -100)
  ];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 7);
  assert.ok(settle(balances, payments).every((cents) => cents === 0));
  const random = prng(5);
  for (let i = 0; i < 10; i += 1) assert.deepEqual(D.suggestPayments(shuffled(balances, random)), payments);
});

test("ten non-zero balances still use the exact search", () => {
  const balances = [
    row("a", "Avery", 600), row("b", "Blair", 500), row("c", "Casey", -500), row("d", "Drew", -400), row("e", "Emery", -200),
    row("f", "Finley", 100), row("g", "Gray", 100), row("i", "Indy", -100), row("j", "Jules", -100), row("z", "Zero", 0)
  ];
  const payments = D.suggestPayments(balances);
  assert.equal(payments.length, 5); // 9 non-zero people in 4 zero-sum groups
  assert.ok(settle(balances, payments).every((cents) => cents === 0));
});

// ---------- property: balances always sum to zero (0.5.6) ----------------------

const randomFixture = (random) => {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const int = (max) => Math.floor(random() * (max + 1));
  const roster = crew.slice(0, 2 + int(2));
  // Records may name removed people: an id no longer on the roster, or only a name snapshot.
  const everyone = roster.map((p) => ({ id: p.id, name: p.name })).concat([
    { id: "p-gone", name: "Drew" },
    { id: null, name: "Pat" }
  ]);
  const someone = () => pick(everyone);
  const maybeBuyer = () => (random() < 0.1 ? { id: null, name: "" } : someone());
  const line = () => {
    const buyer = maybeBuyer();
    return { bottleId: "b" + int(5), typeId: "t", amount: 1, costCents: Math.round(random() * 50000) / 100, shareCents: null, buyerId: buyer.id, buyerName: buyer.name, abv: 40 };
  };
  const pours = [];
  for (let i = int(8); i > 0; i -= 1) {
    const drinker = someone();
    const buyer = maybeBuyer();
    pours.push({ id: "x" + i, personId: drinker.id, bottleId: "b1", ounces: 1, abv: 40, timestamp: null, costCents: random() < 0.1 ? null : int(900), buyerId: buyer.id, buyerName: buyer.name });
  }
  const ringUps = [];
  const guestTabs = [];
  for (let i = int(6); i > 0; i -= 1) {
    const person = someone();
    const lines = Array.from({ length: 1 + int(3) }, line);
    ringUps.push({ id: "c" + i, nightId: "n1", kind: "crew", personId: person.id, personName: person.name, priceCents: null, voidedAt: random() < 0.2 ? "2026-09-17T21:00:00Z" : null, lines });
  }
  for (let t = int(4); t > 0; t -= 1) {
    const tabId = "g" + t;
    const status = pick(["open", "paid", "written_off"]);
    let total = 0;
    for (let i = int(3); i > 0; i -= 1) {
      const lines = Array.from({ length: 1 + int(3) }, line);
      const price = D.priceCents(sum(lines.map((l) => l.costCents)), int(100), pick([1, 25, 50]));
      D.allocateShares(price, lines.map((l) => l.costCents)).forEach((share, index) => { lines[index].shareCents = share; });
      const voided = random() < 0.2;
      if (!voided) total += price;
      ringUps.push({ id: tabId + "-r" + i, nightId: "n1", kind: "guest", tabId, priceCents: price, voidedAt: voided ? "2026-09-17T21:00:00Z" : null, lines });
    }
    const collector = status === "paid" ? someone() : { id: null, name: null };
    const writer = status === "written_off" && random() < 0.9 ? someone() : { id: null, name: null };
    guestTabs.push({
      id: tabId, nightId: "n1", guestName: "Guest " + t, status,
      collectorId: collector.id, collectorName: collector.name, amountCents: status === "paid" ? total : null,
      writtenOffBy: writer.id, writtenOffByName: writer.name
    });
  }
  const payments = [];
  for (let i = int(4); i > 0; i -= 1) {
    const from = someone();
    const to = someone();
    payments.push({ id: "pay" + i, fromPersonId: from.id, fromName: from.name, toPersonId: to.id, toName: to.name, amountCents: 1 + int(5000), paidAt: null, voidedAt: random() < 0.2 ? "2026-09-17T23:00:00Z" : null });
  }
  return { people: roster, nights: [{ id: "n1", pours }], ringUps, guestTabs, payments };
};

test("property: balances sum to zero across 200 random fixtures of pours, ring-ups, tabs and payments, and the suggestions settle them", () => {
  const random = prng(20260917);
  for (let n = 0; n < 200; n += 1) {
    const fixture = randomFixture(random);
    const balances = D.crewBalances(fixture);
    assert.ok(balances.every((entry) => Number.isInteger(entry.cents)), "fixture " + n + ": whole cents");
    assert.equal(sum(balances.map((entry) => entry.cents)), 0, "fixture " + n + ": sums to zero");
    // Normalizing the state first changes nothing.
    assert.deepEqual(D.crewBalances(D.normalizeState(fixture)), balances, "fixture " + n + ": normalized state agrees");
    const payments = D.suggestPayments(balances);
    const nonZero = balances.filter((entry) => entry.cents !== 0).length;
    assert.ok(payments.length <= Math.max(0, nonZero - 1), "fixture " + n + ": at most one payment fewer than people owed or owing");
    const left = new Map(balances.map((entry) => [(entry.personId || "") + "|" + entry.name, entry.cents]));
    payments.forEach((p) => {
      const fromKey = (p.fromPersonId || "") + "|" + p.fromName;
      const toKey = (p.toPersonId || "") + "|" + p.toName;
      left.set(fromKey, left.get(fromKey) + p.amountCents);
      left.set(toKey, left.get(toKey) - p.amountCents);
    });
    assert.ok([...left.values()].every((cents) => cents === 0), "fixture " + n + ": suggestions settle everyone");
  }
});

// ---------- normalizers for the new records --------------------------------------

test("normalizePayment returns every field in a fixed order with numeric cents and null times", () => {
  assert.deepEqual(
    D.normalizePayment({ id: "pay1", fromPersonId: "p-alex", fromName: "Alex", toPersonId: "p-sam", toName: "Sam", amountCents: "320", paidAt: "2026-09-17T23:00:00Z" }),
    { id: "pay1", fromPersonId: "p-alex", fromName: "Alex", toPersonId: "p-sam", toName: "Sam", amountCents: 320, paidAt: "2026-09-17T23:00:00Z", voidedAt: null }
  );
  assert.deepEqual(D.normalizePayment({ id: "pay2", fromPersonId: "", toPersonId: null }), {
    id: "pay2", fromPersonId: null, fromName: "", toPersonId: null, toName: "", amountCents: 0, paidAt: null, voidedAt: null
  });
});

test("normalizeState defaults payments, pour cost and buyer fields, and the write-off author to null", () => {
  const state = D.normalizeState({
    nights: [{
      id: "n1", name: "Friday", date: "2026-09-17",
      pours: [
        { id: "x1", personId: "p-alex", bottleId: "b1", ounces: 2, abv: 40, timestamp: "2026-09-17T20:00:00Z" },
        { id: "x2", personId: "p-sam", bottleId: "b1", ounces: 1, abv: 40, timestamp: "2026-09-17T20:05:00Z", costCents: "160", buyerId: "p-sam", buyerName: "Sam" }
      ]
    }],
    guestTabs: [{ id: "g1", nightId: "h1", guestName: "Quinn", status: "written_off", writtenOffBy: "p-jordan", writtenOffByName: "Jordan" }],
    payments: [{ id: "pay1", fromPersonId: "p-alex", fromName: "Alex", toPersonId: "p-sam", toName: "Sam", amountCents: 320 }]
  });
  assert.deepEqual(state.nights[0].pours[0], {
    id: "x1", personId: "p-alex", bottleId: "b1", ounces: 2, abv: 40, timestamp: "2026-09-17T20:00:00Z", costCents: null, buyerId: null, buyerName: null
  });
  assert.deepEqual(state.nights[0].pours[1], {
    id: "x2", personId: "p-sam", bottleId: "b1", ounces: 1, abv: 40, timestamp: "2026-09-17T20:05:00Z", costCents: 160, buyerId: "p-sam", buyerName: "Sam"
  });
  assert.equal(state.guestTabs[0].writtenOffBy, "p-jordan");
  assert.equal(state.guestTabs[0].writtenOffByName, "Jordan");
  assert.deepEqual(state.payments, [{ id: "pay1", fromPersonId: "p-alex", fromName: "Alex", toPersonId: "p-sam", toName: "Sam", amountCents: 320, paidAt: null, voidedAt: null }]);
  assert.deepEqual(D.normalizeState(JSON.parse(JSON.stringify(state))), state);
});
