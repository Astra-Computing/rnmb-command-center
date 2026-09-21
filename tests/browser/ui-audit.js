// UI layout audit. Not a pass/fail test — a diagnostic that walks every screen
// at several widths, measures the rendered DOM, and reports text that does not
// fit its box and fields that are the wrong size for what goes in them.
//
// Run inside the dev-env container, with the static server already up:
//   cd /workspace/projects/rnmb-command-center && python3 -m http.server 3000
//   PLAYWRIGHT_BROWSERS_PATH=/workspace/tools/playwright/browsers \
//     node /workspace/projects/rnmb-command-center/tests/browser/ui-audit.js [baseUrl]
//
// Exit code is 0 unless the page itself failed to drive; findings are the output.
"use strict";

const { chromium } = require("/workspace/tools/playwright/node_modules/playwright");

const baseUrl = (process.argv[2] || process.env.RNMB_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const ONLY = process.env.RNMB_AUDIT_ONLY || "";

// ---------- the in-page audit ---------------------------------------------------

/**
 * Runs inside the page. Returns findings as plain data. Every check is a
 * measurement rather than a rule of taste, so a finding always carries the
 * numbers that produced it.
 */
function auditInPage() {
  const findings = [];
  const seen = new Set();

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  };

  const path = (el) => {
    const bits = [];
    let node = el;
    while (node && node.nodeType === 1 && bits.length < 4) {
      let bit = node.tagName.toLowerCase();
      if (node.id) { bits.unshift(`${bit}#${node.id}`); break; }
      if (node.name) bit += `[name='${node.name}']`;
      else if (node.className && typeof node.className === "string") {
        const cls = node.className.trim().split(/\s+/).filter(Boolean)[0];
        if (cls) bit += `.${cls}`;
      }
      bits.unshift(bit);
      node = node.parentElement;
    }
    return bits.join(" > ");
  };

  const label = (el) => {
    const own = (el.value || el.placeholder || el.textContent || "").trim().replace(/\s+/g, " ");
    return own.length > 70 ? own.slice(0, 67) + "..." : own;
  };

  const push = (finding) => {
    const key = `${finding.kind}|${finding.where}|${finding.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(finding);
  };

  // Text measurement in the element's own font, for field-sizing checks.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const textWidth = (el, text) => {
    const s = getComputedStyle(el);
    ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    return ctx.measureText(text || "").width;
  };
  const horizontalPadding = (el) => {
    const s = getComputedStyle(el);
    return parseFloat(s.paddingLeft || 0) + parseFloat(s.paddingRight || 0) +
      parseFloat(s.borderLeftWidth || 0) + parseFloat(s.borderRightWidth || 0);
  };

  const elements = Array.from(document.querySelectorAll("body *")).filter(visible);

  for (const el of elements) {
    const style = getComputedStyle(el);
    const tag = el.tagName.toLowerCase();

    // ---- 1. text clipped by its own box ----
    const ownsText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (ownsText) {
      const overX = el.scrollWidth - el.clientWidth;
      if (overX > 1 && /hidden|clip/.test(style.overflowX)) {
        push({ kind: "text-clipped", where: path(el), text: label(el),
          detail: `${Math.round(overX)}px of text is cut off horizontally (content ${el.scrollWidth}px in a ${el.clientWidth}px box)` });
      }
      const overY = el.scrollHeight - el.clientHeight;
      if (overY > 1 && /hidden|clip/.test(style.overflowY)) {
        push({ kind: "text-clipped", where: path(el), text: label(el),
          detail: `${Math.round(overY)}px of text is cut off vertically (content ${el.scrollHeight}px in a ${el.clientHeight}px box)` });
      }
    }

    // ---- 2. content spilling outside its parent ----
    const parent = el.parentElement;
    if (parent && parent !== document.body && visible(parent)) {
      const pStyle = getComputedStyle(parent);
      if (/hidden|clip|visible/.test(pStyle.overflowX)) {
        const r = el.getBoundingClientRect();
        const pr = parent.getBoundingClientRect();
        const spill = Math.max(pr.left - r.left, r.right - pr.right);
        if (spill > 2 && pr.width > 0) {
          push({ kind: "spills-parent", where: path(el), text: label(el),
            detail: `sticks ${Math.round(spill)}px outside ${path(parent)}` });
        }
      }
    }

    // ---- 3 & 4. fields sized wrong for what they hold ----
    if (tag === "input" || tag === "select" || tag === "textarea") {
      const content = tag === "select"
        ? (el.options && el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : "")
        : (el.value || el.placeholder || "");
      const inner = el.clientWidth - horizontalPadding(el);
      const needed = textWidth(el, content) + (tag === "select" ? 22 : 2);

      if (content && inner > 0 && needed > inner + 2) {
        push({ kind: "field-too-small", where: path(el), text: label(el),
          detail: `"${content}" needs about ${Math.round(needed)}px but the field gives ${Math.round(inner)}px` });
      }
      // A field far wider than anything it can hold reads as a mistake.
      const isShort = /^(number)$/.test(el.type || "") || el.inputMode === "decimal" || /amount|ounces|size|level|abv|unit|markup|rounding|price/i.test(el.name || "");
      // 11rem is about the narrowest a field can be and still be a comfortable
      // tap target, so only flag boxes wider than that AND far wider than needed.
      if (isShort && content && inner > Math.max(176, needed * 4)) {
        push({ kind: "field-oversized", where: path(el), text: label(el),
          detail: `${Math.round(inner)}px wide for "${content}", which needs about ${Math.round(needed)}px` });
      }
    }

    // ---- 5. a control row whose items do not line up ----
    if (/flex/.test(style.display) && style.alignItems !== "flex-start" && style.alignItems !== "start") {
      const kids = Array.from(el.children).filter(visible);
      if (kids.length > 1) {
        const rect = el.getBoundingClientRect();
        const sameRow = kids.every((k) => Math.abs(k.getBoundingClientRect().top - kids[0].getBoundingClientRect().top) < 4);
        const controls = kids.filter((k) => /^(input|select|button|a)$/.test(k.tagName.toLowerCase()));
        if (sameRow && controls.length > 1 && rect.width > 0) {
          const heights = controls.map((k) => Math.round(k.getBoundingClientRect().height));
          const spread = Math.max(...heights) - Math.min(...heights);
          if (spread > 4) {
            push({ kind: "row-uneven", where: path(el), text: label(el),
              detail: `controls in one row are ${heights.join(", ")}px tall` });
          }
        }
      }
    }
  }

  // ---- 6. the page itself scrolls sideways ----
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) {
    const culprits = elements
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 5)
      .map((el) => path(el));
    push({ kind: "page-scrolls-sideways", where: "document", text: "",
      detail: `page is ${doc.scrollWidth}px wide in a ${window.innerWidth}px window; widest: ${culprits.join(" | ") || "unknown"}` });
  }

  return findings;
}

// ---------- driving the screens -------------------------------------------------

async function openPage(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#personList", { state: "attached" });
  await page.waitForTimeout(150);
  return { page, context, errors };
}

const tab = (page, name) => page.click(`.tab-button[data-tab="${name}"]`);

/** A host night with an open tab, a rung-up drink and a crew drink, so the register is full. */
async function seedHostNight(page) {
  await page.evaluate(async () => {
    const r = window.__rnmb;
    const night = { id: crypto.randomUUID(), name: "Audit night", date: new Date().toISOString().slice(0, 10), kind: "host" };
    await r.hostAction("", (db) => db.startHostNight(night));
    const tabId = crypto.randomUUID();
    await r.hostAction("", (db) => db.openTab({ id: tabId, nightId: night.id, guestName: "Bartholomew Wingfield-Smythe" }));
    await r.hostAction("", (db) => db.openTab({ id: crypto.randomUUID(), nightId: night.id, guestName: "Jo" }));
    r.render();
  });
  await page.waitForTimeout(150);
}

const screens = [
  { name: "Overview", go: async (page) => { await tab(page, "overview"); } },
  { name: "Tonight", go: async (page) => { await tab(page, "tonight"); } },
  {
    name: "Tonight / quick log picked",
    go: async (page) => {
      await tab(page, "tonight");
      const person = page.locator("#quickLogPeople [data-quick-person]").first();
      if (await person.count()) await person.click();
    }
  },
  { name: "Inventory", go: async (page) => { await tab(page, "inventory"); } },
  {
    name: "Inventory / counted type selected",
    go: async (page) => {
      await tab(page, "inventory");
      await page.selectOption("#typeForm [name='measure']", "unit").catch(() => {});
    }
  },
  { name: "Menu", go: async (page) => { await tab(page, "menu"); } },
  {
    name: "Menu / editing an item",
    go: async (page) => {
      await tab(page, "menu");
      const edit = page.locator("#menuList [data-edit-menu-item]").first();
      if (await edit.count()) await edit.click();
    }
  },
  { name: "Ledger", go: async (page) => { await tab(page, "ledger"); } },
  { name: "Crew", go: async (page) => { await tab(page, "crew"); } },
  {
    name: "Register / empty",
    go: async (page) => { await seedHostNight(page); await page.evaluate(() => { location.hash = "#register"; }); await page.waitForTimeout(200); }
  },
  {
    name: "Register / drink and target picked",
    go: async (page) => {
      await seedHostNight(page);
      await page.evaluate(() => { location.hash = "#register"; });
      await page.waitForTimeout(200);
      const item = page.locator("#registerMenu [data-register-item]").first();
      if (await item.count()) await item.click();
      const target = page.locator("#registerTabs [data-register-tab]").first();
      if (await target.count()) await target.click();
      await page.waitForTimeout(150);
    }
  }
];

const widths = [
  { label: "1440", viewport: { width: 1440, height: 1000 } },
  { label: "1024", viewport: { width: 1024, height: 900 } },
  { label: "400", viewport: { width: 400, height: 900 } }
];

async function main() {
  const browser = await chromium.launch();
  const all = [];
  try {
    for (const width of widths) {
      for (const screen of screens) {
        if (ONLY && !screen.name.toLowerCase().includes(ONLY.toLowerCase())) continue;
        const { page, context, errors } = await openPage(browser, width.viewport);
        try {
          await screen.go(page);
          await page.waitForTimeout(120);
          const findings = await page.evaluate(auditInPage);
          findings.forEach((f) => all.push({ ...f, screen: screen.name, width: width.label }));
          errors.forEach((e) => all.push({ kind: "page-error", where: "page", text: "", detail: e, screen: screen.name, width: width.label }));
        } catch (error) {
          all.push({ kind: "audit-failed", where: "driver", text: "", detail: String(error.message).split("\n")[0], screen: screen.name, width: width.label });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Group identical findings across widths so one defect reports once.
  const grouped = new Map();
  for (const f of all) {
    const key = `${f.kind}|${f.where}|${f.text}|${f.detail}`;
    if (!grouped.has(key)) grouped.set(key, { ...f, widths: new Set(), screens: new Set() });
    grouped.get(key).widths.add(f.width);
    grouped.get(key).screens.add(f.screen);
  }

  const order = ["page-error", "audit-failed", "page-scrolls-sideways", "text-clipped", "spills-parent", "field-too-small", "field-oversized", "row-uneven"];
  const rows = Array.from(grouped.values()).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  console.log(`UI audit against ${baseUrl}\n${"=".repeat(60)}`);
  if (!rows.length) {
    console.log("No layout findings.");
    return;
  }
  let current = "";
  for (const row of rows) {
    if (row.kind !== current) {
      current = row.kind;
      console.log(`\n## ${current}  (${rows.filter((r) => r.kind === current).length})`);
    }
    console.log(`- ${row.where}`);
    if (row.text) console.log(`    text: "${row.text}"`);
    console.log(`    ${row.detail}`);
    console.log(`    at ${Array.from(row.widths).sort().join(", ")}px on: ${Array.from(row.screens).join("; ")}`);
  }
  console.log(`\n${rows.length} distinct findings across ${screens.length} screens x ${widths.length} widths.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
