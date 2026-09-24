/*
 * quotebook.js — turns a pasted or uploaded quotebook into quote-and-author pairs.
 *
 * A classic browser script (no build step, no imports, no dependencies). It
 * defines ONE global, `RNMBQuotebook`, and when loaded by Node
 * (`require("./quotebook.js")`) exports the same object, so tests/quotebook.test.js
 * exercises exactly the code the page runs. Nothing here touches the DOM, the
 * network, storage or the clock — quote text goes in as a string and comes back
 * as objects, and this file never holds on to either.
 *
 * ── Provenance ──────────────────────────────────────────────────────────────
 * Ported from the [UN]Quotable repo (Astra-Computing/applications),
 *   src/lib/parseQuotes.ts @ commit 9c2801ff7f22bcafa78ed59308f546921a6f56e3
 * TypeScript → ES5 browser JS. The whole case set ports, not a smoke subset: the
 * detection order, every guard and every comment explaining a guard are the
 * original's, because those guards are the accumulated answer to real quotebooks.
 *
 * Deliberate deltas from the original:
 *   1. `sortAuthor` is dropped. It only ever served bracket seeding in
 *      [UN]Quotable; this dashboard has no bracket, so a quote is { text, author }.
 *   2. `normalizeText` is new (KTD3) and runs before the line split. A book
 *      exported from Notepad, Word or a chat client arrives with a BOM, CRLF or
 *      CR line endings, and curly double quotation marks; all three now parse the
 *      same as the clean equivalent. This also fixes a latent bug carried over
 *      from the original: its SPEAKER_RE comment claims to match curly quote
 *      marks, but the character class is ASCII-only, so `Ines: “Open up.”` fell
 *      through to the no-attribution branch with the speaker's name stuck to the
 *      front of the text. Folding the curly doubles ahead of the regex fixes it.
 *      The RIGHT SINGLE quotation mark (U+2019) is deliberately LEFT ALONE: the
 *      ported parser treats it as a closing-quote character, so folding it would
 *      move where attribution is read from.
 *
 * ── Formats handled, in order of detection ──────────────────────────────────
 * The only hard rule: one quote (or exchange) per line. Blank lines are skipped.
 *
 *  Multi-speaker (tab, 2+ spaces, or simply starting at the line's head)
 *    Corbin: "text"[TAB]Jeron: "text"[TAB]Jon: "text"
 *    → text = each turn on its own line, author = "Corbin, Jeron, Jon"
 *
 *  Standard with attribution after the closing quote
 *    "Quote text" - Author      "Quote text" — Author    (em dash)
 *    "Quote text"-Author        (context) "Quote text" - Author
 *    "Quote - with - dashes" - Author   ← dashes inside the text are safe
 *
 *  Unquoted with attribution
 *    Quote text — Author        Quote text - Author      Author: Quote text
 *
 *  No attribution
 *    "Quote text"   /   Quote text        → author = "Unknown"
 *
 * ── The local store (U2) ─────────────────────────────────────────────────────
 * The crew's quotes are the most private thing the group has, so the parsed book
 * lives under its OWN browser storage key (KTD2) and nowhere else: never on the
 * app `state` object (normalizeState would drop it, and archiveData() would ship
 * it in every export first), never in Supabase. The store takes its storage as a
 * parameter so node --test can drive it with a fake; app.js passes localStorage.
 *
 * Exported API:
 *   normalizeText(rawText) -> string     BOM stripped, newlines folded, curly
 *                                        double quote marks folded to ASCII "
 *   parseQuotebook(rawText) -> [{ text, author }]
 *   prepareBook(rawText, fileName) -> { ok: true, book } | { ok: false, reason }
 *                                        reason: "empty" | "too-large"
 *   createStore(storage) -> { load() -> book | null,
 *                             save(book) -> { ok: true } | { ok: false, reason },
 *                             clear() -> boolean }
 *                                        reason: "too-large" | "storage"
 *   STORAGE_KEY, MAX_STORED_CHARS
 * A book is { fileName, count, quotes: [{ text, author }] }.
 */

