/* Profilrahmen: eigene SVG-Grafiken.
 * viewBox 0 0 120 120 – der Avatar ist der Kreis um (60,60) mit Radius 40.
 * Der Rahmen wird 1,5x so groß wie der Avatar darübergelegt. */
(() => {
  // Umrisse folgen der Textfarbe (hell/dunkel), siehe .avatar .frame in style.css
  const line = 'currentColor';

  const heart = (x, y, s, c) =>
    `<path transform="translate(${x} ${y}) scale(${s})" d="M0 4C-7-2-4-9 0-4.5 4-9 7-2 0 4Z" fill="${c}" stroke="#fff" stroke-width=".8"/>`;
  const spark = (x, y, s, c) =>
    `<path transform="translate(${x} ${y}) scale(${s})" d="M0-8Q1-1 8 0Q1 1 0 8Q-1 1-8 0Q-1-1 0-8Z" fill="${c}"/>`;
  const flower = (x, y, c) => {
    let p = '';
    for (let i = 0; i < 5; i++) {
      const a = (i * 72 - 90) * Math.PI / 180;
      p += `<circle cx="${(x + Math.cos(a) * 4.6).toFixed(1)}" cy="${(y + Math.sin(a) * 4.6).toFixed(1)}" r="4" fill="${c}"/>`;
    }
    return p + `<circle cx="${x}" cy="${y}" r="2.8" fill="#ffd34d"/>`;
  };
  const onRing = (deg, r = 40) => {
    const a = deg * Math.PI / 180;
    return [+(60 + Math.cos(a) * r).toFixed(1), +(60 + Math.sin(a) * r).toFixed(1)];
  };

  const FRAMES = {
    cat: {
      name: 'Katzenohren',
      svg: `<g stroke="${line}" stroke-width="2.5" stroke-linejoin="round">
          <path d="M27 40 31 9 55 25Z" fill="#fff"/><path d="M93 40 89 9 65 25Z" fill="#fff"/></g>
        <path d="M33 32 35 18 46 26Z" fill="#f7a8c8"/><path d="M87 32 85 18 74 26Z" fill="#f7a8c8"/>
        <g stroke="${line}" stroke-width="2.2" stroke-linecap="round" fill="none">
          <path d="M3 56 19 60M2 66 19 66M4 76 19 72"/><path d="M117 56 101 60M118 66 101 66M116 76 101 72"/></g>`,
    },
    bunny: {
      name: 'Hasenohren',
      svg: `<g stroke="${line}" stroke-width="2.5">
          <ellipse cx="45" cy="17" rx="8.5" ry="16" transform="rotate(-14 45 17)" fill="#fff"/>
          <ellipse cx="75" cy="17" rx="8.5" ry="16" transform="rotate(14 75 17)" fill="#fff"/></g>
        <ellipse cx="45" cy="18" rx="4" ry="10.5" transform="rotate(-14 45 18)" fill="#f7a8c8"/>
        <ellipse cx="75" cy="18" rx="4" ry="10.5" transform="rotate(14 75 18)" fill="#f7a8c8"/>`,
    },
    devil: {
      name: 'Teufelshörner',
      svg: `<g fill="#e5484d" stroke="#8b1d22" stroke-width="2" stroke-linejoin="round">
          <path d="M31 36C22 27 21 13 28 4 31 16 38 24 47 26Z"/><path d="M89 36C98 27 99 13 92 4 89 16 82 24 73 26Z"/></g>`,
    },
    halo: {
      name: 'Heiligenschein',
      svg: `<ellipse cx="60" cy="11" rx="27" ry="7" fill="none" stroke="#ffd34d" stroke-width="9" opacity=".25"/>
        <ellipse cx="60" cy="11" rx="27" ry="7" fill="none" stroke="#ffcf3a" stroke-width="4.5"/>
        <ellipse cx="60" cy="10.5" rx="27" ry="6.5" fill="none" stroke="#fff6c9" stroke-width="1.2"/>`,
    },
    crown: {
      name: 'Krone',
      svg: `<g transform="rotate(-8 60 18)">
          <path d="M37 31 35 7 48 18 60 3 72 18 85 7 83 31Z" fill="#ffc83d" stroke="#b7791f" stroke-width="2" stroke-linejoin="round"/>
          <path d="M37 31H83" stroke="#b7791f" stroke-width="2"/>
          <circle cx="60" cy="24" r="3.2" fill="#e5484d"/><circle cx="47" cy="25" r="2.4" fill="#1a8cff"/><circle cx="73" cy="25" r="2.4" fill="#30a46c"/></g>`,
    },
    party: {
      name: 'Partyhut',
      svg: `<g transform="rotate(24 84 22)">
          <path d="M69 36 84 3 99 36Z" fill="#1a8cff" stroke="#0b5cad" stroke-width="2" stroke-linejoin="round"/>
          <path d="M73.5 27H94.5M77 19H91" stroke="#ffd34d" stroke-width="3.2"/>
          <circle cx="84" cy="4" r="4.5" fill="#ff5b9e" stroke="#fff" stroke-width="1"/></g>
        ${spark(18, 22, 0.6, '#ffd34d')}${spark(104, 70, 0.5, '#ff5b9e')}`,
    },
    headphones: {
      name: 'Kopfhörer',
      svg: `<path d="M14 64A46 46 0 0 1 106 64" fill="none" stroke="${line}" stroke-width="6" stroke-linecap="round"/>
        <rect x="7" y="52" width="15" height="27" rx="7" fill="#1a8cff" stroke="${line}" stroke-width="2.5"/>
        <rect x="98" y="52" width="15" height="27" rx="7" fill="#1a8cff" stroke="${line}" stroke-width="2.5"/>`,
    },
    flowers: {
      name: 'Blumenkranz',
      svg: (() => {
        const cols = ['#ff8fb8', '#ffffff', '#c9a7ff', '#ff8fb8', '#ffffff', '#c9a7ff', '#ff8fb8'];
        let s = '';
        [-165, -140, -115, -90, -65, -40, -15].forEach((d, i) => {
          const [lx, ly] = onRing(d + 12, 41);
          if (i < 6) s += `<ellipse cx="${lx}" cy="${ly}" rx="4.5" ry="2.2" fill="#58b368" transform="rotate(${d + 102} ${lx} ${ly})"/>`;
        });
        [-165, -140, -115, -90, -65, -40, -15].forEach((d, i) => { const [x, y] = onRing(d, 41); s += flower(x, y, cols[i]); });
        return s;
      })(),
    },
    hearts: {
      name: 'Herzen',
      svg: heart(20, 24, 1.5, '#ff5b7f') + heart(98, 18, 1.1, '#ff8fb8') + heart(108, 58, 0.9, '#ff5b7f') +
        heart(12, 70, 1.0, '#ff8fb8') + heart(100, 98, 1.3, '#ff5b7f') + heart(22, 104, 0.8, '#ff8fb8'),
    },
    sparkles: {
      name: 'Funkeln',
      svg: spark(18, 20, 1.1, '#ffd34d') + spark(102, 24, 0.8, '#fff2a8') + spark(110, 74, 1.0, '#ffd34d') +
        spark(12, 86, 0.7, '#fff2a8') + spark(96, 106, 0.75, '#ffd34d') + spark(58, 6, 0.6, '#fff2a8'),
    },
    neon: {
      name: 'Neon',
      svg: `<circle cx="60" cy="60" r="44" fill="none" stroke="#a855f7" stroke-width="11" opacity=".22"/>
        <circle cx="60" cy="60" r="44" fill="none" stroke="#a855f7" stroke-width="3.5"/>
        <circle cx="60" cy="60" r="44" fill="none" stroke="#1a8cff" stroke-width="3.5" stroke-dasharray="69 69" transform="rotate(-45 60 60)"/>
        ${spark(100, 22, 0.6, '#fff')}${spark(20, 98, 0.5, '#fff')}`,
    },
    // ---------- Exklusiv: nur mit Einlöse-Code (Erfolge → Code einlösen) ----------
    flames: {
      name: 'Flammen', locked: true,
      svg: (() => {
        const flame = (deg, s) => {
          const [x, y] = onRing(deg, 42);
          return `<g transform="translate(${x} ${y}) rotate(${deg + 90}) scale(${s})">
            <path d="M0 2C-7-3-6-11 0-20 6-11 7-3 0 2Z" fill="#ff5a1f"/>
            <path d="M0 1C-3.5-2-3-7 0-12 3-7 3.5-2 0 1Z" fill="#ffd166"/></g>`;
        };
        let s = '';
        [-175, -152, -128, -105, -90, -75, -52, -28, -5].forEach((d, i) => { s += flame(d, [0.6, 0.72, 0.84, 0.94, 1, 0.94, 0.84, 0.72, 0.6][i]); });
        return `<circle cx="60" cy="60" r="42" fill="none" stroke="#ff7a1f" stroke-width="3"/>` + s;
      })(),
    },
    galaxy: {
      name: 'Galaxie', locked: true,
      svg: `<defs><linearGradient id="wuGalaxy" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#7c3aed"/><stop offset=".5" stop-color="#ec4899"/><stop offset="1" stop-color="#06b6d4"/></linearGradient></defs>
        <circle cx="60" cy="60" r="44" fill="none" stroke="url(#wuGalaxy)" stroke-width="12" opacity=".25"/>
        <circle cx="60" cy="60" r="44" fill="none" stroke="url(#wuGalaxy)" stroke-width="4.5"/>
        ${spark(16, 26, 0.9, '#fff')}${spark(104, 18, 0.7, '#e9d5ff')}${spark(112, 70, 0.55, '#fff')}${spark(14, 92, 0.6, '#a5f3fc')}${spark(94, 108, 0.85, '#fff')}
        <circle cx="34" cy="10" r="1.6" fill="#fff"/><circle cx="88" cy="6" r="1.2" fill="#fff"/><circle cx="6" cy="56" r="1.3" fill="#fff"/><circle cx="116" cy="98" r="1.4" fill="#fff"/>`,
    },
    laurel: {
      name: 'Lorbeerkranz', locked: true,
      svg: (() => {
        const leaf = (deg, side) => {
          const [x, y] = onRing(deg, 46);
          return `<ellipse cx="${x}" cy="${y}" rx="3.6" ry="8" transform="rotate(${deg + (side ? 40 : -40)} ${x} ${y})" fill="#f2c94c" stroke="#a87b12" stroke-width="1.2"/>`;
        };
        let s = '';
        for (let d = 100; d <= 250; d += 19) s += leaf(d, 1);
        for (let d = 80; d >= -70; d -= 19) s += leaf(d, 0);
        return s + `<path d="M52 108 60 102 68 108" fill="none" stroke="#a87b12" stroke-width="2.5" stroke-linecap="round"/>`;
      })(),
    },
    rainbow: {
      name: 'Regenbogen', locked: true,
      svg: (() => {
        const cols = ['#ff4d4d', '#ff9f1c', '#ffe14d', '#3ecf8e', '#1a8cff', '#9b5de5'];
        const L = 2 * Math.PI * 44, seg = L / cols.length;
        return `<circle cx="60" cy="60" r="44" fill="none" stroke="#fff" stroke-width="10" opacity=".12"/>` +
          cols.map((c, i) => `<circle cx="60" cy="60" r="44" fill="none" stroke="${c}" stroke-width="5.5" stroke-dasharray="${seg.toFixed(2)} ${(L - seg).toFixed(2)}" stroke-dashoffset="${(-i * seg).toFixed(2)}" transform="rotate(-90 60 60)"/>`).join('');
      })(),
    },
    diamond: {
      name: 'Diamant', locked: true,
      svg: (() => {
        const gem = (deg, s) => {
          const [x, y] = onRing(deg, 44);
          return `<path transform="translate(${x} ${y}) scale(${s})" d="M0-8 6.5 0 0 8-6.5 0Z" fill="#7dd3fc" stroke="#fff" stroke-width="1.2"/>
            <path transform="translate(${x} ${y}) scale(${s})" d="M0-8 2.5 0 0 8" fill="none" stroke="#e0f2fe" stroke-width="1"/>`;
        };
        return `<circle cx="60" cy="60" r="44" fill="none" stroke="#38bdf8" stroke-width="2.5"/>` +
          [-90, -30, 30, 90, 150, 210].map((d, i) => gem(d, i === 0 ? 1.5 : 1)).join('') +
          spark(100, 16, 0.55, '#fff') + spark(18, 100, 0.5, '#fff');
      })(),
    },
  };

  // Banner für den Profil-Status (ebenfalls nur mit Code)
  window.WHATSUP_BANNERS = {
    sunset: { name: 'Sonnenuntergang', bg: 'linear-gradient(135deg, #ff5f6d, #ffc371)' },
    ocean: { name: 'Ozean', bg: 'linear-gradient(135deg, #0061ff, #60efff)' },
    neon: { name: 'Neon', bg: 'linear-gradient(135deg, #f72585, #7209b7 55%, #3a0ca3)' },
    gold: { name: 'Gold', bg: 'linear-gradient(135deg, #a87b12, #ffd700 50%, #b8860b)' },
    galaxy: { name: 'Galaxie', bg: 'radial-gradient(circle at 20% 30%, rgba(255,255,255,.35) 0 1px, transparent 2px), radial-gradient(circle at 75% 60%, rgba(255,255,255,.3) 0 1px, transparent 2px), linear-gradient(135deg, #0f0c29, #302b63 55%, #6d28d9)' },
  };

  window.WHATSUP_FRAMES = FRAMES;
})();
