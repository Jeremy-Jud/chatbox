/* WhatsUp – Peer-to-Peer-Chat über WebRTC (PeerJS).
 * Jeder Nutzer hat einen 6-stelligen Code = Peer-ID. Einzel- und Gruppenchats,
 * Bilder/GIFs, Emojis, Profilbilder und Erfolge. */
(() => {
  'use strict';

  const ID_PREFIX = 'chatbox-v1-';
  const LOGIN_PREFIX = 'chatbox-login-'; // vorübergehende Peer-ID eines Geräts, das sich anmelden will
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I
  const CODE_RE = /^[A-Z0-9]{6}$/;
  const RETRY_MS = 10000;
  const MAX_TEXT = 4000;
  const MAX_MB = 25;                                              // max. Größe pro Bild/GIF
  const MAX_MEDIA = Math.ceil(MAX_MB * 1024 * 1024 * 4 / 3) + 64; // als Base64-Daten-URL
  const OLD_MAX_MEDIA = 10 * 1024 * 1024; // Grenze bis v1.10 – ältere Versionen lehnen Größeres ab
  const PROTO = 6;                        // Protokoll-Version (3 = große Dateien bis 25 MB, 4 = Sprachnachrichten, 5 = Sticker, 6 = Videos)
  const STICKER_OWNER = 'V5KGWG';         // nur dieser Nutzer hat die Sticker-Funktion
  const STICKER_MAX = 1.5 * 1024 * 1024;
  const MAX_AVATAR = 300 * 1024;
  const MEDIA_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;
  const AUDIO_RE = /^data:audio\/(mp4|webm|ogg|mpeg|aac|x-m4a);base64,/;
  const VIDEO_RE = /^data:video\/(mp4|webm|quicktime);base64,/;
  const POSTER_MAX = 200 * 1024; // Vorschaubild eines Videos
  const $ =(id) => document.getElementById(id);

  // ================= Speicher =================
  let loggedOut = false; // Konto ist auf ein anderes Gerät umgezogen: nichts mehr speichern
  const store = {
    load(key, fallback) {
      try { const v = localStorage.getItem('chatbox.' + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    save(key, value) {
      if (loggedOut) return;
      try { localStorage.setItem('chatbox.' + key, JSON.stringify(value)); } catch (e) { console.error(e); }
    },
  };

  // IndexedDB für Chatverläufe und Bilder (localStorage wäre dafür zu klein)
  const db = (() => {
    let dbp;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      const r = indexedDB.open('chatbox', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['chats', 'media', 'keys'].forEach((s) => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
    const run = async (name, mode, fn) => {
      if (loggedOut && mode === 'readwrite') return undefined;
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(name, mode);
        const req = fn(t.objectStore(name));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      keys: (s) => run(s, 'readonly', (st) => st.getAllKeys()),
      // Ganze Datenbank löschen (Abmelden nach dem Konto-Umzug)
      destroy: async () => {
        try { (await open()).close(); } catch {}
        dbp = null;
        await new Promise((res) => { const r = indexedDB.deleteDatabase('chatbox'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
      },
      get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
      put: (s, k, v) => run(s, 'readwrite', (st) => st.put(v, k)),
      del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
      all: async (s) => {
        const d = await open();
        return new Promise((res, rej) => {
          const out = {};
          const t = d.transaction(s, 'readonly');
          const c = t.objectStore(s).openCursor();
          c.onsuccess = () => { const cur = c.result; if (cur) { out[cur.key] = cur.value; cur.continue(); } };
          t.oncomplete = () => res(out);
          t.onerror = () => rej(t.error);
        });
      },
    };
  })();

  // ================= Zustand =================
  let me = store.load('me', null);                 // { code, name, status, avatar }
  let contacts = store.load('contacts', null);     // code -> { name, status, avatar, badges, friend }
  let groups = store.load('groups', {});           // gid -> { id, name, owner, members[], names{}, updated }
  let leftGroups = store.load('leftGroups', []);
  let blocked = store.load('blocked', []);
  let unread = store.load('unread', {});           // chatId -> Anzahl
  let recentEmojis = store.load('recentEmojis', []);
  const settings = Object.assign({
    theme: 'system', notify: true, sound: true, preview: true, autoUpdate: true,
    runInBackground: true, openAtLogin: false, bgHintShown: false, relay: true, popupNotify: true,
  }, store.load('settings', {}));
  const saveSettings = () => store.save('settings', settings);
  let unlocked = store.load('achievements', {});   // id -> Zeitstempel
  const stats = Object.assign({
    sent: 0, groupSent: 0, images: 0, gifs: 0, emojis: 0, received: 0, groupsCreated: 0,
    avatarSet: 0, statuses: 0, calls: 0, voices: 0, maxFire: 0, night: 0, early: 0, days: 0, streak: 0, maxStreak: 0, lastDay: '',
  }, store.load('stats', {}));
  let chats = {};                                  // chatId -> [Nachricht]
  const mediaCache = new Map();

  // Übernahme aus Version 1.0
  if (!contacts) {
    contacts = {};
    for (const [code, f] of Object.entries(store.load('friends', {}))) {
      contacts[code] = { name: f.name, friend: true };
      if (f.unread) unread['u:' + code] = f.unread;
    }
  }

  function saveMeta() {
    store.save('me', me); store.save('contacts', contacts); store.save('groups', groups);
    store.save('leftGroups', leftGroups); store.save('blocked', blocked); store.save('unread', unread);
    store.save('stats', stats); store.save('achievements', unlocked); store.save('recentEmojis', recentEmojis);
  }

  const saveTimers = {};
  function saveChat(chatId) {
    clearTimeout(saveTimers[chatId]);
    saveTimers[chatId] = setTimeout(() => db.put('chats', chatId, chats[chatId] || []).catch(console.error), 250);
  }

  const mediaKey = (chatId, id) => chatId + '|' + id;
  async function getMedia(chatId, id) {
    const k = mediaKey(chatId, id);
    if (mediaCache.has(k)) return mediaCache.get(k);
    const v = await db.get('media', k).catch(() => null);
    if (v) mediaCache.set(k, v);
    return v;
  }
  function putMedia(chatId, id, data) {
    const k = mediaKey(chatId, id);
    mediaCache.set(k, data);
    return db.put('media', k, data).catch(console.error);
  }

  async function loadData() {
    try { chats = await db.all('chats'); } catch (e) { console.error(e); chats = {}; }
    const old = store.load('messages', null);
    if (old && me) {
      for (const [code, list] of Object.entries(old)) {
        const id = 'u:' + code;
        if (chats[id]) continue;
        chats[id] = list.map((m) => (m.from === me.code
          ? { id: m.id, from: m.from, text: m.text, ts: m.ts, to: [code],
              sentTo: m.status && m.status !== 'pending' ? [code] : [], deliveredTo: m.status === 'delivered' ? [code] : [] }
          : { id: m.id, from: m.from, text: m.text, ts: m.ts }));
        await db.put('chats', id, chats[id]).catch(console.error);
      }
      try { localStorage.removeItem('chatbox.messages'); localStorage.removeItem('chatbox.friends'); } catch {}
      saveMeta();
    }
  }

  function deleteChatData(chatId) {
    (chats[chatId] || []).forEach((m) => {
      if (m.media) { mediaCache.delete(mediaKey(chatId, m.id)); db.del('media', mediaKey(chatId, m.id)).catch(() => {}); }
    });
    delete chats[chatId];
    delete unread[chatId];
    db.del('chats', chatId).catch(() => {});
  }

  // Chatverlauf leeren (Kontakt/Gruppe bleibt), gibt Speicher von Bildern und GIFs frei
  async function clearChat(chatId) {
    (chats[chatId] || []).forEach((m) => {
      if (m.media) { mediaCache.delete(mediaKey(chatId, m.id)); db.del('media', mediaKey(chatId, m.id)).catch(() => {}); }
    });
    chats[chatId] = [];
    delete unread[chatId];
    clearTimeout(saveTimers[chatId]);
    await db.put('chats', chatId, []).catch(console.error);
    saveMeta(); scheduleRender();
  }

  // Ungefährer Speicherbedarf eines Chats in Bytes (Text + Bilder)
  async function chatSize(chatId) {
    let bytes = 0;
    for (const m of chats[chatId] || []) {
      bytes += (m.text || '').length * 2 + 120;
      if (m.media) {
        const d = await getMedia(chatId, m.id).catch(() => null);
        if (d) bytes += Math.round(d.length * 0.75);
      }
    }
    return bytes;
  }
  const fmtBytes = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`);

  // ================= Hilfsfunktionen =================
  const clean = (s, max) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
  const isFriend = (c) => !!(contacts[c] && contacts[c].friend);
  const friendCodes = () => Object.keys(contacts).filter(isFriend);
  const others = (g) => g.members.filter((c) => c !== me.code);
  const sharesGroup = (code) => Object.values(groups).some((g) => g.members.includes(code));
  const nameOf = (code) => (code === me.code ? me.name : (contacts[code] && contacts[code].name) || 'Nutzer ' + code);
  const ensureContact = (code, name) => {
    if (!contacts[code]) contacts[code] = { name: clean(name, 24) || 'Nutzer ' + code, friend: false };
    return contacts[code];
  };
  const validAvatar = (a) => (typeof a === 'string' && a.length <= MAX_AVATAR && MEDIA_RE.test(a.slice(0, 40)) ? a : null);
  const emojiCount = (t) => (t.match(/\p{Extended_Pictographic}/gu) || []).length;
  const onlyEmoji = (t) => t && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍|\s)+$/u.test(t) && emojiCount(t) <= 3;
  const dayStr = (d) => d.toLocaleDateString('sv-SE');
  const clampTs = (ts) => { const n = Number(ts), now = Date.now(); return n > 0 && n <= now + 60000 ? Math.min(n, now) : now; };

  function validMedia(m) {
    if (!m || typeof m !== 'object') return null;
    if (m.kind === 'sticker') {
      if (typeof m.data !== 'string' || m.data.length > STICKER_MAX || !/^data:image\/(png|webp);base64,/.test(m.data.slice(0, 30))) return null;
      return { kind: 'sticker', data: m.data, w: 512, h: 512 };
    }
    if (m.kind === 'audio') {
      if (typeof m.data !== 'string' || m.data.length > MAX_MEDIA || !AUDIO_RE.test(m.data.slice(0, 40))) return null;
      const dur = Math.round(Number(m.dur) * 10) / 10;
      const wave = Array.isArray(m.wave) ? m.wave.slice(0, 64).map((v) => Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100) / 100) : [];
      return { kind: 'audio', data: m.data, dur: dur > 0 && dur <= 3600 ? dur : 0, wave };
    }
    if (m.kind === 'video') {
      if (typeof m.data !== 'string' || m.data.length > MAX_MEDIA || !VIDEO_RE.test(m.data.slice(0, 40))) return null;
      const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 10000 ? n : 360; };
      const dur = Math.round(Number(m.dur) * 10) / 10;
      const poster = typeof m.poster === 'string' && m.poster.length <= POSTER_MAX && /^data:image\/(jpeg|webp|png);base64,/.test(m.poster.slice(0, 30)) ? m.poster : null;
      return { kind: 'video', data: m.data, w: dim(m.w), h: dim(m.h), dur: dur > 0 && dur <= 3600 ? dur : 0, poster };
    }
    if (m.kind !== 'image' && m.kind !== 'gif') return null;
    if (typeof m.data !== 'string' || m.data.length > MAX_MEDIA || !MEDIA_RE.test(m.data.slice(0, 40))) return null;
    const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 20000 ? n : 300; };
    return { kind: m.kind, data: m.data, w: dim(m.w), h: dim(m.h) };
  }

  // Was von einer Datei in der Nachricht gespeichert wird (die Daten selbst liegen in IndexedDB)
  const mediaMeta = (m) => (m.kind === 'audio' ? { kind: 'audio', dur: m.dur || 0, wave: m.wave || [] }
    : m.kind === 'video' ? { kind: 'video', w: m.w, h: m.h, dur: m.dur || 0, poster: m.poster || null }
    : { kind: m.kind, w: m.w, h: m.h });

  function sanitizeGroup(g) {
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !/^[a-z0-9-]{8,40}$/.test(g.id)) return null;
    const members = Array.isArray(g.members) ? [...new Set(g.members.filter((c) => typeof c === 'string' && CODE_RE.test(c)))].slice(0, 50) : [];
    const names = {};
    if (g.names && typeof g.names === 'object') members.forEach((c) => { const n = clean(g.names[c], 24); if (n) names[c] = n; });
    return {
      id: g.id, name: clean(g.name, 40) || 'Gruppe', owner: CODE_RE.test(g.owner) ? g.owner : members[0],
      members, names, updated: Number(g.updated) || 0,
      // Ältere Versionen kennen Bild/Beschreibung nicht: undefined = „unverändert lassen“
      avatar: 'avatar' in g ? validAvatar(g.avatar) : undefined,
      desc: 'desc' in g ? clean(g.desc, 200) : undefined,
      by: CODE_RE.test(g.by) && members.includes(g.by) ? g.by : null,
    };
  }

  // ================= Netzwerk =================
  let peer = null;
  const conns = {};       // code -> DataConnection
  const connecting = {};  // code -> Zeitstempel
  const queues = {};      // code -> Promise (Sendereihenfolge)
  let pendingAdd = null;
  let pendingAddRelayed = false; // Anfrage liegt schon im Briefkasten

  const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const peerIdOf = (code) => ID_PREFIX + code.toLowerCase();
  const codeOf = (peerId) => peerId.slice(ID_PREFIX.length).toUpperCase();
  const isOnline = (code) => !!(conns[code] && conns[code].open);

  function wantedCodes() {
    const s = new Set(friendCodes());
    Object.values(groups).forEach((g) => others(g).forEach((c) => s.add(c)));
    s.delete(me.code);
    blocked.forEach((c) => s.delete(c));
    return [...s];
  }

  function startPeer() {
    clearTimeout(restartTimer);
    const old = peer;
    const p = (peer = new Peer(peerIdOf(me.code), { debug: 0 }));
    if (old) { try { old.destroy(); } catch {} }
    // Ereignisse eines alten, ersetzten Peers ignorieren
    p.on('open', () => { if (p !== peer) return; setNet(true); connectAll(); });
    p.on('connection', (conn) => {
      if (p !== peer) { conn.close(); return; }
      if (conn.peer.startsWith(LOGIN_PREFIX)) login.incoming(conn); // neues Gerät will sich anmelden
      else setupConn(conn, false);
    });
    p.on('call', (mc) => { if (p === peer) calls.incoming(mc); else mc.close(); });
    p.on('disconnected', () => {
      if (p !== peer) return;
      setNet(false);
      setTimeout(() => { if (p === peer && !p.destroyed && p.disconnected) try { p.reconnect(); } catch { restartPeer(5000); } }, 3000);
    });
    p.on('error', (err) => {
      if (p !== peer) return;
      if (err.type === 'peer-unavailable') {
        const m = /chatbox-v1-(\w+)/i.exec(err.message || '');
        if (m) {
          const code = m[1].toUpperCase();
          delete connecting[code];
          calls.unavailable(code);
          if (pendingAdd === code) {
            // Mit Briefkasten-Server geht die Anfrage gleich darüber raus (pendingAdd bleibt für den Hinweis)
            if (relay.canSend(code)) { if (!pendingAddRelayed) setStatus('Dein Freund ist offline. Anfrage wird über den Server zugestellt…'); }
            else { setStatus('Freund ist gerade nicht online. Ihr werdet verbunden, sobald dein Freund WhatsUp öffnet.'); pendingAdd = null; }
          }
        }
        return;
      }
      if (err.type === 'unavailable-id') { setNet(false); restartPeer(5000); return; }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) { setNet(false); restartPeer(8000); }
      console.warn('Peer-Fehler:', err.type, err);
    });
  }
  let restartTimer = null;
  function restartPeer(ms) { clearTimeout(restartTimer); restartTimer = setTimeout(startPeer, ms); }

  function connectTo(code) {
    if (!peer || !peer.open || code === me.code || isOnline(code) || blocked.includes(code)) return;
    if (connecting[code] && Date.now() - connecting[code] < 15000) return;
    connecting[code] = Date.now();
    setupConn(peer.connect(peerIdOf(code), { reliable: true }), true);
  }
  function connectAll() { wantedCodes().forEach(connectTo); }

  function setupConn(conn, mine) {
    const code = codeOf(conn.peer);
    if (!CODE_RE.test(code) || blocked.includes(code)) { conn.close(); return; }

    conn.on('open', () => {
      delete connecting[code];
      // Die neueste Verbindung gewinnt. Eine ältere kann tot sein, ohne dass wir es merken
      // (z. B. iPhone im Hintergrund, PC neu gestartet) – dann würde alles dort verloren gehen.
      // Die alte bleibt offen: Was darüber noch ankommt, wird weiter verarbeitet.
      conns[code] = conn;
      conn.send(helloPayload(code));
      Object.values(groups).forEach((g) => { if (g.members.includes(code)) conn.send({ type: 'group', group: g }); });
      flushPending(code);
      flushActions(code);
      stories.syncTo(code);
      scheduleRender();
    });
    conn.on('data', (data) => { try { handleData(code, data); } catch (e) { console.error(e); } });
    const drop = () => { if (conns[code] === conn) delete conns[code]; scheduleRender(); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  function helloPayload(code) {
    return {
      type: 'hello', v: PROTO, pv: me.pv || 0, name: me.name, status: me.status || '', avatar: me.avatar || null, frame: me.frame || null, banner: validBanner(me.banner),
      badges: Object.keys(unlocked).length, ach: Object.keys(unlocked), ctx: isFriend(code) ? 'friend' : 'group',
      keys: relay.publicKeys(),
    };
  }

  function sendTo(code, data) {
    if (!isOnline(code)) return false;
    try { conns[code].send(data); return true; } catch { return false; }
  }
  // Direkt senden, sonst über den Briefkasten-Server (wenn der andere offline ist)
  function sendData(code, data) {
    if (sendTo(code, data)) return true;
    relay.send(code, data).catch(() => {});
    return false;
  }
  function broadcastProfile() {
    const targets = new Set([...friendCodes(), ...Object.keys(conns)]);
    targets.forEach((c) => sendData(c, helloPayload(c)));
  }

  function handleData(code, data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'hello': {
        const c = ensureContact(code);
        c.name = clean(data.name, 24) || c.name;
        c.status = clean(data.status, 80);
        c.avatar = validAvatar(data.avatar);
        c.frame = validFrame(data.frame);
        c.banner = validBanner(data.banner);
        c.pv = Math.max(0, Number(data.pv) || 0);
        relay.pinKeys(code, data.keys);
        relay.saveNames();
        c.badges = Math.max(0, Math.min(999, Number(data.badges) || 0));
        // Welche Erfolge (ältere Versionen schicken nur die Anzahl)
        if (Array.isArray(data.ach)) c.ach = [...new Set(data.ach.map(String))].filter((id) => ACH.some((a) => a.id === id));
        const oldV = c.v || 1;
        c.v = Math.max(1, Math.min(99, Number(data.v) || 1));
        // Wartende große Dateien zustellen, sobald der Freund eine neue Version hat
        if (oldV < PROTO && c.v >= PROTO) setTimeout(() => flushPending(code), 0);
        if (data.ctx !== 'group' && !c.friend) {
          c.friend = true;
          if (pendingAdd !== code) { notify('Neuer Freund', `${c.name} hat dich hinzugefügt.`); toast(`🤝 ${c.name} hat dich hinzugefügt`); }
        }
        if (pendingAdd === code) { setStatus(`${c.name} wurde hinzugefügt ✓`); pendingAdd = null; $('addInput').value = ''; }
        saveMeta(); checkAchievements(); scheduleRender();
        break;
      }
      case 'msg': {
        const c = ensureContact(code);
        if (!c.friend) { c.friend = true; saveMeta(); }
        receiveMessage('u:' + code, code, data, null);
        break;
      }
      case 'gmsg': {
        const g = groups[data.gid];
        if (!g || !g.members.includes(code) || !g.members.includes(me.code)) return;
        receiveMessage('g:' + g.id, code, data, g.id);
        break;
      }
      case 'mact': // Reaktion oder „für alle löschen“
        receiveAction(code, data);
        break;
      case 'mack': { // Bestätigung für eine Aktion
        const a = actOutbox.find((x) => x.aid === data.aid);
        if (a && a.to === code) doneAction(a.aid);
        break;
      }
      case 'ack': {
        const chatId = data.gid ? 'g:' + data.gid : 'u:' + code;
        const m = (chats[chatId] || []).find((x) => x.id === data.id);
        if (m && m.from === me.code && m.to && m.to.includes(code) && !m.deliveredTo.includes(code)) {
          m.deliveredTo.push(code);
          if (!m.sentTo.includes(code)) m.sentTo.push(code);
          saveChat(chatId); scheduleRender();
        }
        break;
      }
      case 'group': {
        const g = sanitizeGroup(data.group);
        if (!g || !g.members.includes(code) || !g.members.includes(me.code) || leftGroups.includes(g.id)) return;
        const local = groups[g.id];
        if (local && g.updated <= local.updated) return;
        const added = local ? g.members.filter((c) => !local.members.includes(c)) : [];
        if (g.avatar === undefined) g.avatar = local ? local.avatar || null : null;
        if (g.desc === undefined) g.desc = local ? local.desc || '' : '';
        groups[g.id] = g;
        g.members.forEach((c) => { if (c !== me.code) { const ct = ensureContact(c, g.names[c]); if (/^Nutzer /.test(ct.name) && g.names[c]) ct.name = g.names[c]; } });
        if (!local) {
          systemMessage('g:' + g.id, `${nameOf(code)} hat dich zur Gruppe hinzugefügt`);
          notify('Neue Gruppe', `${nameOf(code)} hat dich zu „${g.name}“ hinzugefügt.`);
          toast(`👥 Neue Gruppe: ${g.name}`);
        } else {
          added.forEach((c) => systemMessage('g:' + g.id, `${nameOf(c)} ist der Gruppe beigetreten`));
          const who = g.by && g.by !== me.code ? nameOf(g.by) : null;
          const sys = (withWho, without) => systemMessage('g:' + g.id, who ? `${who} ${withWho}` : without);
          if (local.name !== g.name) sys(`hat die Gruppe in „${g.name}“ umbenannt`, `Gruppe heißt jetzt „${g.name}“`);
          if ((local.avatar || null) !== g.avatar) sys(g.avatar ? 'hat das Gruppenbild geändert' : 'hat das Gruppenbild entfernt', g.avatar ? 'Neues Gruppenbild' : 'Gruppenbild entfernt');
          if ((local.desc || '') !== g.desc) sys(g.desc ? 'hat die Beschreibung geändert' : 'hat die Beschreibung entfernt', 'Beschreibung geändert');
        }
        saveMeta(); connectAll(); scheduleRender();
        break;
      }
      case 'hreq':
        // Direkt UND über den Briefkasten antworten – falls die direkte Verbindung tot ist
        if (isFriend(code) || sharesGroup(code)) { const h = helloPayload(code); sendTo(code, h); relay.send(code, h).catch(() => {}); }
        break;
      case 'call-end': case 'call-reject': case 'call-cam': case 'callmiss':
        calls.handle(code, data);
        break;
      case 'status': case 'sdel': case 'slist': case 'sget': case 'sreact': case 'sseen':
        stories.handle(code, data).catch(console.error);
        break;
      case 'gleave': {
        const g = groups[data.gid];
        if (!g || !g.members.includes(code)) return;
        g.members = g.members.filter((c) => c !== code);
        g.updated = Math.max(g.updated + 1, Date.now());
        systemMessage('g:' + g.id, `${nameOf(code)} hat die Gruppe verlassen`);
        saveMeta(); scheduleRender();
        break;
      }
    }
  }

  // Verpasste Profil-Änderungen nachholen (z. B. wenn ein Update in eine tote Verbindung ging)
  const profileAsked = {};
  function checkProfileVersion(code, pv) {
    const c = contacts[code];
    pv = Number(pv) || 0;
    if (!c || !pv || pv <= (c.pv || 0)) return;
    if (profileAsked[code] && Date.now() - profileAsked[code] < 30000) return;
    profileAsked[code] = Date.now();
    sendData(code, { type: 'hreq' });
  }

  function receiveMessage(chatId, from, data, gid) {
    const id = String(data.id || '').slice(0, 64);
    if (!id) return;
    checkProfileVersion(from, data.pv);
    const list = (chats[chatId] = chats[chatId] || []);
    // Wurde schon „für alle gelöscht“, bevor sie ankam? Dann gar nicht erst anzeigen
    if (tombstones[chatId + '|' + id]) {
      delete tombstones[chatId + '|' + id]; saveTombstones();
      list.push({ id, from, text: '', ts: clampTs(data.ts), deleted: true });
      saveChat(chatId); scheduleRender();
    }
    if (!list.some((m) => m.id === id)) {
      const text = clean(data.text, MAX_TEXT);
      let media = validMedia(data.media);
      if (media && media.kind === 'sticker' && from !== STICKER_OWNER) media = null;
      if (!text && !media) { sendData(from, gid ? { type: 'ack', id, gid } : { type: 'ack', id }); return; }
      const msg = { id, from, text, ts: clampTs(data.ts) };
      const reply = validReply(data.reply);
      if (reply) msg.reply = reply;
      if (media) { msg.media = mediaMeta(media); putMedia(chatId, id, media.data); }
      list.push(msg);
      saveChat(chatId);
      if (!gid) fire.mark(from, 'them', msg.ts);
      stats.received++;
      if (activeChat !== chatId || !document.hasFocus()) {
        unread[chatId] = (unread[chatId] || 0) + 1;
        const title = gid ? `${groups[gid].name} – ${nameOf(from)}` : nameOf(from);
        notify(title, preview(msg), {
          chatId, icon: contacts[from] && contacts[from].avatar,
          replyPlaceholder: gid ? `Antwort an ${groups[gid].name}…` : `Antwort an ${nameOf(from)}…`,
        });
      }
      saveMeta(); checkAchievements(); scheduleRender();
    }
    sendData(from, gid ? { type: 'ack', id, gid } : { type: 'ack', id });
  }

  function recipientsOf(chatId) {
    if (chatId.startsWith('u:')) return [chatId.slice(2)];
    const g = groups[chatId.slice(2)];
    return g ? others(g) : [];
  }

  function enqueue(code, fn) {
    queues[code] = (queues[code] || Promise.resolve()).then(fn).catch(console.error);
  }

  const oldVersionWarned = new Set();
  async function deliverTo(chatId, msg, code, viaRelay = false) {
    if (msg.deliveredTo.includes(code) || msg.deleted) return; // gelöschte Nachrichten nicht mehr zustellen
    const useRelay = viaRelay || !isOnline(code);
    if (useRelay && (!relay.canSend(code) || (msg.relayedTo || []).includes(code))) return;
    const wire = { id: msg.id, text: msg.text, ts: msg.ts, pv: me.pv || 0 };
    if (msg.reply) wire.reply = msg.reply;
    if (msg.media) {
      const data = await getMedia(chatId, msg.id);
      if (!data) return;
      // Ältere Versionen (bis v1.10) lehnen Dateien über ~7 MB ab -> warten, bis der Freund aktualisiert
      if (data.length > OLD_MAX_MEDIA && ((contacts[code] && contacts[code].v) || 1) < 3 && !(msg.media.kind === 'video' || msg.media.kind === 'audio')) {
        const k = code + '|' + msg.id;
        if (!oldVersionWarned.has(k)) { oldVersionWarned.add(k); toast(`${nameOf(code)} braucht ein WhatsUp-Update für große GIFs – wird danach zugestellt`); }
        return;
      }
      // Ältere Versionen kennen keine Sprachnachrichten: Hinweistext statt Datei
      const peerV = (contacts[code] && contacts[code].v) || 1;
      if (msg.media.kind === 'audio' && peerV < 4) wire.text = '🎤 Sprachnachricht – aktualisiere WhatsUp, um sie anzuhören.';
      else if (msg.media.kind === 'sticker' && peerV < 5) wire.text = '🩷 Sticker – aktualisiere WhatsUp, um ihn zu sehen.';
      else if (msg.media.kind === 'video' && peerV < 6) wire.text = '🎥 Video – aktualisiere WhatsUp, um es anzusehen.';
      else wire.media = { ...mediaMeta(msg.media), data };
    }
    if (chatId.startsWith('g:')) { wire.type = 'gmsg'; wire.gid = chatId.slice(2); } else wire.type = 'msg';
    if (!useRelay && isOnline(code)) {
      if (sendTo(code, wire)) {
        if (!msg.sentTo.includes(code)) { msg.sentTo.push(code); saveChat(chatId); scheduleRender(); }
        // Keine Bestätigung? Verbindung war wohl tot (z. B. PC aus) -> zusätzlich in den Briefkasten.
        // Wartezeit: 15 s + Übertragungszeit bei ~150 KB/s für Bilder/GIFs
        const waitMs = 15000 + (wire.media ? Math.round(wire.media.data.length / 150) : 0);
        setTimeout(() => {
          if (!msg.deliveredTo.includes(code) && !(msg.relayedTo || []).includes(code)) enqueue(code, () => deliverTo(chatId, msg, code, true));
        }, waitMs);
      }
      return;
    }
    // Empfänger offline: verschlüsselt in seinen Briefkasten legen
    if (await relay.send(code, wire)) {
      msg.relayedTo = [...new Set([...(msg.relayedTo || []), code])];
      if (!msg.sentTo.includes(code)) msg.sentTo.push(code);
      saveChat(chatId); scheduleRender();
    }
  }

  // Nachrichten an Offline-Empfänger nach kurzer Wartezeit über den Server schicken
  // (falls die direkte Verbindung doch noch klappt, geht es direkt)
  function relayLater(chatId, msg, code, ms = 4000) {
    setTimeout(() => { if (!isOnline(code)) enqueue(code, () => deliverTo(chatId, msg, code)); }, ms);
  }
  function relayPending() {
    flushActions();
    for (const [chatId, list] of Object.entries(chats)) {
      for (const m of list) {
        if (m.from !== me.code || !m.to) continue;
        m.to.forEach((code) => {
          if (!isOnline(code) && !m.deliveredTo.includes(code) && !(m.relayedTo || []).includes(code)) enqueue(code, () => deliverTo(chatId, m, code));
        });
      }
    }
  }

  function flushPending(code) {
    for (const [chatId, list] of Object.entries(chats)) {
      for (const m of list) {
        if (m.from === me.code && m.to && m.to.includes(code) && !m.deliveredTo.includes(code) && !(m.relayedTo || []).includes(code)) {
          enqueue(code, () => deliverTo(chatId, m, code));
        }
      }
    }
  }

  async function sendMessage(chatId, text, media) {
    const to = recipientsOf(chatId);
    const msg = { id: crypto.randomUUID(), from: me.code, text, ts: Date.now(), to, sentTo: [], deliveredTo: [] };
    // Antwort auf eine Nachricht?
    if (pendingReply && pendingReply.chatId === chatId) {
      const orig = findMsg(chatId, pendingReply.id);
      if (orig && !orig.deleted) msg.reply = replyRef(orig);
      clearReply();
    }
    if (media) { msg.media = mediaMeta(media); await putMedia(chatId, msg.id, media.data); }
    (chats[chatId] = chats[chatId] || []).push(msg);
    saveChat(chatId);
    if (chatId.startsWith('u:')) fire.mark(chatId.slice(2), 'me', msg.ts);
    to.forEach((code) => {
      if (isOnline(code)) enqueue(code, () => deliverTo(chatId, msg, code));
      else { connectTo(code); relayLater(chatId, msg, code); }
    });

    stats.sent++;
    if (chatId.startsWith('g:')) stats.groupSent++;
    if (media) { if (media.kind === 'audio') stats.voices = (stats.voices || 0) + 1; else if (media.kind === 'video') stats.videos = (stats.videos || 0) + 1; else if (media.kind === 'gif') stats.gifs++; else stats.images++; }
    stats.emojis += emojiCount(text);
    const h = new Date().getHours();
    if (h < 4) stats.night++;
    if (h >= 5 && h < 7) stats.early++;
    touchDay();
    saveMeta(); checkAchievements(); scheduleRender();
  }

  // ================= Antworten, Reaktionen, Löschen =================
  const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
  const validEmoji = (e) => typeof e === 'string' && e.length <= 16 && /\p{Extended_Pictographic}/u.test(e) && !/[\p{L}\p{N}<>]/u.test(e.replace(/[\u{1F1E6}-\u{1F1FF}#*0-9️⃣]/gu, ''));
  const snippet = (s, n = 90) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  let pendingReply = null; // { chatId, id }
  // Für alle gelöschte Nachrichten, die (noch) nicht da sind: chatId|id -> Zeit
  const tombstones = store.load('tombstones', {});

  const findMsg = (chatId, id) => (chats[chatId] || []).find((x) => x.id === id && !x.sys);
  function replyRef(m) {
    return { id: m.id, from: m.from, text: snippet(m.deleted ? '' : preview(m)) };
  }
  function validReply(r) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !CODE_RE.test(String(r.from || ''))) return null;
    return { id: r.id.slice(0, 64), from: r.from, text: snippet(clean(r.text, 300)) };
  }

  // Aktion an alle anderen im Chat schicken – zuverlässig wie eine Nachricht:
  // Sie bleibt im Postausgang, bis der andere sie bestätigt ('mack') oder der Briefkasten-Server sie angenommen hat.
  // Ohne Bestätigung (z. B. tote Verbindung, iPhone im Hintergrund) geht sie nach 15 s zusätzlich über den Server.
  const ACT_MAX_AGE = 30 * 24 * 3600 * 1000;
  let actOutbox = store.load('actOutbox', []); // [{ aid, to, ts, data }]
  const actBusy = new Set();
  function saveOutbox() {
    actOutbox = actOutbox.filter((a) => Date.now() - a.ts < ACT_MAX_AGE);
    store.save('actOutbox', actOutbox);
  }
  function sendAction(chatId, data) {
    const gid = chatId.startsWith('g:') ? chatId.slice(2) : null;
    const ts = Date.now();
    recipientsOf(chatId).forEach((code) => {
      const aid = crypto.randomUUID();
      const item = { aid, to: code, ts, data: { ...data, type: 'mact', aid, ts, ...(gid ? { gid } : {}) } };
      actOutbox.push(item);
      deliverAction(item);
    });
    saveOutbox();
  }
  function deliverAction(item, viaRelay = false) {
    const code = item.to;
    if (actBusy.has(item.aid) && !viaRelay) return;
    actBusy.add(item.aid);
    if (!viaRelay && isOnline(code) && sendTo(code, item.data)) {
      setTimeout(() => { if (actOutbox.some((a) => a.aid === item.aid)) deliverAction(item, true); }, 15000);
      return;
    }
    if (!isOnline(code)) connectTo(code);
    relay.send(code, item.data)
      .then((ok) => { if (ok) doneAction(item.aid); })
      .catch(() => {})
      .finally(() => actBusy.delete(item.aid)); // sonst später nochmal (Verbindung/Briefkasten wieder da)
  }
  function doneAction(aid) {
    actBusy.delete(aid);
    const n = actOutbox.length;
    actOutbox = actOutbox.filter((a) => a.aid !== aid);
    if (actOutbox.length !== n) saveOutbox();
  }
  // Wartende Aktionen erneut versuchen (neue Verbindung, Briefkasten-Abruf, Start)
  function flushActions(code) {
    actOutbox.filter((a) => !code || a.to === code).forEach((a) => deliverAction(a));
  }

  function removeMedia(chatId, m) {
    if (!m.media) return;
    mediaCache.delete(mediaKey(chatId, m.id));
    db.del('media', mediaKey(chatId, m.id)).catch(() => {});
    delete m.media;
  }
  function markDeleted(chatId, m) {
    removeMedia(chatId, m);
    m.text = '';
    m.deleted = true;
    delete m.reactions;
    delete m.reply;
  }

  function setReaction(chatId, m, emoji) {
    if (!m || m.deleted) return;
    m.reactions = m.reactions || {};
    if (emoji && m.reactions[me.code] !== emoji) m.reactions[me.code] = emoji;
    else { delete m.reactions[me.code]; emoji = ''; }
    if (!Object.keys(m.reactions).length) delete m.reactions;
    saveChat(chatId); scheduleRender();
    sendAction(chatId, { act: 'react', id: m.id, emoji });
  }

  function deleteForAll(chatId, m) {
    if (!m || m.from !== me.code || m.deleted) return;
    markDeleted(chatId, m);
    saveChat(chatId); scheduleRender();
    sendAction(chatId, { act: 'del', id: m.id });
  }
  function deleteForMe(chatId, m) {
    const list = chats[chatId] || [];
    const i = list.indexOf(m);
    if (i < 0) return;
    removeMedia(chatId, m);
    list.splice(i, 1);
    if (pendingReply && pendingReply.id === m.id) clearReply();
    saveChat(chatId); scheduleRender();
  }

  // Aktion von einem anderen empfangen
  function receiveAction(from, data) {
    let chatId;
    if (data.gid) {
      const g = groups[data.gid];
      if (!g || !g.members.includes(from) || !g.members.includes(me.code)) return;
      chatId = 'g:' + g.id;
    } else chatId = 'u:' + from;
    // Empfang bestätigen, damit der Absender nicht mehr über den Server nachschickt
    if (typeof data.aid === 'string') sendTo(from, { type: 'mack', aid: data.aid.slice(0, 64) });
    const id = String(data.id || '').slice(0, 64);
    const m = findMsg(chatId, id);
    if (data.act === 'del') {
      if (!m) { tombstones[chatId + '|' + id] = Date.now(); saveTombstones(); return; }
      if (m.from !== from || m.deleted) return; // nur der Absender darf für alle löschen
      markDeleted(chatId, m);
      saveChat(chatId); scheduleRender();
    } else if (data.act === 'react') {
      if (!m || m.deleted) return;
      // Eine Reaktion kann doppelt (direkt + Server) oder verspätet ankommen: nur die neueste zählt
      const ts = Number(data.ts) || 0;
      m.rts = m.rts || {};
      if (ts && ts <= (m.rts[from] || 0)) return;
      if (ts) m.rts[from] = ts;
      m.reactions = m.reactions || {};
      if (validEmoji(data.emoji)) m.reactions[from] = data.emoji; else delete m.reactions[from];
      if (!Object.keys(m.reactions).length) delete m.reactions;
      saveChat(chatId); scheduleRender();
      if (m.from === me.code && validEmoji(data.emoji) && (activeChat !== chatId || !document.hasFocus())) {
        notify(nameOf(from), `hat mit ${data.emoji} auf deine Nachricht reagiert: ${snippet(preview(m), 60)}`, { chatId, icon: contacts[from] && contacts[from].avatar });
      }
    }
  }
  function saveTombstones() {
    const cut = Date.now() - 30 * 24 * 3600 * 1000; // so lange liegt eine Nachricht höchstens im Briefkasten
    Object.keys(tombstones).forEach((k) => { if (tombstones[k] < cut) delete tombstones[k]; });
    store.save('tombstones', tombstones);
  }

  // ---- Antworten: Leiste über dem Eingabefeld ----
  function startReply(chatId, m) {
    pendingReply = { chatId, id: m.id };
    $('replyName').textContent = m.from === me.code ? 'Du' : nameOf(m.from);
    $('replyName').style.color = m.from === me.code ? '' : colorFor(m.from);
    $('replyText').textContent = snippet(preview(m)) || ' ';
    $('replyBar').classList.remove('hidden');
    $('msgInput').focus();
  }
  function clearReply() {
    pendingReply = null;
    $('replyBar').classList.add('hidden');
  }
  $('replyCancel').onclick = clearReply;

  // Zitat in einer Nachricht; Klick springt zur Originalnachricht
  function quoteEl(chatId, r) {
    const orig = findMsg(chatId, r.id);
    const q = el('div', 'quote');
    const who = el('div', 'quote-name', r.from === me.code ? 'Du' : nameOf(r.from));
    if (r.from !== me.code) who.style.color = colorFor(r.from);
    q.style.borderColor = r.from === me.code ? '' : colorFor(r.from);
    const text = orig && orig.deleted ? '🚫 Diese Nachricht wurde gelöscht' : orig ? snippet(preview(orig)) : r.text || 'Nachricht';
    q.append(who, el('div', 'quote-text', text));
    q.onclick = (e) => {
      e.stopPropagation();
      const target = $('messages').querySelector(`[data-id="${CSS.escape(r.id)}"]`);
      if (!target) { toast('Originalnachricht nicht mehr vorhanden'); return; }
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
    };
    return q;
  }

  // Reaktionen unter einer Nachricht: gleiche Emojis zusammengefasst
  function reactionsEl(chatId, m) {
    const by = {};
    Object.entries(m.reactions).forEach(([code, e]) => { (by[e] = by[e] || []).push(code); });
    const row = el('div', 'reacts');
    Object.entries(by).sort((a, b) => b[1].length - a[1].length).forEach(([e, codes]) => {
      const mine = codes.includes(me.code);
      const chip = el('button', 'react-chip' + (mine ? ' mine' : ''), codes.length > 1 ? `${e} ${codes.length}` : e);
      chip.type = 'button';
      chip.title = codes.map((c) => (c === me.code ? 'Du' : nameOf(c))).join(', ') + (mine ? ' · Klicken zum Entfernen' : '');
      chip.onclick = (ev) => { ev.stopPropagation(); setReaction(chatId, m, mine ? '' : e); };
      row.appendChild(chip);
    });
    return row;
  }

  // ---- Menü: Rechtsklick (PC) oder lange gedrückt halten (Handy) ----
  let menuOpenedAt = 0;
  function attachMsgMenu(div, chatId, m) {
    let timer = null, start = null, fired = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    div.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      cancel();
      if (Date.now() - menuOpenedAt > 500) openMsgMenu(chatId, m, div, e.clientX, e.clientY);
    });
    div.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      fired = false;
      start = { x: e.clientX, y: e.clientY };
      cancel();
      timer = setTimeout(() => {
        timer = null; fired = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openMsgMenu(chatId, m, div, start.x, start.y);
      }, 450);
    });
    div.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => div.addEventListener(t, cancel));
    // Nach langem Drücken nicht zusätzlich das Bild öffnen o. Ä.
    div.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  }

  function closeMsgMenu() {
    const b = $('msgMenuBack');
    if (b) b.remove();
    document.querySelectorAll('.msg.menu-on').forEach((x) => x.classList.remove('menu-on'));
  }

  function openMsgMenu(chatId, m, div, x, y) {
    closeMsgMenu();
    menuOpenedAt = Date.now();
    const back = el('div', 'msg-menu-back');
    back.id = 'msgMenuBack';
    const menu = el('div', 'msg-menu');
    back.appendChild(menu);
    div.classList.add('menu-on');
    // Klicks direkt nach dem Öffnen (Loslassen des Fingers) ignorieren
    back.addEventListener('click', (e) => { if (Date.now() - menuOpenedAt < 350) return; if (e.target === back) closeMsgMenu(); });
    back.addEventListener('contextmenu', (e) => { e.preventDefault(); closeMsgMenu(); });

    const act = (label, icon, fn, cls = '') => {
      const b = el('button', 'menu-item ' + cls);
      b.type = 'button';
      b.append(el('span', 'menu-ic', icon), el('span', '', label));
      b.onclick = (e) => { e.stopPropagation(); if (Date.now() - menuOpenedAt < 350) return; fn(); };
      return b;
    };

    const drawMain = () => {
      menu.replaceChildren();
      if (!m.deleted) {
        const bar = el('div', 'react-bar');
        const mineR = m.reactions && m.reactions[me.code];
        QUICK_REACTIONS.forEach((e) => {
          const b = el('button', 'react-pick' + (mineR === e ? ' active' : ''), e);
          b.type = 'button';
          b.title = mineR === e ? 'Reaktion entfernen' : 'Reagieren';
          b.onclick = (ev) => { ev.stopPropagation(); if (Date.now() - menuOpenedAt < 350) return; setReaction(chatId, m, e); closeMsgMenu(); };
          bar.appendChild(b);
        });
        const plus = el('button', 'react-pick react-plus', '＋');
        plus.type = 'button';
        plus.title = 'Weitere Emojis';
        plus.onclick = (ev) => { ev.stopPropagation(); if (Date.now() - menuOpenedAt < 350) return; drawMore(); };
        bar.appendChild(plus);
        menu.appendChild(bar);
        menu.appendChild(act('Antworten', '↩️', () => { closeMsgMenu(); startReply(chatId, m); }));
        if (m.text) menu.appendChild(act('Kopieren', '📋', async () => {
          closeMsgMenu();
          try { await navigator.clipboard.writeText(m.text); toast('Text kopiert'); } catch { toast('Kopieren fehlgeschlagen'); }
        }));
      }
      menu.appendChild(act('Löschen', '🗑️', drawDelete, 'danger'));
      place();
    };
    const drawMore = () => {
      menu.replaceChildren();
      const grid = el('div', 'react-grid');
      const all = [...new Set([...recentEmojis, ...Object.values(window.CHATBOX_EMOJIS).join(' ').split(' ')])].filter(validEmoji);
      all.forEach((e) => {
        const b = el('button', 'react-pick', e);
        b.type = 'button';
        b.onclick = (ev) => { ev.stopPropagation(); setReaction(chatId, m, e); closeMsgMenu(); };
        grid.appendChild(b);
      });
      menu.appendChild(grid);
      place();
    };
    const drawDelete = () => {
      menu.replaceChildren();
      menu.appendChild(el('div', 'menu-title', 'Nachricht löschen?'));
      const canAll = m.from === me.code && !m.deleted;
      if (canAll) menu.appendChild(act('Für alle löschen', '🗑️', () => { closeMsgMenu(); deleteForAll(chatId, m); }, 'danger'));
      menu.appendChild(act('Für mich löschen', '🙈', () => { closeMsgMenu(); deleteForMe(chatId, m); }, canAll ? '' : 'danger'));
      menu.appendChild(act('Abbrechen', '✕', drawMain));
      place();
    };
    // Menü neben dem Finger/Mauszeiger, aber immer ganz im Fenster
    const place = () => {
      const pad = 8, w = menu.offsetWidth, h = menu.offsetHeight;
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = Math.min(Math.max(pad, x - w / 2), vw - w - pad);
      let top = y + 12;
      if (top + h > vh - pad) top = Math.max(pad, y - h - 12);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    };

    document.body.appendChild(back);
    drawMain();
  }

  function systemMessage(chatId, text) {
    (chats[chatId] = chats[chatId] || []).push({ id: crypto.randomUUID(), sys: true, text, ts: Date.now() });
    saveChat(chatId);
  }

  function touchDay() {
    const today = dayStr(new Date());
    if (stats.lastDay === today) return;
    const y = new Date(); y.setDate(y.getDate() - 1);
    stats.streak = stats.lastDay === dayStr(y) ? stats.streak + 1 : 1;
    stats.maxStreak = Math.max(stats.maxStreak, stats.streak);
    stats.days++;
    stats.lastDay = today;
  }

  // ================= Gruppen =================
  function groupNames(members) {
    const n = {};
    members.forEach((c) => { n[c] = nameOf(c); });
    return n;
  }

  function broadcastGroup(g) {
    g.names = groupNames(g.members);
    others(g).forEach((c) => { if (!sendData(c, { type: 'group', group: g })) connectTo(c); });
  }

  function createGroup(name, members) {
    const g = {
      id: crypto.randomUUID(), name: clean(name, 40) || 'Gruppe', owner: me.code,
      members: [me.code, ...members], names: {}, updated: Date.now(), avatar: null, desc: '', by: me.code,
    };
    groups[g.id] = g;
    systemMessage('g:' + g.id, 'Du hast die Gruppe erstellt');
    stats.groupsCreated++;
    broadcastGroup(g);
    saveMeta(); checkAchievements();
    openChat('g:' + g.id);
  }

  function addToGroup(g, codes) {
    codes.forEach((c) => { if (!g.members.includes(c)) { g.members.push(c); systemMessage('g:' + g.id, `${nameOf(c)} wurde hinzugefügt`); } });
    g.updated = Date.now();
    g.by = me.code;
    broadcastGroup(g);
    saveMeta(); scheduleRender();
  }

  // Name, Beschreibung und Gruppenbild ändern (jedes Mitglied darf das)
  function updateGroup(g, ch) {
    const msgs = [];
    if (ch.name !== undefined) {
      const n = clean(ch.name, 40);
      if (n && n !== g.name) { g.name = n; msgs.push(`Du hast die Gruppe in „${n}“ umbenannt`); }
    }
    if (ch.desc !== undefined) {
      const d = clean(ch.desc, 200);
      if (d !== (g.desc || '')) { g.desc = d; msgs.push(d ? 'Du hast die Beschreibung geändert' : 'Du hast die Beschreibung entfernt'); }
    }
    if (ch.avatar !== undefined && ch.avatar !== (g.avatar || null)) {
      g.avatar = ch.avatar;
      msgs.push(ch.avatar ? 'Du hast das Gruppenbild geändert' : 'Du hast das Gruppenbild entfernt');
    }
    if (!msgs.length) return false;
    msgs.forEach((m) => systemMessage('g:' + g.id, m));
    g.updated = Date.now();
    g.by = me.code;
    broadcastGroup(g);
    saveMeta(); scheduleRender();
    return true;
  }

  function leaveGroup(g) {
    others(g).forEach((c) => sendData(c, { type: 'gleave', gid: g.id }));
    leftGroups.push(g.id);
    delete groups[g.id];
    deleteChatData('g:' + g.id);
    saveMeta();
    closeChat();
  }

  function removeFriend(code) {
    const c = contacts[code];
    if (!c) return;
    c.friend = false;
    if (!blocked.includes(code)) blocked.push(code);
    deleteChatData('u:' + code);
    if (!sharesGroup(code)) delete contacts[code];
    if (conns[code]) conns[code].close();
    saveMeta();
    closeChat();
  }

  // ================= Erfolge =================
  const ACH = window.CHATBOX_ACHIEVEMENTS;
  function statValue(key) {
    if (key === 'friends') return friendCodes().length;
    if (key === 'unlockedOthers') return ACH.filter((a) => a.id !== 'all' && unlocked[a.id]).length;
    return stats[key] || 0;
  }
  function checkAchievements() {
    let changed = true, newOnes = false;
    while (changed) {
      changed = false;
      for (const a of ACH) {
        if (!unlocked[a.id] && statValue(a.stat) >= a.goal) {
          unlocked[a.id] = Date.now();
          changed = true;
          toast(`${a.icon} Erfolg freigeschaltet: ${a.title}`, true);
          newOnes = true;
        }
      }
    }
    saveMeta();
    if (newOnes) {
      relay.reportAchievements();
      broadcastProfile(); // Freunde sehen den neuen Erfolg in deinem Profil
    }
  }

  // Erfolge eines Kontakts nach Seltenheit sortieren: wenigste Besitzer zuerst
  function rarestFirst(ids, counts) {
    const order = new Map(ACH.map((a, i) => [a.id, i]));
    return ids.map((id) => ACH.find((a) => a.id === id)).filter(Boolean)
      .map((a) => ({ a, n: Math.max(1, counts[a.id] || 0) })) // der Besitzer selbst zählt immer mit
      .sort((x, y) => x.n - y.n || y.a.goal - x.a.goal || order.get(x.a.id) - order.get(y.a.id));
  }
  const ownersText = (n) => (n === 1 ? '1 Person auf der Welt besitzt dieses Achievement' : `${n.toLocaleString('de-DE')} Personen auf der Welt besitzen dieses Achievement`);

  // Abschnitt „Seltenste Erfolge“ im Profil: zuerst 3, mit „Weitere anzeigen“ alle
  function rareAchievementsEl(ids) {
    const wrap = el('div', 'rare-ach');
    wrap.appendChild(el('div', 'rare-ach-title', 'Seltenste Erfolge'));
    const ul = el('ul', 'ach-list rare-list');
    const more = el('button', 'link rare-more', '');
    more.type = 'button';
    wrap.append(ul, more);
    let expanded = false;
    let rows = rarestFirst(ids, {});
    let state = 'loading'; // 'loading' | 'ok' | 'error'
    const draw = () => {
      ul.replaceChildren();
      (expanded ? rows : rows.slice(0, 3)).forEach(({ a, n }) => {
        const li = el('li', 'got');
        li.appendChild(el('span', 'ach-icon', a.icon));
        const body = el('div', 'fmeta');
        body.appendChild(el('div', 'fname', a.title));
        body.appendChild(el('div', 'flast', a.desc));
        body.appendChild(el('div', 'rare-count', state === 'ok' ? ownersText(n) : state === 'loading' ? 'Wird geladen…' : 'Seltenheit gerade nicht verfügbar'));
        li.appendChild(body);
        ul.appendChild(li);
      });
      more.classList.toggle('hidden', rows.length <= 3);
      more.textContent = expanded ? 'Weniger anzeigen' : `Weitere anzeigen (${rows.length - 3})`;
    };
    more.onclick = () => { expanded = !expanded; draw(); };
    draw();
    relay.achStats().then((s) => {
      if (s) { rows = rarestFirst(ids, s.counts); state = 'ok'; } else state = 'error';
      draw();
    });
    return wrap;
  }

  // ================= Bilder =================
  const readAsDataURL = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
  const loadImg = (src) => new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('Das Bild konnte nicht gelesen werden.'));
    i.src = src;
  });

  async function prepareImage(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Nur Bilder und GIFs können gesendet werden.');
    const url = await readAsDataURL(file);
    const img = await loadImg(url);
    if (file.type === 'image/gif') {
      if (url.length > MAX_MEDIA) throw new Error(`Das GIF ist zu groß (max. ${MAX_MB} MB).`);
      return { kind: 'gif', data: url, w: img.naturalWidth, h: img.naturalHeight };
    }
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    const data = cv.toDataURL('image/webp', 0.85);
    if (data.length > MAX_MEDIA) throw new Error('Das Bild ist zu groß.');
    return { kind: 'image', data, w, h };
  }

  async function prepareAvatar(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Bitte wähle ein Bild aus.');
    const img = await loadImg(await readAsDataURL(file));
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const cv = document.createElement('canvas');
    cv.width = cv.height = 192;
    cv.getContext('2d').drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, 192, 192);
    return cv.toDataURL('image/webp', 0.85);
  }

  async function sendImageFile(file) {
    if (!activeChat || !file) return;
    try {
      toast('📤 Bild wird vorbereitet…');
      const media = await prepareImage(file);
      const caption = $('msgInput').value.trim();
      $('msgInput').value = '';
      await sendMessage(activeChat, caption, media);
    } catch (e) {
      toast('⚠️ ' + e.message);
    }
  }

  // ================= Benachrichtigungen & Toasts =================
  // Windows-Benachrichtigung (wie Teams/Discord). Ist das Fenster aktiv, reicht ein kleiner Hinweis in der App.
  function notify(title, body, opts = {}) {
    const focused = document.hasFocus();
    if (!focused) window.chatboxWindow.flash();
    if (!settings.notify) return;
    if (focused) {
      if (opts.chatId && opts.chatId !== activeChat) toast(`${title}: ${String(body).slice(0, 60)}`);
      return;
    }
    const send = (icon) => window.chatboxWindow.notify({
      title,
      body: opts.chatId && !settings.preview ? 'Neue Nachricht' : String(body).slice(0, 200),
      icon,
      chatId: opts.chatId || null,
      replyPlaceholder: opts.replyPlaceholder || null,
      silent: !settings.sound,
    });
    if (!opts.icon) send(null);
    else toPng(opts.icon).then(send, () => send(null));
  }

  // Profilbilder sind WebP – Windows-Benachrichtigungen brauchen PNG
  const pngCache = new Map();
  function toPng(src) {
    if (src.startsWith('data:image/png')) return Promise.resolve(src);
    if (pngCache.has(src)) return Promise.resolve(pngCache.get(src));
    return loadImg(src).then((img) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      cv.getContext('2d').drawImage(img, 0, 0, 128, 128);
      const png = cv.toDataURL('image/png');
      if (pngCache.size > 50) pngCache.clear();
      pngCache.set(src, png);
      return png;
    });
  }

  // Roter Zähler am Taskleisten-Icon
  let lastBadge = -1;
  function updateBadge() {
    const n = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
    if (n === lastBadge) return;
    lastBadge = n;
    if (!n) { window.chatboxWindow.setBadge(0, null); return; }
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const g = cv.getContext('2d');
    g.fillStyle = '#e5484d';
    g.beginPath(); g.arc(16, 16, 16, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff';
    g.font = `bold ${n > 9 ? 16 : 20}px "Segoe UI", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(n > 9 ? '9+' : String(n), 16, 17);
    window.chatboxWindow.setBadge(n, cv.toDataURL('image/png'));
  }

  window.chatboxWindow.onNotificationClick((chatId) => {
    if (!me) return;
    const ok = chatId.startsWith('g:') ? groups[chatId.slice(2)] : contacts[chatId.slice(2)];
    if (ok) openChat(chatId);
  });
  // Antwort direkt aus der Windows-Benachrichtigung
  window.chatboxWindow.onNotificationReply((chatId, text) => {
    if (!me || typeof chatId !== 'string' || typeof text !== 'string') return;
    const exists = chatId.startsWith('g:') ? groups[chatId.slice(2)] : chatId.startsWith('u:') && contacts[chatId.slice(2)];
    text = text.trim().slice(0, MAX_TEXT);
    if (!exists || !text) return;
    delete unread[chatId];
    sendMessage(chatId, text, null);
  });
  window.chatboxWindow.onHidden(() => {
    if (settings.bgHintShown) return;
    settings.bgHintShown = true; saveSettings();
    window.chatboxWindow.notify({ title: 'WhatsUp läuft im Hintergrund weiter', body: 'So verpasst du keine Nachrichten. Zum Öffnen oder Beenden klicke auf das WhatsUp-Symbol unten rechts in der Taskleiste.', silent: true });
  });
  const sendPrefs = () => window.chatboxWindow.setPrefs({ runInBackground: settings.runInBackground, openAtLogin: settings.openAtLogin, popupNotify: settings.popupNotify, theme: settings.theme });

  const toastQueue = [];
  let toastBusy = false;
  function toast(text, gold) {
    toastQueue.push({ text, gold });
    while (toastQueue.length > 3) toastQueue.shift();
    if (!toastBusy) nextToast();
  }
  function nextToast() {
    const t = toastQueue.shift();
    const box = $('toast');
    if (!t) { toastBusy = false; box.classList.add('hidden'); return; }
    toastBusy = true;
    box.textContent = t.text;
    box.classList.toggle('gold', !!t.gold);
    box.classList.remove('hidden');
    setTimeout(nextToast, t.gold ? 2600 : 1600);
  }

  // ================= UI =================
  const colors = ['#5b8cff', '#ff7a59', '#3ecf8e', '#c06cff', '#ffb547', '#ff5b9e', '#2ec4d6'];
  const colorFor = (seed) => colors[[...String(seed)].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  const durText = (s) => { s = Math.round(s || 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const preview = (m) => (m.deleted ? '🚫 Diese Nachricht wurde gelöscht' : m.media
    ? (m.media.kind === 'sticker' ? '🩷 Sticker' : m.media.kind === 'audio' ? '🎤 Sprachnachricht (' + durText(m.media.dur) + ')' : m.media.kind === 'video' ? '🎥 Video (' + durText(m.media.dur) + ')' : m.media.kind === 'gif' ? '🎞️ GIF' : '📷 Bild') + (m.text ? ' ' + m.text : '')
    : m.text);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const FRAMES = window.WHATSUP_FRAMES;
  const validFrame = (f) => (typeof f === 'string' && Object.prototype.hasOwnProperty.call(FRAMES, f) ? f : null);
  const BANNERS = window.WHATSUP_BANNERS;
  const validBanner = (b) => (typeof b === 'string' && Object.prototype.hasOwnProperty.call(BANNERS, b) ? b : null);

  // Einlöse-Codes (Liste mit allen Codes: CODES.md im Repo). Groß/klein, Leerzeichen und Bindestriche egal.
  const REDEEM_CODES = {
    FLAMMENMEER: ['frame:flames'],
    MILCHSTRASSE: ['frame:galaxy'],
    SIEGERKRANZ: ['frame:laurel'],
    REGENBOGEN: ['frame:rainbow'],
    DIAMANTEN: ['frame:diamond'],
    ABENDROT: ['banner:sunset'],
    TIEFSEE: ['banner:ocean'],
    NEONNACHT: ['banner:neon'],
    GOLDRAUSCH: ['banner:gold'],
    STERNENSTAUB: ['banner:galaxy'],
    WHATSUPVIP: [...Object.keys(FRAMES).filter((f) => FRAMES[f].locked).map((f) => 'frame:' + f), ...Object.keys(BANNERS).map((b) => 'banner:' + b)],
  };
  let redeemed = store.load('redeemed', []);
  const rewards = () => new Set(redeemed.flatMap((c) => REDEEM_CODES[c] || []));
  const frameLocked = (id) => !!(id && FRAMES[id] && FRAMES[id].locked && !rewards().has('frame:' + id));
  const bannerLocked = (id) => !!(id && !rewards().has('banner:' + id));
  const rewardName = (r) => { const [k, id] = r.split(':'); return k === 'frame' ? `Rahmen „${FRAMES[id].name}“` : `Banner „${BANNERS[id].name}“`; };
  function redeemCode(input) {
    const code = String(input || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜ]/g, '');
    if (!code) return { ok: false, text: 'Bitte gib einen Code ein.' };
    const list = REDEEM_CODES[code];
    if (!list) return { ok: false, text: 'Diesen Code gibt es nicht.' };
    if (redeemed.includes(code)) return { ok: false, text: 'Diesen Code hast du schon eingelöst.' };
    const before = rewards();
    redeemed.push(code);
    store.save('redeemed', redeemed);
    const fresh = list.filter((r) => !before.has(r));
    if (!fresh.length) return { ok: true, text: 'Eingelöst – du hattest schon alles davon.' };
    return { ok: true, text: (fresh.length > 2 ? fresh.length + ' Belohnungen' : fresh.map(rewardName).join(' und ')) + ' freigeschaltet! Auswählen unter Du → Profil.' };
  }
  // Status als farbiges Banner
  function bannerEl(text, banner, pill) {
    const b = el(pill ? 'span' : 'div', pill ? 'banner-pill' : 'banner', text);
    b.style.background = BANNERS[banner].bg;
    return b;
  }

  function avatarEl(name, avatar, seed, cls, online, frame) {
    const a = el('span', 'avatar' + (cls ? ' ' + cls : ''));
    if (validFrame(frame)) {
      // SVG stammt nur aus der eigenen, festen Liste in frames.js
      const f = el('span', 'frame');
      f.innerHTML = `<svg viewBox="0 0 120 120" aria-hidden="true">${FRAMES[frame].svg}</svg>`;
      a.appendChild(f);
      a.classList.add('framed');
    }
    if (avatar) {
      const i = document.createElement('img');
      i.src = avatar; i.alt = '';
      a.appendChild(i);
    } else {
      a.appendChild(document.createTextNode(([...(name || '?').trim()][0] || '?').toUpperCase()));
      a.classList.add('initial');
    }
    if (online != null) a.appendChild(el('span', 'dot' + (online ? ' on' : '')));
    return a;
  }

  function chatAvatar(chatId, cls, withDot) {
    if (chatId.startsWith('g:')) {
      const g = groups[chatId.slice(2)];
      return avatarEl(g ? g.name : '?', g && g.avatar, chatId, 'sq ' + (cls || ''));
    }
    const code = chatId.slice(2), c = contacts[code] || {};
    return avatarEl(c.name, c.avatar, code, cls, withDot ? isOnline(code) : null, c.frame);
  }

  function setNet(on) { $('netDot').classList.toggle('on', on); }
  function setStatus(text, err) { const s = $('addStatus'); s.textContent = text; s.classList.toggle('err', !!err); }

  let view = 'viewSetup';
  let activeChat = null;
  const TITLES = { viewList: 'WhatsUp', viewChat: 'WhatsUp', viewSettings: 'Einstellungen', viewAchievements: 'Erfolge', viewSetup: 'WhatsUp', viewStatus: 'Status', viewReels: 'UpReels' };
  const TABS = ['viewStatus', 'viewReels', 'viewList', 'viewSettings'];
  let lastTab = 'viewList';

  function show(v) {
    view = v;
    if (TABS.includes(v)) lastTab = v;
    ['viewSetup', 'viewList', 'viewChat', 'viewSettings', 'viewAchievements', 'viewStatus', 'viewReels'].forEach((x) => $(x).classList.toggle('hidden', x !== v));
    if (v !== 'viewReels') { reels.pauseAll(); reels.closeSheet(); }
    document.documentElement.classList.toggle('in-reels', v === 'viewReels');
    $('tabbar').classList.toggle('hidden', !TABS.includes(v));
    document.querySelectorAll('#tabbar .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === v));
    $('backBtn').classList.toggle('hidden', TABS.includes(v) || v === 'viewSetup');
    $('trophyBtn').classList.toggle('hidden', v === 'viewSetup');
    $('trophyBtn').classList.toggle('active', v === 'viewAchievements');
    $('titleText').textContent = TITLES[v];
    hideEmoji();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => { renderQueued = false; render(); }, 16);
  }

  function render() {
    if (!me) return;
    updateBadge();
    renderList();
    renderTabs();
    if (view === 'viewStatus') stories.renderList();
    if (view === 'viewChat') renderChat();
    if (view === 'viewAchievements') renderAchievements();
  }

  // Leiste unten: ungelesene Chats, neue Status, eigenes Profilbild
  function renderTabs() {
    const n = Object.values(unread).reduce((a, b) => a + (b || 0), 0);
    $('chatsBadge').textContent = n > 99 ? '99+' : String(n);
    $('chatsBadge').classList.toggle('hidden', !n);
    $('statusDot').classList.toggle('hidden', !stories.unseenCount());
    const key = [me.name, me.avatar, me.code].join('|');
    if ($('tabMeAvatar').dataset.key !== key) {
      $('tabMeAvatar').dataset.key = key;
      $('tabMeAvatar').replaceChildren(avatarEl(me.name, me.avatar, me.code));
    }
  }
  document.querySelectorAll('#tabbar .tab').forEach((t) => {
    t.onclick = () => {
      const v = t.dataset.tab;
      if (v === 'viewSettings') { if (view !== 'viewSettings') openSettings(); return; }
      show(v); render();
      if (v === 'viewReels') reels.openFeed();
    };
  });

  const lastMsg = (chatId) => { const l = chats[chatId]; return l && l.length ? l[l.length - 1] : null; };

  function renderList() {
    const meAv = $('meAvatar');
    meAv.replaceChildren(avatarEl(me.name, me.avatar, me.code, '', null, me.frame));
    $('meName').textContent = me.name;
    $('myCode').textContent = me.code;

    const items = [
      ...friendCodes().map((c) => 'u:' + c),
      ...Object.keys(groups).map((g) => 'g:' + g),
    ].sort((a, b) => ((lastMsg(b) || {}).ts || 0) - ((lastMsg(a) || {}).ts || 0));

    const ul = $('chatList');
    ul.replaceChildren();
    $('emptyList').classList.toggle('hidden', items.length > 0);
    items.forEach((chatId) => {
      const isGroup = chatId.startsWith('g:');
      const code = chatId.slice(2);
      const li = el('li');
      li.appendChild(chatAvatar(chatId, '', !isGroup));
      const meta = el('div', 'fmeta');
      const fn = el('div', 'fname', isGroup ? groups[code].name : nameOf(code));
      const fb = isGroup ? '' : fire.badge(code);
      if (fb) fn.appendChild(el('span', 'fire', fb));
      meta.appendChild(fn);
      const last = lastMsg(chatId);
      let sub;
      if (last) sub = last.sys ? last.text : (last.from === me.code ? 'Du: ' : isGroup ? nameOf(last.from) + ': ' : '') + preview(last);
      else if (isGroup) sub = `${groups[code].members.length} Mitglieder`;
      else sub = (isOnline(code) ? 'Online' : 'Offline') + (contacts[code].status ? ' · ' + contacts[code].status : '');
      meta.appendChild(el('div', 'flast', sub));
      li.appendChild(meta);
      if (unread[chatId]) li.appendChild(el('span', 'badge', String(unread[chatId])));
      li.onclick = () => openChat(chatId);
      ul.appendChild(li);
    });
  }

  function renderChat() {
    const chatId = activeChat;
    const isGroup = chatId.startsWith('g:');
    const code = chatId.slice(2);
    if (isGroup ? !groups[code] : !contacts[code]) { closeChat(); return; }

    $('chatAvatar').replaceChildren(chatAvatar(chatId, '', !isGroup));
    $('callBtns').classList.toggle('hidden', isGroup); // Anrufe nur im Einzelchat
    if (isGroup) {
      const g = groups[code];
      const on = others(g).filter(isOnline).length;
      $('chatName').textContent = g.name;
      $('chatSub').textContent = `${g.members.length} Mitglieder · ${on} online` + (g.desc ? ' · ' + g.desc.replace(/\s+/g, ' ') : '');
    } else {
      const c = contacts[code];
      $('chatName').textContent = c.name;
      const fb = fire.badge(code);
      if (fb) $('chatName').appendChild(el('span', 'fire', fb));
      $('chatSub').textContent = (isOnline(code) ? 'online' : 'offline') + (c.status && !c.banner ? ' · ' + c.status : '');
      if (c.banner && c.status) { $('chatSub').append(' · '); $('chatSub').appendChild(bannerEl(c.status, c.banner, true)); }
      $('chatName').title = fb ? 'Streak: Schreibt euch jeden Tag beide mindestens eine Nachricht, sonst ist er weg.' : '';
    }

    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.replaceChildren();
    let lastDay = '', lastFrom = null;
    (chats[chatId] || []).forEach((m) => {
      const day = fmtDay(m.ts);
      if (day !== lastDay) { box.appendChild(el('div', 'day', day)); lastDay = day; lastFrom = null; }
      if (m.sys) { box.appendChild(el('div', 'sys', m.text)); lastFrom = null; return; }
      const mine = m.from === me.code;
      if (isGroup && !mine && m.from !== lastFrom) {
        const s = el('div', 'sender', nameOf(m.from));
        s.style.color = colorFor(m.from);
        box.appendChild(s);
      }
      lastFrom = m.from;
      const big = !m.media && !m.reply && !m.deleted && onlyEmoji(m.text);
      const isVoice = m.media && m.media.kind === 'audio';
      const isSticker = m.media && m.media.kind === 'sticker';
      const div = el('div', 'msg ' + (mine ? 'me' : 'them') + (big ? ' big' : '') + (m.deleted ? ' deleted' : '') + (m.reactions && !m.deleted ? ' has-reacts' : '') + (m.reply && !m.deleted ? ' has-quote' : '')
        + (isSticker ? ' sticker' : isVoice ? ' has-voice' : m.media ? ' has-media' : ''));
      div.dataset.id = m.id;
      if (m.reply && !m.deleted) div.appendChild(quoteEl(chatId, m.reply));
      if (m.deleted) div.appendChild(el('div', 'text', mine ? '🚫 Du hast diese Nachricht gelöscht' : '🚫 Diese Nachricht wurde gelöscht'));
      else if (isSticker) div.appendChild(stickers.view(chatId, m));
      else if (isVoice) div.appendChild(voice.el(chatId, m));
      else if (m.media && m.media.kind === 'video') div.appendChild(video.el(chatId, m));
      else if (m.media) div.appendChild(mediaEl(chatId, m));
      if (m.text) div.appendChild(el('div', 'text', m.text));
      let tick = '';
      if (mine && m.to && m.to.length && !m.deleted) {
        tick = m.deliveredTo.length >= m.to.length ? ' ✓✓' : m.deliveredTo.length || m.sentTo.length ? ' ✓' : ' 🕓';
      }
      div.appendChild(el('div', 'meta', fmtTime(m.ts) + tick));
      if (m.reactions && !m.deleted) div.appendChild(reactionsEl(chatId, m));
      attachMsgMenu(div, chatId, m);
      box.appendChild(div);
    });
    if (atBottom || box.dataset.chat !== chatId) box.scrollTop = box.scrollHeight;
    box.dataset.chat = chatId;
  }

  function mediaEl(chatId, m) {
    const img = document.createElement('img');
    img.className = 'media';
    img.alt = m.media.kind === 'gif' ? 'GIF' : 'Bild';
    const w = Math.min(220, m.media.w);
    img.style.width = w + 'px';
    img.style.aspectRatio = `${m.media.w} / ${m.media.h}`;
    const k = mediaKey(chatId, m.id);
    if (mediaCache.has(k)) img.src = mediaCache.get(k);
    else getMedia(chatId, m.id).then((d) => { if (d) img.src = d; });
    img.onclick = () => openViewer(img.src, m);
    return img;
  }

  function renderAchievements() {
    const done = ACH.filter((a) => unlocked[a.id]).length;
    $('achCount').textContent = done;
    $('achTotal').textContent = ACH.length;
    $('achBar').style.width = (done / ACH.length) * 100 + '%';
    const ul = $('achList');
    ul.replaceChildren();
    [...ACH].sort((a, b) => (unlocked[b.id] ? 1 : 0) - (unlocked[a.id] ? 1 : 0)).forEach((a) => {
      const got = !!unlocked[a.id];
      const li = el('li', got ? 'got' : '');
      li.appendChild(el('span', 'ach-icon', a.icon));
      const body = el('div', 'fmeta');
      body.appendChild(el('div', 'fname', a.title));
      const v = Math.min(statValue(a.stat), a.goal);
      const extra = got ? new Date(unlocked[a.id]).toLocaleDateString('de-DE') : a.goal > 1 ? `${v}/${a.goal}` : '';
      body.appendChild(el('div', 'flast', a.desc + (extra ? ' · ' + extra : '')));
      li.appendChild(body);
      ul.appendChild(li);
    });
  }

  // ================= Navigation =================
  function openChat(chatId) {
    if (activeChat !== chatId) { voice.stop(false); voice.stopPlayback(); clearReply(); closeMsgMenu(); video.close(); video.closePlayer(); }
    activeChat = chatId;
    setTimeout(() => voice.syncComposer(), 0);
    delete unread[chatId];
    saveMeta();
    show('viewChat');
    render();
    recipientsOf(chatId).forEach(connectTo);
    // Nur mit Maus/Tastatur automatisch ins Eingabefeld – auf dem Handy würde sonst die Tastatur aufspringen
    if (!window.matchMedia('(pointer: coarse)').matches) $('msgInput').focus();
  }

  function closeChat() {
    voice.stop(false);
    voice.stopPlayback();
    activeChat = null;
    clearReply(); closeMsgMenu(); video.close(); video.closePlayer();
    closeModal();
    show('viewList');
    render();
  }

  // ================= Modals =================
  function openModal(build) {
    const box = $('modalBox');
    box.replaceChildren();
    delete box.dataset.owner;
    build(box);
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }

  function checkList(codes) {
    const ul = el('ul', 'checklist');
    codes.forEach((c) => {
      const li = el('li');
      const lab = el('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.value = c;
      lab.append(cb, avatarEl(nameOf(c), contacts[c] && contacts[c].avatar, c, 'sm', null, contacts[c] && contacts[c].frame), el('span', '', nameOf(c)));
      li.appendChild(lab);
      ul.appendChild(li);
    });
    ul.selected = () => [...ul.querySelectorAll('input:checked')].map((i) => i.value);
    return ul;
  }

  function buttons(...defs) {
    const row = el('div', 'modal-actions');
    defs.forEach(([label, cls, fn]) => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; row.appendChild(b); });
    return row;
  }

  function openNewGroup() {
    const friends = friendCodes();
    openModal((box) => {
      box.appendChild(el('h3', '', 'Neue Gruppe'));
      if (!friends.length) {
        box.appendChild(el('p', 'muted', 'Füge zuerst Freunde per Code hinzu, dann kannst du eine Gruppe erstellen.'));
        box.appendChild(buttons(['OK', 'primary', closeModal]));
        return;
      }
      const name = el('input');
      name.placeholder = 'Gruppenname'; name.maxLength = 40;
      box.appendChild(name);
      box.appendChild(el('div', 'label', 'Mitglieder auswählen'));
      const list = checkList(friends);
      box.appendChild(list);
      const err = el('div', 'status err');
      box.appendChild(err);
      box.appendChild(buttons(['Abbrechen', 'ghost', closeModal], ['Erstellen', 'primary', () => {
        const sel = list.selected();
        if (!name.value.trim()) { err.textContent = 'Gib der Gruppe einen Namen.'; name.focus(); return; }
        if (!sel.length) { err.textContent = 'Wähle mindestens einen Freund aus.'; return; }
        closeModal();
        createGroup(name.value, sel);
      }]));
      setTimeout(() => name.focus(), 0);
    });
  }

  // Zeile „Chatverlauf · 12,3 MB  Leeren“ für die Chat-Infos
  function clearRow(chatId) {
    const row = el('div', 'setting clear-row');
    const label = el('span', '', 'Chatverlauf');
    const size = el('span', 'muted', ' · wird berechnet…');
    label.appendChild(size);
    const btn = el('button', 'link danger-link', 'Leeren');
    btn.type = 'button';
    btn.id = 'clearChatBtn';
    row.append(label, btn);
    chatSize(chatId).then((b) => { size.textContent = ` · ${fmtBytes(b)}`; });
    btn.onclick = async () => {
      if (!confirm('Alle Nachrichten, Bilder und GIFs in diesem Chat auf diesem Gerät löschen? Das kann nicht rückgängig gemacht werden. Bei den anderen bleibt der Chat erhalten.')) return;
      await clearChat(chatId);
      size.textContent = ' · leer';
      toast('Chat geleert');
    };
    return row;
  }

  // Profil eines beliebigen Nutzers (z. B. aus UpReels) – aufgebaut wie die Chat-Info
  function openProfile(code, name) {
    const c = contacts[code];
    const mine = code === me.code;
    const shownName = mine ? me.name : (c && !/^Nutzer /.test(c.name) ? c.name : name) || code;
    reels.pauseAll();
    openModal((box) => {
      const head = el('div', 'info-head');
      const av = mine ? me.avatar : c && c.avatar;
      const fr = mine ? me.frame : c && c.frame;
      head.appendChild(avatarEl(shownName, av, code, 'xl', c && c.friend ? isOnline(code) : null, fr));
      head.appendChild(el('h3', '', mine ? `${shownName} (Du)` : shownName));
      const banner = mine ? validBanner(me.banner) : c && c.banner;
      const status = mine ? me.status : c && c.status;
      if (banner) head.appendChild(bannerEl(status || shownName, banner));
      else if (status) head.appendChild(el('div', 'muted', status));
      head.appendChild(el('div', 'muted', `Code: ${code}` + (c && c.friend ? ` · ${isOnline(code) ? 'online' : 'offline'}` : '')));
      const pill = el('div', 'pill hidden');
      head.appendChild(pill);
      box.appendChild(head);
      // Erfolge: eigene, von Freunden direkt, sonst vom Server
      const achWrap = el('div');
      box.appendChild(achWrap);
      const showAch = (ids) => {
        ids = (ids || []).filter((id) => ACH.some((a) => a.id === id));
        pill.textContent = `🏆 ${ids.length} ${ids.length === 1 ? "Erfolg" : "Erfolge"}`;
        pill.classList.toggle('hidden', !ids.length);
        achWrap.replaceChildren(ids.length ? rareAchievementsEl(ids) : el('div', 'muted center', 'Noch keine Erfolge bekannt.'));
      };
      if (mine) showAch(Object.keys(unlocked));
      else if (c && c.ach && c.ach.length) showAch(c.ach);
      else {
        achWrap.appendChild(el('div', 'muted center', 'Erfolge werden geladen…'));
        fetch(`${relay.url()}/v1/achuser/${code}`).then((r) => r.json()).then((d) => showAch(d.ach)).catch(() => showAch([]));
      }
      box.appendChild(reels.profileSection(code, shownName));
      const btns = [];
      if (!mine && c && c.friend) btns.push(['Chat öffnen', 'ghost', () => { closeModal(); openChat('u:' + code); }]);
      else if (!mine && !blocked.includes(code)) btns.push(['Als Freund hinzufügen', 'ghost', () => {
        closeModal();
        $('addInput').value = code;
        $('addForm').requestSubmit();
        toast(`🤝 Anfrage an ${shownName} gesendet`);
      }]);
      btns.push(['Schließen', 'primary', closeModal]);
      box.appendChild(buttons(...btns));
    });
    // Nach dem Schließen läuft das Reel weiter
    const obs = new MutationObserver(() => { if ($('modal').classList.contains('hidden')) { obs.disconnect(); if (view === 'viewReels') reels.playVisible(); } });
    obs.observe($('modal'), { attributes: true, attributeFilter: ['class'] });
  }

  function openInfo() {
    if (!activeChat) return;
    const code = activeChat.slice(2);
    if (activeChat.startsWith('u:')) {
      const c = contacts[code];
      openModal((box) => {
        const head = el('div', 'info-head');
        head.appendChild(avatarEl(c.name, c.avatar, code, 'xl', isOnline(code), c.frame));
        head.appendChild(el('h3', '', c.name));
        if (c.banner) head.appendChild(bannerEl(c.status || c.name, c.banner));
        else if (c.status) head.appendChild(el('div', 'muted', c.status));
        head.appendChild(el('div', 'muted', `Code: ${code} · ${isOnline(code) ? 'online' : 'offline'}`));
        if (c.badges) head.appendChild(el('div', 'pill', `🏆 ${c.badges} ${c.badges === 1 ? "Erfolg" : "Erfolge"}`));
        box.appendChild(head);
        if (c.ach && c.ach.length) box.appendChild(rareAchievementsEl(c.ach));
        box.appendChild(reels.profileSection(code, c.name));
        box.appendChild(clearRow(activeChat));
        box.appendChild(buttons(['Freund entfernen', 'danger', () => {
          if (confirm(`${c.name} entfernen? Der Chatverlauf wird gelöscht. ${c.name} kann dich erst wieder erreichen, wenn du den Code erneut addest.`)) removeFriend(code);
        }], ['Schließen', 'primary', closeModal]));
      });
      return;
    }
    const g = groups[code];
    openModal((box) => {
      let draftAv = g.avatar || null;
      const head = el('div', 'info-head');
      const avWrap = el('div', 'group-av');
      const drawAv = () => avWrap.replaceChildren(avatarEl(nameIn.value || g.name, draftAv, activeChat, 'sq xl'));
      head.appendChild(avWrap);
      const avRow = el('div', 'row center');
      const change = el('button', 'link', 'Bild ändern');
      const remove = el('button', 'link muted-link', 'Entfernen');
      change.type = remove.type = 'button';
      avRow.append(change, remove);
      head.appendChild(avRow);
      box.appendChild(head);

      const nameField = el('label', 'field', 'Name');
      const nameIn = el('input');
      nameIn.value = g.name; nameIn.maxLength = 40; nameIn.id = 'groupNameIn';
      nameField.appendChild(nameIn);
      const descField = el('label', 'field', 'Beschreibung');
      const descIn = el('textarea');
      descIn.value = g.desc || ''; descIn.maxLength = 200; descIn.rows = 3; descIn.id = 'groupDescIn';
      descIn.placeholder = 'Worum geht es in der Gruppe?';
      descField.appendChild(descIn);
      box.append(nameField, descField);
      drawAv();

      const input = $('groupAvatarInput');
      change.onclick = () => input.click();
      remove.onclick = () => { draftAv = null; drawAv(); refresh(); };
      input.onchange = async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        try { draftAv = await prepareAvatar(f); drawAv(); refresh(); } catch (err) { toast(err.message); }
      };
      remove.classList.toggle('hidden', !draftAv);

      box.appendChild(el('div', 'label', `${g.members.length} Mitglieder`));
      const ul = el('ul', 'members');
      [me.code, ...others(g)].forEach((c) => {
        const li = el('li');
        const cc = contacts[c] || {};
        li.appendChild(avatarEl(nameOf(c), c === me.code ? me.avatar : cc.avatar, c, 'sm', c === me.code ? null : isOnline(c), c === me.code ? me.frame : cc.frame));
        li.appendChild(el('span', '', nameOf(c) + (c === me.code ? ' (du)' : '') + (c === g.owner ? ' 👑' : '')));
        ul.appendChild(li);
      });
      box.appendChild(ul);
      box.appendChild(clearRow(activeChat));
      const candidates = friendCodes().filter((c) => !g.members.includes(c));
      let list = null;
      if (candidates.length) {
        box.appendChild(el('div', 'label', 'Freunde hinzufügen'));
        list = checkList(candidates);
        box.appendChild(list);
      }
      const actions = buttons(
        ['Verlassen', 'danger', () => { if (confirm(`Gruppe „${g.name}“ verlassen? Der Verlauf wird gelöscht.`)) leaveGroup(g); }],
        ['Schließen', 'primary', () => {
          if (!nameIn.value.trim()) { nameIn.focus(); return; }
          updateGroup(g, { name: nameIn.value, desc: descIn.value, avatar: draftAv });
          if (list && list.selected().length) addToGroup(g, list.selected());
          closeModal();
        }],
      );
      const mainBtn = actions.querySelector('.primary');
      mainBtn.id = 'groupSaveBtn';
      function refresh() {
        const dirty = nameIn.value.trim() !== g.name || descIn.value.trim() !== (g.desc || '') ||
          draftAv !== (g.avatar || null) || !!(list && list.selected().length);
        mainBtn.textContent = dirty ? 'Speichern' : 'Schließen';
        remove.classList.toggle('hidden', !draftAv);
      }
      nameIn.addEventListener('input', () => { refresh(); if (!draftAv) drawAv(); });
      descIn.addEventListener('input', refresh);
      if (list) list.addEventListener('change', refresh);
      box.appendChild(actions);
    });
  }

  // ================= Bildbetrachter =================
  function openViewer(src, m) {
    if (!src) return;
    $('viewerImg').src = src;
    const ext = (/^data:image\/(\w+)/.exec(src) || [])[1] || 'png';
    $('viewerSave').href = src;
    $('viewerSave').download = `whatsup-${new Date(m.ts).toISOString().slice(0, 10)}-${m.id.slice(0, 6)}.${ext === 'jpeg' ? 'jpg' : ext}`;
    $('viewerSticker').classList.toggle('hidden', !stickers.isOwner());
    $('viewer').classList.remove('hidden');
  }
  $('viewerClose').onclick = () => $('viewer').classList.add('hidden');
  $('viewer').onclick = (e) => { if (e.target.id === 'viewer' || e.target.id === 'viewerImg') $('viewer').classList.add('hidden'); };

  // ================= Emojis =================
  const EMOJI = window.CHATBOX_EMOJIS;
  let emojiTab = recentEmojis.length ? 'recent' : Object.keys(EMOJI)[0];

  function renderEmojiPanel() {
    const tabs = $('emojiTabs');
    tabs.replaceChildren();
    if (emojiTab === 'stickers' && !stickers.isOwner()) emojiTab = 'recent';
    [...(stickers.isOwner() ? [['stickers', '🩷']] : []), ['recent', '🕓'], ...Object.keys(EMOJI).map((k) => [k, k])].forEach(([key, icon]) => {
      const b = el('button', 'emoji-tab' + (key === emojiTab ? ' active' : ''), icon);
      b.type = 'button';
      b.onclick = () => { emojiTab = key; renderEmojiPanel(); };
      tabs.appendChild(b);
    });
    const grid = $('emojiGrid');
    grid.replaceChildren();
    grid.classList.remove('sticker-grid');
    if (emojiTab === 'stickers') { stickers.renderGrid(grid); return; }
    const list = emojiTab === 'recent' ? recentEmojis : EMOJI[emojiTab].split(' ');
    if (!list.length) grid.appendChild(el('div', 'muted', 'Noch keine Emojis benutzt.'));
    list.forEach((e) => {
      const b = el('button', 'emoji', e);
      b.type = 'button';
      b.onclick = () => insertEmoji(e);
      grid.appendChild(b);
    });
  }

  function insertEmoji(e) {
    const input = $('msgInput');
    const s = input.selectionStart ?? input.value.length, t = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, s) + e + input.value.slice(t);
    input.selectionStart = input.selectionEnd = s + e.length;
    voice.syncComposer();
    if (!window.matchMedia('(pointer: coarse)').matches) input.focus(); // Handy: Tastatur nicht über die Emojis schieben
    recentEmojis = [e, ...recentEmojis.filter((x) => x !== e)].slice(0, 32);
    store.save('recentEmojis', recentEmojis);
  }

  function hideEmoji() { $('emojiPanel').classList.add('hidden'); $('emojiBtn').classList.remove('active'); }
  $('emojiBtn').onclick = () => {
    const p = $('emojiPanel');
    if (p.classList.contains('hidden')) { renderEmojiPanel(); p.classList.remove('hidden'); $('emojiBtn').classList.add('active'); }
    else hideEmoji();
  };

  // ================= Einstellungen =================
  let draftAvatar = null;
  let draftFrame = null;
  let draftBanner = null;
  function openSettings() {
    draftAvatar = me.avatar || null;
    draftFrame = validFrame(me.frame);
    draftBanner = validBanner(me.banner);
    $('profName').value = me.name;
    $('profStatus').value = me.status || '';
    $('profCode').textContent = me.code;
    $('setNotify').checked = settings.notify;
    $('setSound').checked = settings.sound;
    $('setPopup').checked = settings.popupNotify;
    $('setPreview').checked = settings.preview;
    $('setBackground').checked = settings.runInBackground;
    $('setLogin').checked = settings.openAtLogin;
    $('setRelay').checked = settings.relay !== false;
    relay.renderRelayStatus();
    renderNotifyRows();
    $('setAutoUpdate').checked = settings.autoUpdate;
    window.chatboxWindow.isPinned().then((p) => { $('setPin').checked = p; });
    renderProfAvatar();
    markProfileDirty(false);
    renderTheme();
    updateStorage();
    show('viewSettings');
  }

  // ---- Speicher ----
  async function updateStorage() {
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      $('storageUsed').textContent = est && est.usage != null ? fmtBytes(est.usage) : '–';
    } catch { $('storageUsed').textContent = '–'; }
  }
  function openStorage() {
    openModal(async (box) => {
      box.appendChild(el('h3', '', 'Speicher verwalten'));
      const info = el('div', 'muted', 'Wird berechnet…');
      box.appendChild(info);
      const ul = el('ul', 'members storage-list');
      box.appendChild(ul);
      box.appendChild(buttons(['Schließen', 'primary', () => { closeModal(); updateStorage(); }]));
      const ids = [...friendCodes().map((c) => 'u:' + c), ...Object.keys(groups).map((g) => 'g:' + g)]
        .filter((id) => (chats[id] || []).length);
      const sizes = await Promise.all(ids.map(async (id) => [id, await chatSize(id)]));
      sizes.sort((a, b) => b[1] - a[1]);
      info.textContent = sizes.length ? 'Leeren löscht Nachrichten, Bilder und GIFs nur auf diesem Gerät.' : 'Noch keine Chats mit Nachrichten.';
      sizes.forEach(([id, bytes]) => {
        const li = el('li');
        li.appendChild(chatAvatar(id, 'sm'));
        const isG = id.startsWith('g:');
        const name = el('span', 'fmeta');
        name.appendChild(el('span', 'fname', isG ? groups[id.slice(2)].name : nameOf(id.slice(2))));
        const sz = el('span', 'flast', fmtBytes(bytes));
        name.appendChild(sz);
        const btn = el('button', 'link danger-link', 'Leeren');
        btn.type = 'button';
        btn.onclick = async () => {
          if (!confirm('Diesen Chat auf diesem Gerät leeren?')) return;
          await clearChat(id);
          sz.textContent = 'leer';
          btn.remove();
        };
        li.append(name, btn);
        ul.appendChild(li);
      });
    });
  }
  $('storageManage').onclick = openStorage;
  const WEB_URL = 'https://jeremy-jud.github.io/whatsup/';
  $('webLink').onclick = async () => {
    try { await navigator.clipboard.writeText(WEB_URL); toast('Link kopiert – auf dem iPhone in Safari öffnen'); }
    catch { toast(WEB_URL); }
  };
  function renderProfAvatar() {
    const name = $('profName').value || me.name;
    $('profAvatar').replaceChildren(avatarEl(name, draftAvatar, me.code, 'xl', null, draftFrame));
    // Rahmen-Auswahl mit Vorschau des eigenen Bildes
    const grid = $('frameGrid');
    grid.replaceChildren();
    [null, ...Object.keys(FRAMES)].forEach((id) => {
      const locked = frameLocked(id);
      const b = el('button', 'frame-opt' + (id === draftFrame ? ' active' : '') + (id && FRAMES[id].locked ? ' exclusive' : '') + (locked ? ' locked' : ''));
      b.type = 'button';
      b.title = id ? FRAMES[id].name + (locked ? ' – mit einem Code freischalten (Erfolge)' : '') : 'Kein Rahmen';
      b.appendChild(avatarEl(name, draftAvatar, me.code, 'md', null, id));
      b.appendChild(el('span', 'frame-name', id ? FRAMES[id].name : 'Keiner'));
      b.onclick = () => {
        if (locked) { toast('🔒 Exklusiver Rahmen – Code einlösen unter Erfolge 🏆'); return; }
        draftFrame = id; renderProfAvatar(); markProfileDirty(profileDirty());
      };
      grid.appendChild(b);
    });
    // Banner-Auswahl
    const bg = $('bannerGrid');
    bg.replaceChildren();
    [null, ...Object.keys(BANNERS)].forEach((id) => {
      const locked = bannerLocked(id);
      const b = el('button', 'banner-opt' + (id ? '' : ' none') + (id === draftBanner ? ' active' : '') + (locked ? ' locked' : ''), id ? BANNERS[id].name : 'Kein Banner');
      b.type = 'button';
      if (id) b.style.background = BANNERS[id].bg;
      b.title = locked ? 'Mit einem Code freischalten (Erfolge)' : '';
      b.onclick = () => {
        if (locked) { toast('🔒 Exklusives Banner – Code einlösen unter Erfolge 🏆'); return; }
        draftBanner = id; renderProfAvatar(); markProfileDirty(profileDirty());
      };
      bg.appendChild(b);
    });
  }
  function markProfileDirty(dirty) {
    $('profSave').classList.toggle('hidden', !dirty);
  }
  const profileDirty = () => $('profName').value.trim() !== me.name || $('profStatus').value.trim() !== (me.status || '') ||
    draftAvatar !== (me.avatar || null) || draftFrame !== validFrame(me.frame) || draftBanner !== validBanner(me.banner);

  $('avatarChange').onclick = () => $('avatarInput').click();
  $('avatarRemove').onclick = () => { draftAvatar = null; renderProfAvatar(); markProfileDirty(profileDirty()); };
  $('avatarInput').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    try { draftAvatar = await prepareAvatar(f); renderProfAvatar(); markProfileDirty(profileDirty()); } catch (err) { toast(err.message); }
  };
  ['profName', 'profStatus'].forEach((id) => $(id).addEventListener('input', () => { markProfileDirty(profileDirty()); if (id === 'profName' && !draftAvatar) renderProfAvatar(); }));
  $('profSave').onclick = () => {
    const name = $('profName').value.trim();
    if (!name) { $('profName').focus(); return; }
    me.name = name.slice(0, 24);
    me.status = $('profStatus').value.trim().slice(0, 80);
    me.banner = draftBanner;
    me.pv = Date.now();
    if (draftAvatar && draftAvatar !== me.avatar) stats.avatarSet++;
    me.avatar = draftAvatar;
    if (draftFrame && draftFrame !== me.frame) stats.frameSet = (stats.frameSet || 0) + 1;
    me.frame = draftFrame;
    saveMeta();
    checkAchievements();
    broadcastProfile();
    markProfileDirty(false);
    toast('Profil gespeichert');
    render();
  };
  $('profCopy').onclick = () => $('copyBtn').click();

  // Darstellung
  function applyTheme() {
    if (settings.theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', settings.theme);
  }
  function renderTheme() {
    $('themeSeg').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.theme === settings.theme));
  }
  $('themeSeg').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applyTheme(); renderTheme(); sendPrefs(); };
  });

  // Allgemein
  function renderNotifyRows() {
    ['setPopup', 'setSound', 'setPreview'].forEach((id) => $(id).closest('.setting').classList.toggle('disabled', !settings.notify));
  }
  $('setNotify').onchange = (e) => {
    settings.notify = e.target.checked; saveSettings(); renderNotifyRows();
    if (settings.notify) setTimeout(() => relay.setupPush(), 2000); // nach der Erlaubnis-Abfrage
  };
  $('setPopup').onchange = (e) => { settings.popupNotify = e.target.checked; saveSettings(); sendPrefs(); };
  $('setSound').onchange = (e) => { settings.sound = e.target.checked; saveSettings(); };
  $('setPreview').onchange = (e) => { settings.preview = e.target.checked; saveSettings(); };
  $('setBackground').onchange = (e) => { settings.runInBackground = e.target.checked; saveSettings(); sendPrefs(); };
  $('setLogin').onchange = (e) => { settings.openAtLogin = e.target.checked; saveSettings(); sendPrefs(); };
  $('setRelay').onchange = (e) => {
    settings.relay = e.target.checked; saveSettings();
    if (settings.relay) relay.start(); else relay.renderRelayStatus();
  };
  $('notifyTest').onclick = () => {
    const local = () => window.chatboxWindow.notify({ title: 'WhatsUp', body: 'So sehen deine Benachrichtigungen aus 👋', silent: !settings.sound });
    if (!document.documentElement.classList.contains('is-web')) { local(); return; }
    // Web: echter Push über den Server, damit er auch auf dem Sperrbildschirm ankommt
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios && !document.documentElement.classList.contains('is-standalone')) {
      toast('Für Push auf dem Sperrbildschirm: Teilen → „Zum Home-Bildschirm“, dann WhatsUp dort öffnen.');
      return;
    }
    if (!('Notification' in window)) { toast('Dieser Browser kann keine Benachrichtigungen.'); return; }
    const perm = Notification.permission === 'default' ? Notification.requestPermission() : Notification.permission;
    Promise.resolve(perm).then(async (p) => {
      if (p !== 'granted') { toast('Benachrichtigungen sind blockiert. Erlaube sie in den Einstellungen.'); return; }
      if (!settings.notify) { settings.notify = true; saveSettings(); $('setNotify').checked = true; renderNotifyRows(); }
      const r = await relay.pushTest();
      if (r === 'ok') toast('Test kommt in 5 Sekunden. Sperr jetzt dein Handy 🔒');
      else { local(); toast('Push über den Server ging gerade nicht, nur Test in der App.'); }
    });
  };
  $('setAutoUpdate').onchange = (e) => { settings.autoUpdate = e.target.checked; saveSettings(); };
  $('setPin').onchange = async (e) => {
    const pinned = await window.chatboxWindow.isPinned();
    if (pinned !== e.target.checked) { const p = await window.chatboxWindow.togglePin(); $('pinBtn').classList.toggle('active', p); }
  };
  $('repoLink').onclick = () => window.whatsupApp.openRepo();

  // Updates
  const upd = { state: 'idle', latest: null, mode: 'dev', version: '' };
  function renderUpdate() {
    const btn = $('updateBtn'), st = $('updateStatus'), bar = $('updateBar');
    $('appVersion').textContent = upd.version + (upd.mode === 'portable' ? ' (ohne Installation)' : upd.mode === 'dev' ? ' (Entwicklung)' : upd.mode === 'web' ? ' (Web)' : '');
    bar.classList.toggle('hidden', upd.state !== 'downloading');
    btn.disabled = upd.state === 'checking' || upd.state === 'downloading';
    $('updateDot').classList.toggle('hidden', !(upd.state === 'available' || upd.state === 'ready'));
    switch (upd.state) {
      case 'checking': st.textContent = 'Suche nach Updates…'; btn.textContent = 'Suche…'; break;
      case 'none': st.textContent = 'WhatsUp ist auf dem neuesten Stand.'; btn.textContent = 'Erneut suchen'; break;
      case 'available':
        st.textContent = `Version ${upd.latest} ist verfügbar.`;
        btn.textContent = upd.mode === 'installed' ? 'Jetzt aktualisieren' : 'Download öffnen';
        break;
      case 'downloading': st.textContent = `Update wird geladen… ${upd.progress || 0} %`; btn.textContent = 'Wird geladen…'; break;
      case 'ready': st.textContent = 'Update ist bereit. WhatsUp startet dafür kurz neu.'; btn.textContent = 'Neu starten und installieren'; break;
      case 'error': st.textContent = 'Fehler: ' + upd.error; btn.textContent = 'Erneut versuchen'; break;
      default: st.textContent = ''; btn.textContent = 'Nach Updates suchen';
    }
  }
  async function checkForUpdate(silent) {
    if (['checking', 'downloading', 'ready'].includes(upd.state)) return;
    upd.state = 'checking'; renderUpdate();
    try {
      const r = await window.whatsupApp.checkUpdate();
      upd.latest = r.latest;
      upd.state = r.available ? 'available' : 'none';
      if (r.available && silent) toast(`Update ${r.latest} verfügbar – siehe Einstellungen`);
    } catch (e) {
      upd.state = silent ? 'idle' : 'error';
      upd.error = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 120);
    }
    renderUpdate();
  }
  $('updateBtn').onclick = async () => {
    if (upd.state === 'available') {
      if (upd.mode !== 'installed') { window.whatsupApp.downloadUpdate(); return; }
      upd.state = 'downloading'; upd.progress = 0; renderUpdate();
      try { await window.whatsupApp.downloadUpdate(); upd.state = 'ready'; }
      catch (e) { upd.state = 'error'; upd.error = String(e.message || e).slice(0, 120); }
      renderUpdate();
    } else if (upd.state === 'ready') {
      $('updateStatus').textContent = 'Wird installiert…';
      window.whatsupApp.installUpdate();
    } else checkForUpdate(false);
  };
  window.whatsupApp.onUpdateProgress((p) => { upd.progress = p; if (upd.state === 'downloading') renderUpdate(); });
  window.whatsupApp.onUpdateReady(() => { upd.state = 'ready'; renderUpdate(); });
  window.whatsupApp.onUpdateError((m) => { if (upd.state === 'downloading') { upd.state = 'error'; upd.error = m.slice(0, 120); renderUpdate(); } });
  window.whatsupApp.info().then((i) => {
    upd.version = i.version; upd.mode = i.mode; renderUpdate();
    $('loginRow').classList.toggle('hidden', i.mode !== 'installed');
    if (settings.autoUpdate && (i.mode === 'installed' || i.mode === 'portable')) setTimeout(() => checkForUpdate(true), 4000);
  });

  // ================= Events =================
  $('minBtn').onclick = () => window.chatboxWindow.minimize();
  $('closeBtn').onclick = () => window.chatboxWindow.close();
  $('pinBtn').onclick = async () => { const p = await window.chatboxWindow.togglePin(); $('pinBtn').classList.toggle('active', p); };
  $('backBtn').onclick = () => (view === 'viewChat' ? closeChat() : (show(lastTab), render()));
  $('trophyBtn').onclick = () => { show('viewAchievements'); renderAchievements(); };
  $('meCardBtn').onclick = openSettings;
  $('newGroupBtn').onclick = openNewGroup;
  $('chatHead').onclick = openInfo;
  $('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('msgMenuBack')) closeMsgMenu();
    else if (music.isOpen()) music.closePicker();
    else if (reels.sheetOpen()) reels.closeSheet();
    else if (video.open()) video.close();
    else if (video.playerOpen()) video.closePlayer();
    else if (!$('stkEditor').classList.contains('hidden')) $('stkCancel').click();
    else if (!$('stCompose').classList.contains('hidden')) $('stComposeClose').click();
    else if (!$('viewer').classList.contains('hidden')) $('viewer').classList.add('hidden');
    else if (!$('modal').classList.contains('hidden')) closeModal();
    else if (!$('emojiPanel').classList.contains('hidden')) hideEmoji();
    else if (pendingReply) clearReply();
  });

  $('redeemForm').onsubmit = (e) => {
    e.preventDefault();
    const r = redeemCode($('redeemInput').value);
    $('redeemMsg').textContent = r.text;
    $('redeemMsg').classList.toggle('ok', r.ok);
    $('redeemMsg').classList.toggle('err', !r.ok);
    if (r.ok) { $('redeemInput').value = ''; toast('🎁 ' + r.text.split('!')[0] + '!', true); }
  };

  $('setupBtn').onclick = () => {
    const name = $('setupName').value.trim();
    if (!name) { $('setupName').focus(); return; }
    me = { code: newCode(), name: name.slice(0, 24), status: '', avatar: null };
    saveMeta();
    boot();
  };
  $('setupName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('setupBtn').click(); });

  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(me.code); toast('Code kopiert'); }
    catch { toast('Kopieren fehlgeschlagen'); }
  };

  $('addForm').onsubmit = (e) => {
    e.preventDefault();
    const code = $('addInput').value.trim().toUpperCase();
    if (!CODE_RE.test(code)) return setStatus('Ein Code hat genau 6 Zeichen.', true);
    if (code === me.code) return setStatus('Das ist dein eigener Code 🙂', true);
    if (isFriend(code)) return setStatus(`${nameOf(code)} ist schon in deiner Liste.`);
    blocked = blocked.filter((c) => c !== code);
    ensureContact(code).friend = true;
    saveMeta();
    pendingAdd = code;
    pendingAddRelayed = false;
    setStatus(peer && peer.open ? 'Verbinde…' : 'Gespeichert. Wird verbunden, sobald du wieder online bist…');
    if (isOnline(code)) conns[code].send(helloPayload(code));
    else {
      delete connecting[code]; connectTo(code);
      // Offline? Dann die Freundschaftsanfrage über den Briefkasten-Server schicken
      setTimeout(async () => {
        if (isOnline(code) || !(await relay.send(code, helloPayload(code), { push: true }))) return; // Freundschaftsanfrage: mit Push
        if (pendingAdd === code) { pendingAddRelayed = true; setStatus('Dein Freund ist offline. Die Anfrage kommt an, sobald dein Freund WhatsUp öffnet.'); }
      }, 4000);
    }
    checkAchievements();
    render();
  };

  $('sendForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('msgInput').value.trim();
    if (!text || !activeChat) return;
    $('msgInput').value = '';
    voice.syncComposer();
    hideEmoji();
    sendMessage(activeChat, text, null);
  };

  $('attachBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; sendImageFile(f); };
  // Bilder/GIFs aus der Zwischenablage, dem Windows-Emoji-Feld (Win + .) oder per Drag & Drop.
  // Das Emoji-Feld liefert GIFs oft nur als <img src="https://…"> statt als Datei.
  function pickImage(dt) {
    if (!dt) return null;
    const files = [...(dt.files || [])].filter((x) => x.type.startsWith('image/'));
    const gifFile = files.find((x) => x.type === 'image/gif');
    if (gifFile) return { file: gifFile };
    let url = null;
    try {
      const html = dt.getData('text/html') || '';
      const m = /<img[^>]+src\s*=\s*["']([^"']+)["']/i.exec(html);
      if (m) url = m[1].replace(/&amp;/g, '&');
      if (!url) {
        const uri = (dt.getData('text/uri-list') || '').split(/\r?\n/).find((l) => l && !l.startsWith('#'));
        if (uri && /\.(gif|webp|png|jpe?g)(\?|$)/i.test(uri)) url = uri;
      }
    } catch {}
    // Animiertes GIF per Link bevorzugen – die mitgelieferte Datei ist oft nur ein Standbild
    if (url && /^https:\/\//i.test(url) && (!files.length || /\.gif(\?|$)|tenor|giphy/i.test(url))) return { url };
    if (files.length) return { file: files[0] };
    return null;
  }
  async function sendImageFromUrl(url) {
    if (!activeChat) return;
    try {
      toast('📥 GIF wird geladen…');
      const r = await window.whatsupApp.fetchImage(url);
      const bin = atob(r.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const ext = r.type.split('/')[1].replace('jpeg', 'jpg');
      await sendImageFile(new File([bytes], 'bild.' + ext, { type: r.type }));
    } catch (e) {
      toast('⚠️ ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }
  function handleImageTransfer(dt, e) {
    const p = pickImage(dt);
    if (!p) return false;
    if (e) e.preventDefault();
    if (p.file) sendImageFile(p.file); else sendImageFromUrl(p.url);
    return true;
  }
  $('msgInput').addEventListener('paste', (e) => handleImageTransfer(e.clipboardData, e));
  $('msgInput').addEventListener('beforeinput', (e) => {
    if (e.dataTransfer && /^insertFrom/.test(e.inputType)) handleImageTransfer(e.dataTransfer, e);
  });

  // Drag & Drop ins Chatfenster
  let dragDepth = 0;
  const chatView = $('viewChat');
  chatView.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').classList.remove('hidden'); });
  chatView.addEventListener('dragover', (e) => e.preventDefault());
  chatView.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
  chatView.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').classList.add('hidden');
    if (!handleImageTransfer(e.dataTransfer, null)) toast('⚠️ Nur Bilder und GIFs');
  });
  // Dateien außerhalb des Chats nicht im Fenster öffnen
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  window.addEventListener('focus', () => {
    if (activeChat && unread[activeChat]) { delete unread[activeChat]; saveMeta(); scheduleRender(); }
  });

  // ================= Streaks (wie bei Snapchat) =================
  // Ein Tag zählt, wenn ihr euch im Einzelchat BEIDE mindestens eine Nachricht geschickt habt
  // (Text, Bild, GIF, Sprachnachricht, Sticker). Fehlt ein ganzer Tag, ist der Streak weg.
  // Beide Geräte rechnen unabhängig aus denselben Nachrichten – es braucht keinen Server.
  const fire = (() => {
    const MILESTONES = [3, 7, 10, 30, 50, 100, 200, 365, 500, 1000];
    const dayNum = (ts) => { const d = new Date(ts); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5); };
    const today = () => dayNum(Date.now());
    const hoursLeft = () => { const d = new Date(); return (new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) - d) / 36e5; };
    const rec = (code) => { const c = contacts[code]; if (!c) return null; return (c.fire = c.fire || { n: 0, last: 0, days: {} }); };

    // Aktueller Streak (0, wenn gestern und heute nichts geschafft wurde)
    function current(code) {
      const f = contacts[code] && contacts[code].fire;
      return f && f.n && f.last >= today() - 1 ? f.n : 0;
    }
    const todayBits = (code) => { const f = contacts[code] && contacts[code].fire; return (f && f.days && f.days[today()]) || 0; };
    // Heute noch nicht geschafft, aber gestern schon -> läuft heute um Mitternacht ab
    const atRisk = (code) => current(code) > 0 && contacts[code].fire.last === today() - 1;

    function mark(code, who, ts) {
      const f = rec(code);
      if (!f) return;
      const D = dayNum(ts);
      if (D < today() - 2 || D > today()) return;
      const bits = f.days[D] || 0;
      const nb = bits | (who === 'me' ? 1 : 2);
      if (nb === bits) return;
      f.days[D] = nb;
      Object.keys(f.days).forEach((k) => { if (Number(k) < today() - 3) delete f.days[k]; });
      if (nb === 3) complete(code, f, D);
      saveMeta(); scheduleRender();
    }
    function complete(code, f, D) {
      if (D === f.last) return;
      if (f.n && D === f.last + 1) { f.n++; f.last = D; }
      else if (f.n && D < f.last) { if (D === f.last - f.n) f.n++; else return; } // verspätete Nachricht von gestern
      else { f.n = 1; f.last = D; }
      f.lostShown = 0;
      stats.maxFire = Math.max(stats.maxFire || 0, f.n);
      if (MILESTONES.includes(f.n)) toast(`🔥 ${f.n} Tage Streak mit ${nameOf(code)}!`, true);
      checkAchievements();
    }

    // Anzeige hinter dem Namen: 🔥12, kurz vor Ablauf 🔥12⏳
    function badge(code) {
      const n = current(code);
      if (!n) return '';
      return '🔥' + n + (atRisk(code) && hoursLeft() < 4 ? '⏳' : '');
    }
    // Text unter dem Namen im Chat
    function hint(code) {
      const n = current(code), bits = todayBits(code);
      const missing = !(bits & 1) && !(bits & 2) ? 'ihr beide' : !(bits & 1) ? 'du' : nameOf(code);
      if (bits === 3) return n ? `🔥 ${n} ${n === 1 ? 'Tag' : 'Tage'} · heute geschafft` : '';
      if (n) {
        const h = Math.floor(hoursLeft());
        return `🔥 ${n} · heute fehlt noch: ${missing}` + (atRisk(code) && h < 4 ? ` (noch ${h < 1 ? 'unter 1' : h} Std.)` : '');
      }
      return bits ? (missing === 'du' ? '🔥 Streak startet, wenn du heute auch schreibst' : `🔥 Streak startet, wenn ${missing} heute auch schreibt`) : '';
    }

    // Verlorene Streaks melden und kurz vor Mitternacht erinnern
    function tick() {
      for (const code of friendCodes()) {
        const f = contacts[code].fire;
        if (!f || !f.n) continue;
        if (f.n >= 3 && f.last < today() - 1 && f.lostShown !== f.last) {
          f.lostShown = f.last;
          toast(`💔 Streak mit ${nameOf(code)} verloren (${f.n} Tage)`);
          saveMeta();
        }
        if (f.n >= 3 && atRisk(code) && hoursLeft() < 4 && f.reminded !== today()) {
          f.reminded = today();
          notify(nameOf(code), `⏳ Euer ${f.n}-Tage-Streak läuft heute ab! Schreib noch was.`, { chatId: 'u:' + code, icon: contacts[code].avatar });
          saveMeta();
        }
      }
      scheduleRender();
    }
    return { mark, badge, hint, current, tick };
  })();

  // ================= Sticker (nur für einen bestimmten Nutzer) =================
  // Nur STICKER_OWNER kann Sticker erstellen, speichern und senden. Alle anderen sehen sie nur:
  // kein Sticker-Tab, kein Speichern (Anzeige als Hintergrundbild), Sticker von anderen werden verworfen.
  const stickers = (() => {
    const MAX = 200;
    const isOwner = () => !!me && me.code === STICKER_OWNER;
    let list = store.load('stickers', []);          // [{ id, ts }]
    const key = (id) => 'stk|' + id;
    const save = () => store.save('stickers', list);
    const cache = new Map();
    async function data(id) {
      if (cache.has(id)) return cache.get(id);
      const d = await db.get('media', key(id)).catch(() => null);
      if (d) cache.set(id, d);
      return d;
    }
    async function add(d) {
      const id = crypto.randomUUID();
      await db.put('media', key(id), d);
      cache.set(id, d);
      list.unshift({ id, ts: Date.now() });
      while (list.length > MAX) { const old = list.pop(); db.del('media', key(old.id)).catch(() => {}); cache.delete(old.id); }
      save();
    }
    function remove(id) {
      list = list.filter((s) => s.id !== id);
      db.del('media', key(id)).catch(() => {});
      cache.delete(id);
      save();
    }
    async function send(id) {
      if (!isOwner() || !activeChat) return;
      const d = await data(id);
      if (!d) return;
      hideEmoji();
      // zuletzt benutzt nach vorne
      const s = list.find((x) => x.id === id);
      if (s) { list = [s, ...list.filter((x) => x !== s)]; save(); }
      await sendMessage(activeChat, '', { kind: 'sticker', data: d, w: 512, h: 512 });
    }

    // ---------- Panel (Tab im Emoji-Feld) ----------
    function renderGrid(grid) {
      grid.classList.add('sticker-grid');
      const add = el('button', 'stk-tile add', '+ Neuer Sticker');
      add.type = 'button';
      add.onclick = () => $('stickerInput').click();
      grid.appendChild(add);
      list.forEach((s) => {
        const t = el('button', 'stk-tile');
        t.type = 'button';
        t.title = 'Senden · Rechtsklick/gedrückt halten zum Löschen';
        data(s.id).then((d) => { if (d) t.style.backgroundImage = `url("${d}")`; });
        let held = null, longPress = false;
        const del = () => { if (confirm('Diesen Sticker löschen?')) { remove(s.id); t.remove(); } };
        t.onpointerdown = () => { longPress = false; held = setTimeout(() => { longPress = true; del(); }, 600); };
        t.onpointerup = t.onpointerleave = () => clearTimeout(held);
        t.oncontextmenu = (e) => { e.preventDefault(); clearTimeout(held); del(); };
        t.onclick = () => { if (!longPress) send(s.id); };
        grid.appendChild(t);
      });
    }

    // ---------- Editor ----------
    const cv = $('stkCanvas'), g = cv.getContext('2d');
    let img = null, shape = 'round', zoom = 1, pan = { x: 0, y: 0 };
    function open(src) {
      if (!isOwner()) return;
      loadImg(src).then((i) => {
        img = i; zoom = 1; pan = { x: 0, y: 0 };
        $('stkZoom').value = '1';
        $('stkText').value = '';
        setShape('round');
        $('viewer').classList.add('hidden');
        $('stkEditor').classList.remove('hidden');
      }, () => toast('⚠️ Das Bild konnte nicht gelesen werden.'));
    }
    function close() { $('stkEditor').classList.add('hidden'); img = null; }
    function setShape(s) {
      shape = s;
      $('stkShape').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.shape === s));
      draw();
    }
    function clipPath(c) {
      c.beginPath();
      if (shape === 'round') c.arc(256, 256, 236, 0, Math.PI * 2);
      else if (shape === 'square') c.roundRect(20, 20, 472, 472, 70);
      else c.rect(0, 0, 512, 512);
    }
    function draw() {
      if (!img) return;
      g.clearRect(0, 0, 512, 512);
      const w = img.naturalWidth, h = img.naturalHeight;
      const base = shape === 'full' ? Math.min(512 / w, 512 / h) : Math.max(472 / w, 472 / h);
      const s = base * zoom, dw = w * s, dh = h * s;
      g.save();
      clipPath(g);
      g.clip();
      g.drawImage(img, 256 - dw / 2 + pan.x, 256 - dh / 2 + pan.y, dw, dh);
      g.restore();
      // weißer Sticker-Rand
      if (shape !== 'full') {
        g.save(); clipPath(g); g.lineWidth = 14; g.strokeStyle = '#fff'; g.stroke(); g.restore();
      }
      const text = $('stkText').value.trim();
      if (text) {
        let size = 72;
        g.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`;
        while (g.measureText(text).width > 440 && size > 28) { size -= 4; g.font = `900 ${size}px "Segoe UI", system-ui, sans-serif`; }
        g.textAlign = 'center'; g.textBaseline = 'alphabetic';
        g.lineJoin = 'round'; g.lineWidth = Math.max(6, size / 6); g.strokeStyle = '#000';
        g.strokeText(text, 256, 470); g.fillStyle = '#fff'; g.fillText(text, 256, 470);
      }
    }
    // Verschieben mit Maus/Finger
    let drag = null;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const f = 512 / cv.clientWidth;
      pan.x = drag.px + (e.clientX - drag.x) * f;
      pan.y = drag.py + (e.clientY - drag.y) * f;
      draw();
    });
    cv.addEventListener('pointerup', () => { drag = null; });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoom = Math.max(0.5, Math.min(4, zoom * (e.deltaY < 0 ? 1.08 : 0.93))); $('stkZoom').value = String(zoom); draw(); }, { passive: false });
    $('stkZoom').oninput = (e) => { zoom = Number(e.target.value) || 1; draw(); };
    $('stkText').oninput = draw;
    $('stkShape').querySelectorAll('button').forEach((b) => { b.onclick = () => setShape(b.dataset.shape); });
    $('stkCancel').onclick = close;
    $('stkEditor').onclick = (e) => { if (e.target.id === 'stkEditor') close(); };
    $('stkSave').onclick = async () => {
      if (!img) return;
      draw();
      let d = cv.toDataURL('image/webp', 0.9);
      if (!d.startsWith('data:image/webp')) d = cv.toDataURL('image/png'); // Safari kann kein WebP erzeugen
      if (d.length > STICKER_MAX) { toast('⚠️ Sticker ist zu groß'); return; }
      await add(d);
      close();
      toast('Sticker gespeichert ✓');
      if (!$('emojiPanel').classList.contains('hidden')) renderEmojiPanel();
    };
    $('stickerInput').onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f || !f.type.startsWith('image/')) return;
      open(await readAsDataURL(f));
    };
    // Bild aus dem Chat als Sticker übernehmen
    $('viewerSticker').onclick = () => open($('viewerImg').src);

    // Anzeige im Chat (für alle): nur ansehen
    function view(cid, m) {
      const d = el('div', 'stk');
      d.setAttribute('role', 'img');
      d.setAttribute('aria-label', 'Sticker');
      getMedia(cid, m.id).then((x) => { if (x) d.style.backgroundImage = `url("${x}")`; });
      d.oncontextmenu = (e) => e.preventDefault();
      return d;
    }
    return { isOwner, renderGrid, view, open };
  })();

  // ================= Sprachnachrichten =================
  // Aufnahme mit MediaRecorder (bevorzugt MP4/AAC: spielt auf iPhone, Windows und Android),
  // Wellenform wird beim Aufnehmen gemessen und mitgeschickt.
  const voice = (() => {
    const MAX_S = 300;           // höchstens 5 Minuten
    const BARS = 40;
    let rec = null, stream = null, chunks = [], startT = 0, timer = null, chatId = null, cancelled = false;
    let actx = null, analyser = null, sampler = null, levels = [];

    const pickType = () => ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

    async function start() {
      if (rec || !activeChat) return;
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast('⚠️ Sprachnachrichten werden hier nicht unterstützt.'); return; }
      if (calls.active()) { toast('Während eines Anrufs nicht möglich'); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        toast(e && e.name === 'NotAllowedError' ? '⚠️ Kein Zugriff aufs Mikrofon. Bitte in den Einstellungen erlauben.' : '⚠️ Kein Mikrofon gefunden.');
        return;
      }
      const type = pickType();
      try { rec = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 48000 }); }
      catch { rec = new MediaRecorder(stream); }
      chunks = []; levels = []; cancelled = false; chatId = activeChat;
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = finish;
      rec.start(250);
      startT = Date.now();
      // Lautstärke messen: für die Live-Anzeige und die Wellenform in der Nachricht
      try {
        actx = new AudioContext();
        analyser = actx.createAnalyser();
        analyser.fftSize = 1024;
        actx.createMediaStreamSource(stream).connect(analyser);
        const buf = new Float32Array(analyser.fftSize);
        sampler = setInterval(() => {
          analyser.getFloatTimeDomainData(buf);
          let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
          levels.push(Math.sqrt(sum / buf.length));
          draw();
        }, 80);
      } catch {}
      $('recBar').classList.remove('hidden');
      $('recTime').textContent = '0:00';
      timer = setInterval(() => {
        const s = (Date.now() - startT) / 1000;
        $('recTime').textContent = fmt(s);
        if (s >= MAX_S) stop(true);
      }, 250);
      hideEmoji();
    }
    // Live-Anzeige: die letzten Pegel als Balken von rechts nach links
    function draw() {
      const cv = $('recWave'), g = cv.getContext('2d');
      const w = cv.width = cv.clientWidth * (window.devicePixelRatio || 1), h = cv.height = cv.clientHeight * (window.devicePixelRatio || 1);
      g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#1a8cff';
      const bw = 3 * (window.devicePixelRatio || 1), gap = 2 * (window.devicePixelRatio || 1);
      const n = Math.floor(w / (bw + gap));
      const last = levels.slice(-n);
      last.forEach((v, i) => {
        const bh = Math.max(bw, Math.min(1, v * 6) * h);
        g.fillRect(w - (last.length - i) * (bw + gap), (h - bh) / 2, bw, bh);
      });
    }
    function stop(send) {
      if (!rec || rec.state === 'inactive') return;
      cancelled = !send;
      rec.stop();
    }
    function cleanup() {
      clearInterval(timer); clearInterval(sampler);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (actx) actx.close().catch(() => {});
      stream = null; actx = null; analyser = null;
      $('recBar').classList.add('hidden');
    }
    // Pegel auf feste Anzahl Balken (0..1) bringen
    function wave() {
      if (!levels.length) return Array(BARS).fill(0.2);
      const out = [];
      for (let i = 0; i < BARS; i++) {
        const a = Math.floor(i * levels.length / BARS), b = Math.max(a + 1, Math.floor((i + 1) * levels.length / BARS));
        out.push(Math.max(...levels.slice(a, b)));
      }
      const max = Math.max(...out) || 1;
      return out.map((v) => Math.round(Math.max(0.08, v / max) * 100) / 100);
    }
    async function finish() {
      const r = rec; rec = null;
      const dur = (Date.now() - startT) / 1000;
      const w = wave();
      cleanup();
      if (cancelled) return;
      if (dur < 0.8) { toast('Zu kurz'); return; }
      try {
        const type = ((r && r.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm').split(';')[0];
        const data = await readAsDataURL(new Blob(chunks, { type }));
        if (data.length > MAX_MEDIA) { toast('⚠️ Die Sprachnachricht ist zu lang.'); return; }
        await sendMessage(chatId, '', { kind: 'audio', data, dur: Math.round(dur * 10) / 10, wave: w });
      } catch (e) { toast('⚠️ Sprachnachricht konnte nicht gesendet werden.'); console.error(e); }
    }

    $('micBtn').onclick = start;
    $('recSend').onclick = () => stop(true);
    $('recCancel').onclick = () => stop(false);
    const syncComposer = () => $('sendForm').classList.toggle('has-text', !!$('msgInput').value.trim());
    $('msgInput').addEventListener('input', syncComposer);

    // ---------- Abspielen ----------
    // Ein gemeinsamer Player; die Anzeige wird beim Neuzeichnen des Chats wieder verbunden
    const player = { audio: new Audio(), id: null, ui: null, rate: 1 };
    player.audio.preload = 'auto';
    function paint() {
      const ui = player.ui;
      if (!ui) return;
      const a = player.audio, dur = ui.dur || a.duration || 0;
      const playing = !a.paused && !a.ended;
      ui.btn.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
      const p = dur ? Math.min(1, a.currentTime / dur) : 0;
      const on = Math.round(p * ui.bars.length);
      ui.bars.forEach((b, i) => b.classList.toggle('on', i < on));
      ui.time.textContent = fmt(playing || a.currentTime > 0 ? a.currentTime : dur);
    }
    ['timeupdate', 'play', 'pause', 'ended'].forEach((ev) => player.audio.addEventListener(ev, paint));
    player.audio.addEventListener('ended', () => {
      player.audio.currentTime = 0;
      const ui = player.ui;
      if (ui) { ui.bars.forEach((b) => b.classList.remove('on')); ui.time.textContent = fmt(ui.dur); ui.btn.querySelector('use').setAttribute('href', '#i-play'); }
    });

    function el_(cid, m) {
      const box = el('div', 'voice');
      const btn = el('button', 'vplay');
      btn.type = 'button'; btn.title = 'Abspielen';
      btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-play"/></svg>';
      const body = el('div', 'vbody');
      const wv = el('div', 'vwave');
      const vals = Array.isArray(m.media.wave) && m.media.wave.length ? m.media.wave : Array(BARS).fill(0.3);
      const bars = vals.map((v) => { const b = document.createElement('i'); b.style.height = Math.round(Math.max(0.2, v) * 100) + '%'; wv.appendChild(b); return b; });
      const info = el('div', 'vinfo');
      const time = el('span', '', fmt(m.media.dur || 0));
      info.append(time);
      body.append(wv, info);
      const speed = el('button', 'vspeed', (player.id === m.id ? player.rate : 1) + '×');
      speed.type = 'button'; speed.title = 'Geschwindigkeit';
      box.append(btn, body, speed);
      const ui = { btn, bars, time, dur: m.media.dur || 0 };
      if (player.id === m.id) { player.ui = ui; paint(); }

      async function load() {
        if (player.id === m.id) return true;
        const data = await getMedia(cid, m.id);
        if (!data) { toast('Sprachnachricht nicht gefunden'); return false; }
        player.audio.pause();
        if (player.ui) { player.ui.bars.forEach((b) => b.classList.remove('on')); player.ui.btn.querySelector('use').setAttribute('href', '#i-play'); player.ui.time.textContent = fmt(player.ui.dur); }
        player.id = m.id; player.ui = ui; player.rate = Number(speed.dataset.rate) || 1;
        speed.textContent = player.rate + '×';
        player.audio.src = data;
        player.audio.defaultPlaybackRate = player.rate;
        player.audio.playbackRate = player.rate;
        return true;
      }
      btn.onclick = async () => {
        if (!(await load())) return;
        if (player.audio.paused) player.audio.play().catch(() => toast('⚠️ Kann nicht abgespielt werden'));
        else player.audio.pause();
      };
      // Auf die Wellenform tippen = an diese Stelle springen
      wv.onclick = async (e) => {
        if (!(await load())) return;
        const r = wv.getBoundingClientRect();
        const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
        const d = ui.dur || player.audio.duration || 0;
        if (d) player.audio.currentTime = p * d;
        if (player.audio.paused) player.audio.play().catch(() => {});
        paint();
      };
      speed.onclick = () => {
        const next = { 1: 1.5, 1.5: 2, 2: 1 }[player.id === m.id ? player.rate : 1] || 1;
        if (player.id === m.id) { player.rate = next; player.audio.playbackRate = next; }
        speed.textContent = next + '×';
        if (player.id !== m.id) speed.dataset.rate = next;
      };
      return box;
    }
    // Chat verlassen: Wiedergabe stoppen
    function stopPlayback() { player.audio.pause(); }
    return { el: el_, stop, stopPlayback, recording: () => !!rec, syncComposer };
  })();

  // ================= Musik für UpReels (feste Auswahl, CC BY 4.0, keine eigenen Dateien) =================
  // Die Tracks liegen bei der Web-Version (GitHub Pages) unter music/. Die Windows-App holt sie von dort.
  const music = (() => {
    const BASE = document.documentElement.classList.contains('is-web') ? 'music/' : 'https://jeremy-jud.github.io/whatsup/music/';
    let cat = null, catLoading = null, actx = null;
    const buffers = new Map(); // id -> Promise<AudioBuffer>
    let preview = null;        // { node, id }
    const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

    function catalog() {
      if (cat) return Promise.resolve(cat);
      if (!catLoading) {
        catLoading = fetch(BASE + 'tracks.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
          .then((d) => { cat = d; return d; })
          .catch((e) => { catLoading = null; throw e; });
      }
      return catLoading;
    }
    const track = (id) => (cat && cat.tracks.find((t) => t.id === id)) || null;
    const credit = (t) => `„${t.title}“ – ${t.artist} (incompetech.com) · CC BY 4.0`;
    function ctx() {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume().catch(() => {});
      return actx;
    }
    function buffer(id) {
      if (!buffers.has(id)) {
        const p = fetch(BASE + id + '.mp3').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then((ab) => new Promise((res, rej) => ctx().decodeAudioData(ab, res, rej)));
        p.catch(() => buffers.delete(id));
        buffers.set(id, p);
        // höchstens 4 Tracks im Speicher
        while (buffers.size > 4) buffers.delete(buffers.keys().next().value);
      }
      return buffers.get(id);
    }
    function stopPreview() {
      if (preview) { try { preview.node.stop(); } catch {} preview = null; }
      document.querySelectorAll('.mus-play.on').forEach((b) => { b.classList.remove('on'); b.textContent = '▶'; });
    }
    async function playPreview(id, start, len, btn) {
      if (preview && preview.id === id && btn && btn.classList.contains('on')) { stopPreview(); return; }
      stopPreview();
      if (btn) { btn.classList.add('on'); btn.textContent = '…'; }
      try {
        const buf = await buffer(id);
        if (btn && !btn.classList.contains('on')) return; // inzwischen gestoppt
        const node = ctx().createBufferSource();
        node.buffer = buf;
        const g = ctx().createGain(); g.gain.value = 0.9;
        node.connect(g); g.connect(ctx().destination);
        node.start(0, Math.min(start, Math.max(0, buf.duration - 1)), len || undefined);
        node.onended = () => { if (preview && preview.node === node) stopPreview(); };
        preview = { node, id };
        if (btn) btn.textContent = '■';
      } catch { toast('⚠️ Musik konnte nicht geladen werden'); stopPreview(); }
    }

    // Auswahl: Kategorien -> Track -> Ausschnitt. onPick({ id, start }) oder onPick(null) = ohne Musik
    async function pick({ current, len, onPick }) {
      closePicker();
      ctx(); // im Klick freischalten (iPhone)
      const back = el('div', 'reel-sheet-back mus-back');
      back.id = 'musicSheet';
      const box = el('div', 'reel-sheet mus-sheet');
      back.appendChild(box);
      back.onclick = (e) => { if (e.target === back) closePicker(); };
      document.body.appendChild(back);
      const head = (title, onBack) => {
        const h = el('div', 'reel-sheet-head');
        if (onBack) { const b = el('button', 'ic'); b.type = 'button'; b.innerHTML = '<svg><use href="#i-back"/></svg>'; b.onclick = onBack; h.appendChild(b); }
        h.appendChild(el('h3', 'mus-title', title));
        const x = el('button', 'ic'); x.type = 'button'; x.innerHTML = '<svg><use href="#i-x"/></svg>'; x.title = 'Schließen'; x.onclick = closePicker;
        h.appendChild(x);
        return h;
      };
      const foot = () => el('div', 'mus-credit', 'Musik: Kevin MacLeod (incompetech.com) · Lizenz CC BY 4.0');
      box.append(head('🎵 Musik'), el('div', 'muted center', 'Wird geladen…'));
      let data;
      try { data = await catalog(); } catch { box.replaceChildren(head('🎵 Musik'), el('div', 'muted center', '⚠️ Musik konnte nicht geladen werden. Bist du online?')); return; }
      let activeCat = current && track(current.id) ? track(current.id).cat : 'all';

      const drawList = () => {
        stopPreview();
        box.replaceChildren(head('🎵 Musik'));
        const chips = el('div', 'mus-cats');
        [{ id: 'all', name: 'Alle' }, ...data.categories].forEach((c) => {
          const b = el('button', 'mus-cat' + (c.id === activeCat ? ' on' : ''), c.name);
          b.type = 'button';
          b.onclick = () => { activeCat = c.id; drawList(); };
          chips.appendChild(b);
        });
        box.appendChild(chips);
        const ul = el('ul', 'mus-list');
        data.tracks.filter((t) => activeCat === 'all' || t.cat === activeCat).forEach((t) => {
          const li = el('li', 'mus-item' + (current && current.id === t.id ? ' cur' : ''));
          const play = el('button', 'mus-play', '▶');
          play.type = 'button'; play.title = 'Anhören';
          play.onclick = (e) => { e.stopPropagation(); playPreview(t.id, Math.min(30, t.dur / 4), 20, play); };
          const meta = el('div', 'mus-meta');
          meta.append(el('div', 'mus-name', t.title), el('div', 'muted', `${t.artist} · ${fmt(t.dur)}`));
          const use = el('button', 'mus-use', current && current.id === t.id ? '✓ Ausschnitt' : 'Wählen');
          use.type = 'button';
          use.onclick = (e) => { e.stopPropagation(); drawCut(t, current && current.id === t.id ? current.start : 0); };
          li.append(play, meta, use);
          li.onclick = () => drawCut(t, current && current.id === t.id ? current.start : 0);
          ul.appendChild(li);
        });
        box.appendChild(ul);
        // Gewählten Song in der Liste sichtbar machen
        const cur = ul.querySelector('.mus-item.cur');
        if (cur) setTimeout(() => cur.scrollIntoView({ block: 'center' }), 0);
        if (current) {
          const none = el('button', 'menu-item danger', '🚫 Ohne Musik');
          none.type = 'button';
          none.onclick = () => { closePicker(); onPick(null); };
          box.appendChild(none);
        }
        box.appendChild(foot());
      };

      // Ausschnitt wählen
      const drawCut = (t, start) => {
        stopPreview();
        const L = Math.min(len || 15, t.dur);
        const maxStart = Math.max(0, Math.floor((t.dur - L) * 2) / 2);
        start = Math.min(start || 0, maxStart);
        box.replaceChildren(head(t.title, drawList));
        const wrap = el('div', 'mus-cut');
        wrap.appendChild(el('div', 'muted', `${t.artist} · ${fmt(t.dur)}`));
        const label = el('div', 'mus-cut-label');
        const range = el('input');
        range.type = 'range'; range.min = 0; range.max = maxStart; range.step = 0.5; range.value = start;
        range.className = 'mus-range';
        const bar = el('div', 'mus-bar');
        const win = el('div', 'mus-win');
        bar.appendChild(win);
        const upd = () => {
          const s = Number(range.value);
          label.textContent = `Ausschnitt: ${fmt(s)} – ${fmt(s + L)}`;
          win.style.left = (s / t.dur * 100) + '%';
          win.style.width = (L / t.dur * 100) + '%';
        };
        range.oninput = () => { upd(); stopPreview(); };
        range.onchange = () => playPreview(t.id, Number(range.value), L, listen);
        upd();
        const listen = el('button', 'mus-play big', '▶');
        listen.type = 'button'; listen.title = 'Ausschnitt anhören';
        listen.onclick = () => playPreview(t.id, Number(range.value), L, listen);
        const row = el('div', 'mus-cut-row');
        row.append(listen, el('span', 'muted', maxStart > 0 ? 'Schieb den Regler, um den Ausschnitt zu wählen' : 'Der Track ist kürzer als dein Video'));
        wrap.append(label, bar, range, row);
        box.appendChild(wrap);
        const ok = el('button', 'primary mus-ok', '✓ Diese Musik nehmen');
        ok.type = 'button';
        ok.onclick = () => { closePicker(); onPick({ id: t.id, start: Number(range.value) }); };
        box.append(ok, el('div', 'mus-credit', credit(t) + ' · für WhatsUp gekürzt'));
        buffer(t.id).catch(() => {}); // schon mal laden
      };

      drawList(); // immer mit der Liste beginnen – so kann man jederzeit einen anderen Song nehmen
    }
    function closePicker() { stopPreview(); const s = $('musicSheet'); if (s) s.remove(); }

    return { catalog, track, credit, ctx, buffer, pick, closePicker, isOpen: () => !!$('musicSheet'), fmt };
  })();

  // ================= Videos aufnehmen und abspielen =================
  // Aufgenommen wird nicht direkt die Kamera, sondern eine Zeichenfläche, auf die das Kamerabild gemalt wird.
  // So kann man WÄHREND der Aufnahme die Kamera drehen: Es wechselt nur die Quelle, die Aufnahme läuft weiter.
  const video = (() => {
    const MAX_S = 60;                 // höchstens 1 Minute
    const LONG = 960;                 // längere Bildseite in Pixeln
    const isMobile = () => window.matchMedia('(pointer: coarse)').matches;
    const ov = $('vidRec'), cv = $('vidCanvas'), src = $('vidSrc'), out = $('vidPreview');
    let st = null; // { chatId, audio, cam, facing, deviceId, rec, chunks, startT, timer, raf, poster, result }

    const pickType = () => ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const fmt = (s) => { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    const videoInputs = async () => { try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; } };

    // ---------- Musik für UpReels: auswählen, beim Aufnehmen mithören, Regler, einmischen ----------
    // Die Vorschau läuft über Web Audio: Video-Ton -> voiceGain, Musik -> musicGain.
    let mix = null; // { ctx, outSrc, voiceGain, musicGain, node }
    function ensureMix() {
      if (mix) return mix;
      const ctx = music.ctx();
      const voiceGain = ctx.createGain(), musicGain = ctx.createGain();
      const outSrc = ctx.createMediaElementSource(out); // geht pro Element nur einmal – ab jetzt läuft der Vorschau-Ton immer hierüber
      outSrc.connect(voiceGain);
      voiceGain.connect(ctx.destination);
      musicGain.connect(ctx.destination);
      mix = { ctx, outSrc, voiceGain, musicGain, node: null };
      return mix;
    }
    function applyLevels() {
      if (!mix || !st) return;
      mix.voiceGain.gain.value = st.target === 'reel' ? st.levels.voice : 1;
      mix.musicGain.gain.value = st.levels.music;
    }
    function stopMusic() { if (mix && mix.node) { try { mix.node.stop(); } catch {} mix.node = null; } }
    // Musik ab Sekunde „at“ des Videos starten (beim Aufnehmen, in der Vorschau und beim Einmischen)
    function startMusic(at) {
      stopMusic();
      if (!st || !st.music || !st.musicBuf) return;
      ensureMix();
      const off = st.music.start + Math.max(0, at);
      if (off >= st.musicBuf.duration) return;
      const n = mix.ctx.createBufferSource();
      n.buffer = st.musicBuf;
      n.connect(mix.musicGain);
      n.start(0, off);
      mix.node = n;
    }
    async function setMusic(m) {
      st.music = m;
      st.musicBuf = null;
      renderMusicChip();
      if (!m) { stopMusic(); return; }
      try {
        const buf = await music.buffer(m.id);
        if (!st || st.music !== m) return;
        st.musicBuf = buf;
        ensureMix(); applyLevels();
        if (ov.dataset.mode === 'done' && !out.paused) startMusic(out.currentTime);
      } catch { toast('⚠️ Musik konnte nicht geladen werden'); }
    }
    function renderMusicChip() {
      const b = $('vidMusic');
      const t = st && st.music && music.track(st.music.id);
      b.textContent = t ? `🎵 ${t.title} · ab ${fmt(st.music.start)}` : '🎵 Musik hinzufügen';
      b.classList.toggle('on', !!t);
      $('vidMusicX').classList.toggle('hidden', !t);
      $('vidMixMusic').disabled = !t;
      $('vidMixMusicRow').classList.toggle('off', !t);
    }
    // ✕ neben dem Song: Musik mit einem Tipp entfernen
    $('vidMusicX').onclick = () => { if (st && !st.rec && !st.mixing) { setMusic(null); toast('Musik entfernt'); } };
    $('vidMusic').onclick = async () => {
      if (!st || st.rec) return;
      await music.catalog().catch(() => {});
      const len = st.result ? st.result.dur : 15;
      if (ov.dataset.mode === 'done') { out.pause(); }
      music.pick({ current: st.music, len, onPick: (m) => { setMusic(m); if (ov.dataset.mode === 'done') { out.currentTime = 0; out.play().catch(() => {}); } } });
    };
    $('vidMixMusic').oninput = (e) => { if (st) { st.levels.music = Number(e.target.value) / 100; applyLevels(); } };
    $('vidMixVoice').oninput = (e) => { if (st) { st.levels.voice = Number(e.target.value) / 100; applyLevels(); } };
    // Vorschau: Musik im Takt mit dem Video halten
    let lastT = 0;
    out.addEventListener('play', () => { if (st && st.target === 'reel' && !st.mixing) startMusic(out.currentTime); });
    out.addEventListener('pause', () => { if (st && !st.mixing) stopMusic(); });
    out.addEventListener('seeked', () => { if (st && st.target === 'reel' && !st.mixing && !out.paused) startMusic(out.currentTime); });
    out.addEventListener('timeupdate', () => {
      if (st && st.target === 'reel' && !st.mixing && !out.paused && out.currentTime < lastT - 0.3) startMusic(out.currentTime); // Schleife neu
      lastT = out.currentTime;
    });

    // Fertig gemischtes Video erzeugen: Vorschau einmal in Echtzeit abspielen und dabei Bild + Mischung aufnehmen
    async function renderMix(onProgress) {
      const s = st, r = s.result;
      ensureMix(); applyLevels();
      await mix.ctx.resume().catch(() => {});
      const dest = mix.ctx.createMediaStreamDestination();
      mix.voiceGain.disconnect(); mix.musicGain.disconnect();
      mix.voiceGain.connect(dest); mix.musicGain.connect(dest);
      s.mixing = true;
      let raf = 0;
      try {
        out.pause(); out.loop = false; out.muted = false;
        if (out.currentTime !== 0) { const sk = new Promise((res) => out.addEventListener('seeked', res, { once: true })); out.currentTime = 0; await Promise.race([sk, new Promise((res) => setTimeout(res, 1500))]); }
        cv.width = r.w; cv.height = r.h;
        const g = cv.getContext('2d');
        const draw = () => {
          if (out.videoWidth) {
            const s = Math.max(cv.width / out.videoWidth, cv.height / out.videoHeight);
            const dw = out.videoWidth * s, dh = out.videoHeight * s;
            g.drawImage(out, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
          }
          raf = requestAnimationFrame(draw);
        };
        draw();
        const stream = new MediaStream([...cv.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()]);
        const type = pickType();
        let rec;
        try { rec = new MediaRecorder(stream, { videoBitsPerSecond: 1200000, audioBitsPerSecond: 96000, ...(type ? { mimeType: type } : {}) }); }
        catch { rec = new MediaRecorder(stream); }
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        const stopped = new Promise((res) => { rec.onstop = res; });
        const tick = () => onProgress(Math.min(1, out.currentTime / (r.dur || out.duration || 1)));
        out.addEventListener('timeupdate', tick);
        rec.start(500);
        await out.play();
        startMusic(0);
        await Promise.race([new Promise((res) => out.addEventListener('ended', res, { once: true })), new Promise((res) => setTimeout(res, (r.dur + 4) * 1000))]);
        out.removeEventListener('timeupdate', tick);
        stopMusic();
        rec.stop();
        await stopped;
        const t = ((rec.mimeType || type || 'video/webm').split(';')[0]);
        return { blob: new Blob(chunks, { type: t }), type: t };
      } finally {
        cancelAnimationFrame(raf);
        s.mixing = false;
        out.loop = true;
        mix.voiceGain.disconnect(); mix.musicGain.disconnect();
        mix.voiceGain.connect(mix.ctx.destination); mix.musicGain.connect(mix.ctx.destination);
      }
    }

    async function getCam(facing, deviceId) {
      const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
      const tries = deviceId ? [{ deviceId: { exact: deviceId }, ...size }]
        : isMobile() ? [{ facingMode: { exact: facing }, ...size }, { facingMode: facing }] : [{ ...size }, true];
      let err;
      for (const v of tries) {
        try { return await navigator.mediaDevices.getUserMedia({ video: v }); } catch (e) { err = e; }
      }
      throw err;
    }
    const camError = (e) => toast(e && e.name === 'NotAllowedError' ? '⚠️ Kein Zugriff auf die Kamera. Bitte in den Einstellungen erlauben.' : '⚠️ Keine Kamera gefunden.');

    // Kamerabild „cover“ in die Zeichenfläche malen (andere Kamera kann ein anderes Format haben)
    function drawLoop() {
      if (!st) return;
      const vw = src.videoWidth, vh = src.videoHeight;
      if (vw && vh && src.readyState >= 2) {
        const g = cv.getContext('2d');
        const s = Math.max(cv.width / vw, cv.height / vh);
        const dw = vw * s, dh = vh * s;
        g.drawImage(src, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
      }
      st.raf = requestAnimationFrame(drawLoop);
    }
    // Vorschau spiegeln wie ein Spiegel, wenn die Frontkamera läuft (das Video selbst bleibt richtig herum)
    const mirror = () => cv.classList.toggle('mirror', !!st && st.facing === 'user');

    async function useCam(stream) {
      if (st.cam) st.cam.getTracks().forEach((t) => t.stop());
      st.cam = stream;
      src.srcObject = stream;
      await src.play().catch(() => {});
      if (!src.videoWidth) await new Promise((r) => { src.onloadedmetadata = r; setTimeout(r, 1500); });
      const t = stream.getVideoTracks()[0];
      st.deviceId = t && t.getSettings ? t.getSettings().deviceId : null;
      mirror();
    }

    // target: 'chat' (Video in den aktiven Chat) oder 'reel' (als UpReel posten, mit Beschreibung)
    let lastTarget = 'chat';
    let lastMusic = null;
    // opts.music = { id, start }: Musik vorwählen („Sound benutzen“)
    async function open(target = 'chat', opts = {}) {
      if (st || (target === 'chat' && !activeChat)) return;
      if (!navigator.mediaDevices || !window.MediaRecorder) { toast('⚠️ Videos aufnehmen wird hier nicht unterstützt.'); return; }
      if (calls.active()) { toast('Während eines Anrufs nicht möglich'); return; }
      if (voice.recording()) return;
      hideEmoji();
      if (mix) music.ctx(); // Ton der Vorschau läuft über Web Audio: im Klick wieder freischalten
      lastTarget = target;
      // Jede neue Aufnahme startet ohne Musik und mit Standard-Lautstärken (nur „Sound benutzen“ wählt vor)
      stopMusic();
      st = { chatId: target === 'chat' ? activeChat : null, target, facing: 'user', chunks: [], music: null, musicBuf: null, levels: { music: 0.6, voice: 1 } };
      renderMusicChip();
      ov.dataset.target = target;
      $('vidCaption').value = '';
      $('vidMixMusic').value = 60; $('vidMixVoice').value = 100;
      if (target === 'reel') {
        lastMusic = opts.music || null;
        await music.catalog().catch(() => {});
        if (!st) return;
        if (opts.music && music.track(opts.music.id)) setMusic({ id: opts.music.id, start: Number(opts.music.start) || 0 });
        else renderMusicChip();
      }
      ov.classList.remove('hidden');
      ov.classList.add('loading');
      setMode('ready');
      try {
        const cam = await getCam('user');
        if (!st) { cam.getTracks().forEach((t) => t.stop()); return; }
        await useCam(cam);
      } catch (e) { camError(e); close(); return; }
      try { st.audio = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
      catch { toast('🔇 Kein Mikrofon – Video wird ohne Ton aufgenommen'); }
      if (!st) return;
      // Format der Zeichenfläche: wie die erste Kamera, längere Seite höchstens LONG Pixel
      const vw = src.videoWidth || 1280, vh = src.videoHeight || 720;
      const k = Math.min(1, LONG / Math.max(vw, vh));
      cv.width = Math.round(vw * k / 2) * 2;
      cv.height = Math.round(vh * k / 2) * 2;
      ov.classList.remove('loading');
      drawLoop();
      const n = (await videoInputs()).length;
      $('vidFlip').classList.toggle('hidden', !(n > 1 || (isMobile() && n > 0)));
    }

    // Kamera drehen – geht auch mitten in der Aufnahme
    async function flip() {
      if (!st || !st.cam || st.flipping) return;
      st.flipping = true;
      const s = st;
      try {
        let next;
        if (isMobile()) {
          s.facing = s.facing === 'user' ? 'environment' : 'user';
          s.cam.getTracks().forEach((t) => t.stop()); // Handys erlauben oft nur eine Kamera gleichzeitig
          next = await getCam(s.facing);
        } else {
          const inputs = await videoInputs();
          if (inputs.length < 2) { toast('Keine zweite Kamera gefunden'); return; }
          const i = inputs.findIndex((d) => d.deviceId === s.deviceId);
          const dev = inputs[(i + 1) % inputs.length];
          s.facing = /back|rear|rück|environment/i.test(dev.label) ? 'environment' : 'user';
          next = await getCam(s.facing, dev.deviceId);
        }
        if (st !== s) { next.getTracks().forEach((t) => t.stop()); return; }
        await useCam(next);
      } catch (e) { camError(e); }
      finally { s.flipping = false; }
    }

    function start() {
      if (!st || st.rec || !st.cam) return;
      const canvasStream = cv.captureStream ? cv.captureStream(30) : null;
      // Ohne captureStream (sehr alte Browser): direkt die Kamera aufnehmen, dann kein Drehen während der Aufnahme
      const vtracks = canvasStream ? canvasStream.getVideoTracks() : st.cam.getVideoTracks();
      st.direct = !canvasStream;
      const stream = new MediaStream([...vtracks, ...(st.audio ? st.audio.getAudioTracks() : [])]);
      const type = pickType();
      const opts = { videoBitsPerSecond: 1200000, audioBitsPerSecond: 64000, ...(type ? { mimeType: type } : {}) };
      try { st.rec = new MediaRecorder(stream, opts); } catch { st.rec = new MediaRecorder(stream); }
      st.chunks = [];
      st.rec.ondataavailable = (e) => { if (e.data && e.data.size) st.chunks.push(e.data); };
      st.rec.onstop = finish;
      st.rec.start(500);
      st.startT = Date.now();
      // Musik zum Mithören (Kopfhörer empfohlen) – eingemischt wird sie später sauber vom Track
      if (st.target === 'reel' && st.musicBuf) { ensureMix(); mix.musicGain.gain.value = 0.7; startMusic(0); }
      // Vorschaubild für die Chat-Blase kurz nach dem Start
      setTimeout(() => { if (st && !st.poster) st.poster = posterFrom(cv); }, 400);
      $('vidTime').textContent = '0:00';
      st.timer = setInterval(() => {
        const s = (Date.now() - st.startT) / 1000;
        $('vidTime').textContent = fmt(s) + ' / ' + fmt(MAX_S);
        $('vidProg').style.width = Math.min(100, s / MAX_S * 100) + '%';
        if (s >= MAX_S) stop();
      }, 200);
      setMode('rec');
      if (st.direct) $('vidFlip').classList.add('hidden');
    }
    function stop() { if (st && st.rec && st.rec.state !== 'inactive') st.rec.stop(); }

    function posterFrom(source) {
      try {
        const w = source.width || source.videoWidth, h = source.height || source.videoHeight;
        const k = Math.min(1, 360 / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
        const d = c.toDataURL('image/jpeg', 0.7);
        return d.length <= POSTER_MAX ? d : null;
      } catch { return null; }
    }

    async function finish() {
      if (!st) return;
      clearInterval(st.timer);
      stopMusic();
      const dur = (Date.now() - st.startT) / 1000;
      const type = ((st.rec && st.rec.mimeType) || (st.chunks[0] && st.chunks[0].type) || 'video/webm').split(';')[0];
      st.rec = null;
      if (dur < 1) { toast('Zu kurz – halte die Aufnahme etwas länger'); setMode('ready'); return; }
      const blob = new Blob(st.chunks, { type });
      st.result = { blob, type, dur: Math.round(dur * 10) / 10, w: cv.width, h: cv.height, poster: st.poster || posterFrom(cv) };
      // Kamera aus, Ergebnis zeigen
      cancelAnimationFrame(st.raf);
      if (st.cam) st.cam.getTracks().forEach((t) => t.stop());
      if (st.audio) st.audio.getTracks().forEach((t) => t.stop());
      st.cam = st.audio = null;
      out.src = URL.createObjectURL(blob);
      if (mix) applyLevels();
      out.play().catch(() => {});
      setMode('done');
    }

    async function send() {
      if (!st || !st.result) return;
      const { blob, type, dur, w, h, poster } = st.result;
      const chatId = st.chatId;
      if (st.target === 'reel') {
        if (!reels.canPost()) return;
        $('vidSend').disabled = true; $('vidRetake').disabled = true; $('vidMusic').disabled = true;
        const s = st;
        let file = { blob, type };
        // Musik oder geänderte Lautstärke: Mischung in ein neues Video schreiben
        if (s.musicBuf || s.levels.voice !== 1) {
          const bar = $('vidUpload');
          bar.classList.remove('hidden');
          bar.querySelector('span').textContent = '🎵 Musik wird eingemischt…';
          try { file = await renderMix((p) => { bar.querySelector('div').style.width = Math.round(p * 100) + '%'; }); }
          catch (e) { console.error(e); toast('⚠️ Musik konnte nicht eingemischt werden'); file = null; }
          bar.classList.add('hidden');
        }
        let ok = false;
        if (file && st === s) ok = await reels.upload({ blob: file.blob, type: file.type, dur, w, h, poster, music: s.musicBuf ? s.music : null }, $('vidCaption').value);
        $('vidSend').disabled = false; $('vidRetake').disabled = false; $('vidMusic').disabled = false;
        if (ok) close();
        return;
      }
      $('vidSend').disabled = true;
      try {
        const data = await readAsDataURL(new Blob([blob], { type }));
        if (data.length > MAX_MEDIA) { toast(`⚠️ Das Video ist zu groß (max. ${MAX_MB} MB).`); $('vidSend').disabled = false; return; }
        close();
        await sendMessage(chatId, '', { kind: 'video', data, w, h, dur, poster });
      } catch (e) { console.error(e); toast('⚠️ Video konnte nicht gesendet werden.'); $('vidSend').disabled = false; }
    }

    // Nochmal: Ergebnis verwerfen und Kamera wieder an
    async function retake() {
      if (!st || st.mixing) return;
      close();
      await open(lastTarget); // neues Video = neu anfangen, auch ohne Musik
    }

    function close() {
      stopMusic();
      music.closePicker();
      if (st) {
        const s = st; st = null;
        clearInterval(s.timer);
        cancelAnimationFrame(s.raf);
        if (s.rec && s.rec.state !== 'inactive') { s.rec.onstop = null; s.rec.stop(); }
        if (s.cam) s.cam.getTracks().forEach((t) => t.stop());
        if (s.audio) s.audio.getTracks().forEach((t) => t.stop());
      }
      src.srcObject = null;
      if (out.src) { URL.revokeObjectURL(out.src); out.removeAttribute('src'); out.load(); }
      $('vidSend').disabled = false; $('vidRetake').disabled = false; $('vidMusic').disabled = false;
      ov.classList.add('hidden');
    }

    function setMode(mode) {
      ov.dataset.mode = mode; // ready | rec | done
      $('vidProg').style.width = '0%';
      if (mode !== 'rec') $('vidTime').textContent = mode === 'done' && st && st.result ? fmt(st.result.dur) : 'max. ' + fmt(MAX_S);
    }

    $('videoBtn').onclick = () => open('chat');
    $('vidClose').onclick = close;
    $('vidFlip').onclick = flip;
    $('vidShutter').onclick = () => { if (st && st.rec) stop(); else start(); };
    $('vidRetake').onclick = retake;
    $('vidSend').onclick = send;

    // ---------- In der Chat-Blase: Vorschaubild mit ▶ und Dauer ----------
    function el_(chatId, m) {
      const box = el('div', 'vid');
      const w = Math.min(220, m.media.w || 220);
      box.style.width = w + 'px';
      box.style.aspectRatio = `${m.media.w || 16} / ${m.media.h || 9}`;
      if (m.media.poster) { const img = document.createElement('img'); img.src = m.media.poster; img.alt = 'Video'; box.appendChild(img); }
      const play = el('span', 'vid-play');
      play.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-play"/></svg>';
      box.append(play, el('span', 'vid-dur', '🎥 ' + fmt(m.media.dur || 0)));
      box.onclick = () => openPlayer(chatId, m);
      return box;
    }

    function dataUrlToBlob(d) {
      const i = d.indexOf(',');
      const type = (/^data:([^;,]+)/.exec(d) || [])[1] || 'video/mp4';
      const bin = atob(d.slice(i + 1));
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      return new Blob([bytes], { type });
    }

    // Vollbild-Player
    let playerUrl = null;
    async function openPlayer(chatId, m) {
      const data = await getMedia(chatId, m.id);
      if (!data) { toast('Video nicht gefunden'); return; }
      const blob = dataUrlToBlob(data); // fetch() auf data:-URLs verbietet die Content-Security-Policy
      closePlayer();
      playerUrl = URL.createObjectURL(blob);
      const v = $('vidViewerVideo');
      v.src = playerUrl;
      const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('quicktime') ? 'mov' : 'webm';
      $('vidViewerSave').href = playerUrl;
      $('vidViewerSave').download = `whatsup-${new Date(m.ts).toISOString().slice(0, 10)}-${m.id.slice(0, 6)}.${ext}`;
      $('vidViewer').classList.remove('hidden');
      v.play().catch(() => {});
      v.onerror = () => toast('⚠️ Dieses Video kann hier nicht abgespielt werden.');
    }
    function closePlayer() {
      const v = $('vidViewerVideo');
      v.pause();
      if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
      v.removeAttribute('src'); v.load();
      $('vidViewer').classList.add('hidden');
    }
    $('vidViewerClose').onclick = closePlayer;
    $('vidViewer').onclick = (e) => { if (e.target.id === 'vidViewer') closePlayer(); };

    return {
      el: el_, close, closePlayer, record: open,
      open: () => !!st, playerOpen: () => !$('vidViewer').classList.contains('hidden'),
    };
  })();

  // ================= UpReels: öffentliche Kurzvideos für alle WhatsUp-Nutzer =================
  // Liegen auf dem Briefkasten-Server. Jede Aktion ist mit dem eigenen Schlüssel signiert.
  const reels = (() => {
    const feedEl = $('reelFeed');
    let list = [];            // angezeigte Reels
    let mode = 'feed';        // 'feed' | 'list' (Profil/Meine)
    let feedCache = null;     // Feed merken, während eine Profil-Liste offen ist
    let loading = false, done = false, loadedAt = 0;
    let admin = false;
    let muted = false;
    const viewed = new Set();
    const api = (p) => relay.url() + '/v1/reels' + p;
    const ago = (ts) => {
      const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return 'gerade eben';
      if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
      if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
      if (s < 86400 * 7) return `vor ${Math.floor(s / 86400)} T.`;
      return new Date(ts).toLocaleDateString('de-DE');
    };
    const count = (n) => (n >= 10000 ? Math.round(n / 1000) + 'K' : n >= 1000 ? (n / 1000).toFixed(1).replace('.', ',') + 'K' : String(n || 0));

    function needServer() {
      if (relay.ready()) return true;
      toast(settings.relay === false ? '⚠️ Für UpReels muss in den Einstellungen der Briefkasten-Server an sein.' : '⚠️ Server gerade nicht erreichbar. Versuch es gleich nochmal.');
      return false;
    }
    async function signedPost(path, action, extra, body) {
      const ts = Date.now();
      const sig = await relay.signText(`${action}|${me.code}|${ts}${extra}`);
      const res = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, code: me.code, ts, sig }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);
      return data;
    }

    // ---------- Laden ----------
    async function loadFeed(reset) {
      if (loading || (!reset && done)) return;
      loading = true;
      await music.catalog().catch(() => {});
      try {
        const before = !reset && list.length ? list[list.length - 1].ts : '';
        const res = await fetch(api(`/feed?limit=8&me=${me.code}${before ? '&before=' + before : ''}`));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const d = await res.json();
        admin = !!d.admin;
        const items = (d.reels || []).filter((r) => !list.some((x) => x.id === r.id) || reset);
        if (reset) { list = items; feedEl.replaceChildren(); done = false; }
        else list.push(...items);
        if (items.length < 8) done = true;
        loadedAt = Date.now();
        items.forEach((r) => feedEl.appendChild(reelEl(r)));
        renderEmpty();
      } catch (e) {
        console.warn('UpReels:', e);
        if (!list.length) renderEmpty('⚠️ UpReels konnten nicht geladen werden. Bist du online?');
      } finally { loading = false; }
    }
    function renderEmpty(msg) {
      $('reelEmpty').classList.toggle('hidden', !!list.length);
      $('reelEmpty').textContent = msg || (mode === 'feed' ? 'Noch keine UpReels. Sei der Erste und poste eins! 🎬' : 'Hier gibt es noch keine UpReels.');
    }

    function openFeed() {
      if (mode !== 'feed') {
        mode = 'feed';
        $('reelBack').classList.add('hidden');
        $('reelTitle').textContent = 'UpReels';
        if (feedCache) { list = feedCache.list; done = feedCache.done; feedEl.replaceChildren(...list.map(reelEl)); feedCache = null; renderEmpty(); }
      }
      if (!list.length || Date.now() - loadedAt > 60000) { feedEl.scrollTop = 0; loadFeed(true); }
      else setTimeout(playVisible, 50);
    }
    // Reels eines Nutzers (Profil oder „Meine“)
    async function openUser(code, name) {
      if (mode === 'feed') feedCache = { list, done };
      mode = 'list';
      list = []; done = true;
      feedEl.replaceChildren();
      $('reelTitle').textContent = code === me.code ? 'Meine UpReels' : `UpReels von ${name || nameOf(code)}`;
      $('reelBack').classList.remove('hidden');
      show('viewReels');
      try {
        const d = await (await fetch(api(`/user/${code}?me=${me.code}`))).json();
        list = d.reels || [];
        list.forEach((r) => feedEl.appendChild(reelEl(r)));
      } catch { toast('⚠️ Konnte nicht geladen werden'); }
      renderEmpty();
      feedEl.scrollTop = 0;
      setTimeout(playVisible, 50);
    }

    // ---------- Ein Reel ----------
    function reelEl(r) {
      const item = el('div', 'reel');
      item.dataset.id = r.id;
      // Querformat ganz zeigen; die Ränder füllt eine unscharfe, dunkle Version des Vorschaubilds. Hochkant füllt den Bereich.
      if (r.w > r.h) {
        item.classList.add('landscape');
        if (r.poster) item.style.setProperty('--poster', `url("${r.poster}")`);
      }
      const v = document.createElement('video');
      v.className = 'reel-video';
      v.playsInline = true; v.loop = true; v.preload = 'none';
      v.setAttribute('playsinline', '');
      if (r.poster) v.poster = r.poster;
      v.dataset.src = api('/video/' + r.id);
      item.appendChild(v);

      const heart = el('div', 'reel-heart', '❤️');
      item.appendChild(heart);
      const pauseIc = el('div', 'reel-paused', '▶');
      item.appendChild(pauseIc);

      // Tippen = Pause/Weiter, doppelt tippen = Like
      let lastTap = 0, tapTimer = null;
      v.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 300) {
          clearTimeout(tapTimer); lastTap = 0;
          if (!r.liked) toggleLike(r, item);
          heart.classList.remove('pop'); void heart.offsetWidth; heart.classList.add('pop');
          return;
        }
        lastTap = now;
        tapTimer = setTimeout(() => {
          if (v.paused) { v.play().catch(() => {}); item.classList.remove('paused'); }
          else { v.pause(); item.classList.add('paused'); }
        }, 300);
      });

      // Unten links: wer, wann, Beschreibung
      const info = el('div', 'reel-info');
      const who = el('button', 'reel-who');
      who.type = 'button';
      const c = contacts[r.author];
      who.append(avatarEl(r.name, c && c.avatar, r.author, 'sm', null, c && c.frame), el('span', 'reel-name', r.author === me.code ? 'Du' : r.name), el('span', 'reel-ago', '· ' + ago(r.ts)));
      who.onclick = () => openProfile(r.author, r.name);
      info.appendChild(who);
      if (r.caption) info.appendChild(el('div', 'reel-caption', r.caption));
      if (r.music) {
        const t = music.track(r.music.id);
        const snd = el('button', 'reel-sound');
        snd.type = 'button';
        snd.append(el('span', 'reel-sound-ic', '🎵'), el('span', 'reel-sound-t', t ? t.title + ' · ' + t.artist : 'Musik'));
        snd.onclick = () => openSound(r.music);
        info.appendChild(snd);
        if (!t) music.catalog().then(() => { const tt = music.track(r.music.id); if (tt) snd.lastChild.textContent = tt.title + ' · ' + tt.artist; }).catch(() => {});
      } else {
        const snd = el('div', 'reel-sound plain');
        snd.append(el('span', 'reel-sound-ic', '🎤'), el('span', 'reel-sound-t', 'Originalton'));
        info.appendChild(snd);
      }
      item.appendChild(info);

      // Rechts: Like, Kommentare, Aufrufe, Mehr
      const side = el('div', 'reel-side');
      const btn = (cls, icon, n, title) => {
        const b = el('button', 'reel-btn ' + cls);
        b.type = 'button'; b.title = title;
        b.append(el('span', 'reel-btn-ic', icon), el('span', 'reel-btn-n', n));
        side.appendChild(b);
        return b;
      };
      const likeB = btn('like' + (r.liked ? ' on' : ''), r.liked ? '❤️' : '🤍', count(r.likes), 'Gefällt mir');
      likeB.onclick = () => toggleLike(r, item);
      btn('comments', '💬', count(r.comments), 'Kommentare').onclick = () => openComments(r, item);
      const viewsB = btn('views', '👀', count(r.views), r.author === me.code ? 'Wer hat es gesehen?' : 'Aufrufe');
      viewsB.onclick = () => { if (r.author === me.code || admin) openViewers(r); else toast(`👀 ${r.views} ${r.views === 1 ? 'Aufruf' : 'Aufrufe'}`); };
      btn('more', '⋯', '', 'Mehr').onclick = () => openMore(r, item);
      item.appendChild(side);

      const mute = el('button', 'reel-mute', muted ? '🔇' : '🔊');
      mute.type = 'button'; mute.title = 'Ton an/aus';
      mute.onclick = () => { muted = !muted; document.querySelectorAll('.reel-video').forEach((x) => { x.muted = muted; }); document.querySelectorAll('.reel-mute').forEach((x) => { x.textContent = muted ? '🔇' : '🔊'; }); };
      item.appendChild(mute);
      item._reel = r;
      return item;
    }
    function updateItem(r, item) {
      if (!item) return;
      const like = item.querySelector('.reel-btn.like');
      like.classList.toggle('on', !!r.liked);
      like.querySelector('.reel-btn-ic').textContent = r.liked ? '❤️' : '🤍';
      like.querySelector('.reel-btn-n').textContent = count(r.likes);
      item.querySelector('.reel-btn.comments .reel-btn-n').textContent = count(r.comments);
      item.querySelector('.reel-btn.views .reel-btn-n').textContent = count(r.views);
    }

    // ---------- Abspielen: nur das sichtbare Reel ----------
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { e.target.dataset.vis = e.isIntersecting && e.intersectionRatio >= 0.6 ? '1' : ''; });
      playVisible();
    }, { root: feedEl, threshold: [0, 0.6, 1] });
    new MutationObserver(() => feedEl.querySelectorAll('.reel:not([data-obs])').forEach((x) => { x.dataset.obs = '1'; io.observe(x); }))
      .observe(feedEl, { childList: true });

    let viewTimer = null;
    function playVisible() {
      if (view !== 'viewReels' || document.hidden) { pauseAll(); return; }
      const items = [...feedEl.querySelectorAll('.reel')];
      const cur = items.find((x) => x.dataset.vis === '1');
      items.forEach((x) => {
        const v = x.querySelector('video');
        if (x !== cur) { if (!v.paused) v.pause(); return; }
        if (!v.src) v.src = v.dataset.src;
        v.muted = muted;
        if (!x.classList.contains('paused')) {
          v.play().catch(() => {
            // Ton ohne Antippen nicht erlaubt (iPhone): stumm starten
            muted = true; v.muted = true;
            document.querySelectorAll('.reel-mute').forEach((m) => { m.textContent = '🔇'; });
            v.play().catch(() => {});
          });
        }
      });
      // Nächstes Video schon vorladen
      const i = items.indexOf(cur);
      const next = items[i + 1] && items[i + 1].querySelector('video');
      if (next && !next.src) { next.preload = 'auto'; next.src = next.dataset.src; }
      // Aufruf zählen, wenn man es 1,5 s gesehen hat
      clearTimeout(viewTimer);
      if (cur) viewTimer = setTimeout(() => countView(cur._reel, cur), 1500);
      // Kurz vor dem Ende nachladen
      if (mode === 'feed' && i >= items.length - 3) loadFeed(false);
    }
    function pauseAll() { feedEl.querySelectorAll('video').forEach((v) => { if (!v.paused) v.pause(); }); }
    document.addEventListener('visibilitychange', () => { if (view === 'viewReels') playVisible(); });

    async function countView(r, item) {
      if (!r || r.author === me.code || viewed.has(r.id) || !relay.ready()) return;
      viewed.add(r.id);
      try { await signedPost('/view', 'reelview', `|${r.id}`, { id: r.id, name: me.name }); r.views++; updateItem(r, item); } catch {}
    }

    async function toggleLike(r, item) {
      if (!needServer()) return;
      const on = !r.liked;
      r.liked = on; r.likes = Math.max(0, r.likes + (on ? 1 : -1)); updateItem(r, item);
      try { const d = await signedPost('/like', 'reellike', `|${r.id}|${on ? 1 : 0}`, { id: r.id, on }); r.likes = d.likes; r.liked = d.liked; }
      catch { r.liked = !on; r.likes = Math.max(0, r.likes + (on ? -1 : 1)); toast('⚠️ Hat nicht geklappt'); }
      updateItem(r, item);
    }

    // ---------- Unteres Blatt (Kommentare, Aufrufe, Mehr) ----------
    function sheet(title, build) {
      closeSheet();
      const back = el('div', 'reel-sheet-back');
      back.id = 'reelSheet';
      const box = el('div', 'reel-sheet');
      const head = el('div', 'reel-sheet-head');
      const x = el('button', 'ic', '');
      x.type = 'button'; x.innerHTML = '<svg><use href="#i-x"/></svg>'; x.title = 'Schließen';
      x.onclick = closeSheet;
      head.append(el('h3', '', title), x);
      box.appendChild(head);
      back.appendChild(box);
      back.onclick = (e) => { if (e.target === back) closeSheet(); };
      document.body.appendChild(back);
      build(box);
      return box;
    }
    function closeSheet() { const s = $('reelSheet'); if (s) s.remove(); }

    async function openComments(r, item) {
      sheet('Kommentare', async (box) => {
        const ul = el('ul', 'reel-comments');
        ul.appendChild(el('li', 'muted center', 'Wird geladen…'));
        const form = el('form', 'reel-comment-form');
        const input = el('input');
        input.placeholder = 'Kommentar schreiben…'; input.maxLength = 300;
        const send = el('button', 'send');
        send.type = 'submit'; send.innerHTML = '<svg><use href="#i-send"/></svg>';
        form.append(input, send);
        box.append(ul, form);
        const draw = (comments) => {
          ul.replaceChildren();
          if (!comments.length) ul.appendChild(el('li', 'muted center', 'Noch keine Kommentare. Schreib den ersten!'));
          comments.forEach((c) => {
            const li = el('li', 'reel-comment');
            li.appendChild(avatarEl(c.name, contacts[c.code] && contacts[c.code].avatar, c.code, 'sm'));
            const body = el('div', 'reel-comment-body');
            const head = el('div', 'reel-comment-head');
            head.append(el('b', '', c.code === me.code ? 'Du' : c.name), el('span', 'muted', ' · ' + ago(c.ts)));
            body.append(head, el('div', 'reel-comment-text', c.text));
            li.appendChild(body);
            if (c.code === me.code || r.author === me.code || admin) {
              const del = el('button', 'ic reel-comment-del');
              del.type = 'button'; del.title = 'Kommentar löschen'; del.innerHTML = '<svg><use href="#i-trash"/></svg>';
              del.onclick = async () => {
                if (!confirm('Kommentar löschen?')) return;
                try { await signedPost('/uncomment', 'reeluncomment', `|${r.id}|${c.id}`, { id: r.id, cid: c.id }); r.comments = Math.max(0, r.comments - 1); updateItem(r, item); load(); }
                catch { toast('⚠️ Konnte nicht gelöscht werden'); }
              };
              li.appendChild(del);
            }
            ul.appendChild(li);
          });
          ul.scrollTop = ul.scrollHeight;
        };
        const load = async () => {
          try { const d = await (await fetch(api('/comments/' + r.id))).json(); r.comments = (d.comments || []).length; updateItem(r, item); draw(d.comments || []); }
          catch { ul.replaceChildren(el('li', 'muted center', '⚠️ Konnte nicht geladen werden')); }
        };
        form.onsubmit = async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text || !needServer()) return;
          send.disabled = true;
          try {
            await signedPost('/comment', 'reelcomment', `|${r.id}|${text}`, { id: r.id, text, name: me.name });
            input.value = '';
            await load();
          } catch (err) { toast(err.message === 'slow down' ? '⚠️ Nicht so schnell 🙂' : '⚠️ Kommentar konnte nicht gesendet werden'); }
          send.disabled = false;
        };
        load();
        if (!window.matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50);
      });
    }

    async function openViewers(r) {
      sheet(`👀 ${r.views} ${r.views === 1 ? 'Aufruf' : 'Aufrufe'}`, async (box) => {
        const ul = el('ul', 'reel-comments');
        ul.appendChild(el('li', 'muted center', 'Wird geladen…'));
        box.appendChild(ul);
        try {
          const d = await signedPost('/viewers', 'reelviewers', `|${r.id}`, { id: r.id });
          ul.replaceChildren();
          if (!d.viewers.length) ul.appendChild(el('li', 'muted center', 'Noch hat es niemand gesehen.'));
          d.viewers.forEach((v) => {
            const li = el('li', 'reel-comment');
            li.append(avatarEl(v.name, contacts[v.code] && contacts[v.code].avatar, v.code, 'sm'));
            const body = el('div', 'reel-comment-body');
            body.append(el('b', '', v.name), el('div', 'muted', ago(v.ts)));
            li.appendChild(body);
            ul.appendChild(li);
          });
        } catch { ul.replaceChildren(el('li', 'muted center', '⚠️ Konnte nicht geladen werden')); }
      });
    }

    function openMore(r, item) {
      sheet('UpReel', (box) => {
        const act = (label, icon, fn, cls = '') => {
          const b = el('button', 'menu-item ' + cls);
          b.type = 'button';
          b.append(el('span', 'menu-ic', icon), el('span', '', label));
          b.onclick = fn;
          box.appendChild(b);
        };
        if (r.author !== me.code) act('Profil ansehen', '👤', () => { closeSheet(); openProfile(r.author, r.name); });
        if (r.author !== me.code) act('Melden', '🚩', () => { closeSheet(); report(r, item); }, 'danger');
        if (r.author === me.code || admin) act(r.author === me.code ? 'Löschen' : 'Löschen (Admin)', '🗑️', async () => {
          if (!confirm('Dieses UpReel für alle löschen?')) return;
          try {
            await signedPost('/delete', 'reeldelete', `|${r.id}`, { id: r.id });
            closeSheet(); removeItem(r.id); toast('UpReel gelöscht');
          } catch { toast('⚠️ Konnte nicht gelöscht werden'); }
        }, 'danger');
      });
    }
    function removeItem(id) {
      list = list.filter((x) => x.id !== id);
      const it = feedEl.querySelector(`.reel[data-id="${id}"]`);
      if (it) { const v = it.querySelector('video'); v.pause(); v.removeAttribute('src'); it.remove(); }
      renderEmpty();
      setTimeout(playVisible, 50);
    }
    function report(r, item) {
      sheet('Warum meldest du das?', (box) => {
        ['Nacktheit oder sexuelle Inhalte', 'Gewalt oder Bedrohung', 'Mobbing oder Belästigung', 'Hass oder Beleidigung', 'Spam', 'Etwas anderes'].forEach((reason) => {
          const b = el('button', 'menu-item', reason);
          b.type = 'button';
          b.onclick = async () => {
            if (!needServer()) return;
            try { await signedPost('/report', 'reelreport', `|${r.id}`, { id: r.id, reason }); closeSheet(); removeItem(r.id); toast('Danke! Das UpReel wurde gemeldet und wird dir nicht mehr angezeigt.'); }
            catch { toast('⚠️ Melden hat nicht geklappt'); }
          };
          box.appendChild(b);
        });
      });
    }

    // ---------- Sound: wer hat ihn benutzt, selbst benutzen ----------
    async function openSound(m) {
      let t = music.track(m.id);
      if (!t) { await music.catalog().catch(() => {}); t = music.track(m.id); }
      let node = null;
      const stopNode = () => { if (node) { try { node.stop(); } catch {} node = null; } };
      sheet('🎵 Sound', (box) => {
        const head = el('div', 'snd-head');
        const play = el('button', 'mus-play big', '▶');
        play.type = 'button'; play.title = 'Anhören';
        play.onclick = async () => {
          if (node) { stopNode(); play.textContent = '▶'; return; }
          play.textContent = '…';
          try {
            const buf = await music.buffer(m.id);
            const n = music.ctx().createBufferSource(); n.buffer = buf; n.connect(music.ctx().destination);
            n.start(0, m.start || 0, 15); node = n; play.textContent = '■';
            n.onended = () => { if (node === n) { node = null; play.textContent = '▶'; } };
          } catch { play.textContent = '▶'; toast('⚠️ Konnte nicht geladen werden'); }
        };
        const meta = el('div', 'mus-meta');
        meta.append(el('div', 'mus-name', t ? t.title : 'Musik'), el('div', 'muted', (t ? t.artist + ' · ' : '') + 'Ausschnitt ab ' + music.fmt(m.start || 0)));
        head.append(play, meta);
        box.appendChild(head);
        const use = el('button', 'primary snd-use', '🎬 Sound benutzen');
        use.type = 'button';
        use.onclick = () => { stopNode(); closeSheet(); post({ music: m }); };
        box.appendChild(use);
        const cnt = el('div', 'rare-ach-title snd-count', 'UpReels mit diesem Sound');
        const grid = el('div', 'reel-grid');
        box.append(cnt, grid);
        if (t) box.appendChild(el('div', 'mus-credit', music.credit(t) + ' · gekürzt, mit Stimme gemischt'));
        fetch(api('/sound/' + m.id + '?me=' + me.code)).then((r) => r.json()).then((d) => {
          cnt.textContent = d.count + (d.count === 1 ? ' UpReel' : ' UpReels') + ' mit diesem Sound';
          (d.reels || []).forEach((r) => {
            const th = el('button', 'reel-thumb');
            th.type = 'button';
            if (r.poster) th.style.backgroundImage = 'url("' + r.poster + '")';
            th.appendChild(el('span', '', '▶ ' + count(r.views)));
            th.onclick = () => { stopNode(); closeSheet(); openList(d.reels, r.id, '🎵 ' + (t ? t.title : 'Sound')); };
            grid.appendChild(th);
          });
        }).catch(() => {});
      });
      // Beim Schließen des Blatts Vorhören stoppen
      const obs = new MutationObserver(() => { if (!$('reelSheet')) { stopNode(); obs.disconnect(); } });
      obs.observe(document.body, { childList: true });
    }
    // Beliebige Liste von Reels als eigenen Feed zeigen (z. B. alle mit einem Sound)
    function openList(items, startId, title) {
      if (mode === 'feed') feedCache = { list, done };
      mode = 'list';
      list = items.slice(); done = true;
      feedEl.replaceChildren(...list.map(reelEl));
      $('reelTitle').textContent = title;
      $('reelBack').classList.remove('hidden');
      show('viewReels');
      renderEmpty();
      const target = feedEl.querySelector('.reel[data-id="' + startId + '"]');
      feedEl.scrollTop = target ? target.offsetTop : 0;
      setTimeout(playVisible, 80);
    }
    function canPost() { return needServer(); }

    // ---------- Posten ----------
    function post(opts = {}) {
      if (!needServer()) return;
      if (!store.load('reelsRulesOk', false)) {
        openModal((box) => {
          box.appendChild(el('h3', '', '🎬 UpReels sind öffentlich'));
          box.appendChild(el('p', 'muted', 'Alle WhatsUp-Nutzer können deine UpReels sehen, liken und kommentieren – nicht nur deine Freunde. Dein Name und dein Code werden angezeigt.'));
          box.appendChild(el('p', 'muted', 'Poste nichts, was andere verletzt, und keine Videos von Leuten, die das nicht wollen. Gemeldete UpReels werden ausgeblendet.'));
          box.appendChild(buttons(['Abbrechen', 'ghost', closeModal], ['Verstanden', 'primary', () => { store.save('reelsRulesOk', true); closeModal(); video.record('reel', opts); }]));
        });
        return;
      }
      video.record('reel', opts);
    }

    // Hochladen mit Fortschritt. true = geklappt
    async function upload(res, caption) {
      if (!needServer()) return false;
      const bytes = new Uint8Array(await res.blob.arrayBuffer());
      const meta = new TextEncoder().encode(JSON.stringify({ type: res.type, dur: res.dur, w: res.w, h: res.h, poster: res.poster, caption: String(caption || '').trim().slice(0, 150), name: me.name, music: res.music || null }));
      const body = new Uint8Array(4 + meta.length + bytes.length);
      new DataView(body.buffer).setUint32(0, meta.length);
      body.set(meta, 4);
      body.set(bytes, 4 + meta.length);
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', body))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const ts = Date.now();
      const sig = await relay.signText(`reelup|${me.code}|${ts}|${digest}`);
      const prog = $('vidUpload');
      prog.querySelector('span').textContent = 'Wird hochgeladen…';
      prog.classList.remove('hidden');
      const bar = prog.querySelector('div');
      bar.style.width = '0%';
      const result = await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.open('POST', api('/upload'));
        x.setRequestHeader('Content-Type', 'application/octet-stream');
        x.setRequestHeader('X-From', me.code);
        x.setRequestHeader('X-Ts', String(ts));
        x.setRequestHeader('X-Sig', sig);
        x.upload.onprogress = (e) => { if (e.lengthComputable) bar.style.width = Math.round(e.loaded / e.total * 100) + '%'; };
        x.onload = () => { let d = {}; try { d = JSON.parse(x.responseText); } catch {} resolve(x.status === 200 ? d : { error: d.error || 'HTTP ' + x.status }); };
        x.onerror = () => resolve({ error: 'Keine Verbindung' });
        x.send(body);
      });
      prog.classList.add('hidden');
      if (result.error) { toast('⚠️ ' + (result.error.length < 80 ? result.error : 'Hochladen fehlgeschlagen')); return false; }
      stats.reels = (stats.reels || 0) + 1; saveMeta();
      toast('🎬 UpReel gepostet!', true);
      // Feed neu laden: das eigene Reel steht oben
      mode = 'feed'; feedCache = null;
      $('reelBack').classList.add('hidden');
      $('reelTitle').textContent = 'UpReels';
      show('viewReels');
      await loadFeed(true);
      feedEl.scrollTop = 0;
      setTimeout(playVisible, 100);
      return true;
    }

    $('reelPost').onclick = () => post();
    $('reelMine').onclick = () => openUser(me.code, me.name);
    $('reelBack').onclick = openFeed;
    feedEl.addEventListener('scroll', () => { clearTimeout(feedEl._t); feedEl._t = setTimeout(playVisible, 120); }, { passive: true });

    // Profil eines Freundes: kleine Vorschau seiner UpReels
    function profileSection(code, name) {
      const wrap = el('div', 'rare-ach reel-profile hidden');
      wrap.appendChild(el('div', 'rare-ach-title', 'UpReels'));
      const grid = el('div', 'reel-grid');
      wrap.appendChild(grid);
      fetch(api(`/user/${code}?me=${me.code}`)).then((r) => r.json()).then((d) => {
        const rs = d.reels || [];
        if (!rs.length) return;
        wrap.classList.remove('hidden');
        rs.slice(0, 6).forEach((r) => {
          const t = el('button', 'reel-thumb');
          t.type = 'button';
          if (r.poster) t.style.backgroundImage = `url("${r.poster}")`;
          t.appendChild(el('span', '', '▶ ' + count(r.views)));
          t.onclick = () => { closeModal(); openUser(code, name); };
          grid.appendChild(t);
        });
        if (rs.length > 6) {
          const more = el('button', 'link rare-more', `Alle ${rs.length} ansehen`);
          more.type = 'button';
          more.onclick = () => { closeModal(); openUser(code, name); };
          wrap.appendChild(more);
        }
      }).catch(() => {});
      return wrap;
    }

    return { openFeed, upload, pauseAll, playVisible, profileSection, closeSheet, canPost, sheetOpen: () => !!$('reelSheet') };
  })();

  // ================= Anrufe (Audio & Video, direkt über WebRTC, Ende-zu-Ende verschlüsselt) =================
  // Signalisierung über PeerJS (peer.call), Steuerbefehle (Auflegen, Ablehnen, Kamera aus) über die Chat-Verbindung.
  const calls = (() => {
    const RING_MS = 45000;
    let cur = null;
    // cur = { id, code, video, dir: 'out'|'in', state: 'calling'|'ringing'|'connecting'|'active', mc, local, remote,
    //         start, tick, ringTimer, lostTimer, muted, camOn, facing, camIdx, swapped, remoteCam }
    const box = $('callView');
    const remoteEl = $('callRemote'), localEl = $('callLocal'), localWrap = $('callLocalWrap');
    const isMobile = () => window.matchMedia('(pointer: coarse)').matches;
    const hasMedia = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const kindText = (video) => (video ? '🎥 Videoanruf' : '📞 Anruf');
    const fmtDur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
    const stopStream = (s) => { if (s) s.getTracks().forEach((t) => t.stop()); };

    // ---------- Töne (ohne Audiodateien) ----------
    let actx = null, toneTimer = null;
    function beep(freqs, dur, vol) {
      try {
        actx = actx || new AudioContext();
        if (actx.state === 'suspended') actx.resume();
        const t = actx.currentTime;
        freqs.forEach((f, i) => {
          const o = actx.createOscillator(), g = actx.createGain();
          o.type = 'sine'; o.frequency.value = f;
          const st = t + i * dur;
          g.gain.setValueAtTime(0.0001, st);
          g.gain.exponentialRampToValueAtTime(vol, st + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, st + dur);
          o.connect(g).connect(actx.destination);
          o.start(st); o.stop(st + dur + 0.05);
        });
      } catch {}
    }
    function startTone(incoming) {
      stopTone();
      const play = incoming ? () => beep([659, 784, 988, 784], 0.16, 0.18) : () => beep([440], 0.9, 0.06);
      play();
      toneTimer = setInterval(play, incoming ? 2200 : 3500);
    }
    function stopTone() { clearInterval(toneTimer); toneTimer = null; }

    // ---------- Kamera & Mikrofon ----------
    async function getStream(video, facing = 'user') {
      const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
      if (!video) return navigator.mediaDevices.getUserMedia({ audio });
      try {
        return await navigator.mediaDevices.getUserMedia({ audio, video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch (e) {
        if (e && e.name === 'NotAllowedError') throw e;
        return navigator.mediaDevices.getUserMedia({ audio }); // keine Kamera: nur mit Ton
      }
    }
    function mediaError(e) {
      const n = e && e.name;
      if (n === 'NotAllowedError') toast('⚠️ Kein Zugriff auf Mikrofon/Kamera. Bitte in den Einstellungen erlauben.');
      else if (n === 'NotFoundError') toast('⚠️ Kein Mikrofon gefunden.');
      else if (n === 'NotReadableError') toast('⚠️ Mikrofon/Kamera wird gerade von einem anderen Programm benutzt.');
      else toast('⚠️ Mikrofon/Kamera konnte nicht gestartet werden.');
    }
    async function videoInputs() {
      try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch { return []; }
    }

    // ---------- Oberfläche ----------
    function openUI() {
      const c = contacts[cur.code] || {};
      $('callAvatar').replaceChildren(avatarEl(c.name, c.avatar, cur.code));
      $('callName').textContent = nameOf(cur.code);
      $('callAcceptIcon').setAttribute('href', cur.video ? '#i-video' : '#i-phone');
      box.className = 'call opening' + (cur.video ? '' : ' audio');
      setTimeout(() => box.classList.remove('opening'), 250);
      localWrap.classList.add('hidden');
      localWrap.style.left = localWrap.style.top = localWrap.style.right = '';
      remoteEl.srcObject = null;
      $('callIncoming').classList.toggle('hidden', cur.dir !== 'in');
      $('callControls').classList.toggle('hidden', cur.dir === 'in');
      renderButtons();
      hideEmoji();
    }
    function setState(text) { $('callState').textContent = text; }
    function renderButtons() {
      if (!cur) return;
      const mute = $('callMute'), cam = $('callCam');
      mute.classList.toggle('off', cur.muted);
      mute.querySelector('use').setAttribute('href', cur.muted ? '#i-mic-off' : '#i-mic');
      mute.title = cur.muted ? 'Stummschaltung aufheben' : 'Stummschalten';
      cam.classList.toggle('off', !cur.camOn);
      cam.querySelector('use').setAttribute('href', cur.camOn ? '#i-video' : '#i-video-off');
      cam.title = cur.camOn ? 'Kamera aus' : 'Kamera an';
      localWrap.classList.toggle('cam-off', !cur.camOn);
    }
    // Großes Bild: Video des anderen (oder eigenes, wenn getauscht); sonst Profilbild
    function renderVideo() {
      if (!cur) return;
      const remoteHasVideo = !!(cur.remote && cur.remote.getVideoTracks().length && cur.remoteCam !== false);
      const localHasVideo = !!(cur.local && cur.local.getVideoTracks().length);
      const big = cur.swapped ? (localHasVideo ? cur.local : null) : (remoteHasVideo ? cur.remote : null);
      const small = cur.swapped ? (remoteHasVideo ? cur.remote : null) : (localHasVideo ? cur.local : null);
      // Ton des anderen läuft immer über das große Element (stumm, wenn es das eigene Bild zeigt)
      if (!cur.swapped) { if (remoteEl.srcObject !== cur.remote) remoteEl.srcObject = cur.remote || null; }
      else if (remoteEl.srcObject !== cur.local) remoteEl.srcObject = cur.local;
      remoteEl.muted = !!cur.swapped;
      if (cur.swapped && cur.remote) playAudioOnly(cur.remote); else playAudioOnly(null);
      remoteEl.classList.toggle('mirror', !!cur.swapped && cur.facing === 'user');
      box.classList.toggle('has-video', !!big);
      if (localEl.srcObject !== small) localEl.srcObject = small;
      localWrap.classList.toggle('hidden', !cur.video || !small);
      localWrap.classList.toggle('mirror', !cur.swapped && cur.facing === 'user');
      remoteEl.play().catch(() => {});
      localEl.play().catch(() => {});
    }
    // Beim Tauschen läuft der Ton des anderen über ein unsichtbares Audio-Element
    let audioEl = null;
    function playAudioOnly(stream) {
      if (!stream) { if (audioEl) { audioEl.srcObject = null; } return; }
      audioEl = audioEl || Object.assign(document.createElement('audio'), { autoplay: true });
      if (audioEl.srcObject !== stream) { audioEl.srcObject = stream; audioEl.play().catch(() => {}); }
    }

    // ---------- Ablauf ----------
    async function start(code, video) {
      if (cur) return;
      if (!hasMedia()) { toast('⚠️ Anrufe werden hier nicht unterstützt.'); return; }
      if (!peer || !peer.open) { toast('⚠️ Keine Verbindung zum Netzwerk.'); return; }
      if (!isFriend(code)) return;
      cur = { id: crypto.randomUUID(), code, video, dir: 'out', state: 'calling', muted: false, camOn: video, facing: 'user', camIdx: 0 };
      const me_ = cur;
      openUI();
      setState('Kamera und Mikrofon werden gestartet…');
      try { cur.local = await getStream(video); }
      catch (e) { mediaError(e); cur = null; closeUI(0); return; }
      if (cur !== me_) { stopStream(me_.local); return; } // inzwischen abgebrochen
      cur.camOn = video && cur.local.getVideoTracks().length > 0;
      renderVideo(); renderButtons(); checkFlip();
      setState('Ruft an…');
      connectTo(code);
      const mc = peer.call(peerIdOf(code), cur.local, { metadata: { callId: cur.id, video } });
      if (!mc) { end('unreachable'); return; }
      bind(mc);
      startTone(false);
      cur.ringTimer = setTimeout(() => { if (cur === me_ && cur.state !== 'active') end('noanswer'); }, RING_MS);
      stats.calls = (stats.calls || 0) + 1;
      saveMeta(); checkAchievements();
    }

    function bind(mc) {
      cur.mc = mc;
      const c = cur;
      mc.on('stream', (remote) => {
        if (cur !== c) return;
        cur.remote = remote;
        remote.onaddtrack = () => renderVideo();
        if (cur.state !== 'active') active();
        renderVideo();
      });
      mc.on('close', () => { if (cur === c) end(cur.state === 'ringing' ? 'canceled' : 'remote'); });
      mc.on('error', () => { if (cur === c) end('error'); });
      watchIce(mc, c);
    }
    function watchIce(mc, c) {
      const pc = mc.peerConnection;
      if (!pc) { setTimeout(() => { if (cur === c && mc.peerConnection) watchIce(mc, c); }, 300); return; }
      pc.addEventListener('iceconnectionstatechange', () => {
        if (cur !== c) return;
        const s = pc.iceConnectionState;
        if (s === 'failed') end('lost');
        else if (s === 'disconnected') {
          if (c.state === 'active') setState('Verbindung wird wiederhergestellt…');
          clearTimeout(c.lostTimer);
          c.lostTimer = setTimeout(() => { if (cur === c && pc.iceConnectionState !== 'connected' && pc.iceConnectionState !== 'completed') end('lost'); }, 10000);
        } else if (s === 'connected' || s === 'completed') clearTimeout(c.lostTimer);
      });
    }
    function active() {
      cur.state = 'active';
      cur.start = Date.now();
      clearTimeout(cur.ringTimer);
      stopTone();
      box.classList.remove('ringing-in');
      $('callIncoming').classList.add('hidden');
      $('callControls').classList.remove('hidden');
      const c = cur;
      const upd = () => { if (cur === c && cur.state === 'active') setState(fmtDur(Date.now() - c.start)); };
      upd();
      cur.tick = setInterval(upd, 1000);
    }

    function incoming(mc) {
      const code = codeOf(mc.peer);
      const meta = mc.metadata || {};
      if (!CODE_RE.test(code) || !isFriend(code) || blocked.includes(code)) { mc.close(); return; }
      const callId = String(meta.callId || '').slice(0, 64);
      if (cur) {
        // Besetzt
        sendTo(code, { type: 'call-reject', callId, busy: true });
        setTimeout(() => { try { mc.close(); } catch {} }, 800);
        systemMessage('u:' + code, `${kindText(!!meta.video)} verpasst (du warst in einem anderen Anruf)`);
        unread['u:' + code] = (unread['u:' + code] || 0) + 1;
        saveMeta(); scheduleRender();
        return;
      }
      cur = { id: callId, code, video: !!meta.video, dir: 'in', state: 'ringing', mc, muted: false, camOn: !!meta.video, facing: 'user', camIdx: 0 };
      const c = cur;
      openUI();
      box.classList.add('ringing-in');
      setState(cur.video ? 'Videoanruf …' : 'Anruf …');
      startTone(true);
      mc.on('close', () => { if (cur === c && cur.state === 'ringing') end('canceled'); });
      cur.ringTimer = setTimeout(() => { if (cur === c && cur.state === 'ringing') end('missed'); }, RING_MS + 5000);
      // Fenster nach vorne holen bzw. Benachrichtigung zeigen
      window.chatboxWindow.attention && window.chatboxWindow.attention();
      if (document.hidden || !document.hasFocus()) {
        notifyCall(code, cur.video);
      }
    }
    function notifyCall(code, video) {
      if (!settings.notify) return;
      const icon = contacts[code] && contacts[code].avatar;
      const send = (ic) => window.chatboxWindow.notify({ title: nameOf(code), body: video ? '🎥 Videoanruf …' : '📞 Ruft dich an …', icon: ic, silent: true });
      if (icon) toPng(icon).then(send, () => send(null)); else send(null);
    }

    async function accept() {
      if (!cur || cur.dir !== 'in' || cur.state !== 'ringing') return;
      const c = cur;
      stopTone();
      clearTimeout(cur.ringTimer);
      cur.state = 'connecting';
      box.classList.remove('ringing-in');
      $('callIncoming').classList.add('hidden');
      $('callControls').classList.remove('hidden');
      setState('Verbinde …');
      try { cur.local = await getStream(cur.video); }
      catch (e) { mediaError(e); if (cur === c) decline(); return; }
      if (cur !== c) { stopStream(c.local); return; }
      cur.camOn = cur.video && cur.local.getVideoTracks().length > 0;
      renderVideo(); renderButtons(); checkFlip();
      bind(cur.mc);
      cur.mc.answer(cur.local);
      watchIce(cur.mc, c);
      stats.calls = (stats.calls || 0) + 1;
      saveMeta(); checkAchievements();
    }
    function decline() {
      if (!cur) return;
      sendTo(cur.code, { type: 'call-reject', callId: cur.id });
      end('declined');
    }

    // Anruf beenden und im Chat vermerken
    function end(reason) {
      if (!cur) return;
      const c = cur;
      cur = null;
      clearTimeout(c.ringTimer); clearTimeout(c.lostTimer); clearInterval(c.tick);
      stopTone();
      if (!['remote', 'canceled', 'rejected', 'busy', 'declined', 'unreachable'].includes(reason)) sendTo(c.code, { type: 'call-end', callId: c.id });
      try { if (c.mc) c.mc.close(); } catch {}
      stopStream(c.local);
      playAudioOnly(null);
      remoteEl.srcObject = null; localEl.srcObject = null;
      const chatId = 'u:' + c.code, kind = kindText(c.video);
      let msg = null, shown = 'Anruf beendet';
      if (c.start) msg = `${kind} · ${fmtDur(Date.now() - c.start)}`;
      else if (c.dir === 'in') {
        if (reason === 'declined') { msg = `${kind} abgelehnt`; shown = 'Abgelehnt'; }
        else {
          msg = `${kind} verpasst`;
          unread[chatId] = (unread[chatId] || 0) + 1;
          if (document.hidden || !document.hasFocus()) notify(nameOf(c.code), `Verpasster ${c.video ? 'Videoanruf' : 'Anruf'}`, { chatId, icon: contacts[c.code] && contacts[c.code].avatar });
        }
      } else {
        const t = { rejected: 'abgelehnt', busy: 'besetzt', noanswer: 'nicht angenommen', unreachable: 'nicht erreichbar', hangup: 'abgebrochen', error: 'fehlgeschlagen', lost: 'Verbindung verloren' }[reason] || 'beendet';
        msg = `${kind} · ${t}`;
        shown = t.charAt(0).toUpperCase() + t.slice(1);
        // Nicht erreichbar / nicht angenommen: der andere soll den verpassten Anruf sehen (auch per Push)
        if (reason === 'unreachable') sendData(c.code, { type: 'callmiss', callId: c.id, video: !!c.video });
      }
      if (msg) systemMessage(chatId, msg);
      saveMeta(); scheduleRender();
      setState(shown);
      $('callControls').classList.add('hidden');
      $('callIncoming').classList.add('hidden');
      closeUI(c.start || c.dir === 'out' ? 1300 : 600);
    }
    function closeUI(delay) {
      setTimeout(() => {
        if (cur) return; // schon ein neuer Anruf
        box.classList.add('hidden');
        box.classList.remove('has-video', 'ringing-in', 'swapped');
      }, delay);
    }

    // ---------- Knöpfe ----------
    function toggleMute() {
      if (!cur || !cur.local) return;
      cur.muted = !cur.muted;
      cur.local.getAudioTracks().forEach((t) => { t.enabled = !cur.muted; });
      renderButtons();
    }
    function toggleCam() {
      if (!cur || !cur.local) return;
      const vt = cur.local.getVideoTracks();
      if (!vt.length) { toast('Keine Kamera gefunden'); return; }
      cur.camOn = !cur.camOn;
      vt.forEach((t) => { t.enabled = cur.camOn; });
      sendTo(cur.code, { type: 'call-cam', callId: cur.id, on: cur.camOn });
      renderButtons();
    }
    async function checkFlip() {
      const n = (await videoInputs()).length;
      box.classList.toggle('no-flip', !(cur && cur.video && (n > 1 || (isMobile() && n > 0))));
    }
    // Kamera drehen: Handy vorne/hinten, PC nächste Kamera
    async function flip() {
      if (!cur || !cur.local || !cur.video) return;
      const c = cur;
      const old = cur.local.getVideoTracks()[0];
      const inputs = await videoInputs();
      let constraints;
      if (isMobile()) {
        c.facing = c.facing === 'user' ? 'environment' : 'user';
        constraints = { facingMode: { exact: c.facing } };
      } else {
        if (inputs.length < 2) { toast('Keine zweite Kamera gefunden'); return; }
        const curId = old && old.getSettings ? old.getSettings().deviceId : null;
        const i = inputs.findIndex((d) => d.deviceId === curId);
        const next = inputs[(i + 1) % inputs.length];
        constraints = { deviceId: { exact: next.deviceId } };
        c.facing = /back|rear|rück|environment/i.test(next.label) ? 'environment' : 'user';
      }
      // Handys erlauben oft nur eine Kamera gleichzeitig: alte zuerst freigeben
      if (old) old.stop();
      let track;
      try {
        track = (await navigator.mediaDevices.getUserMedia({ video: { ...constraints, width: { ideal: 1280 }, height: { ideal: 720 } } })).getVideoTracks()[0];
      } catch {
        try { track = (await navigator.mediaDevices.getUserMedia({ video: isMobile() ? { facingMode: c.facing } : true })).getVideoTracks()[0]; }
        catch (e) { mediaError(e); return; }
      }
      if (cur !== c) { track.stop(); return; }
      track.enabled = c.camOn;
      if (old) c.local.removeTrack(old);
      c.local.addTrack(track);
      const sender = c.mc && c.mc.peerConnection && c.mc.peerConnection.getSenders().find((s) => s.track === old || (s.track && s.track.kind === 'video') || (!s.track && old));
      if (sender) { try { await sender.replaceTrack(track); } catch (e) { console.warn('Kamera wechseln:', e); } }
      // Neues Objekt erzwingen, damit das Vorschaubild neu startet
      localEl.srcObject = null;
      renderVideo();
    }
    function swap() { if (cur && cur.remote && cur.local) { cur.swapped = !cur.swapped; renderVideo(); } }

    // Eigenes Bild verschieben (Maus oder Finger); kurzer Tipp = Bilder tauschen
    (() => {
      let st = null;
      localWrap.addEventListener('pointerdown', (e) => {
        const r = localWrap.getBoundingClientRect(), b = box.getBoundingClientRect();
        st = { x: e.clientX, y: e.clientY, l: r.left - b.left, t: r.top - b.top, moved: false };
        localWrap.setPointerCapture(e.pointerId);
      });
      localWrap.addEventListener('pointermove', (e) => {
        if (!st) return;
        const dx = e.clientX - st.x, dy = e.clientY - st.y;
        if (!st.moved && Math.hypot(dx, dy) < 6) return;
        st.moved = true;
        const b = box.getBoundingClientRect(), w = localWrap.offsetWidth, h = localWrap.offsetHeight;
        localWrap.style.right = 'auto';
        localWrap.style.left = Math.max(8, Math.min(b.width - w - 8, st.l + dx)) + 'px';
        localWrap.style.top = Math.max(8, Math.min(b.height - h - 8, st.t + dy)) + 'px';
      });
      localWrap.addEventListener('pointerup', () => { if (st && !st.moved) swap(); st = null; });
      localWrap.addEventListener('pointercancel', () => { st = null; });
    })();

    $('callEnd').onclick = () => end(cur && cur.dir === 'in' && cur.state === 'ringing' ? 'declined' : 'hangup');
    $('callAccept').onclick = accept;
    $('callDecline').onclick = decline;
    $('callMute').onclick = toggleMute;
    $('callCam').onclick = toggleCam;
    $('callFlip').onclick = flip;
    $('audioCallBtn').onclick = () => { if (activeChat && activeChat.startsWith('u:')) start(activeChat.slice(2), false); };
    $('videoCallBtn').onclick = () => { if (activeChat && activeChat.startsWith('u:')) start(activeChat.slice(2), true); };

    // Steuerbefehle vom anderen
    function handle(code, data) {
      const sameCall = cur && cur.code === code && (!data.callId || data.callId === cur.id);
      switch (data.type) {
        case 'call-end':
          if (sameCall) end(cur.state === 'ringing' ? 'canceled' : 'remote');
          break;
        case 'call-reject':
          if (sameCall && cur.dir === 'out') end(data.busy ? 'busy' : 'rejected');
          break;
        case 'call-cam':
          if (sameCall) { cur.remoteCam = !!data.on; renderVideo(); }
          break;
        case 'callmiss': {
          if (!isFriend(code)) return;
          const chatId = 'u:' + code;
          systemMessage(chatId, `${kindText(!!data.video)} verpasst`);
          unread[chatId] = (unread[chatId] || 0) + 1;
          notify(nameOf(code), `Verpasster ${data.video ? 'Videoanruf' : 'Anruf'}`, { chatId, icon: contacts[code] && contacts[code].avatar });
          saveMeta(); scheduleRender();
          break;
        }
      }
    }
    // Freund war nicht erreichbar (PeerJS: peer-unavailable)
    function unavailable(code) {
      if (cur && cur.dir === 'out' && cur.code === code && cur.state === 'calling' && cur.mc) end('unreachable');
    }
    return { start, incoming, handle, unavailable, active: () => !!cur };
  })();

  // ================= Status (wie bei WhatsApp: Bilder mit Beschreibung, 24 Stunden sichtbar) =================
  // Verteilung: direkt an Freunde (P2P) oder verschlüsselt über den Briefkasten-Server.
  // Beim Verbinden gleichen beide ihre Liste ab (slist/sget), so kommt auch Verpasstes an.
  const stories = (() => {
    const TTL = 24 * 3600 * 1000;
    const SHOW_MS = 5000;
    const MAX_ITEMS = 30;
    const REACTIONS = ['❤️', '😂', '😮', '😢', '😍', '👏', '🔥', '👍'];
    // code -> [{ id, ts, caption, kind, w, h, seen, seenSent, myReaction, reactions{code:emoji}, views[] }]
    const all = store.load('statuses', {});
    const save = () => store.save('statuses', all);
    const mkey = (code) => 'st:' + code;
    const alive = (s) => Date.now() - s.ts < TTL;
    const validId = (x) => typeof x === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(x);
    const validEmoji = (e) => typeof e === 'string' && e.length <= 16 && /\p{Extended_Pictographic}/u.test(e);

    const ofCode = (code) => (all[code] || []).filter(alive).sort((a, b) => a.ts - b.ts);
    const mine = () => ofCode(me.code);
    const hasUnseen = (code) => ofCode(code).some((s) => !s.seen);
    const latest = (code) => { const l = ofCode(code); return l.length ? l[l.length - 1].ts : 0; };
    const people = () => Object.keys(all).filter((c) => c !== me.code && isFriend(c) && !blocked.includes(c) && ofCode(c).length);
    const unseenCount = () => people().filter(hasUnseen).length;

    function dropMedia(code, id) {
      const k = mediaKey(mkey(code), id);
      mediaCache.delete(k);
      db.del('media', k).catch(() => {});
    }
    // Abgelaufene Status und Status von Ex-Freunden löschen
    function prune() {
      let changed = false;
      for (const code of Object.keys(all)) {
        const keep = code === me.code || (isFriend(code) && !blocked.includes(code));
        const list = all[code].filter((s) => {
          if (keep && alive(s)) return true;
          dropMedia(code, s.id);
          return false;
        });
        if (list.length !== all[code].length) changed = true;
        if (list.length) all[code] = list; else delete all[code];
      }
      if (changed) { save(); scheduleRender(); }
    }

    const wire = (s, data) => ({ type: 'status', id: s.id, ts: s.ts, caption: s.caption, media: { kind: s.kind, data, w: s.w, h: s.h } });

    // Eigene Status veröffentlichen: items = [{ media, caption }]
    async function post(items) {
      const list = (all[me.code] = all[me.code] || []);
      for (const it of items) {
        const s = {
          id: crypto.randomUUID(), ts: Date.now(), caption: clean(it.caption, 300),
          kind: it.media.kind, w: it.media.w, h: it.media.h, seen: true, reactions: {}, views: [],
        };
        await putMedia(mkey(me.code), s.id, it.media.data);
        list.push(s);
        friendCodes().filter((c) => !blocked.includes(c)).forEach((c) => sendData(c, wire(s, it.media.data)));
      }
      while (list.length > MAX_ITEMS) { const old = list.shift(); dropMedia(me.code, old.id); }
      stats.statuses = (stats.statuses || 0) + items.length;
      save(); saveMeta(); checkAchievements(); scheduleRender();
    }

    function removeMine(id) {
      if (!all[me.code]) return;
      all[me.code] = all[me.code].filter((s) => s.id !== id);
      if (!all[me.code].length) delete all[me.code];
      dropMedia(me.code, id);
      friendCodes().forEach((c) => sendData(c, { type: 'sdel', id }));
      save(); scheduleRender();
    }

    // Beim Verbinden: „Diese Status habe ich gerade“
    function syncTo(code) {
      if (!isFriend(code)) return;
      sendTo(code, { type: 'slist', ids: mine().map((s) => s.id) });
    }

    async function handle(code, data) {
      if (!isFriend(code) || blocked.includes(code)) return;
      const id = validId(data.id) ? data.id : null;
      switch (data.type) {
        case 'status': {
          if (!id) return;
          const ts = clampTs(data.ts);
          if (Date.now() - ts >= TTL) return;
          const media = validMedia(data.media);
          if (media && (media.kind === 'audio' || media.kind === 'sticker' || media.kind === 'video')) return; // Status nur mit Bildern
          if (!media) return;
          const list = (all[code] = all[code] || []);
          if (list.some((s) => s.id === id)) return;
          await putMedia(mkey(code), id, media.data);
          list.push({ id, ts, caption: clean(data.caption, 300), kind: media.kind, w: media.w, h: media.h, seen: false });
          while (list.length > MAX_ITEMS) { const old = list.shift(); dropMedia(code, old.id); }
          save(); scheduleRender();
          break;
        }
        case 'sdel': {
          if (!id || !all[code] || !all[code].some((s) => s.id === id)) return;
          all[code] = all[code].filter((s) => s.id !== id);
          if (!all[code].length) delete all[code];
          dropMedia(code, id);
          save(); scheduleRender(); viewer.changed(code);
          break;
        }
        case 'slist': {
          if (!Array.isArray(data.ids)) return;
          const ids = data.ids.filter(validId).slice(0, MAX_ITEMS);
          const have = all[code] || [];
          const gone = have.filter((s) => !ids.includes(s.id));
          if (gone.length) {
            gone.forEach((s) => dropMedia(code, s.id));
            all[code] = have.filter((s) => ids.includes(s.id));
            if (!all[code].length) delete all[code];
            save(); scheduleRender(); viewer.changed(code);
          }
          const missing = ids.filter((x) => !have.some((s) => s.id === x));
          if (missing.length) sendTo(code, { type: 'sget', ids: missing });
          break;
        }
        case 'sget': {
          if (!Array.isArray(data.ids)) return;
          const want = data.ids.filter(validId);
          for (const s of mine()) {
            if (!want.includes(s.id)) continue;
            const d = await getMedia(mkey(me.code), s.id);
            if (d) sendTo(code, wire(s, d));
          }
          break;
        }
        case 'sreact': {
          const s = id && (all[me.code] || []).find((x) => x.id === id);
          if (!s || !validEmoji(data.emoji)) return;
          s.reactions = s.reactions || {};
          s.views = s.views || [];
          s.reactions[code] = data.emoji;
          if (!s.views.includes(code)) s.views.push(code);
          save(); viewer.changed(me.code);
          const text = `hat auf deinen Status reagiert ${data.emoji}`;
          if (document.hasFocus()) toast(`${data.emoji} ${nameOf(code)} ${text.replace(/ \S+$/, '')}`);
          notify(nameOf(code), text, { icon: contacts[code] && contacts[code].avatar });
          break;
        }
        case 'sseen': {
          const s = id && (all[me.code] || []).find((x) => x.id === id);
          if (!s) return;
          s.views = s.views || [];
          if (!s.views.includes(code)) { s.views.push(code); save(); viewer.changed(me.code); }
          break;
        }
      }
    }

    // ---------- Zeitangaben ----------
    function ago(ts) {
      const min = Math.floor((Date.now() - ts) / 60000);
      if (min < 1) return 'Gerade eben';
      if (min < 60) return `Vor ${min} Min.`;
      const d = new Date(ts), today = new Date();
      return (d.getDate() === today.getDate() ? 'Heute, ' : 'Gestern, ') + fmtTime(ts);
    }

    // ---------- Avatar mit Ring (ein Segment pro Status) ----------
    function ringEl(code, list) {
      const c = code === me.code ? me : contacts[code] || {};
      const r = el('span', 'st-ring' + (list.length ? '' : ' none'));
      if (list.length) {
        const n = list.length, seg = 360 / n, gap = n > 1 ? 5 : 0;
        const parts = list.map((s, i) => {
          const col = code !== me.code && s.seen ? 'var(--st-seen)' : 'var(--accent)';
          const a = i * seg + gap / 2, b = (i + 1) * seg - gap / 2;
          return `transparent ${i * seg}deg ${a}deg, ${col} ${a}deg ${b}deg, transparent ${b}deg ${(i + 1) * seg}deg`;
        });
        r.style.background = `conic-gradient(${parts.join(', ')})`;
      }
      r.appendChild(avatarEl(c.name, c.avatar, code));
      return r;
    }

    // ---------- Liste ----------
    function renderList() {
      const ul = $('statusList');
      ul.replaceChildren();
      const my = mine();
      const meLi = el('li');
      const ring = ringEl(me.code, my);
      const add = el('span', 'st-add');
      add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>';
      add.title = 'Status hinzufügen';
      add.onclick = (e) => { e.stopPropagation(); pick(); };
      ring.appendChild(add);
      meLi.appendChild(ring);
      const meta = el('div', 'fmeta');
      meta.appendChild(el('div', 'fname', 'Mein Status'));
      meta.appendChild(el('div', 'flast', my.length ? `${my.length} ${my.length === 1 ? 'Update' : 'Updates'} · ${ago(my[my.length - 1].ts)}` : 'Tippe, um einen Status hinzuzufügen'));
      meLi.appendChild(meta);
      meLi.onclick = () => (my.length ? viewer.open([me.code], 0) : pick());
      meLi.id = 'stMine';
      ul.appendChild(meLi);

      const order = people().sort((a, b) => latest(b) - latest(a));
      const fresh = order.filter(hasUnseen), seen = order.filter((c) => !hasUnseen(c));
      const queue = [...fresh, ...seen];
      [['Neu', fresh], ['Angesehen', seen]].forEach(([title, codes]) => {
        if (!codes.length) return;
        ul.appendChild(el('li', 'listhead', title));
        codes.forEach((code) => {
          const li = el('li');
          li.dataset.code = code;
          li.appendChild(ringEl(code, ofCode(code)));
          const m = el('div', 'fmeta');
          m.appendChild(el('div', 'fname', nameOf(code)));
          m.appendChild(el('div', 'flast', ago(latest(code))));
          li.appendChild(m);
          li.onclick = () => viewer.open(queue, queue.indexOf(code));
          ul.appendChild(li);
        });
      });
      if (!order.length) ul.appendChild(el('li', 'st-empty', friendCodes().length
        ? 'Noch keine Status von deinen Freunden.\nWenn jemand etwas teilt, siehst du es hier.'
        : 'Füge Freunde hinzu, um ihre Status zu sehen.'));
    }

    // ---------- Erstellen ----------
    let draft = [];   // [{ media, caption }]
    let draftIdx = 0;
    function pick() { $('statusInput').click(); }
    async function addFiles(files) {
      const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, 10);
      if (!list.length) return;
      const before = draft.length;
      for (const f of list) {
        if (draft.length >= 10) break;
        try { draft.push({ media: await prepareImage(f), caption: '' }); }
        catch (e) { toast('⚠️ ' + e.message); }
      }
      if (!draft.length) return;
      draftIdx = Math.min(before, draft.length - 1);
      const box = $('stCompose');
      if (box.classList.contains('hidden')) { box.classList.remove('hidden'); box.classList.add('opening'); setTimeout(() => box.classList.remove('opening'), 250); }
      renderDraft();
    }
    function keepCaption() { if (draft[draftIdx]) draft[draftIdx].caption = $('stCaption').value; }
    function renderDraft() {
      if (!draft.length) { closeCompose(); return; }
      draftIdx = Math.min(draftIdx, draft.length - 1);
      $('stComposeImg').src = draft[draftIdx].media.data;
      $('stCaption').value = draft[draftIdx].caption;
      const th = $('stThumbs');
      th.replaceChildren();
      draft.forEach((d, i) => {
        const t = el('button', 'st-thumb' + (i === draftIdx ? ' active' : ''));
        t.type = 'button';
        const img = document.createElement('img'); img.src = d.media.data; img.alt = '';
        t.appendChild(img);
        t.onclick = () => { keepCaption(); draftIdx = i; renderDraft(); };
        th.appendChild(t);
      });
      if (draft.length < 10) {
        const more = el('button', 'st-thumb more');
        more.type = 'button'; more.title = 'Weitere Bilder';
        more.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 6v12M6 12h12"/></svg>';
        more.onclick = () => { keepCaption(); pick(); };
        th.appendChild(more);
      }
      if (!window.matchMedia('(pointer: coarse)').matches) $('stCaption').focus();
    }
    function closeCompose() {
      draft = []; draftIdx = 0;
      $('stCompose').classList.add('hidden');
      $('stCaption').value = '';
    }
    $('statusInput').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); };
    $('stComposeClose').onclick = closeCompose;
    $('stComposeDel').onclick = () => { draft.splice(draftIdx, 1); renderDraft(); };
    $('stComposeForm').onsubmit = async (e) => {
      e.preventDefault();
      keepCaption();
      const items = draft.slice();
      closeCompose();
      if (!items.length) return;
      await post(items);
      toast(items.length === 1 ? 'Status geteilt ✓' : `${items.length} Status geteilt ✓`);
    };

    // ---------- Ansehen (Slides) ----------
    const viewer = (() => {
      let queue = [], qi = 0, idx = 0, card = null, paused = false, sheetOpen = false;
      const box = $('stViewer');
      const isOpen = () => !box.classList.contains('hidden');
      const code = () => queue[qi];
      const items = () => ofCode(code());

      function open(q, start) {
        queue = q.filter((c) => ofCode(c).length);
        qi = Math.max(0, queue.indexOf(q[start]));
        if (!queue.length) return;
        box.classList.remove('hidden', 'closing');
        box.classList.add('opening');
        setTimeout(() => box.classList.remove('opening'), 250);
        paused = false; box.classList.remove('paused');
        showPerson(null);
      }
      function close() {
        if (!isOpen()) return;
        closeSheet();
        box.classList.add('closing');
        setTimeout(() => { box.classList.add('hidden'); box.classList.remove('closing'); $('stCards').replaceChildren(); card = null; }, 190);
        scheduleRender();
      }
      // Neue Person: Karte bauen, mit Slide-Animation einblenden
      function showPerson(dir) {
        const list = items();
        if (!list.length) { nextPerson(); return; }
        const own = code() === me.code;
        const firstNew = list.findIndex((s) => !s.seen);
        if (dir === 'prev') idx = list.length - 1;
        else idx = own || firstNew < 0 ? 0 : firstNew;
        const old = card;
        card = buildCard();
        if (old && dir) {
          old.classList.add(dir === 'next' ? 'out-next' : 'out-prev');
          card.classList.add(dir === 'next' ? 'in-next' : 'in-prev');
          setTimeout(() => old.remove(), 330);
        } else if (old) old.remove();
        $('stCards').appendChild(card);
        renderBottom();
        showItem();
      }
      function buildCard() {
        const c = code(), p = c === me.code ? me : contacts[c] || {};
        const k = el('div', 'st-card');
        const bars = el('div', 'st-bars');
        items().forEach(() => { const b = el('div', 'st-bar'); b.appendChild(document.createElement('i')); bars.appendChild(b); });
        const head = el('div', 'st-head');
        head.appendChild(avatarEl(p.name, p.avatar, c));
        const who = el('div', 'st-who');
        who.appendChild(el('b', '', c === me.code ? 'Mein Status' : nameOf(c)));
        who.appendChild(el('span', 'st-time', ''));
        head.appendChild(who);
        if (c === me.code) {
          const del = el('button', 'st-btn st-del');
          del.title = 'Diesen Status löschen';
          del.innerHTML = '<svg><use href="#i-trash"/></svg>';
          del.onclick = (e) => { e.stopPropagation(); deleteCurrent(); };
          head.appendChild(del);
        }
        const x = el('button', 'st-btn');
        x.title = 'Schließen (Esc)';
        x.innerHTML = '<svg><use href="#i-x"/></svg>';
        x.onclick = (e) => { e.stopPropagation(); close(); };
        head.appendChild(x);
        const wrap = el('div', 'st-img-wrap');
        const img = document.createElement('img'); img.alt = '';
        wrap.appendChild(img);
        const zones = el('div', 'st-zones');
        const left = el('div'), right = el('div');
        zones.append(left, right);
        wrap.appendChild(zones);
        const text = el('div', 'st-text');
        wrap.appendChild(text);
        k.append(bars, head, wrap);
        k._ = { bars, img, text, time: who.lastChild, left, right, zones };
        bindPointer(zones, left);
        return k;
      }
      // Tippen links/rechts = zurück/weiter, gedrückt halten = Pause, Wischen = Person wechseln / schließen
      function bindPointer(zones, left) {
        let start = null;
        zones.onpointerdown = (e) => { start = { x: e.clientX, y: e.clientY, t: Date.now(), left: e.target === left }; setPaused(true); };
        zones.onpointerup = (e) => {
          if (!start) return;
          const dx = e.clientX - start.x, dy = e.clientY - start.y, held = Date.now() - start.t;
          const s = start; start = null;
          setPaused(false);
          if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) { if (dx < 0) nextPerson(); else prevPerson(); return; }
          if (dy > 90 && Math.abs(dy) > Math.abs(dx)) { close(); return; }
          if (held < 300) { if (s.left) prev(); else next(); }
        };
        zones.onpointercancel = () => { start = null; setPaused(false); };
        zones.onpointerleave = () => { if (start) { start = null; setPaused(false); } };
      }
      function setPaused(p) {
        paused = p || sheetOpen;
        box.classList.toggle('paused', paused);
      }
      function showItem() {
        const list = items();
        if (!card || !list.length) return;
        idx = Math.max(0, Math.min(idx, list.length - 1));
        const s = list[idx], c = code();
        const { bars, img, text, time } = card._;
        // Balken: davor voll, aktueller läuft, danach leer
        [...bars.children].forEach((b, i) => {
          b.classList.toggle('done', i < idx);
          b.classList.remove('run');
          const bar = b.firstChild;
          bar.style.animation = 'none';
          bar.onanimationend = null;
          if (i === idx) {
            void bar.offsetWidth; // Animation neu starten
            bar.style.animation = '';
            bar.style.animationDuration = SHOW_MS + 'ms';
            bar.onanimationend = () => { if (isOpen() && card && card._.bars === bars) next(); };
          }
        });
        bars.children[idx].classList.add('run');
        // Bild erst laden, dann starten
        setPaused(true);
        const startNow = () => { if (card && card._.img === img) setPaused(false); };
        img.onload = startNow;
        img.onerror = startNow;
        const k = mediaKey(mkey(c), s.id);
        // gleiches Bild wie eben -> es kommt kein neues load-Ereignis
        const setSrc = (d) => { if (img.getAttribute('src') === d && img.complete) startNow(); else img.src = d; };
        if (mediaCache.has(k)) setSrc(mediaCache.get(k));
        else getMedia(mkey(c), s.id).then((d) => { if (d && card && card._.img === img) setSrc(d); else startNow(); });
        text.textContent = s.caption || '';
        text.style.display = s.caption ? '' : 'none';
        time.textContent = ago(s.ts);
        // Gesehen merken und dem Besitzer melden
        if (c !== me.code && !s.seen) { s.seen = true; save(); }
        if (c !== me.code && !s.seenSent) { s.seenSent = true; save(); sendData(c, { type: 'sseen', id: s.id }); }
        renderBottom();
      }
      function next() {
        if (idx < items().length - 1) { idx++; showItem(); } else nextPerson();
      }
      function prev() {
        if (idx > 0) { idx--; showItem(); } else if (qi > 0) prevPerson(); else showItem();
      }
      function nextPerson() {
        if (qi < queue.length - 1) { qi++; showPerson('next'); } else close();
      }
      function prevPerson() {
        if (qi > 0) { qi--; showPerson('prev'); } else showItem();
      }
      function deleteCurrent() {
        const s = items()[idx];
        if (!s) return;
        removeMine(s.id);
        if (!items().length) { close(); return; }
        const old = card;
        card = buildCard();
        old.replaceWith(card);
        showItem();
      }
      // Unten: Reaktionen (bei anderen) oder „Angesehen“ (eigener Status)
      function renderBottom() {
        const own = code() === me.code;
        const s = items()[idx];
        $('stReact').classList.toggle('hidden', own);
        $('stOwn').classList.toggle('hidden', !own);
        if (own) {
          const views = (s && s.views) || [];
          const reacts = Object.values((s && s.reactions) || {});
          $('stViewsText').textContent = views.length + (reacts.length ? '  ' + reacts.slice(0, 5).join('') : '');
          if (sheetOpen) renderSheet();
          return;
        }
        const r = $('stReact');
        r.replaceChildren();
        REACTIONS.forEach((e) => {
          const b = el('button', s && s.myReaction === e ? 'picked' : '', e);
          b.type = 'button';
          b.title = 'Mit ' + e + ' reagieren';
          b.onclick = () => react(e);
          r.appendChild(b);
        });
      }
      function react(e) {
        const s = items()[idx], c = code();
        if (!s || c === me.code) return;
        s.myReaction = e; save();
        sendData(c, { type: 'sreact', id: s.id, emoji: e });
        const burst = el('div', 'st-burst', e);
        box.appendChild(burst);
        setTimeout(() => burst.remove(), 950);
        renderBottom();
      }
      function renderSheet() {
        const s = items()[idx];
        const ul = $('stSheetList');
        ul.replaceChildren();
        const views = (s && s.views) || [];
        $('stSheetTitle').textContent = views.length ? `Angesehen von ${views.length}` : 'Noch nicht angesehen';
        views.slice().reverse().forEach((v) => {
          const li = el('li');
          li.appendChild(avatarEl(nameOf(v), contacts[v] && contacts[v].avatar, v));
          li.appendChild(el('span', 'fname', nameOf(v)));
          const r = s.reactions && s.reactions[v];
          li.appendChild(r ? el('span', 'emo', r) : el('span', 'muted', ''));
          ul.appendChild(li);
        });
      }
      function openSheet() { sheetOpen = true; $('stSheet').classList.remove('hidden'); renderSheet(); setPaused(true); }
      function closeSheet() { sheetOpen = false; $('stSheet').classList.add('hidden'); setPaused(false); }
      $('stViews').onclick = openSheet;
      $('stSheetClose').onclick = closeSheet;

      // Tastatur: Pfeile, Leertaste = Pause, Esc = schließen
      document.addEventListener('keydown', (e) => {
        if (!isOpen()) return;
        if (e.key === 'Escape') { e.stopImmediatePropagation(); if (sheetOpen) closeSheet(); else close(); }
        else if (e.key === 'ArrowRight') next();
        else if (e.key === 'ArrowLeft') prev();
        else if (e.key === 'ArrowDown') nextPerson();
        else if (e.key === 'ArrowUp') prevPerson();
        else if (e.key === ' ') { e.preventDefault(); setPaused(!paused); }
      }, true);

      // Etwas hat sich geändert (gelöscht, neue Reaktion …)
      function changed(c) {
        if (!isOpen() || c !== code()) return;
        if (!items().length) { nextPerson(); return; }
        if (card && card._.bars.children.length !== items().length) {
          const old = card; card = buildCard(); old.replaceWith(card); showItem();
        } else renderBottom();
      }
      return { open, close, changed, isOpen };
    })();

    return { prune, post, handle, syncTo, renderList, unseenCount, pick, viewer, addFiles, mine };
  })();

  // ================= Briefkasten-Server (Offline-Zustellung) =================
  // Ist der Empfänger offline, landet die Nachricht Ende-zu-Ende-verschlüsselt in seinem
  // Briefkasten auf dem Server. Der Server kann sie weder lesen noch fälschen.
  //  - Schlüssel: ECDSA (signieren) + ECDH (verschlüsseln), nicht exportierbar in IndexedDB
  //  - Pro Nachricht: Einmal-Schlüssel (ECDH) -> HKDF -> AES-256-GCM, Absender signiert alles
  const relay = (() => {
    const DEFAULT_URL = 'https://whatsup-relay.whatsup-relay.workers.dev';
    const RELAY_TYPES = new Set(['msg', 'gmsg', 'ack', 'group', 'gleave', 'hello', 'status', 'sdel', 'sreact', 'sseen', 'callmiss', 'hreq', 'mact']);
    // Push aufs Handy nur für echte Nachrichten und Reaktionen (Profil, Gruppen-Abgleich, Bestätigungen usw. still)
    const PUSH_TYPES = new Set(['msg', 'gmsg', 'sreact', 'callmiss']);
    const te = new TextEncoder(), td = new TextDecoder();
    let ident = null;        // { signPriv, encPriv, signPub, encPub }
    let ready = false;
    let polling = false;
    const known = {};        // code -> registriert beim Server? (true/false)

    const url = () => store.load('relayUrl', null) || DEFAULT_URL;
    const enabled = () => settings.relay !== false && !!url();
    const b64u = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
    const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/[^A-Za-z0-9_-]/g, '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
    const cat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; p.forEach((x) => { o.set(x, i); i += x.length; }); return o; };
    const pubJwk = (k) => (k && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && !k.d ? { kty: 'EC', crv: 'P-256', x: k.x, y: k.y } : null);

    async function newIdentity() {
      const s = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const e = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      return {
        signPriv: s.privateKey, encPriv: e.privateKey,
        signPub: pubJwk(await crypto.subtle.exportKey('jwk', s.publicKey)),
        encPub: pubJwk(await crypto.subtle.exportKey('jwk', e.publicKey)),
      };
    }
    async function loadKeys() {
      let k = await db.get('keys', 'identity').catch(() => null);
      if (!k) {
        k = await newIdentity();
        await db.put('keys', 'identity', k);
      }
      ident = k;
    }
    const rotateText = (code, ts, s, e) => `rotate|${code}|${ts}|${s.x}.${s.y}|${e.x}.${e.y}`;

    // ---- Konto-Umzug (siehe login unten) ----
    // Neues Gerät: eigene Schlüssel erzeugen und mit dem neuen Schlüssel unterschreiben
    async function rotationRequest(code, k) {
      const ts = Date.now();
      const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k.signPriv, te.encode(rotateText(code, ts, k.signPub, k.encPub)));
      return { sign: k.signPub, enc: k.encPub, ts, sigNew: b64u(sig) };
    }
    // Altes Gerät: Umzug mit dem bisherigen Schlüssel bestätigen und beim Server eintragen.
    // 'off' = Briefkasten ist ausgeschaltet, es gibt nichts umzustellen.
    async function rotate(r) {
      if (!enabled()) return 'off';
      const s = pubJwk(r && r.sign), e = pubJwk(r && r.enc), ts = Number(r && r.ts);
      if (!s || !e || !Number.isFinite(ts) || typeof r.sigNew !== 'string') throw new Error('Ungültige Schlüssel vom neuen Gerät');
      if (!ident) await loadKeys();
      const sig = await sign(rotateText(me.code, ts, s, e));
      await post(`/v1/rotate/${me.code}`, { sign: s, enc: e, ts, sig, sigNew: r.sigNew });
      ready = false; // Ab jetzt gehört der Briefkasten dem neuen Gerät
      return 'ok';
    }
    // Neues Gerät: Sind beim Server schon unsere neuen Schlüssel eingetragen?
    async function serverHasKey(code, signPub, baseUrl) {
      try {
        const res = await fetch(`${baseUrl || url()}/v1/keys/${code}`);
        if (!res.ok) return false;
        const k = await res.json();
        return !!(k.sign && k.sign.x === signPub.x && k.sign.y === signPub.y);
      } catch { return false; }
    }
    async function sign(text) {
      return b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.signPriv, te.encode(text)));
    }
    async function post(path, body) {
      const res = await fetch(url() + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(data.error || 'HTTP ' + res.status); e.status = res.status; throw e; }
      return data;
    }

    async function register() {
      const ts = Date.now();
      const { signPub: s, encPub: e } = ident;
      const sig = await sign(`register|${me.code}|${ts}|${s.x}.${s.y}|${e.x}.${e.y}`);
      await post(`/v1/register/${me.code}`, { sign: s, enc: e, ts, sig });
    }

    // Schlüssel eines Kontakts: zuerst die direkt (per Hello) übermittelten, sonst vom Server
    // fresh = gespeicherte Schlüssel ignorieren (z. B. weil der Kontakt das Gerät gewechselt hat)
    async function keysOf(code, fresh) {
      const c = contacts[code];
      if (!fresh && c && c.keys && c.keys.sign && c.keys.enc) return c.keys;
      const res = await fetch(`${url()}/v1/keys/${code}`);
      if (res.status === 404) { known[code] = false; return null; }
      if (!res.ok) throw new Error('Schlüssel nicht erreichbar');
      const k = await res.json();
      const keys = { sign: pubJwk(k.sign), enc: pubJwk(k.enc) };
      if (!keys.sign || !keys.enc) return null;
      known[code] = true;
      if (c) { c.keys = keys; saveMeta(); }
      return keys;
    }

    async function seal(keys, data) {
      const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
      const theirs = await crypto.subtle.importKey('jwk', keys.enc, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, eph.privateKey, 256);
      const aes = await aesFrom(shared, epk);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, te.encode(JSON.stringify(data))));
      const head = cat(new Uint8Array([1]), epk, iv);
      const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ident.signPriv, cat(head, ct)));
      return cat(head, sig, ct); // 1 + 65 + 12 + 64 + Daten
    }
    async function aesFrom(shared, epk) {
      const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: epk, info: te.encode('whatsup-relay-v1') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function open(env, from) {
      if (env.length < 143 || env[0] !== 1) return null;
      const head = env.subarray(0, 78), epk = env.subarray(1, 66), iv = env.subarray(66, 78);
      const sig = env.subarray(78, 142), ct = env.subarray(142);
      const ok = async (keys) => {
        if (!keys) return false;
        const vkey = await crypto.subtle.importKey('jwk', keys.sign, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkey, sig, cat(head, ct));
      };
      if (!(await ok(await keysOf(from)))) {
        // Vielleicht ist der Absender auf ein neues Gerät umgezogen: aktuelle Schlüssel vom Server holen
        const cur = await keysOf(from, true).catch(() => null);
        if (!(await ok(cur))) return null; // gefälscht
      }
      const theirs = await crypto.subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, ident.encPriv, 256);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesFrom(shared, epk), ct);
      return JSON.parse(td.decode(pt));
    }

    // Nachricht in den Briefkasten des Empfängers legen. true = angenommen
    async function send(code, data, opts = {}) {
      const push = opts.push ?? PUSH_TYPES.has(data && data.type);
      if (!ready || !enabled() || !data || !RELAY_TYPES.has(data.type) || blocked.includes(code) || known[code] === false) return false;
      try {
        const keys = await keysOf(code);
        if (!keys) return false;
        const body = await seal(keys, data);
        const ts = Date.now();
        const res = await fetch(`${url()}/v1/send/${code}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-From': me.code, 'X-Ts': String(ts), 'X-Sig': await sign(`send|${me.code}|${code}|${ts}`), ...(push ? {} : { 'X-Silent': '1' }) },
          body,
        });
        if (res.status === 404) { known[code] = false; return false; }
        return res.ok;
      } catch (e) { console.warn('Briefkasten senden:', e); return false; }
    }

    // Eigenen Briefkasten leeren
    async function poll() {
      if (!ready || !enabled() || polling) return;
      polling = true;
      try {
        let ts = Date.now();
        const { items } = await post(`/v1/inbox/${me.code}`, { ts, sig: await sign(`inbox|${me.code}|${ts}`) });
        const done = [];
        for (const it of items || []) {
          try {
            ts = Date.now();
            const res = await fetch(`${url()}/v1/get/${me.code}/${it.id}`, { headers: { 'X-Ts': String(ts), 'X-Sig': await sign(`get|${me.code}|${ts}|${it.id}`) } });
            if (res.status === 404) { done.push(it.id); continue; }
            if (!res.ok) continue;
            const data = await open(new Uint8Array(await res.arrayBuffer()), it.sender).catch(() => null);
            if (data && !blocked.includes(it.sender)) { try { handleData(it.sender, data); } catch (e) { console.error(e); } }
            done.push(it.id); // auch unlesbare/gefälschte Nachrichten entfernen
          } catch (e) { console.warn('Briefkasten abholen:', e); }
        }
        if (done.length) {
          ts = Date.now();
          await post(`/v1/ack/${me.code}`, { ids: done, ts, sig: await sign(`ack|${me.code}|${ts}|${done.join(',')}`) });
        }
        relayPending();
      } catch (e) { console.warn('Briefkasten:', e); }
      finally { polling = false; renderRelayStatus(); }
    }

    // Web-Version: Push-Benachrichtigungen aufs Handy, auch wenn WhatsUp zu ist
    async function setupPush() {
      if (!document.documentElement.classList.contains('is-web') || !('PushManager' in window) || !navigator.serviceWorker) return;
      if (!('Notification' in window) || Notification.permission !== 'granted' || !settings.notify) return;
      try {
        const reg = await navigator.serviceWorker.ready;
        const { key } = await (await fetch(`${url()}/v1/vapid/x`)).json();
        if (!key) return;
        const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) }));
        const s = sub.toJSON();
        const ts = Date.now();
        await post(`/v1/push/${me.code}`, { sub: s, ts, sig: await sign(`push|${me.code}|${ts}|${s.endpoint}`) });
        return true;
      } catch (e) { console.warn('Push:', e); return false; }
    }
    // Test-Push an dieses Gerät (kommt 5 s später, auch bei gesperrtem Handy)
    async function pushTest() {
      if (!ready || !(await setupPush())) return 'nopush';
      try {
        const ts = Date.now();
        const r = await post(`/v1/pushtest/${me.code}`, { ts, sig: await sign(`pushtest|${me.code}|${ts}`) });
        return r && r.ok ? 'ok' : 'nopush';
      } catch (e) { console.warn('Push-Test:', e); return 'error'; }
    }
    // Namen und Profilbilder für die Push-Anzeige im Service Worker bereitlegen
    function saveNames() {
      const names = {};
      Object.entries(contacts).forEach(([c, v]) => { names[c] = v.name; });
      db.put('keys', 'pushNames', names).catch(() => {});
      if (!document.documentElement.classList.contains('is-web')) return;
      const icons = {};
      Promise.all(Object.entries(contacts).filter(([, v]) => v.avatar).map(([c, v]) =>
        toPng(v.avatar).then((png) => { icons[c] = png; }, () => {})))
        .then(() => db.put('keys', 'pushIcons', icons)).catch(() => {});
    }

    // ---- Seltenheit der Erfolge ----
    // Eigene Erfolge (nur die IDs) beim Server melden, damit er zählen kann, wie viele Personen sie haben
    async function reportAchievements() {
      if (!ready || !enabled()) return;
      const ach = Object.keys(unlocked).sort();
      const key = `${me.code}|${ach.join(',')}`;
      if (store.load('achReported', '') === key) return;
      try {
        const ts = Date.now();
        await post(`/v1/achreport/${me.code}`, { ach, ts, sig: await sign(`achreport|${me.code}|${ts}|${ach.join(',')}`) });
        store.save('achReported', key);
        achStatsCache = null; // gleich neu laden, damit die eigenen Erfolge mitgezählt sind
      } catch (e) { console.warn('Erfolge melden:', e); }
    }
    // Weltweite Zahlen: { counts: { id: Anzahl }, players }. Höchstens alle 5 Minuten neu laden.
    let achStatsCache = store.load('achStats', null);
    let achStatsLoading = null;
    function achStats() {
      if (achStatsCache && Date.now() - achStatsCache.at < 5 * 60000) return Promise.resolve(achStatsCache);
      if (!achStatsLoading) {
        achStatsLoading = fetch(`${url()}/v1/achstats`)
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((d) => {
            const counts = {};
            Object.entries((d && d.counts) || {}).forEach(([id, n]) => { counts[id] = Math.max(0, Number(n) || 0); });
            achStatsCache = { at: Date.now(), counts, players: Number(d && d.players) || 0 };
            store.save('achStats', achStatsCache);
            return achStatsCache;
          })
          .catch((e) => { console.warn('Erfolgs-Statistik:', e); return achStatsCache; }) // zur Not die alten Zahlen
          .finally(() => { achStatsLoading = null; });
      }
      return achStatsLoading;
    }

    function renderRelayStatus() {
      const st = $('relayStatus');
      if (!st) return;
      st.textContent = !enabled() ? 'Aus' : ready ? 'Aktiv · verschlüsselt' : 'Nicht erreichbar';
    }

    async function start() {
      if (!enabled()) { renderRelayStatus(); return; }
      try {
        await loadKeys();
        await register();
        ready = true;
      } catch (e) { console.warn('Briefkasten-Server nicht verfügbar:', e); ready = false; }
      renderRelayStatus();
      if (!ready) { setTimeout(start, 60000); return; }
      broadcastProfile();   // Freunde bekommen unsere Schlüssel
      poll();
      setupPush();
      saveNames();
      reportAchievements();
    }

    // Abholen: beim Start, jede Minute, beim Zurückkehren in die App und wenn das Netz wieder da ist
    setInterval(() => poll(), 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'relay-poll') poll(); });
    window.addEventListener('online', () => poll());

    return {
      start, poll, send, setupPush, pushTest, saveNames, renderRelayStatus, reportAchievements, achStats,
      newIdentity, rotationRequest, rotate, serverHasKey, enabled, url,
      canSend: (code) => ready && enabled() && known[code] !== false,
      ready: () => ready && enabled(),
      // Für UpReels: Text mit dem eigenen Schlüssel unterschreiben (nur wenn der Briefkasten aktiv ist)
      signText: async (text) => { if (!ready || !ident) throw new Error('not ready'); return sign(text); },
      publicKeys: () => (ident ? { sign: ident.signPub, enc: ident.encPub } : null),
      // Direkt (per Verbindung) erhaltene Schlüssel merken
      pinKeys(code, k) {
        const keys = k && { sign: pubJwk(k.sign), enc: pubJwk(k.enc) };
        if (!keys || !keys.sign || !keys.enc) return;
        const c = contacts[code];
        if (c) { c.keys = keys; known[code] = true; }
      },
    };
  })();

  // ================= Auf einem neuen Gerät anmelden (Konto-Umzug) =================
  // Das neue Gerät verbindet sich mit einer vorübergehenden Peer-ID mit dem Konto-Code.
  // Das alte Gerät zeigt einen 6-stelligen Bestätigungscode, der auf dem neuen eingegeben wird
  // (wie eine Zwei-Faktor-Bestätigung). Danach überträgt das alte Gerät alle Daten, der
  // Briefkasten-Server bekommt die Schlüssel des neuen Geräts und das alte meldet sich ab.
  // Abmelden ist nötig, weil ein Code (= Peer-ID) immer nur auf einem Gerät online sein kann.
  //
  // Ablauf (neu -> alt / alt -> neu):
  //   lreq -> | <- lwait (Code wird angezeigt) | lcode -> | <- lok / lwrong / lfail
  //   lkeys (neue Schlüssel) -> | <- lls (Profil & Einstellungen) | <- lidb … / lack -> (Chats & Bilder)
  //   <- lend | lstored -> | (altes Gerät stellt den Briefkasten um) <- ldone / lerr | lbye ->
  const login = (() => {
    const VERIFY_TTL = 5 * 60 * 1000;
    const MAX_TRIES = 3;
    const BLOCK_MS = 10 * 60 * 1000;
    const DEVICES = { pc: 'Windows-PC', web: 'Browser', ios: 'iPhone/iPad' };
    const LS_PREFIX = 'chatbox.';
    const IDB_STORES = ['chats', 'media'];
    const LS_KEY_RE = /^[A-Za-z]{1,40}$/;
    const digits = () => Array.from(crypto.getRandomValues(new Uint32Array(6)), (n) => n % 10).join('');
    const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
    const safeSend = (conn, d) => { try { conn.send(d); } catch {} };
    const closeSoon = (conn) => setTimeout(() => { try { conn.close(); } catch {} }, 800);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ---------------- Altes Gerät (hier ist das Konto angemeldet) ----------------
    let session = null;
    let blockedUntil = 0;

    function waitFor(s, t, ms) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { delete s.waits[t]; reject(new Error('Zeitüberschreitung')); }, ms);
        s.waits[t] = { resolve: (v) => { clearTimeout(timer); delete s.waits[t]; resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } };
      });
    }

    function modal(build) {
      openModal((box) => { box.dataset.owner = 'login'; build(box); });
    }
    function closeOwnModal() { if ($('modalBox').dataset.owner === 'login') closeModal(); }

    function showCode(s) {
      modal((box) => {
        box.appendChild(el('h3', '', 'Anmeldung auf neuem Gerät'));
        box.appendChild(el('p', '', `Jemand möchte sich auf einem ${s.device} mit deinem Konto anmelden. Wenn du das bist, gib dort diesen Bestätigungscode ein:`));
        box.appendChild(el('div', 'login-code', s.code.slice(0, 3) + ' ' + s.code.slice(3)));
        box.appendChild(el('p', 'muted', 'Gib den Code niemals an jemand anderen weiter. Danach zieht dein Konto mit allen Chats auf das neue Gerät um und dieses Gerät wird abgemeldet. Der Code gilt 5 Minuten.'));
        box.appendChild(buttons(['Das war ich nicht', 'ghost', () => {
          safeSend(s.conn, { t: 'lfail', why: 'denied' });
          endA(null, BLOCK_MS);
          toast('Anmeldung abgelehnt');
        }], ['OK', 'primary', closeModal]));
      });
    }
    function showProgress(s, text) {
      if (!s.progress) {
        modal((box) => {
          box.appendChild(el('h3', '', 'Konto wird übertragen'));
          s.progress = el('p', '', text);
          box.appendChild(s.progress);
          box.appendChild(el('p', 'muted', 'Lass WhatsUp auf beiden Geräten geöffnet, bis die Übertragung fertig ist.'));
        });
      }
      s.progress.textContent = text;
    }
    function showEnd(text) {
      modal((box) => {
        box.appendChild(el('h3', '', 'Anmeldung auf neuem Gerät'));
        box.appendChild(el('p', '', text));
        box.appendChild(buttons(['OK', 'primary', closeModal]));
      });
    }

    function endA(msg, block = 0) {
      const s = session;
      if (!s) return;
      session = null;
      clearTimeout(s.timer);
      if (block) blockedUntil = Date.now() + block;
      Object.values(s.waits).forEach((w) => w.reject(new Error('abgebrochen')));
      closeSoon(s.conn);
      if (msg) showEnd(msg); else closeOwnModal();
    }

    function incoming(conn) {
      conn.on('data', (d) => onA(conn, d).catch((e) => {
        console.error('Anmeldung:', e);
        if (session && session.conn === conn) { safeSend(conn, { t: 'lerr', msg: String(e.message || e).slice(0, 120) }); endA('Die Übertragung ist fehlgeschlagen. Dein Konto bleibt auf diesem Gerät.'); }
      }));
      const gone = () => {
        if (!session || session.conn !== conn) return;
        if (session.finishing) { Object.values(session.waits).forEach((w) => w.reject(new Error('getrennt'))); return; }
        endA(session.ok ? 'Die Verbindung zum neuen Gerät wurde unterbrochen. Dein Konto bleibt auf diesem Gerät.' : null);
      };
      conn.on('close', gone);
      conn.on('error', gone);
    }

    async function onA(conn, d) {
      if (!d || typeof d !== 'object') return;
      if (d.t === 'lreq') {
        if (!me || session || Date.now() < blockedUntil) { safeSend(conn, { t: 'lbusy' }); closeSoon(conn); return; }
        const s = session = { conn, code: digits(), tries: 0, ok: false, waits: {}, device: DEVICES[d.device] || 'anderen Gerät' };
        s.timer = setTimeout(() => {
          if (session !== s || s.ok) return;
          safeSend(conn, { t: 'lfail', why: 'expired' });
          endA(null, 60 * 1000);
        }, VERIFY_TTL);
        showCode(s);
        // Den Code selbst nicht in die Windows-Benachrichtigung (wäre z. B. auf dem Sperrbildschirm sichtbar)
        notify('Anmeldung auf neuem Gerät', 'Öffne WhatsUp, um den Bestätigungscode zu sehen.');
        safeSend(conn, { t: 'lwait' });
        return;
      }
      const s = session;
      if (!s || s.conn !== conn) return;
      if (d.t === 'lcode' && !s.ok) {
        if (String(d.code || '') === s.code) {
          s.ok = true;
          clearTimeout(s.timer);
          showProgress(s, 'Bestätigt. Warte auf das neue Gerät…');
          safeSend(conn, { t: 'lok' });
        } else if (++s.tries >= MAX_TRIES) {
          safeSend(conn, { t: 'lfail', why: 'tries' });
          endA('Auf dem anderen Gerät wurde mehrmals ein falscher Code eingegeben. Anmeldungen sind jetzt für 10 Minuten gesperrt.', BLOCK_MS);
        } else safeSend(conn, { t: 'lwrong', left: MAX_TRIES - s.tries });
        return;
      }
      if (d.t === 'lkeys' && s.ok && !s.started) { s.started = true; await transfer(s, d.keys); return; }
      if (s.waits[d.t]) s.waits[d.t].resolve(d);
    }

    async function transfer(s, keys) {
      const conn = s.conn;
      showProgress(s, 'Konto wird übertragen…');
      await relay.poll(); // Wartende Offline-Nachrichten noch abholen, damit sie mit umziehen
      if (session !== s) return;
      saveMeta();
      const ls = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(LS_PREFIX)) ls[k.slice(LS_PREFIX.length)] = localStorage.getItem(k);
      }
      const mediaIds = await db.keys('media');
      const chatIds = Object.keys(chats); // aus dem Speicher: aktueller als die Datenbank
      const total = mediaIds.length + chatIds.length;
      safeSend(conn, { t: 'lls', ls, total });
      let n = 0;
      const step = async (store, key, value) => {
        if (session !== s) throw new Error('abgebrochen');
        if (value != null) {
          conn.send({ t: 'lidb', store, key, value });
          await waitFor(s, 'lack', 120000);
        }
        n++;
        showProgress(s, `Konto wird übertragen… ${total ? Math.floor((n / total) * 100) : 100} %`);
      };
      for (const id of mediaIds) await step('media', id, await db.get('media', id).catch(() => null));
      for (const id of chatIds) await step('chats', id, chats[id]);
      conn.send({ t: 'lend' });
      await waitFor(s, 'lstored', 120000);

      // Briefkasten auf die Schlüssel des neuen Geräts umstellen
      showProgress(s, 'Fast fertig…');
      let r;
      try { r = await relay.rotate(keys); }
      catch (e) {
        console.error('Briefkasten umstellen:', e);
        safeSend(conn, { t: 'lerr', msg: 'Der Briefkasten-Server konnte nicht umgestellt werden.' });
        endA('Der Briefkasten-Server konnte nicht umgestellt werden. Dein Konto bleibt auf diesem Gerät.');
        return;
      }
      s.finishing = true;
      safeSend(conn, { t: 'ldone' });
      const bye = await waitFor(s, 'lbye', 20000).then(() => true, () => false);
      // Ohne Bestätigung nur abmelden, wenn der Briefkasten schon umgestellt ist
      // (dann kann das neue Gerät selbst prüfen, dass der Umzug geklappt hat).
      if (!bye && r !== 'ok') {
        endA('Das neue Gerät hat nicht geantwortet. Dein Konto bleibt vorsichtshalber auch auf diesem Gerät angemeldet.');
        return;
      }
      await logout();
    }

    // Dieses Gerät abmelden: Peer schließen, alle Daten löschen, neu laden (zeigt die Einrichtung)
    async function logout() {
      loggedOut = true;
      try { if (peer) peer.destroy(); } catch {}
      for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
      await db.destroy();
      localStorage.setItem(LS_PREFIX + 'movedNotice', JSON.stringify(Date.now()));
      window.chatboxWindow.reload();
    }

    // ---------------- Neues Gerät (hier wird die Anmeldung gestartet) ----------------
    let b = null;

    function deviceKind() {
      if (!document.documentElement.classList.contains('is-web')) return 'pc';
      return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'ios' : 'web';
    }

    function setStatusB(text, err) {
      const st = $('loginStatus');
      st.textContent = text || '';
      st.classList.toggle('err', !!err);
    }
    // Ansicht: 'code' (Konto-Code eingeben), 'wait' (verbinden), 'verify' (Bestätigungscode), 'busy' (Übertragung)
    function uiB(stage) {
      const code = $('loginCode'), ver = $('loginVerify'), btn = $('loginBtn');
      code.disabled = stage !== 'code';
      ver.classList.toggle('hidden', stage !== 'verify' && stage !== 'busy');
      ver.disabled = stage !== 'verify';
      btn.disabled = stage === 'wait' || stage === 'busy';
      btn.textContent = stage === 'verify' ? 'Bestätigen' : 'Weiter';
      $('loginBack').disabled = stage === 'busy';
      if (stage === 'code') code.focus();
      if (stage === 'verify') { ver.value = ''; ver.focus(); }
    }

    async function cleanupB(wipe) {
      const cur = b;
      b = null;
      if (!cur) return;
      clearTimeout(cur.timer);
      try { cur.peer.destroy(); } catch {}
      if (wipe && cur.received) await db.destroy(); // halb übertragene Chats wegwerfen
    }
    function failB(text) {
      if (!b) return;
      cleanupB(true);
      setStatusB(text, true);
      uiB('code');
    }

    async function startB(raw) {
      const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!CODE_RE.test(code)) { setStatusB('Gib deinen 6-stelligen Code ein (steht in WhatsUp oben unter deinem Namen).', true); return; }
      if (me) return;
      await db.destroy(); // Reste eines abgebrochenen Versuchs entfernen (ohne Konto gibt es hier nichts anderes)
      const tmp = new Peer(LOGIN_PREFIX + hex(12), { debug: 0 });
      const cur = b = { peer: tmp, code, stage: 'wait', ls: null, n: 0, total: 0, received: false };
      uiB('wait');
      setStatusB('Verbinde mit deinem Konto…');
      cur.timer = setTimeout(() => { if (b === cur) failB('Keine Antwort. Ist WhatsUp auf deinem anderen Gerät geöffnet und auf dem neuesten Stand?'); }, 25000);
      tmp.on('open', () => {
        if (b !== cur) return;
        const conn = cur.conn = tmp.connect(peerIdOf(code), { reliable: true });
        conn.on('open', () => conn.send({ t: 'lreq', v: 1, device: deviceKind() }));
        conn.on('data', (d) => { if (b === cur) onB(cur, d).catch((e) => { console.error('Anmeldung:', e); failB('Fehler bei der Übertragung: ' + (e.message || e)); }); });
        const gone = () => { if (b === cur) closedB(cur); };
        conn.on('close', gone);
        conn.on('error', gone);
      });
      tmp.on('error', (err) => {
        if (b !== cur) return;
        if (err.type === 'peer-unavailable') failB('Dein Konto ist gerade auf keinem Gerät online. Öffne WhatsUp auf deinem anderen Gerät und versuch es nochmal.');
        else failB('Verbindung fehlgeschlagen. Prüfe deine Internetverbindung.');
      });
    }

    async function onB(cur, d) {
      if (!d || typeof d !== 'object') return;
      const conn = cur.conn;
      switch (d.t) {
        case 'lwait':
          clearTimeout(cur.timer);
          cur.stage = 'verify';
          uiB('verify');
          setStatusB('Auf deinem anderen Gerät wird jetzt ein Bestätigungscode angezeigt. Gib ihn hier ein.');
          break;
        case 'lbusy':
          failB('Dein anderes Gerät nimmt gerade keine Anmeldung an (es läuft schon eine, oder sie ist nach falschen Codes kurz gesperrt). Versuch es später nochmal.');
          break;
        case 'lwrong': {
          const left = Math.max(0, Number(d.left) || 0);
          uiB('verify');
          setStatusB(`Falscher Code. Noch ${left} ${left === 1 ? 'Versuch' : 'Versuche'}.`, true);
          break;
        }
        case 'lfail':
          failB(d.why === 'tries' ? 'Zu viele falsche Codes. Versuch es in 10 Minuten nochmal.'
            : d.why === 'denied' ? 'Die Anmeldung wurde auf deinem anderen Gerät abgelehnt.'
            : 'Der Bestätigungscode ist abgelaufen. Versuch es nochmal.');
          break;
        case 'lok': {
          cur.stage = 'transfer';
          uiB('busy');
          setStatusB('Bestätigt! Dein Konto wird übertragen…');
          cur.ident = await relay.newIdentity();
          conn.send({ t: 'lkeys', keys: await relay.rotationRequest(cur.code, cur.ident) });
          break;
        }
        case 'lls': {
          if (cur.stage !== 'transfer' || !d.ls || typeof d.ls !== 'object') return;
          const ls = {};
          for (const [k, v] of Object.entries(d.ls)) if (LS_KEY_RE.test(k) && typeof v === 'string') ls[k] = v;
          let acct = null;
          try { acct = JSON.parse(ls.me || 'null'); } catch {}
          if (!acct || acct.code !== cur.code) throw new Error('Unerwartete Kontodaten');
          cur.ls = ls;
          cur.total = Math.max(0, Number(d.total) || 0);
          break;
        }
        case 'lidb':
          if (!cur.ls || !IDB_STORES.includes(d.store) || typeof d.key !== 'string') return;
          cur.received = true;
          await db.put(d.store, d.key, d.value);
          cur.n++;
          setStatusB(`Dein Konto wird übertragen… ${cur.total ? Math.min(100, Math.floor((cur.n / cur.total) * 100)) : 100} %`);
          conn.send({ t: 'lack' });
          break;
        case 'lend':
          if (!cur.ls) return;
          cur.stage = 'stored';
          setStatusB('Fast fertig…');
          conn.send({ t: 'lstored' });
          break;
        case 'lerr':
          failB('Der Umzug ist fehlgeschlagen. Dein Konto bleibt auf dem anderen Gerät.');
          break;
        case 'ldone':
          if (cur.stage !== 'stored') return;
          await finishB(cur);
          break;
      }
    }

    // Verbindung weg, nachdem alles übertragen war: Hat das alte Gerät den Briefkasten schon umgestellt?
    async function closedB(cur) {
      if (cur.stage === 'wait') { failB('Dein anderes Gerät hat die Anmeldung nicht angenommen. Ist dort die neueste WhatsUp-Version installiert?'); return; }
      if (cur.stage !== 'stored') { failB('Die Verbindung zu deinem anderen Gerät wurde unterbrochen. Versuch es nochmal.'); return; }
      let base = null;
      try { base = JSON.parse(cur.ls.relayUrl || 'null'); } catch {}
      if (await relay.serverHasKey(cur.code, cur.ident.signPub, base || undefined)) await finishB(cur);
      else failB('Die Verbindung zu deinem anderen Gerät wurde unterbrochen. Versuch es nochmal.');
    }

    async function finishB(cur) {
      if (cur.finished) return;
      cur.finished = true;
      for (const [k, v] of Object.entries(cur.ls)) localStorage.setItem(LS_PREFIX + k, v);
      localStorage.removeItem(LS_PREFIX + 'movedNotice');
      await db.put('keys', 'identity', cur.ident);
      setStatusB('Geschafft! WhatsUp startet…');
      safeSend(cur.conn, { t: 'lbye' });
      await sleep(600); // Zeit für das „Tschüss“ ans alte Gerät
      clearTimeout(cur.timer);
      try { cur.peer.destroy(); } catch {}
      window.chatboxWindow.reload();
    }

    function submitB() {
      if (!b) { startB($('loginCode').value); return; }
      if (b.stage !== 'verify' || !b.conn) return;
      const code = $('loginVerify').value.replace(/\D/g, '');
      if (code.length !== 6) { setStatusB('Der Bestätigungscode hat 6 Ziffern.', true); $('loginVerify').focus(); return; }
      uiB('wait');
      setStatusB('Prüfe…');
      safeSend(b.conn, { t: 'lcode', code });
    }

    // Einrichtung: „Ich habe schon ein Konto“
    $('setupLoginLink').onclick = () => {
      $('setupNew').classList.add('hidden');
      $('setupLogin').classList.remove('hidden');
      setStatusB('');
      uiB('code');
    };
    $('loginBack').onclick = () => {
      cleanupB(true);
      $('setupLogin').classList.add('hidden');
      $('setupNew').classList.remove('hidden');
      $('setupName').focus();
    };
    $('loginBtn').onclick = submitB;
    ['loginCode', 'loginVerify'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') submitB(); }));

    // Hinweis nach dem Abmelden auf dem alten Gerät
    if (store.load('movedNotice', null)) {
      localStorage.removeItem(LS_PREFIX + 'movedNotice');
      $('setupMoved').classList.remove('hidden');
    }

    return { incoming };
  })();

  // ================= Start =================
  async function boot() {
    if (!me.pv) { me.pv = Date.now(); saveMeta(); } // Freunde holen sich so einmal das aktuelle Profil
    await loadData();
    show('viewList');
    stories.prune();
    setInterval(() => stories.prune(), 5 * 60 * 1000);
    setTimeout(() => fire.tick(), 3000);
    setInterval(() => fire.tick(), 10 * 60 * 1000);
    checkAchievements();
    render();
    startPeer();
    setInterval(connectAll, RETRY_MS);
    relay.start();
    window.chatboxWindow.ready(); // jetzt dürfen Antworten aus Benachrichtigungen kommen
  }

  applyTheme();
  sendPrefs();
  if (me) boot();
  else { show('viewSetup'); $('setupName').focus(); }
})();
