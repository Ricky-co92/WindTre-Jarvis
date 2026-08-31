import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';

const configSrc = readFileSync('../config.js', 'utf8');
const url = configSrc.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)[1];
const key = configSrc.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)[1];
const sb = createClient(url, key, { auth: { persistSession: false } });

function normalize(titolo) {
  return titolo.toLowerCase().replace(/[^a-z0-9()]/g, '');
}

const { data: rows, error } = await sb.from('wt_manuali').select('id, gruppo_id, titolo, versione, is_latest, file_name, uploaded_at, categoria');
if (error) { console.error(error); process.exit(1); }

const byGruppo = {};
rows.forEach((r) => { (byGruppo[r.gruppo_id] = byGruppo[r.gruppo_id] || []).push(r); });

const byNorm = {};
Object.entries(byGruppo).forEach(([g, rs]) => {
  const titolo = rs[0].titolo;
  const norm = normalize(titolo);
  (byNorm[norm] = byNorm[norm] || []).push({ gruppoId: g, titolo, rows: rs });
});

const dupGroups = Object.entries(byNorm).filter(([, fams]) => fams.length > 1);
console.log('Famiglie totali:', Object.keys(byGruppo).length);
console.log('Chiavi normalizzate con >1 famiglia (possibili duplicati da unire):', dupGroups.length);
let totalFamiliesInvolved = 0;
dupGroups.forEach(([norm, fams]) => { totalFamiliesInvolved += fams.length; });
console.log('Famiglie coinvolte totali:', totalFamiliesInvolved, '-> diventerebbero', dupGroups.length, 'dopo merge');

dupGroups.forEach(([norm, fams]) => {
  console.log('\n=== norm:', norm, '===');
  fams.forEach((f) => {
    console.log('  gruppo', f.gruppoId, '| titolo:', JSON.stringify(f.titolo), '| versioni:', f.rows.length, '| categoria:', f.rows[0].categoria);
  });
});

writeFileSync('duplicate-audit.json', JSON.stringify(dupGroups.map(([norm, fams]) => ({ norm, families: fams.map(f => ({ gruppoId: f.gruppoId, titolo: f.titolo, versioni: f.rows.length })) })), null, 2));
