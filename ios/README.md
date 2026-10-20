# WaveDrop per iPhone

App nativa SwiftUI, compilata **da Windows** con [xtool](https://xtool.sh) dentro Ubuntu (WSL). È il corrispettivo dell'app Android:
- collegamento al PC con il codice QR;
- scambio di file **direttamente con altri telefoni** (iPhone o Android) sulla stessa rete Wi-Fi, abbinandoli con un QR;
- invio di foto, file e testi;
- ricezione con salvataggio in **Foto** e in **File › WaveDrop**;
- cifratura end-to-end.

```
ios/
├── Package.swift            pacchetto SwiftPM (target app + WaveDropKit)
├── xtool.yml                bundle ID, Info.plist, icona
├── Info.plist               permessi: rete locale, fotocamera, Foto, schema wavedrop://
├── Sources/WaveDropKit/     protocollo (Swift, testato anche su Linux)
├── Sources/WaveDrop/        app SwiftUI (solo iOS)
├── Tests/WaveDropKitTests/  test con gli stessi vettori di Android e del PC
└── scripts/wsl-build.sh     sincronizza in WSL e lancia xtool
```

Il protocollo (`WaveDropKit`) è già verificato. Dentro Ubuntu, `swift test` passa 18 test su 18:
- riproduce byte per byte chiavi, MAC e blocchi cifrati generati dal PC;
- prova il server da telefono a telefono (`PeerCore`): abbinamento con il QR, ricezione di file, rifiuto, blocchi alterati, annullamento.

L'interfaccia SwiftUI e la parte di rete (`PeerService.swift`, con Network.framework e Bonjour) invece si compilano solo con l'SDK iOS, che xtool estrae da Xcode.xip. Con l'SDK di Xcode 27.2 l'app si compila (`xtool dev build`, senza firma), ma non è ancora stata installata né provata su un iPhone.

## Cosa è già pronto in Ubuntu (WSL)

- Swift 6.4 (swiftly) con le librerie di sistema necessarie
- xtool in `~/.local/bin/xtool`
- usbmuxd e libimobiledevice-utils (`ideviceinfo`)
- una copia del progetto in `~/wavedrop-ios`

## Passi da fare tu (una volta sola)

### 1. Scarica Xcode
Vai su <https://developer.apple.com/download/all/?q=Xcode> con il tuo Apple ID e scarica **Xcode 27** (`.xip`, circa 3–4 GB) nella cartella **Download**. Serve solo per estrarne l'SDK iOS.

### 2. Configura xtool (in Ubuntu)
```bash
xtool setup
```
- Modalità di accesso: **1 (Password)** se non hai l'Apple Developer Program a pagamento. Inserisci Apple ID, password e codice a due fattori; xtool li invia solo ad Apple. Puoi usare anche un Apple ID secondario.
- Percorso di Xcode.xip: `/mnt/c/Users/<tuo-utente>/Downloads/Xcode_27.xip` (con il nome esatto del file scaricato).

### 3. Collega l'iPhone tramite iTunes
1. Collega l'iPhone via USB, apri **iTunes** e accetta **Autorizza questo computer** sull'iPhone.
2. Apri **PowerShell come amministratore** ed esegui (regola firewall per WSL e inoltro del servizio Apple sulla porta 27015):
   ```powershell
   New-NetFirewallRule -DisplayName "WSL" -Direction Inbound -InterfaceAlias "vEthernet (WSL (Hyper-V firewall))" -Action Allow
   $wslHost = (Get-NetIPAddress -InterfaceAlias "vEthernet (WSL*" -AddressFamily IPv4).IPAddress
   netsh interface portproxy set v4tov4 listenport=27015 connectaddress=127.0.0.1 connectport=27015 listenaddress=$wslHost
   ```
3. In Ubuntu, verifica che l'iPhone si veda:
   ```bash
   export USBMUXD_SOCKET_ADDRESS="$(ip route list default | awk '{print $3}'):27015"
   ideviceinfo | head -3
   ```

In alternativa a iTunes puoi passare l'USB a WSL con [usbipd](https://learn.microsoft.com/windows/wsl/connect-usb).

### 4. Compila e installa
```bash
bash "/mnt/c/percorso/di/WaveDrop/ios/scripts/wsl-build.sh"
```
Lo script copia il progetto in `~/wavedrop-ios` ed esegue `xtool dev`, che compila, firma e installa l'app sull'iPhone.

### 5. Sull'iPhone
- **Impostazioni › Privacy e sicurezza › Modalità sviluppatore**: attivala e riavvia.
- **Impostazioni › Generali › VPN e gestione dispositivi**: autorizza il tuo Apple ID.

Con un Apple ID gratuito l'app scade dopo **7 giorni**: per rinnovarla basta rilanciare lo script.

## Uso
1. Sul PC apri WaveDrop e scegli **Collega telefono**.
2. Nell'app iPhone tocca **Scansiona il codice QR**. Funziona anche inquadrando il QR con la Fotocamera: nella pagina che si apre tocca «Apri il collegamento nell'app».
3. Invia foto, file o testi. Per ricevere, tieni l'app aperta: iOS sospende le app in background.

Con un altro telefono (iPhone o Android con WaveDrop), sulla stessa rete Wi-Fi:
1. Nella sezione **Telefoni vicini** tocca **Abbina** accanto all'altro telefono.
2. Sull'altro tocca **Mostra il codice QR** nella richiesta che compare, e inquadralo.
3. Da quel momento l'altro telefono compare accanto ai PC.

La prima volta iOS chiede il permesso per la **rete locale**: senza, i telefoni non si vedono. Puoi darlo anche dopo, in Impostazioni › Privacy e sicurezza › Rete locale.

## Perché non AirDrop vero
AirDrop usa AWDL, una rete Wi-Fi diretta tra dispositivi Apple, oltre al Bluetooth LE e a certificati firmati da Apple. iOS non permette ad altre app di usarlo. OpenDrop e omdrop-owl lo reimplementano, ma solo su **Linux** con una scheda Wi-Fi in modalità monitor (WaveDrop su Linux ha un ponte verso AirDrop: vedi il README principale). Su Windows, su WSL e dentro un'app Android o iOS non è possibile.
