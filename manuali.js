(function () {
  var BUCKET = 'manuali';
  var docs = [];
  var allRows = [];
  var searchTerm = '';
  var CATEGORIE = [];
  var closedCats = { 'Manuali': true, 'Sintesi Offerte': true, 'Guide': true };
  var histTargetGruppo = null;

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
    if (!path) return '';
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  async function generateThumb(file) {
    try {
      var buf = await file.arrayBuffer();
      var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      var page = await pdf.getPage(1);
      var viewport = page.getViewport({ scale: 1 });
      var scale = 300 / viewport.width;
      var scaledViewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: scaledViewport }).promise;
      return await new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.75);
      });
    } catch (err) {
      console.warn('Miniatura non generata:', err);
      return null;
    }
  }
  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  async function loadCategorie() {
    try {
      var res = await sb.from('wt_manuali_categorie').select('*').order('ordine');
      if (res.error) throw res.error;
      CATEGORIE = (res.data || []).map(function (r) { return r.nome; });
    } catch (err) {
      console.error('Errore caricamento categorie:', err);
      CATEGORIE = [];
    }
    populateCategorySelects();
  }

  function populateCategorySelects() {
    var mainSel = document.getElementById('mnCategoriaInput');
    if (mainSel) {
      var cur = mainSel.value;
      mainSel.innerHTML = CATEGORIE.map(function (c) { return '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>'; }).join('');
      if (CATEGORIE.indexOf(cur) > -1) mainSel.value = cur;
    }
  }

  function bulkCatOptionsHtml(selected) {
    return '<option value=""' + (!selected ? ' selected' : '') + '>(scegli categoria)</option>' +
      CATEGORIE.map(function (c) { return '<option value="' + escapeHtml(c) + '"' + (selected === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>'; }).join('');
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
    document.getElementById('mnNewFields').style.display = this.value ? 'none' : 'flex';
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

    var byCat = {};
    list.forEach(function (d) {
      var cat = d.categoria || 'Senza categoria';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(d);
    });
    var catOrder = CATEGORIE.filter(function (c) { return byCat[c]; })
      .concat(Object.keys(byCat).filter(function (c) { return CATEGORIE.indexOf(c) === -1; }));

    catOrder.forEach(function (cat) {
      var isClosed = closedCats[cat] !== false;
      var section = document.createElement('div');
      section.className = 'mn-cat-section';
      var head = document.createElement('div');
      head.className = 'mn-cat-head' + (isClosed ? ' closed' : '');
      head.innerHTML = '<span class="arrow">&#9662;</span><span class="mn-cat-head-title">' + escapeHtml(cat) + '</span><span class="mn-cat-count">' + byCat[cat].length + '</span>';
      head.addEventListener('click', function () {
        closedCats[cat] = !isClosed;
        renderList();
      });
      section.appendChild(head);
      var body = document.createElement('div');
      body.className = 'mn-cat-body' + (isClosed ? ' closed' : '');
      var grid = document.createElement('div');
      grid.className = 'mn-grid';
      byCat[cat].forEach(function (d) { grid.appendChild(buildDocCard(d)); });
      body.appendChild(grid);
      section.appendChild(body);
      wrap.appendChild(section);
    });
    applyManualiPerms();
  }

  function buildDocCard(d) {
    var history = allRows.filter(function (r) { return r.gruppo_id === d.gruppo_id && !r.is_latest; });
    var card = document.createElement('div');
    card.className = 'mn-card';
    card.innerHTML =
      '<div class="mn-thumb">' + (d.thumb_path ? '<img src="' + publicUrl(d.thumb_path) + '" alt="">' : '<div class="mn-thumb-fallback">PDF</div>') + '</div>' +
      '<div class="mn-card-info">' +
      '<div class="mn-title">' + escapeHtml(d.titolo) + '</div>' +
      '<div class="mn-ver-tag">v' + d.versione + ' &middot; ' + fmtDate(d.uploaded_at) + '</div>' +
      '<div class="mn-card-actions">' +
      (history.length ? '<span class="mn-history-toggle" data-g="' + d.gruppo_id + '">Storico (' + history.length + ')</span>' : '<span></span>') +
      '<button type="button" class="mn-icon-btn mn-add-hist-btn" data-g="' + d.gruppo_id + '" title="Aggiungi versione storica">&#128193;+</button>' +
      '<button type="button" class="mn-icon-btn mn-del-btn" data-id="' + d.id + '" data-g="' + d.gruppo_id + '" title="Elimina">&#128465;</button>' +
      '</div></div>';
    card.querySelector('.mn-thumb').addEventListener('click', function () { openPreview(d); });
    card.querySelector('.mn-title').addEventListener('click', function () { openPreview(d); });
    var histToggle = card.querySelector('.mn-history-toggle');
    if (histToggle) histToggle.addEventListener('click', function (ev) { ev.stopPropagation(); openHistoryModal(d.gruppo_id, d.titolo); });
    card.querySelector('.mn-add-hist-btn').addEventListener('click', function (ev) { ev.stopPropagation(); openImportHistModal(d.gruppo_id, d.titolo); });
    card.querySelector('.mn-del-btn').addEventListener('click', function (ev) { ev.stopPropagation(); deleteDoc(d.id, d.gruppo_id); });
    return card;
  }

  function openPreview(d) {
    document.getElementById('mnPreviewTitle').textContent = d.titolo;
    document.getElementById('mnPreviewFrame').src = publicUrl(d.storage_path) + '#toolbar=1';
    document.getElementById('mnPreviewBackdrop').classList.remove('hidden');
  }
  document.getElementById('mnPreviewClose').addEventListener('click', function () {
    document.getElementById('mnPreviewBackdrop').classList.add('hidden');
    document.getElementById('mnPreviewFrame').src = '';
  });
  document.getElementById('mnPreviewBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnPreviewBackdrop') document.getElementById('mnPreviewClose').click();
  });

  function openHistoryModal(gruppoId, titolo) {
    var history = allRows.filter(function (r) { return r.gruppo_id === gruppoId && !r.is_latest; })
      .sort(function (a, b) { return b.versione - a.versione; });
    document.getElementById('mnHistTitle').innerHTML = 'Storico &mdash; ' + escapeHtml(titolo);
    document.getElementById('mnHistBody').innerHTML = history.map(function (h) {
      return '<div class="mn-hist-row"><span>v' + h.versione + '</span><span>' + fmtDate(h.uploaded_at) + '</span><span>' + fmtSize(h.file_size) + '</span><a href="#" class="mn-hist-open" data-path="' + escapeHtml(h.storage_path) + '" data-title="' + escapeHtml(titolo) + ' v' + h.versione + '">Apri anteprima</a></div>';
    }).join('') || '<p class="sub">Nessuna versione precedente.</p>';
    document.getElementById('mnHistBody').querySelectorAll('.mn-hist-open').forEach(function (a) {
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        document.getElementById('mnHistBackdrop').classList.add('hidden');
        document.getElementById('mnPreviewTitle').textContent = a.dataset.title;
        document.getElementById('mnPreviewFrame').src = publicUrl(a.dataset.path) + '#toolbar=1';
        document.getElementById('mnPreviewBackdrop').classList.remove('hidden');
      });
    });
    document.getElementById('mnHistBackdrop').classList.remove('hidden');
  }
  document.getElementById('mnHistClose').addEventListener('click', function () {
    document.getElementById('mnHistBackdrop').classList.add('hidden');
  });
  document.getElementById('mnHistBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnHistBackdrop') document.getElementById('mnHistClose').click();
  });

  async function deleteDoc(id, gruppoId) {
    if (!confirm('Eliminare definitivamente questo documento e tutto il suo storico versioni?')) return;
    try {
      var groupRows = allRows.filter(function (r) { return r.gruppo_id === gruppoId; });
      var paths = [];
      groupRows.forEach(function (r) { paths.push(r.storage_path); if (r.thumb_path) paths.push(r.thumb_path); });
      if (paths.length) await sb.storage.from(BUCKET).remove(paths);
      var res = await sb.from('wt_manuali').delete().eq('gruppo_id', gruppoId);
      if (res.error) throw res.error;
      await loadManuali();
    } catch (err) {
      alert('Errore eliminazione: ' + err.message);
    }
  }

  async function uploadOne(file, opts, forcedFileName) {
    var fileName = forcedFileName || file.name;
    var safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    var path = opts.gruppoId + '/v' + opts.versione + '-' + safeName;
    var upRes = await sb.storage.from(BUCKET).upload(path, file, { contentType: 'application/pdf', upsert: false });
    if (upRes.error) throw upRes.error;

    var thumbPath = null;
    if (!opts.skipThumb) {
      var thumbBlob = await generateThumb(file);
      if (thumbBlob) {
        thumbPath = opts.gruppoId + '/thumb-v' + opts.versione + '.jpg';
        var thumbUp = await sb.storage.from(BUCKET).upload(thumbPath, thumbBlob, { contentType: 'image/jpeg', upsert: true });
        if (thumbUp.error) { console.warn('Thumb upload fallita:', thumbUp.error); thumbPath = null; }
      }
    }

    var insRes = await sb.from('wt_manuali').insert({
      gruppo_id: opts.gruppoId, titolo: opts.titolo, categoria: opts.categoria || null,
      versione: opts.versione, storage_path: path, file_name: fileName,
      file_size: file.size, is_latest: opts.isLatest, thumb_path: thumbPath,
      uploaded_at: opts.uploadedAt || new Date().toISOString()
    });
    if (insRes.error) throw insRes.error;
  }

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
      if (!current) { statusEl.textContent = 'Documento non trovato.'; statusEl.className = 'status err'; ev.target.value = ''; return; }
      titolo = current.titolo; categoria = current.categoria; versione = current.versione + 1; gruppoId = current.gruppo_id;
    } else {
      titolo = document.getElementById('mnTitoloInput').value.trim();
      categoria = document.getElementById('mnCategoriaInput').value;
      if (!titolo) { statusEl.textContent = 'Inserisci un titolo per il nuovo documento.'; statusEl.className = 'status err'; ev.target.value = ''; return; }
      versione = 1; gruppoId = crypto.randomUUID();
    }

    statusEl.textContent = 'Caricamento in corso...';
    statusEl.className = 'status';
    try {
      if (targetGruppo) {
        var updRes = await sb.from('wt_manuali').update({ is_latest: false }).eq('gruppo_id', gruppoId).eq('is_latest', true);
        if (updRes.error) throw updRes.error;
      }
      await uploadOne(file, { gruppoId: gruppoId, titolo: titolo, categoria: categoria, versione: versione, isLatest: true });
      statusEl.textContent = 'Caricato: ' + titolo + ' (v' + versione + ')';
      statusEl.className = 'status ok';
      document.getElementById('mnTitoloInput').value = '';
      document.getElementById('mnTargetSelect').value = '';
      document.getElementById('mnNewFields').style.display = 'flex';
      await loadManuali();
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
    ev.target.value = '';
  });

  function openImportHistModal(gruppoId, titolo) {
    histTargetGruppo = gruppoId;
    document.getElementById('mnImportTitle').innerHTML = 'Importa storico &mdash; ' + escapeHtml(titolo);
    document.getElementById('mnImportDate').value = '';
    document.getElementById('mnImportFiles').value = '';
    document.getElementById('mnImportStatus').textContent = '';
    document.getElementById('mnImportBackdrop').classList.remove('hidden');
  }
  document.getElementById('mnImportClose').addEventListener('click', function () {
    document.getElementById('mnImportBackdrop').classList.add('hidden');
  });
  document.getElementById('mnImportBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnImportBackdrop') document.getElementById('mnImportClose').click();
  });

  document.getElementById('mnImportGoBtn').addEventListener('click', async function () {
    var files = document.getElementById('mnImportFiles').files;
    var statusEl = document.getElementById('mnImportStatus');
    if (!files.length) { statusEl.textContent = 'Seleziona almeno un file PDF.'; statusEl.className = 'status err'; return; }
    var dateVal = document.getElementById('mnImportDate').value;
    var uploadedAt = dateVal ? new Date(dateVal + 'T12:00:00').toISOString() : null;
    var current = allRows.filter(function (r) { return r.gruppo_id === histTargetGruppo && r.is_latest; })[0];
    var groupRows = allRows.filter(function (r) { return r.gruppo_id === histTargetGruppo; });
    var nextVer = groupRows.length ? Math.max.apply(null, groupRows.map(function (r) { return r.versione; })) : 0;

    for (var i = 0; i < files.length; i++) {
      statusEl.textContent = 'Caricamento ' + (i + 1) + '/' + files.length + '...';
      statusEl.className = 'status';
      try {
        nextVer += 1;
        await uploadOne(files[i], {
          gruppoId: histTargetGruppo, titolo: current.titolo, categoria: current.categoria,
          versione: nextVer, isLatest: false, uploadedAt: uploadedAt
        });
      } catch (err) {
        statusEl.textContent = 'Errore su file ' + (i + 1) + ': ' + err.message;
        statusEl.className = 'status err';
        return;
      }
    }
    statusEl.textContent = files.length + ' file importati nello storico.';
    statusEl.className = 'status ok';
    await loadManuali();
  });

  function applyManualiPerms() {
    if (typeof PERMS === 'undefined' || !PERMS.ready) return;
    var canUpload = PERMS.can('manuali', 'upload');
    var canDelete = PERMS.can('manuali', 'delete');
    var uploadBox = document.getElementById('mnUploadBox');
    if (uploadBox) uploadBox.style.display = canUpload ? 'flex' : 'none';
    document.querySelectorAll('.mn-del-btn').forEach(function (b) { b.style.display = canDelete ? '' : 'none'; });
    document.querySelectorAll('.mn-add-hist-btn').forEach(function (b) { b.style.display = canUpload ? '' : 'none'; });
    var bulkBtn = document.getElementById('mnBulkOpenBtn');
    if (bulkBtn) bulkBtn.style.display = canUpload ? '' : 'none';
  }
  document.addEventListener('jarvis:permsReady', applyManualiPerms);

  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'manuali') return;
    loadCategorie();
    loadManuali();
  });

  // ================= GESTIONE CATEGORIE (SuperAdmin) =================
  async function renderCatManager() {
    if (typeof PERMS === 'undefined' || !PERMS.isSuperAdmin) {
      var btn = document.getElementById('mnCatManageBtn');
      if (btn) btn.classList.add('hidden');
      return;
    }
    document.getElementById('mnCatManageBtn').classList.remove('hidden');
  }
  document.addEventListener('jarvis:permsReady', renderCatManager);

  document.getElementById('mnCatManageBtn').addEventListener('click', function () {
    renderCatList();
    document.getElementById('mnCatBackdrop').classList.remove('hidden');
  });
  document.getElementById('mnCatClose').addEventListener('click', function () {
    document.getElementById('mnCatBackdrop').classList.add('hidden');
  });
  document.getElementById('mnCatBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnCatBackdrop') document.getElementById('mnCatClose').click();
  });

  async function renderCatList() {
    var res = await sb.from('wt_manuali_categorie').select('*').order('ordine');
    var list = res.data || [];
    var wrap = document.getElementById('mnCatList');
    wrap.innerHTML = list.map(function (c) {
      return '<div class="mn-bulk-ver-row" data-id="' + c.id + '"><span style="flex:1;color:#eafcff;">' + escapeHtml(c.nome) + '</span>' +
        '<button type="button" class="mn-icon-btn mn-cat-del" data-id="' + c.id + '" title="Elimina">&#128465;</button></div>';
    }).join('') || '<p class="sub">Nessuna categoria.</p>';
    wrap.querySelectorAll('.mn-cat-del').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Eliminare questa categoria? I manuali gi\u00e0 assegnati la manterranno come testo, ma non sar\u00e0 pi\u00f9 selezionabile.')) return;
        await sb.from('wt_manuali_categorie').delete().eq('id', b.dataset.id);
        await loadCategorie();
        renderCatList();
        renderList();
      });
    });
  }

  document.getElementById('mnCatAddBtn').addEventListener('click', async function () {
    var input = document.getElementById('mnCatNewInput');
    var nome = input.value.trim();
    if (!nome) return;
    var res = await sb.from('wt_manuali_categorie').select('ordine').order('ordine', { ascending: false }).limit(1);
    var nextOrdine = (res.data && res.data[0] ? res.data[0].ordine : 0) + 10;
    var ins = await sb.from('wt_manuali_categorie').insert({ nome: nome, ordine: nextOrdine });
    if (ins.error) { alert('Errore: ' + ins.error.message); return; }
    input.value = '';
    await loadCategorie();
    renderCatList();
  });

  // ================= IMPORT MASSIVO DA ZIP =================
  var MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
  var SEASON_MONTH = { estate: 5, summer: 5, inverno: 11, winter: 11, primavera: 2, spring: 2, autunno: 8, autumn: 8 };
  var monthsRe = MONTHS_IT.join('|');

  function parseDateFromText(text) {
    if (!text) return null;
    var iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) { var d1 = new Date(+iso[1], +iso[2] - 1, +iso[3]); if (!isNaN(d1)) return d1; }
    var re = new RegExp('(\\d{1,2})\\s*[\\+\\-_ ]?\\s*(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*(\\d{2,4})', 'i');
    var m = text.toLowerCase().match(re);
    if (m) {
      var day = parseInt(m[1], 10);
      var month = MONTHS_IT.indexOf(m[2].toLowerCase());
      var year = parseInt(m[3], 10);
      if (year < 100) year += 2000;
      var d2 = new Date(year, month, day);
      if (!isNaN(d2) && day >= 1 && day <= 31) return d2;
    }
    var reMY = new RegExp('(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*(\\d{2,4})', 'i');
    var m2 = text.toLowerCase().match(reMY);
    if (m2) {
      var month2 = MONTHS_IT.indexOf(m2[1].toLowerCase());
      var year2 = parseInt(m2[2], 10);
      if (year2 < 100) year2 += 2000;
      return new Date(year2, month2, 1);
    }
    var seasonRe = new RegExp('(' + Object.keys(SEASON_MONTH).join('|') + ')\\s*[\\+\\-_ ]?\\s*(\\d{4})', 'i');
    var m3 = text.toLowerCase().match(seasonRe);
    if (m3) return new Date(parseInt(m3[2], 10), SEASON_MONTH[m3[1].toLowerCase()], 1);
    var yOnly = text.match(/\b(20\d{2})\b/);
    if (yOnly) return new Date(parseInt(yOnly[1], 10), 0, 1);
    return null;
  }

  function familyKeyFromFilename(nameNoExt) {
    var re = new RegExp('\\d{1,2}\\s*[\\+\\-_ ]?\\s*(' + monthsRe + ')\\s*[\\+\\-_ ]?\\s*\\d{2,4}', 'gi');
    var stripped = nameNoExt
      .replace(/\(\d+\)/g, '')
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(re, '')
      .replace(/[_\-\+]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return stripped.toLowerCase() || nameNoExt.toLowerCase();
  }

  function titleize(key) {
    return key.split(' ').filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  function guessCategoria(nameNoExt) {
    var n = nameNoExt.toLowerCase();
    if (n.indexOf('manuale') > -1) return 'Manuali';
    if (n.indexOf('sintesi') > -1) return 'Sintesi Offerte';
    if (n.indexOf('canvass') > -1) return 'Canvass';
    if (n.indexOf('guid') > -1 || n.indexOf('selling') > -1) return 'Guide';
    return '';
  }

  async function sha256Hex(buf) {
    var hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.prototype.map.call(new Uint8Array(hash), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  var bulkFamilies = null; // { key: { titolo, categoria, versions:[{file, buf, path, date, dateGuessConfident}] } }

  document.getElementById('mnBulkOpenBtn').addEventListener('click', function () {
    document.getElementById('mnBulkFiles').value = '';
    document.getElementById('mnBulkReview').innerHTML = '';
    document.getElementById('mnBulkSkipped').innerHTML = '';
    document.getElementById('mnBulkAnalyzeStatus').textContent = '';
    document.getElementById('mnBulkConfirmBtn').classList.add('hidden');
    document.getElementById('mnBulkImportStatus').textContent = '';
    bulkFamilies = null;
    document.getElementById('mnBulkBackdrop').classList.remove('hidden');
  });
  document.getElementById('mnBulkClose').addEventListener('click', function () {
    document.getElementById('mnBulkBackdrop').classList.add('hidden');
  });
  document.getElementById('mnBulkBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnBulkBackdrop') document.getElementById('mnBulkClose').click();
  });

  document.getElementById('mnBulkAnalyzeBtn').addEventListener('click', async function () {
    var fileList = document.getElementById('mnBulkFiles').files;
    var statusEl = document.getElementById('mnBulkAnalyzeStatus');
    if (!fileList.length) { statusEl.textContent = 'Seleziona almeno un file .zip.'; statusEl.className = 'status err'; return; }

    var families = {};
    var seenHashes = {};
    var skippedNonPdf = [];
    var skippedDupes = 0;

    for (var zi = 0; zi < fileList.length; zi++) {
      statusEl.textContent = 'Apro ' + fileList[zi].name + ' (' + (zi + 1) + '/' + fileList.length + ')...';
      statusEl.className = 'status';
      var zip = await JSZip.loadAsync(fileList[zi]);
      var entries = Object.keys(zip.files).filter(function (n) { return !zip.files[n].dir; });
      for (var ei = 0; ei < entries.length; ei++) {
        var path = entries[ei];
        var lower = path.toLowerCase();
        if (lower.endsWith('/')) continue;
        if (!lower.endsWith('.pdf')) {
          if (!/\.(pdf)$/.test(lower)) skippedNonPdf.push(path);
          continue;
        }
        statusEl.textContent = 'Leggo ' + path + '...';
        var buf = await zip.files[path].async('arraybuffer');
        var hash = await sha256Hex(buf);
        if (seenHashes[hash]) { skippedDupes++; continue; }
        seenHashes[hash] = true;

        var parts = path.split('/');
        var fileName = parts[parts.length - 1];
        var nameNoExt = fileName.replace(/\.pdf$/i, '');
        var key = familyKeyFromFilename(nameNoExt);
        var dateFromName = parseDateFromText(nameNoExt);
        var dateFromPath = dateFromName || parseDateFromText(parts.slice(0, -1).join(' '));
        var confident = !!dateFromName;
        var finalDate = dateFromPath || new Date();

        if (!families[key]) {
          families[key] = { titolo: titleize(key), categoria: guessCategoria(nameNoExt), versions: [] };
        }
        families[key].versions.push({ fileName: fileName, buf: buf, date: finalDate, confident: confident, sourcePath: path });
      }
    }

    Object.keys(families).forEach(function (k) {
      families[k].versions.sort(function (a, b) { return a.date - b.date; });
    });

    bulkFamilies = families;
    statusEl.textContent = Object.keys(families).length + ' documenti rilevati, ' +
      Object.values(families).reduce(function (s, f) { return s + f.versions.length; }, 0) + ' versioni totali (' +
      skippedDupes + ' duplicati esatti scartati).';
    statusEl.className = 'status ok';

    document.getElementById('mnBulkSkipped').innerHTML = skippedNonPdf.length
      ? '<p class="sub">' + skippedNonPdf.length + ' file non-PDF ignorati (non importati).</p>' : '';

    renderBulkReview();
    document.getElementById('mnBulkConfirmBtn').classList.remove('hidden');
  });

  function renderBulkReview() {
    var wrap = document.getElementById('mnBulkReview');
    wrap.innerHTML = '';
    var keys = Object.keys(bulkFamilies).sort();
    keys.forEach(function (key) {
      var fam = bulkFamilies[key];
      var card = document.createElement('div');
      card.className = 'mn-bulk-fam';
      var lowConfCount = fam.versions.filter(function (v) { return !v.confident; }).length;
      card.innerHTML =
        '<div class="mn-bulk-fam-head">' +
        '<input type="text" class="cfg-input mn-bulk-titolo" value="' + escapeHtml(fam.titolo) + '">' +
        '<select class="cfg-input mn-bulk-cat">' + bulkCatOptionsHtml(fam.categoria) + '</select>' +
        '<label style="font-size:12px;color:#7fc4dc;display:flex;align-items:center;gap:5px;"><input type="checkbox" class="mn-bulk-include" checked> Includi</label>' +
        '<span class="mn-bulk-toggle-versions">' + fam.versions.length + ' versioni' + (lowConfCount ? ' &mdash; <span class="mn-bulk-flag">' + lowConfCount + ' con data incerta</span>' : '') + '</span>' +
        '</div>' +
        '<div class="mn-bulk-versions">' +
        fam.versions.map(function (v, vi) {
          return '<div class="mn-bulk-ver-row"><input type="checkbox" class="mn-bulk-ver-include" checked data-vi="' + vi + '">' +
            '<span style="flex:1;">' + escapeHtml(v.fileName) + '</span>' +
            '<input type="date" class="mn-bulk-ver-date" data-vi="' + vi + '" value="' + v.date.toISOString().slice(0, 10) + '">' +
            (v.confident ? '' : '<span class="mn-bulk-flag" title="Data dedotta dalla cartella, verifica">?</span>') +
            '</div>';
        }).join('') +
        '</div>';

      card.querySelector('.mn-bulk-titolo').addEventListener('input', function () { fam.titolo = this.value; });
      card.querySelector('.mn-bulk-cat').addEventListener('change', function () { fam.categoria = this.value; });
      card.querySelector('.mn-bulk-include').addEventListener('change', function () {
        card.style.opacity = this.checked ? '' : '.4';
        fam._excluded = !this.checked;
      });
      card.querySelector('.mn-bulk-toggle-versions').addEventListener('click', function () {
        card.querySelector('.mn-bulk-versions').classList.toggle('open');
      });
      card.querySelectorAll('.mn-bulk-ver-date').forEach(function (inp) {
        inp.addEventListener('change', function () {
          fam.versions[+this.dataset.vi].date = new Date(this.value + 'T12:00:00');
        });
      });
      card.querySelectorAll('.mn-bulk-ver-include').forEach(function (chk) {
        chk.addEventListener('change', function () { fam.versions[+this.dataset.vi]._excluded = !this.checked; });
      });

      wrap.appendChild(card);
    });
  }

  document.getElementById('mnBulkConfirmBtn').addEventListener('click', async function () {
    if (!bulkFamilies) return;
    var statusEl = document.getElementById('mnBulkImportStatus');
    var keys = Object.keys(bulkFamilies).filter(function (k) { return !bulkFamilies[k]._excluded; });
    var totalVersions = keys.reduce(function (s, k) { return s + bulkFamilies[k].versions.filter(function (v) { return !v._excluded; }).length; }, 0);
    var done = 0;

    for (var ki = 0; ki < keys.length; ki++) {
      var fam = bulkFamilies[keys[ki]];
      var versions = fam.versions.filter(function (v) { return !v._excluded; }).sort(function (a, b) { return a.date - b.date; });
      if (!versions.length) continue;
      var gruppoId = crypto.randomUUID();
      for (var vi = 0; vi < versions.length; vi++) {
        var v = versions[vi];
        var isLatest = vi === versions.length - 1;
        done++;
        statusEl.textContent = 'Import ' + done + '/' + totalVersions + ': ' + fam.titolo + ' (' + v.fileName + ')';
        statusEl.className = 'status';
        try {
          var blob = new Blob([v.buf], { type: 'application/pdf' });
          blob.name = v.fileName;
          await uploadOne(blob, {
            gruppoId: gruppoId, titolo: fam.titolo, categoria: fam.categoria || null,
            versione: vi + 1, isLatest: isLatest, uploadedAt: v.date.toISOString(),
            skipThumb: !isLatest
          }, v.fileName);
        } catch (err) {
          statusEl.textContent = 'Errore su ' + v.fileName + ': ' + err.message;
          statusEl.className = 'status err';
          return;
        }
      }
    }
    statusEl.textContent = 'Import completato: ' + totalVersions + ' file caricati.';
    statusEl.className = 'status ok';
    await loadManuali();
  });
})();
