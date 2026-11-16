// Where a day's portion is in the Otzaria / Zayit library (seforim.db, the same layout in both): the book's title,
// its TOC headings (each one under the one before), and the reference of its first line ("משנה אהלות יח, ד").
// The provider's /board/book finds the ids (SPEC "קישורים לאוצריא ולזית"). After Zayit's own LimudCycles.kt.
// Pure: no DOM, so a Node script can check every day against the real DB.
import { he, g } from './calendar-heb.js';

const n = x => g(x, true);                    // 18 -> "יח", as the library writes it
const plain = s => String(s).replace(/[׳״"']/g, '');
const first = v => parseInt(String(v), 10);   // "1-3" -> 1
const dot = v => String(v).split(/[.:]/).map(x => parseInt(x, 10)); // "7.10" -> [7, 10]

const MISHNA = { 'ביכורים': 'ביכורים', 'מקוואות': 'מקואות' };
const bavli = (name, daf, amud = 'a') => {
  const t = he(name);
  if (name === 'Shekalim') return { b: 'תלמוד ירושלמי שקלים' };    // the daf yomi learns the Yerushalmi's
  if (name === 'Kinnim' || name === 'Midot' || name === 'Middot') return { b: 'משנה ' + t };
  return { b: t, t: [`דף ${n(daf)}${amud === 'b' ? ':' : '.'}`] };
};
const mishna = (k, v) => {
  const m = he(k), [p, i] = dot(v), b = 'משנה ' + (MISHNA[m] || m);
  return { b, t: ['פרק ' + n(p)], r: `${b} ${n(p)}, ${n(i)}` };
};
function rambam(x) {
  const t = he(x.name), s = String(x.perek);
  // "Eruvin" is translated as the masechta's name
  const b = 'משנה תורה, ' + (x.name === 'Eruvin' ? 'הלכות עירובין' : t);
  // The four books before the halachos are read by their paragraphs ("1-21"); תוכן החיבור by perek:halacha
  if (/^(Transmission of the Oral Law|Positive Mitzvot|Negative Mitzvot)$/.test(x.name)) return { b, r: `${b} ${n(first(s))}` };
  return { b, t: ['פרק ' + n(first(s))] };
}
const CC = 'חפץ חיים, פתיחה להלכות לשון הרע ורכילות';
const CCB = {
  Hakdamah: ['חפץ חיים, הקדמה'], Psichah: [CC + ', הקדמה'], Lavin: [CC + ', לאוין'], Asin: [CC + ', עשיין'], Arurin: [CC + ', ארורין'],
  HilchosLH: ['חפץ חיים, חלק ראשון: הלכות איסורי לשון הרע', true], HilchosRechilus: ['חפץ חיים, חלק שני: הלכות איסורי רכילות', true],
  Tziyurim: ['חפץ חיים, ציורים'],
};
const SHL = { Hakdamah: 'הקדמה', 'Shar Hazechira': 'שער הזכירה', 'Shar Hatvuna': 'שער התבונה', 'Shar Hatorah': 'שער התורה', 'Chasimas Hasefer': 'חתימת הספר' };
const TANYA = {
  'Likkutei Amarim': 'חלק ראשון; ליקוטי אמרים', 'Shaar HaYichud VehaEmunah': 'חלק שני; שער היחוד והאמונה',
  'Iggeret HaTeshuvah': 'חלק שלישי; אגרת התשובה', 'Iggeret HaKodesh': 'אגרת הקדש', 'Kuntres Acharon': 'קונטרס אחרון',
};
const TANYA_SEC = { 'Title Page': 'שער', Approbation: 'הסכמות', "Compiler's Foreword": 'הקדמת המלקט', 'Chinukh Katan': 'חינוך קטן' };
const AH = { 'Orach Chaim': 'אורח חיים', "Yoreh De'ah": 'יורה דעה', 'Even HaEzer': 'אבן העזר', 'Choshen Mishpat': 'חושן משפט' };

/** Each program's place: id -> ev -> { b, t?, r?, a? } (a = an alternative TOC, e.g. the Yerushalmi's Vilna dapim), or null. */
export const PLACES = {
  dafyomi: e => bavli(e.daf.name, e.daf.blatt),
  dirshuamudyomi: e => bavli(e.amud.name, e.amud.amud, e.amud.side),
  // The Vilna dapim are an alternative TOC; a daf may start on its amud ב there
  'yerushalmi-vilna': e => ({ b: 'תלמוד ירושלמי ' + plain(he(e.daf.name)), a: 'Vilna', t: [[`דף ${n(e.daf.blatt)}.`, `דף ${n(e.daf.blatt)}:`]] }),
  // Schottenstein's pages are not in the library: the masechta itself
  'yerushalmi-schottenstein': e => ({ b: 'תלמוד ירושלמי ' + plain(he(e.daf.name)) }),
  mishnayomi: e => mishna(e.mishnaYomi[0].k, e.mishnaYomi[0].v),
  rambam1: e => rambam(e.reading),
  rambam3: e => rambam(e.readings[0]),
  // The Dirshu seifim are the Shulchan Aruch's, not the Mishnah Berurah's: the siman
  dirshudafhalacha: e => ({ b: 'משנה ברורה', t: ['סימן ' + n(first(e.reading.b))] }),
  kitzurshulchanaruch: e => {
    const m = String(e.reading.b).match(/^(\d+):(\d+)$/);
    if (!m) return null;
    const b = 'קיצור שלחן ערוך';
    return { b, t: ['סימן ' + n(m[1])], r: `${b} ${n(m[1])}, ${n(m[2])}` };
  },
  arukhhashulchanyomi: e => {
    const sec = AH[e.reading.k], [s, i] = dot(String(e.reading.v).split('-')[0]);
    return sec ? { b: 'ערוך השולחן', t: [sec, 'סימן ' + n(s)], r: `ערוך השולחן, ${sec}, ${n(s)}, ${n(i)}` } : null;
  },
  chofetzchaim: e => {
    const [base, klal] = CCB[e.reading.k] || [];
    if (!base) return null;
    if (e.reading.b == null) return { b: 'חפץ חיים', r: base };
    if (klal) { const [k, s] = dot(e.reading.b); return { b: 'חפץ חיים', r: `${base}, כלל ${n(k)}${s ? ', ' + n(s) : ''}` }; }
    const i = first(e.reading.b);
    return { b: 'חפץ חיים', r: e.reading.k === 'Tziyurim' ? `${base}, ציור ${n(i)}` : `${base}, ${n(i)}` };
  },
  shemirathalashon: e => {
    const x = e.reading, gate = x.bk === 1 ? SHL[x.k] : null;
    if (x.bk === 1 && !gate) return null;
    const base = ['שמירת הלשון', x.bk === 1 ? 'חלק ראשון' : 'חלק שני', gate].filter(Boolean).join(', ');
    // "13.5" = perek.os (hebcal writes "13.10" as a string, so a number is exact); "3" = a paragraph of the preface
    const [p, i] = dot(String(x.b).replace('Footnote_in_', ''));
    return { b: 'שמירת הלשון', r: Number.isNaN(i) ? `${base}, ${n(p)}` : `${base}, ${n(p)}, ${n(i)}` };
  },
  psalms: e => {
    const [a] = e.reading, [p, v] = String(a).split(':').map(Number);
    return { b: 'תהילים', t: ['פרק ' + n(p)], ...(v ? { r: `תהילים ${n(p)}, ${n(v)}` } : {}) };
  },
  nachyomi: e => ({ b: plain(he(e.k)), t: ['פרק ' + n(e.v)] }),
  tanakhyomi: e => {
    const m = String(e.daf?.verses || '').match(/^(.+?) (\d+):(\d+)/);
    if (!m) return null;
    const b = plain(he(m[1]));
    return { b, t: ['פרק ' + n(m[2])], r: `${b} ${n(m[2])}, ${n(m[3])}` };
  },
  pirkeiavotsummer: e => ({ b: 'משנה אבות', t: ['פרק ' + n(e.reading[0])] }),
  seferhamitzvot: e => {
    const tok = String(e.reading.reading).split(/,\s*/)[0];
    let m;
    if ((m = tok.match(/^([PN])(\d+)/))) {
      const sec = m[1] === 'P' ? 'מצוות עשה' : 'מצוות לא תעשה';
      return { b: 'ספר המצוות', t: [sec], r: `ספר המצוות, ${sec}, ${n(m[2])}` };
    }
    if ((m = tok.match(/^Principle (\d+)/))) return { b: 'ספר המצוות', t: ['שורשים', 'שורש ' + n(m[1])] };
    if ((m = tok.match(/^Laws of Megillah and Chanukah Chapters (\d+)/))) return { b: 'משנה תורה, הלכות מגילה וחנוכה', t: ['פרק ' + n(m[1])] };
    if (/Introduction/.test(tok)) return { b: 'ספר המצוות', t: ['הקדמות', 'הקדמת הרמב"ם'] };
    if (/Nusach HaTefila|Order of Prayer/.test(tok)) return { b: 'משנה תורה, סדר התפילה' };
    if (/Haggadah/.test(tok)) return { b: 'משנה תורה, הלכות חמץ ומצה', t: ['פרק ט'] };
    return null;
  },
  tanyayomi: e => {
    const x = e.reading, part = TANYA[x.book];
    if (!part) return null;
    if (x.section) {
      const sec = TANYA_SEC[x.section];
      return sec ? { b: 'תניא', t: [part, sec] } : { b: 'תניא', t: [part] };
    }
    return { b: 'תניא', t: [part, 'פרק ' + n(x.chap)], r: `תניא, ${part}, ${n(x.chap)}, ${n(x.verse)}` };
  },
};

/** The place of one program's event, or null. */
export function placeOf(id, ev) {
  try { return PLACES[id]?.(ev) || null; } catch { return null; }
}
