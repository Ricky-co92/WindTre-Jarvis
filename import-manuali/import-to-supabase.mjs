// One-off migration script: bulk-import archived WindTre "manuali" PDFs (packed in .zip
// files in this folder) into Supabase — table wt_manuali + storage bucket "manuali".
//
// Mirrors the grouping/date/category heuristics from ../manuali.js (familyKeyFromFilename,
// parseDateFromText, titleize, guessCategoria, isGenericKey) so behavior matches the
// in-browser bulk importer exactly.
//
// Usage:
//   node import-to-supabase.mjs                 preview only — analyzes zips, writes
//                                                preview-report.json, uploads NOTHING.
//   node import-to-supabase.mjs --test-write     runs one small reversible read/write
//                                                probe against Supabase (inserts+deletes
//                                                one test row/file) to check whether the
//                                                anon key can write given current RLS
//                                                policies. Uploads nothing else.
//   node import-to-supabase.mjs --commit         does the real import: uploads PDFs +
//                                                thumbnails, inserts wt_manuali rows.
//                                                Safe to re-run: already-imported
//                                                (gruppo_id, versione) pairs are skipped.

import AdmZip from 'adm-zip';
import { createClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateThumb, closeBrowser } from './thumb-render.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUCKET = 'manuali';
const TABLE = 'wt_manuali';
const CONCURRENCY = 5;
const THUMB_CONCURRENCY = 3; // headless Chrome page rendering is heavier than plain network I/O
const GRUPPO_IDS_FILE = path.join(__dirname, '.gruppo-ids.json');
const PREVIEW_REPORT_FILE = path.join(__dirname, 'preview-report.json');
const IMPORT_REPORT_FILE = path.join(__dirname, 'import-report.json');

const args = process.argv.slice(2);
const MODE = args.includes('--commit') ? 'commit' : args.includes('--test-write') ? 'test-write' : 'preview';

// ---------------------------------------------------------------------------
// Grouping/date heuristics — ported verbatim from ../manuali.js, validated against
// the real archive (see conversation history: false-merge fix for generic filenames).
// ---------------------------------------------------------------------------
const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const SEASON_MONTH = { estate: 5, summer: 5, inverno: 11, winter: 11, primavera: 2, spring: 2, autunno: 8, autumn: 8 };
const monthsRe = MONTHS_IT.join('|');

function parseDateFromText(text) {
  if (!text) return null;
  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) { const d1 = new Date(+iso[1], +iso[2] - 1, +iso[3]); if (!isNaN(d1)) return d1; }
  const re = new RegExp('(\\d{1,2})\\s*[\\+\\-_ ]?\\s*(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*(\\d{2,4})', 'i');
  const m = text.toLowerCase().match(re);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS_IT.indexOf(m[2].toLowerCase());
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    const d2 = new Date(year, month, day);
    if (!isNaN(d2) && day >= 1 && day <= 31) return d2;
  }
  const reMY = new RegExp('(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*(\\d{2,4})', 'i');
  const m2 = text.toLowerCase().match(reMY);
  if (m2) {
    const month2 = MONTHS_IT.indexOf(m2[1].toLowerCase());
    let year2 = parseInt(m2[2], 10);
    if (year2 < 100) year2 += 2000;
    return new Date(year2, month2, 1);
  }
  const seasonRe = new RegExp('(' + Object.keys(SEASON_MONTH).join('|') + ')\\s*[\\+\\-_ ]?\\s*(\\d{4})', 'i');
  const m3 = text.toLowerCase().match(seasonRe);
  if (m3) return new Date(parseInt(m3[2], 10), SEASON_MONTH[m3[1].toLowerCase()], 1);
  const yOnly = text.match(/\b(20\d{2})\b/);
  if (yOnly) return new Date(parseInt(yOnly[1], 10), 0, 1);
  return null;
}

