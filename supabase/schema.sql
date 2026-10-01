create extension if not exists pgcrypto;

-- Fresh projects only: this file creates every table at its current shape. A
-- database created from an older copy of this file is brought up to date by
-- supabase/rls-passphrase.sql, supabase/host-mode.sql,
-- supabase/crew-balance.sql and supabase/safe-saves.sql (run in that order)
-- instead, and those four files must end at the same result as this one.

create table if not exists public.rnmb_people (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  color text not null default '#ef4444',
  created_at timestamptz not null default now()
);

create table if not exists public.rnmb_beverage_types (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  category text not null,
  abv numeric(5, 2) not null check (abv >= 0 and abv <= 95),
  created_at timestamptz not null default now(),
  measure text not null default 'oz',
  unit_oz numeric(8, 2),
  constraint rnmb_beverage_types_measure check (measure in ('oz', 'unit')),
  constraint rnmb_beverage_types_unit_volume
    check ((unit_oz is null or unit_oz > 0) and (measure = 'oz' or unit_oz is not null))
);

create table if not exists public.rnmb_nights (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  date date not null,
  created_at timestamptz not null default now(),
  kind text not null default 'crew',
  ended_at timestamptz,
  constraint rnmb_nights_kind check (kind in ('crew', 'host'))
);

-- A partial unique index: every open host night has the same value in the
-- indexed column, so a second open host night would be a duplicate.
create unique index if not exists rnmb_nights_one_open_host
  on public.rnmb_nights (kind)
  where kind = 'host' and ended_at is null;

create table if not exists public.rnmb_bottles (
  id uuid primary key default gen_random_uuid(),
  type_id uuid not null references public.rnmb_beverage_types(id) on delete cascade,
  nickname text,
  size_oz numeric(8, 2) not null check (size_oz > 0),
  remaining_oz numeric(8, 2) not null check (remaining_oz >= 0),
  price numeric(10, 2) not null default 0 check (price >= 0),
  buyer_id uuid references public.rnmb_people(id) on delete set null,
  purchase_date date not null,
  created_at timestamptz not null default now(),
  check (remaining_oz <= size_oz)
);

create table if not exists public.rnmb_pours (
  id uuid primary key default gen_random_uuid(),
  night_id uuid not null references public.rnmb_nights(id) on delete cascade,
  person_id uuid not null references public.rnmb_people(id) on delete cascade,
  bottle_id uuid not null references public.rnmb_bottles(id) on delete cascade,
  ounces numeric(8, 2) not null check (ounces > 0),
  abv_snapshot numeric(5, 2) not null check (abv_snapshot > 0 and abv_snapshot <= 95),
  poured_at timestamptz not null default now(),
  cost_cents integer,
  buyer_id uuid references public.rnmb_people(id) on delete set null,
  buyer_name text,
  constraint rnmb_pours_cost_cents check (cost_cents is null or cost_cents >= 0)
);

create table if not exists public.rnmb_settings (
  id boolean primary key default true,
  active_night_id uuid references public.rnmb_nights(id) on delete set null,
  responsible_mode boolean not null default true,
  updated_at timestamptz not null default now(),
  markup_percent numeric(6, 2) not null default 0,
  rounding_increment_cents integer not null default 25,
  pricing_version integer not null default 1,
  constraint rnmb_settings_singleton check (id),
  constraint rnmb_settings_markup_percent check (markup_percent >= 0),
  constraint rnmb_settings_rounding_increment_cents check (rounding_increment_cents > 0)
);

comment on column public.rnmb_beverage_types.measure is
  'oz = poured stock tracked in ounces; unit = counted stock tracked in whole units (cans, bottled drinks).';
comment on column public.rnmb_beverage_types.unit_oz is
  'Fluid ounces in one unit of a counted type, so standard drinks can still be computed. Required when measure = unit; ignored for poured types.';

-- The bottle and pour columns keep their original names so an older client and
-- a newer database (or the reverse) still agree during a deploy. The amounts in
-- them are in the type's measure.
comment on column public.rnmb_bottles.size_oz is
  'Full size of the stock item in its type''s measure: ounces for poured types, whole units for counted types.';
comment on column public.rnmb_bottles.remaining_oz is
  'Amount left in the stock item, in its type''s measure: ounces for poured types, whole units for counted types.';
comment on column public.rnmb_pours.ounces is
  'Amount of the crew pour in its type''s measure: ounces for poured types, whole units for counted types.';
comment on column public.rnmb_pours.cost_cents is
  'What the pour drew, in whole cents (purchase price / size x amount, rounded half-up), fixed when logged. Null on pours logged before costs were recorded.';
comment on column public.rnmb_pours.buyer_id is
  'Who bought the stock item the pour came from, fixed when logged.';
comment on column public.rnmb_pours.buyer_name is
  'The buyer''s name when the pour was logged, kept after that person is removed.';
comment on column public.rnmb_settings.rounding_increment_cents is
  'Drink prices are rounded UP to a multiple of this many cents (25 = $0.25).';

-- Host mode tables (as supabase/host-mode.sql creates them, with the changes
-- supabase/crew-balance.sql makes).
--    Money is whole cents. Money history is never deleted: a stock item that a
--    ring-up drew from cannot be deleted (on delete restrict), and removing a
--    person keeps their name on past records through a name snapshot column
--    beside each person reference (on delete set null).
create table if not exists public.rnmb_menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  kind text not null check (kind in ('cocktail', 'straight', 'counted')),
  created_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists public.rnmb_recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  menu_item_id uuid not null references public.rnmb_menu_items(id) on delete cascade,
  type_id uuid not null references public.rnmb_beverage_types(id) on delete restrict,
  amount numeric(8, 2) not null check (amount > 0),
  line_no integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.rnmb_guest_tabs (
  id uuid primary key default gen_random_uuid(),
  night_id uuid not null references public.rnmb_nights(id) on delete restrict,
  guest_name text not null check (char_length(trim(guest_name)) > 0),
  status text not null default 'open' check (status in ('open', 'paid', 'written_off')),
  collector_id uuid references public.rnmb_people(id) on delete set null,
  collector_name text,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  written_off_by uuid references public.rnmb_people(id) on delete set null,
  written_off_by_name text,
  -- collector_name and written_off_by_name, not the ids, carry the rule, so the
  -- row stays valid after that crew member is removed.
  constraint rnmb_guest_tabs_close_state check (
    (status = 'open' and closed_at is null and collector_id is null
      and collector_name is null and amount_cents is null
      and written_off_by is null and written_off_by_name is null)
    or (status = 'paid' and closed_at is not null
      and collector_name is not null and amount_cents is not null
      and written_off_by is null and written_off_by_name is null)
    or (status = 'written_off' and closed_at is not null and collector_id is null
      and collector_name is null and amount_cents is null
      and written_off_by_name is not null)
  )
);

