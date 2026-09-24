// Tests for quotebook.js — the quotebook text parser behind the crew quote card.
// Run inside the dev-env container:
//   node --test /workspace/projects/rnmb-command-center/tests/
//
// Every fixture here is SYNTHETIC. No real crew quote is committed to this repo,
// and no automated check is ever driven with the crew's real book.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Q = require("../quotebook.js");

// ---------- fixtures ----------------------------------------------------------

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures", "parser", name), "utf8");

// The answer key lists one entry per expected quote as `<text> — <author>`, using
// an em dash as the separator. Only the author half is asserted: the text half is
// the raw source line, which the parser deliberately reshapes (quote marks are
// stripped, multi-speaker turns are split onto their own lines).
const keyAuthors = (keyText) =>
  keyText
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.lastIndexOf(" — ");
      assert.ok(idx > 0, "every key line carries an em dash attribution: " + line);
      return line.slice(idx + 3).trim();
    });

const authorsOf = (quotes) => quotes.map((quote) => quote.author);

// ---------- the stress corpus against its answer key --------------------------

test("the stress corpus parses to exactly the key's length and every author matches", () => {
  const quotes = Q.parseQuotebook(fixture("StressTest.txt"));
  const expected = keyAuthors(fixture("StressTestKey.txt"));

  assert.equal(quotes.length, expected.length, "one quote per non-blank source line");
  assert.deepEqual(authorsOf(quotes), expected);
});

test("no speaker name is left inside any quote's text", () => {
  const quotes = Q.parseQuotebook(fixture("StressTest.txt"));

  for (const quote of quotes) {
    for (const name of quote.author.split(", ")) {
      assert.ok(
        quote.text.indexOf(name + ":") === -1,
        "author \"" + name + "\" leaked into the text: " + JSON.stringify(quote.text)
      );
    }
  }
});

// ---------- hyphens: attribution versus punctuation ---------------------------

test("a hyphen after the closing quote is the author; hyphens inside the quote are not", () => {
  const quotes = Q.parseQuotebook(
    '"Well-made drinks - and good ones - take their time" - Ines'
  );

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].author, "Ines");
  assert.equal(quotes[0].text, "Well-made drinks - and good ones - take their time");
});

// ---------- every separator form resolves to the author -----------------------

test("em dash, en dash, no-space hyphen and a bare name each resolve to the author", () => {
  assert.equal(Q.parseQuotebook('"The keg is a mood." — Ines')[0].author, "Ines");
  assert.equal(Q.parseQuotebook('"The keg is a mood." – Ines')[0].author, "Ines");
  assert.equal(Q.parseQuotebook('"The keg is a mood."-Ines')[0].author, "Ines");
  assert.equal(Q.parseQuotebook('"The keg is a mood." Ines')[0].author, "Ines");
  assert.equal(Q.parseQuotebook('"The keg is a mood." Mary Anne Vole')[0].author, "Mary Anne Vole");

  // Unquoted lines reach the same answer through the dash branches.
  assert.equal(Q.parseQuotebook("The keg is a mood. — Ines")[0].author, "Ines");
  assert.equal(Q.parseQuotebook("The keg is a mood. - Ines")[0].author, "Ines");

  // In every case the separator and the name are off the text.
  assert.equal(Q.parseQuotebook('"The keg is a mood." — Ines')[0].text, "The keg is a mood.");
  assert.equal(Q.parseQuotebook("The keg is a mood. - Ines")[0].text, "The keg is a mood.");
});

test("a narration tail such as a trailing \"he said\" is not attributed as a name", () => {
  const quotes = Q.parseQuotebook('"Get the ice" he said');

  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].author, "Unknown");
  assert.ok(quotes[0].text.indexOf("he said") !== -1, "the narration stays with the text");
});

// ---------- colons: a speaker prefix versus a sentence colon ------------------

test("a colon inside a sentence is not a speaker, but a one-to-three capitalised-word prefix is", () => {
  // Four words before the colon: this is a sentence, not an attribution.
  const sentence = Q.parseQuotebook("I have one rule: never lie to the till");
  assert.equal(sentence[0].author, "Unknown");
  assert.equal(sentence[0].text, "I have one rule: never lie to the till");

  // One, two and three capitalised words are all read as the speaker.
  assert.equal(Q.parseQuotebook("Ines: the walk-in is a rumour")[0].author, "Ines");
  assert.equal(Q.parseQuotebook("Mary Vole: the walk-in is a rumour")[0].author, "Mary Vole");

  const three = Q.parseQuotebook("Mary Anne Vole: the walk-in is a rumour");
  assert.equal(three[0].author, "Mary Anne Vole");
  assert.equal(three[0].text, "the walk-in is a rumour");
});

