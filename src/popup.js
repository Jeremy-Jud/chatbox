// Eigenes Benachrichtigungsfenster: Enter sendet die Antwort, Shift+Enter macht eine neue Zeile.
(() => {
  const list = document.getElementById('list');
  const items = new Map(); // Schlüssel: Chat (oder id) -> { el, timer, id, chatId }
  const SHOW_MS = 7000;
  const MAX = 3;

  // Höhe ans Hauptprogramm melden (0 = nichts mehr zu zeigen)
  const report = () => window.popup.setHeight(items.size ? Math.ceil(list.getBoundingClientRect().height) : 0);
  new ResizeObserver(report).observe(list);

  function remove(key) {
    const it = items.get(key);
    if (!it || it.closing) return;
    it.closing = true;
    clearTimeout(it.timer);
    it.el.classList.add('out');
    setTimeout(() => { it.el.remove(); items.delete(key); report(); }, 160);
  }
  // Ausblenden pausieren, solange man drüber ist oder tippt
  function busy(it) {
    return it.hover || (it.ta && (document.activeElement === it.ta || it.ta.value.trim()));
  }
  function arm(key, ms = SHOW_MS) {
    const it = items.get(key);
    if (!it) return;
    clearTimeout(it.timer);
    it.timer = setTimeout(() => { if (busy(it)) arm(key, 2500); else remove(key); }, ms);
  }

  // Leiser Hinweiston (statt Windows-Ton)
  let ctx = null;
  function ding() {
    try {
      ctx = ctx || new AudioContext();
      const t = ctx.currentTime;
      [[880, 0], [1320, 0.09]].forEach(([f, d]) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t + d);
        g.gain.exponentialRampToValueAtTime(0.12, t + d + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.22);
        o.connect(g).connect(ctx.destination);
        o.start(t + d); o.stop(t + d + 0.25);
      });
    } catch {}
  }

  const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  function build(n, key) {
    const el = document.createElement('div');
    el.className = 'card';
    const av = document.createElement('img');
    av.className = 'av'; av.alt = '';
    const main = document.createElement('div'); main.className = 'main';
    const top = document.createElement('div'); top.className = 'top';
    const title = document.createElement('span'); title.className = 'title';
    const app = document.createElement('span'); app.className = 'app'; app.textContent = 'WhatsUp';
    top.append(title, app);
    const body = document.createElement('div'); body.className = 'body';
    main.append(top, body);
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Schließen';
    el.append(av, main, x);

    const it = { el, av, title, body, id: n.id, chatId: n.chatId, ta: null };
    x.onclick = (e) => { e.stopPropagation(); remove(key); };
    el.onmouseenter = () => { it.hover = true; };
    el.onmouseleave = () => { it.hover = false; };
    el.onclick = (e) => {
      if (e.target.closest('.reply')) return;
      if (n.chatId) window.popup.open(n.chatId);
      remove(key);
    };

    if (n.chatId) {
      const box = document.createElement('div'); box.className = 'reply';
      const ta = document.createElement('textarea');
      ta.rows = 1; ta.placeholder = n.placeholder || 'Antworten…'; ta.maxLength = 4000;
      const send = document.createElement('button'); send.className = 'send'; send.title = 'Senden (Enter)'; send.innerHTML = SEND_SVG;
      box.append(ta, send);
      const hint = document.createElement('div'); hint.className = 'hint'; hint.textContent = 'Enter senden · Shift+Enter neue Zeile';
      hint.hidden = true;
      el.append(box, hint);
      it.ta = ta;
      const grow = () => { ta.style.height = '26px'; ta.style.height = Math.min(ta.scrollHeight, 104) + 'px'; send.classList.toggle('on', !!ta.value.trim()); };
      const submit = () => {
        const text = ta.value.trim();
        if (!text) return;
        window.popup.reply(it.id, it.chatId, text);
        box.remove(); hint.remove();
        const s = document.createElement('div'); s.className = 'sent'; s.textContent = 'Gesendet ✓';
        el.append(s);
        it.ta = null;
        arm(key, 1200);
      };
      ta.addEventListener('input', grow);
      ta.addEventListener('focus', () => { hint.hidden = false; window.popup.focus(); });
      ta.addEventListener('blur', () => { hint.hidden = true; });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
        else if (e.key === 'Escape') { e.preventDefault(); remove(key); }
      });
      send.onclick = (e) => { e.stopPropagation(); submit(); };
      box.onclick = (e) => { e.stopPropagation(); ta.focus(); };
    }
    return it;
  }

  window.popup.onShow((n) => {
    if (!n || typeof n !== 'object') return;
    if (n.theme === 'light' || n.theme === 'dark') document.documentElement.setAttribute('data-theme', n.theme);
    else document.documentElement.removeAttribute('data-theme');
    const key = n.chatId || n.id;
    let it = items.get(key);
    if (it && it.closing) { it.el.remove(); items.delete(key); it = null; }
    if (!it) {
      it = build(n, key);
      items.set(key, it);
      list.prepend(it.el);
      // höchstens 3 gleichzeitig
      [...items.keys()].slice(0, Math.max(0, items.size - MAX)).forEach(remove);
    } else {
      it.id = n.id; // neue Nachricht im selben Chat: Inhalt ersetzen, Antwortfeld bleibt
    }
    it.title.textContent = n.title || 'WhatsUp';
    it.body.textContent = n.body || '';
    it.av.src = n.icon || 'assets/logo.png';
    if (!n.silent) ding();
    arm(key);
    report();
  });
})();
