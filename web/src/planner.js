// The notification plan for the next 14 days, handed to the provider (/board/schedule). Windows then shows each one
// on time with no process running (ScheduledToastNotification). The shabbat/yom tov windows go with it: nothing
// is scheduled inside them, and the provider blocks live notifications and updates there too (SPEC: "שום דבר").
// Rebuilt on every opening of the board and when settings change.
import { settings, cardSettings, zmanim, zmanText, log, ymd } from './core.js';
import { chosen, remindersOf } from './cards/zmanim.js';

// How far ahead the plan goes: Windows shows it with no process, so a board left closed for two weeks still reminds.
const DAYS = 14;

/** Each source adds items: { id, at: Date, title, body, scenario? }. Cards register sources (see addSource). */
const sources = [];
export function addSource(fn) { sources.push(fn); }

/** The windows when nothing goes out: [[startMs, endMs]] (candle lighting to nightfall). Set by the shabbat card. */
let quietFn = async () => [];
export function setQuiet(fn) { quietFn = fn; }

// The zmanim reminders: per time the user picked, one or more "minutes before" (SPEC: several reminders for one time).
addSource(async () => {
  const z = cardSettings('zmanim');
  const want = remindersOf(z); // { timeId: [minutes before, ...] }
  if (!Object.keys(want).length) return [];
  const out = [];
  const times = chosen(z);
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(); day.setDate(day.getDate() + d);
    const t = await zmanim(day);
    if (!t) return [];
    for (const [id, mins] of Object.entries(want)) {
      const x = times.find(y => y.id === id);
      if (!x || !t[x.method]) continue;
      // "קראתי" / "התפללתי" cancels the rest of today's reminders of shema (both opinions), or of tefila.
      const kind = id.startsWith('shma') ? 'shma' : id.startsWith('tefila') ? 'tefila' : '';
      const done = kind && { label: kind === 'shma' ? 'קראתי' : 'התפללתי', ids: Object.keys(want).filter(k => k.startsWith(kind)).map(k => `z${k}${day.getDate()}m`) };
      for (const m of mins) {
        out.push({ id: `z${id}${day.getDate()}m${m}`, at: new Date(t[x.method] - m * 60_000), title: `${x.name} בעוד ${m} דקות`, body: zmanText(t[x.method], x.round), ...(done ? { done } : {}), ...(notifyOn('zmanimUrgent') && !(notifyOn('zmanimUrgentOff') || []).includes(id) && m === Math.min(...mins) ? { scenario: 'urgent' } : {}) });
      }
    }
  }
  return out;
});

let timer = 0;
export function replan() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      const quiet = (await quietFn()).map(w => [+w[0], +w[1]]);
      const plan = (await Promise.all(sources.map(f => f().catch(e => { log('plan: ' + e.message); return []; })))).flat()
        .filter(x => x.at instanceof Date && !isNaN(x.at))
        .map(x => ({ id: x.id, at: +x.at, title: x.title, body: x.body || '', scenario: x.scenario || '', ...(x.done ? { done: x.done } : {}) }));
      const r = await fetch('schedule', { method: 'POST', body: JSON.stringify({ plan, quiet }) });
      log(`plan: ${plan.length} items, ${await r.text()} scheduled, ${quiet.length} quiet windows`);
    } catch (e) { log('plan failed: ' + e.message); }
  }, 2000);
}

// ---------- the sources from the cards (SPEC: each one is the user's choice) ----------
import { HDate } from '@hebcal/core';
import { upcoming as kodesh, candleRule, candleTime, prayerChange, eruvTavshilin } from './cards/shabbat.js';
import { omerToday, counted } from './cards/omer.js';
import { upcomingPersonal } from './cards/personal.js';
import { remindDay } from './cards/personal-calc.js';
import { holidays, evName, addDays, flags } from './cards/calendar-heb.js';

setQuiet(async () => (await kodesh(DAYS + 2)).map(w => [w.start, w.end]));

// A mark that changes the plan ("ספרתי", a personal date added or removed): build it again.
globalThis.addEventListener?.('haluach:plan-changed', () => replan());
globalThis.addEventListener?.('haluach:personal-changed', () => replan());

