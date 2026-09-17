-- RNMB Command Center — crew running balance checks.
--
-- Run this in the Supabase SQL editor AFTER supabase/crew-balance.sql. It needs
-- no edits and changes nothing: it works inside one transaction and the last
-- line rolls every change back, including the test people, stock, nights,
-- tabs and payments it makes.
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
-- Test ids are fixed values beginning a1 to a9 and made mostly of zeros, so
-- they will not collide with the random ids the dashboard creates.

begin;

-- 1. Preconditions and catalog checks, as the table owner.
do $$
declare
  v_table text;
  v_name text;
  v_count integer;
begin
  perform set_config('rnmb.checks_passed', '0', true);

  if to_regclass('public.rnmb_payments') is null
     or to_regprocedure('public.rnmb_end_night(jsonb)') is null
     or to_regprocedure('public.rnmb_record_payment(jsonb)') is null
     or to_regprocedure('public.rnmb_void_payment(jsonb)') is null then
    raise exception 'CHECK SETUP: run supabase/crew-balance.sql before this script.';
  end if;
  if not exists (select 1 from public.rnmb_access where passphrase <> '') then
    raise exception 'CHECK SETUP: no passphrase is stored; run supabase/rls-passphrase.sql with a real passphrase first.';
  end if;

  -- The new table: row-level security on, and a gated `for all` policy.
  if not exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'rnmb_payments' and c.relrowsecurity
  ) then
    raise exception 'CHECK FAILED (rls): row-level security is not enabled on public.rnmb_payments.';
  end if;
  if not exists (
    select 1
      from pg_policies p
     where p.schemaname = 'public'
       and p.tablename = 'rnmb_payments'
       and p.cmd = 'ALL'
       and p.qual like '%rnmb_authorized()%'
       and p.with_check like '%rnmb_authorized()%'
  ) then
    raise exception 'CHECK FAILED (rls): public.rnmb_payments has no gated policy calling rnmb_authorized().';
  end if;

  -- And no rnmb_ table anywhere has row-level security switched off.
  select tablename into v_table
    from pg_tables
   where schemaname = 'public' and tablename like 'rnmb\_%' and not rowsecurity
   limit 1;
  if v_table is not null then
    raise exception 'CHECK FAILED (rls): row-level security is not enabled on public.%.', v_table;
  end if;

  -- The new columns exist.
  select count(*) into v_count
    from information_schema.columns
   where table_schema = 'public'
     and (table_name::text, column_name::text) in (
       ('rnmb_pours', 'cost_cents'), ('rnmb_pours', 'buyer_id'), ('rnmb_pours', 'buyer_name'),
       ('rnmb_guest_tabs', 'written_off_by'), ('rnmb_guest_tabs', 'written_off_by_name')
     );
  if v_count <> 5 then
    raise exception 'CHECK FAILED (columns): expected 5 new pour and tab columns, found %.', v_count;
  end if;

  -- Crew nights may end: the host-only rule is gone.
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.rnmb_nights'::regclass and conname = 'rnmb_nights_ended_host_only'
  ) then
    raise exception 'CHECK FAILED (night rule): rnmb_nights_ended_host_only still exists, so a crew night cannot end.';
  end if;

  -- Every function this file checks runs as the caller, so the gated policies apply.
  select p.proname into v_name
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any (array[
       'rnmb_ring_up', 'rnmb_void_ring_up', 'rnmb_close_tab', 'rnmb_end_night',
       'rnmb_end_host_night', 'rnmb_add_crew_pour', 'rnmb_record_payment', 'rnmb_void_payment'
     ])
     and p.prosecdef
   limit 1;
  if v_name is not null then
    raise exception 'CHECK FAILED (invoker): public.% runs as SECURITY DEFINER; it must run as the caller.', v_name;
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
--    row-level security. One crew night, one host night with three open tabs.
do $$
begin
  if not public.rnmb_authorized() then
    raise exception 'CHECK SETUP: the stored passphrase did not unlock rnmb_authorized() as anon.';
  end if;

  insert into public.rnmb_people (id, name) values
    ('a1000000-0000-4000-8000-000000000001', 'Sam'),
    ('a1000000-0000-4000-8000-000000000002', 'Alex'),
    ('a1000000-0000-4000-8000-000000000003', 'Jordan'),
    ('a1000000-0000-4000-8000-000000000004', 'Riley');

  insert into public.rnmb_beverage_types (id, name, category, abv, measure) values
    ('a2000000-0000-4000-8000-000000000001', 'Check tequila', 'Tequila', 40, 'oz');

  -- Sam's tequila: $30 for 25.36 oz. The house bottle: $1 for 8 oz, no buyer,
  -- so one ounce costs exactly 12.5 cents (the half-up case).
  insert into public.rnmb_bottles (id, type_id, nickname, size_oz, remaining_oz, price, buyer_id, purchase_date) values
    ('a3000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'Sam tequila', 25.36, 25.36, 30, 'a1000000-0000-4000-8000-000000000001', '2026-09-16'),
    ('a3000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'House bottle', 8, 8, 1, null, '2026-09-16');

  insert into public.rnmb_menu_items (id, name, kind) values
    ('a4000000-0000-4000-8000-000000000001', 'Check shot', 'straight');

  insert into public.rnmb_nights (id, name, date, kind) values
    ('a5000000-0000-4000-8000-000000000001', 'Check crew night', '2026-09-17', 'crew');

  perform public.rnmb_start_host_night(
    '{"id": "a5000000-0000-4000-8000-000000000002", "name": "Check host night", "date": "2026-09-17"}'::jsonb
  );
  perform public.rnmb_open_tab('{"id": "a6000000-0000-4000-8000-000000000001", "night_id": "a5000000-0000-4000-8000-000000000002", "guest_name": "Guest A"}'::jsonb);
  perform public.rnmb_open_tab('{"id": "a6000000-0000-4000-8000-000000000002", "night_id": "a5000000-0000-4000-8000-000000000002", "guest_name": "Guest B"}'::jsonb);
  perform public.rnmb_open_tab('{"id": "a6000000-0000-4000-8000-000000000003", "night_id": "a5000000-0000-4000-8000-000000000002", "guest_name": "Guest C"}'::jsonb);
  if (select count(*) from public.rnmb_guest_tabs
       where night_id = 'a5000000-0000-4000-8000-000000000002' and status = 'open') <> 3 then
    raise exception 'CHECK SETUP: expected 3 open tabs on the check host night.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 4. A crew pour stores cost_cents (rounded half-up, from the price at pour
--    time) and the buyer snapshot. Legacy pours may have no cost; a negative
--    cost is refused.
do $$
declare
  v_err text;
begin
  -- 3000 cents x 1.5 / 25.36 = 177.44..., so 177.
  perform public.rnmb_add_crew_pour('{
    "id": "a8000000-0000-4000-8000-000000000001",
    "night_id": "a5000000-0000-4000-8000-000000000001",
    "person_id": "a1000000-0000-4000-8000-000000000002",
    "bottle_id": "a3000000-0000-4000-8000-000000000001",
    "ounces": 1.5
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_pours
     where id = 'a8000000-0000-4000-8000-000000000001'
       and cost_cents = 177
       and buyer_id = 'a1000000-0000-4000-8000-000000000001'
       and buyer_name = 'Sam'
       and ounces = 1.5 and abv_snapshot = 40
  ) then
    raise exception 'CHECK FAILED (pour cost): expected cost_cents 177 and buyer Sam on the pour.';
  end if;
  if (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 23.86 then
    raise exception 'CHECK FAILED (pour cost): Sam tequila should read 23.86.';
  end if;

  -- 100 cents x 1 / 8 = 12.5 exactly, so 13; the bottle has no buyer.
  perform public.rnmb_add_crew_pour('{
    "id": "a8000000-0000-4000-8000-000000000002",
    "night_id": "a5000000-0000-4000-8000-000000000001",
    "person_id": "a1000000-0000-4000-8000-000000000002",
    "bottle_id": "a3000000-0000-4000-8000-000000000002",
    "ounces": 1
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_pours
     where id = 'a8000000-0000-4000-8000-000000000002'
       and cost_cents = 13 and buyer_id is null and buyer_name is null
  ) then
    raise exception 'CHECK FAILED (pour half-up): expected cost_cents 13 and no buyer on the house-bottle pour.';
  end if;

  -- The cost is fixed: a later price edit does not change it.
  update public.rnmb_bottles set price = 60 where id = 'a3000000-0000-4000-8000-000000000001';
  if (select cost_cents from public.rnmb_pours where id = 'a8000000-0000-4000-8000-000000000001') <> 177 then
    raise exception 'CHECK FAILED (pour cost fixed): a price edit changed an old pour''s cost.';
  end if;

  -- A pour row written without a cost (as before this migration) still inserts.
  insert into public.rnmb_pours (id, night_id, person_id, bottle_id, ounces, abv_snapshot)
  values (
    'a8000000-0000-4000-8000-000000000003',
    'a5000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000003',
    'a3000000-0000-4000-8000-000000000001',
    1, 40
  );
  if not exists (
    select 1 from public.rnmb_pours
     where id = 'a8000000-0000-4000-8000-000000000003' and cost_cents is null
  ) then
    raise exception 'CHECK FAILED (legacy pour): a pour with no cost was not stored.';
  end if;

  begin
    insert into public.rnmb_pours (id, night_id, person_id, bottle_id, ounces, abv_snapshot, cost_cents)
    values (
      'a8000000-0000-4000-8000-000000000004',
      'a5000000-0000-4000-8000-000000000001',
      'a1000000-0000-4000-8000-000000000003',
      'a3000000-0000-4000-8000-000000000001',
      1, 40, -1
    );
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%violates check constraint%' then
    raise exception 'CHECK FAILED (negative pour cost): expected a check constraint refusal, got: %', coalesce(v_err, 'no error');
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 5. Recording a payment snapshots both names; a duplicate id, a zero,
--    negative or fractional amount, the same person twice, and an unknown
--    person each raise and store nothing.
do $$
declare
  v_err text;
begin
  perform public.rnmb_record_payment('{
    "id": "a9000000-0000-4000-8000-000000000001",
    "from_person_id": "a1000000-0000-4000-8000-000000000002",
    "to_person_id": "a1000000-0000-4000-8000-000000000001",
    "amount_cents": 500,
    "paid_at": "2026-09-16T23:00:00Z"
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_payments
     where id = 'a9000000-0000-4000-8000-000000000001'
       and from_person_id = 'a1000000-0000-4000-8000-000000000002' and from_name = 'Alex'
       and to_person_id = 'a1000000-0000-4000-8000-000000000001' and to_name = 'Sam'
       and amount_cents = 500
       and paid_at = '2026-09-16T23:00:00Z'::timestamptz
       and voided_at is null
  ) then
    raise exception 'CHECK FAILED (record payment): expected Alex paid Sam 500 cents at the given time.';
  end if;

  -- Riley pays Sam; step 7 removes Riley to prove the name snapshot survives.
  perform public.rnmb_record_payment('{
    "id": "a9000000-0000-4000-8000-000000000002",
    "from_person_id": "a1000000-0000-4000-8000-000000000004",
    "to_person_id": "a1000000-0000-4000-8000-000000000001",
    "amount_cents": 250
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_payments
     where id = 'a9000000-0000-4000-8000-000000000002' and from_name = 'Riley' and paid_at is not null
  ) then
    raise exception 'CHECK FAILED (record payment): Riley''s payment was not stored with a default paid_at.';
  end if;

  begin
    perform public.rnmb_record_payment('{
      "id": "a9000000-0000-4000-8000-000000000001",
      "from_person_id": "a1000000-0000-4000-8000-000000000002",
      "to_person_id": "a1000000-0000-4000-8000-000000000001",
      "amount_cents": 500
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%already recorded%' then
    raise exception 'CHECK FAILED (duplicate payment): expected "already recorded", got: %', coalesce(v_err, 'no error');
  end if;
  if (select count(*) from public.rnmb_payments where id = 'a9000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'CHECK FAILED (duplicate payment): expected exactly one payment with that id.';
  end if;

  v_err := null;
  begin
    perform public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000003", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000001", "amount_cents": 0}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%amount above zero%' then
    raise exception 'CHECK FAILED (zero payment): expected "amount above zero", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000004", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000001", "amount_cents": -100}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%amount above zero%' then
    raise exception 'CHECK FAILED (negative payment): expected "amount above zero", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000005", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000001", "amount_cents": 12.5}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%in whole cents%' then
    raise exception 'CHECK FAILED (fractional payment): expected "in whole cents", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000006", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000002", "amount_cents": 100}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%two different crew members%' then
    raise exception 'CHECK FAILED (self payment): expected "two different crew members", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000007", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000009", "amount_cents": 100}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%who was paid does not exist%' then
    raise exception 'CHECK FAILED (unknown payee): expected "who was paid does not exist", got: %', coalesce(v_err, 'no error');
  end if;

  if exists (
    select 1 from public.rnmb_payments
     where id in (
       'a9000000-0000-4000-8000-000000000003', 'a9000000-0000-4000-8000-000000000004',
       'a9000000-0000-4000-8000-000000000005', 'a9000000-0000-4000-8000-000000000006',
       'a9000000-0000-4000-8000-000000000007'
     )
  ) then
    raise exception 'CHECK FAILED (payment rules): a refused payment was stored.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 6. Voiding a payment stamps voided_at and keeps the row; voiding it twice,
--    or voiding a payment that does not exist, raises.
do $$
declare
  v_err text;
  v_voided_at timestamptz;
begin
  perform public.rnmb_void_payment('{"id": "a9000000-0000-4000-8000-000000000001"}'::jsonb);
  select voided_at into v_voided_at from public.rnmb_payments where id = 'a9000000-0000-4000-8000-000000000001';
  if not found then
    raise exception 'CHECK FAILED (void payment): the voided payment was deleted; history must be kept.';
  end if;
  if v_voided_at is null then
    raise exception 'CHECK FAILED (void payment): voided_at was not set.';
  end if;

  begin
    perform public.rnmb_void_payment('{"id": "a9000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%payment was already voided%' then
    raise exception 'CHECK FAILED (void payment twice): expected "payment was already voided", got: %', coalesce(v_err, 'no error');
  end if;
  if (select voided_at from public.rnmb_payments where id = 'a9000000-0000-4000-8000-000000000001') <> v_voided_at then
    raise exception 'CHECK FAILED (void payment twice): voided_at changed.';
  end if;

  v_err := null;
  begin
    perform public.rnmb_void_payment('{"id": "a9000000-0000-4000-8000-000000000009"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%payment does not exist%' then
    raise exception 'CHECK FAILED (void unknown payment): expected "payment does not exist", got: %', coalesce(v_err, 'no error');
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 7. A write-off without written_off_by (or with an unknown person) raises;
--    with it, the name snapshot is stored and survives removing that person.
--    Paying a tab still works and records no write-off author. The tab rule
--    itself refuses a write-off with no author.
do $$
declare
  v_err text;
begin
  begin
    perform public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000001", "status": "written_off"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%needs the crew member who wrote it off%' then
    raise exception 'CHECK FAILED (write-off author): expected "needs the crew member who wrote it off", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000001", "status": "written_off", "written_off_by": "a1000000-0000-4000-8000-000000000009"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%writing off the tab does not exist%' then
    raise exception 'CHECK FAILED (write-off unknown author): expected "writing off the tab does not exist", got: %', coalesce(v_err, 'no error');
  end if;
  if not exists (select 1 from public.rnmb_guest_tabs where id = 'a6000000-0000-4000-8000-000000000001' and status = 'open') then
    raise exception 'CHECK FAILED (write-off author): Guest A was closed by a refused write-off.';
  end if;

  perform public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000001", "status": "written_off", "written_off_by": "a1000000-0000-4000-8000-000000000004"}'::jsonb);
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = 'a6000000-0000-4000-8000-000000000001'
       and status = 'written_off' and closed_at is not null
       and written_off_by = 'a1000000-0000-4000-8000-000000000004'
       and written_off_by_name = 'Riley'
       and collector_id is null and collector_name is null and amount_cents is null
  ) then
    raise exception 'CHECK FAILED (write-off snapshot): Guest A was not written off by Riley.';
  end if;

  -- The paid path is unchanged.
  perform public.rnmb_ring_up('{
    "id": "a7000000-0000-4000-8000-000000000004",
    "night_id": "a5000000-0000-4000-8000-000000000002",
    "kind": "guest",
    "tab_id": "a6000000-0000-4000-8000-000000000002",
    "menu_item_id": "a4000000-0000-4000-8000-000000000001",
    "price_cents": 300,
    "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000002", "amount": 1, "cost_cents": 12.5, "share_cents": 300}]
  }'::jsonb);
  perform public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000002", "status": "paid", "collector_id": "a1000000-0000-4000-8000-000000000001", "amount_cents": 300}'::jsonb);
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = 'a6000000-0000-4000-8000-000000000002'
       and status = 'paid' and amount_cents = 300 and collector_name = 'Sam'
       and written_off_by is null and written_off_by_name is null
  ) then
    raise exception 'CHECK FAILED (paid tab): Guest B was not closed as paid 300 by Sam with no write-off author.';
  end if;

  -- The table rule: a written-off row with no author is refused even when
  -- written directly.
  v_err := null;
  begin
    update public.rnmb_guest_tabs
       set status = 'written_off', closed_at = now()
     where id = 'a6000000-0000-4000-8000-000000000003';
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%violates check constraint%' then
    raise exception 'CHECK FAILED (tab rule): expected a check constraint refusal for a write-off with no author, got: %', coalesce(v_err, 'no error');
  end if;
  if not exists (select 1 from public.rnmb_guest_tabs where id = 'a6000000-0000-4000-8000-000000000003' and status = 'open') then
    raise exception 'CHECK FAILED (tab rule): Guest C was closed without an author.';
  end if;

  -- Removing Riley keeps the write-off and payment name snapshots.
  delete from public.rnmb_people where id = 'a1000000-0000-4000-8000-000000000004';
  if not exists (
    select 1 from public.rnmb_guest_tabs
     where id = 'a6000000-0000-4000-8000-000000000001' and written_off_by is null and written_off_by_name = 'Riley'
  ) then
    raise exception 'CHECK FAILED (person delete): the write-off snapshot "Riley" was lost.';
  end if;
  if not exists (
    select 1 from public.rnmb_payments
     where id = 'a9000000-0000-4000-8000-000000000002' and from_person_id is null and from_name = 'Riley'
  ) then
    raise exception 'CHECK FAILED (person delete): the payment snapshot "Riley" was lost.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 8. A crew ring-up succeeds on an open crew night and on an open host night;
--    a guest ring-up on a crew night raises and writes nothing.
do $$
declare
  v_err text;
begin
  perform public.rnmb_ring_up('{
    "id": "a7000000-0000-4000-8000-000000000001",
    "night_id": "a5000000-0000-4000-8000-000000000001",
    "kind": "crew",
    "person_id": "a1000000-0000-4000-8000-000000000002",
    "menu_item_id": "a4000000-0000-4000-8000-000000000001",
    "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000001", "amount": 1.5, "cost_cents": 177.44}]
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_ring_ups
     where id = 'a7000000-0000-4000-8000-000000000001'
       and night_id = 'a5000000-0000-4000-8000-000000000001'
       and kind = 'crew' and person_name = 'Alex' and price_cents is null and voided_at is null
  ) or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 22.36 then
    raise exception 'CHECK FAILED (crew ring-up on crew night): not stored, or Sam tequila does not read 22.36.';
  end if;

  begin
    perform public.rnmb_ring_up('{
      "id": "a7000000-0000-4000-8000-000000000005",
      "night_id": "a5000000-0000-4000-8000-000000000001",
      "kind": "guest",
      "tab_id": "a6000000-0000-4000-8000-000000000003",
      "menu_item_id": "a4000000-0000-4000-8000-000000000001",
      "price_cents": 300,
      "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000001", "amount": 1.5, "cost_cents": 177.44, "share_cents": 300}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%guest drinks can only be rung up on a host night%' then
    raise exception 'CHECK FAILED (guest ring-up on crew night): expected "guest drinks can only be rung up on a host night", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_ring_ups where id = 'a7000000-0000-4000-8000-000000000005')
     or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 22.36 then
    raise exception 'CHECK FAILED (guest ring-up on crew night): something was written.';
  end if;

  perform public.rnmb_ring_up('{
    "id": "a7000000-0000-4000-8000-000000000002",
    "night_id": "a5000000-0000-4000-8000-000000000002",
    "kind": "crew",
    "person_id": "a1000000-0000-4000-8000-000000000001",
    "menu_item_id": "a4000000-0000-4000-8000-000000000001",
    "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000002", "amount": 1, "cost_cents": 12.5}]
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_ring_ups
     where id = 'a7000000-0000-4000-8000-000000000002'
       and night_id = 'a5000000-0000-4000-8000-000000000002'
       and kind = 'crew' and person_name = 'Sam'
  ) or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000002') <> 5 then
    raise exception 'CHECK FAILED (crew ring-up on host night): not stored, or the house bottle does not read 5.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 9. With the request header set to a wrong passphrase, every new or replaced
