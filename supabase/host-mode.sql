-- RNMB Command Center — host mode: stock catalog, menu, guest tabs and the bar
-- register.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- BEFORE deploying the version of the dashboard that has the register. It is
-- safe to re-run: every statement either checks whether its object already
-- exists or replaces it, and no existing row is deleted or changed.
--
-- It needs NO edits. Unlike rls-passphrase.sql there is no passphrase in this
-- file; every new table and function reuses the passphrase you already set,
-- through rnmb_authorized(). Run rls-passphrase.sql first if you never have.
--
-- Afterwards, run supabase/checks/host-mode-checks.sql to prove it works. That
-- script changes nothing: it rolls everything back at the end.
--
-- What it adds:
--   * Beverage types learn whether they are poured (ounces) or counted (units),
--     and may have 0% ABV, so mixers like lime juice can be tracked stock.
--   * Nights learn whether they are a crew night or a host night, and when a
--     host night ended. At most one host night can be open at a time.
--   * Settings learn the markup percentage and the price rounding increment.
--   * New tables for menu items, their recipes, guest tabs, ring-ups (every
--     drink the register records), the stock each ring-up drew from, and hand
--     corrections of stock levels.
--   * Functions that save each register action in ONE call. A function runs
--     inside a single transaction, so if any check fails nothing is written:
--     stock can never be deducted without the sale being recorded.

-- 0. Refuse to run before the passphrase gate exists, with a readable reason.
do $$
begin
  if to_regprocedure('public.rnmb_authorized()') is null then
    raise exception 'Run supabase/rls-passphrase.sql before supabase/host-mode.sql: rnmb_authorized() does not exist yet.';
  end if;
end;
$$;

-- 1. Beverage types: poured or counted, and mixers with no alcohol.
--    Columns are added without inline checks, and each check is dropped and
--    re-added by name, so a second run never stacks duplicate constraints.
alter table public.rnmb_beverage_types add column if not exists measure text not null default 'oz';
alter table public.rnmb_beverage_types add column if not exists unit_oz numeric(8, 2);

alter table public.rnmb_beverage_types drop constraint if exists rnmb_beverage_types_abv_check;
alter table public.rnmb_beverage_types add constraint rnmb_beverage_types_abv_check
  check (abv >= 0 and abv <= 95);
alter table public.rnmb_beverage_types drop constraint if exists rnmb_beverage_types_measure;
alter table public.rnmb_beverage_types add constraint rnmb_beverage_types_measure
  check (measure in ('oz', 'unit'));
alter table public.rnmb_beverage_types drop constraint if exists rnmb_beverage_types_unit_volume;
alter table public.rnmb_beverage_types add constraint rnmb_beverage_types_unit_volume
  check ((unit_oz is null or unit_oz > 0) and (measure = 'oz' or unit_oz is not null));

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

-- 2. Nights: crew or host, and when a host night ended.
alter table public.rnmb_nights add column if not exists kind text not null default 'crew';
alter table public.rnmb_nights add column if not exists ended_at timestamptz;

alter table public.rnmb_nights drop constraint if exists rnmb_nights_kind;
alter table public.rnmb_nights add constraint rnmb_nights_kind
  check (kind in ('crew', 'host'));
alter table public.rnmb_nights drop constraint if exists rnmb_nights_ended_host_only;
alter table public.rnmb_nights add constraint rnmb_nights_ended_host_only
  check (ended_at is null or kind = 'host');

-- A partial unique index: every open host night has the same value in the
-- indexed column, so a second open host night would be a duplicate.
create unique index if not exists rnmb_nights_one_open_host
  on public.rnmb_nights (kind)
  where kind = 'host' and ended_at is null;

-- 3. Settings: markup and rounding. Defaults invent no profit: 0% markup, and
--    prices rounded up to the next 25 cents.
alter table public.rnmb_settings add column if not exists markup_percent numeric(6, 2) not null default 0;
alter table public.rnmb_settings add column if not exists rounding_increment_cents integer not null default 25;

alter table public.rnmb_settings drop constraint if exists rnmb_settings_markup_percent;
alter table public.rnmb_settings add constraint rnmb_settings_markup_percent
  check (markup_percent >= 0);
alter table public.rnmb_settings drop constraint if exists rnmb_settings_rounding_increment_cents;
alter table public.rnmb_settings add constraint rnmb_settings_rounding_increment_cents
  check (rounding_increment_cents > 0);

comment on column public.rnmb_settings.rounding_increment_cents is
  'Drink prices are rounded UP to a multiple of this many cents (25 = $0.25).';

