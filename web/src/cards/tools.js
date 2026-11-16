// "כלים": date conversion, VAT, a world clock, work hours. The card is a launcher; each tool opens in the layer.
import { h, zmanim, openLayer } from '../core.js';
import { search as placeSearch } from '../location.js';
import { HDate, gematriya } from '@hebcal/core';
import { row, number } from '../ui.js';

const X_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const SUN_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--sun)" stroke-width="1.3"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>';
const MOON_ICON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M12.5 10.2A5 5 0 0 1 5.8 3.5a5 5 0 1 0 6.7 6.7z"/></svg>';
const VAT = 0.18; // SPEC: fixed in code.
const IL = 'Asia/Jerusalem';

// ---------- dates ----------
const pad = n => String(n).padStart(2, '0');
const WEEK = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const GMONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
/** Hebrew months of a year in calendar order (Tishrei first): [month number, name]. */
function hebMonths(y) {
  const n = HDate.monthsInYear(y);
  const order = [7, 8, 9, 10, 11, 12, ...(n === 13 ? [13] : []), 1, 2, 3, 4, 5, 6];
  return order.map(m => [m, new HDate(1, m, y).renderGematriya(true, true).split(' ').slice(1).join(' ')]);
}
/** Free text -> { greg: Date } or { heb: HDate } or null. "24.11.2026", "2026-11-24", "כ״ד כסלו תשפ״ז", "ט״ו שבט". */
export function parseDate(text) {
  const t = String(text).trim();
  let m = t.match(/^(\d{1,2})[./\-](\d{1,2})[./\-](\d{2}|\d{4})$/);
  if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const d = new Date(y, m[2] - 1, +m[1]); return d.getMonth() === m[2] - 1 ? { greg: d } : null; }
  m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { const d = new Date(+m[1], m[2] - 1, +m[3]); return d.getMonth() === m[2] - 1 ? { greg: d } : null; }
  if (!/[א-ת]/.test(t)) return null;
  const clean = t.replace(/["“”]/g, '״').replace(/['`’]/g, '׳');
  try { return { heb: HDate.fromGematriyaString(clean) }; } catch {}
  try { return { heb: HDate.fromGematriyaString(clean + ' ' + gematriya(new HDate().getFullYear())) }; } catch {}
  return null;
}
const hebText = hd => hd.renderGematriya(true);
const gregText = d => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;

function dateTab(box) {
  const free = h('input', { type: 'search', class: 'tl-free', placeholder: 'כ״ד כסלו תשפ״ז או 24.11.2026', 'aria-label': 'תאריך' });
  const after = h('input', { type: 'checkbox' });
  const hd = h('select', {}), hm_ = h('select', {}), hy = h('select', {});
  const gd = h('select', {}, ...Array.from({ length: 31 }, (_, i) => h('option', { value: i + 1 }, i + 1)));
  const gm = h('select', {}, ...GMONTHS.map((n, i) => h('option', { value: i }, n)));
  const gy = h('input', { type: 'number', min: 1, max: 9999, style: 'width:6em' });
  const out = h('div', { class: 'tl-out' });
  let greg = new Date(); greg.setHours(12, 0, 0, 0);

  const fillHeb = heb => {
    const y = heb.getFullYear();
    if (!hy.options.length || Math.abs(y - +hy.options[0].value - 150) > 100) {
      hy.replaceChildren(...Array.from({ length: 301 }, (_, i) => y - 150 + i).map(v => h('option', { value: v }, gematriya(v))));
    }
    hy.value = y;
    hm_.replaceChildren(...hebMonths(y).map(([m, n]) => h('option', { value: m }, n)));
    hm_.value = heb.getMonth();
    hd.replaceChildren(...Array.from({ length: HDate.daysInMonth(heb.getMonth(), y) }, (_, i) => h('option', { value: i + 1 }, gematriya(i + 1))));
    hd.value = heb.getDate();
  };
  const show = (src) => {
    // The civil day is the anchor; "after sunset" moves the Hebrew date one day on.
    const heb = new HDate(greg).add(after.checked ? 1 : 0, 'd');
    if (src !== 'heb') fillHeb(heb);
    if (src !== 'greg') { gd.value = greg.getDate(); gm.value = greg.getMonth(); gy.value = greg.getFullYear(); }
    out.replaceChildren(h('div', { class: 'big tl-heb' }, hebText(heb)),
      h('div', {}, `יום ${WEEK[greg.getDay()]}${after.checked ? ' (בלילה)' : ''}, `, h('b', { class: 'num' }, gregText(greg))));
  };
  const fromHeb = () => {
    const y = +hy.value, months = hebMonths(y).map(x => x[0]);
    let m = +hm_.value; if (!months.includes(m)) m = m === 13 ? 12 : m;
    const d = Math.min(+hd.value || 1, HDate.daysInMonth(m, y));
    greg = new HDate(d, m, y).greg(); greg.setHours(12, 0, 0, 0);
    if (after.checked) greg.setDate(greg.getDate() - 1);
    fillHeb(new HDate(d, m, y));
    show('heb');
  };
  const fromGreg = () => {
    const y = +gy.value || greg.getFullYear(), m = +gm.value, d = Math.min(+gd.value, new Date(y, m + 1, 0).getDate());
    greg = new Date(y, m, d, 12); greg.setFullYear(y);
    show('greg');
  };
  free.addEventListener('input', () => {
    const p = parseDate(free.value);
    free.classList.toggle('bad', !!free.value.trim() && !p);
    if (!p) return;
    if (p.greg) { greg = p.greg; greg.setHours(12, 0, 0, 0); after.checked = false; }
    else { greg = p.heb.greg(); greg.setHours(12, 0, 0, 0); if (after.checked) greg.setDate(greg.getDate() - 1); }
    show();
  });
  [hd, hm_, hy].forEach(x => x.addEventListener('change', fromHeb));
  [gd, gm].forEach(x => x.addEventListener('change', fromGreg));
  gy.addEventListener('input', fromGreg);
  after.addEventListener('change', () => show());
  box.append(free, out,
    row('עברי', h('span', { class: 'tl-sel' }, hd, hm_, hy)),
    row('לועזי', h('span', { class: 'tl-sel' }, gd, gm, gy)),
    h('label', { class: 'check' }, after, h('span', {}, 'אחרי השקיעה', h('span', { class: 'hint' }, 'התאריך העברי כבר של מחר'))));
  show();
}

function vatTab(box) {
  const rows = [['before', 'לפני מע״מ'], ['vat', `מע״מ (${VAT * 100}%)`], ['total', 'כולל מע״מ']];
  const inputs = {};
  const set = (from, raw) => {
    const x = parseFloat(String(raw).replace(/,/g, ''));
    const before = !Number.isFinite(x) ? NaN : from === 'before' ? x : from === 'vat' ? x / VAT : x / (1 + VAT);
    const v = { before, vat: before * VAT, total: before * (1 + VAT) };
    for (const k in inputs) if (k !== from) inputs[k].value = Number.isFinite(v[k]) ? +v[k].toFixed(2) : '';
  };
  for (const [k, label] of rows) {
    inputs[k] = h('input', { type: 'text', inputmode: 'decimal', class: 'num tl-money', 'aria-label': label, oninput: e => set(k, e.target.value) });
    box.append(row(label, h('span', { class: 'unit' }, inputs[k], '₪')));
  }
}

// ---------- world clock ----------
// Default cities (for the user's approval): large Haredi communities abroad and tzaddikim's graves. Israel is local.
export const CITIES = [
  { name: 'ניו יורק (בורו פארק)', lat: 40.6331, lng: -73.9967, tz: 'America/New_York' },
  { name: 'וויליאמסבורג', lat: 40.7081, lng: -73.9571, tz: 'America/New_York' },
  { name: 'לייקווד', lat: 40.0821, lng: -74.2097, tz: 'America/New_York' },
  { name: 'מונסי', lat: 41.1112, lng: -74.0685, tz: 'America/New_York' },
  { name: 'קרית יואל', lat: 41.3418, lng: -74.1679, tz: 'America/New_York', tzaddik: 'רבי יואל מסאטמר' },
  { name: 'מונטריאול', lat: 45.5200, lng: -73.6100, tz: 'America/Toronto' },
  { name: 'לונדון (סטמפורד היל)', lat: 51.5664, lng: -0.0726, tz: 'Europe/London' },
  { name: 'מנצ׳סטר', lat: 53.5130, lng: -2.2550, tz: 'Europe/London' },
  { name: 'אנטוורפן', lat: 51.2108, lng: 4.4219, tz: 'Europe/Brussels' },
  { name: 'פריז', lat: 48.8566, lng: 2.3522, tz: 'Europe/Paris' },
  { name: 'אומן', lat: 48.7484, lng: 30.2218, tz: 'Europe/Kyiv', tzaddik: 'רבי נחמן מברסלב' },
  { name: 'מז׳יבוז׳', lat: 49.4384, lng: 27.4147, tz: 'Europe/Kyiv', tzaddik: 'הבעל שם טוב' },
  { name: 'ברדיטשוב', lat: 49.8927, lng: 28.6018, tz: 'Europe/Kyiv', tzaddik: 'רבי לוי יצחק מברדיטשוב' },
  { name: 'ליזענסק', lat: 50.2598, lng: 22.4183, tz: 'Europe/Warsaw', tzaddik: 'רבי אלימלך מליזענסק' },
  { name: 'קרקוב', lat: 50.0516, lng: 19.9450, tz: 'Europe/Warsaw', tzaddik: 'הרמ״א' },
  { name: 'ברטיסלבה (פרשבורג)', lat: 48.1440, lng: 17.0990, tz: 'Europe/Bratislava', tzaddik: 'החתם סופר' },
];
function parts(tz, d) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
}
export function tzOffset(tz, d = new Date()) {
  const p = parts(tz, d);
  return (Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000) / 60000;
}
const tTime = (d, tz) => d ? d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: tz }) : '-';
const diffText = m => { if (!m) return 'כמו בישראל'; const a = Math.abs(m), hh = Math.floor(a / 60), mm = a % 60; return `${m > 0 ? 'עוד' : 'פחות'} ${mm ? `${hh}:${pad(mm)} שעות` : hh === 1 ? 'שעה' : hh === 2 ? 'שעתיים' : hh + ' שעות'}`; };
/** A noon Date whose local y/m/d is the city's civil date + `add` days (the engine reads the date as y/m/d). */
function cityDay(tz, now, add = 0) {
  const p = parts(tz, now);
  return new Date(+p.year, p.month - 1, +p.day + add, 12);
}
async function cityRow(c, candleMins) {
  const now = new Date();
  const loc = { lat: c.lat, lng: c.lng, elev: 0 };
  const today = cityDay(c.tz, now);
  const toFri = (5 - today.getDay() + 7) % 7;
  const [z, zf] = await Promise.all([zmanim(today, loc).catch(() => null), zmanim(cityDay(c.tz, now, toFri), loc).catch(() => null)]);
  let fri = zf?.sunset ? new Date(zf.sunset - candleMins * 60000) : null;
  if (fri && toFri === 0 && zf.sunset < now) { // Friday after sunset: next week's
    const zn = await zmanim(cityDay(c.tz, now, 7), loc).catch(() => null);
    fri = zn?.sunset ? new Date(zn.sunset - candleMins * 60000) : null;
  }
  const day = z?.sunrise && z?.sunset ? now >= z.sunrise && now < z.sunset : null;
  return h('div', { class: 'item' },
    day == null ? null : h('span', { class: 'tl-ic', html: day ? SUN_ICON : MOON_ICON, title: day ? 'יום' : 'לילה' }),
    h('div', { class: 'tl-c' }, h('div', { class: 'val' }, c.name),
      h('div', { class: 'lab' }, 
        z?.sunset ? `שקיעה ${tTime(z.sunset, c.tz)}` : '', fri ? ` · הדלקה ביום ו׳ ${tTime(fri, c.tz)}` : ''),
      c.tzaddik ? h('div', { class: 'lab' }, 'ציון ' + c.tzaddik) : ''),
    h('span', { class: 'end' }));
}
/** Cities that show the same time now, together (the time once, then their names). */
function byTime(list) {
  const now = new Date(), groups = new Map();
  list.forEach((c, i) => { const t = tTime(now, c.tz); if (!groups.has(t)) groups.set(t, []); groups.get(t).push([c, i]); });
  return [...groups].map(([t, cs]) => ({ t, off: tzOffset(cs[0][0].tz, now) - tzOffset(IL, now), cs }));
}
function clockTab(box, ctx) {
  const list = h('div', {});
  const cities = () => ctx.s.cities || CITIES;
  const draw = async () => {
    const out = [];
    for (const g of byTime(cities())) {
      out.push(h('div', { class: 'row tl-group' }, h('span', {}, diffText(g.off)), h('b', { class: 'num tl-time' }, g.t)));
      const rows = await Promise.all(g.cs.map(([c]) => cityRow(c, ctx.s.candleMins)));
      rows.forEach((r, k) => { const i = g.cs[k][1]; r.querySelector('.end').append(h('button', { class: 'icon', title: 'הסרה', 'aria-label': 'הסרה', html: X_ICON, onclick: () => { ctx.set({ cities: cities().filter((_, j) => j !== i) }); draw(); ctx.rerender(); } })); });
      out.push(...rows);
    }
    list.replaceChildren(...out);
  };
  // Adding a city in place: a search; the tzaddik's name is optional.
  const input = h('input', { type: 'search', class: 'tl-free', placeholder: 'חיפוש עיר', 'aria-label': 'חיפוש עיר' });
  const tz = h('input', { type: 'text', placeholder: 'לא חובה', 'aria-label': 'ציון' });
  const res = h('div', { class: 'list' });
  let t = 0;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    const found = input.value.trim() ? await placeSearch(input.value).catch(() => []) : [];
    res.replaceChildren(...found.filter(p => p.tz).map(p => h('button', { onclick: () => {
      ctx.set({ cities: [...cities(), { name: p.name.split(',')[0], lat: p.lat, lng: p.lng, tz: p.tz, ...(tz.value.trim() ? { tzaddik: tz.value.trim() } : {}) }] });
      input.value = tz.value = ''; res.replaceChildren(); addBox.open = false;
      draw(); ctx.rerender();
    } }, p.name)));
  }, 300); });
  const addBox = h('details', {}, h('summary', {}, 'הוספת עיר'), h('div', { class: 'form' }, input, res, row('ציון של צדיק', tz)));
  const reset = h('button', { class: 'link', onclick: () => { ctx.set({ cities: null }); draw(); ctx.rerender(); } }, 'שחזור הרשימה');
  box.append(list, addBox, h('div', {}, reset));
  draw();
  const timer = setInterval(() => { if (!box.isConnected) clearInterval(timer); else draw(); }, 30_000);
}

