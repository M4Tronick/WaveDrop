# WaveDrop

_di **Matteo Davanzo** · licenza [MIT](LICENSE)_

Condivisione di file in stile AirDrop per Windows (funziona anche su macOS e Linux), con un'interfaccia in sovraimpressione. Ha un'app nativa per **Android** (Kotlin), una per **iPhone** (SwiftUI, compilata da Windows con xtool) e un'app web che funziona su qualsiasi telefono. Tutto è **cifrato end-to-end** e la prima volta si verifica l'altro dispositivo con un **codice a 6 cifre**.

## Come si usa

| Azione | Come |
| --- | --- |
| Aprire WaveDrop | `Ctrl + Alt + D` (si cambia nelle Impostazioni) oppure clic sull'icona vicino all'orologio |
| Inviare file | Clic su un dispositivo → scegli i file, oppure trascinali sull'avatar |
| Inviare cartelle, testo o link | Clic destro sul dispositivo → *Invia una cartella…* / *Invia appunti* |
| Trascinare da Esplora file | Porta i file sulla pillola in alto al centro dello schermo e rilasciali sull'avatar |
| «Invia a» di Esplora file | Impostazioni → Generale → *Mostra in «Invia a»*, poi clic destro su un file → Invia a → WaveDrop |
| Ricevere | Notifica in alto a destra con anteprima: **Rifiuta** / **Accetta**, con la casella *Accetta sempre da…* |

### Primo invio a un dispositivo: il codice
La prima volta che invii a un dispositivo:
1. Sul dispositivo che riceve compare un codice casuale di 6 cifre.
2. Lo scrivi sul tuo PC.
3. I due dispositivi diventano **contatti** e da quel momento si riconoscono da soli.

Se il codice è sbagliato 3 volte, l'abbinamento si annulla. Chi non conosce il codice non può fingersi l'altro dispositivo, e nemmeno mettersi in mezzo alla comunicazione.

### Contatti
In **Impostazioni → Contatti** puoi:
- rinominare un contatto;
- segnarlo come **attendibile**: i suoi file arrivano senza chiedere conferma;
- confrontare il suo codice di sicurezza;
- rimuoverlo;
- abbinare un dispositivo vicino senza inviargli nulla.

