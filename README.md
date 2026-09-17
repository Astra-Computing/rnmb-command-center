# RNMB Command Center

A dependency-free dashboard for tracking group beverage inventory, spending, and night-by-night consumption.

## Features

- Shared Supabase persistence for people, beverage types, bottle purchases, and night logs
- U.S. standard drink calculations using fluid ounces and ABV
- Spending ledger with equal-share settle-up view
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

For a project created before host mode existed, also run [supabase/host-mode.sql](supabase/host-mode.sql) (see Host Mode below). It is safe to run more than once.

## Run Locally

```bash
python3 -m http.server 3000
```

Open `http://localhost:3000`. In the workspace's `dev-env` container, port 3000 is the only port published to the host.

The plain Python server cannot run the Vercel `/api/config` function, so local Python mode uses browser `localStorage`. To test Supabase locally, use Vercel CLI with the same env vars:

```bash
vercel dev
```

## Host Mode

Host mode replaces a flat cover charge with a tab per guest.

**Set up (in the dashboard):**

1. **Inventory**: add stock types. Choose *Poured, ounces* for spirits, liqueurs and fluid mixers (mixers use ABV 0) or *Counted, units* for cans and bottled drinks (give the volume of one unit). Then add the stock you bought, with its price and who paid.
2. **Menu**: build cocktails, straight pours and counted items from those types, and set the markup percentage and the rounding step. Each item shows the price it would ring up at right now, or *Unavailable* when stock can't cover it.
3. **Tonight**: start a night and choose *Host night*, then follow *Open register*.

**At the bar:** the register lives at `#register` (for example `https://<your-site>/#register`), so the bartender's device can bookmark it. Pick a menu item, then a guest's tab (or open one by name) or a crew member. Check the bottle each ingredient pours from, switch it or add a second bottle when one runs out, and confirm. The price is locked when you confirm. Crew drinks cost nothing but still use stock and count toward that person's drinks.

**Closing out:** each open tab is closed as *Paid* (choose who collected the money; the amount is the tab total) or *Write off*. *End night* works once every tab is closed. **Ledger → Host Nights** shows what each collector holds and which buyers it belongs to, plus the value written off from each buyer's stock. It does not change the Equal Share settle-up.

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
# pricing, shares, stock and summaries
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
