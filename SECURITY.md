# Sicherheitsrichtlinie

## Unterstützte Versionen

| Version | Sicherheitsupdates |
|---------|--------------------|
| 1.x (neueste) | ✅ |
| ältere | ❌ |

Bitte nutze immer die [neueste Version](https://github.com/Jeremy-Jud/whatsup/releases/latest).

## Sicherheitslücke melden

**Bitte melde Sicherheitslücken nicht als öffentliches Issue.**

Nutze stattdessen die private Meldefunktion von GitHub:
**[Sicherheitslücke melden](https://github.com/Jeremy-Jud/whatsup/security/advisories/new)**

Bitte schreib dazu:
- was das Problem ist und welche Auswirkungen es hat,
- wie man es nachstellen kann,
- welche Version du verwendest.

Du bekommst so schnell wie möglich eine Rückmeldung. Nach dem Fix wird die Lücke im Release genannt (auf Wunsch mit Danksagung).

## Sicherheitsmodell

**Was WhatsUp schützt:**
- Nachrichten werden über WebRTC (DTLS) verschlüsselt direkt zwischen den Rechnern übertragen.
- Anrufe laufen ebenfalls direkt über WebRTC und sind mit DTLS-SRTP Ende-zu-Ende verschlüsselt. Muss die Verbindung über einen TURN-Server umgeleitet werden, sieht dieser nur verschlüsselte Daten. Kamera und Mikrofon werden nur während eines Anrufs benutzt; die Windows-App erlaubt sie nur dem eigenen Fenster.
- Der PeerJS-Signalisierungsserver sieht nur Verbindungsdaten (Peer-IDs, IP-Adressen), aber keine Nachrichten.
- **Briefkasten-Server (Offline-Zustellung, `relay/`):** Jedes Gerät erzeugt ECDSA- und ECDH-Schlüssel (P-256), die privaten Schlüssel sind nicht exportierbar. Nachrichten werden mit einem Einmal-ECDH-Schlüssel, HKDF und AES-256-GCM verschlüsselt und vom Absender per ECDSA signiert. Der Empfänger prüft die Signatur, der Server kann Inhalte weder lesen noch fälschen.
- Beim Server ist zu jedem Code der Schlüssel hinterlegt (beim ersten Kontakt, danach unveränderbar). Senden, Abholen, Löschen und Push-Anmeldung erfordern eine frische Signatur (max. 10 Minuten alt). Pro Absender gilt ein Mengenlimit, pro Briefkasten eine Größenbegrenzung.
- Web-Push (RFC 8291/8292) enthält nur den Absender-Code, keinen Nachrichteninhalt.
- Status-Updates werden genauso Ende-zu-Ende-verschlüsselt verteilt wie Nachrichten. Nur Nachrichten, Reaktionen und Freundschaftsanfragen lösen einen Push aus. Alles andere (Profil- und Gruppen-Abgleich, Status, Bestätigungen) wird still zugestellt; der Server sieht dabei nur, dass die Zustellung still sein soll.
- **Anmelden auf einem neuen Gerät (Konto-Umzug):** Das neue Gerät verbindet sich über WebRTC mit dem bisherigen Gerät. Dort wird ein zufälliger 6-stelliger Bestätigungscode angezeigt (nicht in der Windows-Benachrichtigung), der auf dem neuen Gerät eingegeben werden muss. Höchstens 3 Versuche, Gültigkeit 5 Minuten, danach Sperre. Erst dann werden die Daten übertragen. Der Briefkasten-Server übernimmt die neuen Schlüssel nur, wenn der bisherige Schlüssel (alter Besitzer) und der neue Schlüssel (Besitz-Nachweis) den Wechsel signiert haben (`/v1/rotate`). Push-Abos des alten Geräts werden dabei gelöscht. Das alte Gerät löscht danach alle lokalen Daten.
- Die Oberfläche läuft mit `contextIsolation`, `sandbox` und ohne `nodeIntegration`. Dazu kommen eine strenge Content Security Policy, gesperrte Navigation und ein Berechtigungsfilter.
- Alle empfangenen Texte werden als reiner Text angezeigt (kein HTML), was XSS verhindert.

- Updates (nur installierte Version) kommen ausschließlich aus den GitHub-Releases dieses Repos über HTTPS. Die SHA-512-Prüfsumme aus `latest.yml` wird vor der Installation geprüft.

**Bekannte Grenzen:**
- Updates sind nicht code-signiert. Die Prüfsumme schützt vor beschädigten Downloads, aber wer Schreibrechte auf dieses Repo hat, kann Updates veröffentlichen. Darum ist Zwei-Faktor-Anmeldung für den Account wichtig.
- Der Freundescode ist gleichzeitig die Adresse im Netzwerk. Wer den Code kennt, kann eine Verbindung aufbauen.
- Es gibt keine Prüfung, dass ein Gerät dauerhaft derselben Person gehört (kein Schlüssel-Fingerprint).
- Chatpartner sehen bei einer direkten Verbindung gegenseitig ihre IP-Adresse.
- Der lokale Chatverlauf wird unverschlüsselt im Benutzerprofil gespeichert.
- Der Briefkasten-Server sieht Metadaten: Absender- und Empfänger-Code, Zeitpunkt, Größe und IP-Adressen. Schlüssel werden beim ersten Kontakt ohne zusätzliche Bestätigung übernommen („trust on first use“). Ein Server, der von Anfang an bösartig ist, könnte also einen falschen Schlüssel ausliefern, bevor sich zwei Geräte direkt verbunden haben.
- Wer den Bestätigungscode vom bisherigen Gerät bekommt (z. B. durch einen Trick: „Schick mir mal den Code“), kann das Konto übernehmen. Die App warnt davor.
- Nachrichten, die Freunde über den Briefkasten schicken, bevor sie vom Umzug erfahren haben, sind noch für den alten Schlüssel verschlüsselt und können auf dem neuen Gerät nicht gelesen werden. Das Zeitfenster ist kurz, weil das neue Gerät beim Start allen Freunden seine neuen Schlüssel schickt.
- Die `.exe` ist nicht code-signiert. Prüfe die SHA-256-Prüfsumme aus dem Release.
