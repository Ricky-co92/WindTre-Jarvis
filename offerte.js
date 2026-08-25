(function () {
  var offerte = [];
  var activeCatFilters = [];   // es. ['consumer','business'] o []
  var activeTipoFilters = [];  // es. ['mobile','fisso'] o []
  var activeBadgeFilters = []; // es. ['Opzione aggiuntiva'] o []
  var activeOpzioneOnly = false;
  var selectedIds = {};        // { id: true }
  var customColumns = [];      // [{id, key, label, ordine}]

  // ================= COLONNE PERSONALIZZATE =================
  async function loadCustomColumns() {
    try {
      var { data, error } = await sb.from('wt_custom_columns').select('*').order('ordine');
      if (error) throw error;
      customColumns = data || [];
    } catch (err) {
      console.error('Errore caricamento colonne personalizzate:', err);
      customColumns = [];
    }
  }

  function slugify(label) {
    return label.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || ('col_' + Date.now());
  }

  document.getElementById('gdAddColumn').addEventListener('click', async function () {
    var label = prompt('Nome della nuova colonna (es. "Sconto attivatore", "Codice interno"):');
    if (!label || !label.trim()) return;
    var key = slugify(label.trim());
    if (customColumns.some(function (c) { return c.key === key; })) {
      alert('Esiste gi\u00e0 una colonna con questo nome.');
      return;
    }
    var ordine = customColumns.length;
    try {
      var { error } = await sb.from('wt_custom_columns').insert({ key: key, label: label.trim(), ordine: ordine });
      if (error) throw error;
      await loadCustomColumns();
      renderGestioneHeader();
      renderGestioneTable();
    } catch (err) {
      alert('Errore nella creazione della colonna: ' + err.message);
    }
  });

  function renderGestioneHeader() {
    var headerRow = document.getElementById('gdHeaderRow');
    var headerEnd = document.getElementById('gdHeaderEnd');
    if (!headerRow || !headerEnd) return;
    headerRow.querySelectorAll('.gd-custom-col').forEach(function (th) { th.remove(); });
    customColumns.forEach(function (col) {
      var th = document.createElement('th');
      th.className = 'gd-custom-col';
      th.innerHTML = escapeHtml(col.label) + '<button type="button" class="gd-col-remove" title="Elimina colonna">&times;</button>';
      th.querySelector('.gd-col-remove').addEventListener('click', async function () {
        if (!confirm('Eliminare la colonna "' + col.label + '"? I dati salvati in questa colonna per ogni offerta andranno persi dalla visualizzazione.')) return;
        try {
          await sb.from('wt_custom_columns').delete().eq('id', col.id);
          await loadCustomColumns();
          renderGestioneHeader();
          renderGestioneTable();
        } catch (err) {
          alert('Errore: ' + err.message);
        }
      });
      headerRow.insertBefore(th, headerEnd);
    });
  }

  // ================= CARICAMENTO DATI =================
  async function loadOfferte() {
    var grid = document.getElementById('ofGrid');
    grid.innerHTML = '<p class="sub">Caricamento offerte&hellip;</p>';
    try {
      var { data, error } = await sb.from('wt_offerte').select('*').order('categoria').order('tipo').order('ordine');
      if (error) throw error;
      offerte = data || [];
      await loadCustomColumns();
      renderGestioneHeader();
    } catch (err) {
      console.error('Errore caricamento offerte:', err);
      offerte = [];
      grid.innerHTML = '<p class="sub">Errore nel caricamento. Verifica che la tabella wt_offerte esista su Supabase.</p>';
      return;
    }
    renderBadgeFilters();
    renderGrid();
    if (document.getElementById('view-gestione') && !document.getElementById('view-gestione').classList.contains('hidden')) {
      renderGestioneTable();
    }
  }

  function renderBadgeFilters() {
    var group = document.getElementById('ofBadgeFilterGroup');
    var badges = [];
    offerte.forEach(function (o) {
      if (o.badge && badges.indexOf(o.badge) === -1) badges.push(o.badge);
    });
    // rimuove i chip precedenti (mantiene la label)
    group.querySelectorAll('.of-chip').forEach(function (c) { c.remove(); });
    badges.forEach(function (b) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'of-chip' + (activeBadgeFilters.indexOf(b) > -1 ? ' active' : '');
      chip.textContent = b;
      chip.addEventListener('click', function () { toggleFilter(chip, activeBadgeFilters, b); });
      group.appendChild(chip);
    });
    group.classList.toggle('hidden', badges.length === 0);
  }

  // ================= FILTRI =================
  document.querySelectorAll('.of-chip[data-filter-cat]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      toggleFilter(chip, activeCatFilters, chip.dataset.filterCat);
    });
  });
  document.querySelectorAll('.of-chip[data-filter-tipo]').forEach(function (chip) {
    chip.addEventListener('click', function () {
      toggleFilter(chip, activeTipoFilters, chip.dataset.filterTipo);
    });
  });
  document.getElementById('ofOpzioneFilter').addEventListener('click', function () {
    activeOpzioneOnly = !activeOpzioneOnly;
    this.classList.toggle('active', activeOpzioneOnly);
    renderGrid();
  });
  function toggleFilter(chip, arr, value) {
    var idx = arr.indexOf(value);
    if (idx > -1) { arr.splice(idx, 1); chip.classList.remove('active'); }
    else { arr.push(value); chip.classList.add('active'); }
    renderGrid();
  }

  function filteredOfferte() {
    return offerte.filter(function (o) {
      var catOk = activeCatFilters.length === 0 || activeCatFilters.indexOf(o.categoria) > -1;
      var tipoOk = activeTipoFilters.length === 0 || activeTipoFilters.indexOf(o.tipo) > -1;
      var badgeOk = activeBadgeFilters.length === 0 || activeBadgeFilters.indexOf(o.badge) > -1;
      var opzioneOk = !activeOpzioneOnly || o.is_opzione === true;
      return catOk && tipoOk && badgeOk && opzioneOk;
    });
  }

  // ================= RENDER GRIGLIA =================
  var CAT_LABEL = { consumer: 'Consumer', business: 'Business' };
  var TIPO_LABEL = { mobile: 'Mobile', fisso: 'Fisso' };

  function renderGrid() {
    var grid = document.getElementById('ofGrid');
    var list = filteredOfferte();
    document.getElementById('ofCount').textContent = list.length + ' offerte';
    if (!list.length) {
      grid.innerHTML = '<p class="sub">Nessuna offerta corrisponde ai filtri scelti.</p>';
      return;
    }
    grid.innerHTML = '';
    list.forEach(function (o) {
      var card = document.createElement('div');
      card.className = 'of-card' + (selectedIds[o.id] ? ' selected' : '');
      card.dataset.id = o.id;
      var badgeHtml = o.badge ? '<div class="of-badge">' + escapeHtml(o.badge) + '</div>' : '';
      var dettagliArr = (o.dettagli || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var dettagliHtml = dettagliArr.map(function (d) { return '<div>' + escapeHtml(d) + '</div>'; }).join('');

      var prezzoBlockHtml;
      if (o.tipo === 'fisso' && o.prezzo_convergente) {
        // Fisso con prezzo convergente: il convergente è il prezzo in evidenza (come nel portale w3)
        var convLabel = o.nota_convergenza ? escapeHtml(o.nota_convergenza) : 'Prezzo convergente';
        prezzoBlockHtml =
          '<div class="of-prezzo-conv-label">' + convLabel + '</div>' +
          '<div class="of-prezzo-conv-main">' + escapeHtml(o.prezzo_convergente) + '</div>' +
          (o.prezzo_principale ? '<div class="of-prezzo-solo">Solo fisso: ' + escapeHtml(o.prezzo_principale) + '</div>' : '') +
          (o.prezzo_secondario ? '<div class="of-prezzo2">' + escapeHtml(o.prezzo_secondario) + '</div>' : '');
      } else {
        // Mobile (o Fisso senza convergente): comportamento invariato
        prezzoBlockHtml =
          '<div class="of-prezzo1">' + escapeHtml(o.prezzo_principale || '') + '</div>' +
          (o.prezzo_secondario ? '<div class="of-prezzo2">' + escapeHtml(o.prezzo_secondario) + '</div>' : '') +
          (o.prezzo_convergente ? '<div class="of-prezzo-conv">' + escapeHtml(o.prezzo_convergente) + (o.nota_convergenza ? ' &mdash; ' + escapeHtml(o.nota_convergenza) : '') + '</div>' : '');
      }

      card.innerHTML =
        '<button type="button" class="of-edit-btn" title="Modifica">\u270e</button>' +
        '<div class="of-check">\u2713</div>' +
        badgeHtml +
        '<div class="of-nome">' + escapeHtml(o.nome) + '</div>' +
        prezzoBlockHtml +
        '<div class="of-dettagli">' + dettagliHtml + '</div>' +
        '<div class="of-tag">' + CAT_LABEL[o.categoria] + ' &middot; ' + TIPO_LABEL[o.tipo] + '</div>';
      card.querySelector('.of-edit-btn').addEventListener('click', function (ev) {
        ev.stopPropagation();
        document.getElementById('ofAdminBackdrop').classList.remove('hidden');
        renderAdminList();
        showAdminForm(o);
      });
      card.addEventListener('click', function () { toggleSelect(o.id); });
      grid.appendChild(card);
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ================= SELEZIONE + BARRA FLOTTANTE =================
  function toggleSelect(id) {
    if (selectedIds[id]) delete selectedIds[id]; else selectedIds[id] = true;
    renderGrid();
    updateSellingBar();
  }
  function updateSellingBar() {
    var n = Object.keys(selectedIds).length;
    var bar = document.getElementById('ofSellingBar');
    bar.classList.toggle('hidden', n === 0);
    document.getElementById('ofSelCount').textContent = n + (n === 1 ? ' offerta selezionata' : ' offerte selezionate');
  }
  document.getElementById('ofClearSel').addEventListener('click', function () {
    selectedIds = {};
    renderGrid();
    updateSellingBar();
  });

  // ================= MODALE GESTIONE OFFERTE =================
  document.getElementById('ofManageBtn').addEventListener('click', function () {
    document.getElementById('ofAdminBackdrop').classList.remove('hidden');
    renderAdminList();
    hideAdminForm();
  });
  document.getElementById('ofAdminClose').addEventListener('click', function () {
    document.getElementById('ofAdminBackdrop').classList.add('hidden');
  });
  document.getElementById('ofAdminBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'ofAdminBackdrop') document.getElementById('ofAdminBackdrop').classList.add('hidden');
  });

  function renderAdminList() {
    var listEl = document.getElementById('ofAdminList');
    if (!offerte.length) { listEl.innerHTML = '<p class="sub">Nessuna offerta ancora inserita.</p>'; return; }
    listEl.innerHTML = '';
    offerte.forEach(function (o) {
      var row = document.createElement('div');
      row.className = 'of-admin-row';
      row.innerHTML = '<span>' + escapeHtml(o.nome) + '</span><span class="tag">' + CAT_LABEL[o.categoria] + ' &middot; ' + TIPO_LABEL[o.tipo] + '</span>';
      row.addEventListener('click', function () { showAdminForm(o); });
      listEl.appendChild(row);
    });
  }

  function showAdminForm(o) {
    document.getElementById('ofAdminForm').classList.remove('hidden');
    document.getElementById('ofFormLegend').textContent = o ? 'Modifica offerta' : 'Nuova offerta';
    document.getElementById('ofFormId').value = o ? o.id : '';
    document.getElementById('ofFormCategoria').value = o ? o.categoria : 'consumer';
    document.getElementById('ofFormTipo').value = o ? o.tipo : 'mobile';
    document.getElementById('ofFormNome').value = o ? o.nome : '';
    document.getElementById('ofFormPrezzo1').value = o ? (o.prezzo_principale || '') : '';
    document.getElementById('ofFormPrezzo2').value = o ? (o.prezzo_secondario || '') : '';
    document.getElementById('ofFormPrezzoConv').value = o ? (o.prezzo_convergente || '') : '';
    document.getElementById('ofFormNotaConv').value = o ? (o.nota_convergenza || '') : '';
    document.getElementById('ofFormBadge').value = o ? (o.badge || '') : '';
    document.getElementById('ofFormOpzione').checked = o ? !!o.is_opzione : false;
    document.getElementById('ofFormDettagli').value = o ? (o.dettagli || '') : '';
    document.getElementById('ofFormDelete').classList.toggle('hidden', !o);
    document.getElementById('ofFormStatus').textContent = '';
  }
  function hideAdminForm() {
    document.getElementById('ofAdminForm').classList.add('hidden');
  }

  document.getElementById('ofAddNew').addEventListener('click', function () { showAdminForm(null); });
  document.getElementById('ofFormCancel').addEventListener('click', hideAdminForm);

  document.getElementById('ofFormSave').addEventListener('click', async function () {
    var statusEl = document.getElementById('ofFormStatus');
    var id = document.getElementById('ofFormId').value;
    var nome = document.getElementById('ofFormNome').value.trim();
    if (!nome) { statusEl.textContent = 'Il nome è obbligatorio.'; statusEl.className = 'status err'; return; }
    var record = {
      categoria: document.getElementById('ofFormCategoria').value,
      tipo: document.getElementById('ofFormTipo').value,
      nome: nome,
      prezzo_principale: document.getElementById('ofFormPrezzo1').value.trim(),
      prezzo_secondario: document.getElementById('ofFormPrezzo2').value.trim(),
      prezzo_convergente: document.getElementById('ofFormPrezzoConv').value.trim(),
      nota_convergenza: document.getElementById('ofFormNotaConv').value.trim(),
      badge: document.getElementById('ofFormBadge').value.trim(),
      is_opzione: document.getElementById('ofFormOpzione').checked,
      dettagli: document.getElementById('ofFormDettagli').value.trim()
    };
    if (id) record.id = id;
    statusEl.textContent = 'Salvataggio...';
    statusEl.className = 'status';
    try {
      var { error } = await sb.from('wt_offerte').upsert(record);
      if (error) throw error;
      statusEl.textContent = 'Salvato.';
      statusEl.className = 'status ok';
      await loadOfferte();
      renderAdminList();
      hideAdminForm();
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  document.getElementById('ofFormDelete').addEventListener('click', async function () {
    var id = document.getElementById('ofFormId').value;
    if (!id) return;
    if (!confirm('Eliminare questa offerta?')) return;
    var statusEl = document.getElementById('ofFormStatus');
    try {
      var { error } = await sb.from('wt_offerte').delete().eq('id', id);
      if (error) throw error;
      await loadOfferte();
      renderAdminList();
      hideAdminForm();
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  // ================= SELLING NOTE: MODALE + PDF =================
  document.getElementById('ofOpenSellingNote').addEventListener('click', function () {
    var listEl = document.getElementById('ofSellingList');
    var selected = offerte.filter(function (o) { return selectedIds[o.id]; });
    listEl.innerHTML = selected.map(function (o) {
      return '<div class="of-sn-item"><b>' + escapeHtml(o.nome) + '</b><span>' + escapeHtml(o.prezzo_principale || '') + '</span></div>';
    }).join('');
    document.getElementById('ofSellingBackdrop').classList.remove('hidden');
  });
  document.getElementById('ofSellingClose').addEventListener('click', function () {
    document.getElementById('ofSellingBackdrop').classList.add('hidden');
  });
  document.getElementById('ofSellingBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'ofSellingBackdrop') document.getElementById('ofSellingBackdrop').classList.add('hidden');
  });

  document.getElementById('ofGeneratePdf').addEventListener('click', function () {
    var statusEl = document.getElementById('ofSellingStatus');
    var selected = offerte.filter(function (o) { return selectedIds[o.id]; });
    if (!selected.length) { statusEl.textContent = 'Nessuna offerta selezionata.'; statusEl.className = 'status err'; return; }
    try {
      var jsPDF = window.jspdf.jsPDF;
      var doc = new jsPDF({ unit: 'pt', format: 'a4' });
      var pageWidth = doc.internal.pageSize.getWidth();
      var margin = 48;
      var y = 60;

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(238, 108, 31);
      doc.text('Selling Note', margin, y);
      y += 18;
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.setFont('helvetica', 'normal');
      doc.text(new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }), margin, y);
      y += 30;

      selected.forEach(function (o) {
        if (y > 740) { doc.addPage(); y = 60; }
        doc.setFillColor(247, 247, 247);
        var dettagliArr = (o.dettagli || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
        var blockHeight = 46 + dettagliArr.length * 14;
        doc.roundedRect(margin, y, pageWidth - margin * 2, blockHeight, 6, 6, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.setTextColor(30, 30, 30);
        doc.text(o.nome, margin + 14, y + 22);

        doc.setFontSize(13);
        doc.setTextColor(238, 108, 31);
        var prezzoTxt = (o.prezzo_principale || '') + (o.prezzo_secondario ? '  (' + o.prezzo_secondario + ')' : '');
        doc.text(prezzoTxt, pageWidth - margin - 14, y + 22, { align: 'right' });

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(70, 70, 70);
        var dy = y + 40;
        dettagliArr.forEach(function (d) {
          doc.text('\u2022 ' + d, margin + 14, dy);
          dy += 14;
        });
        y += blockHeight + 14;
      });

      var note = document.getElementById('ofSellingNote').value.trim();
      if (note) {
        if (y > 700) { doc.addPage(); y = 60; }
        y += 10;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(30, 30, 30);
        doc.text('Note', margin, y);
        y += 16;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(70, 70, 70);
        var noteLines = doc.splitTextToSize(note, pageWidth - margin * 2);
        doc.text(noteLines, margin, y);
      }

      doc.save('Selling_Note_' + new Date().toISOString().slice(0, 10) + '.pdf');
      statusEl.textContent = 'PDF generato.';
      statusEl.className = 'status ok';
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Errore nella generazione: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  // ================= GESTIONE DATI (tabella editabile) =================
  var gdRows = {};      // { rowKey: { id, isNew, dirty, values:{...} } }
  var gdRowCounter = 0;

  function gdFieldNames() {
    return ['categoria', 'tipo', 'nome', 'prezzo_principale', 'prezzo_secondario', 'prezzo_convergente', 'nota_convergenza', 'badge', 'dettagli'];
  }

  function renderGestioneTable() {
    var tbody = document.getElementById('gdTbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    gdRows = {};
    offerte.forEach(function (o) {
      var key = 'r' + (gdRowCounter++);
      gdRows[key] = { id: o.id, isNew: false, dirty: false, values: {
        categoria: o.categoria, tipo: o.tipo, nome: o.nome,
        prezzo_principale: o.prezzo_principale || '', prezzo_secondario: o.prezzo_secondario || '',
        prezzo_convergente: o.prezzo_convergente || '', nota_convergenza: o.nota_convergenza || '',
        badge: o.badge || '', is_opzione: !!o.is_opzione, dettagli: o.dettagli || '',
        extra: Object.assign({}, o.extra || {})
      }};
      tbody.appendChild(buildGdRow(key));
    });
  }

  function buildGdRow(key) {
    var row = gdRows[key];
    var tr = document.createElement('tr');
    tr.dataset.key = key;
    tr.className = row.isNew ? 'gd-new' : (row.dirty ? 'gd-dirty' : '');

    function td(inputHtml) {
      var cell = document.createElement('td');
      cell.innerHTML = inputHtml;
      return cell;
    }

    var catSel = '<select data-f="categoria"><option value="consumer"' + (row.values.categoria === 'consumer' ? ' selected' : '') + '>Consumer</option><option value="business"' + (row.values.categoria === 'business' ? ' selected' : '') + '>Business</option></select>';
    var tipoSel = '<select data-f="tipo"><option value="mobile"' + (row.values.tipo === 'mobile' ? ' selected' : '') + '>Mobile</option><option value="fisso"' + (row.values.tipo === 'fisso' ? ' selected' : '') + '>Fisso</option></select>';

    tr.appendChild(td(catSel));
    tr.appendChild(td(tipoSel));
    tr.appendChild(td('<input type="text" class="gd-nome-input" data-f="nome" value="' + attrEsc(row.values.nome) + '">'));
    tr.appendChild(td('<input type="text" data-f="prezzo_principale" value="' + attrEsc(row.values.prezzo_principale) + '">'));
    tr.appendChild(td('<input type="text" data-f="prezzo_secondario" value="' + attrEsc(row.values.prezzo_secondario) + '">'));
    tr.appendChild(td('<input type="text" data-f="prezzo_convergente" value="' + attrEsc(row.values.prezzo_convergente) + '">'));
    tr.appendChild(td('<input type="text" data-f="nota_convergenza" value="' + attrEsc(row.values.nota_convergenza) + '">'));
    tr.appendChild(td('<input type="text" data-f="badge" value="' + attrEsc(row.values.badge) + '">'));
    var opzCell = document.createElement('td');
    opzCell.className = 'gd-flag-cell';
    opzCell.innerHTML = '<input type="checkbox" data-f="is_opzione"' + (row.values.is_opzione ? ' checked' : '') + '>';
    tr.appendChild(opzCell);
    customColumns.forEach(function (col) {
      var cell = document.createElement('td');
      var val = (row.values.extra && row.values.extra[col.key]) || '';
      cell.innerHTML = '<input type="text" data-extra="' + col.key + '" value="' + attrEsc(val) + '">';
      cell.querySelector('input').addEventListener('input', function (ev) {
        if (!row.values.extra) row.values.extra = {};
        row.values.extra[col.key] = ev.target.value;
        row.dirty = true;
        tr.className = row.isNew ? 'gd-new' : 'gd-dirty';
      });
      tr.appendChild(cell);
    });
    tr.appendChild(td('<textarea data-f="dettagli">' + escapeHtml(row.values.dettagli) + '</textarea>'));
    var delCell = document.createElement('td');
    delCell.innerHTML = '<button type="button" class="gd-del-btn" title="Elimina">\uD83D\uDDD1</button>';
    delCell.querySelector('button').addEventListener('click', function () { gdDeleteRow(key); });
    tr.appendChild(delCell);

    tr.querySelectorAll('[data-f]').forEach(function (el) {
      el.addEventListener('input', function () {
        row.values[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
        row.dirty = true;
        tr.className = row.isNew ? 'gd-new' : 'gd-dirty';
      });
      if (el.type === 'checkbox') {
        el.addEventListener('change', function () {
          row.values[el.dataset.f] = el.checked;
          row.dirty = true;
          tr.className = row.isNew ? 'gd-new' : 'gd-dirty';
        });
      }
    });
    return tr;
  }

  function attrEsc(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  function gdDeleteRow(key) {
    var row = gdRows[key];
    if (row.isNew) {
      delete gdRows[key];
      document.querySelector('#gdTbody tr[data-key="' + key + '"]').remove();
      return;
    }
    if (!confirm('Eliminare questa offerta?')) return;
    sb.from('wt_offerte').delete().eq('id', row.id).then(function (res) {
      if (res.error) { alert('Errore: ' + res.error.message); return; }
      delete gdRows[key];
      document.querySelector('#gdTbody tr[data-key="' + key + '"]').remove();
      loadOfferte();
    });
  }

  document.getElementById('gdAddRow') && document.getElementById('gdAddRow').addEventListener('click', function () {
    var key = 'r' + (gdRowCounter++);
    gdRows[key] = { id: null, isNew: true, dirty: true, values: {
      categoria: 'consumer', tipo: 'mobile', nome: '', prezzo_principale: '', prezzo_secondario: '',
      prezzo_convergente: '', nota_convergenza: '', badge: '', is_opzione: false, dettagli: '', extra: {}
    }};
    document.getElementById('gdTbody').appendChild(buildGdRow(key));
  });

  document.getElementById('gdSaveAll') && document.getElementById('gdSaveAll').addEventListener('click', async function () {
    var statusEl = document.getElementById('gdStatus');
    var dirtyKeys = Object.keys(gdRows).filter(function (k) { return gdRows[k].dirty; });
    if (!dirtyKeys.length) { statusEl.textContent = 'Nessuna modifica da salvare.'; statusEl.className = 'status'; return; }
    statusEl.textContent = 'Salvataggio di ' + dirtyKeys.length + ' righe...';
    statusEl.className = 'status';
    var errors = [];
    for (var i = 0; i < dirtyKeys.length; i++) {
      var row = gdRows[dirtyKeys[i]];
      if (!row.values.nome.trim()) continue; // salta righe vuote
      var record = Object.assign({}, row.values);
      if (row.id) record.id = row.id;
      var res = await sb.from('wt_offerte').upsert(record);
      if (res.error) errors.push(row.values.nome + ': ' + res.error.message);
    }
    if (errors.length) {
      statusEl.textContent = 'Errori: ' + errors.join(' | ');
      statusEl.className = 'status err';
    } else {
      statusEl.textContent = 'Tutte le modifiche sono state salvate.';
      statusEl.className = 'status ok';
    }
    await loadOfferte();
    renderGestioneTable();
  });

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'offerte' && view !== 'gestione') return;
    if (!offerte.length) { loadOfferte(); return; }
    if (view === 'gestione') renderGestioneTable();
    else renderGrid();
  });
  // carica comunque al primo avvio se l'utente arriva già sulla view (fallback)
  if (document.getElementById('ofGrid')) loadOfferte();
})();
