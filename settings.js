(function () {
  var users = [];
  var openId = null;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function loadUsers() {
    try {
      var res = await sb.from('wt_users_permissions').select('*').order('email');
      if (res.error) throw res.error;
      users = res.data || [];
      renderUsers();
    } catch (err) {
      console.error('Errore caricamento utenti:', err);
      document.getElementById('stgUsersList').innerHTML = '<p class="sub">Errore caricamento utenti.</p>';
    }
  }

  function renderUsers() {
    var wrap = document.getElementById('stgUsersList');
    if (!users.length) { wrap.innerHTML = '<p class="sub">Nessun utente configurato.</p>'; return; }
    wrap.innerHTML = '';
    users.forEach(function (u) {
      var card = document.createElement('div');
      card.className = 'stg-user-card';
      var isOpen = openId === u.id;
      card.innerHTML =
        '<div class="stg-user-head">' +
        '<span class="stg-user-email">' + escapeHtml(u.email) + '</span>' +
        (u.is_superadmin ? '<span class="stg-sa-badge">SUPERADMIN</span>' : '') +
        '</div>' +
        '<div class="stg-user-body' + (isOpen ? ' open' : '') + '" id="stgBody-' + u.id + '"></div>';
      card.querySelector('.stg-user-head').addEventListener('click', function () {
        openId = openId === u.id ? null : u.id;
        renderUsers();
      });
      wrap.appendChild(card);
      if (isOpen) renderUserBody(u);
    });
  }

  function renderUserBody(u) {
    var body = document.getElementById('stgBody-' + u.id);
    if (!body) return;
    var perms = JSON.parse(JSON.stringify(u.permissions || {}));

    var saRow = '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:#ffe6b0;margin-bottom:14px;">' +
      '<input type="checkbox" id="stgSA-' + u.id + '" ' + (u.is_superadmin ? 'checked' : '') + '> Questo utente &egrave; SuperAdmin (accesso completo a tutto, incluse Impostazioni)</label>';

    var pagesHtml = PAGES_REGISTRY.map(function (pg) {
      var pp = perms[pg.key] || {};
      var viewChk = '<label><input type="checkbox" class="stg-perm" data-page="' + pg.key + '" data-action="view" ' + (pp.view ? 'checked' : '') + '> Accesso alla pagina</label>';
      var actionsChk = pg.actions.map(function (a) {
        return '<label><input type="checkbox" class="stg-perm" data-page="' + pg.key + '" data-action="' + a.key + '" ' + (pp[a.key] ? 'checked' : '') + '> ' + escapeHtml(a.label) + '</label>';
      }).join('');
      return '<div class="stg-page-block"><div class="stg-page-title">' + escapeHtml(pg.label) + '</div>' +
        '<div class="stg-action-row">' + viewChk + actionsChk + '</div></div>';
    }).join('');

    body.innerHTML = saRow + '<div id="stgPagesWrap-' + u.id + '">' + pagesHtml + '</div>' +
      '<div class="stg-user-actions">' +
      '<button type="button" class="of-chip of-manage-btn" id="stgSaveBtn-' + u.id + '">Salva</button>' +
      '<button type="button" class="of-chip of-manage-btn" id="stgDelBtn-' + u.id + '" style="color:#ff6767;border-color:#ff6767;">Rimuovi utente</button>' +
      '<span class="status" id="stgStatus-' + u.id + '"></span>' +
      '</div>';

    document.getElementById('stgSA-' + u.id).addEventListener('change', function () {
      document.getElementById('stgPagesWrap-' + u.id).classList.toggle('hidden', this.checked);
    });
    document.getElementById('stgPagesWrap-' + u.id).classList.toggle('hidden', u.is_superadmin);

    document.getElementById('stgSaveBtn-' + u.id).addEventListener('click', async function () {
      var statusEl = document.getElementById('stgStatus-' + u.id);
      var isSA = document.getElementById('stgSA-' + u.id).checked;
      var newPerms = {};
      body.querySelectorAll('.stg-perm').forEach(function (chk) {
        var page = chk.dataset.page, action = chk.dataset.action;
        if (!newPerms[page]) newPerms[page] = {};
        newPerms[page][action] = chk.checked;
      });
      statusEl.textContent = 'Salvataggio...';
      statusEl.className = 'status';
      var res = await sb.from('wt_users_permissions').update({ is_superadmin: isSA, permissions: newPerms, updated_at: new Date().toISOString() }).eq('id', u.id);
      if (res.error) { statusEl.textContent = 'Errore: ' + res.error.message; statusEl.className = 'status err'; return; }
      statusEl.textContent = 'Salvato.';
      statusEl.className = 'status ok';
      await loadUsers();
    });

    document.getElementById('stgDelBtn-' + u.id).addEventListener('click', async function () {
      if (!confirm('Rimuovere l\'accesso per ' + u.email + '?')) return;
      var res = await sb.from('wt_users_permissions').delete().eq('id', u.id);
      if (res.error) { alert('Errore: ' + res.error.message); return; }
      openId = null;
      await loadUsers();
    });
  }

  document.getElementById('stgAddUserBtn').addEventListener('click', async function () {
    var email = document.getElementById('stgNewEmail').value.trim().toLowerCase();
    var isSA = document.getElementById('stgNewSuperadmin').checked;
    if (!email || email.indexOf('@') === -1) { alert('Inserisci un\'email valida.'); return; }
    var res = await sb.from('wt_users_permissions').insert({ email: email, is_superadmin: isSA, permissions: {} });
    if (res.error) { alert('Errore: ' + res.error.message); return; }
    document.getElementById('stgNewEmail').value = '';
    document.getElementById('stgNewSuperadmin').checked = false;
    await loadUsers();
  });

  document.addEventListener('jarvis:view', function (ev) {
    var view = ev.detail && ev.detail.view;
    if (view !== 'impostazioni') return;
    loadUsers();
  });
})();
