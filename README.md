# RNMB Command Center

A dependency-free dashboard for tracking group beverage inventory, spending, and night-by-night consumption.

## Features

- Shared Supabase persistence for people, beverage types, bottle purchases, and night logs
- U.S. standard drink calculations using fluid ounces and ABV
- Spending ledger with equal-share settle-up view
- Inventory depletion tracking when pours are logged
- Responsible-use pace checks and hydration reminders
- JSON export/import for backup or migration

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

The anon key is expected to be public. The SQL file enables row-level security with public read/write policies, which fits a private friend-group dashboard only if the Vercel URL is shared carefully. Add Supabase Auth before sharing it broadly.

## Run Locally

```bash
python3 -m http.server 5173
```

Open `http://localhost:5173`.

The plain Python server cannot run the Vercel `/api/config` function, so local Python mode uses browser `localStorage`. To test Supabase locally, use Vercel CLI with the same env vars:

```bash
vercel dev
```

## Deploy on Vercel

Import the repository into Vercel, add the Supabase env vars, and deploy. You can also deploy from the CLI:

```bash
vercel
```

No build command is required.
