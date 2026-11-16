// "לוח שנה": a month grid (Sunday first), Hebrew or Gregorian month as the main view (the user's choice). Each day:
// both dates, holidays / fasts / rosh chodesh, the parasha on shabbat, Israeli national days (hebcal "modern"),
// and a dot for personal dates. Clicking a day opens its zmanim and learning, with "הוסף אירוע".
import { HDate, HebrewCalendar, flags } from '@hebcal/core';
import { h, zmanText, zmanim, settings, cardSettings, openLayer, ymd, noPlace, ahead } from '../core.js';
import { chosen } from './zmanim.js';
import { learningFor, learningRows, chosenIds } from './learning.js';
import { load as loadPersonal, occurrences } from './personal-calc.js';
import { g, hebDate, hdateAt, monthName, evName, noon, addDays, DAYS, DAYS_SHORT } from './calendar-heb.js';
import { CITIES, tzOffset } from './tools.js';
import { upcoming as kodesh } from './shabbat.js';
import { row, choice } from '../ui.js';

let view = null; // { kind, y, m } of the month on screen (not saved: the card opens on today's month)
let lastCtx = null;
window.addEventListener('haluach:personal-changed', () => lastCtx?.rerender());

const SKIP = flags.DAILY_LEARNING | flags.OMER_COUNT | flags.HEBREW_DATE | flags.MOLAD | flags.YOM_KIPPUR_KATAN | flags.SHABBAT_MEVARCHIM | flags.USER_EVENT;
function kind(e) {
  const f = e.getFlags();
  if (f & flags.PARSHA_HASHAVUA) return 'parasha';
  if (f & flags.CHAG) return 'yt';
  if (f & (flags.MINOR_FAST | flags.MAJOR_FAST)) return 'fast';
  if (f & flags.ROSH_CHODESH) return 'rc';
  if (f & flags.MODERN_HOLIDAY) return 'modern';
  return 'hol';
}
/** The events of each civil day in [a, b]: Map(ymd -> [{ name, kind }]). */
// No Israeli national days at all (the user, 15.11.26: "תסיר את כל הימים הישראליים"); `modern` is kept only for old callers.
export function eventsBetween(a, b, il, modern = false) {
  const evs = HebrewCalendar.calendar({ start: a, end: b, il, sedrot: true, candlelighting: false, noModern: true, locale: 'he' });
  const map = new Map();
  for (const e of evs) {
    if ((e.getFlags() & SKIP) || e.getDesc() === 'Chag HaBanot') continue;
    const k = ymd(e.getDate().greg());
    const name = kind(e) === 'parasha' ? evName(e).replace(/^פרשת /, '') : evName(e);
    (map.get(k) || map.set(k, []).get(k)).push({ name, kind: kind(e) });
  }
  return map;
}

