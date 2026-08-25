(function () {
  var offerte = [];
  var activeCatFilters = [];   // es. ['consumer','business'] o []
  var activeTipoFilters = [];  // es. ['mobile','fisso'] o []
  var selectedIds = {};        // { id: true }

  // ================= CARICAMENTO DATI =================
  async function loadOfferte() {
    var grid = document.getElementById('ofGrid');
    grid.innerHTML = '<p class="sub">Caricamento offerte&hellip;</p>';
    try {
      var { data, error } = await sb.from('wt_offerte').select('*').order('categoria').order('tipo').order('ordine');
      if (error) throw error;
      offerte = data || [];
    } catch (err) {
      console.error('Errore caricamento offerte:', err);
      offerte = [];
      grid.innerHTML = '<p class="sub">Errore nel caricamento. Verifica che la tabella wt_offerte esista su Supabase.</p>';
      return;
    }
    renderGrid();
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
      return catOk && tipoOk;
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
      var prezzo2Html = o.prezzo_secondario ? '<div class="of-prezzo2">' + escapeHtml(o.prezzo_secondario) + '</div>' : '';
      var dettagliArr = (o.dettagli || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var dettagliHtml = dettagliArr.map(function (d) { return '<div>' + escapeHtml(d) + '</div>'; }).join('');
      card.innerHTML =
        '<div class="of-check">\u2713</div>' +
        badgeHtml +
        '<div class="of-nome">' + escapeHtml(o.nome) + '</div>' +
        '<div class="of-prezzo1">' + escapeHtml(o.prezzo_principale || '') + '</div>' +
        prezzo2Html +
        '<div class="of-dettagli">' + dettagliHtml + '</div>' +
        '<div class="of-tag">' + CAT_LABEL[o.categoria] + ' &middot; ' + TIPO_LABEL[o.tipo] + '</div>';
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
    document.getElementById('ofFormBadge').value = o ? (o.badge || '') : '';
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
      badge: document.getElementById('ofFormBadge').value.trim(),
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

  // ================= INIT =================
  document.querySelectorAll('.nav-item[data-view="offerte"]').forEach(function (el) {
    el.addEventListener('click', function () {
      if (!offerte.length) loadOfferte();
    });
  });
  // carica comunque al primo avvio se l'utente arriva già sulla view (fallback)
  if (document.getElementById('ofGrid')) loadOfferte();
})();
