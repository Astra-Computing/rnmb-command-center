# RNMB Command Center

A dependency-free dashboard for tracking group beverage inventory, spending, night-by-night consumption, and who owes whom.

## Features

- Shared Supabase persistence for people, beverage types, bottle purchases, and night logs
- U.S. standard drink calculations using fluid ounces and ABV
- Every volume field has a unit dropdown (oz, ml, cl, L) beside it and is stored in ounces; a unit typed into the box wins over the dropdown
- One running balance per person: every drink costs the drinker what it drew, and credits whoever bought it
- Quick log: two taps on a phone to record a drink, and an end-of-night recap to fix what was missed
- Inventory depletion tracking when pours are logged
- JSON export/import for backup or migration
- Host mode: a bar register for nights with guests, with a menu, recipes, guest tabs and cost-plus-markup prices
- Quotebook: load the crew's quotes from a `.txt` and the Overview shows one at random; the book never leaves the browser it was loaded in

## Supabase Setup

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run [supabase/schema.sql](supabase/schema.sql).
4. Copy your project URL and anon public key from Supabase project settings.
5. Add these Vercel environment variables:

```bash
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your-anon-public-key
```

The anon (publishable) key is expected to be public. Every table is gated by row-level security that checks a shared passphrase: set it in [supabase/rls-passphrase.sql](supabase/rls-passphrase.sql) before anyone uses the dashboard. Each browser asks for it once. Add Supabase Auth before sharing the URL broadly.

For a project created before host mode existed, also run [supabase/host-mode.sql](supabase/host-mode.sql) (see Host Mode below), then [supabase/crew-balance.sql](supabase/crew-balance.sql) (see Crew Balances below). Both are safe to run more than once, and they must be run in that order.

## Run Locally

```bash
python3 -m http.server 3000
```

Open `http://localhost:3000`. In the workspace's `dev-env` container, port 3000 is the only port published to the host.

The plain Python server cannot run the Vercel `/api/config` function, so local Python mode uses browser `localStorage`. To test Supabase locally, use Vercel CLI with the same env vars:

```bash
vercel dev
```

## Crew Balances

Nobody splits the bill evenly. Each crew member carries one running balance in whole cents, and it reads the same on every device because it is worked out from the records themselves — purchases, drinks, tabs and payments — every time a screen is drawn. No balance is stored anywhere, so no balance can drift.

**How a balance moves:**

- **Buying a bottle credits you only as it is drunk.** Liquor still on the shelf is still yours. Each drink drawn from your bottle credits you what that measure cost.
- **Every logged drink costs the drinker at cost** — the bottle's price spread over its size, no markup — and credits the buyers of the stock it drew. A drink out of your own bottle nets to zero.
- **A downward stock correction costs nobody.** Liquor spilt, lost or never logged is the buyer's loss, not a charge on the crew.
- **Guest money runs through the same balances.** A paid tab credits each bottle's buyer their share of the price and leaves the crew member who collected the cash carrying it until they pass it on. A written-off tab is charged to whoever wrote it off.
- **Paying someone back is recorded, not assumed.** Send the Venmo, then log it under **Ledger → Record a Payment**; it moves both balances by the amount. A payment logged by mistake is voided, never deleted.

**Ledger → Crew Balances** shows who is owed and who owes, and under it *Fewest payments to square up*: the shortest list of transfers that settles everyone, each with a *Paid* button to record it once the money has actually moved. Every balance together always adds up to zero, and a crew member whose balance is not zero cannot be removed from the roster until they are settled.

That rule is enforced twice against the shared database, because two phones can be working from copies of the balances minutes apart. The dashboard checks what it knows and gives the friendly message; the database then re-checks the records themselves, and refuses only what the delete would actually destroy. Removing somebody deletes the drinks they drank, so a drink of theirs that cost money keeps them on the roster until it is voided — otherwise whoever bought that bottle would silently lose the credit. Every other record that names them — a payment, a crew drink, stock they bought that was poured from, a guest tab they collected or wrote off — keeps their name beside the emptied link, so the money on it survives them and they can leave once they are square.