create table if not exists public.rnmb_ring_ups (
  id uuid primary key default gen_random_uuid(),
  night_id uuid not null references public.rnmb_nights(id) on delete restrict,
  kind text not null check (kind in ('guest', 'crew')),
  tab_id uuid references public.rnmb_guest_tabs(id) on delete restrict,
  person_id uuid references public.rnmb_people(id) on delete set null,
  person_name text,
  menu_item_id uuid references public.rnmb_menu_items(id) on delete set null,
  menu_item_name text not null,
  price_cents integer check (price_cents is null or price_cents >= 0),
  rung_at timestamptz not null default now(),
  voided_at timestamptz,
  -- kind fixes the target, and person_name (not person_id) carries it, so the
  -- rule still holds after a crew member is removed.
  constraint rnmb_ring_ups_target check (
    (kind = 'guest' and tab_id is not null and price_cents is not null
      and person_id is null and person_name is null)
    or (kind = 'crew' and tab_id is null and person_name is not null and price_cents is null)
  )
);

create table if not exists public.rnmb_ring_up_lines (
  id uuid primary key default gen_random_uuid(),
  ring_up_id uuid not null references public.rnmb_ring_ups(id) on delete cascade,
  line_no integer not null default 0,
  bottle_id uuid not null references public.rnmb_bottles(id) on delete restrict,
  type_id uuid not null references public.rnmb_beverage_types(id) on delete restrict,
  amount numeric(8, 2) not null check (amount > 0),
  cost_cents numeric not null default 0 check (cost_cents >= 0),
  share_cents integer check (share_cents is null or share_cents >= 0),
  buyer_id uuid references public.rnmb_people(id) on delete set null,
  buyer_name text,
  abv_snapshot numeric(5, 2) not null check (abv_snapshot >= 0 and abv_snapshot <= 95)
);

create table if not exists public.rnmb_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  bottle_id uuid not null references public.rnmb_bottles(id) on delete cascade,
  previous_remaining numeric(8, 2) not null check (previous_remaining >= 0),
  new_remaining numeric(8, 2) not null check (new_remaining >= 0),
  adjusted_at timestamptz not null default now()
);

-- Crew balance: payments between crew members (identical to
-- supabase/crew-balance.sql). A wrong payment is voided, never deleted.
create table if not exists public.rnmb_payments (
  id uuid primary key default gen_random_uuid(),
  from_person_id uuid references public.rnmb_people(id) on delete set null,
  from_name text not null check (char_length(trim(from_name)) > 0),
  to_person_id uuid references public.rnmb_people(id) on delete set null,
  to_name text not null check (char_length(trim(to_name)) > 0),
  amount_cents integer not null check (amount_cents > 0),
  paid_at timestamptz not null default now(),
  voided_at timestamptz,
  -- `<>` is null (so the check passes) once either person has been removed.
  constraint rnmb_payments_two_people check (from_person_id <> to_person_id)
);

comment on column public.rnmb_guest_tabs.written_off_by is
  'The crew member who wrote the tab off. Null on open and paid tabs, and on tabs written off before this was recorded.';
comment on column public.rnmb_guest_tabs.written_off_by_name is
  'That crew member''s name when the tab was written off, kept after that person is removed.';
comment on column public.rnmb_payments.amount_cents is
  'Amount paid from from_person to to_person, in whole cents.';
comment on column public.rnmb_payments.voided_at is
  'Set when the payment was recorded by mistake. A voided payment moves no balance but stays in the history.';

comment on column public.rnmb_recipe_ingredients.amount is
  'Recipe amount in the type''s measure: ounces for poured types, whole units for counted types.';
comment on column public.rnmb_ring_up_lines.amount is
  'Amount drawn from the stock item, in its type''s measure.';
comment on column public.rnmb_ring_up_lines.cost_cents is
  'Unrounded ingredient cost in cents (purchase price / size x amount), fixed at ring-up.';
comment on column public.rnmb_ring_up_lines.share_cents is
  'This line''s whole-cent share of the guest price, fixed at ring-up. Null on crew ring-ups.';
comment on column public.rnmb_ring_ups.price_cents is
  'Guest price in cents, fixed at ring-up. Null on crew ring-ups.';
comment on column public.rnmb_stock_adjustments.previous_remaining is
  'Level before the hand correction, in the type''s measure.';
comment on column public.rnmb_stock_adjustments.new_remaining is
  'Level after the hand correction, in the type''s measure.';

-- Indexes for the foreign keys the app filters on, and that Postgres checks
-- when a stock item or person is deleted.
create index if not exists rnmb_recipe_ingredients_menu_item_idx on public.rnmb_recipe_ingredients (menu_item_id);
create index if not exists rnmb_guest_tabs_night_idx on public.rnmb_guest_tabs (night_id);
create index if not exists rnmb_ring_ups_night_idx on public.rnmb_ring_ups (night_id);
create index if not exists rnmb_ring_ups_tab_idx on public.rnmb_ring_ups (tab_id);
create index if not exists rnmb_ring_up_lines_ring_up_idx on public.rnmb_ring_up_lines (ring_up_id);
create index if not exists rnmb_ring_up_lines_bottle_idx on public.rnmb_ring_up_lines (bottle_id);
create index if not exists rnmb_stock_adjustments_bottle_idx on public.rnmb_stock_adjustments (bottle_id);
create index if not exists rnmb_payments_from_person_idx on public.rnmb_payments (from_person_id);
create index if not exists rnmb_payments_to_person_idx on public.rnmb_payments (to_person_id);

create or replace function public.rnmb_touch_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rnmb_settings_updated_at on public.rnmb_settings;
create trigger rnmb_settings_updated_at
before update on public.rnmb_settings
for each row execute function public.rnmb_touch_settings_updated_at();

alter table public.rnmb_people enable row level security;
alter table public.rnmb_beverage_types enable row level security;
alter table public.rnmb_nights enable row level security;
alter table public.rnmb_bottles enable row level security;
alter table public.rnmb_pours enable row level security;
alter table public.rnmb_settings enable row level security;
alter table public.rnmb_menu_items enable row level security;
alter table public.rnmb_recipe_ingredients enable row level security;
alter table public.rnmb_guest_tabs enable row level security;
alter table public.rnmb_ring_ups enable row level security;
alter table public.rnmb_ring_up_lines enable row level security;
alter table public.rnmb_stock_adjustments enable row level security;
alter table public.rnmb_payments enable row level security;

-- Access control: every table is gated behind a shared passphrase, which the
-- browser sends on the x-rnmb-key header. See supabase/rls-passphrase.sql for
-- the full explanation and for how to set or rotate the passphrase; that file
-- is also what you run against a database that already has the old open
-- policies. This block keeps a freshly created project from starting wide open.

