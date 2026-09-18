-- Run this once in the Supabase SQL editor before the "Giacenze" page will work.
-- Same reason as parco-sim-schema.sql: the anon key this app uses everywhere can
-- only do CRUD via PostgREST, not DDL.
-- Idempotent: safe to re-run.

create table if not exists public.wt_giacenze_attese (
  codice text primary key,
  nome_articolo text,
  unita_attese numeric not null default 0,
  importato_il timestamptz not null default now()
);

create table if not exists public.wt_giacenze_conteggio (
  id uuid primary key default gen_random_uuid(),
  iniziato_il timestamptz not null default now(),
  completato_il timestamptz,
  operatore text,
  stato text not null default 'in_corso' -- in_corso | completato | abbandonato
);

create table if not exists public.wt_giacenze_conteggio_righe (
  id uuid primary key default gen_random_uuid(),
  conteggio_id uuid references public.wt_giacenze_conteggio(id) on delete cascade,
  codice text not null,
  unita_contate numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (conteggio_id, codice)
);

alter table public.wt_giacenze_attese enable row level security;
alter table public.wt_giacenze_conteggio enable row level security;
alter table public.wt_giacenze_conteggio_righe enable row level security;

drop policy if exists "allow all" on public.wt_giacenze_attese;
drop policy if exists "allow all" on public.wt_giacenze_conteggio;
drop policy if exists "allow all" on public.wt_giacenze_conteggio_righe;
create policy "allow all" on public.wt_giacenze_attese for all using (true) with check (true);
create policy "allow all" on public.wt_giacenze_conteggio for all using (true) with check (true);
create policy "allow all" on public.wt_giacenze_conteggio_righe for all using (true) with check (true);

-- Incremento atomico usato dallo scanner e dal pulsante +1/-1 dello stepper:
-- inserisce la riga se manca, altrimenti somma p_delta (mai sotto zero) e
-- restituisce il nuovo totale. Evita il read-modify-write lato client, che
-- perderebbe conteggi se due dispositivi contano lo stesso conteggio insieme.
create or replace function public.wt_giacenze_incrementa(
  p_conteggio_id uuid,
  p_codice text,
  p_delta numeric
) returns numeric
language plpgsql
as $$
declare
  v_totale numeric;
begin
  insert into public.wt_giacenze_conteggio_righe as r (conteggio_id, codice, unita_contate)
  values (p_conteggio_id, p_codice, greatest(p_delta, 0))
  on conflict (conteggio_id, codice)
  do update set unita_contate = greatest(r.unita_contate + p_delta, 0), updated_at = now()
  returning r.unita_contate into v_totale;
  return v_totale;
end;
$$;

grant execute on function public.wt_giacenze_incrementa(uuid, text, numeric) to anon, authenticated;

-- Fa rileggere a PostgREST tabelle e funzione appena create, senza attendere.
notify pgrst, 'reload schema';
