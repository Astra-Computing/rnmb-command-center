-- RNMB Command Center — host mode checks.
--
-- Run this in the Supabase SQL editor AFTER supabase/host-mode.sql. It needs no
-- edits and changes nothing: it works inside one transaction and the last line
-- rolls every change back, including the test people, stock and tabs it makes.
--
-- What you should see: one row, `checks_passed` with a number and a `result`
-- saying every check passed. If a rule is broken, the editor instead shows an
-- error starting with "CHECK FAILED" that names the check and what happened.
--
-- Why it is built this way: the SQL editor runs as the table owner, which skips
-- row-level security, and sends no x-rnmb-key header. So the script copies the
-- stored passphrase into the request headers (the passphrase itself is never
-- written in this file) and switches to the `anon` role — the role the
-- publishable key uses — so every function and policy runs exactly as it does
-- for the browser.
--
-- The pass counter lives in a transaction-local setting (rnmb.checks_passed)
-- rather than a table, because `anon` can always set its own settings.
-- Test ids are fixed values made mostly of zeros, so they will not collide
-- with the random ids the dashboard creates.

begin;

-- 1. Preconditions and catalog checks, as the table owner.
do $$
declare
  v_table text;
  v_new_tables text[] := array[
    'rnmb_menu_items', 'rnmb_recipe_ingredients', 'rnmb_guest_tabs',
    'rnmb_ring_ups', 'rnmb_ring_up_lines', 'rnmb_stock_adjustments'
  ];
begin
  perform set_config('rnmb.checks_passed', '0', true);

  if to_regclass('public.rnmb_ring_ups') is null
     or to_regprocedure('public.rnmb_ring_up(jsonb)') is null then
    raise exception 'CHECK SETUP: run supabase/host-mode.sql before this script.';
  end if;
  if not exists (select 1 from public.rnmb_access where passphrase <> '') then
    raise exception 'CHECK SETUP: no passphrase is stored; run supabase/rls-passphrase.sql with a real passphrase first.';
  end if;

  -- Every new table: row-level security on, and a gated `for all` policy.
  foreach v_table in array v_new_tables loop
    if not exists (
      select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = v_table and c.relrowsecurity
    ) then
      raise exception 'CHECK FAILED (rls): row-level security is not enabled on public.%.', v_table;
    end if;
    if not exists (
      select 1
        from pg_policies p
       where p.schemaname = 'public'
         and p.tablename = v_table
         and p.cmd = 'ALL'
         and p.qual like '%rnmb_authorized()%'
         and p.with_check like '%rnmb_authorized()%'
    ) then
      raise exception 'CHECK FAILED (rls): public.% has no gated policy calling rnmb_authorized().', v_table;
    end if;
  end loop;

  -- And no rnmb_ table anywhere has row-level security switched off.
  select tablename into v_table
    from pg_tables
   where schemaname = 'public' and tablename like 'rnmb\_%' and not rowsecurity
   limit 1;
  if v_table is not null then
    raise exception 'CHECK FAILED (rls): row-level security is not enabled on public.%.', v_table;
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 2. Act like the browser: the stored passphrase on the x-rnmb-key header.
--    Kept in a second setting too, so the wrong-passphrase check can put the
--    right one back after `anon` loses the ability to read rnmb_access.
do $$
begin
  perform set_config('request.headers', json_build_object('x-rnmb-key', passphrase)::text, true)
     from public.rnmb_access;
  perform set_config('rnmb.good_headers', current_setting('request.headers', true), true);

  -- Only one host night may be open. If a real one is running, mark it ended
  -- for the length of this transaction so the checks can start their own; the
  -- final rollback undoes this too.
  update public.rnmb_nights set ended_at = now() where kind = 'host' and ended_at is null;
end;
$$;

set local role anon;

