// "שבת וחג": the coming shabbat/yom tov (candles, havdalah, parasha, haftara, mevarchim and molad), eruv tavshilin,
// and today's special prayers. Candle lighting = minutes before sunset by the city's custom (a setting).
// upcoming(days) gives the quiet-mode windows [{ start, end, name }] (candles to havdalah).
import { HDate, Molad, hallel, tachanun, getSedra, months, flags } from '@hebcal/core';
import { getLeyningOnDate } from '@hebcal/leyning';
import { h, zmanText, zmanim, settings, save, cardSettings, openLayer, noPlace, ahead } from '../core.js';
import { TIMES } from './zmanim.js';
import { row, toggle, numbers, choice, select, section } from '../ui.js';
import { he, g, refRange, DAYS, DAYS_SHORT, hebDate, hdateAt, addDays, noon, holidays, isYomTov, isKodesh, evName, parshaName } from './calendar-heb.js';

// ---------- candle lighting by city custom ----------
/** The custom per city, as עתים לבינה prints it on Friday (research/itim/candles.md): minutes before the sunset
 *  "מהגובה" (sunset_elev) or "מהמישור" (sunset). Petah Tikva 30 is from SPEC. Elsewhere: 20, from the user's sunset. r = km. */
export const CITIES = [
  { city: 'ירושלים', lat: 31.778, lng: 35.235, r: 12, min: 40, from: 'sunset_elev' },
  { city: 'בית שמש', lat: 31.747, lng: 34.988, r: 6, min: 40, from: 'sunset_elev' },
  { city: 'ביתר עילית', lat: 31.696, lng: 35.116, r: 4, min: 40, from: 'sunset_elev' },
  { city: 'מודיעין עילית', lat: 31.93, lng: 35.042, r: 4, min: 30, from: 'sunset_elev' },
  { city: 'אלעד', lat: 32.052, lng: 34.951, r: 3, min: 30, from: 'sunset_elev' },
  { city: 'חיפה', lat: 32.794, lng: 34.989, r: 10, min: 30, from: 'sunset_elev' },
  { city: 'צפת', lat: 32.9646, lng: 35.496, r: 5, min: 30, from: 'sunset_elev' },
  { city: 'טבריה', lat: 32.794, lng: 35.53, r: 6, min: 30, from: 'sunset' },
  { city: 'פתח תקווה', lat: 32.0878, lng: 34.8869, r: 4, min: 30, from: null },
  { city: 'בני ברק', lat: 32.0849, lng: 34.8352, r: 2.5, min: 22, from: 'sunset' },
  { city: 'אשדוד', lat: 31.8014, lng: 34.6435, r: 7, min: 22, from: 'sunset_elev' },
  { city: 'באר שבע', lat: 31.252, lng: 34.7915, r: 8, min: 20, from: 'sunset_elev' },
  { city: 'אילת', lat: 29.5577, lng: 34.9519, r: 8, min: 20, from: 'sunset' },
  { city: 'ניו יורק', lat: 40.634, lng: -73.997, r: 40, min: 18, from: 'sunset' },
  { city: 'אנטוורפן', lat: 51.213, lng: 4.421, r: 15, min: 18, from: 'sunset' },
  { city: 'לונדון', lat: 51.57, lng: -0.073, r: 30, min: 15, from: 'sunset' },
];
const OTHER = { city: '', min: 20, from: null };
function km(a, b) {
  const R = 6371, d = Math.PI / 180, x = (b.lng - a.lng) * d * Math.cos((a.lat + b.lat) / 2 * d), y = (b.lat - a.lat) * d;
  return R * Math.hypot(x, y);
}
/** The city custom for a location: by name first, then the nearest city within its radius. */
export function cityCustom(loc) {
  if (!loc) return OTHER;
  const byName = CITIES.find(c => (loc.name || '').includes(c.city) || (c.city === 'פתח תקווה' && /פתח תקוה/.test(loc.name || '')));
  if (byName) return byName;
  const near = CITIES.map(c => ({ c, d: km(loc, c) })).filter(x => x.d <= x.c.r).sort((a, b) => a.d - b.d)[0];
  return near ? near.c : OTHER;
}