/** settings().notify: every notification switch and its minutes. These are the defaults (the general settings show
 *  them, under "התראות"). Lists are "minutes before" / "days before"; 0 = at the time itself. */
export const NOTIFY = {
  candles: true, candlesMin: [30],      // before candle lighting
  omer: true,                           // the count at nightfall + "count without a bracha"
  personal: true, personalDays: [0],    // personal dates, at 9:00, N days before (0 = on the day)
  zmanimUrgent: false,                  // the last reminder of each time also in "Do not disturb" (Windows' urgent toasts)
  prayer: true,                         // a change in the prayer, at sunset the evening before
  eruv: true,                           // eruv tavshilin, at 10:00 on the day
  fast: false, fastMin: [30], fastBechorot: false, // fast start (minutes before) and end
  shipments: true, weather: true, podcasts: true, youtube: true, // live checks while the board runs (app.js)
};

export const notifyOn = (k, def = NOTIFY[k]) => (settings().notify || {})[k] ?? def;
/** A list setting (minutes / days); an empty or broken one falls back to the default. */
export const notifyList = k => { const v = (settings().notify || {})[k]; return Array.isArray(v) && v.length ? v : NOTIFY[k]; };
/** "30, 10" -> [30, 10] (whole numbers in [min, max], no repeats). */
export const parseList = (txt, min = 0, max = 600) => [...new Set(String(txt).split(/[,\s]+/).filter(Boolean).map(Number).filter(x => Number.isInteger(x) && x >= min && x <= max))];
/** The user's method for one of the zmanim card's times (alot, tzeit...). */
const methodOf = id => chosen(cardSettings('zmanim')).find(t => t.id === id)?.method;

// Candle lighting: "minutes before" reminders (default 30), for every shabbat/yom tov window starting this week.
addSource(async () => {
  if (!notifyOn('candles')) return [];
  const mins = notifyList('candlesMin');
  const out = [];
  for (const w of await kodesh(DAYS + 1)) {
    const start = new Date(w.start);
    if (start < Date.now()) continue;
    for (const m of mins) out.push({ id: `c${+start}m${m}`, at: new Date(+start - m * 60_000), title: `הדלקת נרות בעוד ${m} דקות`, body: `${w.name || 'שבת'} · ${zmanText(start, 'down')}` });
  }
  return out;
});

// The omer: at nightfall, the count of tonight; and a day later, if "ספרתי" was not marked, "count without a bracha".
addSource(async () => {
  if (!notifyOn('omer')) return [];
  const out = [];
  const tzId = methodOf('tzeit') || 'tzeit_6_45';
  for (let d = 0; d < DAYS; d++) {
    const day = new Date(); day.setDate(day.getDate() + d);
    const z = await zmanim(day);
    const tz = z?.[tzId] || z?.tzeit_6_45;
    if (!tz) continue;
    const o = omerToday(day, true);
    if (!o) continue;
    out.push({ id: `o${o.year}${o.day}`, at: tz, title: `ספירת העומר: ${o.short}`, body: o.sefira });
    // The next evening's sunset: if this day was not marked, the user counts from then on without a bracha.
    const next = new Date(day); next.setDate(next.getDate() + 1);
    const zn = await zmanim(next);
    if (zn?.sunset && !counted(o.year, o.day)) out.push({ id: `of${o.year}${o.day}`, at: new Date(+zn.sunset - 30 * 60_000), title: 'לא סומן "ספרתי" אתמול', body: 'אם שכחתם לספור יום שלם, ממשיכים לספור בלי ברכה.' });
  }
  return out;
});

