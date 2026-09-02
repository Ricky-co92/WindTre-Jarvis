(function () {
  var FISSO_SEZIONE = 'Fisso';

  var SEZIONI = []; // [{id, nome, ordine}]
  var schede = []; // [{id, cliente, note, created_at, updated_at}]
  var righeSummary = []; // all righe (scheda_id, sezione, data_scadenza) -- for card badges
  var searchTerm = '';

  var currentSchedaId = null;
  var currentRighe = []; // working array of riga objects while the editor is open

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  // Parses a bare 'YYYY-MM-DD' (as Postgres `date` columns come back) as a LOCAL
  // midnight, not UTC -- `new Date('2026-09-02')` alone parses as UTC midnight,
  // which can roll back a day once displayed in a timezone behind UTC.
  function parseDate(s) {
    if (!s) return null;
    var d = new Date(s + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  function daysBetween(a, b) {
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  function fmtDateShort(iso) {
    var d = parseDate(iso);
    return d ? d.toLocaleDateString('it-IT') : '';
  }

  // Durata/Rimanenza/% non sono mai editabili a mano: si ricalcolano sempre da
  // data_attivazione/data_scadenza, sia in tabella che nell'export.
  function computeCalc(riga) {
    var att = parseDate(riga.data_attivazione);
    var sca = parseDate(riga.data_scadenza);
    var oggi = parseDate(todayISO());
    var out = { durata: null, rimanenza: null, pct: null };
    if (sca) out.rimanenza = daysBetween(oggi, sca);
    if (att && sca) {
      out.durata = daysBetween(att, sca);
      if (out.durata > 0) {
        var elapsed = daysBetween(att, oggi);
        out.pct = Math.max(0, Math.min(100, Math.round((elapsed / out.durata) * 100)));
      }
    }
    return out;
  }

  // Supabase/PostgREST caps a single select at 1000 rows.
  async function fetchAllRows(table, select, applyFilter) {
    var all = [];
    var pageSize = 1000;
    var from = 0;
    while (true) {
      var q = sb.from(table).select(select);
      if (applyFilter) q = applyFilter(q);
      var res = await q.range(from, from + pageSize - 1);
      if (res.error) throw res.error;
      var batch = res.data || [];
      all = all.concat(batch);
      if (batch.length < pageSize) break;
      from += pageSize;
    }
    return all;
  }

  // ================= LOAD =================
  async function loadSezioni() {
    try {
      SEZIONI = await fetchAllRows('wt_parco_sim_sezioni', '*', function (q) { return q.order('ordine'); });
    } catch (err) {
      console.error('Errore caricamento sezioni:', err);
      SEZIONI = [];
    }
  }

  async function loadOfferteNomi() {
    try {
      var rows = await fetchAllRows('wt_offerte', 'nome', function (q) { return q.order('nome'); });
      var dl = document.getElementById('psOfferteList');
      if (dl) dl.innerHTML = rows.filter(function (r) { return r.nome; }).map(function (r) {
        return '<option value="' + escapeHtml(r.nome) + '">';
      }).join('');
    } catch (err) {
      console.error('Errore caricamento offerte:', err);
    }
  }

  async function loadSchede() {
    try {
      schede = await fetchAllRows('wt_parco_sim_schede', '*', function (q) { return q.order('cliente'); });
      righeSummary = await fetchAllRows('wt_parco_sim_righe', 'scheda_id, sezione, data_scadenza');
      renderCards();
    } catch (err) {
      console.error('Errore caricamento schede:', err);
      document.getElementById('psGrid').innerHTML = '<p class="sub">Errore caricamento schede.</p>';
    }
  }

  // ================= LISTA SCHEDE =================
  function computeBadges(schedaId) {
    var rows = righeSummary.filter(function (r) { return r.scheda_id === schedaId; });
    var totSim = rows.filter(function (r) { return r.sezione !== FISSO_SEZIONE; }).length;
    var totFissi = rows.filter(function (r) { return r.sezione === FISSO_SEZIONE; }).length;
    var today = todayISO();
    var in30 = new Date();
    in30.setDate(in30.getDate() + 30);
    var in30ISO = in30.toISOString().slice(0, 10);
    var hasScaduta = rows.some(function (r) { return r.data_scadenza && r.data_scadenza < today; });
    var hasInScadenza = rows.some(function (r) { return r.data_scadenza && r.data_scadenza >= today && r.data_scadenza <= in30ISO; });
    return { totSim: totSim, totFissi: totFissi, hasScaduta: hasScaduta, hasInScadenza: hasInScadenza };
  }

  function filteredSchede() {
    if (!searchTerm) return schede;
    return schede.filter(function (s) { return (s.cliente || '').toLowerCase().indexOf(searchTerm) > -1; });
  }

  function renderCards() {
    var grid = document.getElementById('psGrid');
    var list = filteredSchede();
    if (!list.length) { grid.innerHTML = '<p class="sub">Nessuna scheda trovata.</p>'; applyParcoSimPerms(); return; }
    grid.innerHTML = list.map(function (s) {
      var b = computeBadges(s.id);
      return '<div class="ps-card" data-id="' + s.id + '">' +
        '<button type="button" class="ps-card-del" data-id="' + s.id + '" title="Elimina">&#128465;</button>' +
        '<div class="ps-card-cliente">' + escapeHtml(s.cliente) + '</div>' +
        '<div class="ps-card-meta">Aggiornata ' + fmtDateShort(s.updated_at ? s.updated_at.slice(0, 10) : '') + '</div>' +
        '<div class="ps-card-counts"><span><b>' + b.totSim + '</b> SIM</span><span><b>' + b.totFissi + '</b> Fissi</span></div>' +
        '<div class="ps-badges">' +
        (b.hasScaduta ? '<span class="ps-badge ps-badge-danger">Scaduta</span>' : '') +
        (b.hasInScadenza ? '<span class="ps-badge ps-badge-warn">In scadenza</span>' : '') +
        '</div></div>';
    }).join('');
    grid.querySelectorAll('.ps-card').forEach(function (card) {
      card.addEventListener('click', function () { openEditor(card.dataset.id); });
    });
    grid.querySelectorAll('.ps-card-del').forEach(function (btn) {
      btn.addEventListener('click', function (ev) { ev.stopPropagation(); deleteScheda(btn.dataset.id); });
    });
    applyParcoSimPerms();
  }

  document.getElementById('psSearchInput').addEventListener('input', function () {
    searchTerm = this.value.trim().toLowerCase();
    renderCards();
  });

  document.getElementById('psNewBtn').addEventListener('click', function () { openEditor(null); });

  async function deleteScheda(id) {
    if (!confirm('Eliminare definitivamente questa scheda e tutte le sue righe?')) return;
    try {
      var res = await sb.from('wt_parco_sim_schede').delete().eq('id', id);
      if (res.error) throw res.error;
      if (currentSchedaId === id) {
        document.getElementById('psEditorBackdrop').classList.add('hidden');
        currentSchedaId = null;
      }
      await loadSchede();
    } catch (err) {
      alert('Errore eliminazione: ' + err.message);
    }
  }

  // ================= EDITOR SCHEDA =================
  function sezioneOptionsHtml(selected) {
    return SEZIONI.map(function (s) {
      return '<option value="' + escapeHtml(s.nome) + '"' + (selected === s.nome ? ' selected' : '') + '>' + escapeHtml(s.nome) + '</option>';
    }).join('');
  }

  async function openEditor(schedaId) {
    currentSchedaId = schedaId || null;
    var statusEl = document.getElementById('psEditorStatus');
    statusEl.textContent = '';
    var scheda = schedaId ? schede.filter(function (s) { return s.id === schedaId; })[0] : null;
    document.getElementById('psEditorTitle').textContent = scheda ? ('Scheda — ' + scheda.cliente) : 'Nuova scheda';
    document.getElementById('psClienteInput').value = scheda ? scheda.cliente : '';
    document.getElementById('psNoteInput').value = scheda ? (scheda.note || '') : '';

    try {
      currentRighe = schedaId
        ? await fetchAllRows('wt_parco_sim_righe', '*', function (q) { return q.eq('scheda_id', schedaId).order('ordine'); })
        : [];
    } catch (err) {
      statusEl.textContent = 'Errore caricamento righe: ' + err.message;
      statusEl.className = 'status err';
      currentRighe = [];
    }

    renderRigheTable();
    applyEditorPerms();
    document.getElementById('psEditorBackdrop').classList.remove('hidden');
  }

  document.getElementById('psEditorClose').addEventListener('click', function () {
    document.getElementById('psEditorBackdrop').classList.add('hidden');
  });
  document.getElementById('psEditorBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'psEditorBackdrop') document.getElementById('psEditorClose').click();
  });

  function canEditNow() {
    return typeof PERMS === 'undefined' || !PERMS.ready || PERMS.can('parco_sim', 'edit');
  }

  function renderRigheTable() {
    var tbody = document.getElementById('psRigheTbody');
    var canEdit = canEditNow();
    if (!currentRighe.length) {
      tbody.innerHTML = '<tr><td colspan="14" style="color:#7fc4dc;padding:12px;">Nessuna riga. Usa "+ Aggiungi riga".</td></tr>';
      return;
    }

    var order = SEZIONI.map(function (s) { return s.nome; });
    var indexed = currentRighe.map(function (r, i) { return { r: r, i: i }; });
    indexed.sort(function (a, b) {
      var oa = order.indexOf(a.r.sezione); if (oa === -1) oa = 999;
      var ob = order.indexOf(b.r.sezione); if (ob === -1) ob = 999;
      return oa !== ob ? oa - ob : a.i - b.i;
    });

    var dis = canEdit ? '' : ' disabled';
    tbody.innerHTML = indexed.map(function (item) {
      var r = item.r, idx = item.i;
      var calc = computeCalc(r);
      var overdue = calc.rimanenza != null && calc.rimanenza < 0;
      return '<tr data-idx="' + idx + '">' +
        '<td><select class="ps-f-sezione"' + dis + '>' + sezioneOptionsHtml(r.sezione) + '</select></td>' +
        '<td><input type="text" class="ps-f-piano" list="psOfferteList" value="' + escapeHtml(r.piano_tariffario || '') + '"' + dis + '></td>' +
        '<td><input type="text" class="ps-f-numero" value="' + escapeHtml(r.numero || '') + '"' + dis + '></td>' +
        '<td><input type="text" class="ps-f-seriale" value="' + escapeHtml(r.seriale || '') + '"' + dis + '></td>' +
        '<td><input type="text" class="ps-f-puk" value="' + escapeHtml(r.puk || '') + '"' + dis + '></td>' +
        '<td><input type="text" class="ps-f-utente" value="' + escapeHtml(r.utente_utilizzatore || '') + '"' + dis + '></td>' +
        '<td><input type="date" class="ps-f-attivazione" value="' + (r.data_attivazione || '') + '"' + dis + '></td>' +
        '<td><input type="date" class="ps-f-scadenza" value="' + (r.data_scadenza || '') + '"' + dis + '></td>' +
        '<td class="ps-calc-cell">' + (calc.durata != null ? calc.durata : '&mdash;') + '</td>' +
        '<td class="ps-calc-cell' + (overdue ? ' overdue' : '') + '">' + (calc.rimanenza != null ? calc.rimanenza : '&mdash;') + '</td>' +
        '<td class="ps-calc-cell">' + (calc.pct != null ? calc.pct + '%' : '&mdash;') + '</td>' +
        '<td><input type="number" step="0.01" class="ps-f-canone" value="' + (r.canone != null ? r.canone : '') + '"' + dis + '></td>' +
        '<td><input type="text" class="ps-f-terminale" value="' + escapeHtml(r.terminale || '') + '"' + dis + '></td>' +
        '<td>' + (canEdit ? '<button type="button" class="ps-row-del" data-idx="' + idx + '" title="Elimina riga">&#128465;</button>' : '') + '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('tr').forEach(function (tr) {
      var idx = parseInt(tr.dataset.idx, 10);
      function bind(sel, field, opts) {
        var el = tr.querySelector(sel);
        if (!el) return;
        el.addEventListener(opts && opts.event === 'change' ? 'change' : 'input', function () {
          var val = this.value;
          if (opts && opts.number) val = val === '' ? null : parseFloat(val);
          currentRighe[idx][field] = val;
          if (opts && opts.rerender) renderRigheTable();
        });
      }
      bind('.ps-f-sezione', 'sezione', { event: 'change', rerender: true });
      bind('.ps-f-piano', 'piano_tariffario');
      bind('.ps-f-numero', 'numero');
      bind('.ps-f-seriale', 'seriale');
      bind('.ps-f-puk', 'puk');
      bind('.ps-f-utente', 'utente_utilizzatore');
      bind('.ps-f-attivazione', 'data_attivazione', { rerender: true });
      bind('.ps-f-scadenza', 'data_scadenza', { rerender: true });
      bind('.ps-f-canone', 'canone', { number: true });
      bind('.ps-f-terminale', 'terminale');
      var delBtn = tr.querySelector('.ps-row-del');
      if (delBtn) delBtn.addEventListener('click', function () {
        currentRighe.splice(idx, 1);
        renderRigheTable();
      });
    });
  }

  document.getElementById('psAddRigaBtn').addEventListener('click', function () {
    currentRighe.push({
      sezione: SEZIONI.length ? SEZIONI[0].nome : '', piano_tariffario: '', numero: '', seriale: '', puk: '',
      utente_utilizzatore: '', data_attivazione: null, data_scadenza: null, canone: null, terminale: ''
    });
    renderRigheTable();
  });

  document.getElementById('psSaveBtn').addEventListener('click', async function () {
    var statusEl = document.getElementById('psEditorStatus');
    var cliente = document.getElementById('psClienteInput').value.trim();
    if (!cliente) { statusEl.textContent = 'Inserisci il nome del cliente.'; statusEl.className = 'status err'; return; }
    var note = document.getElementById('psNoteInput').value.trim();

    statusEl.textContent = 'Salvataggio...';
    statusEl.className = 'status';
    try {
      var schedaId = currentSchedaId;
      if (schedaId) {
        var upd = await sb.from('wt_parco_sim_schede').update({ cliente: cliente, note: note || null, updated_at: new Date().toISOString() }).eq('id', schedaId);
        if (upd.error) throw upd.error;
      } else {
        var ins = await sb.from('wt_parco_sim_schede').insert({ cliente: cliente, note: note || null }).select().single();
        if (ins.error) throw ins.error;
        schedaId = ins.data.id;
        currentSchedaId = schedaId;
      }

      // Cancella e reinserisce tutte le righe della scheda, stesso pattern usato da
      // comuni.js per l'upload dell'elenco aree bianche: più semplice e robusto di un
      // diff riga-per-riga, e soddisfa "salva scheda, cancella righe rimosse" così com'è.
      var del = await sb.from('wt_parco_sim_righe').delete().eq('scheda_id', schedaId);
      if (del.error) throw del.error;

      if (currentRighe.length) {
        var payload = currentRighe.map(function (r, i) {
          return {
            scheda_id: schedaId, sezione: r.sezione || null,
            canone: (r.canone != null && r.canone !== '') ? r.canone : null,
            piano_tariffario: r.piano_tariffario || null, numero: r.numero || null, seriale: r.seriale || null,
            puk: r.puk || null, utente_utilizzatore: r.utente_utilizzatore || null,
            data_attivazione: r.data_attivazione || null, data_scadenza: r.data_scadenza || null,
            terminale: r.terminale || null, ordine: i
          };
        });
        var ins2 = await sb.from('wt_parco_sim_righe').insert(payload);
        if (ins2.error) throw ins2.error;
      }

      statusEl.textContent = 'Salvato.';
      statusEl.className = 'status ok';
      await loadSchede();
      currentRighe = await fetchAllRows('wt_parco_sim_righe', '*', function (q) { return q.eq('scheda_id', schedaId).order('ordine'); });
      applyEditorPerms();
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  document.getElementById('psDeleteSchedaBtn').addEventListener('click', function () {
    if (currentSchedaId) deleteScheda(currentSchedaId);
  });

  // ================= EXPORT EXCEL =================
  document.getElementById('psExportBtn').addEventListener('click', function () { exportScheda(); });

  function exportScheda() {
    if (typeof ExcelJS === 'undefined') { alert('Libreria Excel non disponibile (controlla la connessione).'); return; }
    var cliente = document.getElementById('psClienteInput').value.trim() || 'Cliente';
    var note = document.getElementById('psNoteInput').value.trim();

    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Parco SIM');
    ws.columns = [
      { key: 'a', width: 3 }, { key: 'canone', width: 10 }, { key: 'piano', width: 24 },
      { key: 'numero', width: 14 }, { key: 'seriale', width: 16 }, { key: 'puk', width: 10 },
      { key: 'utente', width: 22 }, { key: 'attiv', width: 13 }, { key: 'scad', width: 13 },
      { key: 'durata', width: 10 }, { key: 'rimanenza', width: 12 }, { key: 'pct', width: 10 },
      { key: 'terminale', width: 20 }
    ];

    ws.getCell('B2').value = cliente;
    ws.getCell('B2').font = { bold: true, size: 14, color: { argb: 'FFEAFCFF' } };
    ws.getCell('M2').value = 'Generato il ' + new Date().toLocaleDateString('it-IT');
    ws.getCell('M2').alignment = { horizontal: 'right' };

    ws.getCell('B4').value = 'NOTE:';
    ws.getCell('B4').font = { bold: true };
    ws.mergeCells('C4:M4');
    ws.getCell('C4').value = note || '';
    ws.getCell('C4').alignment = { wrapText: true };

    var totSim = currentRighe.filter(function (r) { return r.sezione !== FISSO_SEZIONE; }).length;
    var totFissi = currentRighe.filter(function (r) { return r.sezione === FISSO_SEZIONE; }).length;
    ws.getCell('B5').value = 'TOTALE SIM:'; ws.getCell('B5').font = { bold: true };
    ws.getCell('C5').value = totSim;
    ws.getCell('B6').value = 'TOTALE FISSI:'; ws.getCell('B6').font = { bold: true };
    ws.getCell('C6').value = totFissi;

    var headFont = { bold: true, color: { argb: 'FF4FC8E8' } };
    var headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    function head(cell, text) {
      var c = ws.getCell(cell);
      c.value = text;
      c.font = headFont;
      c.fill = headFill;
      c.alignment = { vertical: 'middle', wrapText: true };
    }
    ['B', 'C', 'D', 'G', 'H', 'I', 'J', 'K', 'L', 'M'].forEach(function (col) { ws.mergeCells(col + '8:' + col + '9'); });
    head('B8', 'CANONE'); head('C8', 'PIANO TARIFFARIO'); head('D8', 'NUMERO');
    ws.mergeCells('E8:F8'); head('E8', 'SERIALE / PUK'); head('E9', 'SERIALE'); head('F9', 'PUK');
    head('G8', 'UTENTE UTILIZZATORE'); head('H8', 'DATA ATTIVAZIONE'); head('I8', 'DATA SCADENZA');
    head('J8', 'DURATA (GIORNI)'); head('K8', 'RIMANENZA (GIORNI)'); head('L8', '% DEL CONTRATTO COMPLETATA');
    head('M8', 'TERMINALE');

    var rowIdx = 10;
    var order = SEZIONI.map(function (s) { return s.nome; });
    var bySezione = {};
    currentRighe.forEach(function (r) {
      var key = r.sezione || '(senza sezione)';
      if (!bySezione[key]) bySezione[key] = [];
      bySezione[key].push(r);
    });
    var sezOrder = order.filter(function (s) { return bySezione[s]; })
      .concat(Object.keys(bySezione).filter(function (s) { return order.indexOf(s) === -1; }));

    sezOrder.forEach(function (sezName) {
      ws.mergeCells('B' + rowIdx + ':M' + rowIdx);
      var c = ws.getCell('B' + rowIdx);
      c.value = sezName;
      c.font = { bold: true, color: { argb: 'FF8FE8FF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1924' } };
      rowIdx++;
      bySezione[sezName].forEach(function (r) {
        var calc = computeCalc(r);
        ws.getCell('B' + rowIdx).value = r.canone != null ? r.canone : null;
        ws.getCell('C' + rowIdx).value = r.piano_tariffario || '';
        ws.getCell('D' + rowIdx).value = r.numero || '';
        ws.getCell('E' + rowIdx).value = r.seriale || '';
        ws.getCell('F' + rowIdx).value = r.puk || '';
        ws.getCell('G' + rowIdx).value = r.utente_utilizzatore || '';
        ws.getCell('H' + rowIdx).value = r.data_attivazione ? fmtDateShort(r.data_attivazione) : '';
        ws.getCell('I' + rowIdx).value = r.data_scadenza ? fmtDateShort(r.data_scadenza) : '';
        ws.getCell('J' + rowIdx).value = calc.durata != null ? calc.durata : '';
        ws.getCell('K' + rowIdx).value = calc.rimanenza != null ? calc.rimanenza : '';
        ws.getCell('L' + rowIdx).value = calc.pct != null ? (calc.pct + '%') : '';
        ws.getCell('M' + rowIdx).value = r.terminale || '';
        rowIdx++;
      });
    });

    wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'ParcoSIM_' + cliente.replace(/[^a-zA-Z0-9]+/g, '_') + '_' + todayISO() + '.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // ================= PERMESSI =================
  function applyParcoSimPerms() {
    if (typeof PERMS === 'undefined' || !PERMS.ready) return;
    var canEdit = PERMS.can('parco_sim', 'edit');
    var canDelete = PERMS.can('parco_sim', 'delete');
    document.getElementById('psNewBtn').classList.toggle('hidden', !canEdit);
    document.querySelectorAll('.ps-card-del').forEach(function (b) { b.classList.toggle('hidden', !canDelete); });
    // "Gestisci sezioni" resta riservato al SuperAdmin puro, come "Gestisci categorie"
    // in Manuali, indipendentemente dal permesso granulare "edit".
    document.getElementById('psSezManageBtn').classList.toggle('hidden', !PERMS.isSuperAdmin);
  }
  document.addEventListener('jarvis:permsReady', applyParcoSimPerms);

  function applyEditorPerms() {
    var canEdit = canEditNow();
    var canDelete = typeof PERMS === 'undefined' || !PERMS.ready || PERMS.can('parco_sim', 'delete');
    var canExport = typeof PERMS === 'undefined' || !PERMS.ready || PERMS.can('parco_sim', 'export');
    document.getElementById('psSaveBtn').classList.toggle('hidden', !canEdit);
    document.getElementById('psAddRigaBtn').classList.toggle('hidden', !canEdit);
    document.getElementById('psClienteInput').disabled = !canEdit;
    document.getElementById('psNoteInput').disabled = !canEdit;
    document.getElementById('psDeleteSchedaBtn').classList.toggle('hidden', !(currentSchedaId && canDelete));
    document.getElementById('psExportBtn').classList.toggle('hidden', !canExport);
  }

  // ================= GESTIONE SEZIONI (SuperAdmin) =================
  document.getElementById('psSezManageBtn').addEventListener('click', function () {
    renderSezList();
    document.getElementById('psSezBackdrop').classList.remove('hidden');
  });
  document.getElementById('psSezClose').addEventListener('click', function () {
    document.getElementById('psSezBackdrop').classList.add('hidden');
  });
  document.getElementById('psSezBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'psSezBackdrop') document.getElementById('psSezClose').click();
  });

  async function renderSezList() {
    var list = await fetchAllRows('wt_parco_sim_sezioni', '*', function (q) { return q.order('ordine'); });
    var wrap = document.getElementById('psSezList');
    wrap.innerHTML = list.map(function (s) {
      return '<div class="mn-bulk-ver-row" data-id="' + s.id + '"><span style="flex:1;color:#eafcff;">' + escapeHtml(s.nome) + '</span>' +
        '<button type="button" class="mn-icon-btn ps-sez-del" data-id="' + s.id + '" title="Elimina">&#128465;</button></div>';
    }).join('') || '<p class="sub">Nessuna sezione.</p>';
    wrap.querySelectorAll('.ps-sez-del').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (!confirm('Eliminare questa sezione? Le righe già assegnate manterranno il nome come testo, ma non sarà più selezionabile per righe nuove.')) return;
        await sb.from('wt_parco_sim_sezioni').delete().eq('id', b.dataset.id);
        await loadSezioni();
        renderSezList();
        renderCards();
      });
    });
  }

  document.getElementById('psSezAddBtn').addEventListener('click', async function () {
    var input = document.getElementById('psSezNewInput');
    var nome = input.value.trim();
    if (!nome) return;
    var res = await sb.from('wt_parco_sim_sezioni').select('ordine').order('ordine', { ascending: false }).limit(1);
    var nextOrdine = (res.data && res.data[0] ? res.data[0].ordine : 0) + 10;
    var ins = await sb.from('wt_parco_sim_sezioni').insert({ nome: nome, ordine: nextOrdine });
    if (ins.error) { alert('Errore: ' + ins.error.message); return; }
    input.value = '';
    await loadSezioni();
    renderSezList();
  });

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'parco_sim') return;
    loadSezioni();
    loadSchede();
    loadOfferteNomi();
  });
})();