create table if not exists public.rnmb_access (
  id boolean primary key default true check (id),
  passphrase text not null,
  updated_at timestamptz not null default now()
);

-- No policies on purpose: RLS denies by default, so the publishable key can
-- never read this table. Only rnmb_authorized() sees it, via SECURITY DEFINER.
alter table public.rnmb_access enable row level security;

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

revoke all on function public.rnmb_authorized() from public;
grant execute on function public.rnmb_authorized() to anon, authenticated;

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
drop policy if exists "RNMB gated menu items" on public.rnmb_menu_items;
drop policy if exists "RNMB gated recipe ingredients" on public.rnmb_recipe_ingredients;
drop policy if exists "RNMB gated guest tabs" on public.rnmb_guest_tabs;
drop policy if exists "RNMB gated ring-ups" on public.rnmb_ring_ups;
drop policy if exists "RNMB gated ring-up lines" on public.rnmb_ring_up_lines;
drop policy if exists "RNMB gated stock adjustments" on public.rnmb_stock_adjustments;
drop policy if exists "RNMB gated payments" on public.rnmb_payments;

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
create policy "RNMB gated menu items" on public.rnmb_menu_items
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated recipe ingredients" on public.rnmb_recipe_ingredients
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated guest tabs" on public.rnmb_guest_tabs
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated ring-ups" on public.rnmb_ring_ups
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated ring-up lines" on public.rnmb_ring_up_lines
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated stock adjustments" on public.rnmb_stock_adjustments
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());
create policy "RNMB gated payments" on public.rnmb_payments
  for all using (public.rnmb_authorized()) with check (public.rnmb_authorized());

-- One-call functions (identical to supabase/host-mode.sql and, where that file
-- replaces or adds one, supabase/crew-balance.sql).
--    The browser calls each one as POST /rest/v1/rpc/<name> with the body
--    {"payload": {...}}. They run as the CALLER (not SECURITY DEFINER), so the
--    gated policies above still apply, and each one checks the passphrase
--    first anyway so that a wrong passphrase gets a clear refusal instead of a
--    confusing "not found". Any failed rule raises an error whose message
--    starts with "RNMB:" and says what to fix; because a function call is one
--    transaction, nothing it did before the error is kept.

