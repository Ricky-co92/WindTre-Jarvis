-- Migration v3 per la pagina "Giacenze": tabella dedicata per il catalogo del Listino SBS.
-- Da eseguire una volta sola nello stesso Supabase SQL editor già usato per le altre migration
-- in tools/ (la anon key non può fare DDL). Idempotente.
--
-- Il file reale del Listino SBS usa "Referenza" (codice interno del fornitore SBS) e "Nome
-- Prodotto", non "Codice"/"Descrizione" come inizialmente ipotizzato: niente in questa tabella
-- corrisponde al "codice" usato in wt_giacenze_attese/wt_giacenze_conteggio_righe per il
-- conteggio di magazzino. wt_giacenze_ean (creata da giacenze-ean-schema.sql) resta quindi
-- per ora scollegata da questo import: lo scanner continua a leggerla per l'abbinamento
-- ean -> codice, ma nessun import scrive più lì finché non si decide come collegare
-- referenza_sbs (o altro) al codice del gestionale.

create table if not exists public.wt_giacenze_listino_sbs (
  ean text primary key,
  referenza_sbs text,
  nome_prodotto text,
  pvp numeric,
  aggiornato_il timestamptz not null default now()
);
alter table public.wt_giacenze_listino_sbs enable row level security;
drop policy if exists "allow all" on public.wt_giacenze_listino_sbs;
create policy "allow all" on public.wt_giacenze_listino_sbs for all using (true) with check (true);

notify pgrst, 'reload schema';
