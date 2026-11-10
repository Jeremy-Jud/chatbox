# 💬 Chatbox

Eine kleine Desktop-Chat-App. Sie öffnet sich als kompaktes Fenster, und man fügt Freunde einfach per **6-stelligem Code** hinzu.

## Funktionen

- Kleines, rahmenloses Fenster (360 × 540), auf Wunsch **immer im Vordergrund** (📌)
- Jeder Nutzer bekommt beim ersten Start einen eigenen **Code**, z. B. `K7M2QX`
- Freunde per Code adden. Die andere Person sieht dich automatisch auch in ihrer Liste
- Echtes Chatten in Echtzeit, direkt von PC zu PC (Peer-to-Peer über WebRTC)
- Online-Status, ungelesene Nachrichten, Desktop-Benachrichtigungen
- Häkchen: 🕓 wartet · ✓ gesendet · ✓✓ angekommen
- Nachrichten an Freunde, die gerade offline sind, werden automatisch zugestellt, sobald beide Chatbox offen haben
- Chatverlauf wird lokal auf deinem PC gespeichert

## Starten

Voraussetzung: [Node.js](https://nodejs.org) (LTS)

```bash
npm install
npm start
```

## Als .exe bauen

```bash
npm run dist
```

Die fertige portable `Chatbox.exe` liegt danach im Ordner `dist/` und kann an Freunde weitergegeben werden.

## So funktioniert's

Chatbox nutzt [PeerJS](https://peerjs.com). Der öffentliche PeerJS-Server wird nur zum Verbindungsaufbau genutzt. Die Nachrichten selbst gehen verschlüsselt (WebRTC/DTLS) direkt zwischen den Rechnern hin und her. Es gibt keinen zentralen Server, der deine Chats speichert.

**Hinweis:** Weil es keinen Server gibt, müssen beide Personen Chatbox gleichzeitig geöffnet haben, damit Nachrichten ankommen.