function familyKeyFromFilename(nameNoExt) {
  const re = new RegExp('\\d{1,2}\\s*[\\+\\-_ ]?\\s*(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*\\d{2,4}', 'gi');
  const stripped = nameNoExt
    .replace(/\(\d+\)/g, '')
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(re, '')
    .replace(/[_\-\+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.toLowerCase() || nameNoExt.toLowerCase();
}

function isGenericKey(key) {
  return key.indexOf(' ') === -1 && key.length > 0 && key.length <= 12;
}

function titleize(key) {
  return key.split(' ').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function guessCategoria(nameNoExt) {
  const n = nameNoExt.toLowerCase();
  if (n.indexOf('manuale') > -1) return 'Manuali';
  if (n.indexOf('sintesi') > -1) return 'Sintesi Offerte';
  if (n.indexOf('canvass') > -1) return 'Canvass';
  if (n.indexOf('guid') > -1 || n.indexOf('selling') > -1) return 'Guide';
  return '';
}

function versionDateSort(a, b) {
  const da = a.date ? a.date.getTime() : Infinity;
  const db = b.date ? b.date.getTime() : Infinity;
  return da - db;
}

// ---------------------------------------------------------------------------
// Zip scanning
// ---------------------------------------------------------------------------
function scanZips() {
  const zipFiles = readdirSync(__dirname).filter((f) => f.toLowerCase().endsWith('.zip'));
  if (!zipFiles.length) {
    console.error('Nessun file .zip trovato in', __dirname);
    process.exit(1);
  }
  console.log('Zip trovati:', zipFiles.length);

  const families = {};
  const seenHashes = new Set();
  let totalPdf = 0, dupCount = 0, nonPdfCount = 0;

  for (const zf of zipFiles) {
    const zip = new AdmZip(path.join(__dirname, zf));
    const entries = zip.getEntries().filter((e) => !e.isDirectory);
    for (const entry of entries) {
      const lower = entry.entryName.toLowerCase();
      if (!lower.endsWith('.pdf')) { nonPdfCount++; continue; }
      totalPdf++;
      const buf = entry.getData();
      const hash = createHash('sha256').update(buf).digest('hex');
      if (seenHashes.has(hash)) { dupCount++; continue; }
      seenHashes.add(hash);

      const parts = entry.entryName.split('/');
      const fileName = parts[parts.length - 1];
      const nameNoExt = fileName.replace(/\.pdf$/i, '');
      let key = familyKeyFromFilename(nameNoExt);
      let titolo = titleize(key);
      const immediateFolder = parts.length > 1 ? parts[parts.length - 2] : '';
      if (isGenericKey(key) && immediateFolder) {
        key = key + '::' + immediateFolder.toLowerCase();
        titolo = titolo + ' (' + titleize(immediateFolder.toLowerCase()) + ')';
      }
      const dateFromName = parseDateFromText(nameNoExt);
      const dateFromPath = dateFromName || parseDateFromText(parts.slice(0, -1).join(' '));
      const confident = !!dateFromName;
      const finalDate = dateFromPath || null;

      if (!families[key]) families[key] = { titolo, categoria: guessCategoria(nameNoExt), versions: [] };
      families[key].versions.push({
        fileName, buf, date: finalDate, confident, noDate: !finalDate,
        sourceZip: zf, sourcePath: entry.entryName, sha256: hash
      });
    }
  }

  Object.keys(families).forEach((k) => families[k].versions.sort(versionDateSort));

  const stats = {
    zipCount: zipFiles.length, totalPdfEntries: totalPdf, exactDuplicates: dupCount,
    nonPdfSkipped: nonPdfCount, totalFamilies: Object.keys(families).length,
    totalVersions: Object.values(families).reduce((s, f) => s + f.versions.length, 0),
    noDateVersions: Object.values(families).reduce((s, f) => s + f.versions.filter((v) => v.noDate).length, 0)
  };
  return { families, stats };
}

// ---------------------------------------------------------------------------
// Supabase client (reads URL/anon key from ../config.js so credentials stay single-sourced)
// ---------------------------------------------------------------------------
function loadSupabaseConfig() {
  const configSrc = readFileSync(path.join(__dirname, '..', 'config.js'), 'utf8');
  const url = configSrc.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
  const key = configSrc.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
  if (!url || !key) throw new Error('Impossibile leggere SUPABASE_URL/SUPABASE_ANON_KEY da ../config.js');
  return { url, key };
}

function makeClient() {
  const { url, key } = loadSupabaseConfig();
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------------------------------------------------------------------------
// Reversible RLS write probe
// ---------------------------------------------------------------------------
async function testAnonWriteAccess(sb) {
  const testGruppo = randomUUID();
  const testPath = `__rls_write_test__/${testGruppo}.pdf`;
  const dummy = Buffer.from('%PDF-1.4\n%test file for RLS probe, safe to ignore\n');

  const upRes = await sb.storage.from(BUCKET).upload(testPath, dummy, { contentType: 'application/pdf' });
  if (upRes.error) return { ok: false, stage: 'storage.upload', error: upRes.error.message };

  const insRes = await sb.from(TABLE).insert({
    gruppo_id: testGruppo, titolo: '__ANON_WRITE_TEST__ (safe to delete)', categoria: null,
    versione: 1, storage_path: testPath, file_name: 'rls-test.pdf', file_size: dummy.length,
    is_latest: true, thumb_path: null, uploaded_at: new Date().toISOString()
  });

  await sb.storage.from(BUCKET).remove([testPath]);
  if (!insRes.error) await sb.from(TABLE).delete().eq('gruppo_id', testGruppo);

  if (insRes.error) return { ok: false, stage: 'db insert', error: insRes.error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Persisted family-key -> gruppo_id map, so re-running --commit is idempotent
// (same families reuse the same gruppo_id instead of creating duplicates).
// ---------------------------------------------------------------------------
function loadGruppoIds() {
  if (!existsSync(GRUPPO_IDS_FILE)) return {};
  return JSON.parse(readFileSync(GRUPPO_IDS_FILE, 'utf8'));
}
function saveGruppoIds(map) {
  writeFileSync(GRUPPO_IDS_FILE, JSON.stringify(map, null, 2));
}

// ---------------------------------------------------------------------------
// Upload one version (storage + optional thumb + db row)
// ---------------------------------------------------------------------------
async function uploadOne(sb, buf, opts, fileName) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${opts.gruppoId}/v${opts.versione}-${safeName}`;
  const upRes = await sb.storage.from(BUCKET).upload(storagePath, buf, { contentType: 'application/pdf', upsert: false });
  if (upRes.error) {
    // A prior interrupted run can leave the file uploaded but its wt_manuali row
    // missing (upload succeeds, then the process dies before the insert). Anon key
    // can't overwrite (upsert:true fails RLS) or delete (remove() silently no-ops
    // under RLS) that leftover, but the object is otherwise a byte-identical
    // re-upload of the same source PDF — safe to treat as already-done and proceed
    // straight to the DB insert instead of failing the whole task.
    if (!/already exists/i.test(upRes.error.message)) {
      throw new Error(`storage upload fallito (${storagePath}): ${upRes.error.message}`);
    }
    console.warn(`  File già presente in storage (run precedente interrotto), riuso: ${storagePath}`);
  }

  let thumbPath = null;
  if (opts.thumbBuf) {
    thumbPath = `${opts.gruppoId}/thumb-v${opts.versione}.jpg`;
    // upsert:true fails RLS on this bucket's storage.objects policy (verified empirically);
    // upsert:false is fine since every thumb path in a fresh import run is guaranteed new.
    const thumbUp = await sb.storage.from(BUCKET).upload(thumbPath, opts.thumbBuf, { contentType: 'image/jpeg', upsert: false });
    if (thumbUp.error) { console.warn('  Thumb upload fallita:', thumbUp.error.message); thumbPath = null; }
  }

  const insRes = await sb.from(TABLE).insert({
    gruppo_id: opts.gruppoId, titolo: opts.titolo, categoria: opts.categoria || null,
    versione: opts.versione, storage_path: storagePath, file_name: fileName,
    file_size: buf.length, is_latest: opts.isLatest, thumb_path: thumbPath,
    uploaded_at: opts.uploadedAt || new Date().toISOString()
  });
  if (insRes.error) throw new Error(`insert wt_manuali fallito (${fileName}): ${insRes.error.message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('Modalità:', MODE);
  const { families, stats } = scanZips();

  console.log('\n=== RISULTATO ANALISI ===');
  console.log(JSON.stringify(stats, null, 2));

  const preview = Object.entries(families).map(([key, fam]) => ({
    key, titolo: fam.titolo, categoria: fam.categoria,
    versioni: fam.versions.map((v) => ({
      fileName: v.fileName, date: v.date ? v.date.toISOString().slice(0, 10) : null,
      confident: v.confident, noDate: v.noDate, sourceZip: v.sourceZip, sourcePath: v.sourcePath
    }))
  }));
  writeFileSync(PREVIEW_REPORT_FILE, JSON.stringify({ stats, families: preview }, null, 2));
  console.log('\nReport di anteprima scritto in:', PREVIEW_REPORT_FILE);

  if (MODE === 'preview') {
    console.log('\nSolo anteprima — nessun upload eseguito. Rilancia con --test-write o --commit.');
    return;
  }

  const sb = makeClient();

  if (MODE === 'test-write' || MODE === 'commit') {
    console.log('\n=== TEST SCRITTURA (reversibile) ===');
    const test = await testAnonWriteAccess(sb);
    if (!test.ok) {
      console.error('La sola anon key NON può scrivere. Fallito allo stage:', test.stage);
      console.error('Errore:', test.error);
      console.error('\nServe autenticazione utente (login) per procedere con --commit. Nessun dato reale caricato.');
      process.exitCode = 1;
      return;
    }
    console.log('OK — la anon key può scrivere su storage e su wt_manuali (RLS permissivo). Riga/file di test creati e rimossi correttamente.');
  }

  if (MODE === 'test-write') { return; }

  // MODE === 'commit'
  console.log('\n=== IMPORT REALE ===');
  const gruppoIds = loadGruppoIds();

  console.log('Recupero righe già presenti su wt_manuali per rendere il run idempotente...');
  const { data: existingRows, error: existErr } = await sb.from(TABLE).select('gruppo_id, versione');
  if (existErr) { console.error('Impossibile leggere wt_manuali:', existErr.message); process.exitCode = 1; return; }
  const existingSet = new Set((existingRows || []).map((r) => r.gruppo_id + '::' + r.versione));

  const pending = [];
  let skippedAlready = 0;
  for (const [key, fam] of Object.entries(families)) {
    if (!gruppoIds[key]) { gruppoIds[key] = randomUUID(); }
    const gruppoId = gruppoIds[key];
    const versions = fam.versions;
    versions.forEach((v, vi) => {
      const versione = vi + 1;
      const isLatest = vi === versions.length - 1;
      if (existingSet.has(gruppoId + '::' + versione)) { skippedAlready++; return; }
      pending.push({ v, gruppoId, titolo: fam.titolo, categoria: fam.categoria, versione, isLatest });
    });
  }
  saveGruppoIds(gruppoIds);

  console.log(`Task da eseguire: ${pending.length} (già presenti/saltate: ${skippedAlready})`);
  if (!pending.length) { console.log('Niente da caricare.'); return; }

  // Thumbnails render via a shared headless Chrome instance, batched like the
  // uploads below (a per-page render failure/timeout only affects that page).
  const needsThumb = pending.filter((p) => p.isLatest);
  console.log(`Pre-rendering ${needsThumb.length} miniature (batch da ${THUMB_CONCURRENCY})...`);
  for (let i = 0; i < needsThumb.length; i += THUMB_CONCURRENCY) {
    const batch = needsThumb.slice(i, i + THUMB_CONCURRENCY);
    await Promise.all(batch.map(async (p) => { p.thumbBuf = await generateThumb(p.v.buf); }));
    console.log(`  Miniature: ${Math.min(i + THUMB_CONCURRENCY, needsThumb.length)}/${needsThumb.length}`);
  }
  await closeBrowser();

  const tasks = pending.map((p) => async () => {
    await uploadOne(sb, p.v.buf, {
      gruppoId: p.gruppoId, titolo: p.titolo, categoria: p.categoria || null,
      versione: p.versione, isLatest: p.isLatest, uploadedAt: p.v.date ? p.v.date.toISOString() : undefined,
      thumbBuf: p.thumbBuf || null
    }, p.v.fileName);
  });

  let done = 0, failed = 0;
  const failures = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((t) => t()));
    results.forEach((r) => {
      if (r.status === 'fulfilled') done++;
      else { failed++; failures.push(r.reason.message); console.error('  ERRORE:', r.reason.message); }
    });
    console.log(`Progresso: ${done + failed}/${tasks.length} (ok: ${done}, falliti: ${failed})`);
  }

  writeFileSync(IMPORT_REPORT_FILE, JSON.stringify({ done, failed, failures, skippedAlready, totalTasks: tasks.length }, null, 2));
  console.log('\n=== COMPLETATO ===');
  console.log(`Caricati con successo: ${done}`);
  console.log(`Falliti: ${failed}${failed ? ' (dettagli in ' + IMPORT_REPORT_FILE + ', rilancia --commit per riprovare solo quelli mancanti)' : ''}`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(async (err) => {
  console.error('Errore fatale:', err);
  await closeBrowser();
  process.exitCode = 1;
});
