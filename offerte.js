(function () {
  var offerte = [];
  var customFields = [];      // [{id,key,label,ordine,field_type}]
  var activeCatFilters = [];
  var activeTipoFilters = [];
  var ofSearchTerm = '';
  var gdSearchTerm = '';
  var gdSortField = null;     // 'categoria' | 'tipo' | 'nome' | field.key
  var gdSortDir = 1;          // 1 asc, -1 desc
  var currentDetailId = null;
  var pendingLinkedIds = [];
  var linkSelectableList = [];
  var linkSearchTerm = '';
  var _activeBadgeFilters = [];

  var CAT_LABEL = { consumer: 'Consumer', business: 'Business' };
  var TIPO_LABEL = { mobile: 'Mobile', fisso: 'Fisso', opzione: 'Opzione' };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function attrEsc(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  // ================= CARICAMENTO DATI =================
  async function loadOfferte() {
    var grid = document.getElementById('ofGrid');
    grid.innerHTML = '<p class="sub">Caricamento tariffe&hellip;</p>';
    try {
      var res1 = await sb.from('wt_offerte').select('*').order('ordine');
      if (res1.error) throw res1.error;
      offerte = res1.data || [];
      await loadCustomFields();
      renderGestioneHeader();
    } catch (err) {
      console.error('Errore caricamento tariffe:', err);
      offerte = [];
      grid.innerHTML = '<p class="sub">Errore nel caricamento. Verifica che la tabella wt_offerte esista su Supabase.</p>';
      return;
    }
    // filtro Badge disattivato su richiesta: resta solo Categoria/Tipo
    renderGrid();
    if (document.getElementById('view-gestione') && !document.getElementById('view-gestione').classList.contains('hidden')) {
      renderGestioneTable();
    }
  }

  async function loadCustomFields() {
    try {
      var { data, error } = await sb.from('wt_custom_columns').select('*').order('ordine');
      if (error) throw error;
      customFields = data || [];
    } catch (err) {
      console.error('Errore caricamento campi:', err);
      customFields = [];
    }
  }

  function fieldVal(o, key) {
    return (o.extra && o.extra[key] !== undefined) ? o.extra[key] : '';
  }

  function matchesSearch(o, term) {
    if (!term) return true;
    var haystack = [o.nome];
    customFields.forEach(function (f) { haystack.push(fieldVal(o, f.key)); });
    return haystack.some(function (v) { return v && String(v).toLowerCase().indexOf(term) > -1; });
  }

  // ================= CAMPI PERSONALIZZATI =================
  function slugify(label) {
    return label.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || ('col_' + Date.now());
  }

  document.getElementById('gdAddColumn').addEventListener('click', async function () {
    var label = prompt('Nome del nuovo campo (es. "Sconto attivatore", "Codice interno"):');
    if (!label || !label.trim()) return;
    var key = slugify(label.trim());
    if (customFields.some(function (f) { return f.key === key; })) {
      alert('Esiste gi\u00e0 un campo con questo nome.');
      return;
    }
    var typeChoice = prompt('Tipo di campo: scrivi "testo", "paragrafo" (multi-riga) o "flag" (s\u00ec/no)', 'testo');
    var field_type = 'text';
    if (typeChoice) {
      var t = typeChoice.trim().toLowerCase();
      if (t.indexOf('parag') === 0) field_type = 'textarea';
      else if (t.indexOf('flag') === 0 || t.indexOf('si') === 0 || t.indexOf('s\u00ec') === 0) field_type = 'checkbox';
    }
    var ordine = customFields.length;
    try {
      var { error } = await sb.from('wt_custom_columns').insert({ key: key, label: label.trim(), ordine: ordine, field_type: field_type });
      if (error) throw error;
      await loadCustomFields();
      renderGestioneHeader();
      renderGestioneTable();
      renderGrid();
    } catch (err) {
      alert('Errore nella creazione del campo: ' + err.message);
    }
  });



  async function removeField(field) {
    if (!confirm('Eliminare il campo "' + field.label + '"? I dati salvati per ogni tariffa in questo campo andranno persi dalla visualizzazione.')) return;
    try {
      await sb.from('wt_custom_columns').delete().eq('id', field.id);
      await loadCustomFields();
      renderGestioneHeader();
      renderGestioneTable();
      renderGrid();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  // ================= FILTRI (Dettaglio Tariffe) =================
  document.querySelectorAll('.of-chip[data-filter-cat]').forEach(function (chip) {
    chip.addEventListener('click', function () { toggleFilter(chip, activeCatFilters, chip.dataset.filterCat); });
  });
  document.querySelectorAll('.of-chip[data-filter-tipo]').forEach(function (chip) {
    chip.addEventListener('click', function () { toggleFilter(chip, activeTipoFilters, chip.dataset.filterTipo); });
  });
  document.getElementById('ofSearchInput').addEventListener('input', function () {
    ofSearchTerm = this.value.trim().toLowerCase();
    renderGrid();
  });
  function toggleFilter(chip, arr, value) {
    var idx = arr.indexOf(value);
    if (idx > -1) { arr.splice(idx, 1); chip.classList.remove('active'); }
    else { arr.push(value); chip.classList.add('active'); }
    renderGrid();
  }
  function renderBadgeFilters() {
    var group = document.getElementById('ofBadgeFilterGroup');
    var badges = [];
    offerte.forEach(function (o) {
      var b = fieldVal(o, 'badge');
      if (b && badges.indexOf(b) === -1) badges.push(b);
    });
    group.querySelectorAll('.of-chip').forEach(function (c) { c.remove(); });
    badges.forEach(function (b) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'of-chip' + (_activeBadgeFilters.indexOf(b) > -1 ? ' active' : '');
      chip.textContent = b;
      chip.addEventListener('click', function () {
        var idx = _activeBadgeFilters.indexOf(b);
        if (idx > -1) { _activeBadgeFilters.splice(idx, 1); chip.classList.remove('active'); }
        else { _activeBadgeFilters.push(b); chip.classList.add('active'); }
        renderGrid();
      });
      group.appendChild(chip);
    });
    group.classList.toggle('hidden', badges.length === 0);
  }

  function filteredOfferte() {
    return offerte.filter(function (o) {
      var catOk = activeCatFilters.length === 0 || activeCatFilters.indexOf(o.categoria) > -1;
      var tipoOk = activeTipoFilters.length === 0 || activeTipoFilters.indexOf(o.tipo) > -1;
      var badge = fieldVal(o, 'badge');
      var badgeOk = _activeBadgeFilters.length === 0 || _activeBadgeFilters.indexOf(badge) > -1;
      var searchOk = matchesSearch(o, ofSearchTerm);
      return catOk && tipoOk && badgeOk && searchOk;
    });
  }

  // ================= GRIGLIA CARD =================




  function familyOf(o) {
    // solo "a valle": tutto ciò a cui questa tariffa converge, a catena (X -> Y -> Z ...)
    // niente "a monte": chi converge verso o non deve comparire/illuminarsi qui.
    var result = [];
    var seen = {};
    seen[o.id] = true;
    var queue = (o.linked_ids || []).slice();
    while (queue.length) {
      var id = queue.shift();
      if (seen[id]) continue;
      seen[id] = true;
      var node = offerte.filter(function (x) { return x.id === id; })[0];
      if (!node) continue;
      result.push(node);
      (node.linked_ids || []).forEach(function (nid) { if (!seen[nid]) queue.push(nid); });
    }
    return result;
  }

  function buildCardInnerHtml(o) {
    var cfg = getCardConfig(o);
    var hidden = cfg.hiddenFields || [];
    var prominentKey = cfg.prominentField || null;
    var cardFields = customFields.filter(function (f) { return hidden.indexOf(f.key) === -1 && f.key !== prominentKey; });
    var prominentField = prominentKey ? customFields.filter(function (f) { return f.key === prominentKey; })[0] : null;
    var badge = fieldVal(o, 'badge');
    var badgeHtml = badge ? '<div class="of-badge">' + escapeHtml(badge) + '</div>' : '';
    var prominentHtml = '';
    if (prominentField) {
      var pv = fieldVal(o, prominentField.key);
      if (pv && prominentField.field_type !== 'checkbox') {
        prominentHtml = '<div class="of-prominent-label">' + escapeHtml(prominentField.label) + '</div><div class="of-prominent">' + escapeHtml(pv) + '</div>';
      }
    }
    var fieldsHtml = cardFields.map(function (f) {
      var v = fieldVal(o, f.key);
      if (f.field_type === 'checkbox') {
        return v === true ? '<div class="of-extra-field"><b>' + escapeHtml(f.label) + '</b></div>' : '';
      }
      if (!v) return '';
      return '<div class="of-extra-field"><b>' + escapeHtml(f.label) + ':</b> ' + escapeHtml(v) + '</div>';
    }).join('');
    var family = familyOf(o);
    var linkHtml = family.length ? '<div class="of-link-badge">\uD83D\uDD17 Bundle con ' + family.length + ' altra' + (family.length > 1 ? '/e' : '') + ' tariffa/e</div>' : '';
    var catTag = o.categoria === 'business' ? 'BIZ' : 'CONS';
    var borderColor = o.tipo === 'fisso' ? '#ffb020' : (o.tipo === 'opzione' ? '#7fe8a0' : '#8fe8ff');
    return '<div class="of-card-header" style="border-left-color:' + borderColor + '">' +
        '<div class="of-corner-tag">' + catTag + '</div>' +
        badgeHtml +
        '<div class="of-nome">' + escapeHtml(o.nome) + '</div>' +
      '</div>' +
      '<div class="of-card-body">' +
        prominentHtml +
        fieldsHtml +
        linkHtml +
      '</div>' +
      '<div class="of-tag">' + CAT_LABEL[o.categoria] + ' &middot; ' + TIPO_LABEL[o.tipo] + '</div>';
  }

  // ================= GRIGLIA CARD =================
  function renderGrid() {
    var grid = document.getElementById('ofGrid');
    var list = filteredOfferte();
    if (!list.length) {
      grid.innerHTML = '<p class="sub">Nessuna tariffa corrisponde ai filtri scelti.</p>';
      return;
    }
    grid.innerHTML = '';
    list.forEach(function (o) {
      var card = document.createElement('div');
      card.className = 'of-card';
      card.dataset.id = o.id;
      card.innerHTML = buildCardInnerHtml(o);
      card.addEventListener('click', function () { openDetail(o.id); });
      var family = familyOf(o);
      if (family.length) {
        var familyIds = family.map(function (x) { return x.id; }).concat([o.id]);
        card.addEventListener('mouseenter', function () {
          familyIds.forEach(function (fid) {
            var el = grid.querySelector('.of-card[data-id="' + fid + '"]');
            if (el) el.classList.add('linked-highlight');
          });
        });
        card.addEventListener('mouseleave', function () {
          document.querySelectorAll('.of-card.linked-highlight').forEach(function (c) {
            c.classList.remove('linked-highlight');
          });
        });
      }
      grid.appendChild(card);
    });
  }

  document.getElementById('ofAddNewCard').addEventListener('click', function () {
    openDetail(null, true);
  });

  // ================= RIORDINA TARIFFE (modale, lista semplice) =================
  var reorderSortable = null;

  document.getElementById('ofReorderBtn').addEventListener('click', function () {
    document.getElementById('ofReorderBackdrop').classList.remove('hidden');
    renderReorderList();
  });
  document.getElementById('ofReorderClose').addEventListener('click', function () {
    document.getElementById('ofReorderBackdrop').classList.add('hidden');
    if (reorderSortable) { reorderSortable.destroy(); reorderSortable = null; }
  });
  document.getElementById('ofReorderBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'ofReorderBackdrop') document.getElementById('ofReorderClose').click();
  });

  function renderReorderList() {
    var list = document.getElementById('ofReorderList');
    list.innerHTML = '';
    var sorted = offerte.slice().sort(function (a, b) { return (a.ordine || 0) - (b.ordine || 0); });
    sorted.forEach(function (o) {
      var row = document.createElement('div');
      row.className = 'of-reorder-row';
      row.dataset.id = o.id;
      row.innerHTML = '<span class="of-reorder-handle">&#9776;</span>' +
        '<span class="orr-name">' + escapeHtml(o.nome) + '</span>' +
        '<span class="orr-tag">' + CAT_LABEL[o.categoria] + ' \u00b7 ' + TIPO_LABEL[o.tipo] + '</span>';
      list.appendChild(row);
    });
    if (reorderSortable) reorderSortable.destroy();
    reorderSortable = new Sortable(list, {
      animation: 150,
      handle: '.of-reorder-handle',
      ghostClass: 'sortable-ghost',
      chosenClass: 'sortable-chosen',
      onEnd: function () { persistReorderList(); }
    });
  }

  async function persistReorderList() {
    var statusEl = document.getElementById('ofReorderStatus');
    var rows = Array.prototype.slice.call(document.querySelectorAll('#ofReorderList .of-reorder-row'));
    statusEl.textContent = 'Salvataggio...';
    statusEl.className = 'status';
    var ops = [];
    rows.forEach(function (row, i) {
      var o = offerte.filter(function (x) { return x.id === row.dataset.id; })[0];
      var newOrdine = (i + 1) * 10;
      if (o && o.ordine !== newOrdine) {
        ops.push(sb.from('wt_offerte').update({ ordine: newOrdine }).eq('id', o.id));
      }
    });
    try {
      if (ops.length) await Promise.all(ops);
      await loadOfferte();
      statusEl.textContent = 'Ordine salvato.';
      statusEl.className = 'status ok';
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  }

  // ================= CONFIGURATORE CARD (per singola tariffa) =================
  function getCardConfig(o) {
    return o.card_config || {};
  }

  async function updateCardConfig(o, patch) {
    var cfg = Object.assign({}, getCardConfig(o), patch);
    try {
      await sb.from('wt_offerte').update({ card_config: cfg }).eq('id', o.id);
      o.card_config = cfg;
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  async function moveField(field, direction, currentOfferta) {
    var idx = customFields.indexOf(field);
    var swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= customFields.length) return;
    var other = customFields[swapIdx];
    try {
      await Promise.all([
        sb.from('wt_custom_columns').update({ ordine: other.ordine }).eq('id', field.id),
        sb.from('wt_custom_columns').update({ ordine: field.ordine }).eq('id', other.id)
      ]);
      await loadCustomFields();
      renderGestioneHeader();
      renderGestioneTable();
      renderGrid();
      if (currentOfferta) renderCardConfigBox(currentOfferta);
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  }

  function renderCardConfigBox(o) {
    var list = document.getElementById('ofCardConfigList');
    list.innerHTML = '';
    var cfg = getCardConfig(o);
    var hidden = cfg.hiddenFields || [];
    var prominentKey = cfg.prominentField || null;
    customFields.forEach(function (f, idx) {
      var row = document.createElement('div');
      row.className = 'of-config-row';
      var isHidden = hidden.indexOf(f.key) > -1;
      var isProminent = prominentKey === f.key;
      var upBtn = document.createElement('button');
      upBtn.type = 'button'; upBtn.title = 'Sposta su';
      upBtn.textContent = '\u25b2';
      upBtn.disabled = idx === 0;
      upBtn.style.opacity = idx === 0 ? '.3' : '1';
      upBtn.addEventListener('click', function () { moveField(f, -1, o); });
      var downBtn = document.createElement('button');
      downBtn.type = 'button'; downBtn.title = 'Sposta gi\u00f9';
      downBtn.textContent = '\u25bc';
      downBtn.disabled = idx === customFields.length - 1;
      downBtn.style.opacity = idx === customFields.length - 1 ? '.3' : '1';
      downBtn.addEventListener('click', function () { moveField(f, 1, o); });
      var eyeBtn = document.createElement('button');
      eyeBtn.type = 'button';
      eyeBtn.title = isHidden ? 'Nascosto su questa card: clicca per mostrare' : 'Visibile su questa card: clicca per nascondere';
      eyeBtn.textContent = isHidden ? '\uD83D\uDEAB' : '\uD83D\uDC41\uFE0F';
      eyeBtn.addEventListener('click', async function () {
        var newHidden = isHidden ? hidden.filter(function (k) { return k !== f.key; }) : hidden.concat([f.key]);
        var patch = { hiddenFields: newHidden };
        if (!isHidden && prominentKey === f.key) patch.prominentField = null;
        await updateCardConfig(o, patch);
        renderCardConfigBox(o);
        renderGrid();
      });
      var starBtn = document.createElement('button');
      starBtn.type = 'button';
      starBtn.title = isProminent ? 'In evidenza su questa card: clicca per togliere' : 'Metti in evidenza su questa card (es. il canone)';
      starBtn.textContent = isProminent ? '\u2B50' : '\u2606';
      starBtn.addEventListener('click', async function () {
        var newProminent = isProminent ? null : f.key;
        await updateCardConfig(o, { prominentField: newProminent });
        renderCardConfigBox(o);
        renderGrid();
      });
      var label = document.createElement('span');
      label.className = 'ofc-label';
      label.textContent = f.label;
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(label);
      row.appendChild(starBtn);
      row.appendChild(eyeBtn);
      list.appendChild(row);
    });
    if (!customFields.length) {
      list.innerHTML = '<p class="sub">Nessun campo ancora creato. Aggiungine uno da "Database Offerte".</p>';
    }

    var previewWrap = document.getElementById('ofCardConfigPreview');
    var card = document.createElement('div');
    card.className = 'of-card';
    card.style.cursor = 'default';
    card.innerHTML = buildCardInnerHtml(o);
    previewWrap.innerHTML = '';
    previewWrap.appendChild(card);
  }


  // ================= MODALE DETTAGLIO / MODIFICA =================
  function openDetail(id, startInEdit) {
    currentDetailId = id;
    document.getElementById('ofDetailBackdrop').classList.remove('hidden');
    var o = id ? offerte.filter(function (x) { return x.id === id; })[0] : null;
    if (startInEdit) showEditForm(o);
    else showDetailView(o);
  }
  document.getElementById('ofDetailClose').addEventListener('click', function () {
    document.getElementById('ofDetailBackdrop').classList.add('hidden');
  });
  document.getElementById('ofDetailBackdrop').addEventListener('click', function (ev) {
    if (ev.target.id === 'ofDetailBackdrop') document.getElementById('ofDetailBackdrop').classList.add('hidden');
  });

  function showDetailView(o) {
    document.getElementById('ofDetailTitle').textContent = 'Dettaglio tariffa';
    document.getElementById('ofDetailView').classList.remove('hidden');
    document.getElementById('ofEditForm').classList.add('hidden');
    document.getElementById('ofDetailName').textContent = o.nome;
    document.getElementById('ofDetailTag').textContent = CAT_LABEL[o.categoria] + ' \u00b7 ' + TIPO_LABEL[o.tipo];
    var wrap = document.getElementById('ofDetailFields');
    wrap.innerHTML = customFields.map(function (f) {
      var v = fieldVal(o, f.key);
      var displayVal;
      if (f.field_type === 'checkbox') displayVal = v === true ? 'S\u00ec' : 'No';
      else displayVal = v ? escapeHtml(v) : '';
      var emptyClass = (!v && f.field_type !== 'checkbox') ? ' dv-empty' : '';
      var stackedClass = f.field_type === 'textarea' ? ' of-detail-field-stacked' : '';
      return '<div class="of-detail-field' + stackedClass + '"><div class="dl">' + escapeHtml(f.label) + '</div><div class="dv' + emptyClass + '">' + (displayVal || 'Non impostato') + '</div></div>';
    }).join('');

    var others = familyOf(o);
    var linkedWrap = document.getElementById('ofLinkedWrap');
    if (others.length) {
      linkedWrap.classList.remove('hidden');
      var listEl = document.getElementById('ofLinkedList');
      listEl.innerHTML = '';
      others.forEach(function (x) {
        var mini = document.createElement('div');
        mini.className = 'of-card of-linked-card';
        mini.dataset.linkedId = x.id;
        mini.innerHTML = buildCardInnerHtml(x);
        mini.addEventListener('click', function () { openDetail(x.id); });
        listEl.appendChild(mini);
      });
    } else {
      linkedWrap.classList.add('hidden');
    }
  }

  document.getElementById('ofDetailEditBtn').addEventListener('click', function () {
    var o = offerte.filter(function (x) { return x.id === currentDetailId; })[0];
    showEditForm(o);
  });
  document.getElementById('ofDetailDeleteBtn').addEventListener('click', async function () {
    if (!currentDetailId) return;
    if (!confirm('Eliminare questa tariffa?')) return;
    try {
      await sb.from('wt_offerte').delete().eq('id', currentDetailId);
      document.getElementById('ofDetailBackdrop').classList.add('hidden');
      await loadOfferte();
    } catch (err) {
      alert('Errore: ' + err.message);
    }
  });

  function renderLinkChecklist(list, term) {
    var wrap = document.getElementById('ofFormLinkedList');
    var filtered = term ? list.filter(function (x) { return x.nome.toLowerCase().indexOf(term) > -1; }) : list;
    if (!filtered.length) {
      wrap.innerHTML = '<p class="sub">Nessuna tariffa trovata.</p>';
      return;
    }
    wrap.innerHTML = '';
    filtered.forEach(function (x) {
      var row = document.createElement('label');
      row.className = 'of-link-check-row';
      var isChecked = pendingLinkedIds.indexOf(x.id) > -1;
      row.innerHTML = '<input type="checkbox" value="' + x.id + '"' + (isChecked ? ' checked' : '') + '>' +
        '<span class="oflc-name">' + escapeHtml(x.nome) + '</span>' +
        '<span class="oflc-tag">' + CAT_LABEL[x.categoria] + ' \u00b7 ' + TIPO_LABEL[x.tipo] + '</span>';
      row.querySelector('input').addEventListener('change', function (ev) {
        if (ev.target.checked) {
          if (pendingLinkedIds.indexOf(x.id) === -1) pendingLinkedIds.push(x.id);
        } else {
          pendingLinkedIds = pendingLinkedIds.filter(function (id) { return id !== x.id; });
        }
      });
      wrap.appendChild(row);
    });
  }

  document.getElementById('ofFormLinkSearch').addEventListener('input', function () {
    linkSearchTerm = this.value.trim().toLowerCase();
    renderLinkChecklist(linkSelectableList, linkSearchTerm);
  });

  function showEditForm(o) {
    document.getElementById('ofDetailTitle').textContent = o ? 'Modifica tariffa' : 'Nuova tariffa';
    document.getElementById('ofEditFormLegend').textContent = o ? 'Dati Tariffa' : 'Nuova Tariffa';
    document.getElementById('ofDetailView').classList.add('hidden');
    document.getElementById('ofEditForm').classList.remove('hidden');
    document.getElementById('ofFormId').value = o ? o.id : '';
    document.getElementById('ofFormCategoria').value = o ? o.categoria : 'consumer';
    document.getElementById('ofFormTipo').value = o ? o.tipo : 'mobile';
    document.getElementById('ofFormNome').value = o ? o.nome : '';
    document.getElementById('ofFormStatus').textContent = '';

    if (o) {
      document.getElementById('ofCardConfigBox').classList.remove('hidden');
      renderCardConfigBox(o);
    } else {
      document.getElementById('ofCardConfigBox').classList.add('hidden');
    }

    var linkedListWrap = document.getElementById('ofFormLinkedList');
    var linkSearchInput = document.getElementById('ofFormLinkSearch');
    linkedListWrap.innerHTML = '';
    linkSearchInput.value = '';
    linkSearchTerm = '';
    if (!o) {
      linkedListWrap.innerHTML = '<p class="sub">Salva prima la tariffa per poter scegliere i collegamenti.</p>';
      linkSearchInput.disabled = true;
    } else {
      linkSearchInput.disabled = false;
      pendingLinkedIds = (o.linked_ids || []).slice();
      linkSelectableList = offerte.filter(function (x) { return x.id !== o.id; });
      renderLinkChecklist(linkSelectableList, '');
    }

    var extraWrap = document.getElementById('ofFormExtraFields');
    extraWrap.innerHTML = '';
    customFields.forEach(function (f) {
      var v = o ? fieldVal(o, f.key) : '';
      var row = document.createElement('div');
      row.className = 'row';
      if (f.field_type === 'checkbox') {
        row.innerHTML = '<div class="field wide"><label class="radio-opt" style="display:flex;align-items:center;gap:8px;"><input type="checkbox" data-extra-key="' + f.key + '" data-type="checkbox"' + (v === true ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#ffb020;"> ' + escapeHtml(f.label) + '</label></div>';
      } else if (f.field_type === 'textarea') {
        row.innerHTML = '<div class="field wide"><label>' + escapeHtml(f.label) + '</label><textarea data-extra-key="' + f.key + '" rows="3">' + escapeHtml(v) + '</textarea></div>';
      } else {
        row.innerHTML = '<div class="field wide"><label>' + escapeHtml(f.label) + '</label><input type="text" data-extra-key="' + f.key + '" value="' + attrEsc(v) + '"></div>';
      }
      extraWrap.appendChild(row);
    });
  }

  document.getElementById('ofFormCancel').addEventListener('click', function () {
    if (currentDetailId) {
      var o = offerte.filter(function (x) { return x.id === currentDetailId; })[0];
      showDetailView(o);
    } else {
      document.getElementById('ofDetailBackdrop').classList.add('hidden');
    }
  });

  document.getElementById('ofFormSave').addEventListener('click', async function () {
    var statusEl = document.getElementById('ofFormStatus');
    var id = document.getElementById('ofFormId').value;
    var nome = document.getElementById('ofFormNome').value.trim();
    if (!nome) { statusEl.textContent = 'Il nome \u00e8 obbligatorio.'; statusEl.className = 'status err'; return; }
    var extra = {};
    document.querySelectorAll('#ofFormExtraFields [data-extra-key]').forEach(function (input) {
      extra[input.dataset.extraKey] = input.dataset.type === 'checkbox' ? input.checked : input.value;
    });
    var record = {
      categoria: document.getElementById('ofFormCategoria').value,
      tipo: document.getElementById('ofFormTipo').value,
      nome: nome,
      linked_ids: pendingLinkedIds.slice(),
      extra: extra
    };
    if (id) record.id = id;
    statusEl.textContent = 'Salvataggio...';
    statusEl.className = 'status';
    try {
      var { data, error } = await sb.from('wt_offerte').upsert(record).select();
      if (error) throw error;
      var savedId = id || (data && data[0] && data[0].id);
      await loadOfferte();
      currentDetailId = savedId;
      var saved = offerte.filter(function (x) { return x.id === savedId; })[0];
      if (saved) showDetailView(saved);
      else document.getElementById('ofDetailBackdrop').classList.add('hidden');
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  // ================= GESTIONE DATI (tabella editabile e ordinabile) =================
  var gdRows = {};
  var gdRowCounter = 0;
  var gdSelected = {};

  function renderGestioneHeader() {
    var headerRow = document.getElementById('gdHeaderRow');
    if (!headerRow) return;
    while (headerRow.children.length > 2) headerRow.removeChild(headerRow.lastChild);

    function addSortTh(label, sortKey, extraButtons, extraClass) {
      var th = document.createElement('th');
      th.className = 'gd-sort-th' + (extraClass ? ' ' + extraClass : '');
      var arrow = gdSortField === sortKey ? (gdSortDir === 1 ? ' \u25b2' : ' \u25bc') : '';
      var span = document.createElement('span');
      span.textContent = label + arrow;
      th.appendChild(span);
      th.addEventListener('click', function (ev) {
        if (ev.target.tagName === 'BUTTON') return;
        if (gdSortField === sortKey) gdSortDir = -gdSortDir; else { gdSortField = sortKey; gdSortDir = 1; }
        renderGestioneHeader();
        renderGestioneTable();
      });
      if (extraButtons) extraButtons.forEach(function (b) { th.appendChild(b); });
      headerRow.appendChild(th);
    }

    addSortTh('Categoria', 'categoria');
    addSortTh('Tipo', 'tipo');
    addSortTh('Nome', 'nome');

    customFields.forEach(function (f) {
      var rmBtn = document.createElement('button');
      rmBtn.type = 'button'; rmBtn.className = 'gd-col-remove'; rmBtn.title = 'Elimina campo'; rmBtn.innerHTML = '&times;';
      rmBtn.addEventListener('click', function (ev) { ev.stopPropagation(); removeField(f); });
      addSortTh(f.label, f.key, [rmBtn], 'gd-custom-col');
    });

    var endTh = document.createElement('th');
    headerRow.appendChild(endTh);
  }

  function sortedFilteredOfferte() {
    var list = offerte.filter(function (o) { return matchesSearch(o, gdSearchTerm); });
    if (!gdSortField) return list;
    return list.slice().sort(function (a, b) {
      var va, vb;
      if (['categoria', 'tipo', 'nome'].indexOf(gdSortField) > -1) { va = a[gdSortField] || ''; vb = b[gdSortField] || ''; }
      else { va = fieldVal(a, gdSortField); vb = fieldVal(b, gdSortField); }
      if (typeof va === 'boolean' || typeof vb === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
      else { va = String(va).toLowerCase(); vb = String(vb).toLowerCase(); }
      if (va < vb) return -1 * gdSortDir;
      if (va > vb) return 1 * gdSortDir;
      return 0;
    });
  }

  function renderGestioneTable() {
    var tbody = document.getElementById('gdTbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    gdRows = {};
    gdSelected = {};
    updateGdDeleteButton();
    document.getElementById('gdSelectAll').checked = false;
    sortedFilteredOfferte().forEach(function (o) {
      var key = 'r' + (gdRowCounter++);
      gdRows[key] = { id: o.id, isNew: false, dirty: false, values: {
        categoria: o.categoria, tipo: o.tipo, nome: o.nome,
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

    var selCell = document.createElement('td');
    selCell.className = 'gd-flag-cell';
    selCell.innerHTML = '<input type="checkbox" class="gd-row-select">';
    selCell.querySelector('input').addEventListener('change', function (ev) {
      if (ev.target.checked) gdSelected[key] = true; else delete gdSelected[key];
      updateGdDeleteButton();
    });
    tr.appendChild(selCell);

    var editCell = document.createElement('td');
    editCell.className = 'gd-flag-cell';
    editCell.innerHTML = '<button type="button" class="gd-del-btn" style="color:#7fc4dc" title="Apri scheda completa">\u270e</button>';
    editCell.querySelector('button').addEventListener('click', function () {
      var full = offerte.filter(function (o) { return o.id === row.id; })[0];
      openDetail(full ? full.id : null, true);
    });
    tr.appendChild(editCell);

    function td(inputHtml) {
      var cell = document.createElement('td');
      cell.innerHTML = inputHtml;
      return cell;
    }

    var catSel = '<select data-f="categoria"><option value="consumer"' + (row.values.categoria === 'consumer' ? ' selected' : '') + '>Consumer</option><option value="business"' + (row.values.categoria === 'business' ? ' selected' : '') + '>Business</option></select>';
    var tipoSel = '<select data-f="tipo"><option value="mobile"' + (row.values.tipo === 'mobile' ? ' selected' : '') + '>Mobile</option><option value="fisso"' + (row.values.tipo === 'fisso' ? ' selected' : '') + '>Fisso</option><option value="opzione"' + (row.values.tipo === 'opzione' ? ' selected' : '') + '>Opzione</option></select>';
    tr.appendChild(td(catSel));
    tr.appendChild(td(tipoSel));
    tr.appendChild(td('<input type="text" class="gd-nome-input" data-f="nome" value="' + attrEsc(row.values.nome) + '">'));

    ['categoria', 'tipo', 'nome'].forEach(function (f) {
      tr.querySelector('[data-f="' + f + '"]').addEventListener('input', function (ev) {
        row.values[f] = ev.target.value;
        row.dirty = true;
        tr.className = row.isNew ? 'gd-new' : 'gd-dirty';
      });
    });

    customFields.forEach(function (field) {
      var cell = document.createElement('td');
      var v = (row.values.extra && row.values.extra[field.key] !== undefined) ? row.values.extra[field.key] : '';
      if (field.field_type === 'textarea') {
        cell.innerHTML = '<textarea data-extra="' + field.key + '">' + escapeHtml(v) + '</textarea>';
      } else if (field.field_type === 'checkbox') {
        cell.className = 'gd-flag-cell';
        cell.innerHTML = '<input type="checkbox" data-extra="' + field.key + '"' + (v === true ? ' checked' : '') + '>';
      } else {
        cell.innerHTML = '<input type="text" data-extra="' + field.key + '" value="' + attrEsc(v) + '">';
      }
      var inputEl = cell.querySelector('[data-extra]');
      var evName = field.field_type === 'checkbox' ? 'change' : 'input';
      inputEl.addEventListener(evName, function () {
        if (!row.values.extra) row.values.extra = {};
        row.values.extra[field.key] = field.field_type === 'checkbox' ? inputEl.checked : inputEl.value;
        row.dirty = true;
        tr.className = row.isNew ? 'gd-new' : 'gd-dirty';
      });
      tr.appendChild(cell);
    });

    var delCell = document.createElement('td');
    delCell.innerHTML = '<button type="button" class="gd-del-btn" title="Elimina">\uD83D\uDDD1</button>';
    delCell.querySelector('button').addEventListener('click', function () { gdDeleteRow(key); });
    tr.appendChild(delCell);

    return tr;
  }

  function gdDeleteRow(key) {
    var row = gdRows[key];
    if (row.isNew) {
      delete gdRows[key];
      document.querySelector('#gdTbody tr[data-key="' + key + '"]').remove();
      return;
    }
    if (!confirm('Eliminare questa tariffa?')) return;
    sb.from('wt_offerte').delete().eq('id', row.id).then(function (res) {
      if (res.error) { alert('Errore: ' + res.error.message); return; }
      delete gdRows[key];
      document.querySelector('#gdTbody tr[data-key="' + key + '"]').remove();
      loadOfferte();
    });
  }

  function updateGdDeleteButton() {
    var btn = document.getElementById('gdDeleteSelected');
    var n = Object.keys(gdSelected).length;
    btn.classList.toggle('hidden', n === 0);
    btn.textContent = 'Elimina selezionate (' + n + ')';
  }

  document.getElementById('gdSearchInput').addEventListener('input', function () {
    gdSearchTerm = this.value.trim().toLowerCase();
    renderGestioneTable();
  });

  document.getElementById('gdSelectAll').addEventListener('change', function (ev) {
    var checked = ev.target.checked;
    gdSelected = {};
    document.querySelectorAll('#gdTbody tr').forEach(function (tr) {
      var cb = tr.querySelector('.gd-row-select');
      if (cb) cb.checked = checked;
      if (checked) gdSelected[tr.dataset.key] = true;
    });
    updateGdDeleteButton();
  });

  document.getElementById('gdDeleteSelected').addEventListener('click', async function () {
    var keys = Object.keys(gdSelected);
    if (!keys.length) return;
    if (!confirm('Eliminare ' + keys.length + ' tariffe selezionate? L\'operazione non \u00e8 reversibile.')) return;
    var statusEl = document.getElementById('gdStatus');
    statusEl.textContent = 'Eliminazione in corso...';
    statusEl.className = 'status';
    var idsToDelete = keys.map(function (k) { return gdRows[k] && gdRows[k].id; }).filter(function (id) { return id; });
    var newRowKeys = keys.filter(function (k) { return gdRows[k] && gdRows[k].isNew; });
    try {
      if (idsToDelete.length) {
        var { error } = await sb.from('wt_offerte').delete().in('id', idsToDelete);
        if (error) throw error;
      }
      newRowKeys.forEach(function (k) {
        var el = document.querySelector('#gdTbody tr[data-key="' + k + '"]');
        if (el) el.remove();
        delete gdRows[k];
      });
      statusEl.textContent = 'Eliminate ' + keys.length + ' tariffe.';
      statusEl.className = 'status ok';
      gdSelected = {};
      updateGdDeleteButton();
      await loadOfferte();
      renderGestioneTable();
    } catch (err) {
      statusEl.textContent = 'Errore: ' + err.message;
      statusEl.className = 'status err';
    }
  });

  document.getElementById('gdAddRow').addEventListener('click', function () {
    var key = 'r' + (gdRowCounter++);
    gdRows[key] = { id: null, isNew: true, dirty: true, values: { categoria: 'consumer', tipo: 'mobile', nome: '', extra: {} } };
    document.getElementById('gdTbody').appendChild(buildGdRow(key));
  });

  document.getElementById('gdSaveAll').addEventListener('click', async function () {
    var statusEl = document.getElementById('gdStatus');
    var dirtyKeys = Object.keys(gdRows).filter(function (k) { return gdRows[k].dirty; });
    if (!dirtyKeys.length) { statusEl.textContent = 'Nessuna modifica da salvare.'; statusEl.className = 'status'; return; }
    statusEl.textContent = 'Salvataggio di ' + dirtyKeys.length + ' righe...';
    statusEl.className = 'status';
    var errors = [];
    for (var i = 0; i < dirtyKeys.length; i++) {
      var row = gdRows[dirtyKeys[i]];
      if (!row.values.nome.trim()) continue;
      var record = { categoria: row.values.categoria, tipo: row.values.tipo, nome: row.values.nome, extra: row.values.extra || {} };
      if (row.id) record.id = row.id;
      var res = await sb.from('wt_offerte').upsert(record);
      if (res.error) errors.push(row.values.nome + ': ' + res.error.message);
    }
    if (errors.length) { statusEl.textContent = 'Errori: ' + errors.join(' | '); statusEl.className = 'status err'; }
    else { statusEl.textContent = 'Tutte le modifiche sono state salvate.'; statusEl.className = 'status ok'; }
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
  if (document.getElementById('ofGrid')) loadOfferte();
})();
