-- RNMB Command Center — safe saves: one-transaction replace-all, and edits that
-- refuse to overwrite a newer change from another device.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query),
-- AFTER deploying the version of the dashboard that knows about it. That order
-- is deliberate: the new dashboard keeps its old save paths until it sees the
-- columns this file adds, so it works unchanged against a database that has not
-- had it yet. The old dashboard also keeps working after this file runs: it never
-- calls the new functions, and the new columns all have defaults.
--
-- It is safe to re-run: every statement either checks whether its object already
-- exists or replaces it, and no existing row is deleted or changed (except that
-- the two version columns start at 1).
--
-- It needs NO edits. There is no passphrase in this file; every new function
-- reuses the passphrase you already set, through rnmb_authorized(). Run
-- rls-passphrase.sql, host-mode.sql and crew-balance.sql first if you never have.
--
-- Afterwards, run supabase/checks/safe-saves-checks.sql to prove it works. That
-- script changes nothing: it rolls everything back at the end.
--
-- What it adds:
--   * rnmb_replace_all: Import, Reload demo data and Clear used to delete every
--     table and re-insert it in about 25 separate requests. A failure part-way
--     left the shared database empty or half-filled. Now the whole swap is one
--     function call, so it either all happens or none of it does.
--   * A version number on each menu item, and one on the pricing. A save names
--     the version it started from; if someone else saved in between, the save is
--     refused and the dashboard loads the newer data, instead of quietly putting
--     an old copy back.
--   * rnmb_save_menu_item: a menu item and its whole recipe are saved in one
--     transaction, so a failure can no longer leave half a recipe behind.
--   * rnmb_save_pricing: the markup and the rounding, saved against the version.
--
-- Every function refuses with a message that starts "RNMB:" and says what
-- happened; the dashboard shows that message.

-- 0. Preconditions.
do $$
begin
  if to_regprocedure('public.rnmb_authorized()') is null then
    raise exception 'Run supabase/rls-passphrase.sql before supabase/safe-saves.sql: rnmb_authorized() does not exist yet.';
  end if;
  if to_regclass('public.rnmb_menu_items') is null then
    raise exception 'Run supabase/host-mode.sql before supabase/safe-saves.sql: rnmb_menu_items does not exist yet.';
  end if;
  if to_regclass('public.rnmb_payments') is null then
    raise exception 'Run supabase/crew-balance.sql before supabase/safe-saves.sql: rnmb_payments does not exist yet.';
  end if;
end;
$$;

-- 1. Version numbers. They only ever go up.
alter table public.rnmb_menu_items add column if not exists version integer not null default 1;
alter table public.rnmb_settings add column if not exists pricing_version integer not null default 1;

-- 2. Replace every table in one transaction.
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

-- 3. Save a menu item and its whole recipe in one transaction.
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

-- 4. Save the markup and the rounding against the pricing version.
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

revoke all on function public.rnmb_replace_all(jsonb) from public;
revoke all on function public.rnmb_save_menu_item(jsonb) from public;
revoke all on function public.rnmb_save_pricing(jsonb) from public;

grant execute on function public.rnmb_replace_all(jsonb) to anon, authenticated;
grant execute on function public.rnmb_save_menu_item(jsonb) to anon, authenticated;
grant execute on function public.rnmb_save_pricing(jsonb) to anon, authenticated;