### Telefono (iPhone e Android)
1. Sul PC apri **Collega telefono** (dall'overlay o da Impostazioni → Telefono).
2. Nell'app WaveDrop tocca **Scansiona il codice QR**. Senza app: inquadra il QR con la fotocamera e tocca **Collega** nella pagina che si apre.

| | Come si installa | Cosa fa in più dell'app web |
| --- | --- | --- |
| **Android** | `dist\WaveDrop-Android-1.0.0.apk` (sorgenti in [`android/`](android)) | Compare nel menu **Condividi** di Android; salva in Galleria e in Download; con *Resta raggiungibile* riceve anche con l'app chiusa |
| **iPhone** | Compilata da Windows con xtool: vedi [`ios/README.md`](ios/README.md) | Scanner QR integrato; salva in Foto e in File › WaveDrop; chiave privata nel Portachiavi |
| **App web** | Nessuna installazione: Condividi → *Aggiungi alla schermata Home* (iPhone) o menu ⋮ → *Aggiungi a schermata Home* (Android) | — |

Dal telefono puoi inviare foto, file e testi al PC e accettare quello che il PC ti manda. Le immagini ricevute si salvano in Foto tenendole premute.

### Impostazioni
- **Profilo:** foto o iniziali colorate, nome, codice di sicurezza.
- **Ricezione:**
  - visibilità: *Tutti*, *Solo contatti* (gli estranei non ti vedono nemmeno), *Nessuno*;
  - cartella di salvataggio fissa, oppure *Chiedi ogni volta*;
  - una sottocartella per ogni mittente;
  - accettazione automatica dai contatti attendibili;
  - cosa fare dopo la ricezione;
  - suono di notifica.
- **Generale:** avvio con Windows, isola in alto, «Invia a», scorciatoia, tema, Bluetooth; su Linux anche il **ponte AirDrop** (vedi sotto).
- **Cronologia** dei trasferimenti e **Sicurezza** (dettagli della cifratura, rigenerazione delle chiavi).

## Avvio e build

```bash
npm install
npm start            # compila l'app web per telefoni e avvia WaveDrop
npm run start:2      # seconda istanza indipendente, per provare sullo stesso PC
npm run dist         # dist/WaveDrop Setup 1.0.0.exe (installer) e dist/WaveDrop 1.0.0.exe (portatile)
npm run dist:linux   # dist/WaveDrop-1.0.0.AppImage (da eseguire su Linux)
npm run build:ble    # ricompila l'helper Bluetooth (assets/ble-helper.exe)
npm test             # test dell'adattatore AirDrop sugli output di esempio (test/fixtures/airdrop)
node scripts/make-vectors.js > android/app/src/test/resources/vectors.json   # vettori di test per le app native
```

App Android (JDK 17+ e Android SDK; in `android/local.properties` il percorso dell'SDK):
```bash
cd android && ./gradlew testDebugUnitTest assembleRelease
```
App iPhone: vedi [`ios/README.md`](ios/README.md).


Al primo avvio Windows Defender Firewall chiede l'accesso alla rete: consentilo per le **reti private**, altrimenti né gli altri PC né il telefono ti raggiungono. WaveDrop usa la porta TCP **47480** (fissa, così il segnalibro sul telefono resta valido) e la porta UDP 47474 per la ricerca.

## Come funziona

AirDrop usa Bluetooth LE per farsi trovare, una rete Wi-Fi diretta tra dispositivi Apple (AWDL) e HTTPS con certificati legati all'ID Apple. I PC non supportano AWDL e iOS non permette ad altre app di usare AirDrop. WaveDrop ricostruisce lo stesso schema con strumenti disponibili ovunque:

- **Ricerca:**
  - annunci UDP multicast e broadcast sulla rete locale (`src/core/discovery.js`);
  - su Windows, anche un segnale **Bluetooth LE** con l'indirizzo di rete (`native/ble-helper.cs`, `src/core/ble.js`). Così i PC si trovano anche sulle reti che bloccano la ricerca normale, e quelli più vicini compaiono per primi.
- **Identità:** ogni dispositivo ha una coppia di chiavi X25519. Su Windows la chiave privata è protetta da DPAPI.
- **Primo contatto:** CPace, un PAKE su ristretto255, con il codice a 6 cifre. Per i telefoni il QR contiene un segreto monouso e la chiave pubblica del PC.
- **Trasferimenti** (`src/core/transfer.js`, `src/shared/protocol.js`):
  - richiesta cifrata (`/Ask`), legata alle chiavi dei due contatti;
  - risposta con una chiave effimera, che dà forward secrecy;
  - file a blocchi da 1 MiB cifrati con **ChaCha20-Poly1305** (`/Chunk`). Un blocco alterato interrompe il trasferimento.
- **Solo contatti:** gli annunci contengono solo un numero casuale e un'etichetta per ciascun contatto. Chi non è un contatto non vede né nome né chiave e non può collegare due annunci tra loro.
- **Telefono** (`src/core/mobile.js`, `src/web/`): app web servita dal PC, che usa la stessa crittografia in JavaScript.

## E l'AirDrop vero di Apple?

AirDrop usa una rete Wi-Fi diretta tra dispositivi Apple (AWDL), un segnale Bluetooth LE e certificati firmati da Apple. Due progetti open source lo reimplementano:
- [OpenDrop](https://github.com/seemoo-lab/opendrop), in Python;
- [omdrop-owl](https://github.com/t4t5/omdrop-owl), basato su OWL.

Entrambi funzionano solo su **Linux** (o macOS), con una scheda Wi-Fi che supporta la modalità monitor e l'iniezione di pacchetti, e solo verso iPhone impostati su «Tutti per 10 minuti».
- **Questo PC:** l'Intel Wireless-AC 9560 è nell'elenco delle schede funzionanti di omdrop-owl, in modalità esclusiva (il Wi-Fi si scollega mentre il PC è visibile). Funzionerebbe però solo avviando **Linux**.
- **Windows e WSL:** non c'è accesso diretto alla scheda Wi-Fi, quindi non è possibile.
- **App Android o iOS:** nessuna app può usare AWDL. L'unica eccezione è Quick Share sui Pixel 10, che Google ha integrato nel sistema operativo.

WaveDrop quindi parla il proprio protocollo, uguale su PC, Android e iPhone. Su **Linux** può però fare da ponte verso l'AirDrop vero, appoggiandosi a omdrop-owl (sezione seguente).

## Ponte AirDrop (solo Linux)

Con il PC avviato in Linux, WaveDrop può scambiare file con iPhone, iPad e Mac attraverso l'AirDrop di Apple. Non lo fa da solo: comanda la riga di comando di [omdrop-owl](https://github.com/t4t5/omdrop-owl) (la radio AWDL, tramite OWL) e di [omdrop-plugin](https://github.com/netmojo-systems/omdrop-plugin) 0.16 o successivo (il comando `omdrop`, con il ricevitore e il mittente). Il codice è in `src/core/airdrop.js`.

Su **Windows** (e su macOS) la funzione non esiste: l'interruttore non compare e WaveDrop si comporta come prima.

### Provarlo su questo portatile

La scheda **Intel Wireless-AC 9560** di questo PC (driver `iwlwifi`) è nell'elenco delle schede funzionanti di omdrop-owl, in **modalità esclusiva**.

1. **Avvia Linux.** Le prove di omdrop-owl sono su Arch/Omarchy, ma ci sono pacchetti anche per Debian/Ubuntu, Fedora e NixOS. Serve Python 3.11 o successivo; con Python 3.10 installa anche `python3-tomli`.
2. **Installa omdrop-owl** (la radio):
   ```bash
   yay -S omdrop-owl                     # Arch / Omarchy (AUR)
   ```
   Su Debian/Ubuntu, dai sorgenti di omdrop-owl: installa le dipendenze di compilazione elencate nel suo README, poi `tools/build-deb.sh` e `sudo apt install ./omdrop-owl_*.deb`. Su Fedora usa invece `tools/build-rpm.sh`. Il pacchetto mette `omdrop-discoverable`, `send-to-peer` e la tabella delle schede (`owl-profiles`) in `/usr/lib/omdrop`, insieme alla regola polkit che permette di accendere la radio senza password dalla sessione grafica.
3. **Installa omdrop-plugin** (il comando `omdrop`):
   ```bash
   omarchy plugin add https://github.com/netmojo-systems/omdrop-plugin.git   # Omarchy
   ```
   Su altre distribuzioni scarica il repository e lancia `omdrop-plugin/bin/omdrop setup`: installa `~/.local/bin/omdrop` e il servizio che riceve i file (`airdrop-receiver.service`). Il ricevitore vuole anche i pacchetti `python-libarchive-c` (o `python3-libarchive-c`) e `keyutils`.
4. **Controlla che sia tutto pronto:**
   ```bash
   omdrop doctor                 # elenca cosa manca
   omdrop firewall install       # solo se usi ufw: apre la porta 8771 su awdl0
   omdrop on 10m                 # prova a renderti visibile (il Wi-Fi si scollega)
   omdrop peers -n               # dispositivi Apple vicini, con il nome
   omdrop off                    # il Wi-Fi si ricollega
   ```
5. **Avvia WaveDrop su Linux** (`npm install && npm start` nella cartella del progetto) e vai in **Impostazioni › Generale › AirDrop**. La riga *Ponte AirDrop (solo Linux)* dice se omdrop-owl è disponibile e quale modalità usa la scheda. Accendila: il PC diventa visibile per 10 minuti.
6. **Sull'iPhone** apri Centro di Controllo › AirDrop e scegli **«Tutti per 10 minuti»**.
7. **Inviare:** apri l'overlay (`Ctrl + Alt + D`). I dispositivi Apple compaiono accanto agli altri con il **marchio AirDrop** blu e la scritta *AirDrop*. Clic o trascinamento come per gli altri dispositivi; il proprietario accetta sul suo schermo. Gli *appunti* partono come link se sono un indirizzo web, altrimenti come file `.txt`.
8. **Ricevere:** dal foglio di condivisione dell'iPhone scegli il nome del PC. I file arrivano nella cartella dei ricevuti di WaveDrop, con la solita notifica e una riga nella **Cronologia** (segnata *AirDrop*). Un link arriva come file `.url` e la notifica ha il pulsante *Apri link*.

Sotto i dispositivi, nell'overlay, la riga *AirDrop* mostra quanto resta della finestra di visibilità e permette di riaccenderla (**Rendi visibile per 10 minuti**) o di spegnerla prima. Mentre WaveDrop tiene aperta la finestra, la cartella di ricezione di omdrop (`omdrop dir`) punta a quella di WaveDrop; alla fine torna com'era.

### Limiti del ponte

- **Wi-Fi scollegato in modalità esclusiva.** Su questo portatile (Intel `iwlwifi`) il Wi-Fi si spegne finché il PC è visibile ad AirDrop: niente Internet e niente dispositivi WaveDrop in rete per quei minuti. Per questo WaveDrop non si rende mai visibile da solo all'avvio: solo quando accendi l'interruttore o premi *Rendi visibile*. Con le schede Intel AWDL gira solo sul canale 6, quindi è lento (circa 17 secondi per una foto da 2,4 MB secondo omdrop-owl).
- **I dispositivi Apple devono essere su «Tutti per 10 minuti».** Senza un'identità firmata da Apple, che omdrop non sa ottenere, il PC usa un certificato autofirmato e non può inviare a chi ha AirDrop su *Solo contatti*.
- **Si vedono solo i dispositivi che rispondono con il nome**, cioè quelli con AirDrop aperto. Gli iPhone ascoltano a intermittenza: se un invio non parte, apri un foglio di condivisione sull'iPhone e riprova.
- **Ricezione senza conferma.** Finché il PC è visibile, il ricevitore di omdrop accetta tutto quello che arriva (come AirDrop su *Tutti*): non c'è il pulsante *Rifiuta*, e le opzioni *Chiedi ogni volta dove salvare* e *Una sottocartella per ogni mittente* non valgono per AirDrop.
- **Niente cartelle**: comprimile prima in un `.zip`. Niente codice di abbinamento né contatti: la sicurezza è quella di AirDrop, non la cifratura di WaveDrop.
- **OpenDrop come alternativa.** Se `omdrop` non c'è ma c'è [OpenDrop](https://github.com/seemoo-lab/opendrop) (`pip3 install opendrop`), WaveDrop usa i suoi comandi `find`, `send` e `receive` (per forzarlo: `WAVEDROP_AIRDROP_BACKEND=opendrop npm start`). Però:
  - **OpenDrop non verifica i certificati Apple**: non controlla che il certificato TLS dell'altro dispositivo sia firmato da Apple né il suo record di validazione, quindi non sai davvero chi c'è dall'altra parte;
  - accetta automaticamente qualsiasi file;
  - non accende la radio: OWL va avviato a mano (come root) e l'interfaccia `awdl0` deve già esistere, senza la gestione della modalità esclusiva di omdrop-owl;
  - invia un file per richiesta, quindi più file chiedono più conferme.
- Su Windows, WSL, Android e iOS non è possibile in nessun modo: serve l'accesso diretto alla scheda Wi-Fi in modalità monitor.

I test (`npm test`) controllano come l'adattatore legge l'output di `omdrop` e di OpenDrop su esempi in `test/fixtures/airdrop`. Quegli esempi sono ricostruiti dai sorgenti dei due progetti, non registrati su un PC vero: alla prima prova su Linux conviene sostituirli con output reali (vedi `test/fixtures/airdrop/README.md`).

## Limiti

- Su Windows non è compatibile con l'AirDrop di Apple (vedi sopra; su Linux c'è il ponte): iPhone e Android usano le app WaveDrop o l'app web.
- Telefono e PC devono essere sulla stessa rete. L'app web è servita in HTTP sulla rete locale: i file sono cifrati, ma chi controlla la rete potrebbe alterare la pagina scaricata dal telefono. Usala su reti di cui ti fidi; un'app nativa eliminerebbe questo limite.
- iPhone e Android ricevono solo mentre la pagina di WaveDrop è aperta: iOS sospende le pagine in background.
- Il Bluetooth serve a *trovare* i dispositivi; i file viaggiano sempre in rete. È disponibile solo su Windows.

## Ringraziamenti

WaveDrop non esisterebbe senza chi ha studiato AirDrop e ha condiviso il proprio lavoro:

- [OpenDrop](https://github.com/seemoo-lab/opendrop) e [OWL](https://github.com/seemoo-lab/owl) del Secure Mobile Networking Lab (SEEMOO) della TU Darmstadt, che hanno ricostruito AirDrop e AWDL;
- [omdrop-owl](https://github.com/t4t5/omdrop-owl) di t4t5 e [omdrop-plugin](https://github.com/netmojo-systems/omdrop-plugin) di netmojo-systems, usati dal ponte AirDrop su Linux;
- [xtool](https://github.com/xtool-org/xtool), che permette di compilare l'app iPhone senza un Mac;
- le librerie open source delle tre app: Electron, noble (Paul Miller), node-qrcode, OkHttp, Bouncy Castle, ZXing Android Embedded, Jetpack Compose, swift-crypto.

L'elenco completo, con le licenze, è in [CREDITS.md](CREDITS.md). Nessuno di questi progetti è incluso nel repository: WaveDrop usa le librerie come dipendenze e avvia OpenDrop/omdrop come programmi esterni.

## Licenza

[MIT](LICENSE) © 2026 Matteo Davanzo.

AirDrop, iPhone e Apple sono marchi di Apple Inc. WaveDrop è un progetto indipendente, non affiliato né approvato da Apple.
