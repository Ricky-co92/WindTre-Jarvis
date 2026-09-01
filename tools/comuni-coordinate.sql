-- Run this once in the Supabase SQL editor (project settings > SQL Editor) BEFORE
-- running geocode-comuni.mjs. The anon key used by every script/client in this repo
-- can only do CRUD via PostgREST, not DDL, so this table has to be created manually.
--
-- Kept as its OWN table (not extra columns on wt_comuni_aree_bianche) because
-- comuni.js's "Carica file aggiornato" flow does a full delete+reinsert of
-- wt_comuni_aree_bianche on every upload (see cabFileInput handler) -- any lat/lon
-- columns added there would be wiped on the next aree-bianche refresh. Coordinates
-- are stable and shouldn't need re-geocoding just because the aree-bianche list
-- was updated, so they live here and are joined by comune_norm at read time.

create table if not exists public.comuni_coordinate (
  id bigserial primary key,
  comune_norm text not null unique,
  comune text not null,
  provincia text,
  codice_istat text,
  lat double precision not null,
  lon double precision not null,
  source text default 'nominatim',
  created_at timestamptz not null default now()
);

alter table public.comuni_coordinate enable row level security;

-- Mirrors the permissive anon-key policy the rest of this app relies on
-- (see wt_comuni_aree_bianche, wt_manuali, ...): no server layer, RLS is the
-- only gate, and this app's client code always talks to Supabase with the anon key.
create policy "public read comuni_coordinate"
  on public.comuni_coordinate for select
  using (true);

create policy "public insert comuni_coordinate"
  on public.comuni_coordinate for insert
  with check (true);

create policy "public upsert comuni_coordinate"
  on public.comuni_coordinate for update
  using (true) with check (true);
