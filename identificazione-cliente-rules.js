// Logica pura di calcolo documenti per il modulo "Identificazione Cliente".
// Nessuna dipendenza da DOM/Supabase: riceve uno stato e restituisce { paths, extra, note }.
// Isolato in questo file (invece che dentro identificazione-cliente.js) così le regole si
// possono aggiornare senza toccare il codice che gestisce pill/checkbox e il render.
(function () {
  var DOCS = {
    CI_IT: "Carta d'Identità Italiana",
    PAT_IT: "Patente di Guida Italiana",
    PASS_IT: "Passaporto Italiano",
    CI_ORIG: "Carta d'Identità Paese d'origine",
    PASS_ORIG: "Passaporto Paese d'origine",
    PERM_SOGG: "Permesso di Soggiorno in corso di validità",
    PERM_SOGG_PERM: "Permesso di Soggiorno Permanente (oltre 12 mesi)",
    CF_TS: "CF / Tessera Sanitaria (fronte-retro)",
    VISURA: "Visura Camerale Azienda",
    CERT_PIVA: "Certificato attribuzione P.IVA",
    DELEGA_RL: "Delega del Rappresentante Legale",
    RL_ORIG: "Doc. identità originale Rappr. Legale (verificare, non fotocopia)",
    RL_CF_ORIG: "Tesserino CF originale Rappr. Legale (verificare, non fotocopia)",
    RED_DIP: "Ultima busta paga (netto ordinario)",
    RED_PENS: "Ultimo cedolino pensione (o Obis/CU/IRPEF/Unico/730)",
    RED_AUT: "Ultimo Modello Unico"
  };

  // Un "path" rappresenta un percorso documentale accettabile.
  // idChoices: documenti di identità alternativi tra loro (OR) — basta uno.
  // extras: documenti aggiuntivi obbligatori per quel percorso (AND).
  // Più path nello stesso risultato = alternative complete (OPPURE tra i path).
  function path(idChoices, extras) {
    return { idChoices: idChoices, extras: extras || [] };
  }

  function computeDocuments(state) {
    var out = { paths: [], extra: [], note: [] };
    var isFinanziato = state.telIncluso === 'fin_std' || state.telIncluso === 'fin_rata';
    var isTelefonoIncluso = state.telIncluso !== 'no';
    var col = isTelefonoIncluso ? 'mdp' : (state.linea === 'untied' ? 'pura' : 'mdp');
    var p = state.profilo;

    if (p === 'turista') {
      out.paths = [
        state.cittadinanza === 'ue'
          ? path([DOCS.CI_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG])
          : path([DOCS.PASS_ORIG])
      ];
      out.note.push("Solo mobile prepagato su credito residuo. Campo Turista=SI in POS.");
      return out;
    }

    if (p === 'privato') {
      if (state.cittadinanza === 'it') {
        out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT])];
      } else if (state.cittadinanza === 'ue') {
        if (col === 'pura') {
          out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG])];
        } else {
          var mobile = state.linea !== 'fisso_modem' && state.linea !== 'fisso_nomodem' && state.linea !== 'fwa';
          if (state.telIncluso === 'var' && mobile) {
            out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT])];
            out.note.push("Passaporto non accettato per Telefono Incluso VAR su Mobile (accettato per Fisso/FWA Outdoor).");
          } else {
            out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG])];
          }
        }
      } else {
        if (col === 'pura') {
          out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG], [DOCS.PERM_SOGG])];
        } else if (state.telIncluso === 'var') {
          out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG], [DOCS.PERM_SOGG_PERM])];
        } else {
          out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG])];
          if (isFinanziato) out.note.push("Extra-UE + Finanziato: Permesso di Soggiorno NON necessario.");
        }
      }
    }

    if (p === 'libpro') {
      if (state.cittadinanza === 'it') {
        out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT])];
      } else if (state.cittadinanza === 'ue') {
        out.paths = [
          col === 'pura'
            ? path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG])
            : path([DOCS.CI_IT, DOCS.PAT_IT])
        ];
      } else {
        if (col === 'pura') {
          out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG], [DOCS.PERM_SOGG_PERM])];
        } else {
          out.paths = [
            path([DOCS.CI_IT, DOCS.PAT_IT]),
            path([DOCS.PASS_ORIG], [DOCS.PERM_SOGG_PERM])
          ];
        }
      }
      out.extra.push(DOCS.CERT_PIVA);
      out.note.push("Verifica preventiva P.IVA su telematici.agenziaentrate.gov.it/VerificaPIVA: titolare = cliente, stato ATTIVA.");
    }

    if (p === 'azienda') {
      out.note.push("Attivabile solo Azienda con Partita IVA italiana.");
      if (state.cittadinanza === 'it') {
        out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT])];
        out.extra.push(DOCS.VISURA);
      } else if (state.cittadinanza === 'ue') {
        out.paths = [path([DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG])];
        out.extra.push(DOCS.VISURA);
      } else {
        out.paths = [
          path([DOCS.CI_IT, DOCS.PAT_IT], [DOCS.VISURA]),
          path([DOCS.PASS_ORIG], [DOCS.PERM_SOGG_PERM])
        ];
      }
      if (state.delegaAzienda) {
        out.extra.push(DOCS.DELEGA_RL, DOCS.RL_ORIG, DOCS.RL_CF_ORIG);
        out.note.push("Delega: inserire in POS 'recapito alternativo' = 0121212.");
      }
    }

    var cfGia = false;
    if (isTelefonoIncluso) {
      out.extra.push(DOCS.CF_TS);
      cfGia = true;
      out.note.push("Telefono Incluso (VAR o Finanziato): CF/Tessera Sanitaria sempre richiesto. Con CIE (Carta d'Identità Elettronica, che riporta già il CF) non serve copia separata.");
    }
    if (state.pagatoreDiverso && state.telIncluso !== 'no') {
      out.extra.push(DOCS.CF_TS + ' del pagatore + doc. identità del pagatore');
    }
    if (state.mnpSostSim) {
      if (!cfGia) out.extra.push(DOCS.CF_TS);
      out.note.push("MNP/Sostituzione SIM: Visura Camerale/Cert. P.IVA-CF diventano obbligatori (non più facoltativi).");
    }
    if (isFinanziato && state.redditoCat) {
      var map = { dip: DOCS.RED_DIP, pens: DOCS.RED_PENS, aut: DOCS.RED_AUT };
      out.extra.push(map[state.redditoCat]);
    }

    out.note.push("Il Codice Fiscale è comunque sempre un dato anagrafico obbligatorio, a prescindere dalla copia fisica del documento, da allegare se non presente sul documento di identità.");
    return out;
  }

  window.ICRules = { computeDocuments: computeDocuments };
})();