### Logging a drink

**Tonight → Quick Log** is built for a phone: tap who is drinking, then tap what they are having. The second row offers that person's usual — the last eight things they logged — or the whole shelf the first time. Tapping a bottle logs one measure of it (1.5 oz, or one unit of counted stock like a can). Tapping a menu item rings the whole recipe up at once, drawing every ingredient from stock. Either way the drinker is charged at cost and the buyers are credited straight away.

### Ending a crew night

**Tonight → Wrap Up → End night** ends the night and opens the recap: one card per person who drank, listing every drink they had, what it drew and what it cost them, with their totals for the night.

Nothing waits on the recap. Balances moved as each drink was logged, so ending a night moves no money — it is a review, not a confirmation step. An ended crew night stays editable on purpose:

- **Void** puts a drink back: the stock returns and both balances go back to where they were.
- **Add a missed drink** points the quick log at that person and that night, so a forgotten round lands where it belongs.

An ended *host* night behaves differently: it only ends once every guest tab is closed, and it locks afterwards.

### Rolling crew balances out

1. Deploy the client first.
2. Run [supabase/crew-balance.sql](supabase/crew-balance.sql) in the Supabase SQL editor. It needs [supabase/host-mode.sql](supabase/host-mode.sql) to have been run first, and it is safe to run more than once.
3. Run [supabase/checks/crew-balance-checks.sql](supabase/checks/crew-balance-checks.sql). It tests every rule inside a transaction it rolls back, and returns one row with the number of checks passed (11).
4. Reload every crew device, including the register.

**The client goes first on purpose.** The new client sends no crew-balance column and no write-off author until it sees that the migration has run, so it behaves exactly like the old one against a database that has not had it yet. The other order is the one that breaks: the migrated `rnmb_close_tab` refuses a write-off that names nobody, an un-upgraded phone never sends an author, and a host night cannot end while a tab is still open — so one stale device could be stuck mid-service. Running the client first means that pairing never happens.

Until the SQL has been run the app still works: the Ledger names the file to run and shows no balances rather than wrong ones, payments and ending a crew night are refused, pours save without their cost stamp, and a guest tab is written off plainly — no author is asked for and nothing claims a charge, because there is nowhere to record one. Pours logged before the migration carry no cost, so they charge nobody.

## Host Mode

Host mode replaces a flat cover charge with a tab per guest.

**Set up (in the dashboard):**

1. **Inventory**: add stock types. Choose *Poured, ounces* for spirits, liqueurs and fluid mixers (mixers use ABV 0) or *Counted, units* for cans and bottled drinks (give the volume of one unit). Then add the stock you bought, with its price and who paid.

   Anywhere a **volume** is asked for — a bottle's size, a pour, a recipe ingredient, a unit's volume, or setting a level by hand — the box takes a number and the **dropdown beside it** takes the unit: oz, ml, cl or L. Type `750`, pick `ml`, and it stores 25.36 oz. If you paste a unit into the box instead (`750 ml`), that wins over the dropdown. The one exception is the **count** of counted stock (how many cans you bought), which is a number of units and not a volume, so it has no dropdown at all.
2. **Menu**: build cocktails, straight pours and counted items from those types, and set the markup percentage and the rounding step. Each item shows the price it would ring up at right now, or *Unavailable* when stock can't cover it.
3. **Tonight**: start a night and choose *Host night*, then follow *Open register*.

**At the bar:** the register lives at `#register` (for example `https://<your-site>/#register`), so the bartender's device can bookmark it. Pick a menu item, then a guest's tab (or open one by name) or a crew member. Check the bottle each ingredient pours from, switch it or add a second bottle when one runs out, and confirm. The price is locked when you confirm. A crew drink is never put on a guest tab: it costs the crew member what it drew, at cost, with no markup.