// ---------- the widget ----------
const IL_TZ = 'Asia/Jerusalem';
function cityTime(c, now) {
  const t = now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: c.tz });
  const m = tzOffset(c.tz, now) - tzOffset(IL_TZ, now);
  if (!m) return t;
  const a = Math.abs(m), d = Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '');
  return `${t} (${m > 0 ? '+' : '-'}${d})`;
}
/** The widget summary: today's Hebrew date (after sunset: tomorrow's), the coming events, the world clock. */
export function widgetSummary(now, sunset, il, modern, cities = []) {
  const hd = hdateAt(now, sunset), today = noon(now);
  const evs = eventsBetween(today, addDays(today, 90), il, modern);
  const todays = (evs.get(ymd(today)) || []).filter(e => e.kind !== 'parasha');
  let parasha = '';
  for (let d = today, i = 0; i < 7 && !parasha; i++, d = addDays(d, 1)) parasha = (evs.get(ymd(d)) || []).find(e => e.kind === 'parasha')?.name || '';
  const greg = `${DAYS_SHORT[now.getDay()]} ${now.toLocaleDateString('he-IL', { day: 'numeric', month: 'long' })}`;
  const rows = [], seen = new Set();
  for (const [k, list] of [...evs].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (k <= ymd(today) || rows.length >= 4) continue;
    for (const e of list) {
      if (e.kind === 'parasha' || rows.length >= 4) continue;
      const base = e.name.replace(/[:׳'].*$|\s+[א-ת]׳?\s*$/, '').replace(/\s+(יום|ליל)\s.*$/, '').trim();
      if (seen.has(base)) continue;
      seen.add(base);
      const d = noon(new Date(k + 'T12:00:00')), h2 = new HDate(d);
      rows.push([e.name, `${DAYS_SHORT[d.getDay()]} ${hebDate(h2, false)}`, e.kind === 'yt' || e.kind === 'fast']);
    }
  }
  // No world-clock times here: a widget keeps this summary for hours, and a clock time would be wrong by then.
  return { big: hebDate(hd), sub: greg + (todays.length ? ' · ' + todays.map(e => e.name).join(', ') : parasha ? ' · פרשת ' + parasha : ''), rows };
}

/** The month on screen:its first and last civil days and the title. */
function monthOf(v) {
  if (v.kind === 'greg') {
    const first = new Date(v.y, v.m, 1, 12), last = new Date(v.y, v.m + 1, 0, 12);
    const h1 = new HDate(first), h2 = new HDate(last);
    const sub = h1.getMonth() === h2.getMonth() ? monthName(h1) : `${monthName(h1)}-${monthName(h2)}`;
    return { first, last, title: first.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }), sub: `${sub} ${g(h2.getFullYear() % 1000)}` };
  }
  const h1 = new HDate(1, v.m, v.y), first = noon(h1.greg()), last = noon(new HDate(h1.daysInMonth(), v.m, v.y).greg());
  const m1 = first.toLocaleDateString('he-IL', { month: 'long' }), m2 = last.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
  return { first, last, title: `${monthName(h1)} ${g(v.y % 1000)}`, sub: m1 === last.toLocaleDateString('he-IL', { month: 'long' }) ? m2 : `${m1}-${m2}` };
}
function today(kindName) {
  const now = new Date(), hd = new HDate(now);
  return kindName === 'greg' ? { kind: 'greg', y: now.getFullYear(), m: now.getMonth() } : { kind: 'heb', y: hd.getFullYear(), m: hd.getMonth() };
}
function step(v, dir) {
  if (v.kind === 'greg') { const d = new Date(v.y, v.m + dir, 1); return { kind: 'greg', y: d.getFullYear(), m: d.getMonth() }; }
  const { first, last } = monthOf(v);
  const hd = new HDate(dir > 0 ? addDays(last, 1) : addDays(first, -1));
  return { kind: 'heb', y: hd.getFullYear(), m: hd.getMonth() };
}

