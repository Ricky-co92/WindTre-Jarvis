// Logica pura di calcolo documenti per il modulo "Identificazione Cliente".
// Nessuna dipendenza da DOM/Supabase: riceve uno stato e restituisce { main, extra, note }.
// Isolato in questo file (invece che dentro identificazione-cliente.js) così le regole si
// possono aggiornare senza toccare il codice che gestisce pill/checkbox e il render.
(function () {
  function computeDocuments(state) {
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

    var out = { main: [], extra: [], note: [] };
    var isFinanziato = state.telIncluso === 'fin_std' || state.telIncluso === 'fin_rata';
    var isTelefonoIncluso = state.telIncluso !== 'no';
    var col = isTelefonoIncluso ? 'mdp' : (state.linea === 'untied' ? 'pura' : 'mdp');
    var p = state.profilo;

    if (p === 'turista') {
      out.main = state.cittadinanza === 'ue'
        ? [DOCS.CI_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG]
        : [DOCS.PASS_ORIG];
      out.note.push("Solo mobile prepagato su credito residuo. Campo Turista=SI in POS.");
      return out;
    }

    if (p === 'privato') {
      if (state.cittadinanza === 'it') {
        out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT];
      } else if (state.cittadinanza === 'ue') {
        if (col === 'pura') {
          out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG];
        } else {
          out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG];
          var mobile = state.linea !== 'fisso_modem' && state.linea !== 'fisso_nomodem' && state.linea !== 'fwa';
          if (state.telIncluso === 'var' && mobile) {
            out.main = [DOCS.CI_IT, DOCS.PAT_IT];
            out.note.push("Passaporto non accettato per Telefono Incluso VAR su Mobile (accettato per Fisso/FWA Outdoor).");
          }
        }
      } else {
        if (col === 'pura') {
          out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PERM_SOGG, DOCS.PASS_ORIG];
        } else {
          out.main = [DOCS.CI_IT + ' / ' + DOCS.PAT_IT + ' / ' + DOCS.PASS_ORIG + ' (uno dei tre)'];
          if (state.telIncluso === 'var') {
            out.extra.push(DOCS.PERM_SOGG_PERM);
            out.note.push("Extra-UE + Telefono Incluso VAR: sempre richiesto Permesso di Soggiorno Permanente.");
          } else if (isFinanziato) {
            out.note.push("Extra-UE + Telefono Incluso Finanziato: Permesso di Soggiorno Permanente NON necessario.");
          }
        }
      }
    }

    if (p === 'libpro') {
      if (state.cittadinanza === 'it') {
        out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT];
      } else if (state.cittadinanza === 'ue') {
        out.main = col === 'pura'
          ? [DOCS.CI_IT, DOCS.PAT_IT, DOCS.CI_ORIG, DOCS.PASS_ORIG]
          : [DOCS.CI_IT, DOCS.PAT_IT];
      } else {
        if (col === 'pura') {
          out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PERM_SOGG_PERM, DOCS.PASS_ORIG];
        } else {
          out.main = [DOCS.CI_IT + ' / ' + DOCS.PAT_IT + ' (uno dei due)'];
          out.note.push("In alternativa: Passaporto Paese d'origine + Permesso di Soggiorno Permanente.");
        }
      }
      out.extra.push(DOCS.CERT_PIVA);
      out.note.push("Verifica preventiva P.IVA su telematici.agenziaentrate.gov.it/VerificaPIVA: titolare = cliente, stato ATTIVA.");
    }

    if (p === 'azienda') {
      out.note.push("Attivabile solo Azienda con Partita IVA italiana.");
      if (state.cittadinanza === 'it') {
        out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_IT];
      } else if (state.cittadinanza === 'ue') {
        out.main = [DOCS.CI_IT, DOCS.PAT_IT, DOCS.PASS_ORIG];
      } else {
        out.main = [DOCS.CI_IT + ' / ' + DOCS.PAT_IT + ' + Visura, oppure ' + DOCS.PASS_ORIG + ' + Permesso Soggiorno Permanente'];
        out.note.push("Se il cliente presenta un documento italiano + Visura/Cert. P.IVA, il Permesso di Soggiorno non è più richiesto.");
      }
      out.extra.push(DOCS.VISURA);
      if (state.delegaAzienda) {
        out.extra.push(DOCS.DELEGA_RL, DOCS.RL_ORIG, DOCS.RL_CF_ORIG);
        out.note.push("Delega: inserire in POS 'recapito alternativo' = 0121212.");
      }
    }

    var cfAggiunto = false;
    if (isTelefonoIncluso) {
      out.extra.push(DOCS.CF_TS);
      cfAggiunto = true;
      out.note.push("Telefono Incluso (VAR o Finanziato): CF/Tessera Sanitaria sempre richiesto. Se il cliente ha la CIE (già contiene il CF), non serve copia separata.");
    }
    if (!cfAggiunto && state.telIncluso !== 'no' && (p === 'azienda' || p === 'libpro')) {
      out.extra.push(DOCS.CF_TS);
      cfAggiunto = true;
    }
    if (state.pagatoreDiverso && state.telIncluso !== 'no') {
      out.extra.push(DOCS.CF_TS + ' del pagatore + doc. identità del pagatore');
    }
    if (state.mnpSostSim) {
      if (!cfAggiunto) out.extra.push(DOCS.CF_TS);
      out.note.push("MNP/Sostituzione SIM: Visura Camerale/Cert. P.IVA-CF diventano obbligatori (non più facoltativi).");
    }
    if (isFinanziato && state.redditoCat) {
      var map = { dip: DOCS.RED_DIP, pens: DOCS.RED_PENS, aut: DOCS.RED_AUT };
      out.extra.push(map[state.redditoCat]);
    }

    out.note.push("Il Codice Fiscale è comunque sempre un dato anagrafico obbligatorio, a prescindere dalla copia fisica del documento.");
    return out;
  }

  window.ICRules = { computeDocuments: computeDocuments };
})();
