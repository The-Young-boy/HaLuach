// Personal dates: storage, the Hebrew-date math (adar rules, bar/bat mitzva) and ICS in/out. Pure, no DOM.
// Entry: { id, type: yahrzeit|birthday|wedding, name, relation, gender: m|f|'', greg: 'YYYY-MM-DD'|null, afterSunset,
//          hebrew: { d, m, y }, adarRule: adar1|adar2|both }. Bar/bat mitzva is derived from a birthday with a gender.
import { HDate, HebrewCalendar, getSedra, months } from '@hebcal/core';
import { hebDate, addDays, noon, isKodesh, parshaName } from './calendar-heb.js';

export const KEY = 'haluach.personal';
export const TYPES = { yahrzeit: 'יארצייט', birthday: 'יום הולדת', wedding: 'יום נישואין', barmitzva: 'בר/בת מצווה' };

export function load() { try { const a = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
export function store(list) { try { localStorage.setItem(KEY, JSON.stringify(list)); } catch {} }
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function parseYmd(s) { const [y, m, d] = String(s).split('-').map(Number); return y && m && d ? new Date(y, m - 1, d, 12) : null; }

/** The Hebrew date of a civil date; after sunset it is the next day. */
export function hebrewOf(greg, afterSunset) {
  const d = typeof greg === 'string' ? parseYmd(greg) : greg;
  let hd = new HDate(d);
  if (afterSunset) hd = hd.next();
  return { d: hd.getDate(), m: hd.getMonth(), y: hd.getFullYear() };
}
export function origin(p) { return new HDate(p.hebrew.d, p.hebrew.m, p.hebrew.y); }

/** The dates of an entry in Hebrew year `hy` (a yahrzeit with adarRule "both" has two). */
export function datesInYear(p, hy) {
  const o = origin(p);
  if (hy <= p.hebrew.y) return [];
  if (p.type === 'yahrzeit') {
    // Died in Adar of a plain year, and this year is a leap year: the user's custom.
    if (p.hebrew.m === months.ADAR_I && !HDate.isLeapYear(p.hebrew.y) && HDate.isLeapYear(hy)) {
      const r = p.adarRule || 'adar1';
      const at = m => new HDate(Math.min(p.hebrew.d, HDate.daysInMonth(m, hy)), m, hy);
      return r === 'both' ? [at(months.ADAR_I), at(months.ADAR_II)] : [at(r === 'adar2' ? months.ADAR_II : months.ADAR_I)];
    }
    const y = HebrewCalendar.getYahrzeit(hy, o);
    return y ? [y] : [];
  }
  const b = HebrewCalendar.getBirthdayOrAnniversary(hy, o);
  return b ? [b] : [];
}
/** Bar mitzva at 13, bat mitzva at 12 (the Hebrew birthday, adar rules included), with the parasha of that week. */
export function mitzvaOf(p) {
  if (p.type !== 'birthday' || !p.gender) return null;
  const age = p.gender === 'f' ? 12 : 13;
  const hd = HebrewCalendar.getBirthdayOrAnniversary(p.hebrew.y + age, origin(p));
  if (!hd) return null;
  const sedra = getSedra(hd.getFullYear(), false).lookup(hd);
  return { hd, age, label: p.gender === 'f' ? 'בת מצווה' : 'בר מצווה', parasha: sedra.chag ? '' : parshaName(sedra.parsha) };
}

function title(p, type, years) {
  if (type === 'yahrzeit') return `יארצייט: ${p.name}`;
  if (type === 'birthday') return `יום הולדת ${years}: ${p.name}`;
  if (type === 'wedding') return `יום נישואין ${years}: ${p.name}`;
  return `${years}: ${p.name}`;
}

/** Every occurrence between two civil dates: [{ p, type, hd, date (civil, daytime), eve, years, title, hdate }]. */
export function occurrences(list, from, to) {
  const a = noon(from), b = noon(to), out = [];
  const y0 = new HDate(a).getFullYear(), y1 = new HDate(b).getFullYear();
  for (const p of list) {
    if (!p?.hebrew) continue;
    for (let hy = y0; hy <= y1; hy++) for (const hd of datesInYear(p, hy)) {
      const date = noon(hd.greg());
      if (date < a || date > b) continue;
      const years = hy - p.hebrew.y;
      out.push({ p, type: p.type, hd, date, eve: addDays(date, -1), years, title: title(p, p.type, years), hdate: hebDate(hd) });
    }
    const mz = mitzvaOf(p);
    if (mz) {
      const date = noon(mz.hd.greg());
      if (date >= a && date <= b) out.push({ p, type: 'barmitzva', hd: mz.hd, date, eve: addDays(date, -1), years: mz.age, title: `${mz.label}: ${p.name}`, hdate: hebDate(mz.hd), parasha: mz.parasha });
    }
  }
  return out.sort((x, y) => x.date - y.date);
}

/** The reminder day: the day itself, or before it when it falls on shabbat / yom tov (the quiet mode). */
export function remindDay(date, il) {
  let d = noon(date);
  while (isKodesh(new HDate(d), il)) d = addDays(d, -1);
  return d;
}

/** Hebrew letters of a name for mishnayot / "נשמה" (final letters as regular, only the person's own name). */
const FINAL = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
export function nameLetters(name) {
  const own = String(name || '').split(/\s+(?:בן|בת|ב"ר|בר)\s+/)[0];
  return [...own.replace(/[^א-ת]/g, '')].map(c => FINAL[c] || c);
}

// ---------- ICS ----------
const unesc = s => s.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1');
/** VEVENTs: [{ summary, date: 'YYYY-MM-DD', time: bool }]. */
export function parseICS(text) {
  const lines = String(text).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) ev = {};
    else if (/^END:VEVENT/i.test(line)) { if (ev?.date) out.push({ summary: ev.summary || '', date: ev.date, time: !!ev.time }); ev = null; }
    else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).split(';')[0].toUpperCase(), val = line.slice(i + 1).trim();
      if (key === 'SUMMARY') ev.summary = unesc(val);
      if (key === 'DTSTART') {
        const m = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
        if (!m) continue;
        if (m[7]) { const d = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])); ev.date = ymd(d); }
        else ev.date = `${m[1]}-${m[2]}-${m[3]}`;
        ev.time = !!m[4];
      }
    }
  }
  return out;
}
/** A guess of the type from the summary (the user can change it in the import list). */
export function guessType(summary, fallback = 'birthday') {
  if (/יאר?צייט|יאָרצייט|פטיר|הילולא|אזכרה|yahr?zeit/i.test(summary)) return 'yahrzeit';
  if (/נישואי|חתונה|anniversary|wedding/i.test(summary)) return 'wedding';
  if (/הולדת|birthday/i.test(summary)) return 'birthday';
  return fallback;
}
export function cleanName(summary) {
  return summary.replace(/יאר?צייט|יאָרצייט|יום הולדת|יום נישואין|יום הנישואין|birthday|anniversary|yahr?zeit/gi, '').replace(/^[\s:\-–]+|[\s:\-–]+$/g, '').trim() || summary;
}

const icsEsc = s => String(s).replace(/([,;\\])/g, '\\$1');
const icsDate = d => ymd(d).replace(/-/g, '');
/** The next occurrence of each entry (and each coming bar/bat mitzva) as all-day events. */
export function toICS(list, now = new Date()) {
  const occ = occurrences(list, now, addDays(now, 400));
  const first = new Map(), ev = [];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  for (const o of occ) {
    const k = o.p.id + o.type, y = o.hd.getFullYear();
    if (first.has(k) && first.get(k) !== y) continue; // only the next one (a yahrzeit kept in both Adars has two)
    first.set(k, y);
    ev.push('BEGIN:VEVENT', `UID:${o.p.id}-${o.type}-${icsDate(o.date)}@haluach`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(o.date)}`, `DTEND;VALUE=DATE:${icsDate(addDays(o.date, 1))}`,
      `SUMMARY:${icsEsc(o.title)}`, `DESCRIPTION:${icsEsc(o.hdate + (o.parasha ? ', ' + o.parasha : ''))}`, 'END:VEVENT');
  }
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//HaLuach//Personal dates//HE', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n');
}
