-- RNMB Command Center — safe saves checks.
--
-- Run this in the Supabase SQL editor AFTER supabase/safe-saves.sql. It needs no
-- edits and changes nothing: it works inside one transaction and the last line
-- rolls every change back, including the test person, stock type, menu items
-- and pricing it saves.
--
-- What you should see: one row, `checks_passed` reading 6 and a `result` saying
-- every check passed. If a rule is broken, the editor instead shows an error
-- starting with "CHECK FAILED" that names the check and what happened.
--
-- The replace-all checks replace the whole database with a copy of itself, so
-- even a run that was cut short and somehow committed leaves the same data (the
-- version numbers would go up by one; nothing reads them but the dashboard).
--
-- Why it is built this way: the SQL editor runs as the table owner, which skips
-- row-level security, and sends no x-rnmb-key header. So the script copies the
-- stored passphrase into the request headers (the passphrase itself is never
-- written in this file) and switches to the `anon` role — the role the
-- publishable key uses — so every function and policy runs exactly as it does
-- for the browser. Test ids begin b1 to b4 and are mostly zeros, so they will not
-- collide with the random ids the dashboard creates.

begin;

-- 1. Preconditions, as the table owner.
do $$
begin
  perform set_config('rnmb.checks_passed', '0', true);
  if to_regprocedure('public.rnmb_replace_all(jsonb)') is null
     or to_regprocedure('public.rnmb_save_menu_item(jsonb)') is null
     or to_regprocedure('public.rnmb_save_pricing(jsonb)') is null then
    raise exception 'CHECK SETUP: run supabase/safe-saves.sql before this script.';
  end if;
  if not exists (select 1 from public.rnmb_access where passphrase <> '') then
    raise exception 'CHECK SETUP: no passphrase is stored; run supabase/rls-passphrase.sql with a real passphrase first.';
  end if;
  if not has_function_privilege('anon', 'public.rnmb_replace_all(jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.rnmb_save_menu_item(jsonb)', 'execute')
     or not has_function_privilege('anon', 'public.rnmb_save_pricing(jsonb)', 'execute') then
    raise exception 'CHECK FAILED (grants): the anon role cannot call the new functions.';
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);

  -- Carry the stored passphrase into this transaction's request headers.
  perform set_config(
    'request.headers',
    json_build_object('x-rnmb-key', (select passphrase from public.rnmb_access where id))::text,
    true
  );
end;
$$;

set local role anon;

-- 2. Without the passphrase, every new function refuses with its own message.
--    (Row-level security would also stop the writes, but with a Postgres error
--    that does not tell the user what to fix.)
do $$
declare
  v_headers text := current_setting('request.headers', true);
  v_refused integer := 0;
begin
  perform set_config('request.headers', '{"x-rnmb-key": "wrong"}', true);
  begin
    perform public.rnmb_replace_all('{"tables": {}}'::jsonb);
  exception when insufficient_privilege then
    if sqlerrm like 'RNMB: the passphrase%' then v_refused := v_refused + 1; end if;
  end;
  begin
    perform public.rnmb_save_menu_item('{"id": "b3000000-0000-4000-8000-000000000001"}'::jsonb);
  exception when insufficient_privilege then
    if sqlerrm like 'RNMB: the passphrase%' then v_refused := v_refused + 1; end if;
  end;
  begin
    perform public.rnmb_save_pricing('{"markup_percent": 1, "rounding_increment_cents": 25}'::jsonb);
  exception when insufficient_privilege then
    if sqlerrm like 'RNMB: the passphrase%' then v_refused := v_refused + 1; end if;
  end;
  perform set_config('request.headers', v_headers, true);
  if v_refused <> 3 then
    raise exception 'CHECK FAILED (passphrase): % of 3 functions refused a wrong passphrase.', v_refused;
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 3. Menu items: add, edit, and refuse a stale edit or a removed item.
do $$
declare
  v_item constant uuid := 'b3000000-0000-4000-8000-000000000001';
  v_version integer;
  v_row record;
  v_lines text;
  v_refused boolean;
