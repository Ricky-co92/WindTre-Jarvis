(function () {
  var BUCKET = 'manuali';
  var docs = [];      // ultimo doc per gruppo (is_latest)
  var allRows = [];   // tutte le righe (per storico)
  var searchTerm = '';
  var openHistory = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(bytes) {
    if (!bytes) return '';
    return bytes > 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }
  function fmtDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }
  function publicUrl(path) {
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  async function loadManuali() {
    try {
      var res = await sb.from('wt_manuali').select('*').order('titolo').order('versione', { ascending: false });
      if (res.error) throw res.error;
      allRows = res.data || [];
      docs = allRows.filter(function (r) { return r.is_latest; });
      populateTargetSelect();
      renderList();
    } catch (err) {
      console.error('Errore caricamento manuali:', err);
      document.getElementById('mnList').innerHTML = '<p class="sub">Errore caricamento manuali.</p>';
    }
  }

  function populateTargetSelect() {
    var sel = document.getElementById('mnTargetSelect');
    var current = sel.value;
    sel.innerHTML = '<option value="">+ Nuovo documento</option>' +
      docs.map(function (d) { return '<option value="' + d.gruppo_id + '">' + escapeHtml(d.titolo) + ' (v' + d.versione + ')</option>'; }).join('');
    sel.value = current;
  }

  document.getElementById('mnTargetSelect').addEventListener('change', function () {
    var isNew = !this.value;
    document.getElementById('mnNewFields').style.display = isNew ? 'flex' : 'none';
  });

  function filteredDocs() {
    if (!searchTerm) return docs;
    return docs.filter(function (d) {
      return (d.titolo || '').toLowerCase().indexOf(searchTerm) > -1 ||
        (d.categoria || '').toLowerCase().indexOf(searchTerm) > -1;
    });
  }

  document.getElementById('mnSearchInput').addEventListener('input', function () {
    searchTerm = this.value.trim().toLowerCase();
    renderList();
  });

  function renderList() {
    var wrap = document.getElementById('mnList');
    var list = filteredDocs();
    if (!list.length) { wrap.innerHTML = '<p class="sub">Nessun manuale trovato.</p>'; return; }
    wrap.innerHTML = '';
    list.forEach(function (d) {
      var history = allRows.filter(function (r) { return r.gruppo_id === d.gruppo_id && !r.is_latest; });
      var card = document.createElement('div');
      card.className = 'mn-card';
      var isOpen = openHistory === d.gruppo_id;
      card.innerHTML =
        '<div class="mn-card-head">' +
        '<div style="flex:1;min-width:0;">' +
        '<div class="mn-title">' + escapeHtml(d.titolo) + '</div>' +
        '<div style="margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        (d.categoria ? '<span class="mn-cat-tag">' + escapeHtml(d.categoria) + '</span>' : '') +
        '<span class="mn-ver-tag">v' + d.versione + ' &middot; ' + fmtDate(d.uploaded_at) + ' &middot; ' + fmtSize(d.file_size) + '</span>' +
        '</div></div>' +
        '<a class="of-chip of-manage-btn" href="' + publicUrl(d.storage_path) + '" target="_blank" rel="noopener">Apri PDF</a>' +
        (history.length ? '<span class="mn-history-toggle" data-g="' + d.gruppo_id + '">Storico (' + history.length + ')</span>' : '') +
        '<button type="button" class="of-chip of-manage-btn mn-del-btn" data-id="' + d.id + '" data-g="' + d.gruppo_id + '" style="color:#ff6767;border-color:#ff6767;">Elimina</button>' +
        '</div>' +
        '<div class="mn-history-list' + (isOpen ? ' open' : '') + '" id="mnHist-' + d.gruppo_id + '">' +
        history.map(function (h) {
          return '<div class="mn-hist-row"><span>v' + h.versione + '</span><span>' + fmtDate(h.uploaded_at) + '</span><span>' + fmtSize(h.file_size) + '</span><a href="' + publicUrl(h.storage_path) + '" target="_blank" rel="noopener">Apri</a></div>';
        }).join('') +
        '</div>';
      wrap.appendChild(card);
    });
    wrap.querySelectorAll('.mn-history-toggle').forEach(function (t) {
      t.addEventListener('click', function () {
        openHistory = openHistory === t.dataset.g ? null : t.dataset.g;
        renderList();
      });
    });
    wrap.querySelectorAll('.mn-del-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteDoc(btn.dataset.id, btn.dataset.g); });
    });
    applyManualiPerms();
  }

  function applyManualiPerms() {
    if (typeof PERMS === 'undefined' || !PERMS.ready) return;
    var canUpload = PERMS.can('manuali', 'upload');
    var canDelete = PERMS.can('manuali', 'delete');
    var uploadBox = document.getElementById('mnUploadBox');
    if (uploadBox) uploadBox.style.display = canUpload ? 'flex' : 'none';
    document.querySelectorAll('.mn-del-btn').forEach(function (b) { b.style.display = canDelete ? '' : 'none'; });
  }

  async function deleteDoc(id, gruppoId) {
    if (!confirm('Eliminare definitivamente questo documento e tutto il suo storico versioni?')) return;
    try {
      var groupRows = allRows.filter(function (r) { return r.gruppo_id === gruppoId; });
      var paths = groupRows.map(function (r) { return r.storage_path; });
      if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      var res = await sb.from('wt_manuali').delete().eq('gruppo_id', gruppoId);
      if (res.error) throw res.error;
      await loadManuali();
    } catch (err) {
      alert('Errore eliminazione: ' + err.message);
    }
  }

  // ================= UPLOAD =================
  document.getElementById('mnUploadTriggerBtn').addEventListener('click', function () {
    document.getElementById('mnFileInput').click();
  });

  document.getElementById('mnFileInput').addEventListener('change', async function (ev) {
    var file = ev.target.files[0];
    if (!file) return;
    var statusEl = document.getElementById('mnUploadStatus');
    var targetGruppo = document.getElementById('mnTargetSelect').value;
    var titolo, categoria, versione, gruppoId;

    if (targetGruppo) {
      var current = docs.filter(function (d) { return d.gruppo_id === targetGruppo; })[0];
      if (!current) { statusEl.textContent = 'Documento non trovato.'; statusEl.className = 'status err'; return; }
      titolo = current.titolo;
      categoria = current.categoria;
      versione = current.versione + 1;
      gruppoId = current.gruppo_id;
    } else {
      titolo = document.getElementById('mnTitoloInput').value.trim();
      categoria = document.getElementById('mnCategoriaInput').value.trim();
      if (!titolo) { statusEl.textContent = 'Inserisci un titolo per il nuovo documento.'; statusEl.className = 'status err'; ev.target.value = ''; return; }
      versione = 1;
      gruppoId = crypto.randomUUID();
    }

    statusEl.textContent = 'Caricamento in corso...';
    statusEl.className = 'status';
    try {
      var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      var path = gruppoId + '/v' + versione + '-' + safeName;
      var upRes = await sb.storage.from(BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
      if (upRes.error) throw upRes.error;

      if (targetGruppo) {
        var updRes = await sb.from('wt_manuali').update({ is_latest: false }).eq('gruppo_id', gruppoId).eq('is_latest', true);
        if (updRes.error) throw updRes.error;
      }

      var insRes = await sb.from('wt_manuali').insert({
        gruppo_id: gruppoId, titolo: titolo, categoria: categoria || null,
        versione: versione, storage_path: path, file_name: file.name,
        file_size: file.size, is_latest: true
      });
      if (insRes.error) throw insRes.error;

      statusEl.textContent = 'Caricato: ' + titolo + ' (v' + versione + ')';
      statusEl.className = 'status ok';
      document.getElementById('mnTitoloInput').value = '';
      document.getElementById('mnCategoriaInput').value = '';
      document.getElementById('mnTargetSelect').value = '';
      document.getElementById('mnNewFields').style.display = 'flex';
      await loadManuali();
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
    ev.target.value = '';
  });

  // ================= PERMESSI =================
  document.addEventListener('jarvis:permsReady', applyManualiPerms);

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'manuali') return;
    loadManuali();
  });
})();