// ---------- multi-speaker exchanges -------------------------------------------

test("a multi-speaker line groups under all its speakers and joins the turns with newlines", () => {
  const quotes = Q.parseQuotebook(
    'Wendell: "I have a theory."   Ottoline: "I have heard your theories."   Wendell: "This one has a diagram."'
  );

  assert.equal(quotes.length, 1);
  // Repeat speakers are named once, in the order they first spoke.
  assert.equal(quotes[0].author, "Wendell, Ottoline");
  assert.equal(
    quotes[0].text,
    '"I have a theory."\n"I have heard your theories."\n"This one has a diagram."'
  );
});

// ---------- normalisation: BOM, CRLF and curly quotes -------------------------

test("BOM, CRLF and curly-quote input parse identically to the clean equivalent", () => {
  const clean = '"The keg is a mood." - Ines\n"The lime is a personality." - Bram';
  const expected = Q.parseQuotebook(clean);

  assert.equal(expected.length, 2);

  const crlf = clean.replace(/\n/g, "\r\n");
  const cr = clean.replace(/\n/g, "\r");
  const bom = "﻿" + crlf;
  const curly = clean.replace(/"/g, (match, offset, whole) => {
    // Opening marks land on an even count of quote characters seen so far.
    const before = whole.slice(0, offset).split('"').length - 1;
    return before % 2 === 0 ? "“" : "”";
  });

  assert.deepEqual(Q.parseQuotebook(crlf), expected, "CRLF");
  assert.deepEqual(Q.parseQuotebook(cr), expected, "bare CR");
  assert.deepEqual(Q.parseQuotebook(bom), expected, "BOM + CRLF");
  assert.deepEqual(Q.parseQuotebook(curly), expected, "curly double quotes");

  // Curly marks around a speaker's turn resolve the same way as straight ones.
  assert.deepEqual(
    Q.parseQuotebook("Ines: “Open the second register.”"),
    Q.parseQuotebook('Ines: "Open the second register."')
  );
});

test("an apostrophe-bearing line keeps the same attribution as its straight-quote equivalent", () => {
  const straight = Q.parseQuotebook("\"I don't know what happened\" - Ines");
  const curlyApostrophe = Q.parseQuotebook("\"I don’t know what happened\" - Ines");

  assert.equal(straight[0].author, "Ines");
  assert.equal(curlyApostrophe[0].author, "Ines", "U+2019 is left alone and does not steal the attribution");
  assert.equal(
    curlyApostrophe[0].text.replace(/’/g, "'"),
    straight[0].text,
    "only the apostrophe character differs"
  );
});

// ---------- blank and empty input ---------------------------------------------

test("blank lines are skipped and an empty string parses to no quotes", () => {
  assert.deepEqual(Q.parseQuotebook(""), []);
  assert.deepEqual(Q.parseQuotebook("\n\n   \n\t\n"), []);
  assert.deepEqual(Q.parseQuotebook("﻿\r\n\r\n"), []);

  const withBlanks = Q.parseQuotebook('\n\n"The keg is a mood." - Ines\n\n   \n"Short one." - Bram\n\n');
  assert.equal(withBlanks.length, 2);
  assert.deepEqual(authorsOf(withBlanks), ["Ines", "Bram"]);
});

// ---------- the long-quote fixture (input for the later layout audit) ---------

test("the long-quote fixture parses, carries an oversized quote and a multi-speaker exchange", () => {
  const quotes = Q.parseQuotebook(fixture("LongQuotes.txt"));

  assert.ok(quotes.length >= 8, "the fixture holds a spread of entries");
  assert.ok(
    quotes.every((quote) => quote.text.length > 0 && quote.author.length > 0),
    "every entry carries both text and an author"
  );

  const longest = quotes.reduce((a, b) => (b.text.length > a.text.length ? b : a));
  assert.ok(
    longest.text.length > 240,
    "the fixture stretches a small card: longest is " + longest.text.length + " characters"
  );

  assert.ok(
    quotes.some((quote) => quote.author.indexOf(", ") !== -1 && quote.text.indexOf("\n") !== -1),
    "the fixture includes a multi-speaker exchange"
  );
});

