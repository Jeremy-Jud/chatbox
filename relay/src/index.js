/*
 * WhatsUp Briefkasten-Server (Cloudflare Worker + Durable Object pro Nutzer-Code)
 *
 * - Speichert nur Ende-zu-Ende-verschlüsselte Nachrichten (der Server kann sie nicht lesen).
 * - Jede Anfrage ist mit dem Schlüssel des Absenders/Empfängers signiert.
 * - Nachrichten werden nach dem Abholen gelöscht, spätestens nach 30 Tagen.
 * - Optional: Web-Push an die Web-Version (iPhone/iPad), wenn eine Nachricht eintrifft.
 */

const CODE_RE = /^[A-Z0-9]{6}$/;
const MAX_BODY = 40 * 1024 * 1024;        // eine verschlüsselte Nachricht (25-MB-GIF + Base64 + Verschlüsselung)
const MAX_BOX_BYTES = 300 * 1024 * 1024;  // pro Briefkasten
const MAX_BOX_MSGS = 3000;
const CHUNK = 1024 * 1024;                // SQLite-Zeilen bleiben unter 2 MB
const TTL_MS = 30 * 24 * 3600 * 1000;
const CLOCK_SKEW = 10 * 60 * 1000;
const SEND_LIMIT_PER_MIN = 120;           // pro Absender und Empfänger
const ACH_ID_RE = /^[a-z0-9_]{1,24}$/;   // Erfolgs-IDs wie 'msg100'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-From, X-Ts, X-Sig, X-Silent, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
  'Access-Control-Max-Age': '86400',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const fail = (status, error) => json({ error }, status);

// ---------- Hilfsfunktionen (Base64url, Signaturen) ----------
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

function validJwk(k) {
  return k && typeof k === 'object' && k.kty === 'EC' && k.crv === 'P-256' && typeof k.x === 'string' && typeof k.y === 'string' && !k.d
    ? { kty: 'EC', crv: 'P-256', x: k.x, y: k.y } : null;
}
async function verify(signJwk, sigB64u, text) {
  try {
    const key = await crypto.subtle.importKey('jwk', signJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64u(sigB64u), enc.encode(text));
  } catch { return false; }
}
// Secrets können ein unsichtbares BOM/Leerzeichen enthalten (z. B. aus PowerShell)
const clean = (s) => String(s || '').replace(/^﻿/, '').trim();
const freshTs = (ts) => Number.isFinite(ts) && Math.abs(Date.now() - ts) < CLOCK_SKEW;

// ---------- Worker: leitet Anfragen an den Briefkasten des jeweiligen Codes ----------
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // v1 / <aktion> / <code> [/ …]
    if (parts[0] !== 'v1') return fail(404, 'not found');
    if (parts[1] === 'health') return json({ ok: true });
    if (parts[1] === 'vapid') return json({ key: clean(env.VAPID_PUBLIC) || null });
    // Wie viele Personen auf der Welt besitzen welchen Erfolg? (öffentlich, nur Zahlen)
    if (parts[1] === 'achstats') return env.ACHSTATS.get(env.ACHSTATS.idFromName('global')).fetch('https://stats/counts');
    // Welche Erfolge hat dieser Code? (für das Profil aus UpReels, nur die IDs)
    // Ranglisten (öffentlich): ?type=ach|fire|chall&me=CODE&friends=CODE,CODE…
    if (parts[1] === 'leaderboard') return env.ACHSTATS.get(env.ACHSTATS.idFromName('global')).fetch('https://stats/leaderboard' + url.search);
    // Admin: Ist dieser Code Admin? (öffentlich, nur ja/nein)
    if (parts[1] === 'isadmin') return json({ admin: admins(env).includes(String(parts[2] || '').toUpperCase()) });
    // Admin: alle Nutzer (Name, Code, zuletzt aktiv) – nur mit Signatur eines Admin-Codes
    if (parts[1] === 'admin' && parts[2] === 'users' && req.method === 'POST') {
      const b = await req.json().catch(() => ({}));
      const code = String(b.code || '').toUpperCase();
      if (!admins(env).includes(code) || !freshTs(Number(b.ts)) || !(await codeSigned(env, code, `adminusers|${code}|${b.ts}`, b.sig))) return fail(403, 'forbidden');
      return env.ACHSTATS.get(env.ACHSTATS.idFromName('global')).fetch('https://stats/users');
    }
    if (parts[1] === 'achuser') {
      const c = String(parts[2] || '').toUpperCase();
      if (!CODE_RE.test(c)) return fail(400, 'bad code');
      return env.ACHSTATS.get(env.ACHSTATS.idFromName('global')).fetch('https://stats/user/' + c);
    }
    // UpReels: Videos gehen an den Speicher des jeweiligen Reels, alles andere an den zentralen Index
    if (parts[1] === 'reels') {
      if (parts[2] === 'video' && /^[a-z0-9]{16,40}$/.test(parts[3] || '') && (req.method === 'GET' || req.method === 'HEAD')) {
        return env.REELBLOB.get(env.REELBLOB.idFromName(parts[3])).fetch(req);
      }
      // Foto-Beitrag: /v1/reels/photo/<id>/<nr> – jedes Foto liegt in einem eigenen Speicher
      if (parts[2] === 'photo' && /^[a-z0-9]{16,40}$/.test(parts[3] || '') && /^\d{1,2}$/.test(parts[4] || '') && (req.method === 'GET' || req.method === 'HEAD')) {
        return env.REELBLOB.get(env.REELBLOB.idFromName(`${parts[3]}-p${Number(parts[4])}`)).fetch(req);
      }
      return env.REELS.get(env.REELS.idFromName('global')).fetch(req);
    }
    const code = String(parts[2] || '').toUpperCase();
    if (!CODE_RE.test(code)) return fail(400, 'bad code');
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(code));
    return stub.fetch(req);
  },
};

