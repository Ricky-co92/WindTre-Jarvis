import { readFileSync, writeFileSync } from 'node:fs';

const families = JSON.parse(readFileSync('empty-categoria-families.json', 'utf8'));

// Proposed scheme: reuse the 4 existing categories where they clearly fit, plus
// 5 new ones for clusters that don't map to any existing category at all.
const FLAGGED = [
  // looks like a misfiled personal/customer document (name + phone number), not
  // reference material — surfaced separately rather than force-categorized.
  { re: /^Marinella Nese/i, note: 'possibile documento cliente (nome+telefono) finito per errore nell\'archivio — verificare se va escluso' },
];

const RULES = [
  // existing categories first (highest confidence keyword matches)
  { cat: 'Canvass', re: /canvass|winback|^cb /i },
  { cat: 'Guide', re: /selling guide|\bguid|^sg /i },
  { cat: 'Sintesi Offerte', re: /^offert|^sintesi|listino|multiservice|portafoglio|fisso e convergenza|luce e gas|conv(ergenza)? energy/i },
  // new categories for clusters with no home in the existing 4
  { cat: 'Prezzi e Costi', re: /\bcost[oi]?\b|prezz[oi]|vou?c+her|switchconvoltura|fwa (indoor|pvt|brezza)/i },
  { cat: 'Set Informativi', re: /^set ?informativo|^scheda ?sintetic|^schede ?sintetic/i },
  { cat: 'Protecta e Assicurazioni', re: /protecta|protett[oi]|assicurazion|deutsche bank|affittuario|proprietario/i },
  { cat: 'Travel e Roaming', re: /travel|roaming/i },
  { cat: 'Procedure e Moduli', re: /procedura|delibera|dichiarazione sostitutiva|\bmnp\b|anagrafica cliente|attivazione (convergenza|fwa)|gestione cambio esim|reload|verifica copertura|schema subentro|cambio piano fisso|rimodulazione|recupera pratica/i },
  { cat: 'Locandine e Flyer', re: /locandina|flyer|novita/i },
  // generic single-word family titles disambiguated earlier by appending a period
  // in parentheses (see manuali.js isGenericKey fix) are one-off canvass-period
  // price/service breakdown sheets — default them to Prezzi e Costi.
  { cat: 'Prezzi e Costi', re: /\([^)]+\)\s*$/ },
];

// One-off manual calls for titles too idiosyncratic for a keyword rule to catch safely.
const OVERRIDES = {
  'Etnico Special': 'Sintesi Offerte',
  'Fisso Very': 'Sintesi Offerte',
  'Voce E Dati': 'Sintesi Offerte',
  'New Conv En': 'Sintesi Offerte',
  'Schema Offerte Fisso&convergenza': 'Sintesi Offerte',
  'Infoblocco L&g Ott24 Newprice': 'Sintesi Offerte',
  'Protezionepro Lista Attivita': 'Protecta e Assicurazioni',
  'Scenari Configurazione Impianti E Analisi Rischi': 'Protecta e Assicurazioni',
  'Processodirecuperapratica002': 'Procedure e Moduli',
  'Anagraficaclienteconpartitaivacensimentodatinovembre25': 'Procedure e Moduli',
  'Bigino Digitale Piva': 'Guide',
};

const proposal = families.map((f) => {
  const flag = FLAGGED.find((fl) => fl.re.test(f.titolo));
  if (OVERRIDES[f.titolo]) return { ...f, categoria_proposta: OVERRIDES[f.titolo], confidence: 'manual', flag: flag?.note || null };
  for (const rule of RULES) {
    if (rule.re.test(f.titolo)) return { ...f, categoria_proposta: rule.cat, confidence: 'high', flag: flag?.note || null };
  }
  return { ...f, categoria_proposta: null, confidence: 'none', flag: flag?.note || null };
});

const byCat = {};
proposal.forEach((f) => {
  const k = f.categoria_proposta || '(nessuna proposta — da rivedere)';
  (byCat[k] = byCat[k] || []).push(f.titolo);
});

console.log('=== RIEPILOGO PROPOSTA ===');
Object.keys(byCat).sort().forEach((k) => console.log(`${k}: ${byCat[k].length}`));

console.log('\n=== TITOLI SENZA PROPOSTA (da rivedere manualmente) ===');
(byCat['(nessuna proposta — da rivedere)'] || []).sort().forEach((t) => console.log(' -', t));

writeFileSync('categoria-proposal.json', JSON.stringify(proposal, null, 2));
console.log('\nScritto categoria-proposal.json');