// ---------- work hours ----------
const toMin = t => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : null; };
/** Minutes between "HH:MM" start and end; an end before the start = past midnight. */
export const span = (s, e) => { const a = toMin(s), b = toMin(e); return a == null || b == null ? 0 : (b - a + 1440) % 1440; };
const hhmm = m => `${Math.floor(m / 60)}:${pad(m % 60)}`;
const fmt = n => n.toLocaleString('he-IL', { maximumFractionDigits: 2 });
function hoursTab(box, ctx) {
  const list = h('div', { class: 'tl-hours' });
  const total = h('div', { class: 'row tl-total' });
  let rows = (ctx.s.hours?.length ? ctx.s.hours : [{ s: '', e: '' }]).map(r => ({ ...r }));
  const sum = () => {
    const m = rows.reduce((a, r) => a + span(r.s, r.e), 0);
    total.replaceChildren(h('span', {}, 'סך הכל'), h('b', { class: 'big' }, hhmm(m)), h('span', { class: 'sub' }, fmt(m / 60) + ' שעות'));
    ctx.set({ hours: rows });
  };
  const draw = () => {
    list.replaceChildren(...rows.map((r, i) => {
      const len = h('span', { class: 'sub num' }, r.s && r.e ? hhmm(span(r.s, r.e)) : '');
      const upd = k => e => { rows[i][k] = e.target.value; len.textContent = rows[i].s && rows[i].e ? hhmm(span(rows[i].s, rows[i].e)) : ''; sum(); };
      return h('div', { class: 'tl-hrow' },
        h('input', { type: 'time', value: r.s, oninput: upd('s'), 'aria-label': 'התחלה' }), '-',
        h('input', { type: 'time', value: r.e, oninput: upd('e'), 'aria-label': 'סיום' }), len,
        h('button', { class: 'icon', title: 'מחיקת שורה', 'aria-label': 'מחיקת שורה', html: X_ICON, onclick: () => { rows.splice(i, 1); if (!rows.length) rows.push({ s: '', e: '' }); draw(); } }));
    }));
    sum();
  };
  box.append(list, h('div', { class: 'chips' },
    h('button', { class: 'btn', onclick: () => { rows.push({ s: '', e: '' }); draw(); } }, 'שורה'),
    h('button', { class: 'btn', onclick: () => { rows = [{ s: '', e: '' }]; draw(); } }, 'ניקוי')), total);
  draw();
}