// ---------- Durable Object: ein Briefkasten pro Code ----------
export class Mailbox {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sendCounts = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, sender TEXT, ts INTEGER, size INTEGER, chunks INTEGER);
      CREATE TABLE IF NOT EXISTS chunks (msg INTEGER, idx INTEGER, data BLOB, PRIMARY KEY (msg, idx));
      CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, sub TEXT, created INTEGER);`);
  }

  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }
  setMeta(k, v) { this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v); }
  keys() { const k = this.getMeta('keys'); return k ? JSON.parse(k) : null; }

  // Signierte Anfrage des Briefkasten-Besitzers prüfen
  async ownerOk(action, code, ts, sig, extra = '') {
    const keys = this.keys();
    if (!keys || !freshTs(ts)) return false;
    return verify(keys.sign, sig, `${action}|${code}|${ts}${extra}`);
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, action, codeRaw, arg] = url.pathname.split('/').filter(Boolean);
    const code = codeRaw.toUpperCase();
    try {
      switch (action) {
        case 'register': return this.register(code, await req.json());
        case 'rotate': return this.rotate(code, await req.json());
        case 'keys': {
          const k = this.keys();
          return k ? json({ sign: k.sign, enc: k.enc }) : fail(404, 'unknown');
        }
        case 'send': return this.receive(code, req);
        case 'inbox': return this.inbox(code, await req.json());
        case 'get': return this.get(code, Number(arg), req);
        case 'ack': return this.ack(code, await req.json());
        case 'push': return this.pushSub(code, await req.json());
        case 'pushtest': return this.pushTest(code, await req.json());
        case 'verify': return this.verifyFromOwner(code, await req.json()); // intern
        case 'achreport': return this.achReport(code, await req.json());
        case 'seen': return this.seen(code, await req.json());
        default: return fail(404, 'not found');
      }
    } catch (e) {
      return fail(500, String(e && e.message || e).slice(0, 200));
    }
  }

  // Schlüssel zum Code hinterlegen (beim ersten Mal). Danach nur noch mit demselben Schlüssel.
  async register(code, b) {
    const sign = validJwk(b.sign), encKey = validJwk(b.enc);
    if (!sign || !encKey || !freshTs(b.ts)) return fail(400, 'bad request');
    const text = `register|${code}|${b.ts}|${sign.x}.${sign.y}|${encKey.x}.${encKey.y}`;
    if (!(await verify(sign, b.sig, text))) return fail(403, 'bad signature');
    const old = this.keys();
    if (old && (old.sign.x !== sign.x || old.sign.y !== sign.y)) return fail(409, 'code taken');
    this.setMeta('keys', JSON.stringify({ sign, enc: encKey }));
    await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
    return json({ ok: true });
  }

  // Konto zieht auf ein neues Gerät um: neue Schlüssel, bestätigt vom alten Schlüssel (sig)
  // und vom neuen (sigNew, beweist den Besitz des neuen privaten Schlüssels).
  async rotate(code, b) {
    const sign = validJwk(b.sign), encKey = validJwk(b.enc);
    if (!sign || !encKey || !freshTs(b.ts)) return fail(400, 'bad request');
    const text = `rotate|${code}|${b.ts}|${sign.x}.${sign.y}|${encKey.x}.${encKey.y}`;
    if (!(await verify(sign, b.sigNew, text))) return fail(403, 'bad signature');
    const old = this.keys();
    if (old && !(await verify(old.sign, b.sig, text))) return fail(403, 'forbidden');
    this.setMeta('keys', JSON.stringify({ sign, enc: encKey }));
    this.sql.exec('DELETE FROM subs'); // Push-Abos gehörten zum alten Gerät
    await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
    return json({ ok: true });
  }

  // Interner Aufruf eines anderen Briefkastens: „Hat der Besitzer dieses Codes das signiert?“
  async verifyFromOwner(code, b) {
    const keys = this.keys();
    if (!keys) return json({ ok: false });
    return json({ ok: await verify(keys.sign, b.sig, String(b.text || '')) });
  }

  // Eigene Erfolge melden (nur die IDs), damit gezählt werden kann, wie selten sie sind
  async achReport(code, b) {
    const ach = Array.isArray(b.ach) ? [...new Set(b.ach.map(String).filter((id) => ACH_ID_RE.test(id)))].slice(0, 100).sort() : [];
    if (!(await this.ownerOk('achreport', code, b.ts, b.sig, `|${ach.join(',')}`))) return fail(403, 'forbidden');
    const stats = this.env.ACHSTATS.get(this.env.ACHSTATS.idFromName('global'));
    await stats.fetch('https://stats/set', { method: 'POST', body: JSON.stringify({ code, ach }) });
    return json({ ok: true });
  }

  // „Ich nutze WhatsUp“: Name, Version, Plattform – für die Nutzerliste des Admins (einmal am Tag)
  async seen(code, b) {
    const name = textOf(b.name, 24);
    if (!name || !(await this.ownerOk('seen', code, b.ts, b.sig, `|${name}`))) return fail(403, 'forbidden');
    const stats = this.env.ACHSTATS.get(this.env.ACHSTATS.idFromName('global'));
    await stats.fetch('https://stats/seen', { method: 'POST', body: JSON.stringify({ code, name, ver: textOf(b.ver, 20), plat: b.plat === 'web' ? 'web' : 'windows',
      maxfire: Math.max(0, Math.min(100000, Math.floor(Number(b.maxFire) || 0))), lb: b.lb === false ? 0 : 1 }) });
    return json({ ok: true });
  }

  // Nachricht für diesen Briefkasten annehmen
  async receive(code, req) {
    const from = String(req.headers.get('X-From') || '').toUpperCase();
    const ts = Number(req.headers.get('X-Ts'));
    const sig = req.headers.get('X-Sig') || '';
    if (!CODE_RE.test(from) || !freshTs(ts)) return fail(400, 'bad request');
    if (!this.keys()) return fail(404, 'unknown recipient');
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > MAX_BODY) return fail(413, 'too large');

    // Absender prüfen: signiert mit dem Schlüssel, der beim Briefkasten des Absenders hinterlegt ist
    const text = `send|${from}|${code}|${ts}`;
    const senderBox = this.env.MAILBOX.get(this.env.MAILBOX.idFromName(from));
    const check = await (await senderBox.fetch(`https://box/v1/verify/${from}`, { method: 'POST', body: JSON.stringify({ text, sig }) })).json();
    if (!check.ok) return fail(403, 'bad signature');

    // Missbrauch begrenzen
    const minute = Math.floor(Date.now() / 60000);
    const cnt = this.sendCounts.get(from);
    const n = cnt && cnt.minute === minute ? cnt.n + 1 : 1;
    this.sendCounts.set(from, { minute, n });
    if (n > SEND_LIMIT_PER_MIN) return fail(429, 'slow down');

    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length || body.length > MAX_BODY) return fail(413, 'too large');
    const tot = this.sql.exec('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS s FROM msgs').toArray()[0];
    if (tot.n >= MAX_BOX_MSGS || tot.s + body.length > MAX_BOX_BYTES) return fail(507, 'mailbox full');

    const chunks = Math.ceil(body.length / CHUNK);
    const id = this.sql.exec('INSERT INTO msgs (sender, ts, size, chunks) VALUES (?, ?, ?, ?) RETURNING id', from, Date.now(), body.length, chunks).toArray()[0].id;
    for (let i = 0; i < chunks; i++) {
      this.sql.exec('INSERT INTO chunks (msg, idx, data) VALUES (?, ?, ?)', id, i, body.subarray(i * CHUNK, (i + 1) * CHUNK));
    }
    // Status-Updates u. Ä. ohne Push (der Absender markiert sie als still)
    if (req.headers.get('X-Silent') !== '1') this.state.waitUntil(this.notifyPush(from));
    return json({ ok: true, id });
  }

  // Liste der wartenden Nachrichten (nur für den Besitzer)
  async inbox(code, b) {
    if (!(await this.ownerOk('inbox', code, b.ts, b.sig))) return fail(403, 'forbidden');
    const items = this.sql.exec('SELECT id, sender, ts, size FROM msgs ORDER BY id LIMIT 200').toArray();
    return json({ items });
  }

  // Eine Nachricht herunterladen (nur für den Besitzer)
  async get(code, id, req) {
    const ts = Number(req.headers.get('X-Ts'));
    if (!Number.isInteger(id) || !(await this.ownerOk('get', code, ts, req.headers.get('X-Sig') || '', `|${id}`))) return fail(403, 'forbidden');
    const rows = this.sql.exec('SELECT data FROM chunks WHERE msg = ? ORDER BY idx', id).toArray();
    if (!rows.length) return fail(404, 'gone');
    const body = concat(...rows.map((r) => new Uint8Array(r.data)));
    return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', ...CORS } });
  }

  // Abgeholte Nachrichten löschen
  async ack(code, b) {
    const ids = Array.isArray(b.ids) ? b.ids.filter(Number.isInteger).slice(0, 500) : [];
    if (!(await this.ownerOk('ack', code, b.ts, b.sig, `|${ids.join(',')}`))) return fail(403, 'forbidden');
    for (const id of ids) {
      this.sql.exec('DELETE FROM chunks WHERE msg = ?', id);
      this.sql.exec('DELETE FROM msgs WHERE id = ?', id);
    }
    return json({ ok: true });
  }

  // Web-Push-Abo der Web-Version speichern/entfernen
  async pushSub(code, b) {
    const sub = b.sub;
    const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return fail(400, 'bad subscription');
    if (!(await this.ownerOk('push', code, b.ts, b.sig, `|${endpoint}`))) return fail(403, 'forbidden');
    if (b.remove) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', endpoint);
    else {
      if (!sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') return fail(400, 'bad subscription');
      this.sql.exec('INSERT OR REPLACE INTO subs (endpoint, sub, created) VALUES (?, ?, ?)', endpoint,
        JSON.stringify({ endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }), Date.now());
      // höchstens 5 Geräte pro Code
      this.sql.exec('DELETE FROM subs WHERE endpoint NOT IN (SELECT endpoint FROM subs ORDER BY created DESC LIMIT 5)');
    }
    return json({ ok: true });
  }

  // Test-Push an die eigenen Geräte, 5 Sekunden verzögert (Zeit zum Sperren des Handys)
  async pushTest(code, b) {
    if (!(await this.ownerOk('pushtest', code, b.ts, b.sig))) return fail(403, 'forbidden');
    const last = Number(this.getMeta('lastPushTest') || 0);
    if (Date.now() - last < 10000) return fail(429, 'too many requests');
    this.setMeta('lastPushTest', String(Date.now()));
    const n = this.sql.exec('SELECT COUNT(*) AS n FROM subs').toArray()[0].n;
    if (!n) return json({ ok: false, subs: 0 });
    this.state.waitUntil(new Promise((r) => setTimeout(r, 5000)).then(() => this.notifyPush(null, { test: true })));
    return json({ ok: true, subs: n });
  }

  async notifyPush(from, payload = { from }) {
    if (!this.env.VAPID_PUBLIC || !this.env.VAPID_PRIVATE) return;
    const subs = this.sql.exec('SELECT endpoint, sub FROM subs').toArray();
    for (const row of subs) {
      try {
        const status = await sendWebPush(JSON.parse(row.sub), JSON.stringify(payload), this.env);
        if (status === 404 || status === 410) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', row.endpoint);
      } catch { /* Push ist nur ein Bonus */ }
    }
  }

  // Täglich: alte Nachrichten löschen
  async alarm() {
    const old = this.sql.exec('SELECT id FROM msgs WHERE ts < ?', Date.now() - TTL_MS).toArray();
    for (const r of old) { this.sql.exec('DELETE FROM chunks WHERE msg = ?', r.id); this.sql.exec('DELETE FROM msgs WHERE id = ?', r.id); }
    await this.state.storage.setAlarm(Date.now() + 24 * 3600 * 1000);
  }
}