begin
  insert into public.rnmb_beverage_types (id, name, category, abv, measure)
  values ('b2000000-0000-4000-8000-000000000001', 'Check Rum', 'Rum', 40, 'oz');

  v_version := public.rnmb_save_menu_item(jsonb_build_object(
    'id', v_item, 'name', 'Check Punch', 'kind', 'cocktail', 'version', null,
    'ingredients', jsonb_build_array(
      jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000001', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 1.5, 'line_no', 0),
      jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000002', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 0.5, 'line_no', 1)
    )
  ));
  if v_version <> 1 then
    raise exception 'CHECK FAILED (menu add): a new item came back as version %, not 1.', v_version;
  end if;

  -- Edit from version 1: rename, keep line 1 with a new amount, drop line 2, add line 3.
  v_version := public.rnmb_save_menu_item(jsonb_build_object(
    'id', v_item, 'name', 'Check Punch Two', 'kind', 'cocktail', 'version', 1,
    'ingredients', jsonb_build_array(
      jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000001', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 2, 'line_no', 0),
      jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000003', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 0.25, 'line_no', 1)
    )
  ));
  select name, version into v_row from public.rnmb_menu_items where id = v_item;
  select string_agg(right(id::text, 1) || ':' || amount::text, ',' order by line_no) into v_lines
    from public.rnmb_recipe_ingredients where menu_item_id = v_item;
  if v_version <> 2 or v_row.version <> 2 or v_row.name <> 'Check Punch Two' or v_lines <> '1:2.00,3:0.25' then
    raise exception 'CHECK FAILED (menu edit): got version %, name %, lines %.', v_version, v_row.name, v_lines;
  end if;

  -- A second device still holds version 1: its save is refused and changes nothing.
  v_refused := false;
  begin
    perform public.rnmb_save_menu_item(jsonb_build_object(
      'id', v_item, 'name', 'Stale Punch', 'kind', 'cocktail', 'version', 1,
      'ingredients', jsonb_build_array(
        jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000001', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 9, 'line_no', 0)
      )
    ));
  exception when others then
    v_refused := sqlerrm like 'RNMB: someone else changed this menu item%';
  end;
  select name, version into v_row from public.rnmb_menu_items where id = v_item;
  select string_agg(right(id::text, 1) || ':' || amount::text, ',' order by line_no) into v_lines
    from public.rnmb_recipe_ingredients where menu_item_id = v_item;
  if not v_refused or v_row.version <> 2 or v_row.name <> 'Check Punch Two' or v_lines <> '1:2.00,3:0.25' then
    raise exception 'CHECK FAILED (menu stale edit): refused %, then version %, name %, lines %.', v_refused, v_row.version, v_row.name, v_lines;
  end if;

  -- An edit of an item someone removed is refused, and does not bring it back.
  delete from public.rnmb_menu_items where id = v_item;
  v_refused := false;
  begin
    perform public.rnmb_save_menu_item(jsonb_build_object(
      'id', v_item, 'name', 'Ghost Punch', 'kind', 'cocktail', 'version', 2,
      'ingredients', jsonb_build_array(
        jsonb_build_object('id', 'b4000000-0000-4000-8000-000000000001', 'type_id', 'b2000000-0000-4000-8000-000000000001', 'amount', 1, 'line_no', 0)
      )
    ));
  exception when others then
    v_refused := sqlerrm like 'RNMB: someone removed this menu item%';
  end;
  if not v_refused or exists (select 1 from public.rnmb_menu_items where id = v_item) then
    raise exception 'CHECK FAILED (menu removed): the edit of a removed item was not refused, or brought it back.';
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 4. Pricing: a save from the current version goes through; a stale one does not.
do $$
declare
  v_before record;
  v_version integer;
  v_after record;
  v_refused boolean := false;
begin
  select markup_percent, rounding_increment_cents, pricing_version into v_before
    from public.rnmb_settings where id;
  if not found then
    raise exception 'CHECK SETUP: there is no settings row; open the dashboard once first.';
  end if;

  v_version := public.rnmb_save_pricing(jsonb_build_object(
    'markup_percent', 12.5, 'rounding_increment_cents', 50, 'version', v_before.pricing_version
  ));
  begin
    perform public.rnmb_save_pricing(jsonb_build_object(
      'markup_percent', 99, 'rounding_increment_cents', 1, 'version', v_before.pricing_version
    ));
  exception when others then
    v_refused := sqlerrm like 'RNMB: someone else changed the pricing%';
  end;
  select markup_percent, rounding_increment_cents, pricing_version into v_after
    from public.rnmb_settings where id;
  if v_version <> v_before.pricing_version + 1 or not v_refused
     or v_after.markup_percent <> 12.5 or v_after.rounding_increment_cents <> 50
     or v_after.pricing_version <> v_version then
    raise exception 'CHECK FAILED (pricing): version % (from %), stale refused %, now %%% / % cents at version %.',
      v_version, v_before.pricing_version, v_refused, v_after.markup_percent, v_after.rounding_increment_cents, v_after.pricing_version;
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;


-- 5. Take a snapshot of every replaceable table, as the dashboard would send it,
--    plus the row counts and versions to compare against. It is kept in
--    transaction-local settings, which the anon role can always write.
do $$
declare
  v_tables constant text[] := array[
    'rnmb_people', 'rnmb_beverage_types', 'rnmb_nights', 'rnmb_bottles', 'rnmb_pours',
    'rnmb_menu_items', 'rnmb_recipe_ingredients', 'rnmb_guest_tabs', 'rnmb_ring_ups',
    'rnmb_ring_up_lines', 'rnmb_stock_adjustments', 'rnmb_payments'
  ];
  v_table text;
  v_rows jsonb;
  v_n integer;
  v_payload jsonb := '{}'::jsonb;
  v_counts jsonb := '{}'::jsonb;
