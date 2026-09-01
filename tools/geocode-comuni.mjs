// One-off enrichment script: geocodes every comune in wt_comuni_aree_bianche and
// stores lat/lon in a separate table, comuni_coordinate (see comuni-coordinate.sql
// for why it's a separate table, and how to create it -- must be run once in the
// Supabase SQL editor before this script will work).
//
// Source: OpenStreetMap Nominatim (nominatim.openstreetmap.org), data licensed
// ODbL 1.0 -- chosen over the various "comuni italiani" CSV/JSON dumps on GitHub
// because none of those repos declare an explicit license (checked via the GitHub
// API: license == null), while Nominatim's license and usage policy are explicit
// and well documented. Queried by "<comune>, <provincia>, Italia" (both already
// columns on wt_comuni_aree_bianche), restricted to countrycodes=it, with a
// comune-name-only retry if the first query finds nothing.
//
// Respects Nominatim's usage policy: max 1 request/second (this script waits
// 1.1s between requests, strictly sequential -- no concurrency), and a
// descriptive User-Agent identifying the request as this app's own.
//
// Usage:
//   node geocode-comuni.mjs              preview only -- lists how many comuni
//                                         still need geocoding, calls Nominatim
//                                         for NOTHING, writes nothing.
//   node geocode-comuni.mjs --commit     does the real geocoding. Resumable: a
//                                         comune already present in
//                                         comuni_coordinate is skipped, so a
//                                         killed/interrupted run can just be
//                                         re-launched and it continues from
//                                         where it left off.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_TABLE = 'wt_comuni_aree_bianche';
const DEST_TABLE = 'comuni_coordinate';
const REPORT_FILE = path.join(__dirname, 'geocode-comuni-report.json');
const COMMIT = process.argv.includes('--commit');
const NOMINATIM_DELAY_MS = 1100;
const USER_AGENT = 'WindTre-Jarvis-ComuniGeocoder/1.0 (one-time internal geocoding script, no bulk redistribution)';

function loadSupabaseConfig() {
  const configSrc = readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const url = configSrc.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = configSrc.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  if (!url || !key) throw new Error('Impossibile leggere SUPABASE_URL/SUPABASE_ANON_KEY da ../config.js');
  return { url, key };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function nominatimSearch(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=it&q=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  return data && data[0] ? { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) } : null;
}

async function geocodeComune(row) {
  let hit = await nominatimSearch(`${row.comune}, ${row.provincia}, Italia`);
  if (!hit) {
    await sleep(NOMINATIM_DELAY_MS);
    hit = await nominatimSearch(`${row.comune}, Italia`);
  }
  return hit;
}

// Supabase/PostgREST caps a single select at 1000 rows, so page through in
// batches like comuni.js's loadComuni() does.
async function fetchAllRows(sb, table, select) {
  var all = [];
  var pageSize = 1000;
  var from = 0;
  while (true) {
    const res = await sb.from(table).select(select).range(from, from + pageSize - 1);
    if (res.error) throw new Error(`Errore lettura ${table}: ${res.error.message}`);
    const batch = res.data || [];
    all = all.concat(batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  const { url, key } = loadSupabaseConfig();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  let allRows, doneRows;
  try {
    allRows = await fetchAllRows(sb, SRC_TABLE, 'comune, comune_norm, provincia, regione, codice_istat');
    doneRows = await fetchAllRows(sb, DEST_TABLE, 'comune_norm');
  } catch (err) {
    console.error(err.message);
    console.error(`(${DEST_TABLE} esiste? Esegui prima comuni-coordinate.sql nell'editor SQL di Supabase.)`);
    process.exitCode = 1;
    return;
  }
  const alreadyDone = new Set(doneRows.map((r) => r.comune_norm));

  const rows = allRows.filter((r) => !alreadyDone.has(r.comune_norm));
  console.log(`Comuni in ${SRC_TABLE}: ${allRows.length} (già geocodificati: ${alreadyDone.size}, da fare: ${rows.length})`);
  if (!COMMIT) {
    console.log('Solo anteprima -- nessuna geocodifica eseguita. Rilancia con --commit per farlo davvero.');
    console.log(`Tempo stimato: ~${Math.ceil(rows.length * NOMINATIM_DELAY_MS / 60000)} minuti (1 richiesta/sec verso Nominatim).`);
    return;
  }

  let done = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const hit = await geocodeComune(row);
      if (!hit) throw new Error('nessun risultato da Nominatim');
      const up = await sb.from(DEST_TABLE).upsert({
        comune_norm: row.comune_norm,
        comune: row.comune,
        provincia: row.provincia,
        codice_istat: row.codice_istat,
        lat: hit.lat,
        lon: hit.lon,
        source: 'nominatim'
      }, { onConflict: 'comune_norm' });
      if (up.error) throw new Error('scrittura fallita: ' + up.error.message);
      done++;
    } catch (err) {
      failed++;
      failures.push({ comune: row.comune, provincia: row.provincia, error: err.message });
      console.warn('  ERRORE:', row.comune, '(' + row.provincia + ') -', err.message);
    }
    if ((i + 1) % 25 === 0 || i === rows.length - 1) {
      console.log(`Progresso: ${i + 1}/${rows.length} (ok: ${done}, falliti: ${failed})`);
    }
    await sleep(NOMINATIM_DELAY_MS);
  }

  writeFileSync(REPORT_FILE, JSON.stringify({ done, failed, failures }, null, 2));
  console.log('\n=== COMPLETATO ===');
  console.log(`Geocodificati con successo: ${done}`);
  console.log(`Falliti: ${failed}${failed ? ' (dettagli in ' + REPORT_FILE + ')' : ''}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exitCode = 1;
});
