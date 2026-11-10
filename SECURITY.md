# Sicherheitsrichtlinie

## Unterstützte Versionen

| Version | Sicherheitsupdates |
|---------|--------------------|
| 1.x (neueste) | ✅ |
| ältere | ❌ |

Bitte nutze immer die [neueste Version](https://github.com/Jeremy-Jud/chatbox/releases/latest).

## Sicherheitslücke melden

**Bitte melde Sicherheitslücken nicht als öffentliches Issue.**

Nutze stattdessen die private Meldefunktion von GitHub:
**[Sicherheitslücke melden](https://github.com/Jeremy-Jud/chatbox/security/advisories/new)**

Bitte schreib dazu:
- was das Problem ist und welche Auswirkungen es hat,
- wie man es nachstellen kann,
- welche Version du verwendest.

Du bekommst so schnell wie möglich eine Rückmeldung. Nach dem Fix wird die Lücke im Release genannt (auf Wunsch mit Danksagung).

## Sicherheitsmodell

**Was Chatbox schützt:**
- Nachrichten werden über WebRTC (DTLS) verschlüsselt direkt zwischen den Rechnern übertragen.
- Der PeerJS-Signalisierungsserver sieht nur Verbindungsdaten (Peer-IDs, IP-Adressen), aber keine Nachrichten.
- Die Oberfläche läuft mit `contextIsolation`, `sandbox` und ohne `nodeIntegration`. Dazu kommen eine strenge Content Security Policy, gesperrte Navigation und ein Berechtigungsfilter.
- Alle empfangenen Texte werden als reiner Text angezeigt (kein HTML), was XSS verhindert.

**Bekannte Grenzen:**
- Der Freundescode ist gleichzeitig die Adresse im Netzwerk. Wer den Code kennt, kann eine Verbindung aufbauen.
- Es gibt keine Prüfung, dass ein Gerät dauerhaft derselben Person gehört (kein Schlüssel-Fingerprint).
- Chatpartner sehen bei einer direkten Verbindung gegenseitig ihre IP-Adresse.
- Der lokale Chatverlauf wird unverschlüsselt im Benutzerprofil gespeichert.
- Die `.exe` ist nicht code-signiert. Prüfe die SHA-256-Prüfsumme aus dem Release.
