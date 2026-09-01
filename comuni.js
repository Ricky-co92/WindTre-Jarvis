(function () {
  var comuni = [];
  var loaded = false;

  var CASALE = { lat: 45.136266, lon: 8.449813 };
  var DEFAULT_RADIUS_KM = 20;

  // Local snapshot (comune, comune_norm, lat, lon) of every comune within 60km of
  // Casale Monferrato, built once from OSM Overpass (see tools/fetch-comuni-vicino-casale.mjs).
  // Needed separately from wt_comuni_aree_bianche because that table only lists
  // comuni that qualify as "aree bianche" -- nearby comuni NOT in that list (already
  // fully covered, so not "white areas") still need to show up here in red.
  var nearbyUniverse = [];
  var nearbyLoaded = false;

  var map = null;
  var markersLayer = null;

  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function haversineKm(lat1, lon1, lat2, lon2) {
    var R = 6371;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1);
    var dLon = toRad(lon2 - lon1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  async function loadNearbyUniverse() {
    try {
      var res = await fetch('data/comuni-vicino-casale.json');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      nearbyUniverse = (data.comuni || []).filter(function (c) { return c.comune_norm !== norm('Casale Monferrato'); });
      nearbyLoaded = true;
      maybeRenderNearby();
    } catch (err) {
      console.error('Errore caricamento comuni vicini:', err);
    }
  }

  async function loadComuni() {
    try {
      var all = [];
      var pageSize = 1000;
      var from = 0;
      while (true) {
        var res = await sb.from('wt_comuni_aree_bianche').select('*').order('comune').range(from, from + pageSize - 1);
        if (res.error) throw res.error;
        var batch = res.data || [];
        all = all.concat(batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      comuni = all;
      loaded = true;
      comuniByNorm = new Map();
      all.forEach(function (c) { if (!comuniByNorm.has(c.comune_norm)) comuniByNorm.set(c.comune_norm, c); });
      renderMeta();
      maybeRenderNearby();
    } catch (err) {
      console.error('Errore caricamento comuni:', err);
      document.getElementById('cabMeta').textContent = 'Errore caricamento dati.';
    }
  }

  function renderMeta() {
    var el = document.getElementById('cabMeta');
    if (!comuni.length) { el.textContent = 'Nessun dato caricato. Usa "Carica file aggiornato" per importare l\'elenco.'; return; }
    var last = comuni.reduce(function (m, c) { return c.updated_at > m ? c.updated_at : m; }, comuni[0].updated_at);
    var d = new Date(last);
    el.textContent = comuni.length + ' comuni in elenco \u2014 ultimo aggiornamento ' + d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  function findComune(name) {
    var n = norm(name);
    return comuni.filter(function (c) { return c.comune_norm === n; })[0] ||
      comuni.filter(function (c) { return c.comune_norm.indexOf(n) === 0; })[0];
  }

  // O(1) exact-match index for the radius list/map redraw, which can run on
  // every 'input' tick while dragging the slider (up to ~440 comuni at 50km) --
  // findComune()'s double linear scan over `comuni` would be too slow there.
  // Falls back to findComune's prefix match for the rare miss (OSM vs Excel
  // naming differences), same as the search box already tolerates.
  var comuniByNorm = null;
  function findComuneFast(name) {
    var n = norm(name);
    var hit = comuniByNorm && comuniByNorm.get(n);
    return hit || findComune(name);
  }

  function renderResultCard(name) {
    var box = document.getElementById('cabSearchResult');
    if (!name.trim()) { box.innerHTML = ''; return; }
    var c = findComune(name);
    if (c) {
      box.innerHTML =
        '<div class="cab-result-card found">' +
        '<div class="cab-result-title">&#10003; ' + escapeHtml(c.comune) + ' &egrave; in elenco</div>' +
        '<div class="cab-result-grid">' +
        '<div><b>' + escapeHtml(c.provincia || '-') + '</b>Provincia</div>' +
        '<div><b>' + escapeHtml(c.regione || '-') + '</b>Regione</div>' +
        '<div><b>Area ' + escapeHtml(c.area != null ? c.area : '-') + '</b>Area</div>' +
        '<div><b>' + (c.ui_ftth != null ? c.ui_ftth : '-') + '</b>UI FTTH W3</div>' +
        '<div><b>' + (c.ui_totali != null ? c.ui_totali : '-') + '</b>UI totali comune</div>' +
        '<div><b>' + escapeHtml(c.codice_istat || '-') + '</b>Codice ISTAT</div>' +
        '</div></div>';
    } else {
      box.innerHTML = '<div class="cab-result-card notfound"><div class="cab-result-title">&#10007; Nessun comune trovato</div>' +
        '<div style="font-size:12.5px;color:#e0a0a0;">"' + escapeHtml(name) + '" non risulta nell\'elenco aree bianche caricato.</div></div>';
    }
  }

  function renderSuggestions(term) {
    var box = document.getElementById('cabSearchResult');
    var n = norm(term);
    if (!n) { box.innerHTML = ''; return; }
    var matches = comuni.filter(function (c) { return c.comune_norm.indexOf(n) > -1; }).slice(0, 8);
    if (!matches.length) { renderResultCard(term); return; }
    if (matches.length === 1 && matches[0].comune_norm === n) { renderResultCard(term); return; }
    box.innerHTML = '<div class="cab-suggest-list">' + matches.map(function (c) {
      return '<div class="cab-suggest-item" data-name="' + escapeHtml(c.comune) + '">' + escapeHtml(c.comune) + ' <span style="color:#557b8c;">(' + escapeHtml(c.provincia || '') + ')</span></div>';
    }).join('') + '</div>';
    box.querySelectorAll('.cab-suggest-item').forEach(function (item) {
      item.addEventListener('click', function () {
        document.getElementById('cabSearchInput').value = item.dataset.name;
        renderResultCard(item.dataset.name);
      });
    });
  }

  document.getElementById('cabSearchInput').addEventListener('input', function () {
    renderSuggestions(this.value);
  });
  document.getElementById('cabSearchInput').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') renderResultCard(this.value);
  });

  function maybeRenderNearby() {
    if (!loaded || !nearbyLoaded) return;
    renderNearby();
  }

  function currentRadiusKm() {
    var slider = document.getElementById('cabRadiusSlider');
    return slider ? parseInt(slider.value, 10) : DEFAULT_RADIUS_KM;
  }

  function computeNearby(radiusKm) {
    return nearbyUniverse
      .map(function (c) {
        return {
          comune: c.comune, comune_norm: c.comune_norm, lat: c.lat, lon: c.lon,
          dist: haversineKm(CASALE.lat, CASALE.lon, c.lat, c.lon)
        };
      })
      .filter(function (c) { return c.dist <= radiusKm; })
      .sort(function (a, b) { return a.dist - b.dist; });
  }

  function renderNearby() {
    var radius = currentRadiusKm();
    var valueEl = document.getElementById('cabRadiusValue');
    if (valueEl) valueEl.textContent = radius + ' km';

    var list = computeNearby(radius);

    var grid = document.getElementById('cabNearbyGrid');
    if (!list.length) {
      grid.innerHTML = '<div style="color:#7fc4dc;font-size:13px;">Nessun comune entro ' + radius + ' km.</div>';
    } else {
      grid.innerHTML = list.map(function (c) {
        var inElenco = findComuneFast(c.comune);
        return '<div class="cab-nearby-chip" data-name="' + escapeHtml(c.comune) + '">' +
          '<span class="name">' + escapeHtml(c.comune) + '</span>' +
          '<span class="right"><span class="dist">' + c.dist.toFixed(1) + ' km</span>' +
          '<span class="dot ' + (inElenco ? 'yes' : 'no') + '" title="' + (inElenco ? 'In elenco' : 'Non in elenco') + '"></span></span>' +
          '</div>';
      }).join('');
      grid.querySelectorAll('.cab-nearby-chip').forEach(function (chip) {
        chip.addEventListener('click', function () {
          document.getElementById('cabSearchInput').value = chip.dataset.name;
          renderResultCard(chip.dataset.name);
          chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      });
    }

    var viewEl = document.getElementById('view-comuni');
    if (viewEl && !viewEl.classList.contains('hidden')) {
      renderMap(list);
    }
  }

  // ================= MAPPA (Leaflet) =================
  function ensureMap() {
    if (map || typeof L === 'undefined') return;
    map = L.map('cabMap', { zoomControl: true }).setView([CASALE.lat, CASALE.lon], 10);
    // Standard OSM raster tiles (free, no API key) with a CSS filter (see
    // #cabMap .leaflet-tile-pane below) faking the dark look -- CARTO's
    // basemaps.cartocdn.com free dark_matter tiles now require an API key
    // and were serving a watermarked "API KEY REQUIRED" placeholder instead
    // of the map.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      subdomains: 'abc',
      maxZoom: 19
    }).addTo(map);
    markersLayer = L.layerGroup().addTo(map);
    var casaleIcon = L.divIcon({ className: 'cab-map-marker', html: '<div class="pin pin-casale"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
    L.marker([CASALE.lat, CASALE.lon], { icon: casaleIcon }).addTo(map)
      .bindPopup('<b>Casale Monferrato</b><br>Punto di riferimento');
  }

  function renderMap(list) {
    ensureMap();
    if (!map || !markersLayer) return;
    markersLayer.clearLayers();
    list.forEach(function (c) {
      var inElenco = findComuneFast(c.comune);
      var cls = inElenco ? 'yes' : 'no';
      var icon = L.divIcon({ className: 'cab-map-marker', html: '<div class="pin pin-' + cls + '"></div>', iconSize: [14, 14], iconAnchor: [7, 7] });
      var popup = '<b>' + escapeHtml(c.comune) + '</b><br>' +
        escapeHtml((inElenco && inElenco.provincia) || '') +
        (inElenco && inElenco.provincia ? '<br>' : '') +
        c.dist.toFixed(1) + ' km da Casale Monferrato';
      if (inElenco) {
        popup += '<br>Area ' + (inElenco.area != null ? inElenco.area : '-') +
          ' &middot; UI FTTH ' + (inElenco.ui_ftth != null ? inElenco.ui_ftth : '-') +
          ' &middot; UI totali ' + (inElenco.ui_totali != null ? inElenco.ui_totali : '-');
      } else {
        popup += '<br><i>Non in elenco aree bianche</i>';
      }
      L.marker([c.lat, c.lon], { icon: icon }).addTo(markersLayer).bindPopup(popup);
    });
    setTimeout(function () { if (map) map.invalidateSize(); }, 30);
  }

  var cabRadiusSliderEl = document.getElementById('cabRadiusSlider');
  var renderNearbyRAF = null;
  function renderNearbyThrottled() {
    if (renderNearbyRAF) return;
    renderNearbyRAF = requestAnimationFrame(function () { renderNearbyRAF = null; renderNearby(); });
  }
  if (cabRadiusSliderEl) cabRadiusSliderEl.addEventListener('input', renderNearbyThrottled);

  // ================= UPLOAD FILE =================
  document.getElementById('cabUploadBtn').addEventListener('click', function () {
    document.getElementById('cabFileInput').click();
  });

  document.getElementById('cabFileInput').addEventListener('change', async function (ev) {
    var file = ev.target.files[0];
    if (!file) return;
    var statusEl = document.getElementById('cabUploadStatus');
    statusEl.textContent = 'Lettura file...';
    statusEl.className = 'status';
    try {
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

      var headerIdx = -1;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].some(function (v) { return String(v || '').trim().toUpperCase() === 'COMUNE'; })) { headerIdx = i; break; }
      }
      if (headerIdx === -1) throw new Error('Intestazione "COMUNE" non trovata nel file.');
      var header = rows[headerIdx].map(function (v) { return String(v || '').trim().toUpperCase(); });
      var colComune = header.indexOf('COMUNE');
      var colIstat = header.indexOf('CODICE ISTAT');
      var colRegione = header.indexOf('REGIONE');
      var colProvincia = header.indexOf('PROVINCIA');
      var colArea = header.indexOf('AREA');
      var colFtth = header.findIndex(function (h) { return h.indexOf('UI FTTH') === 0; });
      var colTot = header.findIndex(function (h) { return h.indexOf('UI TOTALI') === 0; });

      var parsed = [];
      for (var r = headerIdx + 1; r < rows.length; r++) {
        var row = rows[r];
        var comune = row[colComune];
        if (!comune) continue;
        parsed.push({
          comune: String(comune).trim(),
          comune_norm: norm(comune),
          codice_istat: row[colIstat] != null ? String(row[colIstat]) : null,
          regione: row[colRegione] || null,
          provincia: row[colProvincia] || null,
          area: row[colArea] != null ? parseInt(row[colArea], 10) : null,
          ui_ftth: row[colFtth] != null ? parseInt(row[colFtth], 10) : null,
          ui_totali: row[colTot] != null ? parseInt(row[colTot], 10) : null
        });
      }
      if (!parsed.length) throw new Error('Nessun comune trovato nel file.');

      statusEl.textContent = 'Salvataggio di ' + parsed.length + ' comuni...';
      var delRes = await sb.from('wt_comuni_aree_bianche').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      if (delRes.error) throw delRes.error;

      var chunkSize = 500;
      for (var i2 = 0; i2 < parsed.length; i2 += chunkSize) {
        var chunk = parsed.slice(i2, i2 + chunkSize);
        var insRes = await sb.from('wt_comuni_aree_bianche').insert(chunk);
        if (insRes.error) throw insRes.error;
        statusEl.textContent = 'Salvataggio... ' + Math.min(i2 + chunkSize, parsed.length) + '/' + parsed.length;
      }

      statusEl.textContent = 'Importati ' + parsed.length + ' comuni.';
      statusEl.className = 'status ok';
      await loadComuni();
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
    ev.target.value = '';
  });

  // ================= PERMESSI =================
  document.addEventListener('jarvis:permsReady', function () {
    if (typeof PERMS === 'undefined' || !PERMS.ready) return;
    var el = document.getElementById('cabUploadBtn');
    if (el) el.style.display = PERMS.can('comuni', 'upload') ? '' : 'none';
  });

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'comuni') return;
    if (!loaded) loadComuni();
    if (!nearbyLoaded) loadNearbyUniverse();
    // View just became visible: (re)render so the map gets created/resized
    // correctly now that #cabMap has real dimensions (Leaflet can't size
    // itself against a display:none container).
    maybeRenderNearby();
    if (map) setTimeout(function () { map.invalidateSize(); }, 30);
  });
  if (document.getElementById('view-comuni')) { loadComuni(); loadNearbyUniverse(); }
})();