-- 3. Setup: the passphrase unlocks the gate, and test fixtures insert through
--    row-level security. The lime juice type has 0% ABV, which must now insert.
do $$
begin
  if not public.rnmb_authorized() then
    raise exception 'CHECK SETUP: the stored passphrase did not unlock rnmb_authorized() as anon.';
  end if;

  insert into public.rnmb_people (id, name) values
    ('10000000-0000-4000-8000-000000000001', 'Sam'),
    ('10000000-0000-4000-8000-000000000002', 'Alex'),
    ('10000000-0000-4000-8000-000000000003', 'Jordan'),
    ('10000000-0000-4000-8000-000000000004', 'Dana'),
    ('10000000-0000-4000-8000-000000000005', 'Casey'),
    ('10000000-0000-4000-8000-000000000006', 'Riley');

  insert into public.rnmb_beverage_types (id, name, category, abv, measure, unit_oz) values
    ('20000000-0000-4000-8000-000000000001', 'Check tequila', 'Tequila', 40, 'oz', null),
    ('20000000-0000-4000-8000-000000000003', 'Check beer', 'Beer', 5, 'unit', 12);

  -- Scenario: a type with ABV 0 inserts.
  insert into public.rnmb_beverage_types (id, name, category, abv, measure) values
    ('20000000-0000-4000-8000-000000000002', 'Check lime juice', 'Mixer', 0, 'oz');
  if not exists (
    select 1 from public.rnmb_beverage_types
     where id = '20000000-0000-4000-8000-000000000002' and abv = 0
  ) then
    raise exception 'CHECK FAILED (abv 0 type): the 0%% ABV type was not stored.';
  end if;

  insert into public.rnmb_bottles (id, type_id, nickname, size_oz, remaining_oz, price, buyer_id, purchase_date) values
    ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'Sam tequila', 25.36, 25.36, 30, '10000000-0000-4000-8000-000000000001', '2026-09-16'),
    ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 'Alex tequila', 25.36, 25.36, 30, '10000000-0000-4000-8000-000000000002', '2026-09-16'),
    ('30000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000002', 'Jordan lime', 32, 32, 4, '10000000-0000-4000-8000-000000000003', '2026-09-16'),
    ('30000000-0000-4000-8000-000000000004', '20000000-0000-4000-8000-000000000001', 'Dana tequila', 25.36, 25.36, 30, '10000000-0000-4000-8000-000000000004', '2026-09-16'),
    ('30000000-0000-4000-8000-000000000005', '20000000-0000-4000-8000-000000000003', 'Alex beer', 6, 6, 9, '10000000-0000-4000-8000-000000000002', '2026-09-16');

  insert into public.rnmb_menu_items (id, name, kind) values
    ('40000000-0000-4000-8000-000000000001', 'Check margarita', 'cocktail'),
    ('40000000-0000-4000-8000-000000000002', 'Check tequila shot', 'straight');

  insert into public.rnmb_recipe_ingredients (id, menu_item_id, type_id, amount, line_no) values
    ('41000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 2, 1),
    ('41000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', 1, 2),
    ('41000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', 1.5, 1);

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 4. Start a host night, then refuse a second one while it is open.
do $$
declare
  v_err text;
begin
  perform public.rnmb_start_host_night(
    '{"id": "50000000-0000-4000-8000-000000000001", "name": "Check host night", "date": "2026-09-16"}'::jsonb
  );
  if not exists (
    select 1 from public.rnmb_nights
     where id = '50000000-0000-4000-8000-000000000001' and kind = 'host' and ended_at is null
  ) then
    raise exception 'CHECK FAILED (start host night): the host night was not stored as open.';
  end if;

  -- Scenario: starting a second host night while one is open raises.
  begin
    perform public.rnmb_start_host_night(
      '{"id": "50000000-0000-4000-8000-000000000002", "name": "Second host night"}'::jsonb
    );
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%already running%' then
    raise exception 'CHECK FAILED (second host night): expected "already running", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_nights where id = '50000000-0000-4000-8000-000000000002') then
    raise exception 'CHECK FAILED (second host night): the second night was stored.';
  end if;

  perform public.rnmb_open_tab('{"id": "60000000-0000-4000-8000-000000000001", "night_id": "50000000-0000-4000-8000-000000000001", "guest_name": "Guest A"}'::jsonb);
  perform public.rnmb_open_tab('{"id": "60000000-0000-4000-8000-000000000002", "night_id": "50000000-0000-4000-8000-000000000001", "guest_name": "Guest B"}'::jsonb);
  perform public.rnmb_open_tab('{"id": "60000000-0000-4000-8000-000000000003", "night_id": "50000000-0000-4000-8000-000000000001", "guest_name": "Guest C"}'::jsonb);
  if (select count(*) from public.rnmb_guest_tabs
       where night_id = '50000000-0000-4000-8000-000000000001' and status = 'open') <> 3 then
    raise exception 'CHECK FAILED (open tab): expected 3 open tabs.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 5. A ring-up with valid lines decrements each source bottle and inserts one
--    ring-up with its lines.
do $$
begin
  perform public.rnmb_ring_up('{
    "id": "70000000-0000-4000-8000-000000000001",
    "night_id": "50000000-0000-4000-8000-000000000001",
    "kind": "guest",
    "tab_id": "60000000-0000-4000-8000-000000000001",
    "menu_item_id": "40000000-0000-4000-8000-000000000001",
    "price_cents": 500,
    "lines": [
      {"bottle_id": "30000000-0000-4000-8000-000000000001", "amount": 2, "cost_cents": 236.593060, "share_cents": 400},
      {"bottle_id": "30000000-0000-4000-8000-000000000003", "amount": 1, "cost_cents": 12.5, "share_cents": 100}
    ]
  }'::jsonb);

  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001') <> 23.36 then
    raise exception 'CHECK FAILED (valid ring-up): Sam tequila should read 23.36.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000003') <> 31 then
    raise exception 'CHECK FAILED (valid ring-up): Jordan lime should read 31.';
  end if;
  if (select count(*) from public.rnmb_ring_ups
       where id = '70000000-0000-4000-8000-000000000001'
         and kind = 'guest' and price_cents = 500 and voided_at is null
         and menu_item_name = 'Check margarita') <> 1 then
    raise exception 'CHECK FAILED (valid ring-up): expected one guest ring-up at 500 cents.';
  end if;
  if (select count(*) from public.rnmb_ring_up_lines where ring_up_id = '70000000-0000-4000-8000-000000000001') <> 2
     or (select sum(share_cents) from public.rnmb_ring_up_lines where ring_up_id = '70000000-0000-4000-8000-000000000001') <> 500
     or not exists (
       select 1 from public.rnmb_ring_up_lines
        where ring_up_id = '70000000-0000-4000-8000-000000000001'
          and bottle_id = '30000000-0000-4000-8000-000000000001'
          and type_id = '20000000-0000-4000-8000-000000000001'
          and buyer_name = 'Sam' and abv_snapshot = 40 and amount = 2 and line_no = 1
     )
     or not exists (
       select 1 from public.rnmb_ring_up_lines
        where ring_up_id = '70000000-0000-4000-8000-000000000001'
          and bottle_id = '30000000-0000-4000-8000-000000000003'
          and buyer_name = 'Jordan' and abv_snapshot = 0 and amount = 1 and line_no = 2
     ) then
    raise exception 'CHECK FAILED (valid ring-up): the two lines were not stored with their snapshots.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 6. A ring-up whose second line exceeds remaining stock raises, and the first