export const DEFAULTS = { candleMin: null, candleFrom: 'auto', havdalah: '', prayers: true };
const zs = () => cardSettings('zmanim');
/** The minutes and the sunset the candles count from, after the user's overrides. */
export function candleRule(s = cardSettings('shabbat', DEFAULTS), loc = settings().loc) {
  const c = cityCustom(loc);
  const from = s.candleFrom && s.candleFrom !== 'auto' ? s.candleFrom : (c.from || zs().method?.shkia || 'sunset');
  return { min: s.candleMin ?? c.min, from, city: c.city };
}
export function candleTime(z, rule) { const base = z?.[rule.from] || z?.sunset; return base ? new Date(+base - rule.min * 60_000) : null; }
/** Havdalah = the user's tzeit method (זמני היום), unless this card chose another. */
export function havdalahId(s = cardSettings('shabbat', DEFAULTS)) { return s.havdalah || zs().method?.tzeit || 'tzeit_6_45'; }
export function havdalahTime(z, s) { return z?.[havdalahId(s)] || z?.tzeit_6_45 || null; }

// ---------- the windows ----------
const il = () => !!settings().loc?.il;
function baseName(e) { return he(e.getDesc().replace(/\s+(I|II|III|IV|V|VI|VII|VIII)$|\s+\d{4}$|\s+\(.*\)$/g, '')); }
/** The name of a run of holy days a..b (civil dates): "שבת", "ראש השנה", "סוכות ושבת". */
export function windowName(a, b, isIL = il()) {
  const names = [];
  for (let d = a; d <= b; d = addDays(d, 1)) {
    const hd = new HDate(d);
    for (const e of holidays(hd, isIL)) if (e.getFlags() & flags.CHAG) { const n = baseName(e); if (!names.includes(n)) names.push(n); }
    if (hd.getDay() === 6 && !names.includes('שבת')) names.push('שבת');
  }
  return names.length > 1 ? names.slice(0, -1).join(', ') + ' ו' + names[names.length - 1] : names[0] || '';
}
/** Runs of consecutive shabbat/yom tov days touching [from, from + days]: [{ a, b }] as civil noon dates. */
export function kodeshRuns(from, days, isIL = il()) {
  const out = [], end = addDays(from, days);
  let d = addDays(from, -3); // a running window started up to 3 days ago (2 days yom tov + shabbat)
  while (d <= end) {
    if (isKodesh(new HDate(d), isIL)) {
      let b = d;
      while (isKodesh(new HDate(addDays(b, 1)), isIL)) b = addDays(b, 1);
      out.push({ a: d, b });
      d = addDays(b, 1);
    } else d = addDays(d, 1);
  }
  return out;
}
/** The quiet-mode windows for the next `days` days (a running one included): [{ start, end, name }]. */
export async function upcoming(days = 14, from = new Date(), loc = settings().loc) {
  if (!loc) return [];
  const s = cardSettings('shabbat', DEFAULTS), rule = candleRule(s, loc);
  const out = [];
  for (const { a, b } of kodeshRuns(noon(from), days)) {
    const [zEve, zEnd] = await Promise.all([zmanim(addDays(a, -1), loc), zmanim(b, loc)]);
    const start = candleTime(zEve, rule), end = havdalahTime(zEnd, s);
    if (start && end && end > from) out.push({ start, end, name: windowName(a, b) });
  }
  return out;
}
/** The candles are less than 24 hours away: for raising the card to the top of the board. */
export async function isErev(now = new Date()) {
  const w = (await upcoming(2, now))[0];
  return !!w && w.start - now < 24 * 3600_000 && now < w.start;
}