// Personal dates: at 9 in the morning, on the day and/or N days before (a day on shabbat/yom tov moves before it).
addSource(async () => {
  if (!notifyOn('personal')) return [];
  const il = !!settings().loc?.il, days = notifyList('personalDays');
  const today = addDays(new Date(), 0), last = addDays(today, DAYS + 1);
  const out = new Map();
  for (const p of upcomingPersonal(DAYS + 1 + Math.max(...days))) for (const n of days) {
    const on = n ? remindDay(addDays(p.type === 'yahrzeit' ? p.eve : p.date, -n), il) : p.remindOn;
    if (!on || on < today || on > last) continue;
    const at = new Date(on); at.setHours(9, 0, 0, 0);
    const id = `p${p.id}${+at}`;
    // The real distance (a reminder moved off shabbat is one day earlier).
    const left = Math.round((addDays(p.type === 'yahrzeit' ? p.eve : p.date, 0) - addDays(on, 0)) / 864e5);
    if (!out.has(id)) out.set(id, { id, at, title: left > 0 ? `${p.title} ${left === 1 ? 'מחר' : left === 2 ? 'בעוד יומיים' : `בעוד ${left} ימים`}` : p.title, body: [p.name, p.hdate].filter(Boolean).join(' · ') });
  }
  return [...out.values()];
});

// Eruv tavshilin: at 10:00 on the erev yom tov that needs it.
addSource(async () => {
  if (!notifyOn('eruv')) return [];
  const out = [];
  for (let d = 0; d < DAYS + 1; d++) {
    const day = addDays(new Date(), d);
    day.setHours(12, 0, 0, 0);
    if (!eruvTavshilin(day, !!settings().loc?.il)) continue;
    const at = new Date(day); at.setHours(10, 0, 0, 0);
    out.push({ id: `e${ymd(day).replace(/-/g, '')}`, at, title: 'היום מניחים עירוב תבשילין', body: 'לפני הדלקת הנרות, כדי לבשל מיום טוב לשבת.' });
  }
  return out;
});

// A change in the prayer (טל ומטר and the like): at sunset the evening before.
addSource(async () => {
  if (!notifyOn('prayer')) return [];
  const out = [];
  for (let d = 1; d < DAYS + 1; d++) {
    const day = new Date(); day.setDate(day.getDate() + d);
    const msg = prayerChange(new HDate(day));
    if (!msg) continue;
    const eve = new Date(day); eve.setDate(eve.getDate() - 1);
    const z = await zmanim(eve);
    if (z?.sunset) out.push({ id: `pr${+day}`, at: z.sunset, title: 'שינוי בתפילה', body: msg });
  }
  return out;
});

// Fasts (SPEC: "התראות תחילת וסוף צום"): as the "now" strip shows them. A minor fast runs from alot to tzeit by
// the user's methods; Yom Kippur and Tisha B'Av start at sunset the evening before. Start: "minutes before";
// end: at the end. Ta'anit Bechorot (firstborn only) has its own switch. Whatever falls in a shabbat/yom tov window
// (Yom Kippur, Tisha B'Av on motzaei shabbat) is dropped by the provider like every other item.
addSource(async () => {
  if (!notifyOn('fast')) return [];
  const il = !!settings().loc?.il, mins = notifyList('fastMin'), out = [];
  for (let d = 0; d < DAYS + 2; d++) {
    const day = addDays(new Date(), d);
    const f = holidays(new HDate(day), il).find(e => (e.getFlags() & (flags.MINOR_FAST | flags.MAJOR_FAST)) && !(e.getFlags() & flags.EREV)
      && (notifyOn('fastBechorot') || !/Bechorot/.test(e.getDesc())));
    if (!f) continue;
    const z = await zmanim(day);
    if (!z) continue;
    const major = !!(f.getFlags() & flags.MAJOR_FAST);
    const start = major ? (await zmanim(addDays(day, -1)))?.sunset : z[methodOf('alot')] || z.alot_72deg;
    const end = z[methodOf('tzeit')] || z.tzeit_8_5;
    const name = evName(f), key = `${day.getFullYear()}${day.getMonth()}${day.getDate()}`;
    if (start) for (const m of mins) out.push({ id: `f${key}s${m}`, at: new Date(+start - m * 60_000), title: m ? `${name} מתחיל בעוד ${m} דקות` : `${name} מתחיל עכשיו`, body: `${major ? 'בשקיעה' : 'בעלות השחר'} · ${zmanText(start, 'sec')}` });
    if (end) out.push({ id: `f${key}e`, at: end, title: `${name} נגמר`, body: zmanText(end, 'up') });
  }
  return out.filter(x => +x.at > Date.now());
});
