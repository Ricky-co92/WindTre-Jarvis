(function () {
  var comuni = [];
  var loaded = false;

  var NEARBY = [
    'Terruggia', 'Coniolo', 'Villanova Monferrato', 'Mirabello Monferrato',
    'Occimiano', 'Ozzano Monferrato', 'San Giorgio Monferrato', 'Pontestura',
    'Camino', 'Rosignano Monferrato', 'Balzola', 'Morano sul Po'
  ];

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

  async function loadComuni() {
    try {
      var res = await sb.from('wt_comuni_aree_bianche').select('*').order('comune');
      if (res.error) throw res.error;
      comuni = res.data || [];
      loaded = true;
      renderMeta();
      renderNearby();
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

  function renderNearby() {
    var grid = document.getElementById('cabNearbyGrid');
    grid.innerHTML = NEARBY.map(function (name) {
      var c = findComune(name);
      return '<div class="cab-nearby-chip" data-name="' + escapeHtml(name) + '"><span class="name">' + escapeHtml(name) + '</span><span class="dot ' + (c ? 'yes' : 'no') + '" title="' + (c ? 'In elenco' : 'Non in elenco') + '"></span></div>';
    }).join('');
    grid.querySelectorAll('.cab-nearby-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.getElementById('cabSearchInput').value = chip.dataset.name;
        renderResultCard(chip.dataset.name);
        chip.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    });
  }

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
  });
  if (document.getElementById('view-comuni')) loadComuni();
})();