// ---------- parasha, haftara, mevarchim ----------
/** The shabbat the card shows: this Saturday until havdalah, then the next (the parasha changes on motzei shabbat). */
async function shabbatOf(now, s, loc = settings().loc) {
  let d = noon(now);
  while (d.getDay() !== 6) d = addDays(d, 1);
  if (now.getDay() === 6) { const hv = havdalahTime(await zmanim(d, loc), s); if (hv && now > hv) d = addDays(d, 7); }
  return d;
}
export function parashaOf(hd, isIL = il()) {
  const r = getSedra(hd.getFullYear(), isIL).lookup(hd);
  if (!r.chag) return parshaName(r.parsha);
  const ev = holidays(hd, isIL).find(e => e.getFlags() & (flags.CHAG | flags.CHOL_HAMOED));
  return 'שבת ' + (ev ? evName(ev) : he(r.parsha[0]));
}
const SPECIAL = [[/Machar Chodesh/, 'שבת מחר חודש'], [/Rosh Chodesh/, 'שבת ראש חודש'], [/Chanukah/, 'חנוכה']];
export function haftaraOf(hd, isIL = il(), nusach = settings().nusach) {
  let l;
  try { l = getLeyningOnDate(hd, isIL); } catch { return null; }
  if (!l) return null;
  const parts = (nusach === 'edot' && l.seph) || l.haft;
  if (!parts) return null;
  const text = (Array.isArray(parts) ? parts : [parts]).map(p => `${he(p.k)} ${refRange(p.b, p.e)}`).join('; ');
  const reason = JSON.stringify(l.reason || '');
  const special = holidays(hd, isIL).find(e => e.getFlags() & flags.SPECIAL_SHABBAT);
  const why = special ? evName(special) : SPECIAL.find(([re]) => re.test(reason))?.[1] || '';
  return { text, why };
}
const pad = n => String(n).padStart(2, '0');
/** On the shabbat before rosh chodesh (not Elul): the month, the rosh chodesh days and the molad. */
export function mevarchim(hd) {
  if (hd.getDay() !== 6 || hd.getMonth() === months.ELUL || hd.getDate() < 23 || hd.getDate() > 29) return null;
  const days = hd.daysInMonth();
  const first = new HDate(hd.abs() - hd.getDate() + days + 1);
  const rc = days === 30 ? [new HDate(first.abs() - 1), first] : [first];
  const m = new Molad(first.getFullYear(), first.getMonth());
  return {
    month: he(first.getMonthName()),
    rc: rc.map(x => DAYS_SHORT[x.getDay()]).join(' ו'),
    molad: `יום ${DAYS[m.getDow()]}, ${m.getHour()}:${pad(m.getMinutes())} ו-${m.getChalakim()} חלקים`,
  };
}
/** Eruv tavshilin: today is erev yom tov, and the yom tov days run into shabbat. */
export function eruvTavshilin(today, isIL = il()) {
  const hd = new HDate(today);
  if (isKodesh(hd, isIL)) return false;
  let d = hd.next();
  if (!isYomTov(d, isIL) || d.getDay() === 6) return false;
  if (holidays(d, isIL).some(e => e.getDesc() === 'Yom Kippur')) return false;
  while (isYomTov(d, isIL) && d.getDay() !== 6) d = d.next();
  return d.getDay() === 6;
}