--    function raises, a select on the payments table returns no rows, and no
--    row changes; the correct header is then restored for the remaining checks.
do $$
declare
  v_before text;
  v_after text;
  v_err text;
  v_call text;
  v_calls text[] := array[
    $c$select public.rnmb_record_payment('{"id": "a9000000-0000-4000-8000-000000000009", "from_person_id": "a1000000-0000-4000-8000-000000000002", "to_person_id": "a1000000-0000-4000-8000-000000000001", "amount_cents": 100}'::jsonb)$c$,
    $c$select public.rnmb_void_payment('{"id": "a9000000-0000-4000-8000-000000000002"}'::jsonb)$c$,
    $c$select public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000003", "status": "written_off", "written_off_by": "a1000000-0000-4000-8000-000000000003"}'::jsonb)$c$,
    $c$select public.rnmb_ring_up('{"id": "a7000000-0000-4000-8000-000000000009", "night_id": "a5000000-0000-4000-8000-000000000001", "kind": "crew", "person_id": "a1000000-0000-4000-8000-000000000001", "menu_item_id": "a4000000-0000-4000-8000-000000000001", "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000001", "amount": 1, "cost_cents": 118.3}]}'::jsonb)$c$,
    $c$select public.rnmb_void_ring_up('{"id": "a7000000-0000-4000-8000-000000000001"}'::jsonb)$c$,
    $c$select public.rnmb_add_crew_pour('{"id": "a8000000-0000-4000-8000-000000000009", "night_id": "a5000000-0000-4000-8000-000000000001", "person_id": "a1000000-0000-4000-8000-000000000001", "bottle_id": "a3000000-0000-4000-8000-000000000001", "ounces": 1}'::jsonb)$c$,
    $c$select public.rnmb_end_night('{"id": "a5000000-0000-4000-8000-000000000001"}'::jsonb)$c$,
    $c$select public.rnmb_end_host_night('{"id": "a5000000-0000-4000-8000-000000000002"}'::jsonb)$c$
  ];
  v_fingerprint text := $f$
    select concat_ws('|',
      (select count(*) from public.rnmb_payments),
      (select count(*) from public.rnmb_payments where voided_at is not null),
      (select count(*) from public.rnmb_guest_tabs where status = 'open'),
      (select count(*) from public.rnmb_guest_tabs where status = 'written_off'),
      (select count(*) from public.rnmb_ring_ups),
      (select count(*) from public.rnmb_ring_ups where voided_at is not null),
      (select count(*) from public.rnmb_nights where ended_at is not null),
      (select count(*) from public.rnmb_pours),
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

  if exists (select 1 from public.rnmb_payments) then
    raise exception 'CHECK FAILED (wrong passphrase): rnmb_payments returned rows.';
  end if;

  v_err := null;
  begin
    insert into public.rnmb_payments (from_name, to_name, amount_cents) values ('Intruder', 'Sam', 100);
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

-- 10. rnmb_end_night ends a crew night directly. The ended crew night still
--     takes a crew ring-up, a crew pour (costed at the current price), a pour
--     removal and a void; ending it twice raises, and rnmb_end_host_night
--     refuses a crew night.
do $$
declare
  v_err text;
begin
  perform public.rnmb_end_night('{"id": "a5000000-0000-4000-8000-000000000001"}'::jsonb);
  if not exists (
    select 1 from public.rnmb_nights
     where id = 'a5000000-0000-4000-8000-000000000001' and kind = 'crew' and ended_at is not null
  ) then
    raise exception 'CHECK FAILED (end crew night): ended_at was not set on the crew night.';
  end if;

  begin
    perform public.rnmb_end_night('{"id": "a5000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%crew night has already ended%' then
    raise exception 'CHECK FAILED (end crew night twice): expected "crew night has already ended", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_end_host_night('{"id": "a5000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%only a host night can be ended%' then
    raise exception 'CHECK FAILED (end host night on crew night): expected "only a host night can be ended", got: %', coalesce(v_err, 'no error');
  end if;

  -- A missed drink, rung up after the night ended.
  perform public.rnmb_ring_up('{
    "id": "a7000000-0000-4000-8000-000000000003",
    "night_id": "a5000000-0000-4000-8000-000000000001",
    "kind": "crew",
    "person_id": "a1000000-0000-4000-8000-000000000001",
    "menu_item_id": "a4000000-0000-4000-8000-000000000001",
    "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000001", "amount": 1, "cost_cents": 236.59}]
  }'::jsonb);
  if not exists (select 1 from public.rnmb_ring_ups where id = 'a7000000-0000-4000-8000-000000000003' and kind = 'crew')
     or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 21.36 then
    raise exception 'CHECK FAILED (ring-up on ended crew night): not stored, or Sam tequila does not read 21.36.';
  end if;

  -- A missed pour: 6000 cents (the price was edited in step 4) x 0.5 / 25.36 = 118.29..., so 118.
  perform public.rnmb_add_crew_pour('{
    "id": "a8000000-0000-4000-8000-000000000005",
    "night_id": "a5000000-0000-4000-8000-000000000001",
    "person_id": "a1000000-0000-4000-8000-000000000001",
    "bottle_id": "a3000000-0000-4000-8000-000000000001",
    "ounces": 0.5
  }'::jsonb);
  if not exists (
    select 1 from public.rnmb_pours
     where id = 'a8000000-0000-4000-8000-000000000005' and cost_cents = 118 and buyer_name = 'Sam'
  ) or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 20.86 then
    raise exception 'CHECK FAILED (pour on ended crew night): not stored at 118 cents, or Sam tequila does not read 20.86.';
  end if;

  perform public.rnmb_remove_crew_pour('{"id": "a8000000-0000-4000-8000-000000000005"}'::jsonb);
  if exists (select 1 from public.rnmb_pours where id = 'a8000000-0000-4000-8000-000000000005')
     or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 21.36 then
    raise exception 'CHECK FAILED (remove pour on ended crew night): the pour is still there, or Sam tequila does not read 21.36.';
  end if;

  -- A wrong drink, voided after the night ended.
  perform public.rnmb_void_ring_up('{"id": "a7000000-0000-4000-8000-000000000001"}'::jsonb);
  if not exists (select 1 from public.rnmb_ring_ups where id = 'a7000000-0000-4000-8000-000000000001' and voided_at is not null)
     or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000001') <> 22.86 then
    raise exception 'CHECK FAILED (void on ended crew night): not voided, or Sam tequila does not read 22.86.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 11. A host night with an open tab still refuses to end, through either
--     function. Once its tabs close it ends, and then every ring-up, crew pour
--     and void on it raises.
do $$
declare
  v_err text;
begin
  begin
    perform public.rnmb_end_night('{"id": "a5000000-0000-4000-8000-000000000002"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%still open%' then
    raise exception 'CHECK FAILED (end night with open tab): expected "still open", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_end_host_night('{"id": "a5000000-0000-4000-8000-000000000002"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%still open%' then
    raise exception 'CHECK FAILED (end host night with open tab): expected "still open", got: %', coalesce(v_err, 'no error');
  end if;
  if exists (select 1 from public.rnmb_nights where id = 'a5000000-0000-4000-8000-000000000002' and ended_at is not null) then
    raise exception 'CHECK FAILED (end with open tab): the host night was ended anyway.';
  end if;

  perform public.rnmb_close_tab('{"id": "a6000000-0000-4000-8000-000000000003", "status": "written_off", "written_off_by": "a1000000-0000-4000-8000-000000000003"}'::jsonb);
  perform public.rnmb_end_host_night('{"id": "a5000000-0000-4000-8000-000000000002"}'::jsonb);
  if not exists (select 1 from public.rnmb_nights where id = 'a5000000-0000-4000-8000-000000000002' and ended_at is not null) then
    raise exception 'CHECK FAILED (end host night): ended_at was not set after the last tab closed.';
  end if;

  v_err := null;
  begin
    perform public.rnmb_end_night('{"id": "a5000000-0000-4000-8000-000000000002"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%host night has already ended%' then
    raise exception 'CHECK FAILED (end host night twice): expected "host night has already ended", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_ring_up('{
      "id": "a7000000-0000-4000-8000-000000000006",
      "night_id": "a5000000-0000-4000-8000-000000000002",
      "kind": "crew",
      "person_id": "a1000000-0000-4000-8000-000000000001",
      "menu_item_id": "a4000000-0000-4000-8000-000000000001",
      "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000002", "amount": 1, "cost_cents": 12.5}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has ended%' then
    raise exception 'CHECK FAILED (crew ring-up on ended host night): expected "has ended", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_ring_up('{
      "id": "a7000000-0000-4000-8000-000000000007",
      "night_id": "a5000000-0000-4000-8000-000000000002",
      "kind": "guest",
      "tab_id": "a6000000-0000-4000-8000-000000000003",
      "menu_item_id": "a4000000-0000-4000-8000-000000000001",
      "price_cents": 300,
      "lines": [{"bottle_id": "a3000000-0000-4000-8000-000000000002", "amount": 1, "cost_cents": 12.5, "share_cents": 300}]
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has ended%' then
    raise exception 'CHECK FAILED (guest ring-up on ended host night): expected "has ended", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_add_crew_pour('{
      "id": "a8000000-0000-4000-8000-000000000006",
      "night_id": "a5000000-0000-4000-8000-000000000002",
      "person_id": "a1000000-0000-4000-8000-000000000001",
      "bottle_id": "a3000000-0000-4000-8000-000000000002",
      "ounces": 1
    }'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has ended%' then
    raise exception 'CHECK FAILED (pour on ended host night): expected "has ended", got: %', coalesce(v_err, 'no error');
  end if;

  v_err := null;
  begin
    perform public.rnmb_void_ring_up('{"id": "a7000000-0000-4000-8000-000000000002"}'::jsonb);
  exception when others then
    v_err := sqlerrm;
  end;
  if v_err is null or v_err not like '%has ended%' then
    raise exception 'CHECK FAILED (void on ended host night): expected "has ended", got: %', coalesce(v_err, 'no error');
  end if;

  if exists (select 1 from public.rnmb_ring_ups where id in ('a7000000-0000-4000-8000-000000000006', 'a7000000-0000-4000-8000-000000000007'))
     or exists (select 1 from public.rnmb_pours where id = 'a8000000-0000-4000-8000-000000000006')
     or exists (select 1 from public.rnmb_ring_ups where id = 'a7000000-0000-4000-8000-000000000002' and voided_at is not null)
     or (select remaining_oz from public.rnmb_bottles where id = 'a3000000-0000-4000-8000-000000000002') <> 5 then
    raise exception 'CHECK FAILED (ended host night): something was written.';
  end if;

  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 12. The result. Reaching this line means no check raised.
select current_setting('rnmb.checks_passed')::integer as checks_passed,
       'All crew-balance checks passed. Everything was rolled back.' as result;

rollback;
