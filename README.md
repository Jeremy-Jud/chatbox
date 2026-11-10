<div align="center">

# 💬 Chatbox

**Eine kleine Desktop-Chat-App. Freunde per Code adden und direkt chatten.**

Ohne Konto, ohne Telefonnummer, ohne Server, der deine Nachrichten speichert.

[![Download](https://img.shields.io/badge/Download-Chatbox.exe-5b8cff?style=for-the-badge&logo=windows)](https://github.com/Jeremy-Jud/chatbox/releases/latest/download/Chatbox.exe)

[![Release](https://img.shields.io/github/v/release/Jeremy-Jud/chatbox?label=Version)](https://github.com/Jeremy-Jud/chatbox/releases/latest)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-green)](LICENSE)
![Plattform](https://img.shields.io/badge/Plattform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-45-47848f?logo=electron)

</div>

---

## ⬇️ Download

1. **[Chatbox.exe herunterladen](https://github.com/Jeremy-Jud/chatbox/releases/latest/download/Chatbox.exe)** (Windows 10/11, 64-Bit)
2. Doppelklick auf `Chatbox.exe`. Es gibt keine Installation, die App startet direkt.
3. Namen eingeben und fertig. Du bekommst deinen eigenen **6-stelligen Code**.

> **„Der Computer wurde durch Windows geschützt“?**
> Die App ist (noch) nicht mit einem kostenpflichtigen Zertifikat signiert, deshalb warnt Windows SmartScreen.
> Klicke auf **„Weitere Informationen“** und dann auf **„Trotzdem ausführen“**.
> Prüfe vorher am besten die [SHA-256-Prüfsumme](#-prüfsumme-checken) der Datei.

Alle Versionen findest du unter [**Releases**](https://github.com/Jeremy-Jud/chatbox/releases).

## ✨ Funktionen

| | |
|---|---|
| 🪟 **Mini-Fenster** | Kompaktes, rahmenloses Fenster (360 × 540), mit 📌 immer im Vordergrund |
| 🔑 **Freundescode** | Jeder bekommt einen eigenen Code wie `K7M2QX`. Code eingeben, schon seid ihr verbunden |
| ⚡ **Echtzeit-Chat** | Nachrichten gehen direkt von PC zu PC (Peer-to-Peer) |
| 🟢 **Online-Status** | Du siehst, wer gerade online ist |
| 🔔 **Benachrichtigungen** | Desktop-Meldung und blinkende Taskleiste bei neuen Nachrichten |
| ✓✓ **Zustellstatus** | 🕓 wartet · ✓ gesendet · ✓✓ angekommen |
| 📬 **Warteschlange** | Nachrichten an Offline-Freunde werden automatisch zugestellt, sobald ihr beide online seid |
| 💾 **Lokaler Verlauf** | Chats bleiben nur auf deinem PC gespeichert |

## 🚀 So benutzt du Chatbox

1. **Code teilen:** Oben steht dein Code. Mit **Kopieren** kannst du ihn einem Freund schicken.
2. **Freund adden:** Den Code deines Freundes ins Feld eingeben und auf **Adden** klicken.
   Dein Freund sieht dich danach automatisch auch in seiner Liste.
3. **Chatten:** Auf den Namen klicken und lostippen. Mit `Enter` sendest du die Nachricht.
4. **Entfernen:** Mit der Maus über einen Kontakt fahren und auf ✕ klicken.

> ℹ️ Weil es keinen zentralen Server gibt, müssen **beide** Chatbox geöffnet haben, damit Nachrichten ankommen.

## 🔒 Sicherheit & Datenschutz

- **Verschlüsselte Direktverbindung:** Nachrichten laufen über WebRTC-Datenkanäle, die immer mit DTLS verschlüsselt sind.
- **Kein Nachrichtenserver:** Der öffentliche [PeerJS](https://peerjs.com)-Server hilft nur beim *Verbindungsaufbau* (Signalisierung). Deine Nachrichten bekommt er nie zu sehen.
- **Keine Konten, kein Tracking:** Es gibt keine Telemetrie und keine Werbung. Es wird nur dein Anzeigename an deine Kontakte gesendet.
- **Gehärtete App:** Context Isolation, Sandbox, keine Node.js-Rechte im Fenster, eine strenge Content Security Policy, gesperrte Navigation, und alle Berechtigungen außer Benachrichtigungen werden abgelehnt.
- **Geprüfte Abhängigkeiten:** Dependabot und Secret Scanning sind aktiv.

Wichtig zu wissen:
- Wer deinen Code kennt, kann dich adden. Gib ihn also nur Leuten, mit denen du chatten willst.
- Bei einer direkten Verbindung sieht dein Chatpartner deine IP-Adresse. Das ist bei jeder Peer-to-Peer-Verbindung so.
- Der Chatverlauf liegt unverschlüsselt in deinem Windows-Benutzerprofil (`%APPDATA%\Chatbox`).

Sicherheitslücke gefunden? Bitte lies die [Sicherheitsrichtlinie](SECURITY.md).

## 🔍 Prüfsumme checken

So stellst du sicher, dass deine Datei nicht verändert wurde. Öffne PowerShell im Download-Ordner und gib ein:

```powershell
Get-FileHash .\Chatbox.exe -Algorithm SHA256
```

Das Ergebnis muss mit dem Wert übereinstimmen, der beim jeweiligen [Release](https://github.com/Jeremy-Jud/chatbox/releases) steht.

## 🛠️ Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) LTS

```bash
git clone https://github.com/Jeremy-Jud/chatbox.git
cd chatbox
npm install
npm start          # App im Entwicklermodus starten
npm run dist       # Chatbox.exe in den Ordner dist/ bauen
```

> Unter Windows PowerShell funktioniert `npm` manchmal nicht, weil die Skriptausführung gesperrt ist. Nimm dann `npm.cmd install` und `npm.cmd start`.

## 📁 Projektaufbau

```
chatbox/
├── main.js          # Electron-Hauptprozess (Fenster, Sicherheit)
├── preload.js       # Sichere Brücke für Fenster-Buttons
└── src/
    ├── index.html   # Oberfläche
    ├── style.css    # Design
    └── app.js       # Chat-Logik (PeerJS, Freunde, Nachrichten)
```

## 🗺️ Ideen für später

- [ ] Gruppenchats
- [ ] Bilder & Dateien senden
- [ ] Emojis-Auswahl
- [ ] Verschlüsselter lokaler Verlauf
- [ ] macOS- und Linux-Version

## 📄 Lizenz

[MIT](LICENSE) © Jeremy-Jud
