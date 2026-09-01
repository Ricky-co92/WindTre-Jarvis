// One-off script: builds ../data/comuni-vicino-casale.json, a static local snapshot
// of every comune (OSM admin_level=8 boundary) within RADIUS_KM of Casale Monferrato.
//
// Why this exists separately from tools/geocode-comuni.mjs: that script only
// geocodes comuni already present in wt_comuni_aree_bianche (the "aree bianche"
// eligibility list), but the "Comuni vicino a Casale Monferrato" map/slider in
// comuni.js needs to show ALL nearby comuni -- including ones NOT in that list,
// shown with a red dot/marker (already has full coverage, so it's not a
// white area). Nominatim (used for the national geocoding job) has no
// "everything within X km" query; Overpass (also OSM/ODbL) does, via `around`.
//
// This is meant to be re-run only if the radius needs changing or the data goes
// stale -- the output is checked into the repo as a static asset (same pattern
// as templates/*.pdf), not fetched from Overpass on every page load.
//
// Usage: node fetch-comuni-vicino-casale.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dirname, '..', 'data', 'comuni-vicino-casale.json');
const CASALE = { lat: 45.136266, lon: 8.449813 };
const RADIUS_KM = 60; // buffer above the 5-50km slider range in comuni.js

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  const query = `[out:json][timeout:60];
(
  relation(around:${RADIUS_KM * 1000},${CASALE.lat},${CASALE.lon})["boundary"="administrative"]["admin_level"="8"];
);
out center tags;`;

  // Overpass's public instance occasionally answers 504 under load; a couple of
  // retries with backoff clears it up almost always.
  let data;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          'User-Agent': 'WindTre-Jarvis-ComuniVicinoCasale/1.0 (one-time internal script)',
          'Accept': 'application/json'
        },
        body: query
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      data = await res.json();
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`Tentativo ${attempt}/3 fallito: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  if (!data) throw lastErr;

  const comuni = (data.elements || [])
    .filter((el) => el.center && el.tags && el.tags.name)
    .map((el) => ({
      comune: el.tags.name,
      comune_norm: norm(el.tags.name),
      lat: el.center.lat,
      lon: el.center.lon
    }))
    .sort((a, b) => a.comune.localeCompare(b.comune, 'it'));

  const out = {
    center: CASALE,
    radius_km: RADIUS_KM,
    source: 'OpenStreetMap Overpass API, dati ODbL 1.0 (c) OpenStreetMap contributors',
    generated_at: new Date().toISOString(),
    comuni
  };

  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`Scritti ${comuni.length} comuni entro ${RADIUS_KM}km da Casale Monferrato in ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('Errore:', err);
  process.exitCode = 1;
});