// ---------- the local store (U2) ----------------------------------------------
// The store runs against an injected fake, so none of this needs a browser.

const APP_STATE_KEY = "rnmb-command-center-v1";

const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    }
  };
};

test("the store key is its own, never the app-state or passphrase key", () => {
  assert.equal(typeof Q.STORAGE_KEY, "string");
  assert.notEqual(Q.STORAGE_KEY, APP_STATE_KEY);
  assert.notEqual(Q.STORAGE_KEY, "rnmb-access-key");
});

test("a parsed book round-trips through the store and reads back identical", () => {
  const storage = fakeStorage();
  const store = Q.createStore(storage);
  const prepared = Q.prepareBook(fixture("StressTest.txt"), "StressTest.txt");

  assert.equal(prepared.ok, true);
  assert.equal(prepared.book.fileName, "StressTest.txt");
  assert.equal(prepared.book.count, prepared.book.quotes.length);
  assert.ok(prepared.book.count > 0);

  assert.deepEqual(store.save(prepared.book), { ok: true });
  assert.deepEqual(store.load(), prepared.book);
});

test("an upload with no usable quotes is refused and never reaches storage", () => {
  const storage = fakeStorage();
  const store = Q.createStore(storage);
  const kept = Q.prepareBook('"Keep me." - Ines', "keep.txt").book;
  store.save(kept);

  for (const text of ["", "\n \r\n\t", "﻿", null, undefined, 42]) {
    const prepared = Q.prepareBook(text, "empty.txt");
    assert.equal(prepared.ok, false);
    assert.equal(prepared.reason, "empty");
  }
  assert.deepEqual(store.load(), kept, "the previously loaded book is untouched");
});

test("a book over the size cap is rejected and the stored book is unchanged", () => {
  const storage = fakeStorage();
  const store = Q.createStore(storage);
  const kept = Q.prepareBook('"Keep me." - Ines', "keep.txt").book;
  store.save(kept);
  const before = storage.getItem(Q.STORAGE_KEY);

  const line = '"' + "x".repeat(200) + '" - Bram\n';
  const huge = line.repeat(Math.ceil((Q.MAX_STORED_CHARS * 1.2) / line.length));
  const prepared = Q.prepareBook(huge, "huge.txt");

  assert.equal(prepared.ok, false, "refused at upload time, before any write");
  assert.equal(prepared.reason, "too-large");
  assert.equal(storage.getItem(Q.STORAGE_KEY), before);

  // save() enforces the same cap on its own, whatever it is handed.
  const oversized = { fileName: "huge.txt", count: 1, quotes: [{ text: "y".repeat(Q.MAX_STORED_CHARS), author: "Bram" }] };
  assert.deepEqual(store.save(oversized), { ok: false, reason: "too-large" });
  assert.equal(storage.getItem(Q.STORAGE_KEY), before);
});

test("a storage write that throws is caught, reported, and leaves the previous book intact", () => {
  const storage = fakeStorage();
  const store = Q.createStore(storage);
  const kept = Q.prepareBook('"Keep me." - Ines', "keep.txt").book;
  store.save(kept);

  storage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  const next = Q.prepareBook('"Replace me." - Bram', "next.txt").book;

  assert.deepEqual(store.save(next), { ok: false, reason: "storage" });
  assert.deepEqual(store.load(), kept);
});

test("a corrupt, absent or unreadable stored value reads as no book without throwing", () => {
  assert.equal(Q.createStore(fakeStorage()).load(), null, "absent");

  for (const raw of ["{not json", "null", "42", '"a string"', "[]", '{"quotes":"nope"}', '{"quotes":[]}', '{"quotes":[{"text":1,"author":2}]}']) {
    const storage = fakeStorage({ [Q.STORAGE_KEY]: raw });
    assert.equal(Q.createStore(storage).load(), null, "corrupt: " + raw);
  }

  const throwing = fakeStorage();
  throwing.getItem = () => {
    throw new Error("SecurityError");
  };
  assert.equal(Q.createStore(throwing).load(), null, "a getItem that throws");
  assert.equal(Q.createStore(null).load(), null, "no storage at all");
});

