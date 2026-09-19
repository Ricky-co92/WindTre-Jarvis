-- Migration v2 per la pagina "Giacenze": Listino SBS, doppia fonte di giacenza attesa,
-- sessioni di conteggio con nome, correzione/note per riga, EAN non risolti.
-- Da eseguire una volta sola nello stesso Supabase SQL editor già usato per
-- giacenze-schema.sql e giacenze-ean-schema.sql (la anon key non può fare DDL). Idempotente
-- dove possibile; la sola parte non ripetibile è il rename di sicurezza di wt_giacenze_attese,
-- protetto da un controllo "esiste già la nuova tabella?" così ri-eseguire lo script non fallisce.

-- ============= 1. LISTINO SBS: colonna PVP sulla mappatura EAN esistente =============
alter table public.wt_giacenze_ean add column if not exists pvp numeric;

-- ============= 2. GIACENZA ATTESA: due fonti invece di una =============
-- Non droppiamo i dati vecchi: la tabella attuale (fonte unica, era di fatto "export") viene
-- rinominata come backup consultabile a mano; la nuova tabella riparte vuota e si ripopola con i
-- prossimi import "Giacenze aggregate" / "Export magazzino". Se preferisci perdere i dati vecchi
-- invece di tenerli in un backup, sostituisci il blocco DO con: drop table if exists public.wt_giacenze_attese;
do $$
begin
  if to_regclass('public.wt_giacenze_attese') is not null
     and to_regclass('public.wt_giacenze_attese_old_backup') is null then
    alter table public.wt_giacenze_attese rename to wt_giacenze_attese_old_backup;
  end if;
end $$;

create table if not exists public.wt_giacenze_attese (
  fonte text not null check (fonte in ('giacenze','export')),
  codice text not null,
  nome_articolo text,
  unita_attese numeric not null default 0,
  importato_il timestamptz not null default now(),
  primary key (fonte, codice)
);
alter table public.wt_giacenze_attese enable row level security;
drop policy if exists "allow all" on public.wt_giacenze_attese;
create policy "allow all" on public.wt_giacenze_attese for all using (true) with check (true);

-- ============= 3. SESSIONI DI CONTEGGIO CON NOME =============
alter table public.wt_giacenze_conteggio add column if not exists nome text;
update public.wt_giacenze_conteggio set nome = to_char(iniziato_il, 'DD/MM/YYYY') where nome is null;

-- ============= 4. RIGHE CONTEGGIO: correzione + nota =============
alter table public.wt_giacenze_conteggio_righe add column if not exists corretto boolean not null default false;
alter table public.wt_giacenze_conteggio_righe add column if not exists corretto_il timestamptz;
alter table public.wt_giacenze_conteggio_righe add column if not exists differenza_al_momento_correzione numeric;
alter table public.wt_giacenze_conteggio_righe add column if not exists note text;

-- ============= 5. EAN SCANSIONATI/IMPORTATI NON ANCORA RISOLTI A UN CODICE =============
-- La unique (conteggio_id, ean) NON era nello schema proposto in chat ma serve per fare
-- l'upsert additivo richiesto ("se esiste già una riga per quello stesso ean+conteggio_id,
-- incrementa quantita invece di duplicare") con un ON CONFLICT invece di un
-- read-modify-write lato client, che sotto scansioni rapide perderebbe quantità.
create table if not exists public.wt_giacenze_ean_non_risolti (
  id uuid primary key default gen_random_uuid(),
  conteggio_id uuid references public.wt_giacenze_conteggio(id) on delete cascade,
  ean text not null,
  quantita numeric not null default 1,
  creato_il timestamptz not null default now(),
  unique (conteggio_id, ean)
);
alter table public.wt_giacenze_ean_non_risolti enable row level security;
drop policy if exists "allow all" on public.wt_giacenze_ean_non_risolti;
create policy "allow all" on public.wt_giacenze_ean_non_risolti for all using (true) with check (true);

-- Incremento atomico per gli EAN non risolti (stesso motivo/pattern di wt_giacenze_incrementa
-- in giacenze-schema.sql): scansione dal vivo e import massivo da XLSX possono capitare
-- ravvicinati, un ON CONFLICT lato Postgres evita di perdere un +1 per una race lato client.
-- Usata anche per "ricreare" la riga quando si rimuove un'assegnazione (p_delta = quantita
-- accumulata, sulla riga già cancellata l'ON CONFLICT non scatta e si inserisce da zero).
create or replace function public.wt_giacenze_ean_non_risolto_incrementa(
  p_conteggio_id uuid,
  p_ean text,
  p_delta numeric
) returns numeric
language plpgsql
as $$
declare
  v_totale numeric;
begin
  insert into public.wt_giacenze_ean_non_risolti as r (conteggio_id, ean, quantita)
  values (p_conteggio_id, p_ean, greatest(p_delta, 0))
  on conflict (conteggio_id, ean)
  do update set quantita = greatest(r.quantita + p_delta, 0)
  returning r.quantita into v_totale;
  return v_totale;
end;
$$;

grant execute on function public.wt_giacenze_ean_non_risolto_incrementa(uuid, text, numeric) to anon, authenticated;

-- Fa rileggere a PostgREST tabelle, colonne e funzioni appena create, senza attendere.
notify pgrst, 'reload schema';
