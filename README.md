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

### 📱 iPhone & iPad

WhatsUp läuft auch im Browser: **[jeremy-jud.github.io/whatsup](https://jeremy-jud.github.io/whatsup/)**

1. Den Link in **Safari** öffnen.
2. Auf **Teilen** (Viereck mit Pfeil) → **„Zum Home-Bildschirm“** tippen.
3. WhatsUp vom Home-Bildschirm starten. Es läuft dann im Vollbild wie eine eigene App.

Die Web-Version chattet direkt mit der Windows-App. **Jedes Gerät hat aber seinen eigenen Code:** Dein iPhone bekommt einen anderen Code als dein PC, und Chats und Freunde werden nicht zwischen den Geräten übertragen. Deine Freunde müssen deinen iPhone-Code also extra adden.

iPhone und iPad pausieren Apps im Hintergrund. Nachrichten, die in der Zwischenzeit kommen, warten verschlüsselt im Briefkasten (siehe [Offline-Zustellung](#-offline-zustellung)) und erscheinen beim nächsten Öffnen.
Damit du sie mitbekommst, schalte in WhatsUp unter **Einstellungen → Benachrichtigungen** die Benachrichtigungen ein. Dann bekommst du eine **Push-Benachrichtigung**, auch wenn WhatsUp geschlossen ist, auf dem Sperrbildschirm und in der Mitteilungszentrale (ab iOS 16.4, nur vom Home-Bildschirm aus).
Mit **Test senden** kommt nach 5 Sekunden ein echter Test-Push über den Server. Sperr in der Zeit dein Handy, dann siehst du, wie er auf dem Sperrbildschirm aussieht.

> Auf Android und am PC zeigt die Push-Benachrichtigung das Profilbild des Absenders. iPhone und iPad zeigen bei Web-Apps immer das App-Symbol; das Profilbild kann Apple dort nur bei Apps aus dem App Store anzeigen.

## ✨ Funktionen

| | |
|---|---|
| 🪟 **Mini-Fenster** | Kompaktes, rahmenloses Fenster (380 × 600), mit 📌 immer im Vordergrund |
| 🔑 **Freundescode** | Jeder bekommt einen eigenen Code wie `K7M2QX`. Code eingeben, schon seid ihr verbunden |
| ⚡ **Echtzeit-Chat** | Nachrichten gehen direkt von PC zu PC (Peer-to-Peer) |
| 👥 **Gruppenchats** | Gruppen erstellen, Freunde hinzufügen, umbenennen, verlassen. Mit Gruppenbild und Beschreibung |
| 📷 **Bilder & GIFs** | Über 📎, mit Strg+V, per Drag & Drop oder aus dem Windows-Emoji-Feld (Win + .). GIFs bis 25 MB, Bilder werden automatisch verkleinert |
| 🧹 **Chat leeren** | Verlauf eines Chats löschen und Speicher freigeben. Übersicht aller Chats nach Größe in den Einstellungen |
| 🌅 **Status** | Wie bei WhatsApp: ein oder mehrere Bilder mit Beschreibung teilen, 24 Stunden sichtbar. Ansehen als Slides (tippen, wischen, gedrückt halten = Pause), Reaktionen mit Emojis, „Angesehen von“ für deine eigenen Status |
| 🎤 **Sprachnachrichten** | Mikrofon-Knopf im Chat (erscheint, wenn das Eingabefeld leer ist). Aufnahme mit Live-Pegel, verwerfen oder senden. Abspielen mit Wellenform, Vorspulen per Tippen und 1×/1,5×/2× Tempo. Funktioniert zwischen Windows, iPhone und Browser |
| 🩷 **Sticker** | Exklusiv für einen Nutzer: Sticker aus eigenen Bildern erstellen (rund, eckig oder ganzes Bild, Größe, Text), speichern und senden. Alle anderen sehen die Sticker nur und können sie weder speichern noch benutzen |
| 📞 **Anrufe** | Sprach- und Videoanrufe im Einzelchat, direkt verschlüsselt zwischen den Geräten. Eigenes Bild klein in der Ecke (verschiebbar, antippen zum Tauschen), Kamera drehen, stummschalten, Kamera aus. Verpasste Anrufe stehen im Chat |
| 🧭 **Leiste unten** | Status links, Chats in der Mitte, Einstellungen („Du“) rechts |
| 📱 **Web-Version** | Für iPhone, iPad und Android, chattet direkt mit der Windows-App |
| 😊 **Emojis** | Emoji-Auswahl mit Kategorien und „Zuletzt benutzt“. Nachrichten nur aus Emojis werden groß angezeigt |
| 🏆 **Erfolge** | 27 Erfolge zum Freischalten, z. B. 25 Nachrichten, erstes GIF, Nachteule oder 7 Tage am Stück |
| 🖼️ **Profil** | Profilbild, Name und Status. Deine Freunde sehen dein Bild und deine Erfolge |
| 🐱 **Profilrahmen** | 11 Rahmen fürs Profilbild: Katzenohren, Hasenohren, Teufelshörner, Heiligenschein, Krone, Partyhut, Kopfhörer, Blumenkranz, Herzen, Funkeln, Neon |
| 🔔 **Benachrichtigungen** | Windows-Benachrichtigungen wie bei Teams/Discord mit Profilbild. Ein Klick öffnet den Chat. Roter Zähler am Taskleisten-Icon |
| ↩️ **Direkt antworten** | Wie bei Teams direkt in der Benachrichtigung antworten, ohne WhatsUp zu öffnen. `Enter` sendet, `Shift+Enter` macht eine neue Zeile (eigenes Benachrichtigungsfenster unten rechts, in den Einstellungen abschaltbar) |
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

## 📬 Offline-Zustellung

Sind beide online, gehen Nachrichten wie bisher **direkt von Gerät zu Gerät**.
Ist dein Freund offline, landet die Nachricht **Ende-zu-Ende-verschlüsselt** in seinem Briefkasten auf einem kleinen Server (Cloudflare). Sobald er WhatsUp öffnet, wird sie abgeholt und vom Server gelöscht. Dann siehst du ✓✓.

- Funktioniert für Nachrichten, Bilder, GIFs, Gruppen und Freundschaftsanfragen
- Ungelesene Nachrichten werden nach 30 Tagen automatisch gelöscht
- Lässt sich unter **Einstellungen → Offline-Zustellung** ausschalten (dann wieder nur direkt)
- Der Server-Code liegt im Ordner [`relay/`](relay/)

## 🔒 Sicherheit & Datenschutz

- **Verschlüsselte Direktverbindung:** Nachrichten laufen über WebRTC-Datenkanäle, die immer mit DTLS verschlüsselt sind.
- **Verschlüsselter Briefkasten:** Für die Offline-Zustellung hat jedes Gerät eigene Schlüssel (P-256), die das Gerät nie verlassen. Jede Nachricht wird mit einem Einmal-Schlüssel und AES-256-GCM verschlüsselt und vom Absender signiert. Der Server kann Nachrichten weder lesen noch fälschen, und nur der Besitzer des Codes kann seinen Briefkasten abholen.
- **Signalisierung:** Der öffentliche [PeerJS](https://peerjs.com)-Server hilft nur beim *Verbindungsaufbau*. Deine Nachrichten bekommt er nie zu sehen.
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
- Der Briefkasten-Server sieht keine Inhalte, aber **Metadaten**: welcher Code wann wie große Nachrichten an welchen Code schickt, sowie IP-Adressen.

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
npm run build:web  # Web-Version (iPhone/iPad) in den Ordner dist-web/ bauen
```

Die Web-Version wird bei jedem Push auf `main` automatisch auf GitHub Pages veröffentlicht (`.github/workflows/web.yml`).

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
web/                 # Nur Web-Version: Ersatz für preload.js, iPhone-Design, Manifest, Icons
scripts/build-web.js # Baut die Web-Version aus src/ + web/
relay/               # Briefkasten-Server (Cloudflare Worker): npm install && npx wrangler deploy
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
