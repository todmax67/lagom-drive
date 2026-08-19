# Lagom Drive — Progetto dell'evoluzione OBD

*Bussola di progetto, agosto 2026. Nata da una sessione di solo ragionamento: fissa
decisioni, principi e confini, non è un backlog. Le chat implementative partono da
qui; dove i numeri sono indicativi, è detto esplicitamente. Lo stato dei DID
(confermati, ipotesi, scale) vive in `src/lib/volvo-uds.ts` e nella chat di
decodifica, non in questo documento.*

## 1. Obiettivi e non-obiettivi

**Obiettivo primario:** un metodo per monitorare la salute della batteria di
trazione — capacità *misurata* da tre stimatori indipendenti, non dichiarata da
un registro solo.

**Obiettivo secondo:** un'app per consumi, rigenerazione e ricariche, sia private
(AC) che pubbliche (DC).

**Strumentale:** l'esperimento 12V in corso non è una feature: serve solo al
verdetto "il dongle può restare sempre inserito?".

**Non-obiettivi** (decisi, non dimenticati):
- la sentinella continua a riposo e l'hardware fisso in auto: rinunciati finché
  gli obiettivi restano questi (la curva AC non serve, il bilancio la sostituisce);
- prodotto multi-modello, store, utenti terzi: la mappa DID vale per *questa*
  XC40 (MY2023); la EX30 del nipote è piattaforma SEA, nulla si trasferisce;
- iOS: la raccolta via Web Bluetooth esiste solo su Android/Chrome. Se cambia il
  telefono, cambia il piano.

## 2. Architettura in tre frasi