// ---------- Durable Object: weltweite Erfolgs-Statistik (eine einzige Instanz) ----------
// Speichert pro Code nur, welche Erfolge freigeschaltet sind, und zählt sie zusammen.
export class AchStats {
  constructor(state, env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS owned (code TEXT, ach TEXT, PRIMARY KEY (code, ach))');
    // Nutzerliste für den Admin: wer WhatsUp nutzt (gemeldet von der App, signiert)
    this.sql.exec('CREATE TABLE IF NOT EXISTS users (code TEXT PRIMARY KEY, name TEXT, ver TEXT, plat TEXT, first INTEGER, last INTEGER)');
    // Ranglisten: längster Streak, ob man in Ranglisten erscheinen will (lb = 1)
    for (const col of ['maxfire INTEGER DEFAULT 0', 'lb INTEGER DEFAULT 1']) { try { this.sql.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* gibt es schon */ } }
    this.cache = null; // { at, body }
    this.lbCache = {};
  }
  // Rangliste: die besten 50, dazu der eigene Platz und (optional) die Freunde
  async leaderboard(url) {
    const type = ['ach', 'fire', 'chall'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'ach';
    const me = CODE_RE.test(url.searchParams.get('me') || '') ? url.searchParams.get('me') : null;
    const friends = String(url.searchParams.get('friends') || '').toUpperCase().split(',').filter((c) => CODE_RE.test(c)).slice(0, 300);
    let all = this.lbCache[type];
    if (!all || Date.now() - all.at > 60000) {
      const users = this.sql.exec('SELECT code, name, maxfire, lb FROM users').toArray();
      let value;
      if (type === 'ach') {
        const n = {};
        for (const r of this.sql.exec('SELECT code, COUNT(*) AS n FROM owned GROUP BY code').toArray()) n[r.code] = r.n;
        value = (u) => n[u.code] || 0;
      } else if (type === 'fire') value = (u) => u.maxfire || 0;
      else {
        const res = await this.env.REELS.get(this.env.REELS.idFromName('global')).fetch('https://reels/v1/reels/challcounts');
        const c = (await res.json()).counts || {};
        value = (u) => (c[u.code] ? c[u.code].points : 0);
        all = { extra: c };
      }
      const list = users.map((u) => ({ code: u.code, name: u.name, value: value(u), lb: u.lb !== 0 }))
        .filter((u) => u.value > 0)
        .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
      let rank = 0, last = null;
      list.forEach((u, i) => { if (u.value !== last) { rank = i + 1; last = u.value; } u.rank = rank; });
      all = { at: Date.now(), list, extra: all && all.extra };
      this.lbCache[type] = all;
    }
    const pub = (u) => ({ rank: u.rank, code: u.code, name: u.name, value: u.value, ...(type === 'chall' && all.extra && all.extra[u.code] ? { done: all.extra[u.code].done } : {}) });
    const visible = all.list.filter((u) => u.lb || u.code === me);
    // Plätze nur unter den sichtbaren neu zählen (Ausgeblendete nehmen keinen Platz weg)
    let rank = 0, last = null;
    const ranked = visible.map((u, i) => { if (u.value !== last) { rank = i + 1; last = u.value; } return { ...u, rank }; });
    const meRow = me ? ranked.find((u) => u.code === me) : null;
    return json({
      type, total: ranked.length,
      top: ranked.slice(0, 50).map(pub),
      me: meRow ? pub(meRow) : null,
      friends: friends.length ? ranked.filter((u) => friends.includes(u.code) || u.code === me).map(pub) : [],
    });
  }

  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/set') {
      const { code, ach } = await req.json();
      if (!CODE_RE.test(code) || !Array.isArray(ach)) return fail(400, 'bad request');
      this.sql.exec('DELETE FROM owned WHERE code = ?', code);
      for (const id of ach) if (ACH_ID_RE.test(id)) this.sql.exec('INSERT OR IGNORE INTO owned (code, ach) VALUES (?, ?)', code, id);
      this.cache = null;
      return json({ ok: true });
    }
    if (path === '/leaderboard') return this.leaderboard(new URL(req.url));
    if (path === '/seen') { // nur intern vom Briefkasten (Signatur dort geprüft)
      const b = await req.json();
      const { code, name, ver, plat } = b;
      if (!CODE_RE.test(code)) return fail(400, 'bad code');
      const now = Date.now();
      const { maxfire = 0, lb = 1 } = b;
      this.sql.exec(`INSERT INTO users (code, name, ver, plat, first, last, maxfire, lb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET name = excluded.name, ver = excluded.ver, plat = excluded.plat, last = excluded.last,
          maxfire = MAX(COALESCE(users.maxfire, 0), excluded.maxfire), lb = excluded.lb`, code, name, ver, plat, now, now, maxfire, lb ? 1 : 0);
      this.lbCache = {};
      return json({ ok: true });
    }
    if (path === '/users') { // nur intern, Admin-Prüfung im Worker
      const users = this.sql.exec('SELECT code, name, ver, plat, first, last FROM users ORDER BY last DESC LIMIT 5000').toArray();
      const day = Date.now() - 86400000, week = Date.now() - 7 * 86400000;
      return json({
        count: users.length,
        active24h: users.filter((u) => u.last >= day).length,
        active7d: users.filter((u) => u.last >= week).length,
        withAchievements: this.sql.exec('SELECT COUNT(DISTINCT code) AS n FROM owned').toArray()[0].n,
        users,
      });
    }
    if (path.startsWith('/user/')) {
      const c = path.slice(6);
      if (!CODE_RE.test(c)) return fail(400, 'bad code');
      const ach = this.sql.exec('SELECT ach FROM owned WHERE code = ? ORDER BY ach', c).toArray().map((r) => r.ach);
      return new Response(JSON.stringify({ ach }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...CORS } });
    }
    if (path === '/counts') {
      if (!this.cache || Date.now() - this.cache.at > 60000) {
        const counts = {};
        for (const r of this.sql.exec('SELECT ach, COUNT(*) AS n FROM owned GROUP BY ach').toArray()) counts[r.ach] = r.n;
        const players = this.sql.exec('SELECT COUNT(DISTINCT code) AS n FROM owned').toArray()[0].n;
        this.cache = { at: Date.now(), body: JSON.stringify({ counts, players }) };
      }
      return new Response(this.cache.body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60', ...CORS } });
    }
    return fail(404, 'not found');
  }
}

