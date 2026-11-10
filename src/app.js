/* WhatsUp – Peer-to-Peer-Chat über WebRTC (PeerJS).
 * Jeder Nutzer hat einen 6-stelligen Code = Peer-ID. Einzel- und Gruppenchats,
 * Bilder/GIFs, Emojis, Profilbilder und Erfolge. */
(() => {
  'use strict';

  const ID_PREFIX = 'chatbox-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I
  const CODE_RE = /^[A-Z0-9]{6}$/;
  const RETRY_MS = 10000;
  const MAX_TEXT = 4000;
  const MAX_MB = 25;                                              // max. Größe pro Bild/GIF
  const MAX_MEDIA = Math.ceil(MAX_MB * 1024 * 1024 * 4 / 3) + 64; // als Base64-Daten-URL
  const OLD_MAX_MEDIA = 10 * 1024 * 1024; // Grenze bis v1.10 – ältere Versionen lehnen Größeres ab
  const PROTO = 5;                        // Protokoll-Version (3 = große Dateien bis 25 MB, 4 = Sprachnachrichten, 5 = Sticker)
  const STICKER_OWNER = 'V5KGWG';         // nur dieser Nutzer hat die Sticker-Funktion
  const STICKER_MAX = 1.5 * 1024 * 1024;
  const MAX_AVATAR = 300 * 1024;
  const MEDIA_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;
  const AUDIO_RE = /^data:audio\/(mp4|webm|ogg|mpeg|aac|x-m4a);base64,/;
  const $ = (id) => document.getElementById(id);

  // ================= Speicher =================
  const store = {
    load(key, fallback) {
      try { const v = localStorage.getItem('chatbox.' + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    save(key, value) {
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
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction(name, mode);
        const req = fn(t.objectStore(name));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
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
    if (m.kind !== 'image' && m.kind !== 'gif') return null;
    if (typeof m.data !== 'string' || m.data.length > MAX_MEDIA || !MEDIA_RE.test(m.data.slice(0, 40))) return null;
    const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 20000 ? n : 300; };
    return { kind: m.kind, data: m.data, w: dim(m.w), h: dim(m.h) };
  }

  // Was von einer Datei in der Nachricht gespeichert wird (die Daten selbst liegen in IndexedDB)
  const mediaMeta = (m) => (m.kind === 'audio' ? { kind: 'audio', dur: m.dur || 0, wave: m.wave || [] } : { kind: m.kind, w: m.w, h: m.h });

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
    p.on('connection', (conn) => { if (p === peer) setupConn(conn, false); else conn.close(); });
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
      badges: Object.keys(unlocked).length, ctx: isFriend(code) ? 'friend' : 'group',
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
    if (!list.some((m) => m.id === id)) {
      const text = clean(data.text, MAX_TEXT);
      let media = validMedia(data.media);
      if (media && media.kind === 'sticker' && from !== STICKER_OWNER) media = null;
      if (!text && !media) { sendData(from, gid ? { type: 'ack', id, gid } : { type: 'ack', id }); return; }
      const msg = { id, from, text, ts: clampTs(data.ts) };
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
    if (msg.deliveredTo.includes(code)) return;
    const useRelay = viaRelay || !isOnline(code);
    if (useRelay && (!relay.canSend(code) || (msg.relayedTo || []).includes(code))) return;
    const wire = { id: msg.id, text: msg.text, ts: msg.ts, pv: me.pv || 0 };
    if (msg.media) {
      const data = await getMedia(chatId, msg.id);
      if (!data) return;
      // Ältere Versionen (bis v1.10) lehnen Dateien über ~7 MB ab -> warten, bis der Freund aktualisiert
      if (data.length > OLD_MAX_MEDIA && ((contacts[code] && contacts[code].v) || 1) < PROTO) {
        const k = code + '|' + msg.id;
        if (!oldVersionWarned.has(k)) { oldVersionWarned.add(k); toast(`${nameOf(code)} braucht ein WhatsUp-Update für große GIFs – wird danach zugestellt`); }
        return;
      }
      // Ältere Versionen kennen keine Sprachnachrichten: Hinweistext statt Datei
      const peerV = (contacts[code] && contacts[code].v) || 1;
      if (msg.media.kind === 'audio' && peerV < 4) wire.text = '🎤 Sprachnachricht – aktualisiere WhatsUp, um sie anzuhören.';
      else if (msg.media.kind === 'sticker' && peerV < 5) wire.text = '🩷 Sticker – aktualisiere WhatsUp, um ihn zu sehen.';
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
    if (media) { if (media.kind === 'audio') stats.voices = (stats.voices || 0) + 1; else if (media.kind === 'gif') stats.gifs++; else stats.images++; }
    stats.emojis += emojiCount(text);
    const h = new Date().getHours();
    if (h < 4) stats.night++;
    if (h >= 5 && h < 7) stats.early++;
    touchDay();
    saveMeta(); checkAchievements(); scheduleRender();
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
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of ACH) {
        if (!unlocked[a.id] && statValue(a.stat) >= a.goal) {
          unlocked[a.id] = Date.now();
          changed = true;
          toast(`${a.icon} Erfolg freigeschaltet: ${a.title}`, true);
        }
      }
    }
    saveMeta();
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
  const preview = (m) => (m.media
    ? (m.media.kind === 'sticker' ? '🩷 Sticker' : m.media.kind === 'audio' ? '🎤 Sprachnachricht (' + durText(m.media.dur) + ')' : m.media.kind === 'gif' ? '🎞️ GIF' : '📷 Bild') + (m.text ? ' ' + m.text : '')
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
  const TITLES = { viewList: 'WhatsUp', viewChat: 'WhatsUp', viewSettings: 'Einstellungen', viewAchievements: 'Erfolge', viewSetup: 'WhatsUp', viewStatus: 'Status' };
  const TABS = ['viewStatus', 'viewList', 'viewSettings'];
  let lastTab = 'viewList';

  function show(v) {
    view = v;
    if (TABS.includes(v)) lastTab = v;
    ['viewSetup', 'viewList', 'viewChat', 'viewSettings', 'viewAchievements', 'viewStatus'].forEach((x) => $(x).classList.toggle('hidden', x !== v));
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
      const big = !m.media && onlyEmoji(m.text);
      const isVoice = m.media && m.media.kind === 'audio';
      const isSticker = m.media && m.media.kind === 'sticker';
      const div = el('div', 'msg ' + (mine ? 'me' : 'them') + (big ? ' big' : '') + (isSticker ? ' sticker' : isVoice ? ' has-voice' : m.media ? ' has-media' : ''));
      if (isSticker) div.appendChild(stickers.view(chatId, m));
      else if (isVoice) div.appendChild(voice.el(chatId, m));
      else if (m.media) div.appendChild(mediaEl(chatId, m));
      if (m.text) div.appendChild(el('div', 'text', m.text));
      let tick = '';
      if (mine && m.to && m.to.length) {
        tick = m.deliveredTo.length >= m.to.length ? ' ✓✓' : m.deliveredTo.length || m.sentTo.length ? ' ✓' : ' 🕓';
      }
      div.appendChild(el('div', 'meta', fmtTime(m.ts) + tick));
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
    if (activeChat !== chatId) { voice.stop(false); voice.stopPlayback(); }
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
    closeModal();
    show('viewList');
    render();
  }

  // ================= Modals =================
  function openModal(build) {
    const box = $('modalBox');
    box.replaceChildren();
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
        if (c.badges) head.appendChild(el('div', 'pill', `🏆 ${c.badges} Erfolge`));
        box.appendChild(head);
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
    if (!$('stkEditor').classList.contains('hidden')) $('stkCancel').click();
    else if (!$('stCompose').classList.contains('hidden')) $('stComposeClose').click();
    else if (!$('viewer').classList.contains('hidden')) $('viewer').classList.add('hidden');
    else if (!$('modal').classList.contains('hidden')) closeModal();
    else if (!$('emojiPanel').classList.contains('hidden')) hideEmoji();
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
          if (media && (media.kind === 'audio' || media.kind === 'sticker')) return; // Status nur mit Bildern
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
    const RELAY_TYPES = new Set(['msg', 'gmsg', 'ack', 'group', 'gleave', 'hello', 'status', 'sdel', 'sreact', 'sseen', 'callmiss', 'hreq']);
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

    async function loadKeys() {
      let k = await db.get('keys', 'identity').catch(() => null);
      if (!k) {
        const s = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const e = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        k = {
          signPriv: s.privateKey, encPriv: e.privateKey,
          signPub: pubJwk(await crypto.subtle.exportKey('jwk', s.publicKey)),
          encPub: pubJwk(await crypto.subtle.exportKey('jwk', e.publicKey)),
        };
        await db.put('keys', 'identity', k);
      }
      ident = k;
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
    async function keysOf(code) {
      const c = contacts[code];
      if (c && c.keys && c.keys.sign && c.keys.enc) return c.keys;
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
      const keys = await keysOf(from);
      if (!keys) return null;
      const vkey = await crypto.subtle.importKey('jwk', keys.sign, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkey, sig, cat(head, ct)))) return null; // gefälscht
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
    }

    // Abholen: beim Start, jede Minute, beim Zurückkehren in die App und wenn das Netz wieder da ist
    setInterval(() => poll(), 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
    if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'relay-poll') poll(); });
    window.addEventListener('online', () => poll());

    return {
      start, poll, send, setupPush, pushTest, saveNames, renderRelayStatus,
      canSend: (code) => ready && enabled() && known[code] !== false,
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
