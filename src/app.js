/* Chatbox – Peer-to-Peer-Chat über WebRTC (PeerJS).
 * Jeder Nutzer hat einen 6-stelligen Code. Der Code ist gleichzeitig die
 * Peer-ID, über die andere eine direkte Verbindung aufbauen. */
(() => {
  'use strict';

  const ID_PREFIX = 'chatbox-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I
  const RETRY_MS = 10000;
  const $ = (id) => document.getElementById(id);

  // ---------- Speicher ----------
  const store = {
    load(key, fallback) {
      try { const v = localStorage.getItem('chatbox.' + key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    save(key, value) {
      try { localStorage.setItem('chatbox.' + key, JSON.stringify(value)); } catch {}
    },
  };

  let me = store.load('me', null);                 // { code, name }
  let friends = store.load('friends', {});         // code -> { name, unread }
  let messages = store.load('messages', {});       // code -> [ { id, from, text, ts, status } ]
  const saveAll = () => { store.save('me', me); store.save('friends', friends); store.save('messages', messages); };

  // ---------- Netzwerk ----------
  let peer = null;
  const conns = {};      // code -> DataConnection
  let activeChat = null; // code des offenen Chats
  let pendingAdd = null;

  const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  const peerIdOf = (code) => ID_PREFIX + code.toLowerCase();
  const codeOf = (peerId) => peerId.slice(ID_PREFIX.length).toUpperCase();
  const isOnline = (code) => !!(conns[code] && conns[code].open);

  function startPeer() {
    if (peer) { try { peer.destroy(); } catch {} }
    peer = new Peer(peerIdOf(me.code), { debug: 0 });

    peer.on('open', () => { setNet(true); connectAll(); });
    peer.on('connection', (conn) => setupConn(conn));
    peer.on('disconnected', () => { setNet(false); setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 3000); });
    peer.on('error', (err) => {
      if (err.type === 'peer-unavailable') {
        const m = /chatbox-v1-(\w+)/i.exec(err.message || '');
        if (m && pendingAdd && m[1].toUpperCase() === pendingAdd) {
          setStatus('Freund ist gerade nicht online. Er wird verbunden, sobald er Chatbox öffnet.');
          pendingAdd = null;
        }
        return;
      }
      if (err.type === 'unavailable-id') {
        // ID noch vom letzten Start belegt – kurz warten und neu versuchen
        setNet(false);
        setTimeout(startPeer, 5000);
        return;
      }
      if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        setNet(false);
        setTimeout(startPeer, 8000);
      }
      console.warn('Peer-Fehler:', err.type, err);
    });
  }

  function connectTo(code) {
    if (!peer || !peer.open || code === me.code || isOnline(code)) return;
    const conn = peer.connect(peerIdOf(code), { reliable: true, serialization: 'json' });
    setupConn(conn);
  }

  function connectAll() { Object.keys(friends).forEach(connectTo); }

  function setupConn(conn) {
    const code = codeOf(conn.peer);
    if (!/^[A-Z0-9]{6}$/.test(code)) { conn.close(); return; }

    conn.on('open', () => {
      const old = conns[code];
      conns[code] = conn;
      if (old && old !== conn && old.open) old.close();
      conn.send({ type: 'hello', name: me.name });
      flushPending(code);
      render();
    });
    conn.on('data', (data) => handleData(code, data));
    conn.on('close', () => { if (conns[code] === conn) delete conns[code]; render(); });
    conn.on('error', () => { if (conns[code] === conn) delete conns[code]; render(); });
  }

  function handleData(code, data) {
    if (!data || typeof data !== 'object') return;
    switch (data.type) {
      case 'hello': {
        const name = String(data.name || 'Unbekannt').slice(0, 24);
        const isNew = !friends[code];
        friends[code] = { ...(friends[code] || { unread: 0 }), name };
        if (pendingAdd === code) { setStatus(`${name} wurde hinzugefügt ✓`); pendingAdd = null; $('addInput').value = ''; }
        else if (isNew) notify('Neuer Kontakt', `${name} hat dich hinzugefügt.`);
        saveAll(); render();
        break;
      }
      case 'msg': {
        const text = String(data.text || '').slice(0, 2000);
        if (!text) return;
        const list = (messages[code] = messages[code] || []);
        if (!list.some((m) => m.id === data.id)) {
          list.push({ id: String(data.id), from: code, text, ts: Number(data.ts) || Date.now() });
          if (!friends[code]) friends[code] = { name: 'Unbekannt', unread: 0 };
          if (activeChat !== code || !document.hasFocus()) {
            if (activeChat !== code) friends[code].unread = (friends[code].unread || 0) + 1;
            notify(friends[code].name, text);
          }
          saveAll(); render();
        }
        conns[code] && conns[code].open && conns[code].send({ type: 'ack', id: data.id });
        break;
      }
      case 'ack': {
        const m = (messages[code] || []).find((x) => x.id === data.id);
        if (m && m.status !== 'delivered') { m.status = 'delivered'; saveAll(); render(); }
        break;
      }
    }
  }

  function sendMessage(code, text) {
    const msg = { id: crypto.randomUUID(), from: me.code, text, ts: Date.now(), status: 'pending' };
    (messages[code] = messages[code] || []).push(msg);
    saveAll();
    if (isOnline(code)) { conns[code].send({ type: 'msg', id: msg.id, text, ts: msg.ts }); msg.status = 'sent'; saveAll(); }
    else connectTo(code);
    render();
  }

  function flushPending(code) {
    (messages[code] || []).forEach((m) => {
      if (m.from === me.code && m.status !== 'delivered') {
        conns[code].send({ type: 'msg', id: m.id, text: m.text, ts: m.ts });
        m.status = 'sent';
      }
    });
    saveAll();
  }

  // ---------- Benachrichtigungen ----------
  function notify(title, body) {
    window.chatboxWindow && window.chatboxWindow.flash();
    if (document.hasFocus()) return;
    try { new Notification(title, { body: body.slice(0, 120), silent: false }); } catch {}
  }

  // ---------- UI ----------
  const colors = ['#5b8cff', '#ff7a59', '#3ecf8e', '#c06cff', '#ffb547', '#ff5b9e', '#2ec4d6'];
  const colorFor = (code) => colors[[...code].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length];
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const fmtDay = (ts) => new Date(ts).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });

  function setNet(on) { $('netDot').classList.toggle('on', on); }
  function setStatus(text, err) { const s = $('addStatus'); s.textContent = text; s.classList.toggle('err', !!err); }

  function show(view) {
    ['viewSetup', 'viewList', 'viewChat'].forEach((v) => $(v).classList.toggle('hidden', v !== view));
    $('backBtn').classList.toggle('hidden', view !== 'viewChat');
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function renderList() {
    $('myCode').textContent = me.code;
    const ul = $('friendList');
    ul.innerHTML = '';
    const codes = Object.keys(friends).sort((a, b) => lastTs(b) - lastTs(a));
    $('emptyList').classList.toggle('hidden', codes.length > 0);
    codes.forEach((code) => {
      const f = friends[code];
      const li = el('li');
      const av = el('div', 'avatar', (f.name || '?')[0].toUpperCase());
      av.style.background = colorFor(code);
      const d = el('span', 'dot' + (isOnline(code) ? ' on' : ''));
      av.appendChild(d);
      const meta = el('div', 'fmeta');
      meta.appendChild(el('div', 'fname', f.name));
      const last = (messages[code] || []).slice(-1)[0];
      meta.appendChild(el('div', 'flast', last ? (last.from === me.code ? 'Du: ' : '') + last.text : (isOnline(code) ? 'Online' : 'Offline') + ' · ' + code));
      li.append(av, meta);
      if (f.unread) li.appendChild(el('span', 'badge', String(f.unread)));
      const del = el('button', 'del', '✕');
      del.title = 'Entfernen';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`${f.name} entfernen? Der Chatverlauf wird gelöscht.`)) {
          delete friends[code]; delete messages[code];
          if (conns[code]) conns[code].close();
          saveAll(); render();
        }
      };
      li.appendChild(del);
      li.onclick = () => openChat(code);
      ul.appendChild(li);
    });
  }

  const lastTs = (code) => { const l = messages[code]; return l && l.length ? l[l.length - 1].ts : 0; };

  function renderChat() {
    const code = activeChat;
    const f = friends[code];
    if (!f) { closeChat(); return; }
    $('titleText').textContent = `${f.name} ${isOnline(code) ? '· online' : '· offline'}`;
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.innerHTML = '';
    let lastDay = '';
    (messages[code] || []).forEach((m) => {
      const day = fmtDay(m.ts);
      if (day !== lastDay) { box.appendChild(el('div', 'day', day)); lastDay = day; }
      const mine = m.from === me.code;
      const div = el('div', 'msg ' + (mine ? 'me' : 'them'));
      div.appendChild(document.createTextNode(m.text));
      const tick = mine ? (m.status === 'delivered' ? ' ✓✓' : m.status === 'sent' ? ' ✓' : ' 🕓') : '';
      div.appendChild(el('div', 'meta', fmtTime(m.ts) + tick));
      box.appendChild(div);
    });
    if (atBottom || box.dataset.code !== code) box.scrollTop = box.scrollHeight;
    box.dataset.code = code;
  }

  function render() {
    if (!me) return;
    renderList();
    if (activeChat) renderChat();
    else $('titleText').textContent = `Chatbox · ${me.name}`;
  }

  function openChat(code) {
    activeChat = code;
    friends[code].unread = 0;
    saveAll();
    show('viewChat');
    render();
    connectTo(code);
    $('msgInput').focus();
  }

  function closeChat() {
    activeChat = null;
    show('viewList');
    render();
  }

  // ---------- Events ----------
  $('minBtn').onclick = () => window.chatboxWindow.minimize();
  $('closeBtn').onclick = () => window.chatboxWindow.close();
  $('pinBtn').onclick = async () => { const p = await window.chatboxWindow.togglePin(); $('pinBtn').classList.toggle('active', p); };
  $('backBtn').onclick = closeChat;

  $('setupBtn').onclick = () => {
    const name = $('setupName').value.trim();
    if (!name) { $('setupName').focus(); return; }
    me = { code: newCode(), name };
    saveAll();
    boot();
  };
  $('setupName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('setupBtn').click(); });

  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(me.code); $('copyBtn').textContent = 'Kopiert ✓'; }
    catch { $('copyBtn').textContent = 'Fehler'; }
    setTimeout(() => ($('copyBtn').textContent = 'Kopieren'), 1500);
  };

  $('addForm').onsubmit = (e) => {
    e.preventDefault();
    const code = $('addInput').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) return setStatus('Ein Code hat genau 6 Zeichen.', true);
    if (code === me.code) return setStatus('Das ist dein eigener Code 🙂', true);
    if (friends[code]) return setStatus(`${friends[code].name} ist schon in deiner Liste.`);
    if (!peer || !peer.open) return setStatus('Keine Verbindung zum Netzwerk. Prüfe dein Internet.', true);
    friends[code] = { name: 'Freund ' + code, unread: 0 };
    saveAll();
    pendingAdd = code;
    setStatus('Verbinde…');
    connectTo(code);
    render();
  };

  $('sendForm').onsubmit = (e) => {
    e.preventDefault();
    const text = $('msgInput').value.trim();
    if (!text || !activeChat) return;
    $('msgInput').value = '';
    sendMessage(activeChat, text);
  };

  window.addEventListener('focus', () => { if (activeChat && friends[activeChat]) { friends[activeChat].unread = 0; saveAll(); render(); } });

  // ---------- Start ----------
  function boot() {
    show('viewList');
    render();
    startPeer();
    setInterval(connectAll, RETRY_MS);
  }

  if (me) boot();
  else { show('viewSetup'); $('setupName').focus(); }
})();