--    line's bottle is unchanged.
do $$
declare
  v_err text;
begin
  begin
    perform public.rnmb_ring_up('{
      "id": "70000000-0000-4000-8000-000000000002",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "kind": "guest",
      "tab_id": "60000000-0000-4000-8000-000000000001",
      "menu_item_id": "40000000-0000-4000-8000-000000000001",
      "price_cents": 500,
      "lines": [
        {"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 2, "cost_cents": 236.59, "share_cents": 300},
        {"bottle_id": "30000000-0000-4000-8000-000000000003", "amount": 999, "cost_cents": 12.5, "share_cents": 200}
      ]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%not enough left%' then
    raise exception 'CHECK FAILED (overdraw): expected "not enough left", got: %', coalesce(v_err, 'no error');
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 25.36 then
    raise exception 'CHECK FAILED (overdraw): the first line''s bottle was changed.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000003') <> 31 then
    raise exception 'CHECK FAILED (overdraw): the second line''s bottle was changed.';
  end if;
  if exists (select 1 from public.rnmb_ring_ups where id = '70000000-0000-4000-8000-000000000002')
     or exists (select 1 from public.rnmb_ring_up_lines where ring_up_id = '70000000-0000-4000-8000-000000000002') then
    raise exception 'CHECK FAILED (overdraw): a ring-up or line was stored.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 7. A ring-up whose shares do not sum to its price raises.
do $$
declare
  v_err text;
begin
  begin
    perform public.rnmb_ring_up('{
      "id": "70000000-0000-4000-8000-000000000003",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "kind": "guest",
      "tab_id": "60000000-0000-4000-8000-000000000001",
      "menu_item_id": "40000000-0000-4000-8000-000000000001",
      "price_cents": 500,
      "lines": [
        {"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 2, "cost_cents": 236.59, "share_cents": 400},
        {"bottle_id": "30000000-0000-4000-8000-000000000003", "amount": 1, "cost_cents": 12.5, "share_cents": 50}
      ]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%shares add up to 450 cents but the price is 500 cents%' then
    raise exception 'CHECK FAILED (shares): expected a shares-total refusal, got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_ring_ups where id = '70000000-0000-4000-8000-000000000003')
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 25.36 then
    raise exception 'CHECK FAILED (shares): something was written.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 8. A guest ring-up against a closed tab raises; a crew ring-up with a price
--    raises.
do $$
declare
  v_err text;
begin
  perform public.rnmb_close_tab('{"id": "60000000-0000-4000-8000-000000000002", "status": "written_off"}'::jsonb);
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = '60000000-0000-4000-8000-000000000002' and status = 'written_off' and closed_at is not null
  ) then
    raise exception 'CHECK FAILED (closed tab): Guest B was not written off.';
  end if;

  begin
    perform public.rnmb_ring_up('{
      "id": "70000000-0000-4000-8000-000000000004",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "kind": "guest",
      "tab_id": "60000000-0000-4000-8000-000000000002",
      "menu_item_id": "40000000-0000-4000-8000-000000000002",
      "price_cents": 300,
      "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 1.5, "cost_cents": 177.44, "share_cents": 300}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%tab is closed%' then
    raise exception 'CHECK FAILED (closed tab): expected "tab is closed", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_ring_up('{
      "id": "70000000-0000-4000-8000-000000000005",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "kind": "crew",
      "person_id": "10000000-0000-4000-8000-000000000001",
      "menu_item_id": "40000000-0000-4000-8000-000000000002",
      "price_cents": 300,
      "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 1.5}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%crew ring-up carries no price%' then
    raise exception 'CHECK FAILED (crew price): expected "carries no price", got: %', coalesce(v_err, 'no error');
  end if;

  if exists (select 1 from public.rnmb_ring_ups where id in ('70000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000005'))
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 25.36 then
    raise exception 'CHECK FAILED (closed tab / crew price): something was written.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 9. Covers AE4. Voiding restores every source bottle exactly and sets the
--    voided time; voiding twice raises.
do $$
declare
  v_err text;
begin
  perform public.rnmb_void_ring_up('{"id": "70000000-0000-4000-8000-000000000001"}'::jsonb);

  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001') <> 25.36
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000003') <> 32 then
    raise exception 'CHECK FAILED (void): the source bottles were not restored exactly.';
  end if;
  if not exists (
    select 1 from public.rnmb_ring_ups
     where id = '70000000-0000-4000-8000-000000000001' and voided_at is not null
  ) then
    raise exception 'CHECK FAILED (void): voided_at was not set.';
  end if;
  if (select count(*) from public.rnmb_ring_up_lines where ring_up_id = '70000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'CHECK FAILED (void): the voided ring-up lost its lines; history must be kept.';
  end if;

  begin
    perform public.rnmb_void_ring_up('{"id": "70000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%already voided%' then
    raise exception 'CHECK FAILED (void twice): expected "already voided", got: %', coalesce(v_err, 'no error');
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001') <> 25.36 then
    raise exception 'CHECK FAILED (void twice): stock was restored a second time.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 10. Closing a tab as paid needs the exact total; voiding an item on a paid
--     tab raises.
do $$
declare
  v_err text;
begin
  perform public.rnmb_ring_up('{
    "id": "70000000-0000-4000-8000-000000000006",
    "night_id": "50000000-0000-4000-8000-000000000001",
    "kind": "guest",
    "tab_id": "60000000-0000-4000-8000-000000000001",
    "menu_item_id": "40000000-0000-4000-8000-000000000002",
    "price_cents": 300,
    "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000001", "amount": 1.5, "cost_cents": 177.44, "share_cents": 300}]
  }'::jsonb);

  -- The voided margarita no longer counts, so the total is 300, not 800.
  begin
    perform public.rnmb_close_tab('{"id": "60000000-0000-4000-8000-000000000001", "status": "paid", "collector_id": "10000000-0000-4000-8000-000000000006", "amount_cents": 800}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%must equal the tab total (300 cents)%' then
    raise exception 'CHECK FAILED (paid amount): expected a tab-total refusal, got: %', coalesce(v_err, 'no error');
  end if;

  perform public.rnmb_close_tab('{"id": "60000000-0000-4000-8000-000000000001", "status": "paid", "collector_id": "10000000-0000-4000-8000-000000000006", "amount_cents": 300}'::jsonb);
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = '60000000-0000-4000-8000-000000000001'
       and status = 'paid' and amount_cents = 300 and collector_name = 'Riley' and closed_at is not null
  ) then
    raise exception 'CHECK FAILED (paid tab): Guest A was not closed as paid 300 by Riley.';
  end if;

  v_err := null;
  begin
    perform public.rnmb_void_ring_up('{"id": "70000000-0000-4000-8000-000000000006"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%tab is already closed%' then
    raise exception 'CHECK FAILED (void on paid tab): expected "tab is already closed", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_ring_ups where id = '70000000-0000-4000-8000-000000000006' and voided_at is not null)
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001') <> 23.86 then
    raise exception 'CHECK FAILED (void on paid tab): the item was voided or its stock restored.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 11. Deleting a bottle referenced by a ring-up line raises.
do $$
declare
  v_err text;
begin
  begin
    delete from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001';
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%violates foreign key constraint%' then
    raise exception 'CHECK FAILED (restrict delete): expected a foreign key refusal, got: %', coalesce(v_err, 'no error');
  end if;
  if not exists (select 1 from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000001') then
    raise exception 'CHECK FAILED (restrict delete): the sold bottle was deleted.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 12. Deleting a person referenced as a buyer, as the crew member on a crew
--     ring-up, and as a tab's collector succeeds, and all three name snapshots
--     remain readable.
do $$
declare
  v_deleted integer;
begin
  -- Casey's crew shot, poured from Dana's tequila.
  perform public.rnmb_ring_up('{
    "id": "70000000-0000-4000-8000-000000000007",
    "night_id": "50000000-0000-4000-8000-000000000001",
    "kind": "crew",
    "person_id": "10000000-0000-4000-8000-000000000005",
    "menu_item_id": "40000000-0000-4000-8000-000000000002",
    "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000004", "amount": 1.5, "cost_cents": 177.44}]
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_ring_ups
     where id = '70000000-0000-4000-8000-000000000007'
       and kind = 'crew' and price_cents is null and person_name = 'Casey'
  ) or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000004') <> 23.86
    or exists (
      select 1 from public.rnmb_ring_up_lines
       where ring_up_id = '70000000-0000-4000-8000-000000000007' and share_cents is not null
    ) then
    raise exception 'CHECK FAILED (crew ring-up): not stored with no price and stock deducted.';
  end if;

  delete from public.rnmb_people
   where id in (
     '10000000-0000-4000-8000-000000000004',
     '10000000-0000-4000-8000-000000000005',
     '10000000-0000-4000-8000-000000000006'
   );
  get diagnostics v_deleted = row_count;
  if v_deleted <> 3 then
    raise exception 'CHECK FAILED (person delete): expected 3 people deleted, got %.', v_deleted;
  end if;

  if not exists (
    select 1 from public.rnmb_ring_up_lines
     where ring_up_id = '70000000-0000-4000-8000-000000000007' and buyer_id is null and buyer_name = 'Dana'
  ) then
    raise exception 'CHECK FAILED (person delete): the buyer snapshot "Dana" was lost.';
  end if;
  if not exists (
    select 1 from public.rnmb_ring_ups
     where id = '70000000-0000-4000-8000-000000000007' and person_id is null and person_name = 'Casey'
  ) then
    raise exception 'CHECK FAILED (person delete): the crew member snapshot "Casey" was lost.';
  end if;
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = '60000000-0000-4000-8000-000000000001' and collector_id is null and collector_name = 'Riley'
  ) then
    raise exception 'CHECK FAILED (person delete): the collector snapshot "Riley" was lost.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 13. Ringing up the same ring-up id twice writes one ring-up and leaves stock
--     deducted once.
do $$
declare
  v_payload jsonb := '{
    "id": "70000000-0000-4000-8000-000000000008",
    "night_id": "50000000-0000-4000-8000-000000000001",
    "kind": "crew",
    "person_id": "10000000-0000-4000-8000-000000000001",
    "menu_item_id": "40000000-0000-4000-8000-000000000002",
    "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 1, "cost_cents": 118.30}]
  }'::jsonb;
  v_err text;
begin
  perform public.rnmb_ring_up(v_payload);
  begin
    perform public.rnmb_ring_up(v_payload);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%already saved%' then
    raise exception 'CHECK FAILED (duplicate id): expected "already saved", got: %', coalesce(v_err, 'no error');
  end if;
  if (select count(*) from public.rnmb_ring_ups where id = '70000000-0000-4000-8000-000000000008') <> 1
     or (select count(*) from public.rnmb_ring_up_lines where ring_up_id = '70000000-0000-4000-8000-000000000008') <> 1 then
    raise exception 'CHECK FAILED (duplicate id): expected exactly one ring-up with one line.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 24.36 then
    raise exception 'CHECK FAILED (duplicate id): stock was not deducted exactly once.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 14. A crew pour added through its function after a ring-up on the same
--     bottle leaves the ring-up's deduction in place; removing that pour
--     restores only the pour's amount. A pour larger than what is left raises.
do $$
declare
  v_err text;
begin
  perform public.rnmb_add_crew_pour('{
    "id": "80000000-0000-4000-8000-000000000001",
    "night_id": "50000000-0000-4000-8000-000000000001",
    "person_id": "10000000-0000-4000-8000-000000000001",
    "bottle_id": "30000000-0000-4000-8000-000000000002",
    "ounces": 1.5
  }'::jsonb);
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 22.86 then
    raise exception 'CHECK FAILED (relative pour): Alex tequila should read 22.86 (24.36 after the ring-up, minus 1.5).';
  end if;
  if not exists (
    select 1 from public.rnmb_pours
     where id = '80000000-0000-4000-8000-000000000001' and ounces = 1.5 and abv_snapshot = 40
  ) then
    raise exception 'CHECK FAILED (relative pour): the pour row was not stored with the type''s ABV.';
  end if;

  begin
    perform public.rnmb_add_crew_pour('{
      "id": "80000000-0000-4000-8000-000000000002",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "person_id": "10000000-0000-4000-8000-000000000001",
      "bottle_id": "30000000-0000-4000-8000-000000000002",
      "ounces": 999
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%not enough left%' then
    raise exception 'CHECK FAILED (pour overdraw): expected "not enough left", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_pours where id = '80000000-0000-4000-8000-000000000002')
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 22.86 then
    raise exception 'CHECK FAILED (pour overdraw): something was written.';
  end if;

  perform public.rnmb_remove_crew_pour('{"id": "80000000-0000-4000-8000-000000000001"}'::jsonb);
  if exists (select 1 from public.rnmb_pours where id = '80000000-0000-4000-8000-000000000001') then
    raise exception 'CHECK FAILED (remove pour): the pour row is still there.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000002') <> 24.36 then
    raise exception 'CHECK FAILED (remove pour): Alex tequila should be back to 24.36, keeping the ring-up''s deduction.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 15. A stock correction writes an adjustment record with previous and new
--     levels and sets the bottle's remaining; an impossible level raises.
do $$
declare
  v_err text;
begin
  perform public.rnmb_correct_stock('{
    "id": "90000000-0000-4000-8000-000000000001",
    "bottle_id": "30000000-0000-4000-8000-000000000003",
    "new_remaining": 20.5
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_stock_adjustments
     where id = '90000000-0000-4000-8000-000000000001'
       and bottle_id = '30000000-0000-4000-8000-000000000003'
       and previous_remaining = 32 and new_remaining = 20.5 and adjusted_at is not null
  ) then
    raise exception 'CHECK FAILED (correction): the adjustment record is missing or wrong.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000003') <> 20.5 then
    raise exception 'CHECK FAILED (correction): Jordan lime should read 20.5.';
  end if;

  begin
    perform public.rnmb_correct_stock('{"bottle_id": "30000000-0000-4000-8000-000000000003", "new_remaining": 40}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%must be between 0 and%' then
    raise exception 'CHECK FAILED (correction range): expected a range refusal, got: %', coalesce(v_err, 'no error');
  end if;
  if (select count(*) from public.rnmb_stock_adjustments where bottle_id = '30000000-0000-4000-8000-000000000003') <> 1
     or (select remaining_oz from public.rnmb_bottles where id = '30000000-0000-4000-8000-000000000003') <> 20.5 then
    raise exception 'CHECK FAILED (correction range): something was written.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 16. A crew pour row with ABV snapshot 0 is still rejected (the ABV 0 type
--     itself inserted in step 3), and the pour function refuses a mixer.
do $$
declare
  v_err text;
begin
  begin
    insert into public.rnmb_pours (id, night_id, person_id, bottle_id, ounces, abv_snapshot)
    values (
      '80000000-0000-4000-8000-000000000003',
      '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000003',
      1, 0
    );
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%violates check constraint%' then
    raise exception 'CHECK FAILED (pour abv 0): expected a check constraint refusal, got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_add_crew_pour('{
      "id": "80000000-0000-4000-8000-000000000004",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "person_id": "10000000-0000-4000-8000-000000000001",
      "bottle_id": "30000000-0000-4000-8000-000000000003",
      "ounces": 1
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has no alcohol%' then
    raise exception 'CHECK FAILED (mixer pour): expected "has no alcohol", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_pours where id in ('80000000-0000-4000-8000-000000000003', '80000000-0000-4000-8000-000000000004')) then
    raise exception 'CHECK FAILED (pour abv 0): a pour with no alcohol was stored.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 17. With the request header set to a wrong passphrase, every function
--     raises, a select on each new table returns no rows, and no row changes;
--     the correct header is then restored for the remaining checks.
do $$
declare
  v_before text;
  v_after text;
  v_err text;
  v_call text;
  v_rows integer;
  v_calls text[] := array[
    $c$select public.rnmb_ring_up('{"id": "70000000-0000-4000-8000-000000000009", "night_id": "50000000-0000-4000-8000-000000000001", "kind": "crew", "person_id": "10000000-0000-4000-8000-000000000001", "menu_item_id": "40000000-0000-4000-8000-000000000002", "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 1}]}'::jsonb)$c$,
    $c$select public.rnmb_void_ring_up('{"id": "70000000-0000-4000-8000-000000000008"}'::jsonb)$c$,
    $c$select public.rnmb_open_tab('{"id": "60000000-0000-4000-8000-000000000009", "night_id": "50000000-0000-4000-8000-000000000001", "guest_name": "Intruder"}'::jsonb)$c$,
    $c$select public.rnmb_close_tab('{"id": "60000000-0000-4000-8000-000000000003", "status": "written_off"}'::jsonb)$c$,
    $c$select public.rnmb_start_host_night('{"id": "50000000-0000-4000-8000-000000000009", "name": "Intruder night"}'::jsonb)$c$,
    $c$select public.rnmb_end_host_night('{"id": "50000000-0000-4000-8000-000000000001"}'::jsonb)$c$,
    $c$select public.rnmb_correct_stock('{"bottle_id": "30000000-0000-4000-8000-000000000002", "new_remaining": 0}'::jsonb)$c$,
    $c$select public.rnmb_add_crew_pour('{"id": "80000000-0000-4000-8000-000000000009", "night_id": "50000000-0000-4000-8000-000000000001", "person_id": "10000000-0000-4000-8000-000000000001", "bottle_id": "30000000-0000-4000-8000-000000000002", "ounces": 1}'::jsonb)$c$,
    $c$select public.rnmb_remove_crew_pour('{"id": "80000000-0000-4000-8000-000000000001"}'::jsonb)$c$
  ];
  v_fingerprint text := $f$
    select concat_ws('|',
      (select count(*) from public.rnmb_menu_items),
      (select count(*) from public.rnmb_recipe_ingredients),
      (select count(*) from public.rnmb_guest_tabs),
      (select count(*) from public.rnmb_guest_tabs where status = 'open'),
      (select count(*) from public.rnmb_ring_ups),
      (select count(*) from public.rnmb_ring_ups where voided_at is not null),
      (select count(*) from public.rnmb_ring_up_lines),
      (select count(*) from public.rnmb_stock_adjustments),
      (select count(*) from public.rnmb_nights),
      (select count(*) from public.rnmb_nights where ended_at is not null),
      (select count(*) from public.rnmb_pours),
      (select count(*) from public.rnmb_people),
      (select coalesce(sum(remaining_oz), 0) from public.rnmb_bottles)
    )
  $f$;
begin
  execute v_fingerprint into v_before;

  perform set_config('request.headers', json_build_object('x-rnmb-key', 'not-the-passphrase-check')::text, true);
  if public.rnmb_authorized() then
    raise exception 'CHECK FAILED (wrong passphrase): a wrong passphrase was accepted.';
  end if;

  foreach v_call in array v_calls loop
    v_err := null;
    begin
      execute v_call;
    exception when others then
      v_err := sqlerrm;
    end;
    if v_err is null or v_err not like '%passphrase is missing or wrong%' then
      raise exception 'CHECK FAILED (wrong passphrase): expected a passphrase refusal from %, got: %',
        substring(v_call from 'public\.(rnmb_[a-z_]+)'), coalesce(v_err, 'no error');
    end if;
  end loop;

  if exists (select 1 from public.rnmb_menu_items)
     or exists (select 1 from public.rnmb_recipe_ingredients)
     or exists (select 1 from public.rnmb_guest_tabs)
     or exists (select 1 from public.rnmb_ring_ups)
     or exists (select 1 from public.rnmb_ring_up_lines)
     or exists (select 1 from public.rnmb_stock_adjustments) then
    raise exception 'CHECK FAILED (wrong passphrase): a new table returned rows.';
  end if;

  update public.rnmb_bottles set remaining_oz = 0 where id is not null;
  get diagnostics v_rows = row_count;
  if v_rows <> 0 then
    raise exception 'CHECK FAILED (wrong passphrase): a direct update changed % bottle(s).', v_rows;
  end if;

  v_err := null;
  begin
    insert into public.rnmb_menu_items (name, kind) values ('Intruder special', 'straight');
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%row-level security%' then
    raise exception 'CHECK FAILED (wrong passphrase): expected a row-level security refusal on insert, got: %', coalesce(v_err, 'no error');
  end if;

  perform set_config('request.headers', current_setting('rnmb.good_headers'), true);
  if not public.rnmb_authorized() then
    raise exception 'CHECK SETUP: could not restore the correct passphrase header.';
  end if;

  execute v_fingerprint into v_after;
  if v_after is distinct from v_before then
    raise exception 'CHECK FAILED (wrong passphrase): data changed (before %, after %).', v_before, v_after;
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 18. Covers AE6. Ending a host night with an open tab raises; ending it after
--     closing the tab succeeds. An ended night takes no more ring-ups.
do $$
declare
  v_err text;
begin
  begin
    perform public.rnmb_end_host_night('{"id": "50000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%still open%' then
    raise exception 'CHECK FAILED (end with open tab): expected "still open", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_nights where id = '50000000-0000-4000-8000-000000000001' and ended_at is not null) then
    raise exception 'CHECK FAILED (end with open tab): the night was ended anyway.';
  end if;

  perform public.rnmb_close_tab('{"id": "60000000-0000-4000-8000-000000000003", "status": "written_off"}'::jsonb);
  perform public.rnmb_end_host_night('{"id": "50000000-0000-4000-8000-000000000001"}'::jsonb);
  if not exists (select 1 from public.rnmb_nights where id = '50000000-0000-4000-8000-000000000001' and ended_at is not null) then
    raise exception 'CHECK FAILED (end night): ended_at was not set after the last tab closed.';
  end if;

  v_err := null;
  begin
    perform public.rnmb_ring_up('{
      "id": "70000000-0000-4000-8000-00000000000a",
      "night_id": "50000000-0000-4000-8000-000000000001",
      "kind": "crew",
      "person_id": "10000000-0000-4000-8000-000000000001",
      "menu_item_id": "40000000-0000-4000-8000-000000000002",
      "lines": [{"bottle_id": "30000000-0000-4000-8000-000000000002", "amount": 1}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has ended%' then
    raise exception 'CHECK FAILED (ended night): expected "has ended", got: %', coalesce(v_err, 'no error');
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 19. The result. Reaching this line means no check raised.
select current_setting('rnmb.checks_passed')::integer as checks_passed,
       'All host-mode checks passed. Everything was rolled back.' as result;

rollback;
