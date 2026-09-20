-- RNMB Command Center — crew running balance: drink costs, payments between
-- crew members, who wrote a tab off, and crew nights that can end.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- AFTER deploying the version of the dashboard that shows crew balances. That
-- order is deliberate: the new dashboard sends no crew-balance column and no
-- write-off author until it has seen this file run, so it works unchanged
-- against a database that has not had it yet — while an OLD dashboard against a
-- migrated database cannot write off a guest tab at all, because the new
-- rnmb_close_tab refuses a write-off with no author and the old one never sends
-- one. It is safe to re-run: every statement either checks whether its object
-- already exists or replaces it, and no existing row is deleted or changed.
--
-- It needs NO edits. There is no passphrase in this file; every new table and
-- function reuses the passphrase you already set, through rnmb_authorized().
-- Run rls-passphrase.sql and host-mode.sql first if you never have.
--
-- Afterwards, run supabase/checks/crew-balance-checks.sql to prove it works.
-- That script changes nothing: it rolls everything back at the end.
--
-- If you ever re-run host-mode.sql after this file, what happens depends on
-- whether a crew night has ended yet. Once one has, host-mode.sql re-adds its
-- own rnmb_nights_ended_host_only constraint (ended_at is null or kind =
-- 'host'), Postgres checks it against every existing row, the ended crew night
-- fails it, and the whole script aborts and changes nothing — nothing here needs
-- redoing. Before any crew night has ended, host-mode.sql succeeds and does put
-- back the older night rules and functions this file replaces; run this file
-- again right after it in that case.
--
-- What it adds:
--   * Crew pours learn what they cost, in whole cents, and whose bottle they
--     came from. Both are fixed when the pour is logged, so editing a bottle's
--     price later never rewrites an old balance. Pours logged before this file
--     ran have no cost (the column stays empty for them).
--   * A payments table: one crew member paying another back. A payment is
--     never deleted; a mistake is voided, which keeps it in the history.
--   * Guest tabs learn which crew member wrote them off. A write-off now needs
--     that person.
--   * Crew nights can end, like host nights. An ended crew night still takes
--     crew drinks and voids, so a missed drink can be added afterwards; an
--     ended host night stays locked.
--   * Crew drinks can be rung up from a menu item on a crew night (open or
--     ended) as well as on a running host night. Guest drinks stay host-only.
--     An ended host night locks its guest items, but a crew drink rung up on it
--     can still be voided: it is charged at cost and sits on no tab.
--   * Removing a crew member is a function now, not a plain delete: it refuses
--     while a drink that cost money still names them as the drinker, because
--     that drink is deleted with them and its credit would go too. Everything
--     else that names them keeps the name and loses only the link, so two
--     devices working minutes apart can neither orphan a balance nor strand
--     somebody who has squared up on the roster.

-- 0. Refuse to run before the passphrase gate and host mode exist, with a
--    readable reason.
do $$
begin
  if to_regprocedure('public.rnmb_authorized()') is null then
    raise exception 'Run supabase/rls-passphrase.sql before supabase/crew-balance.sql: rnmb_authorized() does not exist yet.';
  end if;
  if to_regclass('public.rnmb_ring_ups') is null
     or to_regclass('public.rnmb_guest_tabs') is null
     or to_regprocedure('public.rnmb_ring_up(jsonb)') is null then
    raise exception 'Run supabase/host-mode.sql before supabase/crew-balance.sql: the host mode tables and functions do not exist yet.';
  end if;
end;
$$;

-- 1. Crew pours: cost in whole cents and a buyer snapshot.
--    Columns are added without inline checks or references, and each
--    constraint is dropped and re-added by name, so a second run never stacks
--    duplicate constraints. The foreign key names are the ones Postgres gives
--    the inline references in schema.sql.
alter table public.rnmb_pours add column if not exists cost_cents integer;
alter table public.rnmb_pours add column if not exists buyer_id uuid;
alter table public.rnmb_pours add column if not exists buyer_name text;

alter table public.rnmb_pours drop constraint if exists rnmb_pours_buyer_id_fkey;
alter table public.rnmb_pours add constraint rnmb_pours_buyer_id_fkey
  foreign key (buyer_id) references public.rnmb_people(id) on delete set null;
alter table public.rnmb_pours drop constraint if exists rnmb_pours_cost_cents;
alter table public.rnmb_pours add constraint rnmb_pours_cost_cents
  check (cost_cents is null or cost_cents >= 0);

comment on column public.rnmb_pours.cost_cents is
  'What the pour drew, in whole cents (purchase price / size x amount, rounded half-up), fixed when logged. Null on pours logged before costs were recorded.';
comment on column public.rnmb_pours.buyer_id is
  'Who bought the stock item the pour came from, fixed when logged.';
