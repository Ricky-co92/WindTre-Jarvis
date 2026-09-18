-- Run this once in the Supabase SQL editor (after giacenze-schema.sql) before importing the
-- new CSV export or scanning EAN barcodes on the "Giacenze" page.
-- Same reason as the other schema files: the anon key this app uses can only do CRUD via
-- PostgREST, not DDL. Idempotent: safe to re-run.

-- Mappatura EAN -> codice articolo, autoritativa: si riempie SOLO con l'import del CSV ufficiale
-- (upsert per ean, mai cancellata dall'app).
create table if not exists public.wt_giacenze_ean (
  ean text primary key,
  codice text not null,
  descrizione text,
  aggiornato_il timestamptz not null default now()
);

-- Collegamenti barcode -> codice fatti a mano sul campo, per i barcode che l'ultimo export non copre.
-- Tenuta separata da wt_giacenze_ean per non mescolare dati ufficiali e correzioni manuali.
create table if not exists public.wt_giacenze_barcode_map (
  barcode text primary key,
  codice text not null,
  creato_da text,
  creato_il timestamptz not null default now()
);

alter table public.wt_giacenze_ean enable row level security;
alter table public.wt_giacenze_barcode_map enable row level security;

drop policy if exists "allow all" on public.wt_giacenze_ean;
drop policy if exists "allow all" on public.wt_giacenze_barcode_map;
create policy "allow all" on public.wt_giacenze_ean for all using (true) with check (true);
create policy "allow all" on public.wt_giacenze_barcode_map for all using (true) with check (true);

-- Fa rileggere a PostgREST le tabelle appena create, senza attendere.
notify pgrst, 'reload schema';