// ---------- today's prayers ----------
function seasons(hd, isIL) {
  const y = hd.getFullYear(), a = hd.abs();
  const rainStart = new HDate(22, months.TISHREI, y).abs(), pesach = new HDate(15, months.NISAN, y).abs();
  let talStart;
  if (isIL) talStart = new HDate(7, months.CHESHVAN, y).abs();
  else {
    // Diaspora: from maariv of 4 December (5 December before a civil leap year), i.e. the Hebrew day of 5 (6) Dec.
    const Y = new HDate(1, months.TISHREI, y).greg().getFullYear(), n = Y + 1;
    const leap = (n % 4 === 0 && n % 100 !== 0) || n % 400 === 0;
    talStart = new HDate(new Date(Y, 11, leap ? 6 : 5)).abs();
  }
  return { a, rainStart, pesach, talStart, rain: a >= rainStart && a < pesach, tal: a >= talStart && a < pesach };
}
/** The prayer changes today (Hebrew day hd). */
export function prayers(hd, isIL = il(), nusach = settings().nusach || 'ashkenaz', walled = false) {
  const evs = holidays(hd, isIL), out = [];
  const has = f => evs.some(e => e.getFlags() & f), desc = re => evs.some(e => re.test(e.getDesc()));
  const shabbat = hd.getDay() === 6, m = hd.getMonth(), d = hd.getDate();
  const rc = has(flags.ROSH_CHODESH), chm = has(flags.CHOL_HAMOED), yt = has(flags.CHAG);
  if (rc || chm || yt) out.push('יעלה ויבוא');
  const hl = hallel(hd, isIL);
  if (hl === 2) out.push('הלל שלם'); else if (hl === 1) out.push(nusach === 'edot' ? 'הלל בדילוג' : 'חצי הלל');
  if (rc && !yt && !shabbat) out.push('מוסף ראש חודש');
  if (desc(/^Chanukah/) || (desc(/^Purim$/) && !walled) || (desc(/^Shushan Purim$/) && walled)) out.push('על הניסים');
  if (m === months.TISHREI && d <= 10) { out.push('המלך הקדוש, זכרנו'); if (!shabbat) out.push('אבינו מלכנו'); }
  if (desc(/^Tish'a B'Av$/)) out.push('נחם, עננו');
  else if (has(flags.MINOR_FAST) && !desc(/Bechorot/)) out.push('עננו', 'אבינו מלכנו');
  if (!shabbat && !yt) {
    const t = tachanun(hd, isIL);
    if (!t.shacharit && !t.mincha) out.push('אין אומרים תחנון');
    else if (t.shacharit && !t.mincha) out.push('אין תחנון במנחה');
  }
  if (shabbat && d >= 23 && m !== months.ELUL) out.push('ברכת החודש');
  if (m === months.NISAN && !shabbat && !yt) out.push('ברכת האילנות');
  const s = seasons(hd, isIL);
  if (s.rain) out.push('משיב הרוח ומוריד הגשם'); else if (!(nusach === 'ashkenaz' && !isIL)) out.push('מוריד הטל');
  out.push(s.tal ? (nusach === 'edot' ? 'ברך עלינו' : 'ותן טל ומטר') : (nusach === 'edot' ? 'ברכנו' : 'ותן ברכה'));
  return out;
}
/** A change of the prayer today or tonight (for the owner's "שינוי תפילה" notification), or null. */
export function prayerChange(hd, isIL = il(), nusach = settings().nusach || 'ashkenaz') {
  const s = seasons(hd, isIL);
  if (s.a === s.rainStart) return 'במוסף מתחילים "משיב הרוח ומוריד הגשם"';
  if (s.a === s.pesach) return 'במוסף מפסיקים "משיב הרוח ומוריד הגשם"';
  const tal = nusach === 'edot' ? 'ברך עלינו' : 'ותן טל ומטר';
  if (s.a + 1 === s.talStart) return `הערב מתחילים "${tal}"`;
  if (s.a === s.talStart) return `מתחילים "${tal}"`;
  return null;
}