comment on column public.rnmb_pours.buyer_name is
  'The buyer''s name when the pour was logged, kept after that person is removed.';

-- 2. Nights: a crew night may carry ended_at too. The kind check and the
--    one-open-host-night index are unchanged.
alter table public.rnmb_nights drop constraint if exists rnmb_nights_ended_host_only;

-- 3. Guest tabs: who wrote the tab off.
alter table public.rnmb_guest_tabs add column if not exists written_off_by uuid;
alter table public.rnmb_guest_tabs add column if not exists written_off_by_name text;

alter table public.rnmb_guest_tabs drop constraint if exists rnmb_guest_tabs_written_off_by_fkey;
alter table public.rnmb_guest_tabs add constraint rnmb_guest_tabs_written_off_by_fkey
  foreign key (written_off_by) references public.rnmb_people(id) on delete set null;

-- written_off_by_name, not written_off_by, carries the rule, so the row stays
-- valid after that crew member is removed.
-- The constraint is added NOT VALID so that tabs written off before this file
-- ran (which have no author) do not stop it from running; every new or changed
-- row is still checked. The block after it validates the constraint when no
-- such older tab exists, which leaves the database exactly like schema.sql.
alter table public.rnmb_guest_tabs drop constraint if exists rnmb_guest_tabs_close_state;
alter table public.rnmb_guest_tabs add constraint rnmb_guest_tabs_close_state check (
  (status = 'open' and closed_at is null and collector_id is null
    and collector_name is null and amount_cents is null
    and written_off_by is null and written_off_by_name is null)
  or (status = 'paid' and closed_at is not null
    and collector_name is not null and amount_cents is not null
    and written_off_by is null and written_off_by_name is null)
  or (status = 'written_off' and closed_at is not null and collector_id is null
    and collector_name is null and amount_cents is null
    and written_off_by_name is not null)
) not valid;

do $$
begin
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where status = 'written_off' and written_off_by_name is null
  ) then
    alter table public.rnmb_guest_tabs validate constraint rnmb_guest_tabs_close_state;
  end if;
end;
$$;

comment on column public.rnmb_guest_tabs.written_off_by is
  'The crew member who wrote the tab off. Null on open and paid tabs, and on tabs written off before this was recorded.';
comment on column public.rnmb_guest_tabs.written_off_by_name is
  'That crew member''s name when the tab was written off, kept after that person is removed.';

-- 4. New table: payments between crew members.
--    Money is whole cents. Money history is never deleted: a wrong payment is
--    voided (voided_at), and removing a person keeps their name through the
--    name snapshot beside each person reference (on delete set null).
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

comment on column public.rnmb_payments.amount_cents is
  'Amount paid from from_person to to_person, in whole cents.';
comment on column public.rnmb_payments.voided_at is
  'Set when the payment was recorded by mistake. A voided payment moves no balance but stays in the history.';

-- Indexes for the foreign keys that Postgres checks when a person is deleted.
create index if not exists rnmb_payments_from_person_idx on public.rnmb_payments (from_person_id);
create index if not exists rnmb_payments_to_person_idx on public.rnmb_payments (to_person_id);

-- 5. Row-level security: the same passphrase gate as every other table.
alter table public.rnmb_payments enable row level security;

drop policy if exists "RNMB gated payments" on public.rnmb_payments;

create policy "RNMB gated payments" on public.rnmb_payments
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
-- publishable key can act as. (Replacing a function keeps its grants; they are
-- repeated here so this file reads complete.)
revoke all on function public.rnmb_ring_up(jsonb) from public;
revoke all on function public.rnmb_void_ring_up(jsonb) from public;
revoke all on function public.rnmb_close_tab(jsonb) from public;
revoke all on function public.rnmb_end_night(jsonb) from public;
revoke all on function public.rnmb_end_host_night(jsonb) from public;
revoke all on function public.rnmb_add_crew_pour(jsonb) from public;
revoke all on function public.rnmb_record_payment(jsonb) from public;
revoke all on function public.rnmb_void_payment(jsonb) from public;
revoke all on function public.rnmb_remove_person(jsonb) from public;

grant execute on function public.rnmb_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_void_ring_up(jsonb) to anon, authenticated;
grant execute on function public.rnmb_close_tab(jsonb) to anon, authenticated;
grant execute on function public.rnmb_end_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_end_host_night(jsonb) to anon, authenticated;
grant execute on function public.rnmb_add_crew_pour(jsonb) to anon, authenticated;
grant execute on function public.rnmb_record_payment(jsonb) to anon, authenticated;
grant execute on function public.rnmb_void_payment(jsonb) to anon, authenticated;
grant execute on function public.rnmb_remove_person(jsonb) to anon, authenticated;

-- 7. Tell the API to pick up the new table, columns and functions straight
--    away, instead of answering 404 until its schema cache refreshes.
notify pgrst, 'reload schema';
