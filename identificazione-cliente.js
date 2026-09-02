(function () {
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Definizione dei gruppi pill di sinistra: 'options' è una funzione dello stato
  // corrente perché "Profilo" dipende da "Segmento", e 'hiddenIf' nasconde un gruppo
  // intero (es. Tipo linea/Telefono Incluso per il profilo Turista) senza toccare
  // identificazione-cliente-rules.js, che ignora comunque quei campi in quel caso.
  var GROUPS = [
    {
      key: 'segmento', label: 'Segmento', options: function () {
        return [{ value: 'consumer', label: 'Consumer' }, { value: 'business', label: 'Business' }];
      }
    },
    {
      key: 'profilo', label: 'Profilo', options: function (state) {
        return state.segmento === 'business'
          ? [{ value: 'libpro', label: 'Libero Professionista / Ditta Individuale' }, { value: 'azienda', label: 'Azienda / Enti' }]
          : [{ value: 'privato', label: 'Privato' }, { value: 'turista', label: 'Turista' }];
      }
    },
    {
      key: 'cittadinanza', label: 'Cittadinanza', options: function () {
        return [{ value: 'it', label: 'Italiana' }, { value: 'ue', label: 'UE / Schengen' }, { value: 'extraue', label: 'Extra-UE' }];
      }
    },
    {
      key: 'linea', label: 'Tipo linea', hiddenIf: function (state) { return state.profilo === 'turista'; },
      options: function () {
        return [
          { value: 'untied', label: 'SIM Untied' }, { value: 'tied', label: 'SIM Tied' },
          { value: 'fisso_modem', label: 'Fisso con modem' }, { value: 'fisso_nomodem', label: 'Fisso senza modem' },
          { value: 'fwa', label: 'FWA Outdoor' }
        ];
      }
    },
    {
      key: 'telIncluso', label: 'Telefono Incluso', hiddenIf: function (state) { return state.profilo === 'turista'; },
      options: function () {
        return [
          { value: 'no', label: 'No' }, { value: 'var', label: 'VAR' },
          { value: 'fin_std', label: 'Finanziato Standard' }, { value: 'fin_rata', label: 'Finanziato Rata Smart' }
        ];
      }
    },
    {
      key: 'redditoCat', label: 'Categoria reddituale',
      hiddenIf: function (state) { return state.telIncluso !== 'fin_std' && state.telIncluso !== 'fin_rata'; },
      options: function () {
        return [{ value: 'dip', label: 'Dipendente' }, { value: 'pens', label: 'Pensionato' }, { value: 'aut', label: 'Autonomo' }];
      }
    }
  ];

  var FLAGS = [
    { key: 'pagatoreDiverso', label: "Pagatore diverso dall'intestatario" },
    { key: 'mnpSostSim', label: 'MNP o Sostituzione SIM' },
    { key: 'delegaAzienda', label: 'Attivazione con Delega', hiddenIf: function (state) { return state.profilo !== 'azienda'; } }
  ];

  var state = {
    segmento: 'consumer', profilo: 'privato', cittadinanza: 'it', linea: 'untied', telIncluso: 'no',
    pagatoreDiverso: false, mnpSostSim: false, delegaAzienda: false, redditoCat: null
  };

  function renderLeft() {
    var col = document.getElementById('icFieldsCol');
    var html = '';
    GROUPS.forEach(function (g) {
      if (g.hiddenIf && g.hiddenIf(state)) return;
      var opts = g.options(state);
      html += '<div class="ic-group"><div class="of-filter-label">' + escapeHtml(g.label) + '</div><div class="ic-pillrow" data-group="' + g.key + '">' +
        opts.map(function (o) {
          return '<button type="button" class="of-chip' + (state[g.key] === o.value ? ' active' : '') + '" data-value="' + escapeHtml(o.value) + '">' + escapeHtml(o.label) + '</button>';
        }).join('') + '</div></div>';
    });

    var visibleFlags = FLAGS.filter(function (f) { return !(f.hiddenIf && f.hiddenIf(state)); });
    if (visibleFlags.length) {
      html += '<div class="ic-group"><div class="of-filter-label">Flag aggiuntivi</div><div class="ic-flags">' +
        visibleFlags.map(function (f) {
          return '<label class="ic-flag-row"><input type="checkbox" data-flag="' + f.key + '"' + (state[f.key] ? ' checked' : '') + '>' + escapeHtml(f.label) + '</label>';
        }).join('') + '</div></div>';
    }

    col.innerHTML = html;
    bindLeft(col);
  }

  function bindLeft(col) {
    col.querySelectorAll('.ic-pillrow').forEach(function (row) {
      var key = row.dataset.group;
      row.querySelectorAll('.of-chip').forEach(function (btn) {
        btn.addEventListener('click', function () {
          if (state[key] === btn.dataset.value) return;
          state[key] = btn.dataset.value;
          onStateChange(key);
        });
      });
    });
    col.querySelectorAll('[data-flag]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state[cb.dataset.flag] = cb.checked;
        onStateChange(cb.dataset.flag);
      });
    });
  }

  // Quando cambia il Segmento, il Profilo selezionato potrebbe non esistere più
  // nell'elenco valido (es. da 'privato' a Business): si riallinea al primo profilo
  // disponibile per il nuovo segmento invece di lasciare uno stato incoerente.
  function onStateChange(changedKey) {
    if (changedKey === 'segmento') {
      var profiloGroup = GROUPS.filter(function (g) { return g.key === 'profilo'; })[0];
      state.profilo = profiloGroup.options(state)[0].value;
    }
    renderLeft();
    renderResult();
  }

  // Una card documento: icona ti-id-badge per i documenti di identità (dentro i path),
  // ti-file-plus per tutto ciò che è "extra" (extras di un path o documentazione aggiuntiva).
  function docCardHtml(icon, text, extraClass) {
    return '<div class="ic-doc-card' + (extraClass ? ' ic-doc-card-extra' : '') + '"><i class="ti ' + icon + '"></i><span>' + escapeHtml(text) + '</span></div>';
  }

  // Un path = un percorso documentale completo e alternativo agli altri path dello
  // stesso risultato: idChoices sono alternative OR tra loro (separate da "oppure"),
  // extras sono documenti aggiuntivi obbligatori per quel percorso (AND, sotto "+ obbligatorio").
  function pathBlockHtml(p) {
    var idCards = p.idChoices.map(function (t, i) {
      return (i > 0 ? '<div class="ic-or-sep">oppure</div>' : '') + docCardHtml('ti-id-badge', t, false);
    }).join('');
    var html = '<div class="ic-path-block"><div class="ic-card-row">' + idCards + '</div>';
    if (p.extras && p.extras.length) {
      html += '<div class="ic-extras-sep">+ obbligatorio</div><div class="ic-card-row">' +
        p.extras.map(function (t) { return docCardHtml('ti-file-plus', t, true); }).join('') + '</div>';
    }
    html += '</div>';
    return html;
  }

  function pathsGroupHtml(paths) {
    var body = paths.length
      ? '<div class="ic-paths-wrap">' + paths.map(pathBlockHtml).join('<div class="ic-path-divider">OPPURE</div>') + '</div>'
      : '<div class="ic-empty">Nessun documento richiesto per questa combinazione.</div>';
    return '<div class="ic-result-group ic-main"><div class="ic-result-head"><span class="icon"><i class="ti ti-id-badge"></i></span>Documento/i di identità</div>' + body + '</div>';
  }

  function extraGroupHtml(items) {
    var body = items.length
      ? '<div class="ic-card-row">' + items.map(function (t) { return docCardHtml('ti-file-plus', t, true); }).join('') + '</div>'
      : '<div class="ic-empty">Nessuna documentazione aggiuntiva necessaria.</div>';
    return '<div class="ic-result-group ic-extra"><div class="ic-result-head"><span class="icon"><i class="ti ti-file-plus"></i></span>Documentazione aggiuntiva</div>' + body + '</div>';
  }

  function noteGroupHtml(items) {
    var body = items.length
      ? '<div class="ic-note-list">' + items.map(function (t) { return '<div class="ic-note-item">' + escapeHtml(t) + '</div>'; }).join('') + '</div>'
      : '<div class="ic-empty">Nessuna nota operativa.</div>';
    return '<div class="ic-result-group ic-notes"><div class="ic-result-head"><span class="icon"><i class="ti ti-info-circle"></i></span>Note operative</div>' + body + '</div>';
  }

  function renderResult() {
    var res = ICRules.computeDocuments(state);
    var html = pathsGroupHtml(res.paths) + extraGroupHtml(res.extra) + noteGroupHtml(res.note);
    document.getElementById('icResult').innerHTML = html;
  }

  renderLeft();
  renderResult();
})();
