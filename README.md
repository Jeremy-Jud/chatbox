<div align="center">

<img src="build/icon.png" width="110" alt="WhatsUp-Logo">

# WhatsUp

**Eine kleine Desktop-Chat-App. Freunde per Code adden und direkt chatten.**

Ohne Konto, ohne Telefonnummer, ohne Server, der deine Nachrichten speichert.

[![Download](https://img.shields.io/badge/Download-WhatsUp_Setup-1a8cff?style=for-the-badge&logo=windows)](https://github.com/Jeremy-Jud/whatsup/releases/latest/download/WhatsUp-Setup.exe)

[![Release](https://img.shields.io/github/v/release/Jeremy-Jud/whatsup?label=Version)](https://github.com/Jeremy-Jud/whatsup/releases/latest)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-green)](LICENSE)
![Plattform](https://img.shields.io/badge/Plattform-Windows-blue)
![Electron](https://img.shields.io/badge/Electron-45-47848f?logo=electron)

</div>

---

## ⬇️ Download

**Empfohlen: [WhatsUp-Setup.exe](https://github.com/Jeremy-Jud/whatsup/releases/latest/download/WhatsUp-Setup.exe)** (Windows 10/11, 64-Bit)
- Doppelklick, und WhatsUp installiert sich in wenigen Sekunden (keine Admin-Rechte nötig).
- Auf dem Desktop und im Startmenü erscheint eine Verknüpfung.
- **Updates mit einem Klick** direkt in der App (Einstellungen → Updates).

**Ohne Installation: [WhatsUp.exe](https://github.com/Jeremy-Jud/whatsup/releases/latest/download/WhatsUp.exe)**
- Läuft direkt, z. B. vom USB-Stick. Der Start dauert etwa 15 Sekunden.
- Bei Updates öffnet die App die Download-Seite, die neue Version musst du selbst herunterladen.

Danach Namen eingeben und fertig. Du bekommst deinen eigenen **6-stelligen Code**.

> **„Der Computer wurde durch Windows geschützt“?**
> Die App ist (noch) nicht mit einem kostenpflichtigen Zertifikat signiert, deshalb warnt Windows SmartScreen.
> Klicke auf **„Weitere Informationen“** und dann auf **„Trotzdem ausführen“**.
> Prüfe vorher am besten die [SHA-256-Prüfsumme](#-prüfsumme-checken) der Datei.

Alle Versionen findest du unter [**Releases**](https://github.com/Jeremy-Jud/whatsup/releases).

## ✨ Funktionen

| | |
|---|---|
| 🪟 **Mini-Fenster** | Kompaktes, rahmenloses Fenster (380 × 600), mit 📌 immer im Vordergrund |
| 🔑 **Freundescode** | Jeder bekommt einen eigenen Code wie `K7M2QX`. Code eingeben, schon seid ihr verbunden |
| ⚡ **Echtzeit-Chat** | Nachrichten gehen direkt von PC zu PC (Peer-to-Peer) |
| 👥 **Gruppenchats** | Gruppen erstellen, Freunde hinzufügen, umbenennen, verlassen |
| 📷 **Bilder & GIFs** | Über 📎, mit Strg+V oder per Drag & Drop. Bilder werden automatisch verkleinert |
| 😊 **Emojis** | Emoji-Auswahl mit Kategorien und „Zuletzt benutzt“. Nachrichten nur aus Emojis werden groß angezeigt |
| 🏆 **Erfolge** | 23 Erfolge zum Freischalten, z. B. 25 Nachrichten, erstes GIF, Nachteule oder 7 Tage am Stück |
| 🖼️ **Profil** | Profilbild, Name und Status. Deine Freunde sehen dein Bild und deine Erfolge |
| 🔔 **Benachrichtigungen** | Windows-Benachrichtigungen wie bei Teams/Discord mit Profilbild. Ein Klick öffnet den Chat. Roter Zähler am Taskleisten-Icon |
| 🖥️ **Hintergrund** | ✕ schließt nicht, WhatsUp läuft unten rechts im Infobereich weiter. Optional mit Windows starten |
| ⚙️ **Einstellungen** | Profil, Hell/Dunkel, Benachrichtigungen, immer im Vordergrund |
| 🔄 **Updates** | In der App nach Updates suchen und direkt installieren |
| 🌓 **Minimalistisch** | Schlichtes Design, hell oder dunkel passend zu Windows |
| 🟢 **Online-Status** | Du siehst, wer gerade online ist |
| 🔔 **Benachrichtigungen** | Desktop-Meldung und blinkende Taskleiste bei neuen Nachrichten |
| ✓✓ **Zustellstatus** | 🕓 wartet · ✓ gesendet · ✓✓ angekommen |
| 📬 **Warteschlange** | Nachrichten an Offline-Freunde werden automatisch zugestellt, sobald ihr beide online seid |
| 💾 **Lokaler Verlauf** | Chats bleiben nur auf deinem PC gespeichert |

## 🚀 So benutzt du WhatsUp

1. **Code teilen:** Oben steht dein Code. Mit **Kopieren** kannst du ihn einem Freund schicken.
2. **Freund adden:** Den Code deines Freundes ins Feld eingeben und auf **Adden** klicken.
   Dein Freund sieht dich danach automatisch auch in seiner Liste.
3. **Chatten:** Auf den Namen klicken und lostippen. Mit `Enter` sendest du die Nachricht.
   Mit 😊 wählst du Emojis aus, mit 📎 schickst du Bilder oder GIFs. Du kannst Bilder auch einfügen (Strg+V) oder ins Fenster ziehen.
4. **Gruppe:** Auf **＋ Gruppe** klicken, einen Namen eingeben und Freunde auswählen.
5. **Einstellungen:** Über das Zahnrad (oder einen Klick auf deinen Namen) änderst du Profilbild, Name, Status und Design und suchst nach Updates.
6. **Erfolge:** Über 🏆 oben rechts siehst du alle Erfolge und deinen Fortschritt.
7. **Infos & Entfernen:** Im Chat oben auf den Namen klicken. Dort kannst du Freunde entfernen oder Gruppen verwalten.

> ℹ️ Weil es keinen zentralen Server gibt, müssen **beide** WhatsUp geöffnet haben, damit Nachrichten ankommen.

## 🔒 Sicherheit & Datenschutz

- **Verschlüsselte Direktverbindung:** Nachrichten laufen über WebRTC-Datenkanäle, die immer mit DTLS verschlüsselt sind.
- **Kein Nachrichtenserver:** Der öffentliche [PeerJS](https://peerjs.com)-Server hilft nur beim *Verbindungsaufbau* (Signalisierung). Deine Nachrichten bekommt er nie zu sehen.
- **Keine Konten, kein Tracking:** Es gibt keine Telemetrie und keine Werbung. Deine Kontakte bekommen nur Name, Status, Profilbild und die Anzahl deiner Erfolge.
- **Geprüfte Daten:** Empfangene Bilder werden nur als PNG, JPEG, GIF oder WebP angenommen und in der Größe begrenzt. Texte werden nie als HTML dargestellt.
- **Entfernen sperrt:** Wenn du einen Freund entfernst, kann dieser Code dich nicht mehr erreichen, bis du ihn selbst wieder addest.
- **Gehärtete App:** Context Isolation, Sandbox, keine Node.js-Rechte im Fenster, eine strenge Content Security Policy, gesperrte Navigation, und alle Berechtigungen außer Benachrichtigungen werden abgelehnt.
- **Sichere Updates:** Updates kommen nur aus den offiziellen Releases dieses Repos über HTTPS. Vor der Installation wird die SHA-512-Prüfsumme geprüft.
- **Geprüfte Abhängigkeiten:** Dependabot und Secret Scanning sind aktiv.

Wichtig zu wissen:
- Wer deinen Code kennt, kann dich adden. Gib ihn also nur Leuten, mit denen du chatten willst.
- Bei einer direkten Verbindung sieht dein Chatpartner deine IP-Adresse. Das ist bei jeder Peer-to-Peer-Verbindung so.
- Der Chatverlauf (inklusive Bilder) liegt unverschlüsselt in deinem Windows-Benutzerprofil (`%APPDATA%\Chatbox`).
- In Gruppen verbinden sich alle Mitglieder direkt miteinander. Damit sehen auch Gruppenmitglieder, die du nicht geaddet hast, deine IP-Adresse.

Sicherheitslücke gefunden? Bitte lies die [Sicherheitsrichtlinie](SECURITY.md).

## 🔍 Prüfsumme checken

So stellst du sicher, dass deine Datei nicht verändert wurde. Öffne PowerShell im Download-Ordner und gib ein:

```powershell
Get-FileHash .\WhatsUp-Setup.exe -Algorithm SHA256
```

Das Ergebnis muss mit dem Wert übereinstimmen, der beim jeweiligen [Release](https://github.com/Jeremy-Jud/whatsup/releases) steht.

## 🛠️ Selbst bauen

Voraussetzung: [Node.js](https://nodejs.org) LTS

```bash
git clone https://github.com/Jeremy-Jud/whatsup.git
cd whatsup
npm install
npm start          # App im Entwicklermodus starten
npm run dist       # WhatsUp.exe in den Ordner dist/ bauen
```

> Unter Windows PowerShell funktioniert `npm` manchmal nicht, weil die Skriptausführung gesperrt ist. Nimm dann `npm.cmd install` und `npm.cmd start`.

## 📁 Projektaufbau

```
whatsup/
├── main.js          # Electron-Hauptprozess (Fenster, Sicherheit)
├── preload.js       # Sichere Brücke für Fenster-Buttons
└── src/
    ├── index.html   # Oberfläche
    ├── style.css    # Design
    ├── app.js       # Chat-Logik (PeerJS, Freunde, Gruppen, Bilder, Profil)
    ├── emojis.js    # Emoji-Auswahl
    └── achievements.js  # Liste der Erfolge
```

## 🗺️ Ideen für später

- [x] Gruppenchats
- [x] Bilder & GIFs senden
- [x] Emoji-Auswahl
- [x] Erfolge & Profilbilder
- [ ] GIF-Suche
- [ ] Reaktionen auf Nachrichten
- [ ] Dateien senden
- [ ] Verschlüsselter lokaler Verlauf
- [ ] macOS- und Linux-Version

## 📄 Lizenz

[MIT](LICENSE) © Jeremy-Jud
