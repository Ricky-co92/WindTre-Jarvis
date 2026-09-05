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
      var scale = 650 / viewport.width;
      var scaledViewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = scaledViewport.width;
      canvas.height = scaledViewport.height;
      var ctx = canvas.getContext('2d');
      // Canvas starts transparent; compositing onto JPEG (no alpha) turns that black
      // on any PDF without an opaque page background. Paint white first.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
      return await new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob); }, 'image/jpeg', 0.88);
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

  // Se la categoria attuale del documento non è (più) tra quelle configurate (es.
  // cancellata da "Gestisci categorie") la preserva comunque come opzione selezionata
  // invece di far sparire silenziosamente il valore dal select.
  function editCatOptionsHtml(selected) {
    var html = '<option value=""' + (!selected ? ' selected' : '') + '>(nessuna categoria)</option>';
    var found = false;
    html += CATEGORIE.map(function (c) {
      if (c === selected) found = true;
      return '<option value="' + escapeHtml(c) + '"' + (selected === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }).join('');
    if (selected && !found) {
      html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + ' (non più configurata)</option>';
    }
    return html;
  }

  async function loadManuali() {
    try {
      var res = await sb.from('wt_manuali').select('*').order('titolo').order('versione', { ascending: false });
      if (res.error) throw res.error;
      allRows = res.data || [];
      docs = allRows.filter(function (r) { return r.is_latest; });
      populateTargetSelect();
      populateTitoliDatalist();
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

  // "Rubrica" dei titoli già usati: un <datalist> condiviso tra il campo Titolo del
  // nuovo upload e quello della modale Modifica, così rinominando/caricando un file si
  // può selezionare un nome esistente (invece di ridigitarlo a mano, con rischio di
  // refusi che creerebbero una famiglia/gruppo duplicato) oppure digitarne uno nuovo,
  // che semplicemente non troverà corrispondenza nella lista.
  function populateTitoliDatalist() {
    var dl = document.getElementById('mnTitoliList');
    if (!dl) return;
    var titoli = docs.map(function (d) { return d.titolo; }).filter(Boolean);
    titoli = titoli.filter(function (t, i) { return titoli.indexOf(t) === i; }).sort(function (a, b) { return a.localeCompare(b, 'it'); });
    dl.innerHTML = titoli.map(function (t) { return '<option value="' + escapeHtml(t) + '">'; }).join('');
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
      '<button type="button" class="mn-icon-btn mn-edit-btn" data-g="' + d.gruppo_id + '" title="Modifica titolo/date">&#9998;</button>' +
      '<button type="button" class="mn-icon-btn mn-add-hist-btn" data-g="' + d.gruppo_id + '" title="Aggiungi versione storica">&#128193;+</button>' +
      '<button type="button" class="mn-icon-btn mn-del-btn" data-id="' + d.id + '" data-g="' + d.gruppo_id + '" title="Elimina">&#128465;</button>' +
      '</div></div>';
    card.querySelector('.mn-thumb').addEventListener('click', function () { openPreview(d); });
    card.querySelector('.mn-title').addEventListener('click', function () { openPreview(d); });
    var histToggle = card.querySelector('.mn-history-toggle');
    if (histToggle) histToggle.addEventListener('click', function (ev) { ev.stopPropagation(); openHistoryModal(d.gruppo_id, d.titolo); });
    card.querySelector('.mn-edit-btn').addEventListener('click', function (ev) { ev.stopPropagation(); openEditModal(d.gruppo_id); });
    card.querySelector('.mn-add-hist-btn').addEventListener('click', function (ev) { ev.stopPropagation(); openImportHistModal(d.gruppo_id, d.titolo); });
    card.querySelector('.mn-del-btn').addEventListener('click', function (ev) { ev.stopPropagation(); deleteDoc(d.id, d.gruppo_id); });
    return card;
  }

  // Anteprima PDF renderizzata con pdf.js su <canvas>, non un <iframe> puntato
  // all'URL del file: molti browser/WebView mobili non sanno mostrare un PDF
  // incorporato in un iframe e mostrano solo un fallback nativo "apri/scarica"
  // senza anteprima. pdf.js funziona identico su tutti i dispositivi.
  var previewPdf = null;
  var previewPageNum = 1;
  var previewTotalPages = 1;

  async function renderPreviewPage(num) {
    var canvas = document.getElementById('mnPreviewCanvas');
    var page = await previewPdf.getPage(num);
    var body = document.getElementById('mnPreviewBody');
    var maxWidth = body.clientWidth - 24;
    var baseViewport = page.getViewport({ scale: 1 });
    var scale = Math.min(2, maxWidth / baseViewport.width) || 1;
    var viewport = page.getViewport({ scale: scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    document.getElementById('mnPreviewPageInfo').textContent = num + ' / ' + previewTotalPages;
  }

  async function openPreviewUrl(url, title) {
    document.getElementById('mnPreviewTitle').textContent = title;
    document.getElementById('mnPreviewFoot').classList.add('hidden');
    document.getElementById('mnPreviewPageInfo').textContent = 'Caricamento...';
    document.getElementById('mnPreviewBackdrop').classList.remove('hidden');
    try {
      previewPdf = await pdfjsLib.getDocument(url).promise;
      previewTotalPages = previewPdf.numPages;
      previewPageNum = 1;
      await renderPreviewPage(previewPageNum);
      if (previewTotalPages > 1) document.getElementById('mnPreviewFoot').classList.remove('hidden');
    } catch (err) {
      document.getElementById('mnPreviewPageInfo').textContent = '';
      console.error('Errore apertura PDF:', err);
      alert('Impossibile aprire l\'anteprima di questo PDF.');
    }
  }

  function openPreview(d) {
    openPreviewUrl(publicUrl(d.storage_path), d.titolo);
  }
  document.getElementById('mnPreviewPrev').addEventListener('click', function () {
    if (previewPageNum > 1) { previewPageNum--; renderPreviewPage(previewPageNum); }
  });
  document.getElementById('mnPreviewNext').addEventListener('click', function () {
    if (previewPageNum < previewTotalPages) { previewPageNum++; renderPreviewPage(previewPageNum); }
  });
  document.getElementById('mnPreviewClose').addEventListener('click', function () {
    document.getElementById('mnPreviewBackdrop').classList.add('hidden');
    if (previewPdf) { previewPdf.destroy(); previewPdf = null; }
    var canvas = document.getElementById('mnPreviewCanvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
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
        openPreviewUrl(publicUrl(a.dataset.path), a.dataset.title);
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

  var editTargetGruppo = null;

  function openEditModal(gruppoId) {
    editTargetGruppo = gruppoId;
    var groupRows = allRows.filter(function (r) { return r.gruppo_id === gruppoId; })
      .sort(function (a, b) { return new Date(a.uploaded_at) - new Date(b.uploaded_at); });
    if (!groupRows.length) return;

    document.getElementById('mnEditTitle').innerHTML = 'Modifica &mdash; ' + escapeHtml(groupRows[0].titolo);
    document.getElementById('mnEditTitoloInput').value = groupRows[0].titolo;
    document.getElementById('mnEditCategoriaInput').innerHTML = editCatOptionsHtml(groupRows[0].categoria || '');
    document.getElementById('mnEditStatus').textContent = '';

    var listEl = document.getElementById('mnEditVersionsList');
    listEl.innerHTML = groupRows.map(function (r) {
      var dateVal = r.uploaded_at ? new Date(r.uploaded_at).toISOString().slice(0, 10) : '';
      return '<div class="mn-bulk-ver-row" data-id="' + r.id + '">' +
        '<span style="flex:1;">' + escapeHtml(r.file_name) + '</span>' +
        '<input type="date" class="mn-edit-ver-date" data-id="' + r.id + '" data-original="' + dateVal + '" value="' + dateVal + '">' +
        '</div>';
    }).join('');

    document.getElementById('mnEditBackdrop').classList.remove('hidden');
  }
  document.getElementById('mnEditClose').addEventListener('click', function () {
    document.getElementById('mnEditBackdrop').classList.add('hidden');
  });
  document.getElementById('mnEditBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnEditBackdrop') document.getElementById('mnEditClose').click();
  });

  function normalizeTitolo(t) {
    return t.toLowerCase().replace(/[^a-z0-9()]/g, '');
  }

  // Numero di versione e "ultima" non sono mai scritti dall'utente: si ricalcolano
  // sempre dall'ordine cronologico reale delle date, dopo ogni modifica o unione.
  async function recomputeVersionsForGroup(gruppoId) {
    var refreshed = await sb.from('wt_manuali').select('id, uploaded_at').eq('gruppo_id', gruppoId);
    if (refreshed.error) throw refreshed.error;
    var ordered = refreshed.data.sort(function (a, b) { return new Date(a.uploaded_at) - new Date(b.uploaded_at); });
    for (var vi = 0; vi < ordered.length; vi++) {
      var isLatest = vi === ordered.length - 1;
      var vUpd = await sb.from('wt_manuali').update({ versione: vi + 1, is_latest: isLatest }).eq('id', ordered[vi].id);
      if (vUpd.error) throw vUpd.error;
    }
    return ordered.length;
  }

  document.getElementById('mnEditSaveBtn').addEventListener('click', async function () {
    if (!editTargetGruppo) return;
    var statusEl = document.getElementById('mnEditStatus');
    var newTitolo = document.getElementById('mnEditTitoloInput').value.trim();
    var newCategoria = document.getElementById('mnEditCategoriaInput').value || null;
    if (!newTitolo) { statusEl.textContent = 'Il titolo non può essere vuoto.'; statusEl.className = 'status err'; return; }

    // Se il nuovo titolo (normalizzato: senza spazi/maiuscole/punteggiatura) coincide
    // con quello di un'ALTRA famiglia già esistente, i due documenti sono quasi certamente
    // lo stesso file con una convenzione di nome diversa: propongo di unirli in un unico
    // storico invece di lasciare due card duplicate con lo stesso nome.
    var normNew = normalizeTitolo(newTitolo);
    var mergeTarget = docs.find(function (d) {
      return d.gruppo_id !== editTargetGruppo && normalizeTitolo(d.titolo) === normNew;
    });
    var doMerge = false;
    if (mergeTarget) {
      var mergeTargetVersions = allRows.filter(function (r) { return r.gruppo_id === mergeTarget.gruppo_id; }).length;
      doMerge = confirm('Esiste già un documento chiamato "' + mergeTarget.titolo + '" (' + mergeTargetVersions + ' version' + (mergeTargetVersions === 1 ? 'e' : 'i') + ').\n\nVuoi unire questo documento a quello, mettendo tutte le versioni in un unico storico?\n\n(Annulla per rinominare comunque senza unire.)');
    }

    statusEl.textContent = 'Salvataggio...';
    statusEl.className = 'status';
    try {
      if (doMerge) {
        var moveUpd = await sb.from('wt_manuali').update({ gruppo_id: mergeTarget.gruppo_id }).eq('gruppo_id', editTargetGruppo);
        if (moveUpd.error) throw moveUpd.error;
        var mergedTitUpd = await sb.from('wt_manuali').update({ titolo: newTitolo, categoria: newCategoria }).eq('gruppo_id', mergeTarget.gruppo_id);
        if (mergedTitUpd.error) throw mergedTitUpd.error;
        var mergedCount = await recomputeVersionsForGroup(mergeTarget.gruppo_id);
        statusEl.textContent = 'Unito — ' + mergedCount + ' versioni totali.';
      } else {
        var titUpd = await sb.from('wt_manuali').update({ titolo: newTitolo, categoria: newCategoria }).eq('gruppo_id', editTargetGruppo);
        if (titUpd.error) throw titUpd.error;

        var dateInputs = document.querySelectorAll('#mnEditVersionsList .mn-edit-ver-date');
        for (var i = 0; i < dateInputs.length; i++) {
          var inp = dateInputs[i];
          if (inp.value === inp.dataset.original || !inp.value) continue;
          var dUpd = await sb.from('wt_manuali').update({ uploaded_at: new Date(inp.value + 'T12:00:00').toISOString() }).eq('id', inp.dataset.id);
          if (dUpd.error) throw dUpd.error;
        }

        await recomputeVersionsForGroup(editTargetGruppo);
        statusEl.textContent = 'Salvato.';
      }

      statusEl.className = 'status ok';
      await loadManuali();
      document.getElementById('mnEditBackdrop').classList.add('hidden');
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
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
    var canDelete = PERMS.can('manuali', 'delete');
    var isSuperAdmin = !!PERMS.isSuperAdmin;
    document.querySelectorAll('.mn-del-btn').forEach(function (b) { b.style.display = canDelete ? '' : 'none'; });
    // "Aggiungi versione storica" resta riservato al SuperAdmin (come l'import di un
    // manuale e la gestione categorie, vedi renderCatManager).
    document.querySelectorAll('.mn-edit-btn').forEach(function (b) { b.style.display = isSuperAdmin ? '' : 'none'; });
    document.querySelectorAll('.mn-add-hist-btn').forEach(function (b) { b.style.display = isSuperAdmin ? '' : 'none'; });
  }
  document.addEventListener('jarvis:permsReady', applyManualiPerms);

  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'manuali') return;
    loadCategorie();
    loadManuali();
  });

  // ================= GESTIONE CATEGORIE E IMPORT (SuperAdmin) =================
  async function renderCatManager() {
    var isSuperAdmin = typeof PERMS !== 'undefined' && !!PERMS.isSuperAdmin;
    document.getElementById('mnCatManageBtn').classList.toggle('hidden', !isSuperAdmin);
    document.getElementById('mnUploadOpenBtn').classList.toggle('hidden', !isSuperAdmin);
  }
  document.addEventListener('jarvis:permsReady', renderCatManager);

  document.getElementById('mnUploadOpenBtn').addEventListener('click', function () {
    document.getElementById('mnTargetSelect').value = '';
    document.getElementById('mnNewFields').style.display = 'flex';
    document.getElementById('mnTitoloInput').value = '';
    document.getElementById('mnUploadStatus').textContent = '';
    document.getElementById('mnUploadStatus').className = 'status';
    document.getElementById('mnUploadBackdrop').classList.remove('hidden');
  });
  document.getElementById('mnUploadClose').addEventListener('click', function () {
    document.getElementById('mnUploadBackdrop').classList.add('hidden');
  });
  document.getElementById('mnUploadBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'mnUploadBackdrop') document.getElementById('mnUploadClose').click();
  });

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
    wrap.innerHTML = list.map(function (c, i) {
      return '<div class="mn-bulk-ver-row" data-id="' + c.id + '">' +
        '<button type="button" class="mn-icon-btn mn-cat-up" data-id="' + c.id + '" title="Sposta su"' + (i === 0 ? ' disabled style="opacity:.3;"' : '') + '>&#9650;</button>' +
        '<button type="button" class="mn-icon-btn mn-cat-down" data-id="' + c.id + '" title="Sposta giù"' + (i === list.length - 1 ? ' disabled style="opacity:.3;"' : '') + '>&#9660;</button>' +
        '<span class="mn-cat-name" style="flex:1;color:#eafcff;">' + escapeHtml(c.nome) + '</span>' +
        '<button type="button" class="mn-icon-btn mn-cat-rename" data-id="' + c.id + '" title="Rinomina">&#9998;</button>' +
        '<button type="button" class="mn-icon-btn mn-cat-del" data-id="' + c.id + '" title="Elimina">&#128465;</button></div>';
    }).join('') || '<p class="sub">Nessuna categoria.</p>';
    async function moveCategoria(id, direction) {
      var idx = list.findIndex(function (c) { return String(c.id) === String(id); });
      var swapIdx = idx + direction;
      if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
      var a = list[idx], other = list[swapIdx];
      await Promise.all([
        sb.from('wt_manuali_categorie').update({ ordine: other.ordine }).eq('id', a.id),
        sb.from('wt_manuali_categorie').update({ ordine: a.ordine }).eq('id', other.id)
      ]);
      await loadCategorie();
      renderCatList();
    }
    wrap.querySelectorAll('.mn-cat-up').forEach(function (b) {
      b.addEventListener('click', function () { moveCategoria(b.dataset.id, -1); });
    });
    wrap.querySelectorAll('.mn-cat-down').forEach(function (b) {
      b.addEventListener('click', function () { moveCategoria(b.dataset.id, 1); });
    });
    wrap.querySelectorAll('.mn-cat-del').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Eliminare questa categoria? I manuali gi\u00e0 assegnati la manterranno come testo, ma non sar\u00e0 pi\u00f9 selezionabile.')) return;
        await sb.from('wt_manuali_categorie').delete().eq('id', b.dataset.id);
        await loadCategorie();
        renderCatList();
        renderList();
      });
    });
    wrap.querySelectorAll('.mn-cat-rename').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.mn-bulk-ver-row');
        var cat = list.find(function (c) { return String(c.id) === b.dataset.id; });
        var oldNome = cat ? cat.nome : '';
        row.innerHTML =
          '<input type="text" class="cfg-input mn-cat-rename-input" style="flex:1;padding:4px 8px;" value="' + escapeHtml(oldNome) + '">' +
          '<button type="button" class="mn-icon-btn mn-cat-rename-save" title="Salva">&#10003;</button>' +
          '<button type="button" class="mn-icon-btn mn-cat-rename-cancel" title="Annulla">&#10005;</button>';
        var input = row.querySelector('.mn-cat-rename-input');
        input.focus();
        input.select();
        var save = async function () {
          var nuovoNome = input.value.trim();
          if (!nuovoNome) { alert('Il nome non pu\u00f2 essere vuoto.'); return; }
          if (nuovoNome === oldNome) { renderCatList(); return; }
          var upd = await sb.from('wt_manuali_categorie').update({ nome: nuovoNome }).eq('id', b.dataset.id);
          if (upd.error) { alert('Errore: ' + upd.error.message); return; }
          await sb.from('wt_manuali').update({ categoria: nuovoNome }).eq('categoria', oldNome);
          await loadCategorie();
          renderCatList();
          renderList();
        };
        row.querySelector('.mn-cat-rename-save').addEventListener('click', save);
        row.querySelector('.mn-cat-rename-cancel').addEventListener('click', function () { renderCatList(); });
        input.addEventListener('keydown', function (ev) {
          if (ev.key === 'Escape') renderCatList();
          if (ev.key === 'Enter') save();
        });
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

})();