test("a stored book with some malformed entries keeps only the well-formed ones", () => {
  const raw = JSON.stringify({
    fileName: "mixed.txt",
    count: 3,
    quotes: [{ text: "Good.", author: "Ines" }, { text: 5, author: "Bram" }, null, { text: "Also good.", author: "Bram" }]
  });
  const book = Q.createStore(fakeStorage({ [Q.STORAGE_KEY]: raw })).load();

  assert.equal(book.count, 2, "the count is recomputed, never trusted");
  assert.deepEqual(book.quotes, [{ text: "Good.", author: "Ines" }, { text: "Also good.", author: "Bram" }]);
});

// ---------- matching an author to the roster (U5, KTD9) -----------------------

const roster = [
  { id: "p-jon", name: "Jon", color: "#f97316" },
  { id: "p-ines", name: "  Ines ", color: "#22c55e" },
  { id: "p-unknown", name: "Unknown", color: "#38bdf8" },
  { id: "p-sam-1", name: "Sam", color: "#facc15" },
  { id: "p-sam-2", name: "sam", color: "#ef4444" }
];

test("an author matching a roster name with different case or whitespace resolves to that person", () => {
  assert.equal(Q.matchAuthor("jon", roster).id, "p-jon");
  assert.equal(Q.matchAuthor("  JON\t", roster).id, "p-jon");
  assert.equal(Q.matchAuthor("ines", roster).id, "p-ines", "the roster side is trimmed too");
});

test("an author of Unknown never matches, even when a crew member is named Unknown", () => {
  assert.equal(Q.matchAuthor("Unknown", roster), null);
  assert.equal(Q.matchAuthor(" unknown ", roster), null);
});

test("a departed crew member, a multi-speaker author and junk all fall back to no match", () => {
  assert.equal(Q.matchAuthor("Marguerite", roster), null, "not on the roster");
  assert.equal(Q.matchAuthor("Jon, Ines", roster), null, "a multi-speaker exchange belongs to nobody");
  assert.equal(Q.matchAuthor("", roster), null);
  assert.equal(Q.matchAuthor(undefined, roster), null);
  assert.equal(Q.matchAuthor("Jon", undefined), null);
  assert.equal(Q.matchAuthor("Jon", [null, { name: 5 }, { id: "p-jon", name: "Jon" }]).id, "p-jon", "bad roster entries are skipped");
});

test("two crew members sharing a name resolve to the first in roster order, deterministically", () => {
  assert.equal(Q.matchAuthor("Sam", roster).id, "p-sam-1");
  assert.equal(Q.matchAuthor("SAM", roster).id, "p-sam-1");
});

// ---------- the order quotes are tried in (U5) --------------------------------

const fixedRandom = (value) => () => value;

test("the pick order visits every quote once, starting from a random one", () => {
  const order = Q.pickOrder(5, null, fixedRandom(0.5));
  assert.deepEqual(order.slice().sort(), [0, 1, 2, 3, 4]);
  assert.equal(order[0], 2, "starts where the random number lands");
  assert.deepEqual(Q.pickOrder(1, null, fixedRandom(0.99)), [0]);
  assert.deepEqual(Q.pickOrder(0, null, fixedRandom(0.5)), []);
});

test("the quote that is showing is tried last, so a re-pick shows a different one", () => {
  for (let showing = 0; showing < 4; showing += 1) {
    for (const r of [0, 0.3, 0.6, 0.99]) {
      const order = Q.pickOrder(4, showing, fixedRandom(r));
      assert.notEqual(order[0], showing, `showing ${showing}, random ${r}`);
      assert.equal(order[order.length - 1], showing);
      assert.deepEqual(order.slice().sort(), [0, 1, 2, 3]);
    }
  }
  // A book of one quote can only show that quote.
  assert.deepEqual(Q.pickOrder(1, 0, fixedRandom(0.5)), [0]);
  // A stale index from a replaced book is ignored.
  assert.deepEqual(Q.pickOrder(3, 7, fixedRandom(0)).slice().sort(), [0, 1, 2]);
});

test("clearing removes the quotebook key and leaves the app-state key untouched", () => {
  const storage = fakeStorage({ [APP_STATE_KEY]: '{"people":[]}' });
  const store = Q.createStore(storage);
  store.save(Q.prepareBook('"Keep me." - Ines', "keep.txt").book);

  assert.equal(store.clear(), true);
  assert.equal(storage.getItem(Q.STORAGE_KEY), null);
  assert.equal(storage.getItem(APP_STATE_KEY), '{"people":[]}');
  assert.equal(store.load(), null);
});