// ---------- the day layer ----------
export function openDay(date) {
  date = noon(date);
  const hd = new HDate(date), il = !!settings().loc?.il;
  openLayer(body => {
    // The date, what the day is, a link to add a date; then the day's times and learning, each under its own title.
    body.append(h('h2', {}, `יום ${DAYS[date.getDay()]}, ${hebDate(hd)}`),
      h('div', { class: 'cal-dt' }, h('span', { class: 'sub' }, date.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: 'numeric' })),
        h('button', { class: 'link', onclick: () => window.dispatchEvent(new CustomEvent('haluach:add-personal', { detail: { date, ymd: ymd(date) } })) }, 'הוספת תאריך אישי')));
    const evs = eventsBetween(date, date, il, cardSettings('calendar', { modern: true }).modern).get(ymd(date)) || [];
    const mine = occurrences(loadPersonal(), date, date);
    if (evs.length || mine.length) body.append(h('div', { class: 'chips cal-ev' },
      ...evs.map(e => h('span', { class: 'chip' }, e.kind === 'parasha' ? 'פרשת ' + e.name : e.name)),
      ...mine.map(o => h('span', { class: 'chip on' }, o.title))));
    const zbox = h('div', { class: 'cal-z' }, settings().loc ? h('div', { class: 'sub' }, 'טוען זמנים...') : noPlace());
    const isToday = ymd(date) === ymd(new Date());
    const learn = learningRows(learningFor(hd, chosenIds(cardSettings('learning')), il), { today: isToday });
    body.append(h('h3', {}, 'זמנים'), zbox, learn.length ? h('h3', {}, 'לימוד יומי') : '', ...learn);
    if (settings().loc) Promise.all([zmanim(date), kodesh(3, addDays(date, -1)).catch(() => [])]).then(([z, ws]) => {
      const list = chosen(cardSettings('zmanim')).filter(t => t.on && z?.[t.method]).map(t => [t.name, z[t.method], false, t.round]);
      // Candle lighting and the end of shabbat / yom tov on this day (the shabbat card's rules), in their place.
      for (const w of ws) {
        if (ymd(w.start) === ymd(date)) list.push(['הדלקת נרות', w.start, true, 'down']);
        if (ymd(w.end) === ymd(date)) list.push([w.end.getDay() === 6 ? 'צאת השבת' : 'צאת החג', w.end, true, 'up']);
      }
      // Chanukah: tonight's lights, at nightfall by the user's method (on Friday the shabbat candles come first;
      // on Saturday night after havdalah).
      if (evs.some(e => /^חנוכה.*נר/.test(e.name))) {
        const tz = z?.[chosen(cardSettings('zmanim')).find(t => t.id === 'tzeit')?.method] || z?.tzeit_8_5;
        const sat = ws.find(w => ymd(w.end) === ymd(date) && w.end.getDay() === 6);
        if (sat) list.push(['נר חנוכה, אחרי הבדלה', sat.end, true, 'up']);
        else if (date.getDay() !== 5 && tz) list.push(['נר חנוכה', tz, true, 'up']);
      }
      list.sort((a, b) => a[1] - b[1]);
      zbox.replaceChildren(...list.map(([n, t, strong, k]) => h('div', { class: 'row' }, strong ? h('b', {}, n) : h('span', {}, n), h('b', { class: 'num' }, zmanText(t, k)))));
    }).catch(() => { zbox.replaceChildren(h('div', { class: 'sub' }, 'הזמנים לא נטענו.')); });
  });
}

