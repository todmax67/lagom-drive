#!/usr/bin/env node
/**
 * Estrae i comandi ELM327 da una cattura Bluetooth di Android, per scoprire
 * quali DID proprietari interroga Car Scanner.
 *
 * Le definizioni PID della piattaforma CMA non sono pubbliche: né OBDb né il
 * repository di ABRP coprono Volvo. Car Scanner le conosce, e le manda al
 * dongle come testo ASCII: nel log del Bluetooth compaiono in chiaro.
 *
 * Uso:
 *   node scripts/decodifica-snoop.mjs <btsnoop_hci.log | bugreport.zip>
 *
 * Il formato btsnoop viene ignorato di proposito: cercare le sequenze ASCII
 * stampabili è più robusto che interpretare gli strati HCI, L2CAP e ATT, e a
 * noi serve solo il testo che viaggia sulla caratteristica.
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const percorso = process.argv[2];
if (!percorso) {
  console.error('Uso: node scripts/decodifica-snoop.mjs <file>');
  process.exit(1);
}

let dati;
if (percorso.endsWith('.zip')) {
  // I bug report di Android racchiudono il log in un archivio
  const dentro = execSync(`unzip -Z1 "${percorso}"`, { encoding: 'utf8' })
    .split('\n')
    .find(n => /btsnoop.*\.log$/i.test(n));
  if (!dentro) {
    console.error('Nessun btsnoop trovato nel bug report.');
    process.exit(1);
  }
  console.log(`Estraggo ${dentro} dal bug report\n`);
  dati = execSync(`unzip -p "${percorso}" "${dentro}"`, { maxBuffer: 512 * 1024 * 1024 });
} else {
  dati = readFileSync(percorso);
}

// Sequenze stampabili di almeno tre caratteri: i comandi ELM327 e le loro
// risposte sono tutti ASCII, il resto del log è binario.
const testo = dati.toString('latin1');
const pezzi = testo.match(/[\x20-\x7E\r\n]{3,}/g) ?? [];

const COMANDO = /^(AT[A-Z0-9 ]*|[0-9A-F]{4,6})$/i;
const RISPOSTA = /^[0-9A-F\s]{4,}$/i;

const eventi = [];
for (const pezzo of pezzi) {
  for (const riga of pezzo.split(/[\r\n]+/)) {
    const r = riga.trim();
    if (!r || r === '>') continue;
    if (COMANDO.test(r)) eventi.push({ tipo: 'cmd', testo: r.toUpperCase() });
    else if (RISPOSTA.test(r) && r.replace(/\s/g, '').length >= 6)
      eventi.push({ tipo: 'risp', testo: r.replace(/\s/g, '').toUpperCase() });
  }
}

// Car Scanner imposta l'intestazione con ATSH e poi interroga il DID con il
// servizio 22: la coppia dice a quale centralina appartiene ogni grandezza.
let headerCorrente = null;
const letture = new Map();

for (let i = 0; i < eventi.length; i++) {
  const e = eventi[i];
  if (e.tipo !== 'cmd') continue;

  const sh = e.testo.match(/^ATSH\s*([0-9A-F]{3,8})$/);
  if (sh) { headerCorrente = sh[1]; continue; }

  const did = e.testo.match(/^22([0-9A-F]{4})$/);
  if (!did) continue;

  const risposta = eventi.slice(i + 1, i + 4).find(x => x.tipo === 'risp');
  const chiave = `${headerCorrente ?? '?'}|22${did[1]}`;
  if (!letture.has(chiave)) {
    letture.set(chiave, { header: headerCorrente ?? '?', did: did[1], risposte: new Set() });
  }
  if (risposta) letture.get(chiave).risposte.add(risposta.testo);
}

const ecuNoti = {
  '18DA10F1': 'PCM / motore', '18DA1AF1': 'BECM?', '18DA30F1': 'CEM?',
  '18DAF110': 'risposta da 0x10',
};

console.log(`Frammenti ASCII trovati: ${pezzi.length}`);
console.log(`Comandi e risposte riconosciuti: ${eventi.length}`);
console.log(`\n=== INTERROGAZIONI UDS (servizio 22) ===`);
if (letture.size === 0) {
  console.log('  Nessuna. Car Scanner potrebbe non aver interrogato sensori');
  console.log('  proprietari durante la cattura, oppure il log non contiene');
  console.log('  traffico ATT: verifica di aver riavviato dopo aver attivato');
  console.log('  il registro HCI, e che la cattura copra la sessione giusta.');
} else {
  console.log(`  ${'HEADER'.padEnd(10)} ${'DID'.padEnd(6)} RISPOSTE OSSERVATE`);
  for (const v of [...letture.values()].sort((a, b) => (a.header + a.did).localeCompare(b.header + b.did))) {
    const nome = ecuNoti[v.header] ? `  (${ecuNoti[v.header]})` : '';
    const risp = [...v.risposte].slice(0, 3).join('  ') || '(nessuna catturata)';
    console.log(`  ${v.header.padEnd(10)} 22${v.did}  ${risp}${nome}`);
  }
}

const headers = [...new Set([...letture.values()].map(v => v.header))].filter(h => h !== '?');
if (headers.length) {
  console.log(`\n=== CENTRALINE INTERROGATE ===`);
  headers.forEach(h => console.log(`  ATSH${h}`));
}

console.log(`\n=== ALTRI COMANDI VISTI ===`);
const altri = [...new Set(eventi.filter(e => e.tipo === 'cmd' && /^AT/.test(e.testo)).map(e => e.testo))];
altri.slice(0, 25).forEach(c => console.log(`  ${c}`));
