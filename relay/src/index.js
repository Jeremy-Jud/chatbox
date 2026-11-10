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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-From, X-Ts, X-Sig',
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

  // Interner Aufruf eines anderen Briefkastens: „Hat der Besitzer dieses Codes das signiert?“
  async verifyFromOwner(code, b) {
    const keys = this.keys();
    if (!keys) return json({ ok: false });
    return json({ ok: await verify(keys.sign, b.sig, String(b.text || '')) });
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
    this.state.waitUntil(this.notifyPush(from));
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