// ---------- UpReels: öffentliche Kurzvideos für alle WhatsUp-Nutzer ----------
// Jede schreibende Anfrage ist mit dem Schlüssel signiert, der beim Briefkasten des Codes hinterlegt ist.
const REEL_ID_RE = /^[a-z0-9]{16,40}$/;
const MUSIC_ID_RE = /^[a-z0-9-]{1,60}$/;   // Track-ID aus web/music/tracks.json
const REEL_MAX_PHOTOS = 20;
// Wochen-Challenges: Musik-IDs für „Poste ein Reel mit diesem Sound“ (aus web/music/tracks.json)
const CHALL_TRACKS = ["monkeys-spinning-monkeys","carefree","wallpaper","happy-alley","jaunty-gumption","upbeat-forever","off-to-osaka","sneaky-snitch","fluffing-a-duck","investigations","pixel-peeker-polka-faster","run-amok","spazzmatica-polka","merry-go","breaktime","lobby-time","easy-lemon","cool-vibes","dreamer","chill-wave","bossa-antigua","dream-culture","funkorama","funky-chunk","werq","hep-cats","local-forecast-elevator","kool-kats","rollin-at-5","itty-bitty-8-bit","bit-shift","electrodoodle","digital-lemonade","hyperfun","blip-stream","five-armies","heroic-age","volatile-reaction","hitman","movement-proposition","cut-and-run","achilles","spy-glass","covert-affair","crusade","desert-city"];
// Weitere Challenge-Arten (eine Woche hat: 1 Sound-Challenge + 2 davon)
const CHALL_POOL = [
  { type: 'reel_post', goal: 2, points: 20 },
  { type: 'reel_likes', goal: 5, points: 25 },
  { type: 'comments', goal: 5, points: 15 },
  { type: 'messages', goal: 50, points: 15 },
  { type: 'messages', goal: 150, points: 25 },
  { type: 'fire', goal: 3, points: 20 },
  { type: 'fire', goal: 7, points: 30 },
];
const CHALL_TYPES = ['reel_sound', 'reel_post', 'reel_likes', 'comments', 'messages', 'fire'];
// Woche beginnt Montag 00:00 UTC
const weekStart = (t = Date.now()) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day); };
const weekId = (t) => new Date(weekStart(t)).toISOString().slice(0, 10);
// Zufall mit festem Startwert: jede Woche dieselbe Auswahl für alle
const seeded = (str) => { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16; return (h >>> 0) / 4294967296; }; };
function autoChallenges(week, salt = '') {
  const rnd = seeded(week + salt);
  const music = CHALL_TRACKS[Math.floor(rnd() * CHALL_TRACKS.length)];
  const pool = CHALL_POOL.slice();
  const picks = [];
  while (picks.length < 2 && pool.length) {
    const p = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    if (!picks.some((x) => x.type === p.type)) picks.push(p);
  }
  return [{ id: 'c1', type: 'reel_sound', goal: 1, points: 30, music }, ...picks.map((p, i) => ({ id: 'c' + (i + 2), ...p }))];
}                // Foto-Beitrag: höchstens 20 Bilder
const REEL_MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const REEL_MAX_BYTES = 26 * 1024 * 1024;     // ein Video (App begrenzt auf 60 s, ~10 MB)
const REELS_TOTAL_MAX = 4.5 * 1024 ** 3;     // Speichergrenze der kostenlosen Stufe (5 GB) nicht reißen
const REEL_UPLOADS_PER_DAY = 15;
const REEL_COMMENTS_PER_MIN = 10;
const REEL_HIDE_AFTER_REPORTS = 3;
const textOf = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n);
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// Hat der Besitzer dieses Codes den Text signiert? (fragt den Briefkasten des Codes)
async function codeSigned(env, code, text, sig) {
  if (!CODE_RE.test(code) || typeof sig !== 'string') return false;
  const box = env.MAILBOX.get(env.MAILBOX.idFromName(code));
  const r = await (await box.fetch(`https://box/v1/verify/${code}`, { method: 'POST', body: JSON.stringify({ text, sig }) })).json().catch(() => ({}));
  return !!r.ok;
}
const admins = (env) => clean(env.ADMIN_CODES).toUpperCase().split(/[\s,]+/).filter((c) => CODE_RE.test(c));

