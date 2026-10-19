# Ringraziamenti

WaveDrop è stato creato da **Matteo Davanzo** ed è distribuito con licenza [MIT](LICENSE).

Esiste grazie al lavoro di molte persone che hanno studiato AirDrop e reso pubblici
i loro strumenti. Grazie di cuore a tutti.

## Ricerca su AirDrop e AWDL

| Progetto | Autori | Licenza | Ruolo in WaveDrop |
|---|---|---|---|
| [OpenDrop](https://github.com/seemoo-lab/opendrop) | Secure Mobile Networking Lab (SEEMOO), TU Darmstadt | GPL-3.0 | Studio del protocollo AirDrop; backend di riserva del ponte AirDrop su Linux |
| [OWL](https://github.com/seemoo-lab/owl) | Secure Mobile Networking Lab (SEEMOO), TU Darmstadt | GPL-3.0 | Implementazione aperta di AWDL, la radio Wi-Fi di AirDrop |
| [omdrop-owl](https://github.com/t4t5/omdrop-owl) | t4t5 | — | Radio AWDL usata dal ponte AirDrop su Linux |
| [omdrop-plugin](https://github.com/netmojo-systems/omdrop-plugin) | netmojo-systems | MIT | Comando `omdrop`: ricevitore e mittente AirDrop usati dal ponte |
| [xtool](https://github.com/xtool-org/xtool) | xtool-org | MIT | Compilazione e installazione dell'app iPhone da Windows/Linux, senza Mac |

OpenDrop, OWL, omdrop-owl e omdrop-plugin **non sono inclusi** in questo repository:
WaveDrop li avvia come programmi esterni, se sono installati, e ognuno resta sotto la
propria licenza. Gli articoli di riferimento sono quelli di Milan Stute e colleghi
(*A Billion Open Interfaces for Eve and Mallory*, USENIX Security 2019;
*One Billion Apples' Secret Sauce*, MobiCom 2018).

## App desktop (Windows, Linux, macOS)

| Progetto | Licenza |
|---|---|
| [Electron](https://github.com/electron/electron) | MIT |
| [noble-curves](https://github.com/paulmillr/noble-curves), [noble-ciphers](https://github.com/paulmillr/noble-ciphers), [noble-hashes](https://github.com/paulmillr/noble-hashes) di Paul Miller | MIT |
| [node-qrcode](https://github.com/soldair/node-qrcode) | MIT |
| [jsQR](https://github.com/cozmo/jsQR) (lettura del QR nell'app web per telefoni) | Apache-2.0 |
| [esbuild](https://github.com/evanw/esbuild) | MIT |
| [electron-builder](https://github.com/electron-userland/electron-builder) | MIT |

## App Android

| Progetto | Licenza |
|---|---|
| [Jetpack Compose e AndroidX](https://developer.android.com/jetpack/androidx) | Apache-2.0 |
| [Kotlin](https://github.com/JetBrains/kotlin) e [kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) | Apache-2.0 |
| [OkHttp](https://github.com/square/okhttp) di Square | Apache-2.0 |
| [Bouncy Castle](https://www.bouncycastle.org/) | MIT (Bouncy Castle Licence) |
| [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded) | Apache-2.0 |

## App iPhone

| Progetto | Licenza |
|---|---|
| [swift-crypto](https://github.com/apple/swift-crypto) | Apache-2.0 |
| [xtool](https://github.com/xtool-org/xtool) | MIT |

## Crittografia

Il protocollo di WaveDrop usa X25519, ChaCha20-Poly1305, HKDF/HMAC-SHA-256 e
[CPace](https://datatracker.ietf.org/doc/draft-irtf-cfrg-cpace/) su
[ristretto255](https://datatracker.ietf.org/doc/rfc9496/), con un handshake ispirato al
[Noise Protocol Framework](https://noiseprotocol.org/) (pattern IK).

---

AirDrop, iPhone e Apple sono marchi di Apple Inc. WaveDrop è un progetto indipendente,
non affiliato né approvato da Apple.
