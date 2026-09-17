# RNMB Command Center

A dependency-free dashboard for tracking group beverage inventory, spending, night-by-night consumption, and who owes whom.

## Features

- Shared Supabase persistence for people, beverage types, bottle purchases, and night logs
- U.S. standard drink calculations using fluid ounces and ABV
- One running balance per person: every drink costs the drinker what it drew, and credits whoever bought it
- Quick log: two taps on a phone to record a drink, and an end-of-night recap to fix what was missed
- Inventory depletion tracking when pours are logged
- Responsible-use pace checks and hydration reminders
- JSON export/import for backup or migration
- Host mode: a bar register for nights with guests, with a menu, recipes, guest tabs and cost-plus-markup prices

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

### Logging a drink

**Tonight → Quick Log** is built for a phone: tap who is drinking, then tap what they are having. The second row offers that person's usual — the last eight things they logged — or the whole shelf the first time. Tapping a bottle logs one measure of it (1.5 oz, or one unit of counted stock like a can). Tapping a menu item rings the whole recipe up at once, drawing every ingredient from stock. Either way the drinker is charged at cost and the buyers are credited straight away.

### Ending a crew night

**Tonight → Wrap Up → End night** ends the night and opens the recap: one card per person who drank, listing every drink they had, what it drew and what it cost them, with their totals for the night.

Nothing waits on the recap. Balances moved as each drink was logged, so ending a night moves no money — it is a review, not a confirmation step. An ended crew night stays editable on purpose:

- **Void** puts a drink back: the stock returns and both balances go back to where they were.
- **Add a missed drink** points the quick log at that person and that night, so a forgotten round lands where it belongs.

An ended *host* night behaves differently: it only ends once every guest tab is closed, and it locks afterwards.

### Rolling crew balances out

1. Run [supabase/crew-balance.sql](supabase/crew-balance.sql) in the Supabase SQL editor. It needs [supabase/host-mode.sql](supabase/host-mode.sql) to have been run first, and it is safe to run more than once.
2. Run [supabase/checks/crew-balance-checks.sql](supabase/checks/crew-balance-checks.sql). It tests every rule inside a transaction it rolls back, and returns one row with the number of checks passed.
3. Deploy the client straight away.
4. Reload every crew device, including the register, before the next night.

**Run the SQL before deploying the new client and the live register will refuse write-offs.** The migration makes a tab write-off name the crew member writing it off, and the deployed client does not send one yet. Keep the gap between step 1 and step 3 as short as you can.

Until the SQL has been run the app still works: the Ledger names the file to run and shows no balances rather than wrong ones, payments and ending a crew night are refused, and pours save without their cost stamp. Pours logged before the migration carry no cost, so they charge nobody.

## Host Mode

Host mode replaces a flat cover charge with a tab per guest.

**Set up (in the dashboard):**

1. **Inventory**: add stock types. Choose *Poured, ounces* for spirits, liqueurs and fluid mixers (mixers use ABV 0) or *Counted, units* for cans and bottled drinks (give the volume of one unit). Then add the stock you bought, with its price and who paid.
2. **Menu**: build cocktails, straight pours and counted items from those types, and set the markup percentage and the rounding step. Each item shows the price it would ring up at right now, or *Unavailable* when stock can't cover it.
3. **Tonight**: start a night and choose *Host night*, then follow *Open register*.

**At the bar:** the register lives at `#register` (for example `https://<your-site>/#register`), so the bartender's device can bookmark it. Pick a menu item, then a guest's tab (or open one by name) or a crew member. Check the bottle each ingredient pours from, switch it or add a second bottle when one runs out, and confirm. The price is locked when you confirm. A crew drink is never put on a guest tab: it costs the crew member what it drew, at cost, with no markup.

**Closing out:** each open tab is closed as *Paid* (choose who collected the money; the amount is the tab total) or *Write off* (choose who is writing it off — they cover what its drinks cost). *End night* works once every tab is closed. **Ledger → Host Nights** shows what each collector holds and which buyers it belongs to, plus the value written off from each buyer's stock. Both feed the crew balances: the collector carries what they collected, and a write-off lands on whoever wrote it off.

A red *This browser only* banner on the register means nothing is being saved to the shared database.

### Rolling host mode out

1. Run [supabase/host-mode.sql](supabase/host-mode.sql) in the Supabase SQL editor.
2. Run [supabase/checks/host-mode-checks.sql](supabase/checks/host-mode-checks.sql). It tests every rule inside a transaction it rolls back, and returns one row with the number of checks passed.
3. Deploy the client straight away.
4. Reload every crew device, including the register, before the first host night.

The app still works if the SQL has not been run yet: the Menu tab and register say which file to run, and ordinary saves send exactly what they sent before.

## Tests

No dependencies are needed. From the workspace, run them inside the `dev-env` container:

```bash
# balances, settlement, pricing, stock and summaries
docker exec dev-env node --test /workspace/projects/rnmb-command-center/tests/

# end-to-end browser checks (serve the app on port 3000 first)
docker exec -e PLAYWRIGHT_BROWSERS_PATH=/workspace/tools/playwright/browsers dev-env node /workspace/projects/rnmb-command-center/tests/browser/host-mode.smoke.js
```

From Git Bash, prefix `docker exec` with `MSYS_NO_PATHCONV=1`.

## Deploy on Vercel

Import the repository into Vercel, add the Supabase env vars, and deploy. You can also deploy from the CLI:

```bash
vercel
```

No build command is required.