// ---------- the card ----------
function countdown(ms) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)} שעות` : `${m} דקות`;
}
const zmanimName = id => { for (const t of TIMES) { const x = t.m.find(m => m[0] === id); if (x) return `${t.name} (${x[1]})`; } return id; };

/** The widget's summary at a moment (now, or ahead: a future time). */
async function summaryAt(now, loc = settings().loc) {
  const s = cardSettings('shabbat', DEFAULTS), isIL = loc.il ?? true;
  const [w] = await upcoming(10, now, loc);
  const hdSat = new HDate(await shabbatOf(now, s, loc));
  const par = parashaOf(hdSat, isIL);
  // Candles are a deadline (rounded down), the end a start (rounded up): zmanText.
  const t = (d, k) => d ? zmanText(d, k) : '-';
  const rows = [];
  let big = par, what = '';
  if (w) {
    const running = now >= w.start, erev = !running && w.start - now < 24 * 3600_000;
    // The time itself, not a countdown: the widget keeps this summary and a countdown would freeze.
    big = running ? t(w.end, 'up') : t(w.start, 'down');
    // What the big value is: the summary stands alone (widget, compact card).
    what = running ? (w.end.getDay() === 6 ? 'צאת השבת' : 'צאת החג') : erev && w.start.toDateString() === now.toDateString() ? 'הדלקת נרות היום' : `הדלקת נרות ביום ${DAYS_SHORT[w.start.getDay()]}`;
    rows.push([`הדלקת נרות (${DAYS_SHORT[w.start.getDay()]})`, t(w.start, 'down'), erev],
      [`${w.end.getDay() === 6 ? 'צאת השבת' : 'צאת החג'} (${DAYS_SHORT[w.end.getDay()]})`, t(w.end, 'up'), running]);
  }
  const hf = haftaraOf(hdSat, isIL);
  if (hf) rows.push(['הפטרה', hf.text]);
  const mv = mevarchim(hdSat);
  if (mv) rows.push(['מברכים', `${mv.month}, ר״ח ${mv.rc}`], ['המולד', mv.molad]);
  if (eruvTavshilin(noon(now), isIL) && (!w || now < w.start)) rows.push(['עירוב תבשילין', 'היום', true]);
  return { big, sub: [what, par, loc.name].filter(Boolean).join(' · '), rows };
}

export default {
  id: 'shabbat',
  needsLoc: true,
  title: 'שבת וחג',
  size: [1, 4],
  defaults: DEFAULTS,
  every: 60_000,
  async render(el, ctx) {
    const loc = settings().loc;
    if (!loc) { el.replaceChildren(noPlace()); return; }
    const s = ctx.s, now = new Date(), isIL = !!loc.il;
    const zToday = await zmanim(now);
    const hdNow = hdateAt(now, zToday?.sunset);
    const [w] = await upcoming(10, now);
    const sat = await shabbatOf(now, s), hdSat = new HDate(sat);
    const todayHd = new HDate(noon(now));
    const row = (label, value, cls = '') => h('div', { class: 'row' + cls }, h('span', {}, label), value);
    const time = (d, k) => h('b', { class: 'num' }, zmanText(d, k));

    // The facts: candles, havdalah (or the second night's lighting), parasha, haftara.
    const facts = [];
    if (isYomTov(todayHd, isIL) && isYomTov(todayHd.next(), isIL) && !(w && now < w.start && w.start - now < 24 * 3600_000))
      facts.push(row('הדלקה לליל ב׳ (לא לפני)', time(havdalahTime(zToday, s), 'up')));
    if (w) {
      const endsShabbat = w.end.getDay() === 6;
      facts.push(row(`הדלקת נרות (${DAYS_SHORT[w.start.getDay()]})`, time(w.start, 'down'), now >= w.start ? ' past' : ''),
        row(`${endsShabbat ? 'צאת השבת' : 'צאת החג'} (${DAYS_SHORT[w.end.getDay()]})`, time(w.end, 'up')));
    }
    const par = parashaOf(hdSat, isIL), hf = haftaraOf(hdSat, isIL), mv = mevarchim(hdSat);
    // A yom tov on a weekday (Yom Kippur on Monday) before that shabbat: its own haftara first, and the parasha
    // row says it is the shabbat's.
    let ytNoSat = false;
    if (w && w.start < sat) {
      ytNoSat = true;
      for (let d = noon(w.start); d <= w.end; d = addDays(d, 1)) if (d.getDay() === 6) ytNoSat = false;
    }
    if (ytNoSat) {
      const hy = haftaraOf(new HDate(addDays(noon(w.start), 1)), isIL);
      if (hy) facts.push(h('div', { class: 'row shb-hf' }, h('span', {}, 'הפטרה ב' + w.name), h('b', {}, hy.text)));
    }
    facts.push(row(ytNoSat ? 'פרשת השבת' : 'פרשה', h('b', {}, par)));
    if (hf) facts.push(h('div', { class: 'row shb-hf', title: hf.why }, h('span', {}, ytNoSat ? 'הפטרת השבת' : 'הפטרה'), h('b', {}, hf.text)));

    // The notes of today as chips: eruv tavshilin and a prayer change first (accent), mevarchim, today's prayers.
    const eruv = eruvTavshilin(noon(now), isIL) && (!w || now < w.start);
    const nusach = settings().nusach || 'ashkenaz';
    const list = s.prayers ? prayers(hdNow, isIL, nusach, cityCustom(loc).city === 'ירושלים') : [];
    const change = s.prayers ? prayerChange(hdNow, isIL, nusach) : null;

    const details = () => openLayer(body => {
      // The candles, havdalah, parasha and haftara are on the card right above; here what is not.
      body.append(h('h2', {}, w?.name || 'שבת'));
      if (!hf?.why && !mv && !eruv && !list.length) body.append(h('div', { class: 'sub' }, 'אין עוד פרטים השבוע.'));
      if (hf?.why) body.append(row('הפטרה מיוחדת', h('b', {}, hf.why)));
      if (mv) body.append(h('h3', {}, 'מברכים החודש'), row('החודש', h('b', {}, mv.month)), row('ראש חודש', h('b', {}, 'יום ' + mv.rc)), row('המולד', h('b', { class: 'shb-mol' }, mv.molad)));
      if (eruv) body.append(h('h3', {}, 'עירוב תבשילין'), h('div', {}, 'היום מניחים עירוב תבשילין.'));
      if (list.length) body.append(h('h3', {}, 'התפילה, ' + hebDate(hdNow, false)),
        change ? h('div', { class: 'sub shb-ch' }, change) : '', h('div', { class: 'chips' }, ...list.map(p => h('span', { class: 'chip' }, p))));
    });
    const chip = (text, on = false, title = '') => h('button', { class: 'chip' + (on ? ' on' : ''), title, onclick: details }, text);
    const chips = [
      eruv ? chip('עירוב תבשילין היום', true) : null,
      change ? chip(change, true) : null,
      mv ? chip('מברכים ' + mv.month, false, 'ראש חודש ביום ' + mv.rc + '. המולד: ' + mv.molad) : null,
      ...list.filter(p => p !== 'ברכת החודש' || !mv).map(p => chip(p)),
    ].filter(Boolean);

    // On erev shabbat / yom tov: the countdown to the candles, large, at the top.
    const head = [];
    if (w && now < w.start && w.start - now < 24 * 3600_000) {
      const m = Math.max(0, Math.round((w.start - now) / 60_000));
      head.push(h('div', { class: 'sub' }, 'הדלקת נרות בעוד'),
        h('div', { class: 'big shb-cd' }, m >= 60 ? [h('span', { class: 'num' }, `${Math.floor(m / 60)}:${pad(m % 60)}`), h('span', { class: 'shb-u' }, ' שעות')] : [h('span', { class: 'num' }, String(m)), h('span', { class: 'shb-u' }, ' דקות')]));
    }
    if (w && w.name && w.name !== 'שבת') head.push(h('div', { class: 'shb-name' }, w.name));
    el.replaceChildren(...head, ...facts,
      chips.length ? h('hr', { class: 'sep' }) : '', chips.length ? h('div', { class: 'chips', title: 'התפילה, ' + hebDate(hdNow, false) }, ...chips) : '',
      h('button', { class: 'more', onclick: details }, 'פירוט'));
  },
  // big = the candles (the countdown on erev shabbat/yom tov, havdalah while it runs), sub = parasha + city.
  async widget() {
    try {
      const loc = settings().loc;
      if (!loc) return { big: '', sub: 'בחרו מיקום בלוח', rows: [] };
      // Sent ahead (core.js ahead()): the widget moves on at candle lighting, at its end and every day.
      // A widget set to another place (התאמה אישית, {name, lat, lng, elev}): its own summary in per, ahead too.
      let places = [];
      try { places = (await fetch('customs?k=shabbat').then(r => r.json())).map(c => [c, JSON.parse(c)]).filter(([, p]) => p.lat != null); } catch {}
      const at = async t => {
        const per = {};
        for (const [k, p] of places) per[k] = await summaryAt(t, { ...p, il: true });
        return { ...(await summaryAt(t)), ...(places.length ? { per } : {}) };
      };
      const times = (await Promise.all([loc, ...places.map(([, p]) => p)].map(p => upcoming(10, new Date(), p)))).flat().flatMap(w => [w.start, w.end]);
      return { ...(await at(new Date())), ahead: await ahead(at, times) };
    } catch (e) { console.error('shabbat widget', e); return { big: '', sub: 'אין נתונים כרגע', rows: [] }; }
  },
  // Saved on every change (DESIGN.md "Inner menus"). The candle reminder uses the same settings().notify keys as the
  // general settings' "התראות" (defaults in planner.js NOTIFY).
  settings(box, ctx) {
    const s = ctx.s, c = cityCustom(settings().loc);
    const put = patch => { ctx.set(patch); ctx.rerender(); };
    const notify = patch => { save({ notify: { ...(settings().notify || {}), ...patch } }); };
    // Minutes: empty = the city custom (the placeholder shows it).
    const min = h('input', { type: 'number', class: 'n', min: 0, max: 90, value: s.candleMin ?? '', placeholder: String(c.min), 'aria-label': 'דקות לפני השקיעה' });
    min.addEventListener('change', () => {
      if (min.value === '') return put({ candleMin: null });
      const v = Math.min(90, Math.max(0, Math.round(+min.value || 0))); min.value = v; put({ candleMin: v });
    });
    const n = settings().notify || {};
    const ids = [...TIMES.find(t => t.id === 'tzeit').m, ...TIMES.find(t => t.id === 'rt').m];
    box.append(
      section('הדלקת נרות'),
      row('דקות לפני השקיעה', h('span', { class: 'unit' }, min, 'דק׳'), c.city ? `ריק = מנהג ${c.city} (${c.min})` : `ריק = ${c.min}`),
      row('מאיזו שקיעה', choice([['auto', 'לפי המנהג'], ['sunset', 'מישור'], ['sunset_elev', 'מהגובה']], s.candleFrom || 'auto', v => put({ candleFrom: v }))),
      ...toggle('תזכורת לפני ההדלקה', n.candles ?? true, v => notify({ candles: v }), '', [
        row('מתי', numbers(Array.isArray(n.candlesMin) && n.candlesMin.length ? n.candlesMin : [30], 'דק׳ לפני', list => notify({ candlesMin: list.length ? list : [30] }), { max: 600 }), 'אפשר כמה: 30, 10'),
      ]),
      section('צאת שבת וחג'),
      row('לפי', select([['', 'צאת הכוכבים שלי'], ...ids], s.havdalah || '', v => put({ havdalah: v })), 'צאת הכוכבים שלי: ' + zmanimName(zs().method?.tzeit || 'tzeit_6_45')),
      section('התפילה'),
      ...toggle('התפילות המיוחדות של היום', s.prayers, v => put({ prayers: v })),
    );
  },
};

export const css = `.shb-cd { margin-bottom: 4px; }
.shb-u { font-size: 14px; font-weight: 400; color: var(--fg2); }
.shb-name { font-size: 13px; font-weight: 600; padding: 2px 0; }
.shb-hf > :first-child { flex: none; }
.row.shb-hf > b { white-space: normal; text-align: end; }
.shb-ch { margin: 4px 0; }
.shb-mol { white-space: normal; text-align: end; font-weight: 400; }`;
