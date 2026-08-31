// One-off data-cleanup script: merges families in wt_manuali that ended up split
// only because WindTre alternates, month to month, between "Con Spazi" and
// "SenzaSpazi" filename conventions for the same recurring document (e.g.
// "Manuale Professionisti 5 ottobre 22.pdf" vs "ManualeProfessionisti15maggio23.pdf").
// The import-time grouping heuristic has been fixed (see manuali.js /
// import-to-supabase.mjs — matchKey now strips whitespace) so this won't recur for
// future imports; this script is the retroactive fix for families already split
// under the old heuristic.
//
// Also fixes one specific mistaken edit: gruppo_id 078be70a (file "MANUALE BIZ.pdf",
// correctly titled "Manuale Biz" at import time) had its titolo overwritten to
// "MANUALE PROFESSIONISTI" after import (almost certainly an accidental edit via
// the title-edit modal) — reverted here, NOT merged into the real Manuale
// Professionisti family, since its content is unrelated.
//
// Usage:
//   node fix-duplicates.mjs              preview only — shows what would merge.
//   node fix-duplicates.mjs --commit     does the real merge.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const COMMIT = process.argv.includes('--commit');
const TABLE = 'wt_manuali';

const MISTAKEN_EDIT_FIX = { gruppoId: '078be70a-3cda-4ede-9dc3-1cb98dfd5006', correctTitolo: 'Manuale Biz' };

function loadSupabaseConfig() {
  const configSrc = readFileSync('../config.js', 'utf8');
  const url = configSrc.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = configSrc.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  return { url, key };
}

function normalize(titolo) {
  return titolo.toLowerCase().replace(/[^a-z0-9()]/g, '');
}

function cleanTitolo(t) {
  return t.replace(/[\s.]+$/, '').trim();
}

// Prefer a display title that has word spacing and isn't ALL CAPS/all-lowercase;
// among equally "nice" candidates prefer the one from the family with more versions.
function pickCanonicalTitolo(fams) {
  function score(f) {
    const t = cleanTitolo(f.titolo);
    let s = 0;
    if (/\s/.test(t)) s += 10;
    if (t !== t.toUpperCase() && t !== t.toLowerCase()) s += 5;
    s += f.rows.length;
    return s;
  }
  return cleanTitolo([...fams].sort((a, b) => score(b) - score(a))[0].titolo);
}

async function main() {
  const { url, key } = loadSupabaseConfig();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  console.log('=== Fix titolo errato (edit accidentale) ===');
  const { data: mistakenRows } = await sb.from(TABLE).select('id, titolo, file_name').eq('gruppo_id', MISTAKEN_EDIT_FIX.gruppoId);
  if (mistakenRows && mistakenRows.length && mistakenRows[0].titolo !== MISTAKEN_EDIT_FIX.correctTitolo) {
    console.log(`gruppo_id ${MISTAKEN_EDIT_FIX.gruppoId}: "${mistakenRows[0].titolo}" -> "${MISTAKEN_EDIT_FIX.correctTitolo}" (file: ${mistakenRows[0].file_name})`);
    if (COMMIT) {
      const upd = await sb.from(TABLE).update({ titolo: MISTAKEN_EDIT_FIX.correctTitolo }).eq('gruppo_id', MISTAKEN_EDIT_FIX.gruppoId);
      if (upd.error) throw new Error('Fix titolo fallito: ' + upd.error.message);
    }
  } else {
    console.log('(già corretto o non trovato, nessuna azione)');
  }

  console.log('\n=== Ricerca famiglie duplicate ===');
  const { data: rows, error } = await sb.from(TABLE).select('id, gruppo_id, titolo, versione, is_latest, file_name, uploaded_at, thumb_path, categoria');
  if (error) throw error;

  const byGruppo = {};
  rows.forEach((r) => { (byGruppo[r.gruppo_id] = byGruppo[r.gruppo_id] || []).push(r); });

  const byNorm = {};
  Object.entries(byGruppo).forEach(([g, rs]) => {
    const norm = normalize(rs[0].titolo);
    (byNorm[norm] = byNorm[norm] || []).push({ gruppoId: g, titolo: rs[0].titolo, rows: rs });
  });

  const dupGroups = Object.entries(byNorm).filter(([, fams]) => fams.length > 1);
  console.log(`Famiglie totali: ${Object.keys(byGruppo).length}`);
  console.log(`Gruppi duplicati trovati: ${dupGroups.length} (famiglie coinvolte: ${dupGroups.reduce((s, [, f]) => s + f.length, 0)})`);

  for (const [norm, fams] of dupGroups) {
    const canonicalTitolo = pickCanonicalTitolo(fams);
    const canonical = [...fams].sort((a, b) => b.rows.length - a.rows.length)[0];
    const others = fams.filter((f) => f.gruppoId !== canonical.gruppoId);

    console.log(`\n--- ${norm} ---`);
    console.log(`  canonico: ${canonical.gruppoId} ("${canonical.titolo}", ${canonical.rows.length} versioni) -> titolo finale: "${canonicalTitolo}"`);
    others.forEach((o) => console.log(`  assorbe: ${o.gruppoId} ("${o.titolo}", ${o.rows.length} versioni)`));

    if (!COMMIT) continue;

    for (const o of others) {
      const upd = await sb.from(TABLE).update({ gruppo_id: canonical.gruppoId }).eq('gruppo_id', o.gruppoId);
      if (upd.error) throw new Error(`Merge fallito per ${o.gruppoId}: ${upd.error.message}`);
    }
    const titUpd = await sb.from(TABLE).update({ titolo: canonicalTitolo }).eq('gruppo_id', canonical.gruppoId);
    if (titUpd.error) throw new Error(`Aggiornamento titolo fallito per ${canonical.gruppoId}: ${titUpd.error.message}`);

    // Versione/is_latest non sono mai attendibili dopo un merge: si ricalcolano
    // sempre dall'ordine cronologico reale delle date, come nel modale di modifica.
    const { data: merged, error: mergedErr } = await sb.from(TABLE).select('id, uploaded_at').eq('gruppo_id', canonical.gruppoId);
    if (mergedErr) throw mergedErr;
    const ordered = merged.sort((a, b) => new Date(a.uploaded_at) - new Date(b.uploaded_at));
    for (let i = 0; i < ordered.length; i++) {
      const isLatest = i === ordered.length - 1;
      const vUpd = await sb.from(TABLE).update({ versione: i + 1, is_latest: isLatest }).eq('id', ordered[i].id);
      if (vUpd.error) throw new Error(`Rinumerazione versione fallita: ${vUpd.error.message}`);
    }
    console.log(`  -> unito, ${ordered.length} versioni totali rinumerate.`);
  }

  if (!COMMIT) console.log('\nSolo anteprima — nessuna modifica scritta. Rilancia con --commit per applicare davvero.');
  else console.log('\n=== COMPLETATO ===');
}

main().catch((err) => { console.error('Errore fatale:', err); process.exitCode = 1; });
