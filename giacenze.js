(function () {
  var COOLDOWN_MS = 1500; // stesso codice non ricontato finché non sparisce dall'inquadratura per almeno tanto
  var UPSERT_CHUNK = 500;
  var DELETE_CHUNK = 100;
  var MANUAL_MAX_RESULTS = 10; // risultati mostrati dal typeahead della ricerca manuale

  var attese = []; // [{codice, nome_articolo, unita_attese, importato_il}]
  var atteseHay = []; // stringhe minuscole "codice nome" parallele ad attese, per la ricerca
  var attMap = new Map(); // chiave normalizzata (trim+MAIUSCOLO) -> riga di attese
  var attExact = new Map(); // codice esatto -> riga di attese

  var sessione = null; // riga di wt_giacenze_conteggio mostrata (attiva o completata)
  var inCorso = null; // eventuale conteggio 'in_corso' su DB, anche se non ripreso in questa vista
  var mode = 'idle'; // 'idle' | 'active' | 'readonly'
  var righe = new Map(); // codice esatto -> unita_contate, per la sessione mostrata
  var righeKeys = new Map(); // chiave normalizzata -> codice esatto in righe
  var filter = 'all';

  var scanner = null;
  var scannerRunning = false;
  var lastSeen = {}; // chiave normalizzata -> timestamp dell'ultima decodifica (anche se ignorata)
  var pendingUnknown = null; // codice non riconosciuto in attesa di "Aggiungi comunque"
  var selectedCode = null; // articolo selezionato nello stepper manuale
  var renderQueued = false;

  function $(id) { return document.getElementById(id); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // I codici si confrontano sempre in forma normalizzata, così non serve sapere in
  // che case li esporta il gestionale né in che case li decodifica il barcode.
  function normKey(s) {
    return String(s == null ? '' : s).trim().toUpperCase();
  }

  function fmtNum(n) {
    if (n == null) return '';
    return Number.isInteger(n) ? String(n) : n.toLocaleString('it-IT', { maximumFractionDigits: 3 });
  }

  function fmtDiff(n) {
    if (n == null) return '';
    return (n > 0 ? '+' : '') + fmtNum(n);
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('it-IT') + ' ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  }

  function isSuperAdmin() {
    return typeof PERMS !== 'undefined' && PERMS.ready && PERMS.isSuperAdmin;
  }

  function operatoreCorrente() {
    return (typeof currentUser !== 'undefined' && currentUser && currentUser.email) || null;
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

  // ================= IMPORT FILE =================
  // Il .xls del gestionale è in realtà HTML: si legge come testo, non come Excel binario.
  async function readFileText(file) {
    var text = await file.text();
    // Se il file non è UTF-8 (tipico windows-1252) il decoder inserisce U+FFFD al posto
    // delle lettere accentate: in quel caso si rilegge il file con la codifica giusta.
    if (text.indexOf('�') > -1) {
      text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
    }
    return text;
  }

  function cellText(el) {
    return el ? el.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '';
  }

  function headerKey(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  }

  // Trova la colonna "Unita" del negozio dall'header: è quella subito prima di "Costo".
  // Se l'header non è riconoscibile ripiega sulla penultima colonna.
  function findUnitCol(headers, colCount) {
    var keys = headers.map(headerKey);
    var costoIdx = -1;
    var unitIdxs = [];
    keys.forEach(function (k, i) {
      if (costoIdx === -1 && k.indexOf('costo') === 0) costoIdx = i;
      if (k.indexOf('unit') === 0) unitIdxs.push(i);
    });
    if (costoIdx > 0 && unitIdxs.indexOf(costoIdx - 1) > -1) return costoIdx - 1;
    if (unitIdxs.length) return unitIdxs[unitIdxs.length - 1];
    if (costoIdx > 0) return costoIdx - 1;
    return colCount - 2;
  }

  // "12", "12,5", "1.234", "1.234,50" -> numero. Restituisce NaN se non è un numero.
  function parseQty(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s/g, '');
    if (s === '') return 0;
    if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }

  function parseGiacenzeDoc(doc) {
    var table = doc.querySelector('table[id^="DataTables_Table"]') || doc.querySelector('table');
    if (!table) throw new Error('Nessuna tabella trovata nel file.');

    var headRow = table.querySelector('thead tr') ||
      Array.from(table.querySelectorAll('tr')).filter(function (tr) { return tr.querySelector('th'); })[0] || null;
    var headers = headRow ? Array.from(headRow.children).map(cellText) : [];

    var trs = Array.from(table.querySelectorAll('tbody tr, tr')).filter(function (tr) {
      return tr !== headRow && tr.querySelectorAll('td').length > 0;
    });
    if (!trs.length) throw new Error('La tabella non contiene righe.');

    var colCount = headers.length || trs[0].querySelectorAll('td').length;
    var unitCol = findUnitCol(headers, colCount);
    if (unitCol < 2) throw new Error('Colonna delle unità non riconosciuta (header: ' + (headers.join(' | ') || 'assente') + ').');

    var byCode = new Map();
    var skipped = 0;
    var merged = 0;
    trs.forEach(function (tr) {
      var cells = tr.querySelectorAll('td');
      var codice = cellText(cells[0]);
      var nome = cellText(cells[1]);
      if (!codice || /^totale:?$/i.test(codice) || /^totale:?$/i.test(nome)) return;
      var unita = parseQty(cellText(cells[unitCol]));
      if (isNaN(unita)) { skipped++; return; }
      var prev = byCode.get(codice);
      if (prev) {
        // Stesso codice su più righe: si sommano le unità invece di perderne una.
        prev.unita_attese += unita;
        if (!prev.nome_articolo && nome) prev.nome_articolo = nome;
        merged++;
      } else {
        byCode.set(codice, { codice: codice, nome_articolo: nome || null, unita_attese: unita });
      }
    });

    return {
      rows: Array.from(byCode.values()),
      skipped: skipped,
      merged: merged,
      unitLabel: headers[unitCol] || ('colonna ' + (unitCol + 1))
    };
  }

  async function importFile(file) {
    var btn = $('gzImportBtn');
    if (!isSuperAdmin()) return;
    btn.disabled = true;
    setInfo('Lettura file...', '');
    try {
      var text = await readFileText(file);
      var parsed = parseGiacenzeDoc(new DOMParser().parseFromString(text, 'text/html'));
      if (!parsed.rows.length) throw new Error('Nessun articolo valido trovato nel file.');

      var extra = (parsed.merged ? '\n' + parsed.merged + ' righe con codice duplicato sommate.' : '') +
        (parsed.skipped ? '\n' + parsed.skipped + ' righe scartate (unità non numeriche).' : '');
      if (!confirm('Sostituire la giacenza attesa con ' + parsed.rows.length + ' articoli?\nColonna unità letta: "' + parsed.unitLabel + '".' + extra)) {
        setInfo('Import annullato.', '');
        return;
      }

      // Nessun TRUNCATE: la anon key non può fare DDL. Prima si scrive tutto (upsert),
      // poi si eliminano solo i codici spariti dal file: lo stato finale è quello di
      // un truncate+insert, ma un errore a metà non lascia mai la tabella vuota.
      var now = new Date().toISOString();
      var payload = parsed.rows.map(function (r) {
        return { codice: r.codice, nome_articolo: r.nome_articolo, unita_attese: r.unita_attese, importato_il: now };
      });
      for (var i = 0; i < payload.length; i += UPSERT_CHUNK) {
        setInfo('Salvataggio... ' + Math.min(i + UPSERT_CHUNK, payload.length) + '/' + payload.length, '');
        var up = await sb.from('wt_giacenze_attese').upsert(payload.slice(i, i + UPSERT_CHUNK), { onConflict: 'codice' });
        if (up.error) throw up.error;
      }

      var newCodes = new Set(payload.map(function (r) { return r.codice; }));
      var existing = await fetchAllRows('wt_giacenze_attese', 'codice', function (q) { return q.order('codice'); });
      var stale = existing.map(function (r) { return r.codice; }).filter(function (c) { return !newCodes.has(c); });
      for (var j = 0; j < stale.length; j += DELETE_CHUNK) {
        var del = await sb.from('wt_giacenze_attese').delete().in('codice', stale.slice(j, j + DELETE_CHUNK));
        if (del.error) throw del.error;
      }

      await loadAttese();
      renderImportInfo();
      scheduleRender();
      setInfo(payload.length + ' articoli importati, aggiornati il ' + fmtDateTime(now) +
        (stale.length ? ' (' + stale.length + ' rimossi perché non più nel file)' : ''), 'ok');
    } catch (err) {
      console.error('Errore import giacenze:', err);
      setInfo('Errore import: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      $('gzImportFile').value = '';
    }
  }

  function setInfo(msg, cls) {
    var el = $('gzImportInfo');
    el.textContent = msg;
    el.className = 'gz-info' + (cls ? ' ' + cls : '');
  }

  function renderImportInfo() {
    if (!attese.length) {
      setInfo('Nessuna giacenza attesa importata.' + (isSuperAdmin() ? '' : ' Chiedi a un SuperAdmin di importarla.'), '');
      return;
    }
    var last = attese.reduce(function (m, r) { return r.importato_il > m ? r.importato_il : m; }, '');
    setInfo(attese.length + ' articoli importati, aggiornati il ' + fmtDateTime(last), '');
  }

  // ================= LOAD =================
  async function loadAttese() {
    attese = await fetchAllRows('wt_giacenze_attese', '*', function (q) { return q.order('codice'); });
    attese.forEach(function (a) { a.unita_attese = Number(a.unita_attese) || 0; });
    atteseHay = attese.map(function (a) { return (a.codice + ' ' + (a.nome_articolo || '')).toLowerCase(); });
    attMap = new Map();
    attExact = new Map();
    attese.forEach(function (a) {
      var k = normKey(a.codice);
      if (!attMap.has(k)) attMap.set(k, a);
      attExact.set(a.codice, a);
    });
  }

  function setRigaLocal(codice, val) {
    righe.set(codice, val);
    righeKeys.set(normKey(codice), codice);
  }

  async function loadRighe() {
    righe = new Map();
    righeKeys = new Map();
    if (!sessione) return;
    var rows = await fetchAllRows('wt_giacenze_conteggio_righe', 'codice, unita_contate', function (q) {
      return q.eq('conteggio_id', sessione.id).order('codice');
    });
    rows.forEach(function (r) { setRigaLocal(r.codice, Number(r.unita_contate) || 0); });
  }

  async function fetchInCorso() {
    var res = await sb.from('wt_giacenze_conteggio').select('*').eq('stato', 'in_corso')
      .order('iniziato_il', { ascending: false }).limit(1);
    if (res.error) throw res.error;
    return (res.data && res.data[0]) || null;
  }

  async function loadSessione() {
    inCorso = await fetchInCorso();
    if (mode === 'active' && sessione) {
      await loadRighe();
    } else {
      // Nessun conteggio attivo in questa vista: resta consultabile l'ultimo completato.
      var res = await sb.from('wt_giacenze_conteggio').select('*').eq('stato', 'completato')
        .order('completato_il', { ascending: false }).limit(1);
      if (res.error) throw res.error;
      sessione = (res.data && res.data[0]) || null;
      mode = sessione ? 'readonly' : 'idle';
      await loadRighe();
    }
    applyMode();
    scheduleRender();
  }

  async function loadAll() {
    try {
      await loadAttese();
      renderImportInfo();
      await loadSessione();
    } catch (err) {
      console.error('Errore caricamento giacenze:', err);
      setInfo('Errore caricamento: ' + err.message + ' (hai eseguito tools/giacenze-schema.sql su Supabase?)', 'err');
    }
  }

  // ================= MODE / VISIBILITÀ =================
  function applyMode() {
    var active = mode === 'active';
    $('gzImportBtn').classList.toggle('hidden', !isSuperAdmin());
    $('gzStartBtn').classList.toggle('hidden', active);
    $('gzEndBtn').classList.toggle('hidden', !active);
    $('gzExportBtn').classList.toggle('hidden', mode !== 'readonly');
    $('gzInputArea').classList.toggle('hidden', !active);
    $('gzCompare').classList.toggle('hidden', mode === 'idle');

    var showResume = !active && !!inCorso;
    $('gzResume').classList.toggle('hidden', !showResume);
    if (showResume) {
      $('gzResumeText').textContent = 'Conteggio in corso iniziato il ' + fmtDateTime(inCorso.iniziato_il) +
        (inCorso.operatore ? ' da ' + inCorso.operatore : '') + '.';
    }

    var sessEl = $('gzSession');
    sessEl.classList.toggle('hidden', !sessione);
    if (sessione) {
      sessEl.textContent = (mode === 'active' ? 'Conteggio in corso' : 'Ultimo conteggio completato (sola lettura)') +
        ' — iniziato il ' + fmtDateTime(sessione.iniziato_il) +
        (sessione.operatore ? ' da ' + sessione.operatore : '') +
        (sessione.completato_il ? ' · chiuso il ' + fmtDateTime(sessione.completato_il) : '');
    }
    if (!active) stopScanner();
  }
  document.addEventListener('jarvis:permsReady', applyMode);

  // ================= AVVIO / RIPRESA / CHIUSURA CONTEGGIO =================
  async function creaSessione() {
    var res = await sb.from('wt_giacenze_conteggio').insert({ operatore: operatoreCorrente(), stato: 'in_corso' }).select().single();
    if (res.error) throw res.error;
    sessione = res.data;
    inCorso = null;
    righe = new Map();
    righeKeys = new Map();
    lastSeen = {};
    selectedCode = null;
    mode = 'active';
    resetInputArea();
    applyMode();
    scheduleRender();
  }

  async function riprendiSessione(row) {
    sessione = row;
    inCorso = null;
    lastSeen = {};
    selectedCode = null;
    await loadRighe();
    mode = 'active';
    resetInputArea();
    applyMode();
    scheduleRender();
  }

  function resetInputArea() {
    $('gzFeedback').className = 'gz-feedback hidden';
    $('gzFeedback').innerHTML = '';
    $('gzSearchInput').value = '';
    $('gzSuggest').innerHTML = '';
    $('gzStepper').innerHTML = '';
    setManualMsg('', false);
    pendingUnknown = null;
  }

  async function onStartClick() {
    var btn = $('gzStartBtn');
    btn.disabled = true;
    try {
      if (!attese.length) {
        alert('Nessuna giacenza attesa importata: senza non c\'è nulla con cui confrontare il conteggio.' +
          (isSuperAdmin() ? '' : ' Chiedi a un SuperAdmin di importarla.'));
        return;
      }
      // Rilettura fresca: il conteggio in corso potrebbe essere stato avviato da un altro dispositivo.
      var existing = await fetchInCorso();
      if (existing) { openChoice(existing); return; }
      await creaSessione();
    } catch (err) {
      alert('Errore avvio conteggio: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  var choiceRow = null;
  function openChoice(row) {
    choiceRow = row;
    $('gzChoiceText').textContent = 'Esiste già un conteggio in corso, iniziato il ' + fmtDateTime(row.iniziato_il) +
      (row.operatore ? ' da ' + row.operatore : '') + '. Vuoi riprenderlo oppure abbandonarlo e iniziarne uno nuovo?';
    $('gzChoiceBackdrop').classList.remove('hidden');
  }
  function closeChoice() {
    $('gzChoiceBackdrop').classList.add('hidden');
    choiceRow = null;
  }

  $('gzChoiceClose').addEventListener('click', closeChoice);
  $('gzChoiceBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'gzChoiceBackdrop') closeChoice();
  });
  $('gzChoiceResume').addEventListener('click', async function () {
    var row = choiceRow;
    closeChoice();
    if (!row) return;
    try { await riprendiSessione(row); } catch (err) { alert('Errore: ' + err.message); }
  });
  $('gzChoiceAbandon').addEventListener('click', async function () {
    var row = choiceRow;
    closeChoice();
    if (!row) return;
    try {
      var upd = await sb.from('wt_giacenze_conteggio').update({ stato: 'abbandonato' }).eq('id', row.id);
      if (upd.error) throw upd.error;
      await creaSessione();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  });

  $('gzStartBtn').addEventListener('click', onStartClick);
  $('gzResumeBtn').addEventListener('click', async function () {
    try {
      var row = await fetchInCorso();
      if (!row) { await loadSessione(); return; }
      await riprendiSessione(row);
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  });

  $('gzEndBtn').addEventListener('click', async function () {
    if (mode !== 'active' || !sessione) return;
    var data = computeRows();
    var nonContati = data.main.filter(function (r) { return r.state === 'none'; }).length;
    if (!confirm('Terminare il conteggio?' + (nonContati ? '\n' + nonContati + ' articoli non risultano ancora contati.' : '') +
      '\nDopo la chiusura non sarà più modificabile.')) return;
    try {
      var upd = await sb.from('wt_giacenze_conteggio')
        .update({ stato: 'completato', completato_il: new Date().toISOString() })
        .eq('id', sessione.id).select().single();
      if (upd.error) throw upd.error;
      sessione = upd.data;
      mode = 'readonly';
      applyMode();
      scheduleRender();
    } catch (err) {
      alert('Errore chiusura conteggio: ' + err.message);
    }
  });

  // ================= SCRITTURA CONTEGGI =================
  // Incremento atomico lato Postgres (vedi tools/giacenze-schema.sql).
  async function bump(codice, delta) {
    if (!sessione || mode !== 'active') throw new Error('Nessun conteggio attivo.');
    var res = await sb.rpc('wt_giacenze_incrementa', { p_conteggio_id: sessione.id, p_codice: codice, p_delta: delta });
    if (res.error) throw res.error;
    var totale = Number(res.data);
    setRigaLocal(codice, totale);
    scheduleRender();
    return totale;
  }

  async function setCount(codice, valore) {
    if (!sessione || mode !== 'active') throw new Error('Nessun conteggio attivo.');
    var res = await sb.from('wt_giacenze_conteggio_righe').upsert(
      { conteggio_id: sessione.id, codice: codice, unita_contate: valore, updated_at: new Date().toISOString() },
      { onConflict: 'conteggio_id,codice' }
    );
    if (res.error) throw res.error;
    setRigaLocal(codice, valore);
    scheduleRender();
  }

  // ================= SCANNER FOTOCAMERA =================
  function showFeedback(kind, html) {
    var el = $('gzFeedback');
    el.className = 'gz-feedback ' + kind;
    el.innerHTML = html;
  }

  function vibrate(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* non supportato (iOS) */ }
  }

  function feedbackCounted(nome, codice, totale, attesi) {
    showFeedback('ok',
      '<div class="gz-fb-title">&#10003; ' + escapeHtml(nome || codice) + '</div>' +
      '<div class="gz-fb-sub">' + escapeHtml(codice) + '</div>' +
      '<div class="gz-fb-count">Contati: <b>' + fmtNum(totale) + '</b>' + (attesi != null ? ' / attesi ' + fmtNum(attesi) : '') + '</div>');
    vibrate(60);
  }

  async function handleCode(key, rawText) {
    var art = attMap.get(key);
    var extraCode = righeKeys.get(key);
    try {
      if (art) {
        var tot = await bump(art.codice, 1);
        feedbackCounted(art.nome_articolo, art.codice, tot, art.unita_attese);
      } else if (extraCode) {
        var tot2 = await bump(extraCode, 1);
        feedbackCounted('Non presente in giacenza attesa', extraCode, tot2, null);
      } else {
        pendingUnknown = key;
        showFeedback('warn',
          '<div class="gz-fb-title">Codice non riconosciuto: ' + escapeHtml(rawText) + '</div>' +
          '<button type="button" class="pt-btn primary" id="gzAddAnywayBtn">Aggiungi comunque</button>');
        vibrate([40, 60, 40]);
      }
    } catch (err) {
      showFeedback('err', '<div class="gz-fb-title">Errore salvataggio: ' + escapeHtml(err.message) + '</div>');
    }
  }

  $('gzFeedback').addEventListener('click', async function (ev) {
    if (!ev.target.closest('#gzAddAnywayBtn') || !pendingUnknown) return;
    var key = pendingUnknown;
    pendingUnknown = null;
    try {
      var tot = await bump(key, 1);
      feedbackCounted('Non presente in giacenza attesa', key, tot, null);
    } catch (err) {
      showFeedback('err', '<div class="gz-fb-title">Errore salvataggio: ' + escapeHtml(err.message) + '</div>');
    }
  });

  function onDecode(decodedText) {
    var key = normKey(decodedText);
    if (!key || mode !== 'active') return;
    // La fotocamera continua a decodificare lo stesso barcode finché resta inquadrato:
    // l'ultima visione si aggiorna a ogni decodifica (anche se ignorata), così lo stesso
    // codice conta di nuovo solo dopo essere stato fuori campo per COOLDOWN_MS.
    var now = Date.now();
    var last = lastSeen[key];
    lastSeen[key] = now;
    if (last && now - last < COOLDOWN_MS) return;
    handleCode(key, decodedText.trim());
  }

  function scanFormats() {
    if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
    var F = Html5QrcodeSupportedFormats;
    return [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX]
      .filter(function (f) { return f !== undefined; });
  }

  async function startScanner() {
    var msg = $('gzScanMsg');
    if (typeof Html5Qrcode === 'undefined') { msg.textContent = 'Libreria scanner non disponibile (controlla la connessione).'; return; }
    if (scannerRunning || mode !== 'active') return;
    msg.textContent = '';
    $('gzScanToggle').disabled = true;
    try {
      if (!scanner) scanner = new Html5Qrcode('gzScannerBox', { verbose: false, formatsToSupport: scanFormats() });
      await scanner.start(
        { facingMode: 'environment' },
        {
          fps: 10,
          // Rettangolo largo: i barcode 1D non si leggono in un riquadro quadrato.
          qrbox: function (vw, vh) {
            var w = Math.max(50, Math.floor(Math.min(vw * 0.9, 480)));
            return { width: w, height: Math.max(50, Math.floor(Math.min(vh * 0.7, w * 0.5))) };
          }
        },
        onDecode,
        function () { /* nessun codice nel frame: normale */ }
      );
      scannerRunning = true;
      $('gzScanToggle').textContent = 'Ferma fotocamera';
    } catch (err) {
      console.error('Errore avvio fotocamera:', err);
      msg.textContent = 'Impossibile avviare la fotocamera: ' + (err && err.message ? err.message : err);
    } finally {
      $('gzScanToggle').disabled = false;
    }
  }

  async function stopScanner() {
    if (!scanner || !scannerRunning) return;
    scannerRunning = false;
    try { await scanner.stop(); scanner.clear(); } catch (e) { /* già fermo */ }
    var btn = $('gzScanToggle');
    if (btn) btn.textContent = 'Attiva fotocamera';
  }

  $('gzScanToggle').addEventListener('click', function () {
    if (scannerRunning) stopScanner(); else startScanner();
  });

  // ================= RICERCA MANUALE =================
  function searchAttese(term) {
    var tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    var out = [];
    for (var i = 0; i < attese.length && out.length < MANUAL_MAX_RESULTS; i++) {
      var hay = atteseHay[i];
      if (tokens.every(function (t) { return hay.indexOf(t) > -1; })) out.push(attese[i]);
    }
    return out;
  }

  $('gzSearchInput').addEventListener('input', function () {
    var term = this.value.trim();
    var box = $('gzSuggest');
    setManualMsg('', false);
    if (!term) { box.innerHTML = ''; return; }
    var found = searchAttese(term);
    if (!found.length) {
      box.innerHTML = '<div class="gz-sugg-empty">Nessun articolo trovato. ' +
        '<button type="button" class="pt-btn gz-sugg-add" data-code="' + escapeHtml(normKey(term)) + '">Aggiungi comunque &laquo;' + escapeHtml(normKey(term)) + '&raquo;</button></div>';
      return;
    }
    box.innerHTML = found.map(function (a) {
      return '<button type="button" class="gz-sugg" data-code="' + escapeHtml(a.codice) + '"><b>' + escapeHtml(a.codice) + '</b> ' + escapeHtml(a.nome_articolo || '') + '</button>';
    }).join('');
  });

  $('gzSearchInput').addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter') return;
    var first = $('gzSuggest').querySelector('.gz-sugg');
    if (first) { ev.preventDefault(); selectArticle(first.dataset.code); }
  });

  $('gzSuggest').addEventListener('click', async function (ev) {
    var pick = ev.target.closest('.gz-sugg');
    if (pick) { selectArticle(pick.dataset.code); return; }
    var add = ev.target.closest('.gz-sugg-add');
    if (add && add.dataset.code) {
      try {
        await bump(add.dataset.code, 1);
        selectArticle(add.dataset.code);
      } catch (err) {
        setManualMsg('Errore salvataggio: ' + err.message, false);
      }
    }
  });

  function setManualMsg(text, isOk) {
    var el = $('gzManualMsg');
    el.textContent = text;
    el.className = 'gz-msg' + (isOk ? ' ok' : '');
  }

  function currentCount(codice) {
    return righe.has(codice) ? righe.get(codice) : 0;
  }

  // Selezionato un articolo: -1/+1 e input lavorano su un valore in bozza (parte dal
  // conteggio attuale), che viene scritto su DB solo premendo Salva.
  function selectArticle(codice) {
    selectedCode = codice;
    var art = attExact.get(codice) || attMap.get(normKey(codice));
    var nome = art ? art.nome_articolo : null;
    $('gzSuggest').innerHTML = '';
    setManualMsg('', false);
    $('gzStepper').innerHTML =
      '<div class="gz-step-title">' + escapeHtml(nome || codice) + '</div>' +
      '<div class="gz-fb-sub">' + escapeHtml(codice) + ' &middot; ' +
      (art ? 'attesi ' + fmtNum(art.unita_attese) : 'non presente in giacenza attesa') + '</div>' +
      '<div class="gz-step-current">Contate ora: <b id="gzStepCurrent"></b></div>' +
      '<div class="gz-stepper">' +
      '<button type="button" class="pt-btn" id="gzStepMinus">&minus;1</button>' +
      '<input type="number" min="0" step="1" inputmode="numeric" id="gzStepInput" class="cfg-input">' +
      '<button type="button" class="pt-btn" id="gzStepPlus">+1</button>' +
      '</div>' +
      '<button type="button" class="pt-btn primary gz-step-save" id="gzStepSave">Salva</button>';
    $('gzStepInput').value = currentCount(codice);
    updateStepper();
  }

  // Il "Contate ora" segue i conteggi live (anche da scanner); l'input in bozza non si
  // tocca mai: un rerender mentre l'utente digita gli farebbe perdere il numero a metà.
  function updateStepper() {
    var cur = $('gzStepCurrent');
    if (!cur || selectedCode == null) return;
    cur.textContent = fmtNum(currentCount(selectedCode));
  }

  function resetManual() {
    selectedCode = null;
    $('gzStepper').innerHTML = '';
    $('gzSuggest').innerHTML = '';
    $('gzSearchInput').value = '';
    $('gzSearchInput').focus();
  }

  function stepDraft(delta) {
    var input = $('gzStepInput');
    if (!input) return;
    var v = parseFloat(input.value);
    input.value = Math.max(0, (isNaN(v) ? 0 : v) + delta);
  }

  async function saveManual() {
    var input = $('gzStepInput');
    var saveBtn = $('gzStepSave');
    if (!input || selectedCode == null) return;
    var v = parseFloat(input.value);
    if (isNaN(v) || v < 0) { setManualMsg('Inserisci un numero maggiore o uguale a zero.', false); return; }
    var codice = selectedCode;
    var art = attExact.get(codice) || attMap.get(normKey(codice));
    saveBtn.disabled = true;
    try {
      await setCount(codice, v); // aggiorna righe e ridisegna la tabella (scheduleRender) come lo scanner
      resetManual();
      setManualMsg('Salvato: ' + ((art && art.nome_articolo) || codice) + ' — ' + fmtNum(v), true);
    } catch (err) {
      saveBtn.disabled = false;
      setManualMsg('Errore salvataggio: ' + err.message, false);
    }
  }

  $('gzStepper').addEventListener('click', function (ev) {
    if (ev.target.closest('#gzStepPlus')) stepDraft(1);
    else if (ev.target.closest('#gzStepMinus')) stepDraft(-1);
    else if (ev.target.closest('#gzStepSave')) saveManual();
  });

  $('gzStepper').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && ev.target.id === 'gzStepInput') { ev.preventDefault(); saveManual(); }
  });

  // ================= TABELLA DI CONFRONTO =================
  function computeRows() {
    var main = attese.map(function (a) {
      var has = righe.has(a.codice);
      var c = has ? righe.get(a.codice) : null;
      var diff = has ? c - a.unita_attese : null;
      return {
        codice: a.codice, nome: a.nome_articolo || '', att: a.unita_attese, c: c, diff: diff,
        state: !has ? 'none' : (diff === 0 ? 'ok' : 'diff')
      };
    });
    var extras = [];
    righe.forEach(function (c, codice) {
      if (attExact.has(codice)) return;
      extras.push({ codice: codice, nome: '', att: 0, c: c, diff: c, state: c === 0 ? 'ok' : 'diff', extra: true });
    });
    extras.sort(function (a, b) { return a.codice < b.codice ? -1 : a.codice > b.codice ? 1 : 0; });
    return { main: main, extras: extras };
  }

  function passesFilter(r) {
    if (filter === 'diff') return r.state === 'diff';
    if (filter === 'none') return r.state === 'none';
    return true;
  }

  function rowHtml(r) {
    return '<tr class="gz-row gz-' + r.state + '">' +
      '<td class="gz-code">' + escapeHtml(r.codice) + '</td>' +
      '<td>' + escapeHtml(r.extra ? '—' : r.nome) + '</td>' +
      '<td class="gz-num">' + fmtNum(r.att) + '</td>' +
      '<td class="gz-num">' + (r.c == null ? '—' : fmtNum(r.c)) + '</td>' +
      '<td class="gz-num gz-diffcell">' + (r.diff == null ? '' : fmtDiff(r.diff)) + '</td>' +
      '</tr>';
  }

  function renderCompare() {
    if (mode === 'idle') return;
    var data = computeRows();
    var count = function (list, st) { return list.filter(function (r) { return r.state === st; }).length; };
    var tot = data.main.length;
    var none = count(data.main, 'none');
    $('gzSummary').innerHTML =
      '<span>Articoli <b>' + tot + '</b></span>' +
      '<span>Contati <b>' + (tot - none) + '</b></span>' +
      '<span class="gz-s-ok">Corretti <b>' + count(data.main, 'ok') + '</b></span>' +
      '<span class="gz-s-diff">Discrepanze <b>' + count(data.main, 'diff') + '</b></span>' +
      '<span>Non contati <b>' + none + '</b></span>' +
      (data.extras.length ? '<span class="gz-s-warn">Non in giacenza attesa <b>' + data.extras.length + '</b></span>' : '');

    $('gzFilters').querySelectorAll('.of-chip').forEach(function (b) {
      b.classList.toggle('active', b.dataset.filter === filter);
    });

    var main = data.main.filter(passesFilter);
    var extras = data.extras.filter(passesFilter);
    var html = main.map(rowHtml).join('');
    if (extras.length) {
      html += '<tr class="gz-sep"><td colspan="5">Non presenti in giacenza attesa</td></tr>' + extras.map(rowHtml).join('');
    }
    $('gzTbody').innerHTML = html || '<tr><td colspan="5" class="gz-empty">Nessuna riga per questo filtro.</td></tr>';
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () {
      renderQueued = false;
      renderCompare();
      updateStepper();
    });
  }

  $('gzFilters').addEventListener('click', function (ev) {
    var b = ev.target.closest('.of-chip');
    if (!b) return;
    filter = b.dataset.filter;
    renderCompare();
  });

  // ================= EXPORT EXCEL =================
  var STATE_LABEL = { ok: 'Corretto', diff: 'Discrepanza', none: 'Non contato' };
  var STATE_COLORS = {
    ok: { fill: 'FFDCF3E2', text: 'FF1A7A3C' },
    diff: { fill: 'FFFBDCDC', text: 'FFB02020' },
    none: { fill: 'FFEEF0F2', text: 'FF6B7280' }
  };
  var THIN_GRAY_BORDER = { style: 'thin', color: { argb: 'FFE2E4E7' } };

  $('gzExportBtn').addEventListener('click', function () { exportExcel(); });

  function exportExcel() {
    if (typeof ExcelJS === 'undefined') { alert('Libreria Excel non disponibile (controlla la connessione).'); return; }
    if (!sessione) return;
    var data = computeRows();
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Giacenze');
    ws.columns = [{ width: 20 }, { width: 46 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 22 }];

    ws.mergeCells('A1:F1');
    var banner = ws.getCell('A1');
    banner.value = {
      richText: [
        { font: { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }, text: 'Conteggio giacenze\n' },
        { font: { size: 10, color: { argb: 'FF8FE8FF' } },
          text: 'Iniziato il ' + fmtDateTime(sessione.iniziato_il) + (sessione.operatore ? ' da ' + sessione.operatore : '') +
            (sessione.completato_il ? ' · chiuso il ' + fmtDateTime(sessione.completato_il) : '') }
      ]
    };
    banner.alignment = { vertical: 'middle', wrapText: true };
    banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    ws.getRow(1).height = 38;

    var headRow = ws.getRow(3);
    ['CODICE', 'ARTICOLO', 'ATTESO', 'CONTATO', 'DIFFERENZA', 'STATO'].forEach(function (t, i) {
      var c = headRow.getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: 'FF4FC8E8' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
      c.alignment = { vertical: 'middle', horizontal: i >= 2 && i <= 4 ? 'right' : 'left' };
    });

    var rowIdx = 4;
    function addRow(r, label) {
      // Un articolo mai contato risulta 0 nel file finale (e quindi -atteso di differenza):
      // la colonna STATO lo distingue da un articolo contato davvero a 0.
      var contato = r.c == null ? 0 : r.c;
      var diff = contato - r.att;
      var colors = STATE_COLORS[r.state];
      var vals = [r.codice, r.nome, r.att, contato, diff, label || STATE_LABEL[r.state]];
      vals.forEach(function (v, i) {
        var cell = ws.getCell(rowIdx, i + 1);
        cell.value = v;
        cell.border = { top: THIN_GRAY_BORDER, left: THIN_GRAY_BORDER, bottom: THIN_GRAY_BORDER, right: THIN_GRAY_BORDER };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.fill } };
        cell.font = { color: { argb: colors.text }, bold: i === 4 && r.state === 'diff' };
        if (i >= 2 && i <= 4) cell.alignment = { horizontal: 'right' };
        if (i === 4) cell.numFmt = '+0.###;-0.###;0';
      });
      rowIdx++;
    }

    data.main.forEach(function (r) { addRow(r); });
    if (data.extras.length) {
      ws.mergeCells('A' + rowIdx + ':F' + rowIdx);
      var sep = ws.getCell('A' + rowIdx);
      sep.value = 'Non presenti in giacenza attesa';
      sep.font = { bold: true, color: { argb: 'FF8FE8FF' } };
      sep.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D1924' } };
      rowIdx++;
      data.extras.forEach(function (r) { addRow(r, 'Non in giacenza attesa'); });
    }

    ws.views = [{ state: 'frozen', ySplit: 3 }];

    var stamp = (sessione.completato_il || sessione.iniziato_il || new Date().toISOString()).slice(0, 10);
    wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'Giacenze_' + stamp + '.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // ================= IMPORT UI =================
  $('gzImportBtn').addEventListener('click', function () { $('gzImportFile').click(); });
  $('gzImportFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) importFile(f);
  });

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'giacenze') { stopScanner(); return; }
    applyMode();
    loadAll();
  });

  // Se il browser passa in background (es. si blocca lo schermo) la fotocamera va rilasciata.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopScanner();
  });
})();
