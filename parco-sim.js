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

    // La vista carica le sezioni in parallelo all'attivazione (jarvis:view), senza
    // attenderle: se l'editor viene aperto prima che quella fetch sia arrivata (o se
    // era fallita, es. tabella non ancora creata), il select Sezione si renderizzerebbe
    // permanentemente senza opzioni, perché niente altro lo ridisegna in seguito.
    // Qui ci si assicura che SEZIONI sia popolato PRIMA di disegnare la tabella.
    if (!SEZIONI.length) await loadSezioni();

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

  var THIN_GRAY_BORDER = { style: 'thin', color: { argb: 'FFE2E4E7' } };
  var DATA_COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];

  function applyThinBorder(cell) {
    cell.border = { top: THIN_GRAY_BORDER, left: THIN_GRAY_BORDER, bottom: THIN_GRAY_BORDER, right: THIN_GRAY_BORDER };
  }

  // Verde >90gg rimasti, ambra 0-90gg, rosso già scaduto. La % completato usa la
  // STESSA soglia di rimanenza (sono derivate dagli stessi due campi data), non una
  // propria fascia calcolata sulla percentuale.
  function statusColorsForRimanenza(rimanenza) {
    if (rimanenza == null) return null;
    if (rimanenza < 0) return { fill: 'FFFBDCDC', text: 'FFB02020' };
    if (rimanenza <= 90) return { fill: 'FFFDECC8', text: 'FF8A5A00' };
    return { fill: 'FFDCF3E2', text: 'FF1A7A3C' };
  }

  function applyBadge(cell, colors) {
    if (!colors) return;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.fill } };
    cell.font = Object.assign({}, cell.font, { color: { argb: colors.text }, bold: true });
  }

  function exportScheda() {
    if (typeof ExcelJS === 'undefined') { alert('Libreria Excel non disponibile (controlla la connessione).'); return; }
    var cliente = document.getElementById('psClienteInput').value.trim() || 'Cliente';
    var note = document.getElementById('psNoteInput').value.trim();

    // Una riga aggiunta con "+ Aggiungi riga" e mai compilata non ha alcun dato utile:
    // non finisce nell'export (né nei totali) invece di apparire come riga vuota fantasma.
    var meaningfulRighe = currentRighe.filter(function (r) {
      return !!(r.piano_tariffario || r.numero || r.seriale || r.puk || r.utente_utilizzatore ||
        r.data_attivazione || r.data_scadenza || r.terminale || (r.canone != null && r.canone !== ''));
    });

    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Parco SIM');
    ws.columns = [
      { key: 'a', width: 3 }, { key: 'canone', width: 10 }, { key: 'piano', width: 24 },
      { key: 'numero', width: 14 }, { key: 'seriale', width: 16 }, { key: 'puk', width: 10 },
      { key: 'utente', width: 22 }, { key: 'attiv', width: 15 }, { key: 'scad', width: 15 },
      { key: 'durata', width: 11 }, { key: 'rimanenza', width: 13 }, { key: 'pct', width: 11 },
      { key: 'terminale', width: 20 }
    ];

    // ---- Banner intestazione (righe 2) ----
    ws.getRow(2).height = 34;
    ws.mergeCells('B2:I2');
    var bannerName = ws.getCell('B2');
    bannerName.value = {
      richText: [
        { font: { bold: true, size: 17, color: { argb: 'FFFFFFFF' } }, text: cliente + '\n' },
        { font: { size: 10, color: { argb: 'FF8FE8FF' } }, text: 'Parco SIM · Dettaglio contratti WindTre' }
      ]
    };
    bannerName.alignment = { vertical: 'middle', wrapText: true };
    bannerName.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };

    ws.mergeCells('J2:M2');
    var bannerDate = ws.getCell('J2');
    bannerDate.value = 'Generato il ' + new Date().toLocaleDateString('it-IT');
    bannerDate.font = { size: 10, color: { argb: 'FFC8D8E0' } };
    bannerDate.alignment = { vertical: 'middle', horizontal: 'right' };
    bannerDate.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    DATA_COLS.forEach(function (col) {
      ws.getCell(col + '2').border = { bottom: { style: 'medium', color: { argb: 'FF2AB8D9' } } };
    });

    // ---- Note / totali (riga 4, un'unica riga con i tre valori affiancati) ----
    var meaningfulRigheForCount = meaningfulRighe;
    var totSim = meaningfulRigheForCount.filter(function (r) { return r.sezione !== FISSO_SEZIONE; }).length;
    var totFissi = meaningfulRigheForCount.filter(function (r) { return r.sezione === FISSO_SEZIONE; }).length;

    ws.getCell('B4').value = 'NOTE:'; ws.getCell('B4').font = { bold: true };
    ws.mergeCells('C4:F4');
    ws.getCell('C4').value = note || '';
    ws.getCell('G4').value = 'TOTALE SIM:'; ws.getCell('G4').font = { bold: true };
    ws.getCell('H4').value = totSim;
    ws.getCell('I4').value = 'TOTALE FISSI:'; ws.getCell('I4').font = { bold: true };
    ws.getCell('J4').value = totFissi;
    DATA_COLS.forEach(function (col) {
      ws.getCell(col + '4').border = { bottom: THIN_GRAY_BORDER };
    });

    // ---- Intestazioni tabella (righe 6-7) ----
    var headFont = { bold: true, color: { argb: 'FF4FC8E8' } };
    var headFill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    function head(cell, text) {
      var c = ws.getCell(cell);
      c.value = text;
      c.font = headFont;
      c.fill = headFill;
      c.alignment = { vertical: 'middle', wrapText: true };
      applyThinBorder(c);
    }
    ['B', 'C', 'D', 'G', 'H', 'I', 'J', 'K', 'L', 'M'].forEach(function (col) {
      ws.mergeCells(col + '6:' + col + '7');
    });
    head('B6', 'CANONE'); head('C6', 'PIANO TARIFFARIO'); head('D6', 'NUMERO');
    ws.mergeCells('E6:F6'); head('E6', 'SERIALE / PUK'); head('E7', 'SERIALE'); head('F7', 'PUK');
    head('G6', 'UTENTE UTILIZZATORE'); head('H6', 'DATA ATTIVAZIONE'); head('I6', 'DATA SCADENZA');
    head('J6', 'DURATA (GIORNI)'); head('K6', 'RIMANENZA (GIORNI)'); head('L6', '% DEL CONTRATTO COMPLETATA');
    head('M6', 'TERMINALE');
    // head() ha già bordato B7/C7/D7/G7-M7 tramite gli anchor merge; bordo anche E7/F7 già coperto sopra.

    // ---- Righe dati, raggruppate per sezione ----
    var rowIdx = 8;
    var order = SEZIONI.map(function (s) { return s.nome; });
    var bySezione = {};
    meaningfulRighe.forEach(function (r) {
      var key = r.sezione || '(senza sezione)';
      if (!bySezione[key]) bySezione[key] = [];
      bySezione[key].push(r);
    });
    var sezOrder = order.filter(function (s) { return bySezione[s]; })
      .concat(Object.keys(bySezione).filter(function (s) { return order.indexOf(s) === -1; }));

    var zebraIdx = 0;
    sezOrder.forEach(function (sezName) {
      ws.mergeCells('B' + rowIdx + ':M' + rowIdx);
      var c = ws.getCell('B' + rowIdx);
      c.value = sezName;
      c.font = { bold: true, color: { argb: 'FF8FE8FF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1924' } };
      DATA_COLS.forEach(function (col) { applyThinBorder(ws.getCell(col + rowIdx)); });
      rowIdx++;

      bySezione[sezName].forEach(function (r) {
        var calc = computeCalc(r);
        var rowCells = {};
        DATA_COLS.forEach(function (col) { rowCells[col] = ws.getCell(col + rowIdx); });

        rowCells.B.value = r.canone != null ? r.canone : null;
        rowCells.C.value = r.piano_tariffario || '';
        rowCells.D.value = r.numero || '';
        rowCells.E.value = r.seriale || '';
        rowCells.F.value = r.puk || '';
        rowCells.G.value = r.utente_utilizzatore || '';
        rowCells.H.value = r.data_attivazione ? fmtDateShort(r.data_attivazione) : '';
        rowCells.I.value = r.data_scadenza ? fmtDateShort(r.data_scadenza) : '';
        rowCells.J.value = calc.durata != null ? calc.durata : '';
        rowCells.K.value = calc.rimanenza != null ? calc.rimanenza : '';
        rowCells.L.value = calc.pct != null ? (calc.pct + '%') : '';
        rowCells.M.value = r.terminale || '';

        var zebraFill = (zebraIdx % 2 === 0) ? 'FFFFFFFF' : 'FFFAFBFC';
        DATA_COLS.forEach(function (col) {
          var cell = rowCells[col];
          applyThinBorder(cell);
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: zebraFill } };
        });
        zebraIdx++;

        var statusColors = statusColorsForRimanenza(calc.rimanenza);
        applyBadge(rowCells.K, statusColors);
        applyBadge(rowCells.L, statusColors);

        rowIdx++;
      });
    });

    // Header sempre visibile scorrendo righe lunghe.
    ws.views = [{ state: 'frozen', ySplit: 7 }];

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