// Zentraler Index: Feed, Likes, Kommentare, Aufrufe, Meldungen
export class Reels {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reels (id TEXT PRIMARY KEY, author TEXT, name TEXT, caption TEXT, ts INTEGER, dur REAL, w INTEGER, h INTEGER,
        poster TEXT, size INTEGER, likes INTEGER DEFAULT 0, views INTEGER DEFAULT 0, comments INTEGER DEFAULT 0, reports INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS reels_ts ON reels (ts);
      CREATE INDEX IF NOT EXISTS reels_author ON reels (author, ts);
      CREATE TABLE IF NOT EXISTS likes (reel TEXT, code TEXT, PRIMARY KEY (reel, code));
      CREATE TABLE IF NOT EXISTS views (reel TEXT, code TEXT, name TEXT, ts INTEGER, PRIMARY KEY (reel, code));
      CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT, reel TEXT, code TEXT, name TEXT, text TEXT, ts INTEGER);
      CREATE INDEX IF NOT EXISTS comments_reel ON comments (reel, id);
      CREATE TABLE IF NOT EXISTS reports (reel TEXT, code TEXT, reason TEXT, ts INTEGER, PRIMARY KEY (reel, code));
      CREATE TABLE IF NOT EXISTS challenges (week TEXT PRIMARY KEY, list TEXT, custom INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS chall_done (week TEXT, cid TEXT, code TEXT, points INTEGER, ts INTEGER, PRIMARY KEY (week, cid, code));
      CREATE TABLE IF NOT EXISTS chall_progress (week TEXT, code TEXT, sent INTEGER, fire INTEGER, PRIMARY KEY (week, code));`);
    // Musik (aus der festen Auswahl in der App): welcher Track, ab welcher Sekunde
    // kind: 'video' oder 'photos' (Foto-Beitrag zum Wischen); photos = Anzahl; music_vol = Lautstärke der Musik (0..1)
    for (const col of ['music_id TEXT', 'music_start REAL', "kind TEXT DEFAULT 'video'", 'photos INTEGER DEFAULT 0', 'music_vol REAL']) { try { this.sql.exec(`ALTER TABLE reels ADD COLUMN ${col}`); } catch { /* gibt es schon */ } }
    this.sql.exec('CREATE INDEX IF NOT EXISTS reels_music ON reels (music_id, ts)');
    this.rate = new Map();
  }

  limited(key, max, ms) {
    const now = Date.now();
    const r = this.rate.get(key);
    if (!r || now - r.t > ms) { this.rate.set(key, { t: now, n: 1 }); return false; }
    r.n++;
    return r.n > max;
  }
  one(q, ...a) { const r = this.sql.exec(q, ...a).toArray(); return r[0] || null; }
  pub(r, me) {
    return {
      id: r.id, author: r.author, name: r.name, caption: r.caption, ts: r.ts, dur: r.dur, w: r.w, h: r.h, poster: r.poster,
      likes: r.likes, views: r.views, comments: r.comments,
      music: r.music_id ? { id: r.music_id, start: r.music_start || 0, vol: r.music_vol == null ? 1 : r.music_vol } : null,
      kind: r.kind || 'video', photos: r.photos || 0,
      liked: me ? !!this.one('SELECT 1 AS x FROM likes WHERE reel = ? AND code = ?', r.id, me) : false,
    };
  }
  // Challenges dieser Woche (automatisch, außer der Admin hat sie geändert)
  weekChallenges(week) {
    const r = this.one('SELECT list, custom FROM challenges WHERE week = ?', week);
    if (r) return { list: JSON.parse(r.list), custom: !!r.custom };
    const list = autoChallenges(week);
    this.sql.exec('INSERT OR IGNORE INTO challenges (week, list, custom) VALUES (?, ?, 0)', week, JSON.stringify(list));
    return { list, custom: false };
  }
  // Fortschritt eines Nutzers für eine Challenge (vom Server geprüft, Nachrichten/Streak von der App gemeldet)
  progress(c, code, week) {
    const ws = Date.parse(week + 'T00:00:00Z');
    if (c.type === 'reel_sound') return this.one('SELECT COUNT(*) AS n FROM reels WHERE author = ? AND ts >= ? AND music_id = ?', code, ws, c.music).n;
    if (c.type === 'reel_post') return this.one('SELECT COUNT(*) AS n FROM reels WHERE author = ? AND ts >= ?', code, ws).n;
    if (c.type === 'reel_likes') return this.one('SELECT COALESCE(SUM(likes), 0) AS n FROM reels WHERE author = ? AND ts >= ?', code, ws).n;
    if (c.type === 'comments') return this.one('SELECT COUNT(*) AS n FROM comments WHERE code = ? AND ts >= ?', code, ws).n;
    const p = this.one('SELECT sent, fire FROM chall_progress WHERE week = ? AND code = ?', week, code);
    if (c.type === 'messages') return p ? p.sent : 0;
    if (c.type === 'fire') return p ? p.fire : 0;
    return 0;
  }
  challengesFor(code) {
    const week = weekId();
    const { list, custom } = this.weekChallenges(week);
    const out = list.map((c) => {
      const prog = code ? this.progress(c, code, week) : 0;
      const done = !!code && prog >= c.goal;
      if (done) this.sql.exec('INSERT OR IGNORE INTO chall_done (week, cid, code, points, ts) VALUES (?, ?, ?, ?, ?)', week, c.id, code, c.points, Date.now());
      const n = this.one('SELECT COUNT(*) AS n FROM chall_done WHERE week = ? AND cid = ?', week, c.id).n;
      return { ...c, progress: Math.min(prog, c.goal), done, finishers: n };
    });
    const tot = code ? this.one('SELECT COUNT(*) AS done, COALESCE(SUM(points), 0) AS points FROM chall_done WHERE code = ?', code) : { done: 0, points: 0 };
    return { week, ends: weekStart() + 7 * 86400000, custom, list: out, total: tot };
  }
  // Ältere Apps (ohne ?v=2) kennen keine Foto-Beiträge – denen nur Videos zeigen
  kindSql(url) { return Number(url.searchParams.get('v')) >= 2 ? '' : " AND COALESCE(kind, 'video') = 'video'"; }
  // Signierte Aktion prüfen: text = "<aktion>|<code>|<ts>|<extra>"
  async signed(b, action, extra = '') {
    const code = String(b.code || '').toUpperCase();
    if (!freshTs(Number(b.ts))) return null;
    return (await codeSigned(this.env, code, `${action}|${code}|${b.ts}${extra}`, b.sig)) ? code : null;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split('/').filter(Boolean); // v1 / reels / <aktion> [/ id]
    const action = parts[2], arg = parts[3];
    try {
      if (req.method === 'GET') {
        const me = CODE_RE.test(url.searchParams.get('me') || '') ? url.searchParams.get('me') : null;
        if (action === 'feed') {
          const before = Number(url.searchParams.get('before')) || Date.now() + 60000;
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 8));
          // Was man selbst gemeldet hat, bekommt man nicht mehr angezeigt
          const rows = this.sql.exec(`SELECT * FROM reels WHERE hidden = 0 AND ts < ? AND id NOT IN (SELECT reel FROM reports WHERE code = ?)${this.kindSql(url)} ORDER BY ts DESC LIMIT ?`, before, me || '', limit).toArray();
          return json({ reels: rows.map((r) => this.pub(r, me)), admin: !!me && admins(this.env).includes(me) });
        }
        if (action === 'user' && CODE_RE.test(arg || '')) {
          const rows = this.sql.exec(`SELECT * FROM reels WHERE author = ? AND hidden = 0${this.kindSql(url)} ORDER BY ts DESC LIMIT 100`, arg).toArray();
          return json({ reels: rows.map((r) => this.pub(r, me)) });
        }
        if (action === 'sound' && MUSIC_ID_RE.test(arg || '')) { // alle Reels mit diesem Sound
          const rows = this.sql.exec(`SELECT * FROM reels WHERE music_id = ? AND hidden = 0${this.kindSql(url)} ORDER BY ts DESC LIMIT 60`, arg).toArray();
          const n = this.one(`SELECT COUNT(*) AS n FROM reels WHERE music_id = ? AND hidden = 0${this.kindSql(url)}`, arg).n;
          return json({ reels: rows.map((r) => this.pub(r, me)), count: n });
        }
        if (action === 'one' && REEL_ID_RE.test(arg || '')) {
          const r = this.one('SELECT * FROM reels WHERE id = ? AND hidden = 0', arg);
          return r ? json({ reel: this.pub(r, me) }) : fail(404, 'gone');
        }
        if (action === 'challenges') return json(this.challengesFor(me));
        if (action === 'challstats' && CODE_RE.test(arg || '')) { // Abzeichen im Profil
          const t = this.one('SELECT COUNT(*) AS done, COALESCE(SUM(points), 0) AS points FROM chall_done WHERE code = ?', arg);
          return json(t);
        }
        if (action === 'challcounts') { // intern für die Rangliste
          const counts = {};
          for (const r of this.sql.exec('SELECT code, COUNT(*) AS done, SUM(points) AS points FROM chall_done GROUP BY code').toArray()) counts[r.code] = { done: r.done, points: r.points };
          return json({ counts });
        }
        if (action === 'comments' && REEL_ID_RE.test(arg || '')) {
          const rows = this.sql.exec('SELECT id, code, name, text, ts FROM comments WHERE reel = ? ORDER BY id LIMIT 300', arg).toArray();
          return json({ comments: rows });
        }
        return fail(404, 'not found');
      }
      if (req.method !== 'POST') return fail(405, 'method');
      if (action === 'upload') return this.upload(req);
      const b = await req.json();
      // Fortschritt von der App: gesendete Nachrichten diese Woche, aktueller längster Streak
      if (action === 'progress') {
        const week = weekId();
        const sent = Math.max(0, Math.min(100000, Math.floor(Number(b.sent) || 0)));
        const fire = Math.max(0, Math.min(10000, Math.floor(Number(b.fire) || 0)));
        const code = await this.signed(b, 'challprogress', `|${week}|${sent}|${fire}`);
        if (!code) return fail(403, 'forbidden');
        this.sql.exec(`INSERT INTO chall_progress (week, code, sent, fire) VALUES (?, ?, ?, ?)
          ON CONFLICT(week, code) DO UPDATE SET sent = MAX(sent, excluded.sent), fire = MAX(fire, excluded.fire)`, week, code, sent, fire);
        return json(this.challengesFor(code));
      }
      // Admin: Challenges dieser Woche ändern (neu würfeln, Sound festlegen, zurück auf automatisch)
      if (action === 'challadmin') {
        const op = String(b.op || '');
        const music = String(b.music || '');
        const code = await this.signed(b, 'challadmin', `|${op}|${music}`);
        if (!code || !admins(this.env).includes(code)) return fail(403, 'forbidden');
        const week = weekId();
        let list = this.weekChallenges(week).list;
        if (op === 'auto') { this.sql.exec('DELETE FROM challenges WHERE week = ?', week); return json(this.challengesFor(code)); }
        if (op === 'reroll') list = autoChallenges(week, String(Date.now()));
        else if (op === 'sound' && MUSIC_ID_RE.test(music)) list = list.map((c) => (c.type === 'reel_sound' ? { ...c, music } : c));
        else return fail(400, 'bad op');
        this.sql.exec('INSERT OR REPLACE INTO challenges (week, list, custom) VALUES (?, ?, 1)', week, JSON.stringify(list));
        return json(this.challengesFor(code));
      }
      const id = String(b.id || '');
      if (!REEL_ID_RE.test(id)) return fail(400, 'bad id');
      const reel = this.one('SELECT * FROM reels WHERE id = ?', id);
      if (!reel) return fail(404, 'gone');

      if (action === 'like') {
        const on = b.on ? 1 : 0;
        const code = await this.signed(b, 'reellike', `|${id}|${on}`);
        if (!code) return fail(403, 'forbidden');
        if (on) this.sql.exec('INSERT OR IGNORE INTO likes (reel, code) VALUES (?, ?)', id, code);
        else this.sql.exec('DELETE FROM likes WHERE reel = ? AND code = ?', id, code);
        const n = this.one('SELECT COUNT(*) AS n FROM likes WHERE reel = ?', id).n;
        this.sql.exec('UPDATE reels SET likes = ? WHERE id = ?', n, id);
        return json({ ok: true, likes: n, liked: !!on });
      }
      if (action === 'view') {
        const code = await this.signed(b, 'reelview', `|${id}`);
        if (!code) return fail(403, 'forbidden');
        if (code !== reel.author) {
          this.sql.exec('INSERT OR IGNORE INTO views (reel, code, name, ts) VALUES (?, ?, ?, ?)', id, code, textOf(b.name, 24) || code, Date.now());
          const n = this.one('SELECT COUNT(*) AS n FROM views WHERE reel = ?', id).n;
          this.sql.exec('UPDATE reels SET views = ? WHERE id = ?', n, id);
        }
        return json({ ok: true });
      }
      if (action === 'viewers') { // nur für den Ersteller
        const code = await this.signed(b, 'reelviewers', `|${id}`);
        if (!code || (code !== reel.author && !admins(this.env).includes(code))) return fail(403, 'forbidden');
        return json({ viewers: this.sql.exec('SELECT code, name, ts FROM views WHERE reel = ? ORDER BY ts DESC LIMIT 500', id).toArray() });
      }
      if (action === 'comment') {
        const text = textOf(b.text, 300);
        const code = await this.signed(b, 'reelcomment', `|${id}|${text}`);
        if (!code) return fail(403, 'forbidden');
        if (!text) return fail(400, 'empty');
        if (this.limited('c' + code, REEL_COMMENTS_PER_MIN, 60000)) return fail(429, 'slow down');
        const cid = this.one('INSERT INTO comments (reel, code, name, text, ts) VALUES (?, ?, ?, ?, ?) RETURNING id', id, code, textOf(b.name, 24) || code, text, Date.now()).id;
        this.sql.exec('UPDATE reels SET comments = comments + 1 WHERE id = ?', id);
        return json({ ok: true, id: cid });
      }
      if (action === 'uncomment') {
        const cid = Number(b.cid);
        const code = await this.signed(b, 'reeluncomment', `|${id}|${cid}`);
        const c = this.one('SELECT code FROM comments WHERE id = ? AND reel = ?', cid, id);
        if (!code || !c || (c.code !== code && reel.author !== code && !admins(this.env).includes(code))) return fail(403, 'forbidden');
        this.sql.exec('DELETE FROM comments WHERE id = ?', cid);
        this.sql.exec('UPDATE reels SET comments = MAX(0, comments - 1) WHERE id = ?', id);
        return json({ ok: true });
      }
      if (action === 'report') {
        const reason = textOf(b.reason, 100);
        const code = await this.signed(b, 'reelreport', `|${id}`);
        if (!code) return fail(403, 'forbidden');
        this.sql.exec('INSERT OR IGNORE INTO reports (reel, code, reason, ts) VALUES (?, ?, ?, ?)', id, code, reason, Date.now());
        const n = this.one('SELECT COUNT(*) AS n FROM reports WHERE reel = ?', id).n;
        this.sql.exec('UPDATE reels SET reports = ?, hidden = ? WHERE id = ?', n, n >= REEL_HIDE_AFTER_REPORTS ? 1 : reel.hidden, id);
        return json({ ok: true });
      }
      if (action === 'delete') { // Ersteller oder Admin
        const code = await this.signed(b, 'reeldelete', `|${id}`);
        if (!code || (code !== reel.author && !admins(this.env).includes(code))) return fail(403, 'forbidden');
        if (reel.kind === 'photos') {
          for (let i = 0; i < (reel.photos || 0); i++) await this.env.REELBLOB.get(this.env.REELBLOB.idFromName(`${id}-p${i}`)).fetch(`https://blob/v1/reels/drop/${id}`, { method: 'POST' });
        } else await this.env.REELBLOB.get(this.env.REELBLOB.idFromName(id)).fetch(`https://blob/v1/reels/drop/${id}`, { method: 'POST' });
        for (const t of ['likes', 'views', 'comments', 'reports']) this.sql.exec(`DELETE FROM ${t} WHERE reel = ?`, id);
        this.sql.exec('DELETE FROM reels WHERE id = ?', id);
        return json({ ok: true });
      }
      return fail(404, 'not found');
    } catch (e) {
      return fail(500, String(e && e.message || e).slice(0, 200));
    }
  }

  // Hochladen. Body: [4 Byte Länge der Metadaten][Metadaten-JSON][Video]
  // Signatur: "reelup|<code>|<ts>|<sha256 des ganzen Bodys>"
  async upload(req) {
    const code = String(req.headers.get('X-From') || '').toUpperCase();
    const ts = Number(req.headers.get('X-Ts'));
    if (!CODE_RE.test(code) || !freshTs(ts)) return fail(400, 'bad request');
    const len = Number(req.headers.get('Content-Length') || 0);
    if (len > REEL_MAX_BYTES + 400 * 1024) return fail(413, 'too large');
    const body = new Uint8Array(await req.arrayBuffer());
    if (body.length < 8 || body.length > REEL_MAX_BYTES + 400 * 1024) return fail(413, 'too large');
    const digest = hex(await crypto.subtle.digest('SHA-256', body));
    if (!(await codeSigned(this.env, code, `reelup|${code}|${ts}|${digest}`, req.headers.get('X-Sig') || ''))) return fail(403, 'bad signature');

    const day = Math.floor(Date.now() / 86400000);
    const today = this.one('SELECT COUNT(*) AS n FROM reels WHERE author = ? AND ts >= ?', code, day * 86400000).n;
    if (today >= REEL_UPLOADS_PER_DAY) return fail(429, 'Du hast heute schon genug UpReels gepostet. Morgen wieder!');
    const total = this.one('SELECT COALESCE(SUM(size), 0) AS s FROM reels').s;

    const mlen = new DataView(body.buffer, body.byteOffset, 4).getUint32(0);
    if (mlen > 300 * 1024 || 4 + mlen >= body.length) return fail(400, 'bad meta');
    let meta;
    try { meta = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + mlen))); } catch { return fail(400, 'bad meta'); }
    const data = body.subarray(4 + mlen);
    if (data.length > REEL_MAX_BYTES) return fail(413, 'too large');
    if (total + data.length > REELS_TOTAL_MAX) return fail(507, 'Der UpReels-Speicher ist gerade voll.');
    const poster = typeof meta.poster === 'string' && meta.poster.length <= 200 * 1024 && /^data:image\/(jpeg|webp|png);base64,/.test(meta.poster) ? meta.poster : null;
    const dim = (v) => { const n = Math.round(Number(v)); return n > 0 && n < 10000 ? n : 720; };
    const dur = Math.max(0, Math.min(120, Number(meta.dur) || 0));
    const music = meta.music && MUSIC_ID_RE.test(String(meta.music.id || '')) ? { id: meta.music.id, start: Math.max(0, Math.min(600, Number(meta.music.start) || 0)) } : null;
    const musicVol = music ? Math.max(0, Math.min(1, Number(meta.musicVol ?? 1) || 0)) : null;

    const id = hex(crypto.getRandomValues(new Uint8Array(12)));
    let kind = 'video', photos = 0;
    if (meta.kind === 'photos') {
      // Foto-Beitrag: mehrere Bilder hintereinander, Größen stehen in meta.sizes
      const sizes = Array.isArray(meta.sizes) ? meta.sizes.map(Number) : [];
      const types = Array.isArray(meta.types) ? meta.types : [];
      if (!sizes.length || sizes.length > REEL_MAX_PHOTOS || sizes.some((n) => !Number.isInteger(n) || n <= 0 || n > REEL_MAX_PHOTO_BYTES)
        || sizes.reduce((a, n) => a + n, 0) !== data.length) return fail(400, 'bad photos');
      let o = 0;
      for (let i = 0; i < sizes.length; i++) {
        const t = /^image\/(jpeg|webp|png)$/.test(types[i]) ? types[i] : 'image/jpeg';
        const put = await this.env.REELBLOB.get(this.env.REELBLOB.idFromName(`${id}-p${i}`))
          .fetch(`https://blob/v1/reels/put/${id}`, { method: 'POST', headers: { 'X-Type': t }, body: data.subarray(o, o + sizes[i]) });
        if (!put.ok) return fail(500, 'store failed');
        o += sizes[i];
      }
      kind = 'photos'; photos = sizes.length;
    } else {
      const type = /^video\/(mp4|webm|quicktime)$/.test(meta.type) ? meta.type : 'video/mp4';
      const put = await this.env.REELBLOB.get(this.env.REELBLOB.idFromName(id)).fetch(`https://blob/v1/reels/put/${id}`, { method: 'POST', headers: { 'X-Type': type }, body: data });
      if (!put.ok) return fail(500, 'store failed');
    }
    this.sql.exec('INSERT INTO reels (id, author, name, caption, ts, dur, w, h, poster, size, music_id, music_start, kind, photos, music_vol) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, code, textOf(meta.name, 24) || code, textOf(meta.caption, 150), Date.now(), dur, dim(meta.w), dim(meta.h), poster, data.length,
      music ? music.id : null, music ? music.start : null, kind, photos, musicVol);
    return json({ ok: true, reel: this.pub(this.one('SELECT * FROM reels WHERE id = ?', id), code) });
  }
}