export default {
  id: 'calendar',
  title: 'לוח שנה',
  size: [2, 5],
  defaults: { main: 'heb' },
  every: 60 * 60_000,
  async render(el, ctx) {
    lastCtx = ctx;
    const s = ctx.s, il = !!settings().loc?.il;
    if (!view || view.kind !== s.main) view = today(s.main);
    const mo = monthOf(view);
    const start = addDays(mo.first, -mo.first.getDay()), end = addDays(mo.last, 6 - mo.last.getDay());
    const evs = eventsBetween(start, end, il, s.modern);
    const mine = new Map();
    for (const o of occurrences(loadPersonal(), start, end)) { const k = ymd(o.date); (mine.get(k) || mine.set(k, []).get(k)).push(o.title); }
    const tk = ymd(new Date());
    const cells = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const k = ymd(d), hd = new HDate(d), list = evs.get(k) || [], my = mine.get(k) || [];
      const inMonth = d >= mo.first && d <= mo.last;
      const cls = ['cal-d', inMonth ? '' : 'out', k === tk ? 'today' : '', list.some(e => e.kind === 'yt') ? 'yt' : ''].filter(Boolean).join(' ');
      const big = s.main === 'greg' ? d.getDate() : g(hd.getDate(), true), small = s.main === 'greg' ? g(hd.getDate(), true) : d.getDate();
      const label = list.filter(e => e.kind !== 'modern' || !list.some(x => x.kind !== 'modern' && x.kind !== 'parasha'));
      const marks = list.filter(e => e.kind !== 'parasha');
      const day = new Date(d);
      // Narrow: a dot per kind of day (grey = a holiday / fast / rosh chodesh, accent = a personal date).
      // Wide (container query in css): the first name in tiny grey text instead of the dot.
      cells.push(h('button', { class: cls, title: [...list.map(e => e.name), ...my].join('\n'), onclick: () => openDay(day) },
        h('b', {}, big), h('small', {}, small),
        h('span', { class: 'cal-m' }, marks.length ? h('i', {}) : '', my.length ? h('i', { class: 'mine' }) : ''),
        label[0] ? h('span', { class: 'cal-e' }, label[0].name) : ''));
    }
    const chev = d => ({ html: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="${d}"/></svg>` });
    el.replaceChildren(
      h('div', { class: 'cal-top' },
        h('button', { class: 'icon', title: 'החודש הקודם', 'aria-label': 'החודש הקודם', onclick: () => { view = step(view, -1); ctx.rerender(); }, ...chev('M6 3.5 10.5 8 6 12.5') }),
        h('div', { class: 'cal-title' }, h('b', {}, mo.title), ' ', h('span', { class: 'faint' }, mo.sub)),
        h('button', { class: 'link', onclick: () => { view = today(s.main); ctx.rerender(); } }, 'היום'),
        h('button', { class: 'icon', title: 'החודש הבא', 'aria-label': 'החודש הבא', onclick: () => { view = step(view, 1); ctx.rerender(); }, ...chev('M10 3.5 5.5 8 10 12.5') })),
      h('div', { class: 'cal' }, h('div', { class: 'cal-grid' }, ...DAYS_SHORT.map(n => h('span', { class: 'cal-wd' }, n)), ...cells)));
  },
  // "לוח שנה / שעון עולמי": big = today's Hebrew date, sub = the Gregorian date + today's event or the parasha;
  // rows = the next 4 holidays / fasts / rosh chodesh, then the world-clock cities of the tools card.
  // The compact card: what comes next (today's date is in the header already).
  async compact(ctx) {
    const w = await this.widget(ctx);
    const ev = (w.rows || []).filter(r => !/^\d|:/.test(String(r[1])) || /׳|״/.test(String(r[1])));
    const today = String(w.sub || '').split(' · ').slice(1).join(' · ');
    if (!ev.length) return { sub: today || 'אין מועדים קרובים' };
    return { sub: [today, `${ev[0][0]} · ${ev[0][1]}`].filter(Boolean).join(' · '), rows: ev.slice(1, 3) };
  },
  async widget(ctx) {
    try {
      const now = new Date(), il = !!settings().loc?.il;
      const z = settings().loc ? await zmanim(now).catch(() => null) : null;
      const at = (t, sunset) => widgetSummary(t, sunset, il, ctx?.s?.modern !== false, cardSettings('tools').cities || CITIES);
      return { ...at(now, z?.sunset), ahead: await ahead(at) };
    } catch { return { big: '', sub: 'אין נתונים', rows: [] }; }
  },
  // Saved on every change (DESIGN.md "Inner menus").
  settings(box, ctx) {
    box.append(
      row('החודש בכרטיס', choice([['heb', 'עברי'], ['greg', 'לועזי']], ctx.s.main, v => { ctx.set({ main: v }); view = null; ctx.rerender(); })));
  },
};

export const css = `.cal-top { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
.cal-title { flex: 1; min-width: 0; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-title .faint { font-size: 12px; }
.cal { container-type: inline-size; }
.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 1px; }
.cal-wd { text-align: center; font-size: 11px; color: var(--fg3); padding-bottom: 2px; }
.cal-d { display: flex; flex-direction: column; align-items: center; min-width: 0; padding: 3px 0 2px; border: 0; border-radius: var(--radius-s); background: none; color: var(--fg); cursor: pointer; line-height: 1.15; }
.cal-d:hover { background: var(--fill); }
.cal-d b { font-size: 13px; font-weight: 400; font-variant-numeric: tabular-nums; }
.cal-d.yt b { font-weight: 600; }
.cal-d small { font-size: 9px; color: var(--fg3); }
.cal-d.out { opacity: .4; }
.cal-d.today b { display: grid; place-items: center; width: 24px; height: 24px; margin: -3px auto -1px; border-radius: 50%; background: var(--accent); color: var(--on-accent); }
.cal-d.today { font-weight: 600; }

.cal-m { display: flex; gap: 2px; height: 4px; margin-top: 1px; }
.cal-m i { width: 4px; height: 4px; border-radius: 50%; background: var(--fg3); }
.cal-m i.mine { background: var(--accent); }

.cal-e { display: none; max-width: 100%; padding: 0 2px; font-size: 10px; color: var(--fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

@container (min-width: 440px) {
  .cal-d { align-items: stretch; text-align: center; }
  .cal-e { display: block; }
  .cal-m i:not(.mine) { display: none; }
}
.cal-ev { margin: 8px 0; }
.cal-dt { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.cal-z { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); column-gap: 20px; }`;