begin
  foreach v_table in array v_tables loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb), count(*) from public.%I t', v_table)
      into v_rows, v_n;
    v_payload := v_payload || jsonb_build_object(v_table, v_rows);
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;
  perform set_config('rnmb.snap_payload', jsonb_build_object(
    'tables', v_payload,
    'settings', (select to_jsonb(s) from public.rnmb_settings s where id)
  )::text, true);
  perform set_config('rnmb.snap_counts', v_counts::text, true);
  perform set_config('rnmb.snap_menu', (
    select coalesce(jsonb_object_agg(id::text, version), '{}'::jsonb) from public.rnmb_menu_items
  )::text, true);
  perform set_config('rnmb.snap_pricing', (select pricing_version from public.rnmb_settings where id)::text, true);
end;
$$;

-- 6. A replace that fails part-way changes nothing. The payload is the snapshot
--    with one extra person listed twice, so the very first insert breaks after
--    every table has already been emptied.
do $$
declare
  v_tables constant text[] := array[
    'rnmb_people', 'rnmb_beverage_types', 'rnmb_nights', 'rnmb_bottles', 'rnmb_pours',
    'rnmb_menu_items', 'rnmb_recipe_ingredients', 'rnmb_guest_tabs', 'rnmb_ring_ups',
    'rnmb_ring_up_lines', 'rnmb_stock_adjustments', 'rnmb_payments'
  ];
  v_payload jsonb := current_setting('rnmb.snap_payload')::jsonb;
  v_person jsonb;
  v_failed boolean := false;
  v_table text;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
begin
  -- Shaped like the snapshot's rows, so every row in the list has the same keys.
  v_person := jsonb_build_object(
    'id', 'b1000000-0000-4000-8000-000000000001', 'name', 'Check Person',
    'color', '#ef4444', 'created_at', now()
  );
  v_payload := jsonb_set(v_payload, '{tables,rnmb_people}',
    jsonb_build_array(v_person, v_person) || (v_payload #> '{tables,rnmb_people}'));
  begin
    perform public.rnmb_replace_all(v_payload);
  exception when unique_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'CHECK FAILED (replace all, failure): a payload with a repeated person was accepted.';
  end if;
  foreach v_table in array v_tables loop
    execute format('select count(*) from public.%I', v_table) into v_n;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;
  if v_counts <> current_setting('rnmb.snap_counts')::jsonb then
    raise exception 'CHECK FAILED (replace all, failure): a failed replace changed the row counts from % to %.',
      current_setting('rnmb.snap_counts'), v_counts;
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 7. A replace with the snapshot keeps every row and the active night, and moves
--    every version up by one. An unknown table is refused before anything changes.
do $$
declare
  v_tables constant text[] := array[
    'rnmb_people', 'rnmb_beverage_types', 'rnmb_nights', 'rnmb_bottles', 'rnmb_pours',
    'rnmb_menu_items', 'rnmb_recipe_ingredients', 'rnmb_guest_tabs', 'rnmb_ring_ups',
    'rnmb_ring_up_lines', 'rnmb_stock_adjustments', 'rnmb_payments'
  ];
  v_payload jsonb := current_setting('rnmb.snap_payload')::jsonb;
  v_menu jsonb := current_setting('rnmb.snap_menu')::jsonb;
  v_refused boolean := false;
  v_table text;
  v_n integer;
  v_counts jsonb := '{}'::jsonb;
  v_stale text;
begin
  begin
    perform public.rnmb_replace_all(jsonb_build_object('tables', jsonb_build_object('rnmb_access', '[]'::jsonb)));
  exception when others then
    v_refused := sqlerrm like 'RNMB: rnmb_access is not a table%';
  end;
  if not v_refused then
    raise exception 'CHECK FAILED (replace all, unknown table): rnmb_access was not refused.';
  end if;

  perform public.rnmb_replace_all(v_payload);

  foreach v_table in array v_tables loop
    execute format('select count(*) from public.%I', v_table) into v_n;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;
  if v_counts <> current_setting('rnmb.snap_counts')::jsonb then
    raise exception 'CHECK FAILED (replace all): the row counts changed from % to %.', current_setting('rnmb.snap_counts'), v_counts;
  end if;
  select m.id::text into v_stale
    from public.rnmb_menu_items m
   where m.version <> coalesce((v_menu ->> m.id::text)::integer, 0) + 1
   limit 1;
  if v_stale is not null then
    raise exception 'CHECK FAILED (replace all): menu item % did not move up one version.', v_stale;
  end if;
  if (select pricing_version from public.rnmb_settings where id) <> current_setting('rnmb.snap_pricing')::integer + 1
     or (select active_night_id from public.rnmb_settings where id)
        is distinct from nullif(v_payload #>> '{settings,active_night_id}', '')::uuid then
    raise exception 'CHECK FAILED (replace all): the pricing version or the active night is wrong afterwards.';
  end if;
  perform set_config('rnmb.checks_passed', (current_setting('rnmb.checks_passed')::integer + 1)::text, true);
end;
$$;

-- 8. The result. Reaching this line means no check raised.
select current_setting('rnmb.checks_passed')::integer as checks_passed,
       'All safe-saves checks passed. Everything was rolled back.' as result;

rollback;