1. **Due sorgenti, due orologi.** L'API Volvo via cron (minuti, 24 ore su 24) e
   il dongle via rituali (ore, quando c'è qualcuno in auto). Nessuna delle due
   regge l'altra: ogni superficie funziona con la sola API, e i dati OBD
   arricchiscono quando ci sono.
2. **La PWA resta la consultazione per sempre.** La raccolta oggi è PWA
   (Android/Chrome); domani un guscio nativo (Capacitor o simile) che *ri-ospita*
   lo stesso core — vedi §5. Il guscio è un ponte BLE, non una seconda app.
3. **Misurare e interpretare restano separati.** Il grezzo si conserva
   (`didRaw`, esadecimale); le interpretazioni sono colonne tipizzate promosse
   dal Lab e ricalcolabili quando una scala cambia.

## 3. I tre principi trasversali

1. **Provenienza dichiarata.** Ogni numero ha un livello e lo mostra:
   - *1 · misurato* — integrato/letto dai campioni OBD;
   - *2 · dichiarato* — trip computer o statistiche Volvo;
   - *3 · dedotto* — ΔSoC × capacità di lavoro;
   - *0 · onesto* — solo i fatti (km, orari), nessun numero inventato.
   Si mostra il migliore disponibile, col badge della fonte e l'età del dato.
   I buchi non si interpolano mai: si vedono, e sopra una soglia fanno
   retrocedere il titolo di livello.
2. **Stati espliciti.** "In validazione", "fatta/da fare", "fermo da N letture",
   copertura in percentuale: l'app non dichiara mai più di quanto ha misurato.
3. **Atti deliberati.** Promuovere la capacità misurata, promuovere un DID a
   colonna, revocare un token: azioni esplicite e reversibili, mai automatismi.

**Convenzione colore trasversale:** corallo = energia che *esce* dal pacco
(trazione), verde-acqua = energia che *entra* (recupero, ricariche). Vale in
tutti i grafici: se il significato regge ovunque, la legenda diventa superflua.

## 4. Le sei superfici

Navigazione a cinque voci — Oggi, Viaggi, Ricariche, Salute, Lab — più
Impostazioni. Le tab attuali Statistiche e Posizione si riassorbono in Oggi.

### 4.1 Oggi — la pagina dei due orologi

- Stato dell'auto a tre posizioni (a riposo / in guida / in carica) che decide
  il primo piano; ogni card dichiara fonte e freschezza ("cloud · 6 min",
  "sonda · 5 h").
- Card della **sonda del buongiorno**: energia residua, 12V a riposo, delta dal
  giorno prima, stato del rituale (fatta/da fare, SoH settimanale).
- Il banner di raccolta ferma resta globale, sopra tutto, su ogni pagina.

### 4.2 Viaggi — consumi reali, rigenerazione, cascata

Il rilevatore attuale (salto odometrico retrospettivo, ricostruzione della
partenza sui plateau, campi nulli quando la finestra è sporca) **non si tocca**:
l'arricchimento OBD è uno strato sopra, mai una riscrittura.

| Livello | Fonte | Cosa dà |
|---|---|---|
| 1 | ∫ `packPowerKw` sui campioni agganciati | trazione lorda, recupero, quota clima, curva |
| 2 | trip computer Volvo (km × media) | solo il netto |
| 3 | ΔSoC × capacità di lavoro | netto grezzo (1% ≈ 0,7 kWh) |
| 0 | — | km e orari, sempre |

- **Accoppiatore**: aggancio per finestra temporale con margini larghi (i tempi
  API sono ricostruiti); *attacca e rifinisce* — i campioni con velocità > 0
  correggono anche `startedAt`/`endedAt`. Idempotente: i lotti tardivi
  ricalcolano, un derivato è solo l'ultima versione del grezzo.
- **Copertura**: tempo campionato / durata. ≥ ~95% → livello 1 pieno; intermedia
  → scomposizione visibile ma titolo a livello 2, buchi come bande grigie;
  bassa → livelli 2/3. (Soglie indicative, da tarare.)
- **Rigenerazione**: metrica solo di livello 1 — recupero lordo (∫ potenza
  negativa in marcia) e quota di recupero (lordo/trazione). L'attuale
  `energyRegenKwh` da saldo positivo va rinominato "recupero netto": è un'altra
  grandezza. Niente analisi per singola frenata, niente distinzione
  rilascio/pedale: non osservabili onestamente.
- **Punto capacità** per Salute dai viaggi ben coperti: netto integrato /
  ΔsocReal. Con il SoC decimale le soglie di eleggibilità attuali (15 km, 10
  punti) possono scendere.
- L'energia delle soste lunghe tra due viaggi è una voce a sé della giornata,
  non si spalma sui consumi. Costo per viaggio al prezzo medio mensile del
  registro ricariche (niente FIFO).
- **Ricomposizione dei ritagli**: il rilevatore spezza una guida ogni volta che
  l'odometro scatta a metà strada — raramente sulla CMA, che lo aggiorna solo
  all'arrivo, di continuo sulla SEA, che lo aggiorna a ogni poll. La cura sta
  nella lettura, mai nel rilevatore: due ritagli sono la stessa guida se lo dice
  la **sessione OBD** (prova forte: due sessioni diverse restano due guide) o,
  senza dongle, se la **ripartenza** si osserva entro pochi minuti. La
  ripartenza è il primo segno di movimento dopo la chiusura del ritaglio —
  carica che scende (parla sulla CMA) oppure odometro che avanza (parla sulla
  SEA): servono entrambi i testimoni, ciascuno è cieco su una piattaforma.
  Trappole già pagate, da non ripetere: la contiguità di odometro e orari **non
  prova niente**, il rilevatore la produce per costruzione; e il plateau
  dell'odometro alla giunzione misura la sosta solo dove l'odometro è vivo.
  Un intervallo scoperto in cui i chilometri dicono velocità di marcia è un
  buco di raccolta, non una fermata — ma solo se in mezzo non c'è alcun
  campione: vederla ferma è diverso dal non guardarla.
- **Fusione a mano** (opzione parcheggiata, non ancora costruita): la misura ha
  la grana del polling, quindi le soste fra i tre e i sette minuti cadono di
  qua o di là senza che i dati possano decidere. Lì l'unico testimone che sa è
  chi guidava: unire o separare due guide a mano, con la scelta persistita e
  vincente sull'automatismo, e dichiarata come tale ("unita a mano") — la
  stessa forma della promozione. **Criterio di attivazione**: quando capiterà
  di vedere in lista una guida sbagliata, non prima; oggi il margine osservato
  è pulito (fusioni fra 2,0 e 4,4 minuti, sosta minima fra le respinte 5,7).

### 4.3 Ricariche — AC è contabilità, DC è fisica

Il rilevatore di sessioni dall'API e l'inserimento manuale **non si toccano**:
restano i padroni del ciclo di vita. I campioni OBD si agganciano e rifiniscono
(stessa grammatica dei viaggi).

**Correzione della base di costo** (difetto scoperto in progettazione): oggi
`energyAdded` = ΔSoC × capacità è lato *pacco*, ma la tariffa si paga lato
*muro*: i costi attuali sono ottimisti di ~8-15% (le perdite AC). I kWh
diventano due popoli — *pagati* ed *entrati* — con l'efficienza come tasso di
cambio. Il vecchio calcolo resta come livello 3 dichiarato.

- **AC (bilancio, via sonda).** Il bookend serale è viziato (l'energia residua
  risale a riposo): l'unità contabile è il **registro giornaliero** chiuso dalla
  sonda del mattino — ΔE tra due mattine = ricariche − viaggi − standby, e il
  residuo è il controllo di sanità. Per-sessione con barra d'errore; il titolo
  robusto è il **mensile**. Lato muro: campo opzionale per i kWh della wallbox
  letti a mano; un contatore vero è un upgrade, non un prerequisito.
- **Il numero nuovo**: costo per kWh *utile* = tariffa ÷ efficienza. Lo usano i
  costi per viaggio e il confronto casa/colonnina.
- **DC (curva, via registratore).** Sei presente, la banda abbonda: un giro
  completo ogni 5-10 s disegna la curva kW/SoC etichettata con le temperature
  del liquido. Prodotti: libreria dei taper per fascia di temperatura,
  pianificazione (dove staccare), diagnosi delle sessioni lente (pacco freddo /
  taper fisiologico / colonnina che deratizza), fatturato vs pacco.
- **Niente curva AC**: è piatta per costruzione, il bilancio basta.

### 4.4 Salute — tre testimoni, una tela, una sentenza

- **Testimone A**: registro SoH del BECM (economico, settimanale). **B**:
  ricariche — ΔE/ΔSoC sui bookend; più avanti conteggio coulombiano quando la
  scala della corrente è fissata. **C**: viaggi — lo storico dedotto già in
  tabella più i punti misurati.
- **Si confrontano pendenze, non quote**: i tre non misurano la stessa grandezza
  in assoluto. Assi separati (kWh a sinistra per i punti, % a destra per il
  SoH); lo scarto stabile tra linea e punti è informazione (stima congiunta
  della nominale vera e della scala del registro).
- Ogni punto porta condizioni: temperatura (colore — l'avvallamento invernale
  deve leggersi come stagione), ampiezza della finestra SoC (barra d'errore),
  riposo degli estremi (i viaggi la violano: testimone rumoroso per natura).
- **La sentenza**: stati *in linea / meglio del previsto / da osservare /
  degrado anomalo*. Regressione robusta su finestra mobile 6-12 mesi, confronto
  stagione su stagione, e la regola del cron generalizzata: allarme sul segnale
  persistente, mai sul singolo punto. "Degrado anomalo" richiede ≥ 2 testimoni
  concordi per più mesi; un testimone solo che devia produce "da osservare".
  Banda attesa di flotta ~2-3%/anno all'inizio; la garanzia (70% a 8
  anni/160.000 km) è orizzonte legale, non aspettativa.
- **Validazione del testimone A**: linea tratteggiata finché non si muove; se
  resta piatto mentre B e C scendono, declassato a "numero di cortesia" — esito
  informativo quanto la conferma.
- **Promozione della capacità**: quando B ha abbastanza punti concordi, la
  misurata diventa la capacità *di lavoro* (Impostazioni, §4.6); la nominale
  resta come riferimento del degrado. Atto esplicito, reversibile, con ricalcolo
  dei derivati dedotti.
- **Angolo 12V**: tensione mattutina a riposo + `parasiticMa` del CEM. La
  lettura sveglia il paziente: vale il *primo* valore dopo il risveglio.
  Allerta su soglia assoluta (~12,0 V) o tendenza in discesa per settimane.
- Cold start onesto: prima sentenza piena attesa ~6 mesi dopo l'avvio della
  raccolta misurata (febbraio 2027); prima, la pagina dichiara l'attesa.

### 4.5 Lab — il metodo scientifico come interfaccia

- Strumenti: Sonda, Registratore, Analisi sessioni (il grezzo si conserva).
- **Ciclo di vita delle ipotesi DID**: ipotesi → in validazione → confermato →
  colonna tipizzata + superficie consumer (promozione formale); oppure →
  **bocciata**. Il cimitero resta visibile: le bocciature sono conoscenza pagata
  (es. `22489E` come contatore di viaggio).
- **Esperimenti come cittadini di prima classe**: con prossima azione e
  scadenza (es. notte senza dongle → confronto al mattino).
- Dopo ogni aggiornamento software Volvo (OTA): giro di riconferma dei DID
  prima di fidarsi delle colonne.

### 4.6 Impostazioni — poche manopole, una cambia natura

- Tariffe casa/pubblica: input puri con anteprima (come oggi).
- **Capacità batteria**: blocco a due valori — *di lavoro* (oggi impostata) e
  *misurata* (da Salute) col bottone di promozione e lo storico.
- **Dispositivi OBD**: elenco con ultimo contatto e revoca token a portata di
  mano (superficie di sicurezza).
- Stato **Volvo ID** (oggi si scopre solo quando muore al login).
- Le soglie interne (copertura, finestre, sentenza) restano costanti nel codice
  finché l'uso non dimostra che devono diventare manopole.

## 5. Il lato raccolta

### 5.1 I regimi del Registratore

Il cambio di regime è automatico, dai segnali (GPS, potenza, stato di carica),
non da scelta manuale. Cadenze indicative: **il Registratore misura le proprie
cadenze reali e le dichiara** (vedi bolla di qualità).

- **Sosta: nessun polling.** Il rispetto della 12V è un requisito. La rinuncia
  alla sentinella è una decisione, non una mancanza.
- **Buongiorno** (script su richiesta, < 1 minuto): prima il CEM — 12V e
  parassita, il primo valore dopo il risveglio è quello buono — poi il BECM
  (socReal, energia residua), SoH una volta a settimana; ripristino; fine.
- **Viaggio** (loop asimmetrico): la banda del dongle è scarsa e i salti di
  centralina costano. Potenza (`packPowerKw`, BECM) a ~1-2 Hz; **velocità dal
  GPS del telefono** — gratis, fuori dal bus: il budget si spende su ciò che
  solo il bus sa; socReal denso solo agli estremi della sessione; clima ogni
  30-60 s; odometro ai bookend.
- **Carica DC** (giro pieno ogni 5-10 s): potenza, socReal, liquido in/out,
  tensione, corrente — e le ipotesi `didRaw` a bordo: la DC è il momento d'oro
  dell'esplorazione (banda abbondante, auto sveglia, utente presente).

### 5.2 Sessioni, lotti, tamponi

- Sessione con **id generato dal client** e **contesto dichiarato**
  (buongiorno/viaggio/carica/libero); l'inferenza sui buchi resta come fallback.
- Lotti ogni ~10-20 s verso `/api/obd/ingest`; su fallimento coda locale
  (IndexedDB) e svuotamento opportunistico; dedupe server su
  `[deviceId, recordedAt]` (già in schema).
- Ogni lotto porta la **versione dell'app** (sha del deploy): il server la
  registra e il Lab avvisa quando il bundle è vecchio.

### 5.3 Trappole già pagate, codificate in regole

1. Il ripristino dopo i blocchi Volvo include sempre `ATSHDB33F1` (senza, i PID
   standard muoiono per la sessione).
2. Il primo DID dopo la preparazione fallisce quasi sempre: retry di diritto.
3. Bundle vecchio dopo un deploy: si rileva dalla versione nei lotti (regola 5.2).
4. Wake Lock: si riacquisisce su `visibilitychange`; il buco si registra col suo
   motivo e non si interpola — diventa copertura.

### 5.4 Galateo col veicolo e sicurezza

- Solo letture (servizio 22); nessuna scrittura oltre gli AT di configurazione.
- Mai sondare un'auto che dorme; buongiorno breve; disconnessione a fine rituale.
- Token per dispositivo (hash) con revoca in Impostazioni. Il pairing del Vgate
  è debole: finché l'esperimento parassita non dà il verdetto, il dongle non
  resta inserito di default — e la decisione "sempre inserito" è comunque anche
  una decisione di sicurezza, non solo di consumo.

### 5.5 La bolla di qualità

Ogni sessione si porta dietro: cadenze ottenute per segnale, buchi con motivo
(Wake Lock perso, BLE caduta), versione app, contesto. La copertura a valle si
calcola da qui: la materia prima arriva con la sua etichetta.

### 5.6 Cosa compra il guscio nativo (e cosa no)

Compra: foreground service (registrazione a schermo spento), avvio automatico
all'aggancio BLE, riconnessione robusta, GPS continuo, notifiche ("stai guidando
senza registrare"). **Non cambia**: canale, protocollo Volvo, regimi, lotti — il
core va tenuto trasportabile perché il guscio sia un ri-hosting, non una
riscrittura. Criterio di attivazione: quando i buchi da Wake Lock o l'avvio
manuale costano più del progetto del guscio — realisticamente insieme alla curva
DC in mobilità, o quando la registrazione dei viaggi diventa quotidiana.

## 6. Il collante dati (tocchi di schema, concettuali)

- Arricchimenti di viaggi e sessioni come **strato separato** dai rilevatori
  (che non si toccano), con timbri di provenienza e copertura sui derivati.
- `ChargingSession`: campi opzionali per kWh muro, kWh pacco e fonte.
- Metadati di sessione OBD: contesto, versione app, bolla di qualità.
- Tutto ricalcolabile dal grezzo: le promozioni (capacità, scale DID) rileggono
  la storia invece di perderla.

## 7. Sequenza di costruzione

1. **Accoppiatore + arricchimento Viaggi** — i dati sono già in casa, valore
   immediato.
2. **Sonda del buongiorno come rituale guidato** + card in Oggi + bilancio AC
   (e correzione della base di costo appena esiste il primo dato lato muro).
3. **Salute** — quando i punti bastano; prima sentenza ~febbraio 2027.
4. **Curva DC + guscio Android** — è qui che il guscio diventa attuale.

Il Lab (ipotesi/esperimenti) evolve in parallelo con la chat di decodifica.

## 8. Cosa non fare (deciso, con motivo)

- Niente FIFO sui costi: prezzo medio mensile.
- Niente curva AC: il bilancio la sostituisce.
- Niente analisi per-evento di frenata: non osservabile onestamente.
- Niente interpolazione dei buchi: copertura e retrocessione di livello.
- Niente manopole per le soglie interne: costanti finché l'uso non le reclama.
- Niente sentinella/hardware fisso finché gli obiettivi restano questi.
- Niente ambizioni multi-modello: la mappa DID è di questa macchina.

## 9. Rischi e vincoli

- **Mappa DID fragile agli OTA**: riconferma nel Lab dopo ogni aggiornamento.
- **Rate limit API Volvo**: 10.000 chiamate/giorno *per applicazione*, condiviso
  con la EX30 del nipote.
- **La lettura sveglia il paziente**: i valori a riposo sono i primi dopo il
  risveglio, e ogni sonda costa un po' di 12V.
- **Web Bluetooth è Android/Chrome**: un cambio di telefono cambia il piano.
- **La PWA va ricaricata dopo i deploy** (mitigata da 5.2, ma resta vera).

## 10. Glossario

- **Sonda del buongiorno**: lettura mattutina unica ad auto riposata che chiude
  il registro del giorno prima (viaggi + ricariche + standby).
- **Bookend**: coppia di letture ferme che delimita un bilancio.
- **Registro giornaliero**: l'unità contabile delle ricariche AC.
- **Cascata di provenienza**: livelli 1/2/3/0 con badge della fonte.
- **Copertura**: quota di viaggio realmente campionata; decide il livello.
- **Accoppiatore**: aggancio per finestra temporale, attacca-e-rifinisce,
  idempotente.
- **Promozione**: atto deliberato che trasforma una misura in valore di lavoro
  (capacità) o un'ipotesi in colonna (DID).
- **Tribunale/sentenza**: la logica a stati della pagina Salute.
- **Regime**: modalità di campionamento del Registratore (sosta, buongiorno,
  viaggio, carica).
- **Bolla di qualità**: metadati di sessione da cui si calcola la copertura.
- **Guscio**: wrapper nativo Android che ri-ospita il core di raccolta.
