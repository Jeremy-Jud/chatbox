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
  const MAX_MEDIA = 10 * 1024 * 1024; // Länge der Base64-Daten-URL
  const MAX_AVATAR = 300 * 1024;
  const MEDIA_RE = /^data:image\/(png|jpeg|gif|webp);base64,/;
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
      const r = indexedDB.open('chatbox', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('chats'); r.result.createObjectStore('media'); };
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
    runInBackground: true, openAtLogin: false, bgHintShown: false,
  }, store.load('settings', {}));
  const saveSettings = () => store.save('settings', settings);
  let unlocked = store.load('achievements', {});   // id -> Zeitstempel
  const stats = Object.assign({
    sent: 0, groupSent: 0, images: 0, gifs: 0, emojis: 0, received: 0, groupsCreated: 0,
    avatarSet: 0, night: 0, early: 0, days: 0, streak: 0, maxStreak: 0, lastDay: '',
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
    if (m.kind !== 'image' && m.kind !== 'gif') return null;
    if (typeof m.data !== 'string' || m.data.length > MAX_MEDIA || !MEDIA_RE.test(m.data.slice(0, 40))) return null;
    const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 20000 ? n : 300; };
    return { kind: m.kind, data: m.data, w: dim(m.w), h: dim(m.h) };
  }

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
          if (pendingAdd === code) {
            setStatus('Freund ist gerade nicht online. Ihr werdet verbunden, sobald dein Freund WhatsUp öffnet.');
            pendingAdd = null;
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
      const old = conns[code];
      if (old && old !== conn && old.open) {
        // Beide haben gleichzeitig verbunden: die Verbindung des kleineren Codes gewinnt
        const initiator = mine ? me.code : code;
        if (initiator !== (me.code < code ? me.code : code)) { conn.close(); return; }
        conns[code] = conn;
        old.close();
      } else conns[code] = conn;
      conn.send(helloPayload(code));
      Object.values(groups).forEach((g) => { if (g.members.includes(code)) conn.send({ type: 'group', group: g }); });
      flushPending(code);
      scheduleRender();
    });
    conn.on('data', (data) => { try { handleData(code, data); } catch (e) { console.error(e); } });
    const drop = () => { if (conns[code] === conn) delete conns[code]; scheduleRender(); };
    conn.on('close', drop);
    conn.on('error', drop);
  }

  function helloPayload(code) {
    return {
      type: 'hello', v: 2, name: me.name, status: me.status || '', avatar: me.avatar || null, frame: me.frame || null,
      badges: Object.keys(unlocked).length, ctx: isFriend(code) ? 'friend' : 'group',
    };
  }

  function sendTo(code, data) {
    if (!isOnline(code)) return false;
    try { conns[code].send(data); return true; } catch { return false; }
  }
  function broadcastProfile() { Object.keys(conns).forEach((c) => sendTo(c, helloPayload(c))); }

  function handleData(code, data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'hello': {
        const c = ensureContact(code);
        c.name = clean(data.name, 24) || c.name;
        c.status = clean(data.status, 80);
        c.avatar = validAvatar(data.avatar);
        c.frame = validFrame(data.frame);
        c.badges = Math.max(0, Math.min(999, Number(data.badges) || 0));
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

  function receiveMessage(chatId, from, data, gid) {
    const id = String(data.id || '').slice(0, 64);
    if (!id) return;
    const list = (chats[chatId] = chats[chatId] || []);
    if (!list.some((m) => m.id === id)) {
      const text = clean(data.text, MAX_TEXT);
      const media = validMedia(data.media);
      if (!text && !media) return;
      const msg = { id, from, text, ts: clampTs(data.ts) };
      if (media) { msg.media = { kind: media.kind, w: media.w, h: media.h }; putMedia(chatId, id, media.data); }
      list.push(msg);
      saveChat(chatId);
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
    sendTo(from, gid ? { type: 'ack', id, gid } : { type: 'ack', id });
  }

  function recipientsOf(chatId) {
    if (chatId.startsWith('u:')) return [chatId.slice(2)];
    const g = groups[chatId.slice(2)];
    return g ? others(g) : [];
  }

  function enqueue(code, fn) {
    queues[code] = (queues[code] || Promise.resolve()).then(fn).catch(console.error);
  }

  async function deliverTo(chatId, msg, code) {
    if (!isOnline(code)) return;
    const wire = { id: msg.id, text: msg.text, ts: msg.ts };
    if (msg.media) {
      const data = await getMedia(chatId, msg.id);
      if (!data) return;
      wire.media = { kind: msg.media.kind, w: msg.media.w, h: msg.media.h, data };
    }
    if (chatId.startsWith('g:')) { wire.type = 'gmsg'; wire.gid = chatId.slice(2); } else wire.type = 'msg';
    if (sendTo(code, wire) && !msg.sentTo.includes(code)) { msg.sentTo.push(code); saveChat(chatId); scheduleRender(); }
  }

  function flushPending(code) {
    for (const [chatId, list] of Object.entries(chats)) {
      for (const m of list) {
        if (m.from === me.code && m.to && m.to.includes(code) && !m.deliveredTo.includes(code)) {
          enqueue(code, () => deliverTo(chatId, m, code));
        }
      }
    }
  }

  async function sendMessage(chatId, text, media) {
    const to = recipientsOf(chatId);
    const msg = { id: crypto.randomUUID(), from: me.code, text, ts: Date.now(), to, sentTo: [], deliveredTo: [] };
    if (media) { msg.media = { kind: media.kind, w: media.w, h: media.h }; await putMedia(chatId, msg.id, media.data); }
    (chats[chatId] = chats[chatId] || []).push(msg);
    saveChat(chatId);
    to.forEach((code) => (isOnline(code) ? enqueue(code, () => deliverTo(chatId, msg, code)) : connectTo(code)));

    stats.sent++;
    if (chatId.startsWith('g:')) stats.groupSent++;
    if (media) media.kind === 'gif' ? stats.gifs++ : stats.images++;
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
    others(g).forEach((c) => (isOnline(c) ? sendTo(c, { type: 'group', group: g }) : connectTo(c)));
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
    others(g).forEach((c) => sendTo(c, { type: 'gleave', gid: g.id }));
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
      if (url.length > MAX_MEDIA) throw new Error('Das GIF ist zu groß (max. 7 MB).');
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
  const sendPrefs = () => window.chatboxWindow.setPrefs({ runInBackground: settings.runInBackground, openAtLogin: settings.openAtLogin });

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
  const preview = (m) => (m.media ? (m.media.kind === 'gif' ? '🎞️ GIF' : '📷 Bild') + (m.text ? ' ' + m.text : '') : m.text);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const FRAMES = window.WHATSUP_FRAMES;
  const validFrame = (f) => (typeof f === 'string' && Object.prototype.hasOwnProperty.call(FRAMES, f) ? f : null);

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
  const TITLES = { viewList: 'WhatsUp', viewChat: 'WhatsUp', viewSettings: 'Einstellungen', viewAchievements: 'Erfolge', viewSetup: 'WhatsUp' };

  function show(v) {
    view = v;
    ['viewSetup', 'viewList', 'viewChat', 'viewSettings', 'viewAchievements'].forEach((x) => $(x).classList.toggle('hidden', x !== v));
    $('settingsBtn').classList.toggle('hidden', v === 'viewSetup');
    $('settingsBtn').classList.toggle('active', v === 'viewSettings');
    $('backBtn').classList.toggle('hidden', v === 'viewList' || v === 'viewSetup');
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
    if (view === 'viewChat') renderChat();
    if (view === 'viewAchievements') renderAchievements();
  }

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
      meta.appendChild(el('div', 'fname', isGroup ? groups[code].name : nameOf(code)));
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
    if (isGroup) {
      const g = groups[code];
      const on = others(g).filter(isOnline).length;
      $('chatName').textContent = g.name;
      $('chatSub').textContent = `${g.members.length} Mitglieder · ${on} online` + (g.desc ? ' · ' + g.desc.replace(/\s+/g, ' ') : '');
    } else {
      const c = contacts[code];
      $('chatName').textContent = c.name;
      $('chatSub').textContent = (isOnline(code) ? 'online' : 'offline') + (c.status ? ' · ' + c.status : '');
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
      const div = el('div', 'msg ' + (mine ? 'me' : 'them') + (big ? ' big' : '') + (m.media ? ' has-media' : ''));
      if (m.media) div.appendChild(mediaEl(chatId, m));
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
    activeChat = chatId;
    delete unread[chatId];
    saveMeta();
    show('viewChat');
    render();
    recipientsOf(chatId).forEach(connectTo);
    $('msgInput').focus();
  }

  function closeChat() {
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
        if (c.status) head.appendChild(el('div', 'muted', c.status));
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
    [['recent', '🕓'], ...Object.keys(EMOJI).map((k) => [k, k])].forEach(([key, icon]) => {
      const b = el('button', 'emoji-tab' + (key === emojiTab ? ' active' : ''), icon);
      b.type = 'button';
      b.onclick = () => { emojiTab = key; renderEmojiPanel(); };
      tabs.appendChild(b);
    });
    const grid = $('emojiGrid');
    grid.replaceChildren();
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
    input.focus();
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
  function openSettings() {
    draftAvatar = me.avatar || null;
    draftFrame = validFrame(me.frame);
    $('profName').value = me.name;
    $('profStatus').value = me.status || '';
    $('profCode').textContent = me.code;
    $('setNotify').checked = settings.notify;
    $('setSound').checked = settings.sound;
    $('setPreview').checked = settings.preview;
    $('setBackground').checked = settings.runInBackground;
    $('setLogin').checked = settings.openAtLogin;
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
      const b = el('button', 'frame-opt' + (id === draftFrame ? ' active' : ''));
      b.type = 'button';
      b.title = id ? FRAMES[id].name : 'Kein Rahmen';
      b.appendChild(avatarEl(name, draftAvatar, me.code, 'md', null, id));
      b.appendChild(el('span', 'frame-name', id ? FRAMES[id].name : 'Keiner'));
      b.onclick = () => { draftFrame = id; renderProfAvatar(); markProfileDirty(profileDirty()); };
      grid.appendChild(b);
    });
  }
  function markProfileDirty(dirty) {
    $('profSave').classList.toggle('hidden', !dirty);
  }
  const profileDirty = () => $('profName').value.trim() !== me.name || $('profStatus').value.trim() !== (me.status || '') ||
    draftAvatar !== (me.avatar || null) || draftFrame !== validFrame(me.frame);

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
    b.onclick = () => { settings.theme = b.dataset.theme; saveSettings(); applyTheme(); renderTheme(); };
  });

  // Allgemein
  function renderNotifyRows() {
    ['setSound', 'setPreview'].forEach((id) => $(id).closest('.setting').classList.toggle('disabled', !settings.notify));
  }
  $('setNotify').onchange = (e) => { settings.notify = e.target.checked; saveSettings(); renderNotifyRows(); };
  $('setSound').onchange = (e) => { settings.sound = e.target.checked; saveSettings(); };
  $('setPreview').onchange = (e) => { settings.preview = e.target.checked; saveSettings(); };
  $('setBackground').onchange = (e) => { settings.runInBackground = e.target.checked; saveSettings(); sendPrefs(); };
  $('setLogin').onchange = (e) => { settings.openAtLogin = e.target.checked; saveSettings(); sendPrefs(); };
  $('notifyTest').onclick = () => {
    window.chatboxWindow.notify({ title: 'WhatsUp', body: 'So sehen deine Benachrichtigungen aus 👋', silent: !settings.sound });
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
  $('backBtn').onclick = () => (view === 'viewChat' ? closeChat() : (show('viewList'), render()));
  $('trophyBtn').onclick = () => { show('viewAchievements'); renderAchievements(); };
  $('settingsBtn').onclick = openSettings;
  $('meCardBtn').onclick = openSettings;
  $('newGroupBtn').onclick = openNewGroup;
  $('chatHead').onclick = openInfo;
  $('modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('viewer').classList.contains('hidden')) $('viewer').classList.add('hidden');
    else if (!$('modal').classList.contains('hidden')) closeModal();
    else if (!$('emojiPanel').classList.contains('hidden')) hideEmoji();
  });

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
    setStatus(peer && peer.open ? 'Verbinde…' : 'Gespeichert. Wird verbunden, sobald du wieder online bist…');
    if (isOnline(code)) conns[code].send(helloPayload(code));
    else { delete connecting[code]; connectTo(code); }
    checkAchievements();
    render();
  };

  $('sendForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('msgInput').value.trim();
    if (!text || !activeChat) return;
    $('msgInput').value = '';
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

  // ================= Start =================
  async function boot() {
    await loadData();
    show('viewList');
    checkAchievements();
    render();
    startPeer();
    setInterval(connectAll, RETRY_MS);
    window.chatboxWindow.ready(); // jetzt dürfen Antworten aus Benachrichtigungen kommen
  }

  applyTheme();
  sendPrefs();
  if (me) boot();
  else { show('viewSetup'); $('setupName').focus(); }
})();