var RNMBQuotebook = (function () {
  "use strict";

  var UNKNOWN_AUTHOR = "Unknown";

  // Speaker pattern: Name: "text". Curly double quote marks are folded to ASCII
  // by normalizeText before this ever runs, so the class only needs ASCII ".
  var SPEAKER_RE = /(\w[\w\s.']*?)\s*:\s*"([^"]*?)"/g;

  // Closing quote characters: ASCII ", curly " (U+201D), right single ' (U+2019).
  var CLOSE_QUOTES = ['"', "”", "’"];
  // Opening quote characters: ASCII ", and the curly and low-9 double and single marks.
  var OPEN_QUOTES = ['"', "“", "„", "‘", "‚"];

  // A bare word that can serve as an attribution. Lowercase is allowed because
  // quotebooks routinely write a bare first name in lower case.
  var NAME_WORD = /^[A-Za-z][\w.'’-]*$/;
  var CAPITALISED_WORD = /^[A-Z][\w.'’-]*$/;
  // One to three capitalised words — the guard on the unquoted `Name: text` form.
  var SPEAKER_PREFIX = /^[A-Z][\w.'’-]*(?:\s+[A-Z][\w.'’-]*){0,2}$/;

  /**
   * KTD3. Make a book exported from Notepad, Word or a chat client look like a
   * clean one before the parser sees a single line.
   *   - strip a leading byte-order mark
   *   - fold CRLF and bare CR to \n
   *   - fold curly/low-9 DOUBLE quotation marks to ASCII "
   * U+2019 (right single quotation mark) is untouched on purpose — see the
   * deltas note in the file header.
   */
  function normalizeText(rawText) {
    if (typeof rawText !== "string") return "";
    return rawText
      .replace(/^﻿/, "")
      .replace(/\r\n|\r/g, "\n")
      .replace(/[“”„‟]/g, '"');
  }

  function parseQuotebook(rawText) {
    var lines = normalizeText(rawText).split("\n");
    var quotes = [];
    for (var i = 0; i < lines.length; i++) {
      var quote = parseQuoteLine(lines[i]);
      if (quote !== null) quotes.push(quote);
    }
    return quotes;
  }

  function parseQuoteLine(raw) {
    var line = raw.trim();
    if (!line) return null;

    // ── 1. Speaker detection (single or multi) ──────────────────────────────
    // Run SPEAKER_RE unconditionally to collect all Name: "text" segments.
    // Multi-speaker: 2+ segments separated by tab / 2+ spaces.
    // Single-speaker: exactly 1 segment starting at position 0 (e.g. Jon: "Quote").
    SPEAKER_RE.lastIndex = 0;
    var speakers = [];
    var turns = [];
    var firstMatchIdx = -1;
    var match;
    while ((match = SPEAKER_RE.exec(line)) !== null) {
      if (firstMatchIdx < 0) firstMatchIdx = match.index;
      speakers.push(match[1].trim());
      turns.push(match[2].trim());
    }
    // A tab or 2+ spaces is the *usual* separator, but real quotebooks also
    // write exchanges with a single space: `Jack: "..." Max:"Myth."`. Two or
    // more `Name: "quoted"` segments starting at the very beginning of the line
    // is already unambiguous on its own, so accept that too — otherwise the
    // line falls all the way through to the no-attribution branch and the
    // speakers' names end up embedded in the quote text.
    if (speakers.length >= 2 && (firstMatchIdx === 0 || /\t| {2,}/.test(line))) {
      return {
        text: turns
          .map(function (turn) {
            return '"' + turn + '"';
          })
          .join("\n"),
        author: dedupe(speakers).join(", ")
      };
    }
    if (speakers.length === 1 && firstMatchIdx === 0) {
      return { text: turns[0], author: speakers[0] };
    }

    // ── 2. Attribution after the last closing-quote character ───────────────
    // This is the most reliable approach: find where the quoted text ends, then
    // check what follows. Dashes INSIDE the quote are completely ignored.
    var closeIdx = lastIndexOfChars(line, CLOSE_QUOTES);
    if (closeIdx > 0) {
      var attribution = matchAttribution(line.slice(closeIdx + 1));
      if (attribution !== undefined) {
        return {
          text: stripOuterQuotes(line.slice(0, closeIdx + 1)),
          author: attribution || UNKNOWN_AUTHOR
        };
      }
      // Something follows the close-quote that isn't an attribution — fall through.
    }

    // ── 3. Em / en dash anywhere in the line (unquoted lines) ───────────────
    var dashIdx = lastIndexOfChars(line, ["—", "–"]);
    if (dashIdx > 0) {
      var dashText = line.slice(0, dashIdx).replace(/\s+$/, "");
      var dashAuthor = line.slice(dashIdx + 1).trim();
      if (dashText && dashAuthor) {
        return { text: stripOuterQuotes(dashText), author: dashAuthor };
      }
    }

    // ── 4. Spaced hyphen " - " ───────────────────────────────────────────────
    var hyphenIdx = line.lastIndexOf(" - ");
    if (hyphenIdx > 0) {
      var hyphenText = line.slice(0, hyphenIdx).trim();
      var hyphenAuthor = line.slice(hyphenIdx + 3).trim();
      if (hyphenText && hyphenAuthor) {
        return { text: stripOuterQuotes(hyphenText), author: hyphenAuthor };
      }
    }

    // ── 4b. Unquoted speaker form: `Jon: What exactly is this proving out?` ──
    // Deliberately last, so every quote-aware strategy above gets first refusal
    // and this can only ever rescue a line that would otherwise be filed as
    // Unknown with the speaker's name still stuck to the front of the text.
    //
    // The name is held to one-to-three capitalised words. That guard is the whole
    // reason this is safe: `I have one rule: never lie` is four words and stays a
    // quote, where a looser rule would attribute it to "I have one rule".
    var colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      var name = line.slice(0, colonIdx).trim();
      var rest = line.slice(colonIdx + 1).trim();
      if (rest && SPEAKER_PREFIX.test(name)) {
        return { text: stripOuterQuotes(rest), author: name };
      }
    }

    // ── 5. No attribution found ──────────────────────────────────────────────
    return { text: stripOuterQuotes(line), author: UNKNOWN_AUTHOR };
  }

  /**
   * Given the string that comes after the last closing quote, returns:
   *   string    — the attribution text (empty string means "no attribution")
   *   undefined — the content isn't an attribution pattern; caller should fall through
   */
  function matchAttribution(after) {
    var s = after.replace(/^\s+/, "");
    if (!s) return ""; // Line ends cleanly at the closing quote — no attribution.

    // Em / en dash: "—Author" or "— Author"
    if (s.charAt(0) === "—" || s.charAt(0) === "–") {
      return s.slice(1).trim() || UNKNOWN_AUTHOR;
    }

    // Spaced hyphen: "- Author" (space required after the dash)
    if (s.indexOf("- ") === 0 || s.indexOf("-\t") === 0) {
      return s.slice(2).trim() || UNKNOWN_AUTHOR;
    }

    // Bare hyphen directly before a word: "-Author" (common in personal quotebooks)
    if (s.charAt(0) === "-" && s.length > 1 && /\w/.test(s.charAt(1))) {
      return s.slice(1).trim() || UNKNOWN_AUTHOR;
    }

    // Bare name, no separator at all: `"quote text" jeron`. Guarded, because the
    // same position can hold narration — `"Hello" he said` must NOT be attributed
    // to "he said". A single word is taken as a name (quotebooks often use a bare
    // first name, lowercase included); two or three words are taken only when
    // every one of them is capitalised.
    var words = s.split(/\s+/);
    if (words.length === 1 && NAME_WORD.test(words[0])) return s;
    if (words.length <= 3 && words.every(isCapitalisedWord)) return s;

    // Content present but not an attribution pattern (e.g. more quote text follows).
    return undefined;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function isCapitalisedWord(word) {
    return CAPITALISED_WORD.test(word);
  }

  function lastIndexOfChars(s, chars) {
    for (var i = s.length - 1; i >= 0; i--) {
      if (chars.indexOf(s.charAt(i)) !== -1) return i;
    }
    return -1;
  }

  /**
   * Strip one layer of wrapping quote characters from both ends.
   * Only strips if the first char is an open-quote AND the last is a close-quote
   * (so inner dialogue quotes are never accidentally removed).
   */
  function stripOuterQuotes(s) {
    var trimmed = s.trim();
    if (trimmed.length < 2) return trimmed;
    var first = trimmed.charAt(0);
    var last = trimmed.charAt(trimmed.length - 1);
    if (OPEN_QUOTES.indexOf(first) !== -1 && CLOSE_QUOTES.indexOf(last) !== -1) {
      return trimmed.slice(1, -1).trim();
    }
    return trimmed;
  }

  function dedupe(values) {
    var seen = [];
    for (var i = 0; i < values.length; i++) {
      if (seen.indexOf(values[i]) === -1) seen.push(values[i]);
    }
    return seen;
  }

  // ── The local store ────────────────────────────────────────────────────────

  var STORAGE_KEY = "rnmb-quotebook-v1";

  // KTD11: 256 KB, for quota headroom rather than parse cost. localStorage is one
  // ~5 MB budget per origin shared with the app-state key, and commitSave writes
  // app state AFTER the Supabase write has succeeded, so a book that ate the
  // quota would make a later pour report a failure that did not happen. Measured
  // in UTF-16 code units, which is how browsers count against that quota.
  var MAX_STORED_CHARS = 256 * 1024;

  function isQuote(value) {
    return Boolean(value) && typeof value.text === "string" && typeof value.author === "string" && value.text.length > 0;
  }

  function makeBook(fileName, quotes) {
    return {
      fileName: typeof fileName === "string" && fileName ? fileName : "quotebook.txt",
      count: quotes.length,
      quotes: quotes
    };
  }

  /**
   * Parse an upload into a storable book, or say why it cannot be one. Nothing is
   * written here: the caller saves only an ok result, so a failed upload can never
   * replace the book already loaded (6.11.5, 6.11.7).
   */
  function prepareBook(rawText, fileName) {
    var quotes = parseQuotebook(rawText);
    if (!quotes.length) return { ok: false, reason: "empty" };
    var book = makeBook(fileName, quotes);
    if (JSON.stringify(book).length > MAX_STORED_CHARS) return { ok: false, reason: "too-large" };
    return { ok: true, book: book };
  }

  /** A stored value back into a book; anything unusable reads as no book. */
  function parseStored(raw) {
    if (typeof raw !== "string" || !raw) return null;
    var value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return null;
    }
    if (!value || typeof value !== "object" || !Array.isArray(value.quotes)) return null;
    var quotes = [];
    for (var i = 0; i < value.quotes.length; i++) {
      var quote = value.quotes[i];
      if (isQuote(quote)) quotes.push({ text: quote.text, author: quote.author });
    }
    return quotes.length ? makeBook(value.fileName, quotes) : null;
  }

  function defaultStorage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (error) {
      return null; // Some privacy modes throw on the mere property access.
    }
  }

  /**
   * Every storage call is wrapped: a quotebook failure must never surface as the
   * failure of an unrelated action (6.11.7), and a broken key must never stop the
   * dashboard booting.
   */
  function createStore(storage) {
    var target = storage === undefined ? defaultStorage() : storage;

    return Object.freeze({
      load: function () {
        if (!target) return null;
        try {
          return parseStored(target.getItem(STORAGE_KEY));
        } catch (error) {
          return null;
        }
      },
      save: function (book) {
        var serialised = JSON.stringify(book);
        if (serialised.length > MAX_STORED_CHARS) return { ok: false, reason: "too-large" };
        if (!target) return { ok: false, reason: "storage" };
        try {
          target.setItem(STORAGE_KEY, serialised);
          return { ok: true };
        } catch (error) {
          // A refused setItem leaves the previous value in place.
          return { ok: false, reason: "storage" };
        }
      },
      clear: function () {
        if (!target) return false;
        try {
          target.removeItem(STORAGE_KEY);
          return true;
        } catch (error) {
          return false;
        }
      }
    });
  }

  return Object.freeze({
    STORAGE_KEY: STORAGE_KEY,
    MAX_STORED_CHARS: MAX_STORED_CHARS,
    normalizeText: normalizeText,
    parseQuotebook: parseQuotebook,
    prepareBook: prepareBook,
    createStore: createStore
  });
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = RNMBQuotebook;
}