-- 4. New tables.
--    Money is whole cents. Money history is never deleted: a stock item that a
--    ring-up drew from cannot be deleted (on delete restrict), and removing a
--    person keeps their name on past records through a name snapshot column
--    beside each person reference (on delete set null).
create table if not exists public.rnmb_menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  kind text not null check (kind in ('cocktail', 'straight', 'counted')),
  created_at timestamptz not null default now()
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
  -- collector_name, not collector_id, carries the rule, so the row stays valid
  -- after the collector is removed from the crew.
  constraint rnmb_guest_tabs_close_state check (
    (status = 'open' and closed_at is null and collector_id is null
      and collector_name is null and amount_cents is null)
    or (status = 'paid' and closed_at is not null
      and collector_name is not null and amount_cents is not null)
    or (status = 'written_off' and closed_at is not null and collector_id is null
      and collector_name is null and amount_cents is null)
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

-- 5. Row-level security: the same passphrase gate as every other table.
--    One `for all` policy per table covers select, insert, update and delete.
alter table public.rnmb_menu_items enable row level security;
alter table public.rnmb_recipe_ingredients enable row level security;
alter table public.rnmb_guest_tabs enable row level security;
alter table public.rnmb_ring_ups enable row level security;
alter table public.rnmb_ring_up_lines enable row level security;
alter table public.rnmb_stock_adjustments enable row level security;

drop policy if exists "RNMB gated menu items" on public.rnmb_menu_items;
drop policy if exists "RNMB gated recipe ingredients" on public.rnmb_recipe_ingredients;
drop policy if exists "RNMB gated guest tabs" on public.rnmb_guest_tabs;
drop policy if exists "RNMB gated ring-ups" on public.rnmb_ring_ups;
drop policy if exists "RNMB gated ring-up lines" on public.rnmb_ring_up_lines;
drop policy if exists "RNMB gated stock adjustments" on public.rnmb_stock_adjustments;

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

-- 6. One-call functions.
--    The browser calls each one as POST /rest/v1/rpc/<name> with the body
--    {"payload": {...}}. They run as the CALLER (not SECURITY DEFINER), so the
--    gated policies above still apply, and each one checks the passphrase
--    first anyway so that a wrong passphrase gets a clear refusal instead of a
--    confusing "not found". Any failed rule raises an error whose message
--    starts with "RNMB:" and says what to fix; because a function call is one
--    transaction, nothing it did before the error is kept.

-- Ring up one menu item, for a guest tab or a crew member.
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
  if v_night.kind <> 'host' then
    raise exception 'RNMB: drinks can only be rung up on a host night.';
  end if;
  if v_night.ended_at is not null then
    raise exception 'RNMB: this host night has ended, so nothing more can be rung up.';
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
-- item it came from (never above that item's size).
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

  select * into v_night from public.rnmb_nights where id = v_ring_up.night_id for share;
  if v_night.ended_at is not null then
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
-- item not voided, and the collecting crew member is recorded) or written off.
-- payload: id, status ('paid' | 'written_off'), collector_id (paid), amount_cents (paid)
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
    update public.rnmb_guest_tabs
       set status = 'written_off',
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

-- End a host night. Refused while any of its tabs is still open.
-- payload: id
create or replace function public.rnmb_end_host_night(payload jsonb)
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
  if v_night.kind <> 'host' then
    raise exception 'RNMB: only a host night can be ended.';
  end if;
  if v_night.ended_at is not null then
    raise exception 'RNMB: this host night has already ended.';
  end if;

  select count(*) into v_open
    from public.rnmb_guest_tabs
   where night_id = v_id and status = 'open';
  if v_open > 0 then
    raise exception 'RNMB: % tab(s) are still open; close each one as paid or written off before ending the night.',
      v_open;
  end if;

  update public.rnmb_nights set ended_at = now() where id = v_id;

  return v_id;
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
-- which could undo a ring-up saved from another phone).
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
  if v_night.ended_at is not null then
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

  select b.id, b.nickname, b.remaining_oz, t.name as type_name, t.measure, t.abv
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

  update public.rnmb_bottles
     set remaining_oz = remaining_oz - v_amount
   where id = v_bottle.id;

  insert into public.rnmb_pours (id, night_id, person_id, bottle_id, ounces, abv_snapshot, poured_at)
  values (
    v_id, v_night.id, v_person_id, v_bottle.id, v_amount, v_bottle.abv,
    coalesce(nullif(payload ->> 'poured_at', '')::timestamptz, now())
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

-- Same grants as rnmb_authorized(): nobody by default, then the two roles the
-- publishable key can act as.
revoke all on function public.rnmb_ring_up(jsonb) from public;
revoke all on function public.rnmb_void_ring_up(jsonb) from public;
revoke all on function public.rnmb_open_tab(jsonb) from public;
revoke all on function public.rnmb_close_tab(jsonb) from public;
revoke all on function public.rnmb_start_host_night(jsonb) from public;
revoke all on function public.rnmb_end_host_night(jsonb) from public;
revoke all on function public.rnmb_correct_stock(jsonb) from public;
revoke all on function public.rnmb_add_crew_pour(jsonb) from public;
revoke all on function public.rnmb_remove_crew_pour(jsonb) from public;

grant execute on function public.rnmb_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_void_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_open_tab(jsonb) to anon, authenticated;
grant execute on function public.rnmb_close_tab(jsonb) to anon, authenticated;
grant execute on function public.rnmb_start_host_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_end_host_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_correct_stock(jsonb) to anon, authenticated;
grant execute on function public.rnmb_add_crew_pour(jsonb) to anon, authenticated;
grant execute on function public.rnmb_remove_crew_pour(jsonb) to anon, authenticated;

-- 7. Tell the API to pick up the new tables and functions straight away,
--    instead of answering 404 until its schema cache refreshes.
notify pgrst, 'reload schema';