// Speicher für EIN Video, in 1-MB-Stücken. Liefert Teilbereiche (Range), die Safari/iPhone zum Abspielen braucht.
export class ReelBlob {
  constructor(state) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS chunks (idx INTEGER PRIMARY KEY, data BLOB);`);
  }
  getMeta(k) { const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray(); return r.length ? r[0].v : null; }

  async fetch(req) {
    const url = new URL(req.url);
    const action = url.pathname.split('/').filter(Boolean)[2];
    if (action === 'put' && req.method === 'POST') { // nur intern vom Index
      const body = new Uint8Array(await req.arrayBuffer());
      this.sql.exec('DELETE FROM chunks');
      for (let i = 0; i * CHUNK < body.length; i++) this.sql.exec('INSERT INTO chunks (idx, data) VALUES (?, ?)', i, body.subarray(i * CHUNK, (i + 1) * CHUNK));
      this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?), (?, ?)', 'size', String(body.length), 'type', req.headers.get('X-Type') || 'video/mp4');
      return json({ ok: true });
    }
    if (action === 'drop' && req.method === 'POST') { // nur intern vom Index
      this.sql.exec('DELETE FROM chunks');
      this.sql.exec('DELETE FROM meta');
      return json({ ok: true });
    }
    if (action !== 'video' && action !== 'photo') return fail(404, 'not found');
    const size = Number(this.getMeta('size') || 0);
    if (!size) return fail(404, 'gone');
    const type = this.getMeta('type') || 'video/mp4';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', ...CORS };
    let start = 0, end = size - 1, partial = false;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || '');
    if (m && (m[1] || m[2])) {
      partial = true;
      if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(size - 1, Number(m[2])); }
      else { start = Math.max(0, size - Number(m[2])); }
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, ...CORS } });
    }
    const len = end - start + 1;
    if (req.method === 'HEAD') return new Response(null, { status: partial ? 206 : 200, headers: { ...headers, 'Content-Length': String(len), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) } });
    const rows = this.sql.exec('SELECT idx, data FROM chunks WHERE idx BETWEEN ? AND ? ORDER BY idx', Math.floor(start / CHUNK), Math.floor(end / CHUNK)).toArray();
    const out = new Uint8Array(len);
    let o = 0;
    for (const r of rows) {
      const d = new Uint8Array(r.data), base = r.idx * CHUNK;
      const a = Math.max(start, base) - base, z = Math.min(end + 1, base + d.length) - base;
      if (z > a) { out.set(d.subarray(a, z), o); o += z - a; }
    }
    return new Response(out, { status: partial ? 206 : 200, headers: { ...headers, 'Content-Length': String(len), ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) } });
  }
}

// ---------- Web-Push (RFC 8291 aes128gcm + VAPID RFC 8292) ----------
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function vapidAuth(endpoint, env) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(clean(env.VAPID_PRIVATE)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${clean(env.VAPID_PUBLIC)}`;
}

async function sendWebPush(sub, payload, env) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // Datensatzgröße 4096
  const body = concat(salt, rs, new Uint8Array([65]), asPublic, ct);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, env),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body,
  });
  return res.status;
}