// ---------- the card ----------
const TABS = [['date', 'תאריך', dateTab], ['vat', 'מע״מ', vatTab], ['clock', 'שעון עולמי', clockTab], ['hours', 'שעות עבודה', hoursTab]];

/** One tool in the layer, under its name. */
function openTool(id, ctx) {
  const t = TABS.find(x => x[0] === id) || TABS[0];
  if (ctx.s.tab !== t[0]) ctx.set({ tab: t[0] });
  openLayer(body => {
    const box = h('div', { class: 'form' });
    body.append(h('h2', {}, t[1]), box);
    t[2](box, ctx);
  });
}

export default {
  id: 'tools',
  title: 'כלים',
  size: [2, 4],
  defaults: { tab: 'date', cities: null, candleMins: 18, hours: [] },
  every: 30_000,
  // A launcher: the tools as chips (each opens in the layer), then the time in the first 3 world-clock cities.
  render(el, ctx) {
    const now = new Date();
    const cities = byTime(ctx.s.cities || CITIES).slice(0, 3);
    el.replaceChildren(
      h('div', { class: 'chips' }, ...TABS.map(([id, label]) => h('button', { class: 'chip', onclick: () => openTool(id, ctx) }, label))),
      cities.length ? h('hr', { class: 'sep' }) : '',
      ...cities.map(g => h('div', { class: 'row', title: g.cs.map(([c]) => c.name).join(', ') }, h('span', { class: 'tl-names' }, g.cs.map(([c]) => c.name.replace(/ \(.*\)$/, '')).join(', ')), h('b', { class: 'num' }, g.t))),
      cities.length ? h('button', { class: 'more', onclick: () => openTool('clock', ctx) }, 'שעון עולמי') : '');
  },
  settings(box, ctx) {
    box.append(row('הדלקת נרות', number(ctx.s.candleMins, 'דק׳ לפני השקיעה', v => ctx.set({ candleMins: v }), { min: 0, max: 60 }), 'בשעון העולמי'));
  },
};

export const css = `
.tl-names { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-group { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--stroke); }
.tl-group:first-child { margin-top: 0; border-top: 0; }
.tl-group b { font-size: 18px; }
.form input.bad { color: var(--bad); }
.tl-sel, .tl-hrow { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.tl-sel { justify-content: flex-end; }
.tl-free { width: 100%; margin: 6px 0; }
.tl-money { width: 110px; text-align: end; }
.tl-sel select, .tl-sel input { min-width: 0; }
.tl-ic { display: inline-flex; flex: none; }
.tl-c { min-width: 0; }
.tl-time { font-size: 18px; }
.tl-total { border-top: 1px solid var(--stroke); padding-top: 6px; }
`;
