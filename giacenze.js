(function () {
  var COOLDOWN_MS = 1500; // stesso barcode non ricontato finché non sparisce dall'inquadratura per almeno tanto
  var UPSERT_CHUNK = 500;
  var DELETE_CHUNK = 100;
  var MANUAL_MAX_RESULTS = 10; // risultati mostrati dal typeahead della ricerca manuale / assegnazione EAN
  var FONTE_KEY = 'gz_confronto_fonte'; // localStorage: ultima fonte usata per il confronto

  // ---- giacenza attesa (due fonti: 'giacenze' aggregate, 'export' per unità) ----
  var attese = []; // TUTTE le righe, entrambe le fonti: [{fonte, codice, nome_articolo, unita_attese, importato_il}]
  var atteseHay = []; // stringhe minuscole "codice nome" parallele ad attese, per la ricerca
  var attMap = new Map(); // chiave normalizzata -> riga di attese (dedup fra fonti, per display)
  var attExact = new Map(); // codice esatto -> riga di attese (idem)
  var confrontoFonte = localStorage.getItem(FONTE_KEY) || 'giacenze';

  // ---- Listino SBS: mappatura EAN -> codice, fonte primaria ----
  var eanMap = new Map(); // barcodeKey(EAN) -> {codice, descrizione, pvp}
  var eanList = []; // stessa mappa in array deduplicato per codice, per la ricerca di assegnazione
  var eanHay = [];
  var barcodeMap = new Map(); // barcodeKey(barcode) -> {codice}: collegamenti fatti a mano sul campo

  // ---- sessioni di conteggio ----
  var sessioni = []; // elenco per il pannello "Sessioni"
  var sessione = null; // riga di wt_giacenze_conteggio aperta nel dettaglio
  var mode = 'idle'; // 'idle' | 'active' | 'readonly'
  var panel = 'list'; // 'list' (elenco sessioni) | 'detail' (conteggio di una sessione)
  var righe = new Map(); // codice esatto -> {unita_contate, corretto, corretto_il, differenza_al_momento_correzione, note}
  var righeKeys = new Map(); // chiave normalizzata -> codice esatto in righe
  var filter = 'all'; // 'all' | 'daCorrere' | 'corrette'

  // ---- EAN non risolti (per la sessione aperta) ----
  var eanNonRisolti = []; // [{id, ean, quantita, creato_il}]
  var assignedThisSession = []; // solo in memoria: [{ean, codice, nome, quantita}] assegnati in questo caricamento pagina
  var assigningEan = null; // ean per cui è aperto il select di assegnazione

  // ---- scanner fotocamera ----
  var scanner = null; // istanza Html5Qrcode, usata solo dal backend di fallback
  var scannerRunning = false;
  var backend = null; // 'native' (BarcodeDetector) | 'html5qrcode' (fallback) | null
  var nativeStream = null;
  var nativeDetector = null;
  var nativeRAF = null;
  var nativeActive = false;
  var nativeBusy = false; // true mentre un detect() è in volo, per non accodarne un altro
  var nativeFrameCount = 0;
  var nativeCanvas = document.createElement('canvas');
  var nativeCtx = nativeCanvas.getContext('2d', { willReadFrequently: true });
  var torchOn = false;
  var lastSeen = {}; // chiave normalizzata -> timestamp dell'ultima decodifica (anche se ignorata)
  var lastScan = null; // ultimo codice incrementato con successo da uno scan in questa sessione d'uso pagina (per "Annulla ultima scansione")
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

  // Chiave per confrontare i barcode: come normKey, ma i barcode solo numerici perdono gli zeri
  // iniziali, così lo stesso EAN letto come UPC-A (12 cifre) o EAN-13 (con lo 0 davanti) coincide.
  function barcodeKey(s) {
    var t = normKey(s);
    return /^\d+$/.test(t) ? (t.replace(/^0+/, '') || '0') : t;
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

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('it-IT');
  }

  function todayItDate() {
    var d = new Date();
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
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

  // Elimina a blocchi con .in(col, valori): usato per il "truncate" via DML (la anon key non
  // può fare DDL) di una porzione di tabella prima di un import.
  async function deleteInChunks(table, col, values) {
    for (var i = 0; i < values.length; i += DELETE_CHUNK) {
      var del = await sb.from(table).delete().in(col, values.slice(i, i + DELETE_CHUNK));
      if (del.error) throw del.error;
    }
  }

  async function insertInChunks(table, rows) {
    for (var i = 0; i < rows.length; i += UPSERT_CHUNK) {
      var ins = await sb.from(table).insert(rows.slice(i, i + UPSERT_CHUNK));
      if (ins.error) throw ins.error;
    }
  }

  // ================= LETTURA FILE =================
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

  // Nome colonna -> chiave confrontabile (solo lettere minuscole, senza accenti):
  // "Codice EAN" -> "codiceean", "IMEI / SN" -> "imeisn".
  function headerKey(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  }

  // "12", "12,5", "1.234", "1.234,50" -> numero. Restituisce NaN se non è un numero.
  function parseQty(raw) {
    var s = String(raw == null ? '' : raw).replace(/\s/g, '');
    if (s === '') return 0;
    if (s.indexOf(',') > -1) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }

  // ================= LISTINO SBS (import EAN -> codice, fonte primaria) =================
  // Le colonne esatte del Listino SBS non sono confermate: si cerca per corrispondenza
  // case-insensitive su varianti comuni dei nomi header, così un piccolo scarto nei nomi
  // reali richiede solo di aggiungere una variante qui, non di riscrivere il parsing.
  var LISTINO_VARIANTS = {
    ean: ['ean', 'codiceean', 'barcode'],
    codice: ['codice', 'codarticolo'],
    descrizione: ['descrizione', 'nome', 'articolo', 'nomearticolo'],
    pvp: ['pvp', 'prezzo', 'prezzovendita']
  };

  // headers: array di stringhe grezze lette dal file. Ritorna {ean, codice, descrizione, pvp}
  // con l'indice di colonna trovato (-1 se assente) e l'elenco di header non riconosciuti,
  // per un messaggio d'errore leggibile se il file reale usa nomi diversi da quelli previsti.
  function resolveColumns(headers, variants) {
    var keys = headers.map(headerKey);
    var out = {};
    Object.keys(variants).forEach(function (field) {
      var idx = -1;
      variants[field].some(function (v) {
        var i = keys.indexOf(v);
        if (i > -1) { idx = i; return true; }
        return false;
      });
      out[field] = idx;
    });
    return out;
  }

  function parseListinoRows(headers, rows) {
    var cols = resolveColumns(headers, LISTINO_VARIANTS);
    if (cols.ean === -1 || cols.codice === -1) {
      throw new Error('Colonne EAN e/o Codice non riconosciute nel Listino SBS (intestazioni lette: ' +
        (headers.join(' | ') || 'nessuna') + '). Controlla i nomi delle colonne nel file.');
    }
    var out = [];
    var skipped = 0;
    rows.forEach(function (cells) {
      var ean = String(cells[cols.ean] == null ? '' : cells[cols.ean]).trim();
      var codice = String(cells[cols.codice] == null ? '' : cells[cols.codice]).trim();
      if (!ean || !codice) { skipped++; return; }
      var descrizione = cols.descrizione > -1 ? String(cells[cols.descrizione] == null ? '' : cells[cols.descrizione]).trim() : '';
      var pvpRaw = cols.pvp > -1 ? cells[cols.pvp] : null;
      var pvp = pvpRaw == null || pvpRaw === '' ? null : parseQty(pvpRaw);
      out.push({ ean: ean, codice: codice, descrizione: descrizione || null, pvp: isNaN(pvp) ? null : pvp });
    });
    return { rows: out, skipped: skipped, colsFound: cols };
  }

  async function parseListinoFile(file) {
    var isXlsx = /\.xlsx?$/i.test(file.name);
    if (isXlsx) {
      if (typeof XLSX === 'undefined') throw new Error('Libreria XLSX non disponibile (controlla la connessione).');
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      // L'header potrebbe non essere la prima riga (titolo/riga vuota sopra): si cerca fra
      // le prime righe quella che permette di risolvere sia EAN sia Codice.
      var headerIdx = -1, cols = null;
      for (var i = 0; i < Math.min(10, allRows.length); i++) {
        var hs = (allRows[i] || []).map(function (v) { return v == null ? '' : String(v); });
        var c = resolveColumns(hs, LISTINO_VARIANTS);
        if (c.ean > -1 && c.codice > -1) { headerIdx = i; cols = c; break; }
      }
      if (headerIdx === -1) {
        throw new Error('Intestazioni EAN/Codice non trovate nelle prime righe del file XLSX.');
      }
      var headers = (allRows[headerIdx] || []).map(function (v) { return v == null ? '' : String(v); });
      var dataRows = allRows.slice(headerIdx + 1).filter(function (r) { return r && r.length; });
      return parseListinoRows(headers, dataRows);
    }
    if (typeof Papa === 'undefined') throw new Error('Libreria CSV non disponibile (controlla la connessione).');
    var text = await readFileText(file);
    var rawHeaders = [];
    var res = Papa.parse(text.replace(/^﻿/, ''), {
      header: false,
      skipEmptyLines: 'greedy'
    });
    var data = res.data || [];
    if (!data.length) throw new Error('File CSV vuoto.');
    var headers2 = (data[0] || []).map(function (v) { return v == null ? '' : String(v); });
    return parseListinoRows(headers2, data.slice(1));
  }

  async function importListino(file) {
    var btn = $('gzImportListinoBtn');
    if (!isSuperAdmin()) return;
    btn.disabled = true;
    setListinoInfo('Lettura file...', '');
    try {
      var parsed = await parseListinoFile(file);
      if (!parsed.rows.length) throw new Error('Nessuna riga valida (EAN e Codice non vuoti) trovata nel Listino SBS.');
      var note = parsed.skipped ? '\n' + parsed.skipped + ' righe scartate (EAN o Codice mancante).' : '';
      if (!confirm('Sostituire il Listino SBS con ' + parsed.rows.length + ' articoli?' + note)) {
        setListinoInfo('Import annullato.', '');
        return;
      }
      var now = new Date().toISOString();
      var payload = parsed.rows.map(function (r) {
        return { ean: r.ean, codice: r.codice, descrizione: r.descrizione, pvp: r.pvp, aggiornato_il: now };
      });
      setListinoInfo('Svuotamento e salvataggio di ' + payload.length + ' articoli...', '');
      // TRUNCATE via DML (la anon key non può fare DDL): elimina tutto, poi inserisce in blocco.
      var existing = await fetchAllRows('wt_giacenze_ean', 'ean');
      if (existing.length) await deleteInChunks('wt_giacenze_ean', 'ean', existing.map(function (r) { return r.ean; }));
      await insertInChunks('wt_giacenze_ean', payload);
      await loadEanMaps();
      scheduleRender();
      setListinoInfo(payload.length + ' articoli nel listino importati — aggiornati il ' + fmtDateTime(now), 'ok');
    } catch (err) {
      console.error('Errore import Listino SBS:', err);
      setListinoInfo('Errore import Listino SBS: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      $('gzListinoFile').value = '';
    }
  }

  function setListinoInfo(msg, cls) {
    var el = $('gzListinoInfo');
    if (!el) return;
    el.textContent = msg;
    el.className = 'gz-info' + (cls ? ' ' + cls : '');
  }

  function renderListinoInfo() {
    if (!eanMap.size) { setListinoInfo('Nessun Listino SBS importato.', ''); return; }
    setListinoInfo(eanMap.size + ' codici EAN nel Listino SBS.', '');
  }

  $('gzImportListinoBtn').addEventListener('click', function () { $('gzListinoFile').click(); });
  $('gzListinoFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) importListino(f);
  });

  // ================= IMPORT GIACENZE ATTESE: "Giacenze aggregate" (fonte='giacenze') =================
  // Il file del gestionale a volte è un vero CSV, a volte un .xls che in realtà è HTML: si
  // guarda il contenuto, non l'estensione, per scegliere come leggerlo.
  function detectAggregateFormat(text) {
    var head = text.slice(0, 2000).toLowerCase();
    return (head.indexOf('<table') > -1 || head.indexOf('<html') > -1) ? 'html' : 'csv';
  }

  // Trova la colonna "Unità" del negozio dall'header: è quella subito prima di "Costo".
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

  // Raggruppamento per Codice condiviso da entrambe le sorgenti (HTML-come-xls e CSV vero) di
  // "Giacenze aggregate": stessa logica, cambia solo da dove arrivano headers/righe di celle.
  function groupAggregateRows(headers, rowsOfCells) {
    var colCount = headers.length || (rowsOfCells[0] || []).length;
    var unitCol = findUnitCol(headers, colCount);
    if (unitCol < 2) throw new Error('Colonna delle unità non riconosciuta (header: ' + (headers.join(' | ') || 'assente') + ').');

    var byCode = new Map();
    var skipped = 0, merged = 0;
    rowsOfCells.forEach(function (cells) {
      var codice = String(cells[0] == null ? '' : cells[0]).trim();
      var nome = String(cells[1] == null ? '' : cells[1]).trim();
      if (!codice || /^totale:?$/i.test(codice) || /^totale:?$/i.test(nome)) return;
      var unita = parseQty(cells[unitCol]);
      if (isNaN(unita)) { skipped++; return; }
      var prev = byCode.get(codice);
      if (prev) {
        prev.unita_attese += unita;
        if (!prev.nome_articolo && nome) prev.nome_articolo = nome;
        merged++;
      } else {
        byCode.set(codice, { codice: codice, nome_articolo: nome || null, unita_attese: unita });
      }
    });

    // La Descrizione è opzionale: mai escludere una riga per questo, il Codice fa da fallback.
    var rows = Array.from(byCode.values()).map(function (r) {
      if (!r.nome_articolo) r.nome_articolo = r.codice;
      return r;
    });
    return { rows: rows, skipped: skipped, merged: merged, unitLabel: headers[unitCol] || ('colonna ' + (unitCol + 1)) };
  }

  function parseAggregateHtml(text) {
    var doc = new DOMParser().parseFromString(text, 'text/html');
    var table = doc.querySelector('table[id^="DataTables_Table"]') || doc.querySelector('table');
    if (!table) throw new Error('Nessuna tabella trovata nel file.');
    var headRow = table.querySelector('thead tr') ||
      Array.from(table.querySelectorAll('tr')).filter(function (tr) { return tr.querySelector('th'); })[0] || null;
    var headers = headRow ? Array.from(headRow.children).map(cellText) : [];
    var trs = Array.from(table.querySelectorAll('tbody tr, tr')).filter(function (tr) {
      return tr !== headRow && tr.querySelectorAll('td').length > 0;
    });
    if (!trs.length) throw new Error('La tabella non contiene righe.');
    var rowsOfCells = trs.map(function (tr) { return Array.from(tr.querySelectorAll('td')).map(cellText); });
    return groupAggregateRows(headers, rowsOfCells);
  }

  function parseAggregateCsv(text) {
    if (typeof Papa === 'undefined') throw new Error('Libreria CSV non disponibile (controlla la connessione).');
    var res = Papa.parse(text.replace(/^﻿/, ''), { header: false, skipEmptyLines: 'greedy' });
    var data = res.data || [];
    if (!data.length) throw new Error('File CSV vuoto.');
    var headers = (data[0] || []).map(function (v) { return v == null ? '' : String(v); });
    var rowsOfCells = data.slice(1);
    return groupAggregateRows(headers, rowsOfCells);
  }

  async function parseAggregateFile(file) {
    var text = await readFileText(file);
    return detectAggregateFormat(text) === 'html' ? parseAggregateHtml(text) : parseAggregateCsv(text);
  }

  // ================= IMPORT GIACENZE ATTESE: "Export magazzino per unità" (fonte='export') =================
  // Ogni riga del CSV è UNA unità fisica. Solo Stato = GIACENZA entra nelle giacenze attese
  // (unità = numero di righe per Codice). Il Listino SBS è ora l'unica fonte per l'EAN: questo
  // import NON scrive più su wt_giacenze_ean (la colonna Codice EAN, se presente, è ignorata).
  function parseExportCsv(text) {
    if (typeof Papa === 'undefined') throw new Error('Libreria CSV non disponibile (controlla la connessione).');
    var rawHeaders = [];
    var res = Papa.parse(text.replace(/^﻿/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: function (h) { rawHeaders.push(h); return headerKey(h); }
    });
    var fields = res.meta.fields || [];
    if (fields.indexOf('stato') === -1 || fields.indexOf('codice') === -1) {
      throw new Error('Colonne "Stato" e "Codice" non trovate (intestazioni lette: ' + (rawHeaders.join(' | ') || 'nessuna') + ').');
    }

    var byCode = new Map();
    var stats = { righe: res.data.length, nonGiacenza: 0, senzaCodice: 0 };
    res.data.forEach(function (r) {
      var codice = String(r.codice == null ? '' : r.codice).trim();
      var descrizione = String(r.descrizione == null ? '' : r.descrizione).trim();
      if (String(r.stato == null ? '' : r.stato).trim().toUpperCase() !== 'GIACENZA') { stats.nonGiacenza++; return; }
      if (!codice) { stats.senzaCodice++; return; }
      var prev = byCode.get(codice);
      if (prev) {
        prev.unita_attese++;
        if (!prev.nome_articolo && descrizione) prev.nome_articolo = descrizione;
      } else {
        byCode.set(codice, { codice: codice, nome_articolo: descrizione || null, unita_attese: 1 });
      }
    });

    var rows = Array.from(byCode.values()).map(function (r) {
      if (!r.nome_articolo) r.nome_articolo = r.codice;
      return r;
    });
    return {
      rows: rows,
      unitaTotali: rows.reduce(function (s, r) { return s + r.unita_attese; }, 0),
      stats: stats
    };
  }

  async function writeAttese(fonte, rows) {
    var now = new Date().toISOString();
    var payload = rows.map(function (r) {
      return { fonte: fonte, codice: r.codice, nome_articolo: r.nome_articolo, unita_attese: r.unita_attese, importato_il: now };
    });
    // TRUNCATE via DML (solo le righe di questa fonte) e poi insert in blocco, come richiesto.
    // Non è atomico (la anon key non ha transazioni multi-request): se l'insert fallisse dopo il
    // delete, un nuovo tentativo di import ripulisce di nuovo e reinserisce, quindi è ripetibile.
    var existing = await fetchAllRows('wt_giacenze_attese', 'codice', function (q) { return q.eq('fonte', fonte); });
    if (existing.length) await deleteInChunks('wt_giacenze_attese', 'codice', existing.map(function (r) { return r.codice; }));
    await insertInChunks('wt_giacenze_attese', payload);
    return payload.length;
  }

  async function importAggregate(file) {
    var parsed = await parseAggregateFile(file);
    if (!parsed.rows.length) throw new Error('Nessun articolo valido trovato nel file.');
    return {
      tipo: 'giacenze',
      parsed: parsed,
      confirmMsg: 'Sostituire la giacenza attesa "Giacenze aggregate" con ' + parsed.rows.length + ' articoli?\n' +
        'Colonna unità letta: "' + parsed.unitLabel + '".' +
        (parsed.merged ? '\n' + parsed.merged + ' righe con codice duplicato sommate.' : '') +
        (parsed.skipped ? '\n' + parsed.skipped + ' righe scartate (unità non numeriche).' : ''),
      commit: async function () {
        var n = await writeAttese('giacenze', parsed.rows);
        return n + ' articoli distinti importati (fonte "Giacenze aggregate").';
      }
    };
  }

  async function importExport(file) {
    var text = await readFileText(file);
    var parsed = parseExportCsv(text);
    if (!parsed.rows.length) {
      throw new Error('Nessuna riga con Stato = GIACENZA trovata (' + parsed.stats.righe + ' righe lette).');
    }
    var st = parsed.stats;
    return {
      tipo: 'export',
      parsed: parsed,
      confirmMsg: 'Sostituire la giacenza attesa "Export magazzino" con ' + parsed.rows.length + ' articoli distinti (' +
        parsed.unitaTotali + ' unità)?' +
        (st.nonGiacenza ? '\n' + st.nonGiacenza + ' righe con stato diverso da GIACENZA ignorate.' : '') +
        (st.senzaCodice ? '\n' + st.senzaCodice + ' righe in giacenza senza Codice scartate.' : ''),
      commit: async function () {
        var n = await writeAttese('export', parsed.rows);
        return n + ' articoli distinti importati (' + parsed.unitaTotali + ' unità totali, fonte "Export magazzino").';
      }
    };
  }

  // ================= MODALE IMPORT GIACENZE =================
  var importPrepared = null; // {tipo, parsed, confirmMsg, commit} in attesa di conferma

  function openImportModal() {
    importPrepared = null;
    $('gzImportModalFile').value = '';
    $('gzImportModalSummary').innerHTML = '';
    $('gzImportModalSummary').classList.add('hidden');
    $('gzImportModalConfirm').classList.add('hidden');
    $('gzImportModalPickWrap').classList.remove('hidden');
    $('gzImportModalMsg').textContent = '';
    $('gzImportModalBackdrop').classList.remove('hidden');
  }
  function closeImportModal() {
    $('gzImportModalBackdrop').classList.add('hidden');
    importPrepared = null;
  }
  $('gzImportModalClose').addEventListener('click', closeImportModal);
  $('gzImportModalCancel').addEventListener('click', closeImportModal);
  $('gzImportModalBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'gzImportModalBackdrop') closeImportModal();
  });

  $('gzImportGiacenzeBtn').addEventListener('click', function () { if (isSuperAdmin()) openImportModal(); });

  $('gzImportModalFile').addEventListener('change', async function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var tipo = $('gzImportTipoExport').checked ? 'export' : 'giacenze';
    $('gzImportModalMsg').textContent = 'Lettura file...';
    try {
      var prepared = tipo === 'export' ? await importExport(f) : await importAggregate(f);
      importPrepared = prepared;
      $('gzImportModalMsg').textContent = '';
      $('gzImportModalSummary').textContent = prepared.confirmMsg;
      $('gzImportModalSummary').classList.remove('hidden');
      $('gzImportModalConfirm').classList.remove('hidden');
      $('gzImportModalPickWrap').classList.add('hidden');
    } catch (err) {
      console.error('Errore lettura import giacenze:', err);
      $('gzImportModalMsg').textContent = 'Errore: ' + err.message;
      importPrepared = null;
    }
  });

  $('gzImportModalConfirm').addEventListener('click', async function () {
    if (!importPrepared) return;
    var btn = this;
    btn.disabled = true;
    $('gzImportModalMsg').textContent = 'Salvataggio...';
    try {
      var msg = await importPrepared.commit();
      await loadAttese();
      scheduleRender();
      closeImportModal();
      setAtteseInfo(msg, 'ok');
    } catch (err) {
      console.error('Errore import giacenze:', err);
      $('gzImportModalMsg').textContent = 'Errore: ' + err.message;
    } finally {
      btn.disabled = false;
    }
  });

  function setAtteseInfo(msg, cls) {
    var el = $('gzImportInfo');
    el.textContent = msg;
    el.className = 'gz-info' + (cls ? ' ' + cls : '');
  }

  function renderAtteseInfo() {
    if (!attese.length) {
      setAtteseInfo('Nessuna giacenza attesa importata.' + (isSuperAdmin() ? '' : ' Chiedi a un SuperAdmin di importarla.'), '');
      return;
    }
    var perFonte = function (f) {
      var rows = attese.filter(function (a) { return a.fonte === f; });
      if (!rows.length) return null;
      var last = rows.reduce(function (m, r) { return r.importato_il > m ? r.importato_il : m; }, '');
      var unita = rows.reduce(function (s, r) { return s + r.unita_attese; }, 0);
      return rows.length + ' articoli (' + fmtNum(unita) + ' unità) · aggiornati il ' + fmtDateTime(last);
    };
    var g = perFonte('giacenze'), e = perFonte('export');
    setAtteseInfo('Giacenze aggregate: ' + (g || 'non importate') + ' — Export magazzino: ' + (e || 'non importato'), '');
  }

  // ================= LOAD =================
  function atteseFonte(f) { return attese.filter(function (a) { return a.fonte === f; }); }

  async function loadAttese() {
    attese = await fetchAllRows('wt_giacenze_attese', '*', function (q) { return q.order('codice'); });
    attese.forEach(function (a) { a.unita_attese = Number(a.unita_attese) || 0; });
    atteseHay = attese.map(function (a) { return (a.codice + ' ' + (a.nome_articolo || '')).toLowerCase(); });
    attMap = new Map();
    attExact = new Map();
    attese.forEach(function (a) {
      var k = normKey(a.codice);
      attMap.set(k, a);
      attExact.set(a.codice, a);
    });
    renderAtteseInfo();
  }

  // Le mappe EAN/barcode si tengono in memoria (come le attese): la scansione non aspetta una
  // query. Se una tabella non c'è ancora (migration non eseguita) lo scanner continua a
  // funzionare con le altre fonti, ma l'errore viene mostrato, non nascosto.
  async function loadEanMaps() {
    var problemi = [];
    try {
      var eans = await fetchAllRows('wt_giacenze_ean', '*', function (q) { return q.order('ean'); });
      eanMap = new Map();
      var byCode = new Map();
      eans.forEach(function (r) {
        eanMap.set(barcodeKey(r.ean), { codice: r.codice, descrizione: r.descrizione, pvp: r.pvp });
        if (!byCode.has(r.codice)) byCode.set(r.codice, { codice: r.codice, descrizione: r.descrizione });
      });
      eanList = Array.from(byCode.values());
      eanHay = eanList.map(function (e) { return (e.codice + ' ' + (e.descrizione || '')).toLowerCase(); });
      renderListinoInfo();
    } catch (err) {
      console.error('Errore caricamento wt_giacenze_ean:', err);
      problemi.push('wt_giacenze_ean: ' + err.message);
    }
    try {
      var bcs = await fetchAllRows('wt_giacenze_barcode_map', '*', function (q) { return q.order('barcode'); });
      barcodeMap = new Map();
      bcs.forEach(function (r) { barcodeMap.set(barcodeKey(r.barcode), { codice: r.codice }); });
    } catch (err) {
      console.error('Errore caricamento wt_giacenze_barcode_map:', err);
      problemi.push('wt_giacenze_barcode_map: ' + err.message);
    }
    if (problemi.length) {
      throw new Error('Mappatura barcode non caricata (' + problemi.join('; ') + ') — hai eseguito le migration in tools/ su Supabase?');
    }
  }

  function rigaFromRow(r) {
    return {
      unita_contate: Number(r.unita_contate) || 0,
      corretto: !!r.corretto,
      corretto_il: r.corretto_il || null,
      differenza_al_momento_correzione: r.differenza_al_momento_correzione == null ? null : Number(r.differenza_al_momento_correzione),
      note: r.note || ''
    };
  }

  function setRigaLocal(codice, patch) {
    var prev = righe.get(codice) || { unita_contate: 0, corretto: false, corretto_il: null, differenza_al_momento_correzione: null, note: '' };
    var next = Object.assign({}, prev, patch);
    righe.set(codice, next);
    righeKeys.set(normKey(codice), codice);
    return next;
  }

  async function loadRighe() {
    righe = new Map();
    righeKeys = new Map();
    if (!sessione) return;
    var rows = await fetchAllRows('wt_giacenze_conteggio_righe',
      'codice, unita_contate, corretto, corretto_il, differenza_al_momento_correzione, note',
      function (q) { return q.eq('conteggio_id', sessione.id).order('codice'); });
    rows.forEach(function (r) { setRigaLocal(r.codice, rigaFromRow(r)); });
  }

  async function loadEanNonRisolti() {
    eanNonRisolti = [];
    if (!sessione) return;
    eanNonRisolti = await fetchAllRows('wt_giacenze_ean_non_risolti', 'id, ean, quantita, creato_il',
      function (q) { return q.eq('conteggio_id', sessione.id).order('creato_il'); });
    eanNonRisolti.forEach(function (r) { r.quantita = Number(r.quantita) || 0; });
  }

  async function loadAll() {
    try {
      await loadAttese();
      var mapError = null;
      try { await loadEanMaps(); } catch (e) { mapError = e; }
      if (mapError) setListinoInfo(mapError.message, 'err');
      await loadSessioni();
      applyPanel();
      scheduleRender();
    } catch (err) {
      console.error('Errore caricamento giacenze:', err);
      setAtteseInfo('Errore caricamento: ' + err.message + ' (hai eseguito le migration in tools/ su Supabase?)', 'err');
    }
  }

  // ================= SESSIONI =================
  async function loadSessioni() {
    var res = await sb.from('wt_giacenze_conteggio')
      .select('*, wt_giacenze_conteggio_righe(count)')
      .order('iniziato_il', { ascending: false });
    if (res.error) throw res.error;
    sessioni = (res.data || []).map(function (r) {
      var righeCount = (r.wt_giacenze_conteggio_righe && r.wt_giacenze_conteggio_righe[0] && r.wt_giacenze_conteggio_righe[0].count) || 0;
      return {
        id: r.id, nome: r.nome, stato: r.stato, operatore: r.operatore,
        iniziato_il: r.iniziato_il, completato_il: r.completato_il, righeCount: righeCount
      };
    });
  }

  function renderSessioni() {
    var body = $('gzSessionsBody');
    if (!sessioni.length) {
      body.innerHTML = '<tr><td colspan="5" class="gz-empty">Nessuna sessione di conteggio. Creane una con "Nuova sessione".</td></tr>';
      return;
    }
    body.innerHTML = sessioni.map(function (s) {
      var statoLabel = s.stato === 'in_corso' ? 'In corso' : (s.stato === 'completato' ? 'Completato' : 'Abbandonato');
      return '<tr class="gz-sess-row" data-id="' + escapeHtml(s.id) + '">' +
        '<td class="gz-code">' + escapeHtml(s.nome || '(senza nome)') + '</td>' +
        '<td>' + fmtDate(s.iniziato_il) + (s.operatore ? ' · ' + escapeHtml(s.operatore) : '') + '</td>' +
        '<td><span class="gz-badge gz-badge-' + s.stato + '">' + statoLabel + '</span></td>' +
        '<td class="gz-num">' + s.righeCount + '</td>' +
        '<td><button type="button" class="pt-btn gz-sess-open">Apri</button></td>' +
        '</tr>';
    }).join('');
  }

  $('gzSessionsBody').addEventListener('click', function (ev) {
    var row = ev.target.closest('.gz-sess-row');
    if (!row) return;
    var id = row.dataset.id;
    var s = sessioni.find(function (x) { return x.id === id; });
    if (s) apriSessione(s.id, s.stato);
  });

  $('gzNewSessionBtn').addEventListener('click', async function () {
    if (!attese.length) {
      alert('Nessuna giacenza attesa importata: senza non c\'è nulla con cui confrontare il conteggio.' +
        (isSuperAdmin() ? '' : ' Chiedi a un SuperAdmin di importarla.'));
      return;
    }
    var nome = prompt('Nome della nuova sessione di conteggio:', todayItDate());
    if (nome == null) return; // annullato
    nome = nome.trim() || todayItDate();
    var btn = this;
    btn.disabled = true;
    try {
      var res = await sb.from('wt_giacenze_conteggio').insert({ operatore: operatoreCorrente(), stato: 'in_corso', nome: nome }).select().single();
      if (res.error) throw res.error;
      await loadSessioni();
      renderSessioni();
      await apriSessione(res.data.id, 'in_corso');
    } catch (err) {
      alert('Errore creazione sessione: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  async function apriSessione(id, stato) {
    try {
      var res = await sb.from('wt_giacenze_conteggio').select('*').eq('id', id).single();
      if (res.error) throw res.error;
      sessione = res.data;
      mode = stato === 'completato' ? 'readonly' : 'active';
      panel = 'detail';
      lastSeen = {};
      lastScan = null;
      selectedCode = null;
      assignedThisSession = [];
      resetInputArea();
      await Promise.all([loadRighe(), loadEanNonRisolti()]);
      applyPanel();
      scheduleRender();
      renderEanNonRisolti();
    } catch (err) {
      alert('Errore apertura sessione: ' + err.message);
    }
  }

  $('gzBackToListBtn').addEventListener('click', async function () {
    stopScanner();
    panel = 'list';
    sessione = null;
    mode = 'idle';
    await loadSessioni();
    applyPanel();
  });

  $('gzEndBtn').addEventListener('click', async function () {
    if (mode !== 'active' || !sessione) return;
    var data = computeRows();
    var nonContati = data.main.filter(function (r) { return r.state === 'none'; }).length;
    if (!confirm('Terminare il conteggio "' + (sessione.nome || '') + '"?' +
      (nonContati ? '\n' + nonContati + ' articoli non risultano ancora contati.' : '') +
      '\nDopo la chiusura non sarà più modificabile.')) return;
    try {
      var upd = await sb.from('wt_giacenze_conteggio')
        .update({ stato: 'completato', completato_il: new Date().toISOString() })
        .eq('id', sessione.id).select().single();
      if (upd.error) throw upd.error;
      sessione = upd.data;
      mode = 'readonly';
      stopScanner();
      applyPanel();
      scheduleRender();
    } catch (err) {
      alert('Errore chiusura conteggio: ' + err.message);
    }
  });

  // ================= AZZERA CONTEGGIO =================
  $('gzResetCountBtn').addEventListener('click', async function () {
    if (mode !== 'active' || !sessione) return;
    if (!confirm('Sei sicuro di voler azzerare il conteggio "' + (sessione.nome || '') + '"?\n' +
      'Tutte le unità contate torneranno a 0 (le righe non vengono eliminate) e gli EAN non risolti in attesa verranno svuotati.\n' +
      'Questa operazione non è reversibile.')) return;
    var btn = this;
    btn.disabled = true;
    try {
      var codes = Array.from(righe.keys());
      if (codes.length) {
        var now = new Date().toISOString();
        for (var i = 0; i < codes.length; i += UPSERT_CHUNK) {
          var batch = codes.slice(i, i + UPSERT_CHUNK).map(function (c) {
            return { conteggio_id: sessione.id, codice: c, unita_contate: 0, updated_at: now };
          });
          var up = await sb.from('wt_giacenze_conteggio_righe').upsert(batch, { onConflict: 'conteggio_id,codice' });
          if (up.error) throw up.error;
        }
      }
      var ids = eanNonRisolti.map(function (r) { return r.id; });
      if (ids.length) await deleteInChunks('wt_giacenze_ean_non_risolti', 'id', ids);
      lastScan = null;
      assignedThisSession = [];
      await Promise.all([loadRighe(), loadEanNonRisolti()]);
      scheduleRender();
      renderEanNonRisolti();
    } catch (err) {
      alert('Errore azzeramento conteggio: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function resetInputArea() {
    $('gzFeedback').className = 'gz-feedback hidden';
    $('gzFeedback').innerHTML = '';
    $('gzSearchInput').value = '';
    $('gzSuggest').innerHTML = '';
    $('gzStepper').innerHTML = '';
    setManualMsg('', false);
  }

  // ================= MODE / VISIBILITÀ =================
  function applyPanel() {
    $('gzImportGiacenzeBtn').classList.toggle('hidden', !isSuperAdmin());
    $('gzImportListinoBtn').classList.toggle('hidden', !isSuperAdmin());

    var listVisible = panel === 'list';
    $('gzSessionsPanel').classList.toggle('hidden', !listVisible);
    $('gzSessionDetail').classList.toggle('hidden', listVisible);
    if (listVisible) { renderSessioni(); return; }

    var active = mode === 'active';
    $('gzEndBtn').classList.toggle('hidden', !active);
    $('gzInputArea').classList.toggle('hidden', !active);
    $('gzImportScansioniBtn').classList.toggle('hidden', !active);
    $('gzResetCountBtn').classList.toggle('hidden', !active);
    $('gzEanUnresolvedPanel').classList.remove('hidden');
    $('gzEanUnresolvedPanel').classList.toggle('gz-readonly', !active);

    var s = sessione;
    $('gzSessionTitle').textContent = (s ? (s.nome || '(senza nome)') : '') +
      ' — ' + (mode === 'active' ? 'in corso' : 'completato, sola lettura') +
      (s ? ' · iniziato il ' + fmtDateTime(s.iniziato_il) + (s.operatore ? ' da ' + s.operatore : '') +
        (s.completato_il ? ' · chiuso il ' + fmtDateTime(s.completato_il) : '') : '');

    if (!active) stopScanner();
  }
  document.addEventListener('jarvis:permsReady', function () { renderAtteseInfo(); applyPanel(); });

  // ================= SCRITTURA CONTEGGI =================
  // Incremento atomico lato Postgres (vedi tools/giacenze-schema.sql).
  async function bump(codice, delta) {
    if (!sessione || mode !== 'active') throw new Error('Nessun conteggio attivo.');
    var res = await sb.rpc('wt_giacenze_incrementa', { p_conteggio_id: sessione.id, p_codice: codice, p_delta: delta });
    if (res.error) throw res.error;
    var totale = Number(res.data);
    setRigaLocal(codice, { unita_contate: totale });
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
    setRigaLocal(codice, { unita_contate: valore });
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

  // Barcode -> articolo. Ordine di ricerca aggiornato: 1) Listino SBS (fonte primaria),
  // 2) collegamenti manuali sul campo. Se nessuna delle due risolve, il chiamante mette
  // l'EAN in coda come "non risolto" invece di aprire un flusso bloccante.
  function resolveBarcode(rawText) {
    var hit = eanMap.get(barcodeKey(rawText));
    if (hit) return { codice: hit.codice, nome: hit.descrizione };
    hit = barcodeMap.get(barcodeKey(rawText));
    if (hit) return { codice: hit.codice, nome: null };
    return null;
  }

  async function countResolved(hit) {
    var art = attExact.get(hit.codice) || attMap.get(normKey(hit.codice));
    var codice = art ? art.codice : (righeKeys.get(normKey(hit.codice)) || hit.codice);
    var tot = await bump(codice, 1);
    lastScan = codice;
    if (art) feedbackCounted(art.nome_articolo, codice, tot, art.unita_attese);
    else feedbackCounted(hit.nome ? hit.nome + ' (non in giacenza attesa)' : 'Non presente in giacenza attesa', codice, tot, null);
  }

  async function enqueueEanNonRisolto(ean) {
    var res = await sb.rpc('wt_giacenze_ean_non_risolto_incrementa', { p_conteggio_id: sessione.id, p_ean: ean, p_delta: 1 });
    if (res.error) throw res.error;
    await loadEanNonRisolti();
    renderEanNonRisolti();
  }

  async function handleCode(rawText) {
    try {
      var hit = resolveBarcode(rawText);
      if (hit) { await countResolved(hit); return; }
      showFeedback('warn',
        '<div class="gz-fb-title">EAN non riconosciuto: ' + escapeHtml(rawText) + '</div>' +
        '<div class="gz-fb-sub">In attesa di assegnazione — assegnalo dal pannello "EAN sconosciuti" qui sotto.</div>');
      vibrate([40, 60, 40]);
      await enqueueEanNonRisolto(rawText.trim());
    } catch (err) {
      showFeedback('err', '<div class="gz-fb-title">Errore salvataggio: ' + escapeHtml(err.message) + '</div>');
    }
  }

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
    handleCode(decodedText.trim());
  }

  // ================= ANNULLA ULTIMA SCANSIONE =================
  $('gzUndoScanBtn').addEventListener('click', async function () {
    if (!lastScan || mode !== 'active') return;
    var codice = lastScan;
    lastScan = null;
    try {
      var tot = await bump(codice, -1);
      showFeedback('warn', '<div class="gz-fb-title">Annullata ultima scansione</div>' +
        '<div class="gz-fb-sub">' + escapeHtml(codice) + '</div>' +
        '<div class="gz-fb-count">Contati ora: <b>' + fmtNum(tot) + '</b></div>');
    } catch (err) {
      showFeedback('err', '<div class="gz-fb-title">Errore: ' + escapeHtml(err.message) + '</div>');
    }
  });

  function scanFormats() {
    if (typeof Html5QrcodeSupportedFormats === 'undefined') return undefined;
    var F = Html5QrcodeSupportedFormats;
    return [F.QR_CODE, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.ITF, F.CODABAR, F.DATA_MATRIX]
      .filter(function (f) { return f !== undefined; });
  }

  // html5-qrcode ridisegna il ritaglio su un canvas grande quanto il riquadro in pixel di layout
  // e decodifica quello. Il box dello scanner ha quindi una larghezza logica fissa e grande
  // (vedi CSS #gzScannerBox) e qui lo si rimpicciolisce a schermo: il decoder lavora vicino
  // alla risoluzione reale della camera, l'utente vede un box che sta nella card.
  var SCAN_LOGICAL_WIDTH = 1000;

  function fitScanner() {
    var wrap = $('gzScanWrap');
    var box = $('gzScannerBox');
    if (!wrap || !wrap.clientWidth) return;
    var k = wrap.clientWidth / SCAN_LOGICAL_WIDTH;
    box.style.transform = 'scale(' + k + ')';
    wrap.style.height = box.offsetHeight ? Math.ceil(box.offsetHeight * k) + 'px' : '';
  }

  window.addEventListener('resize', fitScanner);
  if (typeof ResizeObserver !== 'undefined' && $('gzScannerBox')) new ResizeObserver(fitScanner).observe($('gzScannerBox'));

  var NATIVE_FORMATS_WANTED = ['ean_13', 'ean_8', 'code_128', 'code_39', 'upc_a', 'upc_e', 'qr_code'];

  async function nativeSupportedFormats() {
    if (!('BarcodeDetector' in window)) return null;
    try {
      var supported = await BarcodeDetector.getSupportedFormats();
      var formats = NATIVE_FORMATS_WANTED.filter(function (f) { return supported.indexOf(f) > -1; });
      return formats.length ? formats : null;
    } catch (e) {
      return null;
    }
  }

  function computeCropRect(video, wrap, reticle) {
    var vw = video.videoWidth, vh = video.videoHeight;
    var cw = wrap.clientWidth, ch = wrap.clientHeight;
    if (!vw || !vh || !cw || !ch) return null;
    var scale = Math.max(cw / vw, ch / vh);
    var dispW = vw * scale, dispH = vh * scale;
    var offX = (dispW - cw) / 2, offY = (dispH - ch) / 2;
    var wRect = wrap.getBoundingClientRect();
    var rRect = reticle.getBoundingClientRect();
    var sx = (offX + (rRect.left - wRect.left)) / scale;
    var sy = (offY + (rRect.top - wRect.top)) / scale;
    var sw = rRect.width / scale;
    var sh = rRect.height / scale;
    sx = Math.max(0, Math.min(sx, vw - 1));
    sy = Math.max(0, Math.min(sy, vh - 1));
    sw = Math.max(1, Math.min(sw, vw - sx));
    sh = Math.max(1, Math.min(sh, vh - sy));
    return { sx: sx, sy: sy, sw: sw, sh: sh };
  }

  function nativeLoop() {
    if (!nativeActive) return;
    nativeRAF = requestAnimationFrame(nativeLoop);
    nativeFrameCount++;
    if (nativeFrameCount % 2 !== 0 || nativeBusy) return;
    var video = $('gzScanVideo');
    var crop = computeCropRect(video, $('gzScanWrap'), $('gzScanReticle'));
    if (!crop) return;
    nativeCanvas.width = Math.round(crop.sw);
    nativeCanvas.height = Math.round(crop.sh);
    nativeCtx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, nativeCanvas.width, nativeCanvas.height);
    nativeBusy = true;
    nativeDetector.detect(nativeCanvas).then(function (codes) {
      nativeBusy = false;
      if (codes.length && mode === 'active') onDecode(codes[0].rawValue);
    }).catch(function () { nativeBusy = false; });
  }

  async function startNativeScanner(formats) {
    var video = $('gzScanVideo');
    nativeStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    });
    backend = 'native';
    $('gzScanWrap').style.height = '';
    $('gzScannerBox').classList.add('hidden');
    video.classList.remove('hidden');
    $('gzScanReticle').classList.remove('hidden');
    video.srcObject = nativeStream;
    await video.play();
    nativeDetector = new BarcodeDetector({ formats: formats });
    nativeFrameCount = 0;
    nativeBusy = false;
    nativeActive = true;
    nativeRAF = requestAnimationFrame(nativeLoop);
  }

  async function stopNativeScanner() {
    nativeActive = false;
    if (nativeRAF) { cancelAnimationFrame(nativeRAF); nativeRAF = null; }
    nativeDetector = null;
    var video = $('gzScanVideo');
    try { video.pause(); } catch (e) { /* ignora */ }
    video.srcObject = null;
    video.classList.add('hidden');
    $('gzScanReticle').classList.add('hidden');
    $('gzScannerBox').classList.remove('hidden');
    if (nativeStream) {
      nativeStream.getTracks().forEach(function (t) { t.stop(); });
      nativeStream = null;
    }
  }

  async function startHtml5QrcodeScanner() {
    if (typeof Html5Qrcode === 'undefined') throw new Error('Libreria scanner non disponibile (controlla la connessione).');
    $('gzScanVideo').classList.add('hidden');
    $('gzScanReticle').classList.add('hidden');
    $('gzScannerBox').classList.remove('hidden');
    if (!scanner) scanner = new Html5Qrcode('gzScannerBox', { verbose: false, formatsToSupport: scanFormats() });
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 10,
        videoConstraints: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } },
        qrbox: { width: 260, height: 100 }
      },
      onDecode,
      function () { /* nessun codice nel frame: normale */ }
    );
    backend = 'html5qrcode';
    fitScanner();
  }

  function activeTrackCapabilities() {
    try {
      if (backend === 'native' && nativeStream) {
        var t = nativeStream.getVideoTracks()[0];
        return t && t.getCapabilities ? t.getCapabilities() : null;
      }
      if (backend === 'html5qrcode' && scanner && scanner.getRunningTrackCapabilities) {
        return scanner.getRunningTrackCapabilities();
      }
    } catch (e) { /* capability non disponibile su questo device/browser */ }
    return null;
  }

  function setupTorchButton() {
    var btn = $('gzTorchToggle');
    torchOn = false;
    btn.textContent = 'Torcia';
    var caps = activeTrackCapabilities();
    btn.classList.toggle('hidden', !(caps && caps.torch));
  }

  async function toggleTorch() {
    var btn = $('gzTorchToggle');
    var next = !torchOn;
    try {
      if (backend === 'native' && nativeStream) {
        await nativeStream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: next }] });
      } else if (backend === 'html5qrcode' && scanner && scanner.applyVideoConstraints) {
        await scanner.applyVideoConstraints({ advanced: [{ torch: next }] });
      } else {
        return;
      }
      torchOn = next;
      btn.textContent = torchOn ? 'Spegni torcia' : 'Torcia';
    } catch (err) {
      console.error('Errore torcia:', err);
    }
  }

  $('gzTorchToggle').addEventListener('click', toggleTorch);

  async function startScanner() {
    var msg = $('gzScanMsg');
    if (scannerRunning || mode !== 'active') return;
    msg.textContent = '';
    $('gzScanToggle').disabled = true;
    try {
      var nativeFormats = await nativeSupportedFormats();
      if (nativeFormats) {
        await startNativeScanner(nativeFormats);
      } else {
        await startHtml5QrcodeScanner();
      }
      scannerRunning = true;
      setupTorchButton();
      $('gzScanToggle').textContent = 'Ferma fotocamera';
    } catch (err) {
      console.error('Errore avvio fotocamera:', err);
      msg.textContent = 'Impossibile avviare la fotocamera: ' + (err && err.message ? err.message : err);
      try { await stopScanner(); } catch (e) { /* ignora, stiamo già gestendo un errore */ }
    } finally {
      $('gzScanToggle').disabled = false;
    }
  }

  async function stopScanner() {
    scannerRunning = false;
    if (backend === 'native') {
      await stopNativeScanner();
    } else if (backend === 'html5qrcode' && scanner) {
      try { await scanner.stop(); scanner.clear(); } catch (e) { /* già fermo */ }
    }
    backend = null;
    torchOn = false;
    var btn = $('gzScanToggle');
    if (btn) btn.textContent = 'Attiva fotocamera';
    var torchBtn = $('gzTorchToggle');
    if (torchBtn) { torchBtn.classList.add('hidden'); torchBtn.textContent = 'Torcia'; }
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
        lastScan = add.dataset.code;
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
    var r = righe.get(codice);
    return r ? r.unita_contate : 0;
  }

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
    var nome = (art && art.nome_articolo) || codice;
    saveBtn.disabled = true;
    try {
      await setCount(codice, v);
      resetManual();
      setManualMsg('Salvato: ' + nome + ' — ' + fmtNum(v), true);
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

  // ================= EAN SCONOSCIUTI =================
  function searchAssignTargets(term) {
    var tokens = term.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    var out = [];
    for (var i = 0; i < attese.length && out.length < MANUAL_MAX_RESULTS; i++) {
      var hay = atteseHay[i];
      if (tokens.every(function (t) { return hay.indexOf(t) > -1; })) out.push({ codice: attese[i].codice, nome: attese[i].nome_articolo });
    }
    if (out.length) return out;
    // Nessun risultato nella giacenza attesa: si prova sul Listino SBS (codice noto ma non ancora atteso).
    for (var j = 0; j < eanList.length && out.length < MANUAL_MAX_RESULTS; j++) {
      var hay2 = eanHay[j];
      if (tokens.every(function (t) { return hay2.indexOf(t) > -1; })) out.push({ codice: eanList[j].codice, nome: eanList[j].descrizione });
    }
    return out;
  }

  function renderEanNonRisolti() {
    var pend = $('gzEanPendingList');
    var ass = $('gzEanAssignedList');
    if (!eanNonRisolti.length) {
      pend.innerHTML = '<div class="gz-empty-inline">Nessun EAN in attesa di assegnazione.</div>';
    } else {
      pend.innerHTML = eanNonRisolti.map(function (r) {
        var open = assigningEan === r.ean;
        return '<div class="gz-ean-row" data-ean="' + escapeHtml(r.ean) + '">' +
          '<div class="gz-ean-head">' +
          '<span class="gz-code">' + escapeHtml(r.ean) + '</span>' +
          '<span class="gz-ean-qty">&times; ' + fmtNum(r.quantita) + '</span>' +
          (mode === 'active' ? '<button type="button" class="pt-btn gz-ean-assign-btn">Assegna</button>' : '') +
          '</div>' +
          (open ? assignSelectHtml(r.ean) : '') +
          '</div>';
      }).join('');
    }
    if (!assignedThisSession.length) {
      ass.innerHTML = '';
      $('gzEanAssignedWrap').classList.add('hidden');
    } else {
      $('gzEanAssignedWrap').classList.remove('hidden');
      ass.innerHTML = assignedThisSession.map(function (a, idx) {
        return '<div class="gz-ean-row gz-ean-assigned" data-idx="' + idx + '">' +
          '<div class="gz-ean-head">' +
          '<span class="gz-code">' + escapeHtml(a.ean) + '</span>' +
          '<span class="gz-ean-qty">&rarr; ' + escapeHtml(a.codice) + (a.nome ? ' (' + escapeHtml(a.nome) + ')' : '') + ', +' + fmtNum(a.quantita) + '</span>' +
          (mode === 'active' ? '<button type="button" class="pt-btn gz-ean-edit-btn">Modifica assegnazione</button>' +
            '<button type="button" class="pt-btn danger gz-ean-remove-btn">Rimuovi assegnazione</button>' : '') +
          '</div>' +
          (assigningEan === ('edit:' + a.ean) ? assignSelectHtml(a.ean, true) : '') +
          '</div>';
      }).join('');
    }
  }

  function assignSelectHtml(ean, isEdit) {
    return '<div class="gz-ean-assign">' +
      '<input type="text" class="of-search-input gz-ean-assign-input" style="max-width:none;" placeholder="Cerca codice o nome articolo&hellip;" autocomplete="off">' +
      '<div class="gz-ean-assign-sugg"></div>' +
      '</div>';
  }

  $('gzEanPendingList').addEventListener('click', function (ev) {
    var btn = ev.target.closest('.gz-ean-assign-btn');
    if (btn) {
      var row = ev.target.closest('.gz-ean-row');
      assigningEan = assigningEan === row.dataset.ean ? null : row.dataset.ean;
      renderEanNonRisolti();
      var input = $('gzEanPendingList').querySelector('.gz-ean-assign-input');
      if (input) input.focus();
      return;
    }
  });

  $('gzEanAssignedList').addEventListener('click', function (ev) {
    var editBtn = ev.target.closest('.gz-ean-edit-btn');
    var rmBtn = ev.target.closest('.gz-ean-remove-btn');
    var row = ev.target.closest('.gz-ean-row');
    if (!row) return;
    var idx = Number(row.dataset.idx);
    var a = assignedThisSession[idx];
    if (!a) return;
    if (editBtn) {
      assigningEan = assigningEan === ('edit:' + a.ean) ? null : ('edit:' + a.ean);
      renderEanNonRisolti();
      var input = $('gzEanAssignedList').querySelector('.gz-ean-assign-input');
      if (input) input.focus();
      return;
    }
    if (rmBtn) removeAssignment(idx);
  });

  function eanAssignSearchInput(container) {
    container.addEventListener('input', function (ev) {
      var input = ev.target.closest('.gz-ean-assign-input');
      if (!input) return;
      var term = input.value.trim();
      var box = input.parentElement.querySelector('.gz-ean-assign-sugg');
      if (!term) { box.innerHTML = ''; return; }
      var found = searchAssignTargets(term);
      box.innerHTML = found.length
        ? found.map(function (a) {
          return '<button type="button" class="gz-sugg" data-code="' + escapeHtml(a.codice) + '"><b>' + escapeHtml(a.codice) + '</b> ' + escapeHtml(a.nome || '') + '</button>';
        }).join('')
        : '<div class="gz-sugg-empty">Nessun articolo trovato.</div>';
    });
    container.addEventListener('click', function (ev) {
      var pick = ev.target.closest('.gz-sugg');
      if (!pick) return;
      var row = ev.target.closest('.gz-ean-row');
      var ean = row.dataset.ean || (assigningEan && assigningEan.indexOf('edit:') === 0 ? assigningEan.slice(5) : null);
      if (!ean) return;
      if (assigningEan && assigningEan.indexOf('edit:') === 0) editAssignment(ean, pick.dataset.code);
      else assignEan(ean, pick.dataset.code);
    });
  }
  eanAssignSearchInput($('gzEanPendingList'));
  eanAssignSearchInput($('gzEanAssignedList'));

  async function assignEan(ean, codice) {
    var row = eanNonRisolti.find(function (r) { return r.ean === ean; });
    if (!row) return;
    try {
      await sb.from('wt_giacenze_barcode_map').upsert(
        { barcode: ean, codice: codice, creato_da: operatoreCorrente() }, { onConflict: 'barcode' }
      );
      barcodeMap.set(barcodeKey(ean), { codice: codice });
      await bump(codice, row.quantita);
      var del = await sb.from('wt_giacenze_ean_non_risolti').delete().eq('id', row.id);
      if (del.error) throw del.error;
      var art = attExact.get(codice) || attMap.get(normKey(codice));
      assignedThisSession.push({ ean: ean, codice: codice, nome: art ? art.nome_articolo : null, quantita: row.quantita });
      assigningEan = null;
      await loadEanNonRisolti();
      renderEanNonRisolti();
    } catch (err) {
      alert('Errore assegnazione EAN: ' + err.message);
    }
  }

  async function editAssignment(ean, nuovoCodice) {
    var idx = assignedThisSession.findIndex(function (a) { return a.ean === ean; });
    if (idx === -1) return;
    var a = assignedThisSession[idx];
    if (nuovoCodice === a.codice) { assigningEan = null; renderEanNonRisolti(); return; }
    try {
      await sb.from('wt_giacenze_barcode_map').upsert(
        { barcode: ean, codice: nuovoCodice, creato_da: operatoreCorrente() }, { onConflict: 'barcode' }
      );
      barcodeMap.set(barcodeKey(ean), { codice: nuovoCodice });
      await bump(a.codice, -a.quantita);
      await bump(nuovoCodice, a.quantita);
      var art = attExact.get(nuovoCodice) || attMap.get(normKey(nuovoCodice));
      assignedThisSession[idx] = { ean: ean, codice: nuovoCodice, nome: art ? art.nome_articolo : null, quantita: a.quantita };
      assigningEan = null;
      renderEanNonRisolti();
    } catch (err) {
      alert('Errore modifica assegnazione: ' + err.message);
    }
  }

  async function removeAssignment(idx) {
    var a = assignedThisSession[idx];
    if (!a) return;
    if (!confirm('Rimuovere l\'assegnazione di ' + a.ean + ' -> ' + a.codice + '? L\'EAN torna fra quelli da assegnare.')) return;
    try {
      await sb.from('wt_giacenze_barcode_map').delete().eq('barcode', a.ean);
      barcodeMap.delete(barcodeKey(a.ean));
      await bump(a.codice, -a.quantita);
      var res = await sb.rpc('wt_giacenze_ean_non_risolto_incrementa', { p_conteggio_id: sessione.id, p_ean: a.ean, p_delta: a.quantita });
      if (res.error) throw res.error;
      assignedThisSession.splice(idx, 1);
      await loadEanNonRisolti();
      renderEanNonRisolti();
    } catch (err) {
      alert('Errore rimozione assegnazione: ' + err.message);
    }
  }

  // ================= IMPORT SCANSIONI (XLSX da scanner esterno) =================
  $('gzImportScansioniBtn').addEventListener('click', function () { $('gzScansioniFile').click(); });
  $('gzScansioniFile').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (f) importScansioni(f);
  });

  async function importScansioni(file) {
    if (mode !== 'active' || !sessione) { $('gzScansioniFile').value = ''; return; }
    var btn = $('gzImportScansioniBtn');
    btn.disabled = true;
    setManualMsg('Lettura file scansioni...', false);
    try {
      if (typeof XLSX === 'undefined') throw new Error('Libreria XLSX non disponibile (controlla la connessione).');
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array' });
      var ws = wb.Sheets[wb.SheetNames[0]];
      var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
      var counts = new Map();
      rows.forEach(function (r) {
        var v = String((r && r[0]) == null ? '' : r[0]).trim();
        if (/^\d{13}$/.test(v)) counts.set(v, (counts.get(v) || 0) + 1);
      });
      if (!counts.size) throw new Error('Nessun EAN a 13 cifre trovato nel file.');

      var risolti = 0, daAssegnare = 0, scansioni = 0;
      for (var entry of counts.entries()) {
        var ean = entry[0], qty = entry[1];
        scansioni += qty;
        var hit = resolveBarcode(ean);
        if (hit) {
          var art = attExact.get(hit.codice) || attMap.get(normKey(hit.codice));
          var codice = art ? art.codice : hit.codice;
          await bump(codice, qty);
          risolti++;
        } else {
          var res = await sb.rpc('wt_giacenze_ean_non_risolto_incrementa', { p_conteggio_id: sessione.id, p_ean: ean, p_delta: qty });
          if (res.error) throw res.error;
          daAssegnare++;
        }
      }
      await loadEanNonRisolti();
      renderEanNonRisolti();
      setManualMsg(scansioni + ' scansioni importate, ' + risolti + ' EAN risolti, ' + daAssegnare + ' EAN da assegnare manualmente.', true);
    } catch (err) {
      console.error('Errore import scansioni:', err);
      setManualMsg('Errore import scansioni: ' + err.message, false);
    } finally {
      btn.disabled = false;
      $('gzScansioniFile').value = '';
    }
  }

  // ================= TABELLA DI CONFRONTO =================
  function attesoFor(codice) {
    var a = attese.find(function (x) { return x.fonte === confrontoFonte && x.codice === codice; });
    return a ? a.unita_attese : 0;
  }

  function rowState(diff, has) {
    if (!has) return 'none';
    if (diff === 0) return 'ok';
    return diff < 0 ? 'mancante' : 'eccedenza';
  }

  function computeRows() {
    var fonteRows = atteseFonte(confrontoFonte);
    var fonteCodes = new Set(fonteRows.map(function (a) { return a.codice; }));
    var main = fonteRows.map(function (a) {
      var r = righe.get(a.codice);
      var has = !!r;
      var c = has ? r.unita_contate : null;
      var diff = has ? c - a.unita_attese : null;
      return {
        codice: a.codice, nome: a.nome_articolo || '', att: a.unita_attese, c: c, diff: diff,
        state: rowState(diff, has),
        corretto: has ? r.corretto : false, corretto_il: has ? r.corretto_il : null,
        diffCorrezione: has ? r.differenza_al_momento_correzione : null,
        note: has ? r.note : ''
      };
    });
    var extras = [];
    righe.forEach(function (r, codice) {
      if (fonteCodes.has(codice)) return;
      var diff = r.unita_contate;
      extras.push({
        codice: codice, nome: '', att: 0, c: r.unita_contate, diff: diff,
        state: rowState(diff, true), extra: true,
        corretto: r.corretto, corretto_il: r.corretto_il, diffCorrezione: r.differenza_al_momento_correzione, note: r.note
      });
    });
    extras.sort(function (a, b) { return a.codice < b.codice ? -1 : a.codice > b.codice ? 1 : 0; });
    return { main: main, extras: extras };
  }

  function passesFilter(r) {
    if (filter === 'daCorrere') return r.diff !== 0 && r.diff != null && !r.corretto;
    if (filter === 'corrette') return r.corretto;
    return true;
  }

  function rowBadge(r) {
    if (!r.corretto || r.diffCorrezione == null || r.diff == null || r.diff === r.diffCorrezione) return '';
    return '<div class="gz-stale-badge">La differenza è cambiata dopo la correzione (era ' + fmtDiff(r.diffCorrezione) + ', ora ' + fmtDiff(r.diff) + ')</div>';
  }

  function rowHtml(r) {
    var checkboxCell = (r.diff != null && r.diff !== 0)
      ? '<input type="checkbox" class="gz-corretto-chk" data-codice="' + escapeHtml(r.codice) + '"' + (r.corretto ? ' checked' : '') + '>'
      : '';
    var noteCell = (r.c != null)
      ? '<input type="text" class="gz-note-input" data-codice="' + escapeHtml(r.codice) + '" value="' + escapeHtml(r.note || '') + '" placeholder="Nota&hellip;">'
      : '<span class="gz-note-disabled">&mdash;</span>';
    var corrIl = r.corretto && r.corretto_il ? '<div class="gz-corr-date">' + fmtDate(r.corretto_il) + '</div>' : '';
    return '<tr class="gz-row gz-' + r.state + '" data-codice="' + escapeHtml(r.codice) + '" data-corretto-il="' + escapeHtml(r.corretto_il || '') + '">' +
      '<td class="gz-code">' + escapeHtml(r.codice) + '</td>' +
      '<td>' + escapeHtml(r.extra ? '—' : r.nome) + '</td>' +
      '<td class="gz-num">' + fmtNum(r.att) + '</td>' +
      '<td class="gz-num">' + (r.c == null ? '—' : fmtNum(r.c)) + '</td>' +
      '<td class="gz-num gz-diffcell">' + (r.diff == null ? '' : fmtDiff(r.diff)) + rowBadge(r) + '</td>' +
      '<td class="gz-center">' + checkboxCell + corrIl + '</td>' +
      '<td>' + noteCell + '</td>' +
      '</tr>';
  }

  function renderCompare() {
    if (panel !== 'detail' || mode === 'idle') return;
    $('gzFonteSelect').value = confrontoFonte;
    var data = computeRows();
    var count = function (list, st) { return list.filter(function (r) { return r.state === st; }).length; };
    var tot = data.main.length;
    var none = count(data.main, 'none');
    $('gzSummary').innerHTML =
      '<span>Articoli <b>' + tot + '</b></span>' +
      '<span>Contati <b>' + (tot - none) + '</b></span>' +
      '<span class="gz-s-ok">In linea <b>' + count(data.main, 'ok') + '</b></span>' +
      '<span class="gz-s-diff">Mancanti <b>' + count(data.main, 'mancante') + '</b></span>' +
      '<span class="gz-s-warn">Eccedenze <b>' + count(data.main, 'eccedenza') + '</b></span>' +
      '<span>Non contati <b>' + none + '</b></span>';

    var correggibili = data.main.concat(data.extras).filter(function (r) { return r.diff != null && r.diff !== 0; });
    var corrette = correggibili.filter(function (r) { return r.corretto; });
    $('gzCorrCounter').textContent = corrette.length + ' di ' + correggibili.length + ' corrette';

    $('gzFilters').querySelectorAll('.of-chip').forEach(function (b) {
      b.classList.toggle('active', b.dataset.filter === filter);
    });

    var main = data.main.filter(passesFilter);
    var extras = data.extras.filter(passesFilter);
    var html = main.map(rowHtml).join('');
    if (extras.length) {
      html += '<tr class="gz-sep"><td colspan="7">Da caricare a magazzino (contati ma non presenti nella giacenza attesa selezionata)</td></tr>' + extras.map(rowHtml).join('');
    }
    $('gzTbody').innerHTML = html || '<tr><td colspan="7" class="gz-empty">Nessuna riga per questo filtro.</td></tr>';
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

  $('gzFonteSelect').addEventListener('change', function () {
    confrontoFonte = this.value;
    localStorage.setItem(FONTE_KEY, confrontoFonte);
    renderCompare();
  });

  $('gzFilters').addEventListener('click', function (ev) {
    var b = ev.target.closest('.of-chip');
    if (!b) return;
    filter = b.dataset.filter;
    renderCompare();
  });

  // ---- correzione / nota per riga (delegati: la tbody viene riscritta a ogni render) ----
  $('gzTbody').addEventListener('change', async function (ev) {
    var chk = ev.target.closest('.gz-corretto-chk');
    if (chk) {
      var codice = chk.dataset.codice;
      var r = righe.get(codice);
      var diffNow = r ? r.unita_contate - attesoFor(codice) : null;
      var patch = chk.checked
        ? { corretto: true, corretto_il: new Date().toISOString(), differenza_al_momento_correzione: diffNow }
        : { corretto: false, corretto_il: null, differenza_al_momento_correzione: null };
      chk.disabled = true;
      try {
        var payload = Object.assign({ conteggio_id: sessione.id, codice: codice, updated_at: new Date().toISOString() }, patch);
        var res = await sb.from('wt_giacenze_conteggio_righe').upsert(payload, { onConflict: 'conteggio_id,codice' });
        if (res.error) throw res.error;
        setRigaLocal(codice, patch);
        renderCompare();
      } catch (err) {
        alert('Errore salvataggio correzione: ' + err.message);
        chk.checked = !chk.checked;
        chk.disabled = false;
      }
      return;
    }
    var note = ev.target.closest('.gz-note-input');
    if (note) await saveNote(note.dataset.codice, note.value);
  });

  async function saveNote(codice, text) {
    try {
      var res = await sb.from('wt_giacenze_conteggio_righe').upsert(
        { conteggio_id: sessione.id, codice: codice, note: text, updated_at: new Date().toISOString() },
        { onConflict: 'conteggio_id,codice' }
      );
      if (res.error) throw res.error;
      setRigaLocal(codice, { note: text });
    } catch (err) {
      alert('Errore salvataggio nota: ' + err.message);
    }
  }

  $('gzGotoLastCorrectedBtn').addEventListener('click', function () {
    var rows = Array.from($('gzTbody').querySelectorAll('tr[data-corretto-il]'))
      .filter(function (tr) { return tr.dataset.correttoIl; })
      .sort(function (a, b) { return a.dataset.correttoIl < b.dataset.correttoIl ? 1 : -1; });
    var target = rows[0];
    if (!target) { alert('Nessuna riga corretta trovata.'); return; }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.add('gz-row-flash');
    setTimeout(function () { target.classList.remove('gz-row-flash'); }, 1300);
  });

  // ================= EXPORT (PDF / CSV / Excel) =================
  var STATE_LABEL = { ok: 'In linea', mancante: 'Mancante', eccedenza: 'Eccedenza', none: 'Non contato' };
  var STATE_COLORS = {
    ok: { fill: 'FFDCF3E2', text: 'FF1A7A3C' },
    mancante: { fill: 'FFFBDCDC', text: 'FFB02020' },
    eccedenza: { fill: 'FFFCEFD6', text: 'FFB56E00' },
    none: { fill: 'FFEEF0F2', text: 'FF6B7280' }
  };

  // Righe attualmente visibili in tabella (rispettano il filtro corrente), condivise da
  // export PDF/CSV/Excel così i tre formati restano sempre coerenti con quello che si vede a schermo.
  function buildExportRows() {
    var data = computeRows();
    return data.main.filter(passesFilter).concat(data.extras.filter(passesFilter));
  }

  $('gzExportCsvBtn').addEventListener('click', function () { exportCsv(); });
  $('gzExportPdfBtn').addEventListener('click', function () { exportPdf(); });
  $('gzExportExcelBtn').addEventListener('click', function () { exportExcel(); });

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    if (!sessione) return;
    var rows = buildExportRows();
    var head = ['Codice', 'Articolo', 'Atteso', 'Contato', 'Differenza', 'Stato', 'Corretto', 'Nota'];
    var lines = [head.join(';')];
    rows.forEach(function (r) {
      lines.push([
        r.codice, r.nome, fmtNum(r.att), r.c == null ? '' : fmtNum(r.c), r.diff == null ? '' : fmtDiff(r.diff),
        STATE_LABEL[r.state], r.corretto ? 'Si' : '', r.note || ''
      ].map(csvEscape).join(';'));
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'Giacenze_' + (sessione.nome || 'sessione').replace(/[^a-zA-Z0-9]+/g, '_') + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function exportPdf() {
    if (typeof window.jspdf === 'undefined' || !window.jspdf.jsPDF) {
      alert('Libreria PDF non disponibile (controlla la connessione).');
      return;
    }
    if (!sessione) return;
    var rows = buildExportRows();
    var data = computeRows();
    var count = function (list, st) { return list.filter(function (r) { return r.state === st; }).length; };
    var tot = data.main.length;

    var doc = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    var pageWidth = doc.internal.pageSize.getWidth();
    var marginX = 8;
    var bannerTop = 8;

    function drawHeader() {
      doc.setFillColor(18, 35, 47);
      doc.rect(marginX, bannerTop, pageWidth - marginX * 2, 14, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(14);
      doc.text(sessione.nome || 'Conteggio giacenze', marginX + 3, bannerTop + 6.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(143, 232, 255);
      doc.text('Giacenze · confronto con "' + (confrontoFonte === 'export' ? 'Export magazzino' : 'Giacenze aggregate') + '"', marginX + 3, bannerTop + 11);
      doc.setTextColor(200, 216, 224);
      doc.text('Generato il ' + new Date().toLocaleDateString('it-IT'), pageWidth - marginX - 3, bannerTop + 8, { align: 'right' });
      doc.setDrawColor(42, 184, 217);
      doc.setLineWidth(0.6);
      doc.line(marginX, bannerTop + 14, pageWidth - marginX, bannerTop + 14);

      var noteY = bannerTop + 20;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(30, 30, 30);
      doc.text('IN LINEA: ' + count(data.main, 'ok') + '   MANCANTI: ' + count(data.main, 'mancante') +
        '   ECCEDENZE: ' + count(data.main, 'eccedenza') + '   NON CONTATI: ' + count(data.main, 'none') +
        '   TOTALE ARTICOLI: ' + tot, marginX + 1, noteY);
      doc.setDrawColor(226, 228, 231);
      doc.setLineWidth(0.2);
      doc.line(marginX, noteY + 3, pageWidth - marginX, noteY + 3);
    }

    doc.autoTable({
      startY: bannerTop + 28,
      margin: { left: marginX, right: marginX, top: bannerTop + 28, bottom: 14 },
      theme: 'plain',
      styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.8, lineColor: [226, 228, 231], lineWidth: 0.15, textColor: [30, 30, 30], valign: 'middle' },
      headStyles: { fillColor: [18, 35, 47], textColor: [79, 200, 232], fontStyle: 'bold', halign: 'center', valign: 'middle', fontSize: 7.5 },
      columnStyles: { 2: { halign: 'right', cellWidth: 22 }, 3: { halign: 'right', cellWidth: 22 }, 4: { halign: 'right', cellWidth: 22 }, 5: { cellWidth: 26 }, 6: { halign: 'center', cellWidth: 18 } },
      head: [['Codice', 'Articolo', 'Atteso', 'Contato', 'Differenza', 'Stato', 'Corretto', 'Nota']],
      body: rows.map(function (r) {
        return [r.codice, r.nome, fmtNum(r.att), r.c == null ? '—' : fmtNum(r.c), r.diff == null ? '' : fmtDiff(r.diff),
        STATE_LABEL[r.state], r.corretto ? 'X' : '', r.note || ''];
      }),
      didDrawPage: drawHeader,
      didParseCell: function (d) {
        if (d.section !== 'body') return;
        var st = rows[d.row.index] && rows[d.row.index].state;
        var colors = STATE_COLORS[st];
        if (colors) d.cell.styles.fillColor = hexToRgbPdf(colors.fill);
      }
    });

    var eanY = doc.lastAutoTable.finalY + 8;
    if (eanY > doc.internal.pageSize.getHeight() - 24) { doc.addPage(); eanY = bannerTop + 10; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(18, 35, 47);
    doc.text('EAN ancora da assegnare (' + eanNonRisolti.length + ')', marginX, eanY);
    if (eanNonRisolti.length) {
      doc.autoTable({
        startY: eanY + 3,
        margin: { left: marginX, right: marginX },
        theme: 'plain',
        styles: { font: 'helvetica', fontSize: 7.5, cellPadding: 1.5, lineColor: [226, 228, 231], lineWidth: 0.15 },
        headStyles: { fillColor: [18, 35, 47], textColor: [79, 200, 232], fontStyle: 'bold' },
        head: [['EAN', 'Quantità in attesa']],
        body: eanNonRisolti.map(function (r) { return [r.ean, fmtNum(r.quantita)]; })
      });
    }

    var pageCount = doc.internal.getNumberOfPages();
    for (var p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(140, 140, 140);
      doc.text('Pagina ' + p + ' di ' + pageCount, pageWidth - marginX, doc.internal.pageSize.getHeight() - 6, { align: 'right' });
    }

    doc.save('Giacenze_' + (sessione.nome || 'sessione').replace(/[^a-zA-Z0-9]+/g, '_') + '.pdf');
  }

  function hexToRgbPdf(argb) {
    var hex = argb.length === 8 ? argb.slice(2) : argb;
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }

  function exportExcel() {
    if (typeof ExcelJS === 'undefined') { alert('Libreria Excel non disponibile (controlla la connessione).'); return; }
    if (!sessione) return;
    var rows = buildExportRows();
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Giacenze');
    ws.columns = [{ width: 20 }, { width: 42 }, { width: 10 }, { width: 10 }, { width: 12 }, { width: 14 }, { width: 10 }, { width: 30 }];

    ws.mergeCells('A1:H1');
    var banner = ws.getCell('A1');
    banner.value = {
      richText: [
        { font: { bold: true, size: 16, color: { argb: 'FFFFFFFF' } }, text: (sessione.nome || 'Conteggio giacenze') + '\n' },
        { font: { size: 10, color: { argb: 'FF8FE8FF' } }, text: 'Confronto con "' + (confrontoFonte === 'export' ? 'Export magazzino' : 'Giacenze aggregate') + '" — iniziato il ' + fmtDateTime(sessione.iniziato_il) }
      ]
    };
    banner.alignment = { vertical: 'middle', wrapText: true };
    banner.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    ws.getRow(1).height = 38;

    var headRow = ws.getRow(3);
    ['CODICE', 'ARTICOLO', 'ATTESO', 'CONTATO', 'DIFFERENZA', 'STATO', 'CORRETTO', 'NOTA'].forEach(function (t, i) {
      var c = headRow.getCell(i + 1);
      c.value = t;
      c.font = { bold: true, color: { argb: 'FF4FC8E8' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF12232F' } };
    });

    var rowIdx = 4;
    rows.forEach(function (r) {
      var colors = STATE_COLORS[r.state];
      var vals = [r.codice, r.nome, r.att, r.c == null ? 0 : r.c, r.diff == null ? 0 : r.diff, STATE_LABEL[r.state], r.corretto ? 'Si' : '', r.note || ''];
      vals.forEach(function (v, i) {
        var cell = ws.getCell(rowIdx, i + 1);
        cell.value = v;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.fill } };
        cell.font = { color: { argb: colors.text } };
      });
      rowIdx++;
    });

    ws.views = [{ state: 'frozen', ySplit: 3 }];
    wb.xlsx.writeBuffer().then(function (buf) {
      var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'Giacenze_' + (sessione.nome || 'sessione').replace(/[^a-zA-Z0-9]+/g, '_') + '.xlsx';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    });
  }

  // ================= FIX ROTELLINA MOUSE SU CAMPI NUMERICI =================
  // Delegato sul contenitore della vista (non per-elemento): gli input numerici vengono
  // ricreati a ogni render (innerHTML), un listener per elemento andrebbe perso ad ogni giro.
  var gzViewEl = $('view-giacenze');
  if (gzViewEl) {
    gzViewEl.addEventListener('wheel', function (ev) {
      if (document.activeElement === ev.target && ev.target.tagName === 'INPUT' && ev.target.type === 'number') {
        ev.preventDefault();
      }
    }, { passive: false });
  }

  // ================= INIT =================
  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'giacenze') { stopScanner(); return; }
    applyPanel();
    loadAll();
  });

  // Se il browser passa in background (es. si blocca lo schermo) la fotocamera va rilasciata.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopScanner();
  });
})();
