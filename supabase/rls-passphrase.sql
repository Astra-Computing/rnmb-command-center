-- RNMB Command Center — put every table behind a shared passphrase.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query).
-- It is safe to re-run; it replaces the old wide-open policies each time.
--
-- BEFORE YOU RUN IT: change 'CHANGE-ME' on the very last statement to the
-- passphrase you will give the crew. Everyone types it into the dashboard once.
--
-- Why this exists: the publishable key is handed to every visitor by
-- /api/config, and it is meant to be public. Until now the policies said
-- `using (true)`, so the key alone let anyone with the URL read or delete the
-- whole dataset. These policies require a passphrase header as well.

-- 1. Where the passphrase lives.
--    RLS is enabled and there are deliberately NO policies on this table, so
--    the publishable key can never read or write it. Only rnmb_authorized()
--    below can see it, because that function is SECURITY DEFINER and therefore
--    runs as its owner rather than as the caller.
create table if not exists public.rnmb_access (
  id boolean primary key default true check (id),
  passphrase text not null,
  updated_at timestamptz not null default now()
);

alter table public.rnmb_access enable row level security;

-- 2. The check that every policy calls.
--    PostgREST exposes the request's headers to SQL, so the policy can read the
--    x-rnmb-key header the browser sends and compare it to the stored value.
--    nullif() guards the case where the setting is present but empty, which
--    would make ''::json raise instead of returning null.
create or replace function public.rnmb_authorized()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rnmb_access
    where passphrase <> ''
      and passphrase = coalesce(
        nullif(current_setting('request.headers', true), '')::json ->> 'x-rnmb-key',
        ''
      )
  );
$$;

-- The browser calls this directly at boot to tell "wrong passphrase" apart from
-- "empty dashboard" — a denied SELECT returns [] with a 200, not an error.
revoke all on function public.rnmb_authorized() from public;
grant execute on function public.rnmb_authorized() to anon, authenticated;

-- 3. Out with the open policies.
drop policy if exists "RNMB public read people" on public.rnmb_people;
drop policy if exists "RNMB public write people" on public.rnmb_people;
drop policy if exists "RNMB public read beverage types" on public.rnmb_beverage_types;
drop policy if exists "RNMB public write beverage types" on public.rnmb_beverage_types;
drop policy if exists "RNMB public read nights" on public.rnmb_nights;
drop policy if exists "RNMB public write nights" on public.rnmb_nights;
drop policy if exists "RNMB public read bottles" on public.rnmb_bottles;
drop policy if exists "RNMB public write bottles" on public.rnmb_bottles;
drop policy if exists "RNMB public read pours" on public.rnmb_pours;
drop policy if exists "RNMB public write pours" on public.rnmb_pours;
drop policy if exists "RNMB public read settings" on public.rnmb_settings;
drop policy if exists "RNMB public write settings" on public.rnmb_settings;

drop policy if exists "RNMB gated people" on public.rnmb_people;
drop policy if exists "RNMB gated beverage types" on public.rnmb_beverage_types;
drop policy if exists "RNMB gated nights" on public.rnmb_nights;
drop policy if exists "RNMB gated bottles" on public.rnmb_bottles;
drop policy if exists "RNMB gated pours" on public.rnmb_pours;
drop policy if exists "RNMB gated settings" on public.rnmb_settings;

-- 4. In with the gated ones. One `for all` policy per table covers select,
--    insert, update and delete.
create policy "RNMB gated people" on public.rnmb_people
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated beverage types" on public.rnmb_beverage_types
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated nights" on public.rnmb_nights
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated bottles" on public.rnmb_bottles
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated pours" on public.rnmb_pours
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated settings" on public.rnmb_settings
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());

-- 5. Set the passphrase. CHANGE THIS VALUE before running.
--    To rotate it later, re-run just this statement with a new value; everyone
--    is prompted again on their next load.
insert into public.rnmb_access (id, passphrase)
values (true, 'CHANGE-ME')
on conflict (id) do update
  set passphrase = excluded.passphrase,
      updated_at = now();