-- Ring up one menu item, for a guest tab or a crew member.
-- Guest drinks: a running host night only. Crew drinks: a running host night,
-- or a crew night whether or not it has ended.
-- payload: id, night_id, kind ('guest' | 'crew'), tab_id (guest),
--   person_id (crew), menu_item_id, price_cents (guest only), rung_at (optional),
--   lines: [{ id (optional), bottle_id, amount, cost_cents, share_cents (guest only) }]
create or replace function public.rnmb_ring_up(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_night_id uuid;
  v_kind text;
  v_tab_id uuid;
  v_person_id uuid;
  v_person_name text;
  v_menu_item_id uuid;
  v_menu_item_name text;
  v_price_cents integer;
  v_lines jsonb;
  v_night record;
  v_tab record;
  v_bottle record;
  v_line jsonb;
  v_line_no integer;
  v_amount numeric;
  v_cost numeric;
  v_share integer;
  v_buyer_name text;
  v_missing integer;
  v_share_total bigint;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_night_id := nullif(payload ->> 'night_id', '')::uuid;
  v_kind := payload ->> 'kind';
  v_tab_id := nullif(payload ->> 'tab_id', '')::uuid;
  v_person_id := nullif(payload ->> 'person_id', '')::uuid;
  v_menu_item_id := nullif(payload ->> 'menu_item_id', '')::uuid;
  v_price_cents := (payload ->> 'price_cents')::integer;
  v_lines := payload -> 'lines';

  if v_id is null then
    raise exception 'RNMB: a ring-up needs an id.';
  end if;
  -- The register creates the id when the order is started, so a retried or
  -- double-tapped submit arrives with the same id and is refused here (and by
  -- the primary key, if two arrive at the same instant).
  if exists (select 1 from public.rnmb_ring_ups where id = v_id) then
    raise exception 'RNMB: ring-up % was already saved.', v_id;
  end if;

  select * into v_night from public.rnmb_nights where id = v_night_id for share;
  if not found then
    raise exception 'RNMB: that night does not exist.';
  end if;
  -- An ended host night is locked. A crew night takes crew drinks even after it
  -- ended, so a missed drink can be added from the recap; it never takes guest
  -- drinks. (An unknown kind is refused below.)
  if v_night.kind = 'host' then
    if v_night.ended_at is not null then
      raise exception 'RNMB: this host night has ended, so nothing more can be rung up.';
    end if;
  elsif v_kind = 'guest' then
    raise exception 'RNMB: guest drinks can only be rung up on a host night.';
  end if;

  if v_kind = 'guest' then
    if v_tab_id is null then
      raise exception 'RNMB: a guest ring-up needs a tab.';
    end if;
    if v_person_id is not null then
      raise exception 'RNMB: a guest ring-up goes on a tab, not to a crew member.';
    end if;
    select * into v_tab from public.rnmb_guest_tabs where id = v_tab_id for share;
    if not found then
      raise exception 'RNMB: that tab does not exist.';
    end if;
    if v_tab.night_id <> v_night_id then
      raise exception 'RNMB: that tab belongs to a different night.';
    end if;
    if v_tab.status <> 'open' then
      raise exception 'RNMB: that tab is closed, so nothing more can be added to it.';
    end if;
    if v_price_cents is null or v_price_cents < 0 then
      raise exception 'RNMB: a guest ring-up needs a price in cents.';
    end if;
  elsif v_kind = 'crew' then
    if v_tab_id is not null then
      raise exception 'RNMB: crew members never get a tab; ring up a crew drink to the person.';
    end if;
    if v_price_cents is not null then
      raise exception 'RNMB: a crew ring-up carries no price.';
    end if;
    if v_person_id is null then
      raise exception 'RNMB: a crew ring-up needs a crew member.';
    end if;
    select name into v_person_name from public.rnmb_people where id = v_person_id;
    if not found then
      raise exception 'RNMB: that crew member does not exist.';
    end if;
  else
    raise exception 'RNMB: a ring-up kind must be guest or crew.';
  end if;

  select name into v_menu_item_name from public.rnmb_menu_items where id = v_menu_item_id;
  if not found then
    raise exception 'RNMB: that menu item does not exist.';
  end if;

  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'RNMB: a ring-up needs at least one ingredient line.';
  end if;

  if v_kind = 'guest' then
    select count(*) filter (where l.line ->> 'share_cents' is null),
           coalesce(sum((l.line ->> 'share_cents')::integer), 0)
      into v_missing, v_share_total
      from jsonb_array_elements(v_lines) as l(line);
    if v_missing > 0 then
      raise exception 'RNMB: every line of a guest ring-up needs a share in cents.';
    end if;
    if v_share_total <> v_price_cents then
      raise exception 'RNMB: the line shares add up to % cents but the price is % cents.',
        v_share_total, v_price_cents;
    end if;
  elsif exists (
    select 1 from jsonb_array_elements(v_lines) as l(line) where l.line ->> 'share_cents' is not null
  ) then
    raise exception 'RNMB: a crew ring-up carries no price, so its lines carry no shares.';
  end if;

  insert into public.rnmb_ring_ups (
    id, night_id, kind, tab_id, person_id, person_name,
    menu_item_id, menu_item_name, price_cents, rung_at
  ) values (
    v_id, v_night_id, v_kind, v_tab_id, v_person_id, v_person_name,
    v_menu_item_id, v_menu_item_name, v_price_cents,
    coalesce(nullif(payload ->> 'rung_at', '')::timestamptz, now())
  );

  for v_line, v_line_no in
    select l.line, l.ord::integer
      from jsonb_array_elements(v_lines) with ordinality as l(line, ord)
      order by l.ord
  loop
    v_amount := (v_line ->> 'amount')::numeric;
    v_share := (v_line ->> 'share_cents')::integer;
    v_cost := (v_line ->> 'cost_cents')::numeric;

    if v_amount is null or v_amount <= 0 then
      raise exception 'RNMB: every line needs an amount above zero.';
    end if;
    if v_amount <> round(v_amount, 2) then
      raise exception 'RNMB: amounts are kept to two decimal places, and % has more.', v_amount;
    end if;
    if v_cost is null then
      if v_kind = 'guest' then
        raise exception 'RNMB: every line of a guest ring-up needs its cost in cents.';
      end if;
      v_cost := 0;
    end if;
    if v_cost < 0 then
      raise exception 'RNMB: a line cost cannot be negative.';
    end if;

    -- Lock the stock item so two ring-ups cannot both spend its last ounce.
    select b.id, b.type_id, b.nickname, b.remaining_oz, b.buyer_id,
           t.name as type_name, t.measure, t.abv
      into v_bottle
      from public.rnmb_bottles b
      join public.rnmb_beverage_types t on t.id = b.type_id
     where b.id = nullif(v_line ->> 'bottle_id', '')::uuid
       for update of b;
    if not found then
      raise exception 'RNMB: a stock item on this ring-up no longer exists.';
    end if;
    if v_bottle.measure = 'unit' and v_amount <> trunc(v_amount) then
      raise exception 'RNMB: % is counted stock and is used in whole units.', v_bottle.type_name;
    end if;
    if v_bottle.remaining_oz < v_amount then
      raise exception 'RNMB: not enough left in % (% left, % needed), so nothing was rung up.',
        coalesce(nullif(v_bottle.nickname, ''), v_bottle.type_name), v_bottle.remaining_oz, v_amount;
    end if;

    update public.rnmb_bottles
       set remaining_oz = remaining_oz - v_amount
     where id = v_bottle.id;

    v_buyer_name := null;
    if v_bottle.buyer_id is not null then
      select name into v_buyer_name from public.rnmb_people where id = v_bottle.buyer_id;
    end if;

    insert into public.rnmb_ring_up_lines (
      id, ring_up_id, line_no, bottle_id, type_id, amount,
      cost_cents, share_cents, buyer_id, buyer_name, abv_snapshot
    ) values (
      coalesce(nullif(v_line ->> 'id', '')::uuid, gen_random_uuid()),
      v_id, v_line_no, v_bottle.id, v_bottle.type_id, v_amount,
      v_cost, v_share, v_bottle.buyer_id, v_buyer_name, v_bottle.abv
    );
  end loop;

  return v_id;
end;
$$;

-- Void a rung-up item: stamp voided_at and put every amount back on the stock
-- item it came from (never above that item's size). Items on an ended host
-- night stay locked; items on a crew night can be voided even after it ended.
-- payload: id
create or replace function public.rnmb_void_ring_up(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_ring_up record;
  v_night record;
  v_tab_status text;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  select * into v_ring_up from public.rnmb_ring_ups where id = v_id for update;
  if not found then
    raise exception 'RNMB: that ring-up does not exist.';
  end if;
  if v_ring_up.voided_at is not null then
    raise exception 'RNMB: that item was already voided.';
  end if;

  -- An ended host night freezes the guest tabs that were counted against the
  -- cash. A crew drink is on no tab and is charged at cost, so it stays
  -- correctable like a crew night's, or a drink rung up to the wrong person
  -- would be a permanent debit with nowhere to undo it.
  select * into v_night from public.rnmb_nights where id = v_ring_up.night_id for share;
  if v_night.kind = 'host' and v_night.ended_at is not null and v_ring_up.kind = 'guest' then
    raise exception 'RNMB: this host night has ended, so its items can no longer be voided.';
  end if;

  if v_ring_up.kind = 'guest' then
    select status into v_tab_status from public.rnmb_guest_tabs where id = v_ring_up.tab_id for update;
    if v_tab_status is distinct from 'open' then
      raise exception 'RNMB: that tab is already closed, so its items can no longer be voided.';
    end if;
  end if;

  -- Summed per stock item: an UPDATE ... FROM applies only one matching row
  -- per target, which would lose an amount if two lines drew from one item.
  update public.rnmb_bottles b
     set remaining_oz = least(b.size_oz, b.remaining_oz + drawn.amount)
    from (
      select bottle_id, sum(amount) as amount
        from public.rnmb_ring_up_lines
       where ring_up_id = v_id
       group by bottle_id
    ) as drawn
   where b.id = drawn.bottle_id;

  update public.rnmb_ring_ups set voided_at = now() where id = v_id;

  return v_id;
end;
$$;

-- Open a guest tab on the running host night.
-- payload: id, night_id, guest_name, opened_at (optional)
create or replace function public.rnmb_open_tab(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_night_id uuid;
  v_guest_name text;
  v_night record;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_night_id := nullif(payload ->> 'night_id', '')::uuid;
  v_guest_name := trim(coalesce(payload ->> 'guest_name', ''));

  if v_id is null then
    raise exception 'RNMB: a tab needs an id.';
  end if;
  if exists (select 1 from public.rnmb_guest_tabs where id = v_id) then
    raise exception 'RNMB: tab % was already opened.', v_id;
  end if;
  if v_guest_name = '' then
    raise exception 'RNMB: a tab needs the guest''s name.';
  end if;

  select * into v_night from public.rnmb_nights where id = v_night_id for share;
  if not found then
    raise exception 'RNMB: that night does not exist.';
  end if;
  if v_night.kind <> 'host' then
    raise exception 'RNMB: guest tabs only exist on a host night.';
  end if;
  if v_night.ended_at is not null then
    raise exception 'RNMB: this host night has ended, so no new tabs can be opened.';
  end if;

  insert into public.rnmb_guest_tabs (id, night_id, guest_name, status, opened_at)
  values (
    v_id, v_night_id, v_guest_name, 'open',
    coalesce(nullif(payload ->> 'opened_at', '')::timestamptz, now())
  );

  return v_id;
end;
$$;

-- Close a guest tab, as paid (the amount must equal the tab total of every
-- item not voided, and the collecting crew member is recorded) or written off
-- (the crew member who wrote it off is recorded).
-- payload: id, status ('paid' | 'written_off'), collector_id (paid),
--   amount_cents (paid), written_off_by (written_off)
create or replace function public.rnmb_close_tab(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_status text;
  v_collector_id uuid;
  v_collector_name text;
  v_amount integer;
  v_written_off_by uuid;
  v_written_off_by_name text;
  v_total bigint;
  v_tab record;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_status := payload ->> 'status';
  v_collector_id := nullif(payload ->> 'collector_id', '')::uuid;
  v_amount := (payload ->> 'amount_cents')::integer;
  v_written_off_by := nullif(payload ->> 'written_off_by', '')::uuid;

  -- Locking the tab makes a ring-up that is saving right now finish first, so
  -- the total below includes it.
  select * into v_tab from public.rnmb_guest_tabs where id = v_id for update;
  if not found then
    raise exception 'RNMB: that tab does not exist.';
  end if;
  if v_tab.status <> 'open' then
    raise exception 'RNMB: that tab is already closed.';
  end if;

  select coalesce(sum(price_cents), 0) into v_total
    from public.rnmb_ring_ups
   where tab_id = v_id and voided_at is null;

  if v_status = 'paid' then
    if v_collector_id is null then
      raise exception 'RNMB: a paid tab needs the crew member who collected the money.';
    end if;
    select name into v_collector_name from public.rnmb_people where id = v_collector_id;
    if not found then
      raise exception 'RNMB: that collector does not exist.';
    end if;
    if v_amount is null or v_amount <> v_total then
      raise exception 'RNMB: the amount collected (% cents) must equal the tab total (% cents).',
        coalesce(v_amount::text, 'no'), v_total;
    end if;
    update public.rnmb_guest_tabs
       set status = 'paid',
           collector_id = v_collector_id,
           collector_name = v_collector_name,
           amount_cents = v_amount,
           closed_at = now()
     where id = v_id;
  elsif v_status = 'written_off' then
    if v_collector_id is not null or v_amount is not null then
      raise exception 'RNMB: a written-off tab has no collector and no amount.';
    end if;
    if v_written_off_by is null then
      raise exception 'RNMB: a written-off tab needs the crew member who wrote it off.';
    end if;
    select name into v_written_off_by_name from public.rnmb_people where id = v_written_off_by;
    if not found then
      raise exception 'RNMB: the crew member writing off the tab does not exist.';
    end if;
    update public.rnmb_guest_tabs
       set status = 'written_off',
           written_off_by = v_written_off_by,
           written_off_by_name = v_written_off_by_name,
           closed_at = now()
     where id = v_id;
  else
    raise exception 'RNMB: a tab closes as paid or written_off.';
  end if;

  return v_id;
end;
$$;

-- Start a host night. Only one host night can be open at a time.
-- payload: id, name, date ('YYYY-MM-DD', optional, defaults to today)
create or replace function public.rnmb_start_host_night(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_name := trim(coalesce(payload ->> 'name', ''));

  if v_id is null then
    raise exception 'RNMB: a night needs an id.';
  end if;
  if v_name = '' then
    raise exception 'RNMB: a host night needs a name.';
  end if;
  if exists (select 1 from public.rnmb_nights where kind = 'host' and ended_at is null) then
    raise exception 'RNMB: a host night is already running; end it before starting another.';
  end if;

  begin
    insert into public.rnmb_nights (id, name, date, kind)
    values (v_id, v_name, coalesce(nullif(payload ->> 'date', '')::date, current_date), 'host');
  exception when unique_violation then
    -- Two crew members pressed start at the same moment (rnmb_nights_one_open_host),
    -- or the id is already taken.
    raise exception 'RNMB: a host night is already running, or night % already exists.', v_id;
  end;

  return v_id;
end;
$$;

-- End a night. A crew night ends straight away; a host night is refused while
-- any of its tabs is still open.
-- payload: id
create or replace function public.rnmb_end_night(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_night record;
  v_open integer;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;

  -- Locking the night makes a tab that is being opened right now finish
  -- first, so the count below includes it.
  select * into v_night from public.rnmb_nights where id = v_id for update;
  if not found then
    raise exception 'RNMB: that night does not exist.';
  end if;
  if v_night.ended_at is not null then
    raise exception 'RNMB: this % night has already ended.', v_night.kind;
  end if;

  if v_night.kind = 'host' then
    select count(*) into v_open
      from public.rnmb_guest_tabs
     where night_id = v_id and status = 'open';
    if v_open > 0 then
      raise exception 'RNMB: % tab(s) are still open; close each one as paid or written off before ending the night.',
        v_open;
    end if;
  end if;

  update public.rnmb_nights set ended_at = now() where id = v_id;

  return v_id;
end;
$$;

-- End a host night. Kept for dashboards deployed before rnmb_end_night: it
-- refuses anything but a host night, then does exactly what rnmb_end_night does.
-- payload: id
create or replace function public.rnmb_end_host_night(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_kind text;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  select kind into v_kind from public.rnmb_nights where id = nullif(payload ->> 'id', '')::uuid;
  if not found then
    raise exception 'RNMB: that night does not exist.';
  end if;
  if v_kind <> 'host' then
    raise exception 'RNMB: only a host night can be ended.';
  end if;

  return public.rnmb_end_night(payload);
end;
$$;

-- Set a stock item's remaining level by hand, recorded as a correction.
-- payload: id (optional, the correction's id), bottle_id, new_remaining
create or replace function public.rnmb_correct_stock(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_new numeric;
  v_bottle record;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := coalesce(nullif(payload ->> 'id', '')::uuid, gen_random_uuid());
  v_new := (payload ->> 'new_remaining')::numeric;

  select b.id, b.size_oz, b.remaining_oz, t.name as type_name, t.measure
    into v_bottle
    from public.rnmb_bottles b
    join public.rnmb_beverage_types t on t.id = b.type_id
   where b.id = nullif(payload ->> 'bottle_id', '')::uuid
     for update of b;
  if not found then
    raise exception 'RNMB: that stock item does not exist.';
  end if;
  if v_new is null or v_new < 0 or v_new > v_bottle.size_oz then
    raise exception 'RNMB: the new level must be between 0 and % (the item''s size).', v_bottle.size_oz;
  end if;
  if v_new <> round(v_new, 2) then
    raise exception 'RNMB: amounts are kept to two decimal places, and % has more.', v_new;
  end if;
  if v_bottle.measure = 'unit' and v_new <> trunc(v_new) then
    raise exception 'RNMB: % is counted stock and is counted in whole units.', v_bottle.type_name;
  end if;

  insert into public.rnmb_stock_adjustments (id, bottle_id, previous_remaining, new_remaining)
  values (v_id, v_bottle.id, v_bottle.remaining_oz, v_new);

  update public.rnmb_bottles set remaining_oz = v_new where id = v_bottle.id;

  return v_id;
end;
$$;

-- Log a crew pour and take its amount off the stock item, relative to the
-- level in the database right now (not a level computed in someone's browser,
-- which could undo a ring-up saved from another phone). The pour's cost and
-- the stock item's buyer are fixed here, from the stock item as it is now.
-- A crew night takes pours even after it ended; an ended host night does not.
-- payload: id, night_id, person_id, bottle_id, ounces (in the type's measure),
--   poured_at (optional). The ABV snapshot is taken from the type.
create or replace function public.rnmb_add_crew_pour(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_night record;
  v_person_id uuid;
  v_amount numeric;
  v_bottle record;
  v_cost_cents integer;
  v_buyer_name text;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_person_id := nullif(payload ->> 'person_id', '')::uuid;
  v_amount := (payload ->> 'ounces')::numeric;

  if v_id is null then
    raise exception 'RNMB: a pour needs an id.';
  end if;
  if exists (select 1 from public.rnmb_pours where id = v_id) then
    raise exception 'RNMB: pour % was already logged.', v_id;
  end if;

  select * into v_night from public.rnmb_nights
   where id = nullif(payload ->> 'night_id', '')::uuid
     for share;
  if not found then
    raise exception 'RNMB: that night does not exist.';
  end if;
  if v_night.kind = 'host' and v_night.ended_at is not null then
    raise exception 'RNMB: this host night has ended, so no more pours can be logged.';
  end if;

  if not exists (select 1 from public.rnmb_people where id = v_person_id) then
    raise exception 'RNMB: that crew member does not exist.';
  end if;

  if v_amount is null or v_amount <= 0 then
    raise exception 'RNMB: a pour needs an amount above zero.';
  end if;
  if v_amount <> round(v_amount, 2) then
    raise exception 'RNMB: amounts are kept to two decimal places, and % has more.', v_amount;
  end if;

  select b.id, b.nickname, b.size_oz, b.remaining_oz, b.price, b.buyer_id,
         t.name as type_name, t.measure, t.abv
    into v_bottle
    from public.rnmb_bottles b
    join public.rnmb_beverage_types t on t.id = b.type_id
   where b.id = nullif(payload ->> 'bottle_id', '')::uuid
     for update of b;
  if not found then
    raise exception 'RNMB: that stock item does not exist.';
  end if;
  if v_bottle.abv <= 0 then
    raise exception 'RNMB: crew pours are for alcoholic stock, and % has no alcohol.', v_bottle.type_name;
  end if;
  if v_bottle.measure = 'unit' and v_amount <> trunc(v_amount) then
    raise exception 'RNMB: % is counted stock and is poured in whole units.', v_bottle.type_name;
  end if;
  if v_bottle.remaining_oz < v_amount then
    raise exception 'RNMB: not enough left in % (% left, % needed), so the pour was not logged.',
      coalesce(nullif(v_bottle.nickname, ''), v_bottle.type_name), v_bottle.remaining_oz, v_amount;
  end if;

  -- Cost in whole cents: price in cents / size x amount. Dividing last keeps
  -- the numeric exact until the one rounding, and round() on a numeric rounds
  -- a half away from zero, which for a cost (never negative) is half-up.
  v_cost_cents := round(v_bottle.price * 100 * v_amount / v_bottle.size_oz)::integer;

  v_buyer_name := null;
  if v_bottle.buyer_id is not null then
    select name into v_buyer_name from public.rnmb_people where id = v_bottle.buyer_id;
  end if;

  update public.rnmb_bottles
     set remaining_oz = remaining_oz - v_amount
   where id = v_bottle.id;

  insert into public.rnmb_pours (
    id, night_id, person_id, bottle_id, ounces, abv_snapshot, poured_at,
    cost_cents, buyer_id, buyer_name
  ) values (
    v_id, v_night.id, v_person_id, v_bottle.id, v_amount, v_bottle.abv,
    coalesce(nullif(payload ->> 'poured_at', '')::timestamptz, now()),
    v_cost_cents, v_bottle.buyer_id, v_buyer_name
  );

  return v_id;
end;
$$;

-- Remove a crew pour and give back only that pour's amount (never above the
-- stock item's size).
-- payload: id
create or replace function public.rnmb_remove_crew_pour(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_pour record;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;

  select * into v_pour from public.rnmb_pours where id = v_id for update;
  if not found then
    raise exception 'RNMB: that pour does not exist (it may already have been removed).';
  end if;

  delete from public.rnmb_pours where id = v_id;

  update public.rnmb_bottles
     set remaining_oz = least(size_oz, remaining_oz + v_pour.ounces)
   where id = v_pour.bottle_id;

  return v_id;
end;
$$;

-- Record a payment from one crew member to another. Names are snapshotted so
-- the payment still reads correctly after either person is removed.
-- payload: id, from_person_id, to_person_id, amount_cents (whole cents above
--   zero), paid_at (optional)
create or replace function public.rnmb_record_payment(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_from_id uuid;
  v_to_id uuid;
  v_from_name text;
  v_to_name text;
  v_amount numeric;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  v_from_id := nullif(payload ->> 'from_person_id', '')::uuid;
  v_to_id := nullif(payload ->> 'to_person_id', '')::uuid;
  v_amount := (payload ->> 'amount_cents')::numeric;

  if v_id is null then
    raise exception 'RNMB: a payment needs an id.';
  end if;
  -- The dashboard creates the id when the payment is started, so a retried or
  -- double-tapped save arrives with the same id and is refused here.
  if exists (select 1 from public.rnmb_payments where id = v_id) then
    raise exception 'RNMB: payment % was already recorded.', v_id;
  end if;

  if v_amount is null or v_amount <= 0 or v_amount <> trunc(v_amount) then
    raise exception 'RNMB: a payment needs an amount above zero, in whole cents.';
  end if;

  if v_from_id is null or v_to_id is null then
    raise exception 'RNMB: a payment needs the crew member who paid and the one who was paid.';
  end if;
  if v_from_id = v_to_id then
    raise exception 'RNMB: a payment must be between two different crew members.';
  end if;
  select name into v_from_name from public.rnmb_people where id = v_from_id;
  if not found then
    raise exception 'RNMB: the crew member who paid does not exist.';
  end if;
  select name into v_to_name from public.rnmb_people where id = v_to_id;
  if not found then
    raise exception 'RNMB: the crew member who was paid does not exist.';
  end if;

  insert into public.rnmb_payments (
    id, from_person_id, from_name, to_person_id, to_name, amount_cents, paid_at
  ) values (
    v_id, v_from_id, v_from_name, v_to_id, v_to_name, v_amount::integer,
    coalesce(nullif(payload ->> 'paid_at', '')::timestamptz, now())
  );

  return v_id;
end;
$$;

-- Void a payment recorded by mistake: stamp voided_at. The row is kept.
-- payload: id
create or replace function public.rnmb_void_payment(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_payment record;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  select * into v_payment from public.rnmb_payments where id = v_id for update;
  if not found then
    raise exception 'RNMB: that payment does not exist.';
  end if;
  if v_payment.voided_at is not null then
    raise exception 'RNMB: that payment was already voided.';
  end if;

  update public.rnmb_payments set voided_at = now() where id = v_id;

  return v_id;
end;
$$;

-- Remove a crew member from the roster, but only while nothing the delete
-- destroys was carrying money. Of the nine columns that name a person, exactly
-- one cascades: rnmb_pours.person_id, the drinker. Deleting the person deletes
-- those pours, and a cost-stamped pour is a debit against the drinker and a
-- credit to whoever bought the bottle, so that credit would vanish with it.
-- Every other reference is `on delete set null` beside a name snapshot, so the
-- payment, tab, ring-up, line or bottle survives and its money stays under the
-- name. Requirement 0.5.7 is enforced here, where the rows are, with the person
-- locked first, because a browser can be working from a copy of the balances
-- that is minutes old; the dashboard keeps its own finer check ("their own
-- balance is not $0.00 yet") as the friendly first message.
-- payload: id
create or replace function public.rnmb_remove_person(payload jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
  v_name text;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;

  v_id := nullif(payload ->> 'id', '')::uuid;
  select name into v_name from public.rnmb_people where id = v_id for update;
  if not found then
    raise exception 'RNMB: that crew member does not exist.';
  end if;

  if exists (
    select 1 from public.rnmb_pours
     where person_id = v_id and cost_cents is not null
  ) then
    raise exception 'RNMB: % drank drinks that cost money, and removing them would erase those drinks and change somebody else''s balance, so they stay on the roster.', v_name;
  end if;

  delete from public.rnmb_people where id = v_id;

  return v_id;
end;
$$;

-- Same grants as rnmb_authorized(): nobody by default, then the two roles the
-- publishable key can act as.
-- Safe saves (supabase/safe-saves.sql). Replace every table in one transaction.
-- payload: { "tables": { "<table>": [rows...], ... }, "settings": { settings row } }
--   Every row in one table's list carries the same keys, as a PostgREST bulk
--   insert needs; the keys of the first row are the columns written. A table
--   that is missing from "tables" ends up empty.
-- Menu item versions and the pricing version go UP, never back to 1, so an edit
-- form that was open before the replace is refused rather than matching a reset
-- version by chance.
-- Every DELETE and UPDATE has a WHERE clause: through the Supabase API, Postgres
-- refuses one without (the safeupdate extension), even inside a function.
create or replace function public.rnmb_replace_all(payload jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  -- Parents before children. Deletes run in the reverse order.
  v_tables text[] := array[
    'rnmb_people', 'rnmb_beverage_types', 'rnmb_nights', 'rnmb_bottles', 'rnmb_pours',
    'rnmb_menu_items', 'rnmb_recipe_ingredients', 'rnmb_guest_tabs', 'rnmb_ring_ups',
    'rnmb_ring_up_lines', 'rnmb_stock_adjustments', 'rnmb_payments'
  ];
  v_rows jsonb;
  v_table text;
  v_cols text;
  v_sets text;
  v_settings jsonb;
  v_old_menu jsonb;
  v_old_pricing integer;
  v_unknown text;
  i integer;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(payload -> 'tables') is distinct from 'object' then
    raise exception 'RNMB: the replacement data has no tables, so nothing was replaced.';
  end if;
  select k into v_unknown
    from jsonb_object_keys(payload -> 'tables') k
   where k <> all (v_tables)
   limit 1;
  if v_unknown is not null then
    raise exception 'RNMB: % is not a table the dashboard can replace, so nothing was replaced.', v_unknown;
  end if;

  select coalesce(jsonb_object_agg(id::text, version), '{}'::jsonb) into v_old_menu
    from public.rnmb_menu_items;
  select pricing_version into v_old_pricing from public.rnmb_settings where id;

  update public.rnmb_settings set active_night_id = null where id;
  for i in reverse array_length(v_tables, 1) .. 1 loop
    execute format('delete from public.%I where id is not null', v_tables[i]);
  end loop;

  foreach v_table in array v_tables loop
    v_rows := payload -> 'tables' -> v_table;
    continue when v_rows is null or jsonb_typeof(v_rows) <> 'array' or jsonb_array_length(v_rows) = 0;
    select string_agg(quote_ident(k), ', ') into v_cols
      from jsonb_object_keys(v_rows -> 0) k;
    execute format(
      'insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)',
      v_table, v_cols, v_cols, v_table
    ) using v_rows;
  end loop;

  update public.rnmb_menu_items m
     set version = coalesce((v_old_menu ->> m.id::text)::integer, 0) + 1
   where m.id is not null;

  -- The settings row: written from the payload, but never its version.
  v_settings := coalesce(payload -> 'settings', '{}'::jsonb) - 'pricing_version' || '{"id": true}'::jsonb;
  select string_agg(quote_ident(k), ', '),
         string_agg(format('%1$I = excluded.%1$I', k), ', ')
    into v_cols, v_sets
    from jsonb_object_keys(v_settings) k;
  execute format(
    'insert into public.rnmb_settings (%s) select %s from jsonb_populate_record(null::public.rnmb_settings, $1) '
    'on conflict (id) do update set %s',
    v_cols, v_cols, v_sets
  ) using v_settings;
  update public.rnmb_settings set pricing_version = coalesce(v_old_pricing, 0) + 1 where id;
end;
$$;

-- Save a menu item and its whole recipe in one transaction.
-- payload: id, name, kind, version (the version the edit started from; null for
--   a new item), ingredients [{ id, type_id, amount, line_no }].
-- Returns the item's new version.
create or replace function public.rnmb_save_menu_item(payload jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_id uuid := nullif(payload ->> 'id', '')::uuid;
  v_expected integer := nullif(payload ->> 'version', '')::integer;
  v_ingredients jsonb := payload -> 'ingredients';
  v_current integer;
  v_written integer;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;
  if v_id is null then
    raise exception 'RNMB: a menu item needs an id.';
  end if;
  if jsonb_typeof(v_ingredients) is distinct from 'array' or jsonb_array_length(v_ingredients) = 0 then
    raise exception 'RNMB: a menu item needs at least one ingredient.';
  end if;

  if v_expected is null then
    if exists (select 1 from public.rnmb_menu_items where id = v_id) then
      raise exception 'RNMB: that menu item was already saved, so it was not added twice. The latest menu is loaded.';
    end if;
    v_current := 1;
    insert into public.rnmb_menu_items (id, name, kind, version)
    values (v_id, payload ->> 'name', payload ->> 'kind', v_current);
  else
    select version into v_current from public.rnmb_menu_items where id = v_id for update;
    if not found then
      raise exception 'RNMB: someone removed this menu item while you were editing it, so nothing was saved. The latest menu is loaded.';
    end if;
    if v_current <> v_expected then
      raise exception 'RNMB: someone else changed this menu item while you were editing it, so nothing was saved. The latest version is loaded; make your change again.';
    end if;
    v_current := v_current + 1;
    update public.rnmb_menu_items
       set name = payload ->> 'name', kind = payload ->> 'kind', version = v_current
     where id = v_id;
    delete from public.rnmb_recipe_ingredients
     where menu_item_id = v_id
       and id not in (
         select (e ->> 'id')::uuid from jsonb_array_elements(v_ingredients) e
          where nullif(e ->> 'id', '') is not null
       );
  end if;

  insert into public.rnmb_recipe_ingredients (id, menu_item_id, type_id, amount, line_no)
  select coalesce(nullif(e ->> 'id', '')::uuid, gen_random_uuid()),
         v_id,
         nullif(e ->> 'type_id', '')::uuid,
         (e ->> 'amount')::numeric,
         coalesce((e ->> 'line_no')::integer, (n - 1)::integer)
    from jsonb_array_elements(v_ingredients) with ordinality as x(e, n)
  on conflict (id) do update
     set type_id = excluded.type_id, amount = excluded.amount, line_no = excluded.line_no
   where public.rnmb_recipe_ingredients.menu_item_id = excluded.menu_item_id;
  get diagnostics v_written = row_count;
  -- A line skipped by the WHERE above belongs to another menu item.
  if v_written <> jsonb_array_length(v_ingredients) then
    raise exception 'RNMB: an ingredient of this item already belongs to another menu item, so nothing was saved.';
  end if;

  return v_current;
end;
$$;

-- Save the markup and the rounding against the pricing version.
-- payload: markup_percent, rounding_increment_cents, version (the version the
--   edit started from). Returns the new pricing version.
create or replace function public.rnmb_save_pricing(payload jsonb)
returns integer
language plpgsql
set search_path = public
as $$
declare
  v_markup numeric := (payload ->> 'markup_percent')::numeric;
  v_increment integer := (payload ->> 'rounding_increment_cents')::integer;
  v_expected integer := nullif(payload ->> 'version', '')::integer;
  v_current integer;
begin
  if not public.rnmb_authorized() then
    raise exception 'RNMB: the passphrase is missing or wrong, so nothing was saved.'
      using errcode = '42501';
  end if;
  if v_markup is null or v_markup < 0 or v_markup >= 10000 then
    raise exception 'RNMB: the markup must be a percentage from 0 up to 9999.99.';
  end if;
  if v_markup <> round(v_markup, 2) then
    raise exception 'RNMB: the markup is kept to two decimal places, and % has more.', v_markup;
  end if;
  if v_increment is null or v_increment <= 0 then
    raise exception 'RNMB: round up to a whole number of cents, 1 or more.';
  end if;

  select pricing_version into v_current from public.rnmb_settings where id for update;
  if not found then
    insert into public.rnmb_settings (id, markup_percent, rounding_increment_cents, pricing_version)
    values (true, v_markup, v_increment, 1);
    return 1;
  end if;
  if v_expected is null or v_current <> v_expected then
    raise exception 'RNMB: someone else changed the pricing while you were editing it, so nothing was saved. The latest pricing is loaded; make your change again.';
  end if;

  v_current := v_current + 1;
  update public.rnmb_settings
     set markup_percent = v_markup, rounding_increment_cents = v_increment, pricing_version = v_current
   where id;
  return v_current;
end;
$$;

revoke all on function public.rnmb_ring_up(jsonb) from public;
revoke all on function public.rnmb_void_ring_up(jsonb) from public;
revoke all on function public.rnmb_open_tab(jsonb) from public;
revoke all on function public.rnmb_close_tab(jsonb) from public;
revoke all on function public.rnmb_start_host_night(jsonb) from public;
revoke all on function public.rnmb_end_night(jsonb) from public;
revoke all on function public.rnmb_end_host_night(jsonb) from public;
revoke all on function public.rnmb_correct_stock(jsonb) from public;
revoke all on function public.rnmb_add_crew_pour(jsonb) from public;
revoke all on function public.rnmb_remove_crew_pour(jsonb) from public;
revoke all on function public.rnmb_record_payment(jsonb) from public;
revoke all on function public.rnmb_void_payment(jsonb) from public;
revoke all on function public.rnmb_remove_person(jsonb) from public;
revoke all on function public.rnmb_replace_all(jsonb) from public;
revoke all on function public.rnmb_save_menu_item(jsonb) from public;
revoke all on function public.rnmb_save_pricing(jsonb) from public;

grant execute on function public.rnmb_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_void_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_open_tab(jsonb) to anon, authenticated;
grant execute on function public.rnmb_close_tab(jsonb) to anon, authenticated;
grant execute on function public.rnmb_start_host_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_end_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_end_host_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_correct_stock(jsonb) to anon, authenticated;
grant execute on function public.rnmb_add_crew_pour(jsonb) to anon, authenticated;
grant execute on function public.rnmb_remove_crew_pour(jsonb) to anon, authenticated;
grant execute on function public.rnmb_record_payment(jsonb) to anon, authenticated;
grant execute on function public.rnmb_void_payment(jsonb) to anon, authenticated;
grant execute on function public.rnmb_remove_person(jsonb) to anon, authenticated;
grant execute on function public.rnmb_replace_all(jsonb) to anon, authenticated;
grant execute on function public.rnmb_save_menu_item(jsonb) to anon, authenticated;
grant execute on function public.rnmb_save_pricing(jsonb) to anon, authenticated;

-- Set a real passphrase before anyone uses the dashboard.
insert into public.rnmb_access (id, passphrase)
values (true, 'CHANGE-ME')
on conflict (id) do nothing;

insert into public.rnmb_settings (id, responsible_mode)
values (true, true)
on conflict (id) do nothing;