**Closing out:** each open tab is closed as *Paid* (choose who collected the money; the amount is the tab total) or *Write off* (choose who is writing it off — they cover what its drinks cost). *End night* works once every tab is closed. **Ledger → Host Nights** shows what each collector holds and which buyers it belongs to, plus the value written off from each buyer's stock. Both feed the crew balances: the collector carries what they collected, and a write-off lands on whoever wrote it off.

Each host night's card also lists the **crew drinks** charged on it — the drinks and pours that went to a crew member rather than onto a guest's tab — with a *Void* button on each. That stays available after the night ends, which is the one thing an ended host night still allows. A guest item does not: its tab total was counted as cash when the night closed, so it is frozen. A crew drink was only ever charged at cost to one person's balance and sits on no tab, so a drink rung up to the wrong crew member can still be put right. Voiding one returns the stock and moves the balance back.

A red *This browser only* banner on the register means nothing is being saved to the shared database.

### Rolling host mode out

1. Run [supabase/host-mode.sql](supabase/host-mode.sql) in the Supabase SQL editor.
2. Run [supabase/checks/host-mode-checks.sql](supabase/checks/host-mode-checks.sql). It tests every rule inside a transaction it rolls back, and returns one row with the number of checks passed.
3. Deploy the client straight away.
4. Reload every crew device, including the register, before the first host night.

The app still works if the SQL has not been run yet: the Menu tab and register say which file to run, and ordinary saves send exactly what they sent before.

## Quotebook

**The quotebook does not sync.** It is kept in the one browser it was loaded in and nowhere else: it is never sent to the shared database, never put in an export or a backup, and it does not come back with an import. Every phone and laptop that should show quotes needs the book loaded on it separately.

**Loading it:** **Crew → Crew Quotes → Load quotebook (.txt)**. Pick a plain text file with one quote per line. Lines like these all work:

```text
"The keg is a mood." - Ines
"The keg is a mood." — Ines
Ines: The keg is a mood.
Ines: "Open up."   Bram: "It is open."
```

The last is an exchange: separate the speakers with a tab or two spaces and each turn gets its own line on the card. A line with no name is filed under *Unknown*. A file saved from Notepad, Word or a chat app is fine as it is.

Loading a new file replaces the old one. A file with no quotes in it, or one over 256 KB, is refused and the book already loaded stays. **Clear quotebook** removes it from this browser only; clearing, importing or reloading the dashboard's data leaves the quotebook alone.

**On the Overview** the quote is the first card. It is not there at all until a book is loaded. It shows a new quote each time the Overview comes into view and whenever it is tapped (or focused and Enter or Space pressed), and it keeps the same one while the dashboard updates underneath it. A long quote gets smaller type rather than being cut off; a quote too long to fit the card at its smallest type is skipped. When the quote is attributed to someone on the roster, the card takes their colour.

## Tests

No dependencies are needed. From the workspace, run them inside the `dev-env` container:

```bash
# balances, settlement, pricing, stock, summaries, and the quotebook parser and store
docker exec dev-env node --test /workspace/projects/rnmb-command-center/tests/

# end-to-end browser checks (serve the app on port 3000 first)
docker exec -e PLAYWRIGHT_BROWSERS_PATH=/workspace/tools/playwright/browsers dev-env node /workspace/projects/rnmb-command-center/tests/browser/host-mode.smoke.js

# layout audit: text that does not fit its box, at ten widths (a report, not pass/fail)
docker exec -e PLAYWRIGHT_BROWSERS_PATH=/workspace/tools/playwright/browsers dev-env node /workspace/projects/rnmb-command-center/tests/browser/ui-audit.js
```

From Git Bash, prefix `docker exec` with `MSYS_NO_PATHCONV=1`.

Every quotebook used by the tests is made up (`tests/fixtures/parser/`). Never test with the crew's real book: the layout audit prints the text of anything it flags. A real book saved in this folder as `quotebook*.txt` is ignored by git, and `.vercelignore` keeps it out of a deploy.

## Deploy on Vercel

Import the repository into Vercel, add the Supabase env vars, and deploy. You can also deploy from the CLI:

```bash
vercel
```

No build command is required.
