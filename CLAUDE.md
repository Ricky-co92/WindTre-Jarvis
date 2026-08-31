# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

WindTre-Jarvis is a client-side PWA used by WindTre retail staff to compile withdrawal/legal PDF modules, browse tariff offers, look up "aree bianche" comuni, and share internal manuals. It is a single static site with **no build step, no bundler, and no package manager** — every `<script>` tag in `index.html` loads a plain JS file (or a CDN library) directly in the browser.

Deployed via GitHub Pages to the custom domain in `CNAME` (windtre.costariccardo.com). Pushing to `main` is the deploy.

## Commands

There is no build/lint/test tooling in this repo (no `package.json`). To work on it locally, just serve the static files and open them in a browser, e.g.:

```
npx serve .
# or
python -m http.server 8000
```

Then open `index.html` (or the served URL) in a browser. Use the browser devtools console to check for runtime errors — there is no linter/formatter/test suite to run.

Cache-busting: static assets are referenced with `?v=N` query params in `index.html` (e.g. `compilatore.js?v=3`). **Bump the version suffix whenever you change one of these files**, otherwise the service worker (`sw.js`) or browser cache can serve a stale copy to already-installed PWA users.

## Architecture

### Loading model
`index.html` is the single page/shell. All view sections (`#view-home`, `#view-compilatore`, `#view-offerte`, `#view-gestione`, `#view-comuni`, `#view-manuali`, `#view-impostazioni`) live in this one HTML file and are toggled via CSS `.hidden`, not routed/loaded separately. Each feature area's logic is a separate global-scope (or IIFE-wrapped) `.js` file loaded via `<script>` tag, in this order: `config.js` → `perms.js` → `app.js` → `compilatore.js` → `offerte.js` → `comuni.js` → `manuali.js` → `settings.js`. There's no module system — files communicate through shared globals (`sb`, `PERMS`, `currentUser`) and a custom DOM event, `jarvis:view` (dispatched by `switchView()` in `app.js`), which each feature file listens for to lazy-load its data when its tab becomes active.

### Backend: Supabase
`config.js` holds the Supabase URL/anon key and instantiates the client as the global `sb` (`auth: { persistSession: false }` — sessions aren't persisted across reloads by design). All data access is direct `sb.from(...)` calls from the browser using the anon key; there is no server layer. Tables in use: `wt_users_permissions`, `wt_offerte`, `wt_custom_columns`, `wt_configurazioni`, `wt_comuni_aree_bianche`, `wt_manuali_categorie`, `wt_manuali`, `wt_module_meta`. File uploads (manuali PDFs/thumbnails) go through Supabase Storage bucket `manuali` (see `BUCKET` in `manuali.js`). Authorization/row access is enforced on the Supabase side (RLS) — this repo has no visibility into those policies, only into what the client requests.

### Permissions (`perms.js`)
`PAGES_REGISTRY` is the single source of truth for which views exist and which fine-grained actions each view supports (e.g. `offerte` → `edit_tariffa`, `delete_tariffa`, ...). A user's row in `wt_users_permissions` stores `is_superadmin` plus a `permissions` JSON blob keyed by page. `PERMS.canView(page)` / `PERMS.can(page, action)` gate both nav visibility (`applyNavVisibility()`) and in-view UI (each feature file re-checks `PERMS` before rendering edit controls). When adding a new view or a new permission-gated action, register it in `PAGES_REGISTRY` first — `settings.js` builds its permission-editing UI for SuperAdmins entirely off that registry.

### `compilatore.js` — PDF module filler (largest/most complex file)
Fills official WindTre withdrawal/legal PDF forms without a server:
- `TEMPLATE_FILES` maps a mode key (`mobile`, `micro`, `fisso`, `cessione`, `morte`, `decesso`, `energy`, `oltresogliasingolo`, `oltresoglia10sim`) to a static PDF in `templates/`, fetched and cached in-memory as bytes (`getTemplateBytes`).
- `MODES` is a per-template config object describing every fillable field/checkbox as **absolute PDF coordinates** (`x`, `top`, `bottom`, `size`, optional `boxed`/`boxX0`/`boxWidth`/`boxCount` for per-character boxed fields like codice fiscale) plus checkbox hit-boxes and signature box geometry. This is coordinate data tied exactly to the fixed layout of the PDFs in `templates/` — if a template PDF changes, these coordinates must be re-measured and updated in lockstep.
- Rendering is done with `PDFLib.PDFDocument` (pdf-lib) to draw text/checkboxes onto the loaded template bytes, `pdf.js` for any preview/rasterization needs, and a custom handwriting font embedded via `fontkit` for signatures.
- `wt_module_meta` (Supabase) stores metadata about generated modules (not the PDFs themselves, which are generated client-side and downloaded).

### `offerte.js`
Backs both the "Dettaglio Tariffe" view (`offerte`, customer-facing catalog browsing) and the "Database Offerte" view (`gestione`, raw spreadsheet-style editing of the same underlying data) from one file. `wt_offerte` rows carry standard fields plus dynamically-defined extra columns described in `wt_custom_columns` (label/type/order) — treat the offer schema as partially dynamic rather than fixed. `wt_configurazioni` holds grouped bundles/configs of offers. Uses `Sortable.js` for drag-reorder (`ordine` fields) and `jsPDF`/`autotable` for exporting tariff sheets.

### `comuni.js`
Manages the "aree bianche" comuni lookup (`wt_comuni_aree_bianche`), paginated in 1000-row batches on load since Supabase caps single-request rows. Includes a hardcoded `NEARBY` list of comuni near the reference area, and Excel import/export via `xlsx.full.min.js`.

### `manuali.js`
Manages uploadable/browsable internal manual PDFs, organized into categories (`wt_manuali_categorie`) with files/thumbnails in the Supabase Storage `manuali` bucket.

### PWA / offline
`sw.js` is a network-first service worker (always tries network, falls back to cache) caching only the shell (`index.html`, `app.js`, `config.js`, `manifest.json`) under `CACHE_NAME`. Bump `CACHE_NAME` when you need to force-invalidate old installed clients' caches.

### CDN dependencies (loaded in `index.html`, no local copies)
jsPDF + autotable, `@supabase/supabase-js@2`, Sortable.js, pdf.js, pdf-lib, `@pdf-lib/fontkit`, JSZip, SheetJS (`xlsx`), Google Fonts (Orbitron/Rajdhani/Inter). Pin exact versions when bumping any of these — nothing here is version-ranged.
