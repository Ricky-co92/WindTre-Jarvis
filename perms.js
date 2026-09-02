var PAGES_REGISTRY = [
  { key: 'home', label: 'Home', actions: [] },
  { key: 'compilatore', label: 'Compilatore Moduli', actions: [] },
  {
    key: 'offerte', label: 'Dettaglio Tariffe', actions: [
      { key: 'edit_tariffa', label: 'Creare/modificare tariffe' },
      { key: 'delete_tariffa', label: 'Eliminare tariffe' },
      { key: 'reorder_tariffa', label: 'Riordinare tariffe' },
      { key: 'edit_config', label: 'Creare/modificare configurazioni' },
      { key: 'delete_config', label: 'Eliminare configurazioni' },
      { key: 'reorder_config', label: 'Riordinare configurazioni' }
    ]
  },
  {
    key: 'gestione', label: 'Database Offerte', actions: [
      { key: 'edit_cell', label: 'Modificare celle' },
      { key: 'manage_columns', label: 'Aggiungere/eliminare colonne' },
      { key: 'manage_rows', label: 'Aggiungere/eliminare righe' }
    ]
  },
  {
    key: 'comuni', label: 'Comuni Aree Bianche', actions: [
      { key: 'upload', label: 'Caricare file aggiornato' }
    ]
  },
  {
    key: 'manuali', label: 'Manuali', actions: [
      { key: 'upload', label: 'Caricare/aggiornare manuali' },
      { key: 'delete', label: 'Eliminare manuali' }
    ]
  },
  {
    key: 'parco_sim', label: 'Parco SIM', actions: [
      { key: 'edit', label: 'Creare/modificare schede e righe' },
      { key: 'delete', label: 'Eliminare schede' },
      { key: 'export', label: 'Esportare Excel' }
    ]
  },
  { key: 'identificazione_cliente', label: 'Identificazione Cliente', actions: [] }
];

var PERMS = {
  ready: false,
  isSuperAdmin: false,
  row: null,
  canView: function (page) {
    if (this.isSuperAdmin) return true;
    if (page === 'impostazioni') return false;
    var p = this.row && this.row.permissions && this.row.permissions[page];
    return !!(p && p.view);
  },
  can: function (page, action) {
    if (this.isSuperAdmin) return true;
    var p = this.row && this.row.permissions && this.row.permissions[page];
    return !!(p && p[action]);
  }
};

async function loadPermissions(user) {
  PERMS.ready = false;
  try {
    var res = await sb.from('wt_users_permissions').select('*').eq('email', user.email).maybeSingle();
    if (res.error) throw res.error;
    PERMS.row = res.data || null;
    PERMS.isSuperAdmin = !!(PERMS.row && PERMS.row.is_superadmin);
    if (PERMS.row && !PERMS.row.auth_user_id) {
      sb.from('wt_users_permissions').update({ auth_user_id: user.id }).eq('id', PERMS.row.id).then(function () {});
    }
  } catch (err) {
    console.error('Errore caricamento permessi:', err);
    PERMS.row = null;
    PERMS.isSuperAdmin = false;
  }
  PERMS.ready = true;
  applyNavVisibility();
  document.dispatchEvent(new CustomEvent('jarvis:permsReady'));
}

function applyNavVisibility() {
  document.querySelectorAll('.nav-item[data-view]').forEach(function (el) {
    var view = el.dataset.view;
    var visible = view === 'impostazioni' ? PERMS.isSuperAdmin : PERMS.canView(view);
    el.classList.toggle('hidden', !visible);
  });
}

function firstAccessibleView() {
  if (PERMS.canView('home')) return 'home';
  var found = PAGES_REGISTRY.filter(function (p) { return p.key !== 'home' && PERMS.canView(p.key); })[0];
  return found ? found.key : null;
}
