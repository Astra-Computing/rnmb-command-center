create extension if not exists pgcrypto;

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
  abv numeric(5, 2) not null check (abv > 0 and abv <= 95),
  created_at timestamptz not null default now()
);

create table if not exists public.rnmb_nights (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) > 0),
  date date not null,
  created_at timestamptz not null default now()
);

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
  poured_at timestamptz not null default now()
);

create table if not exists public.rnmb_settings (
  id boolean primary key default true,
  active_night_id uuid references public.rnmb_nights(id) on delete set null,
  responsible_mode boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint rnmb_settings_singleton check (id)
);

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

create policy "RNMB public read people" on public.rnmb_people for select using (true);
create policy "RNMB public write people" on public.rnmb_people for all using (true) with check (true);
create policy "RNMB public read beverage types" on public.rnmb_beverage_types for select using (true);
create policy "RNMB public write beverage types" on public.rnmb_beverage_types for all using (true) with check (true);
create policy "RNMB public read nights" on public.rnmb_nights for select using (true);
create policy "RNMB public write nights" on public.rnmb_nights for all using (true) with check (true);
create policy "RNMB public read bottles" on public.rnmb_bottles for select using (true);
create policy "RNMB public write bottles" on public.rnmb_bottles for all using (true) with check (true);
create policy "RNMB public read pours" on public.rnmb_pours for select using (true);
create policy "RNMB public write pours" on public.rnmb_pours for all using (true) with check (true);
create policy "RNMB public read settings" on public.rnmb_settings for select using (true);
create policy "RNMB public write settings" on public.rnmb_settings for all using (true) with check (true);

insert into public.rnmb_settings (id, responsible_mode)
values (true, true)
on conflict (id) do nothing;
