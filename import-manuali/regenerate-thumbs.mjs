// One-off follow-up script: regenerates thumbnails for families already imported
// into wt_manuali, WITHOUT touching the PDFs themselves (no re-upload, no re-import).
// Fixes the illegible-thumbnail bug from the initial import (transparent canvas
// background compositing to black in JPEG, low resolution, low quality, plus the
// pdfjs-dist/@napi-rs/canvas font-glyph corruption — see thumb-render.mjs for why
// rendering now goes through headless Chrome instead).
//
// Downloads each is_latest PDF via its public storage URL (anon key can't use
// storage.download()/list() due to RLS, but public-URL fetch works — same trick
// the app itself uses), re-renders the thumbnail, uploads it to a NEW path
// (upsert:true on this bucket fails RLS, and the old thumb path can't be deleted
// by the anon key either — see import-to-supabase.mjs), then updates thumb_path.
//
// Usage:
//   node regenerate-thumbs.mjs              preview only — lists how many rows
//                                            would be touched, renders NOTHING.
//   node regenerate-thumbs.mjs --commit      does the real regeneration.

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateThumb, closeBrowser } from './thumb-render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUCKET = 'manuali';
const TABLE = 'wt_manuali';
const CONCURRENCY = 3; // headless Chrome page rendering is heavier than plain network I/O
const REPORT_FILE = path.join(__dirname, 'regenerate-thumbs-report.json');
const COMMIT = process.argv.includes('--commit');

function loadSupabaseConfig() {
  const configSrc = readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const url = configSrc.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = configSrc.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  if (!url || !key) throw new Error('Impossibile leggere SUPABASE_URL/SUPABASE_ANON_KEY da ../config.js');
  return { url, key };
}

async function main() {
  const { url, key } = loadSupabaseConfig();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: allRows, error } = await sb.from(TABLE).select('id, gruppo_id, titolo, versione, storage_path, thumb_path').eq('is_latest', true);
  if (error) { console.error('Errore lettura wt_manuali:', error.message); process.exitCode = 1; return; }

  // Resumable: a row whose thumb_path already ends in "-r2.jpg" was already
  // regenerated in a previous (possibly interrupted) run of this same script.
  const rows = allRows.filter((r) => !(r.thumb_path && r.thumb_path.endsWith('-r2.jpg')));
  const alreadyDone = allRows.length - rows.length;

  console.log(`Famiglie (is_latest=true) trovate: ${allRows.length} (già rigenerate: ${alreadyDone}, da fare: ${rows.length})`);
  if (!COMMIT) {
    console.log('Solo anteprima — nessuna miniatura rigenerata. Rilancia con --commit per farlo davvero.');
    return;
  }

  let done = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(async (row) => {
      const pub = sb.storage.from(BUCKET).getPublicUrl(row.storage_path).data.publicUrl;
      const res = await fetch(pub);
      if (!res.ok) throw new Error(`download fallito (HTTP ${res.status}) per ${row.storage_path}`);
      const buf = Buffer.from(await res.arrayBuffer());

      const thumbBuf = await generateThumb(buf);
      if (!thumbBuf) throw new Error('rendering fallito');

      const newThumbPath = `${row.gruppo_id}/thumb-v${row.versione}-r2.jpg`;
      const up = await sb.storage.from(BUCKET).upload(newThumbPath, thumbBuf, { contentType: 'image/jpeg', upsert: false });
      if (up.error) throw new Error(`upload thumb fallito: ${up.error.message}`);

      const upd = await sb.from(TABLE).update({ thumb_path: newThumbPath }).eq('id', row.id);
      if (upd.error) throw new Error(`update riga fallito: ${upd.error.message}`);
    }));
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') done++;
      else { failed++; failures.push({ titolo: batch[idx].titolo, gruppo_id: batch[idx].gruppo_id, error: r.reason.message }); console.warn('  ERRORE:', batch[idx].titolo, '-', r.reason.message); }
    });
    console.log(`Progresso: ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length} (ok: ${done}, falliti: ${failed})`);
  }

  writeFileSync(REPORT_FILE, JSON.stringify({ done, failed, failures }, null, 2));
  console.log('\n=== COMPLETATO ===');
  console.log(`Rigenerate con successo: ${done}`);
  console.log(`Fallite: ${failed}${failed ? ' (dettagli in ' + REPORT_FILE + ')' : ''}`);
  await closeBrowser();
  process.exitCode = failed ? 1 : 0;
}

main().catch(async (err) => {
  console.error('Errore fatale:', err);
  await closeBrowser();
  process.exitCode = 1;
});
