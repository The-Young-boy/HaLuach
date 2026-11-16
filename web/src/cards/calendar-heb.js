// Shared Hebrew-calendar helpers for the shabbat, learning, omer, calendar and personal cards (pure functions).
import { HDate, HebrewCalendar, Locale, gematriya, flags, months } from '@hebcal/core';

/** hebcal Hebrew text without niqqud and cantillation; the maqaf becomes "-". */
export const noNiqqud = s => String(s ?? '').replace(/[֑-ֽֿ-ׇ]/g, '').replace(/־/g, '-');
/** hebcal's Hebrew translation of a name, in the plene no-niqqud spelling when hebcal has one (falls back to the name). */
export const he = s => { const t = Locale.lookupTranslation(s, 'he-x-NoNikud'); return t ? noNiqqud(t) : noNiqqud(Locale.gettext(s, 'he')); };
/** A number in Hebrew letters: g(18) = י״ח; plain = without geresh/gershayim (יח). */
export const g = (n, plain = false) => { const s = gematriya(+n); return plain ? s.replace(/[׳״]/g, '') : s; };
/** Every number in a reference to letters: "18:2-3" -> "יח:ב-ג", "7.9" -> "ז:ט", a lone "16" -> "ט״ז". */
export const heNums = s => String(s ?? '').replace(/\d+(?:[.:]\d+)?(?:-\d+(?:[.:]\d+)?)?/g, m =>
  /^\d+$/.test(m) ? g(m) : m.replace(/\d+/g, d => g(d, true)).replace(/\./g, ':'));

/** "21:3","21:8" -> "כא:ג-ח"; "41:8","42:5" -> "מא:ח-מב:ה". */
export function refRange(b, e) {
  if (e == null || String(e) === String(b)) return heNums(String(b));
  const [b1, b2] = String(b).split(/[:.]/), [e1, e2] = String(e).split(/[:.]/);
  if (b2 != null && e2 != null && b1 === e1) return heNums(`${b1}:${b2}-${e2}`);
  return heNums(String(b)) + '-' + heNums(String(e));
}

export const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export function monthName(hd) { return he(hd.getMonthName()); }
/** כ״ד כסלו תשפ״ז (no ה' of the thousands). */
export function hebDate(hd, year = true) { return `${g(hd.getDate())} ${monthName(hd)}${year ? ' ' + g(hd.getFullYear() % 1000) : ''}`; }
/** The Hebrew day at `date`: after sunset it is already the next day. */
export function hdateAt(date, sunset) { const hd = new HDate(date); return sunset && date >= sunset ? hd.next() : hd; }

export function addDays(d, n) { const x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() + n); return x; }
export function noon(d) { const x = new Date(d); x.setHours(12, 0, 0, 0); return x; }

// Without Israeli national days (the user: "תסיר את כל הימים הישראליים") and the North African "Chag HaBanot".
export function holidays(hd, il) { return (HebrewCalendar.getHolidaysOnDate(hd, il) || []).filter(e => !(e.getFlags() & flags.MODERN_HOLIDAY) && e.getDesc() !== 'Chag HaBanot'); }
export function isYomTov(hd, il) { return holidays(hd, il).some(e => e.getFlags() & flags.CHAG); }
/** Shabbat or yom tov (the days of the quiet mode). */
export function isKodesh(hd, il) { return hd.getDay() === 6 || isYomTov(hd, il); }
/** An event's Hebrew name, no niqqud; "ראש השנה 5787" -> "ראש השנה תשפ״ז". */
export function evName(e) { return noNiqqud(e.render('he-x-NoNikud')).replace(/\b(\d{4})\b/, (_, y) => g(+y % 1000)); }

export function parshaName(names) { return 'פרשת ' + names.map(he).join('-'); }

export { HDate, months, flags };
