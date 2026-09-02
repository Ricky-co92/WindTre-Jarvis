-- Run this once in the Supabase SQL editor before the "Parco SIM" page will work.
-- Same reason as comuni-coordinate.sql: the anon key this app uses everywhere can
-- only do CRUD via PostgREST, not DDL.

create table if not exists public.wt_parco_sim_sezioni (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,
  ordine int not null default 0
);

create table if not exists public.wt_parco_sim_schede (
  id uuid primary key default gen_random_uuid(),
  cliente text not null,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.wt_parco_sim_righe (
  id uuid primary key default gen_random_uuid(),
  scheda_id uuid not null references public.wt_parco_sim_schede(id) on delete cascade,
  sezione text,
  canone numeric,
  piano_tariffario text,
  numero text,
  seriale text,
  puk text,
  utente_utilizzatore text,
  data_attivazione date,
  data_scadenza date,
  terminale text,
  ordine int not null default 0
);

create index if not exists wt_parco_sim_righe_scheda_id_idx on public.wt_parco_sim_righe(scheda_id);

insert into public.wt_parco_sim_sezioni (nome, ordine) values
  ('Voce', 10),
  ('Dati/Internet', 20),
  ('Fisso', 30)
on conflict (nome) do nothing;

alter table public.wt_parco_sim_sezioni enable row level security;
alter table public.wt_parco_sim_schede enable row level security;
alter table public.wt_parco_sim_righe enable row level security;

-- Same permissive anon-key policy used by every other table in this project
-- (RLS is the only access gate; there's no server layer -- see CLAUDE.md).
create policy "public all wt_parco_sim_sezioni" on public.wt_parco_sim_sezioni for all using (true) with check (true);
create policy "public all wt_parco_sim_schede" on public.wt_parco_sim_schede for all using (true) with check (true);
create policy "public all wt_parco_sim_righe" on public.wt_parco_sim_righe for all using (true) with check (true);
