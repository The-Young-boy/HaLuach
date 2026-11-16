// "ספירת העומר": tonight's (or today's) count in short and the day's sefira; a button opens the layer with the full
// text in the user's nusach (settings().nusach). "ספרתי" per day in localStorage. Hidden by default outside the omer.
import { HDate, OmerEvent, months } from '@hebcal/core';
import { h, hm, zmanim, settings, cardSettings, openLayer } from '../core.js';
import { noNiqqud, g, addDays } from './calendar-heb.js';

// ---------- the count ----------
const UNITS = ['', 'אחד', 'שנים', 'שלשה', 'ארבעה', 'חמשה', 'ששה', 'שבעה', 'שמונה', 'תשעה'];
const TENS = ['', 'עשרה', 'עשרים', 'שלשים', 'ארבעים'];
const DAYS_N = ['', 'יום אחד', 'שני ימים', 'שלשה ימים', 'ארבעה ימים', 'חמשה ימים', 'ששה ימים', 'שבעה ימים', 'שמונה ימים', 'תשעה ימים', 'עשרה ימים'];
const WEEKS = ['', 'שבוע אחד', 'שני שבועות', 'שלשה שבועות', 'ארבעה שבועות', 'חמשה שבועות', 'ששה שבועות', 'שבעה שבועות'];
const REST = ['', 'ויום אחד', 'ושני ימים', 'ושלשה ימים', 'וארבעה ימים', 'וחמשה ימים', 'וששה ימים'];

/** "שלשה ושלשים יום" (אשכנז, ספרד) or "שלשים ושלשה יום" (עדות המזרח). */
function daysWords(n, nusach) {
  if (n <= 10) return DAYS_N[n];
  if (n < 20) return (n === 12 ? 'שנים' : UNITS[n - 10]) + ' עשר יום';
  const t = TENS[Math.floor(n / 10)], u = UNITS[n % 10];
  if (!u) return t + ' יום';
  return (nusach === 'edot' ? `${t} ו${u}` : `${u} ו${t}`) + ' יום';
}
/** The count sentence. אשכנז: "...ימים, שהם...,  לעומר"; ספרד: "בעומר"; עדות המזרח: "...ימים לעומר, שהם...". */
export function countText(day, nusach = 'ashkenaz') {
  const word = nusach === 'sfarad' ? 'בעומר' : 'לעומר';
  const d = daysWords(day, nusach), w = Math.floor(day / 7), r = day % 7;
  if (day < 7) return `היום ${d} ${word}.`;
  const weeks = WEEKS[w] + (r ? ' ' + REST[r] : '');
  return nusach === 'edot' ? `היום ${d} ${word}, שהם ${weeks}.` : `היום ${d}, שהם ${weeks}, ${word}.`;
}

/** The omer at `date` (civil); afterTzeit = the evening's count (tomorrow's Hebrew day). null outside the omer. */
export function omerToday(date = new Date(), afterTzeit = false) {
  let hd = new HDate(date);
  if (afterTzeit) hd = hd.next();
  const day = hd.abs() - new HDate(15, months.NISAN, hd.getFullYear()).abs();
  if (day < 1 || day > 49) return null;
  const ev = new OmerEvent(hd, day);
  return {
    day, year: hd.getFullYear(), hd,
    short: `${g(day)} לעומר`,
    weeks: Math.floor(day / 7), rest: day % 7,
    sefira: noNiqqud(ev.sefira('he')),
    text: countText(day, settings().nusach || 'ashkenaz'),
  };
}
/** Days until the omer starts (the night of 16 Nisan), from a civil date. */
export function daysToOmer(date = new Date()) {
  const hd = new HDate(date);
  let y = hd.getFullYear();
  if (hd.abs() > new HDate(15, months.NISAN, y).abs() + 49) y++;
  return new HDate(15, months.NISAN, y).abs() - hd.abs();
}

// "ספרתי": { [Hebrew year]: [days] }.
const KEY = 'haluach.omer';
function store() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } }
export function counted(year, day) { return (store()[year] || []).includes(day); }
export function setCounted(year, day, on = true) {
  const all = store(), set = new Set(all[year] || []);
  on ? set.add(day) : set.delete(day);
  for (const y of Object.keys(all)) if (+y < year - 1) delete all[y];
  all[year] = [...set].sort((a, b) => a - b);
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch {}
  // The plan's "count without a bracha" alert depends on this mark (planner.js listens).
  globalThis.dispatchEvent?.(new Event('haluach:plan-changed'));
}

// ---------- the full text (layer) ----------
const BRACHA = 'ברוך אתה ה\' אלקינו מלך העולם, אשר קדשנו במצותיו, וצונו על ספירת העומר.';
const LESHEM = 'לשם יחוד קודשא בריך הוא ושכינתיה, בדחילו ורחימו, ליחד שם י"ה בו"ה ביחודא שלים, בשם כל ישראל. הנני מוכן ומזומן לקיים מצות עשה של ספירת העומר, כמו שכתוב בתורה: וספרתם לכם ממחרת השבת, מיום הביאכם את עומר התנופה, שבע שבתות תמימת תהיינה. עד ממחרת השבת השביעת תספרו חמשים יום, והקרבתם מנחה חדשה לה\'. ויהי נעם ה\' אלקינו עלינו, ומעשה ידינו כוננה עלינו, ומעשה ידינו כוננהו.';
const HARACHAMAN = 'הרחמן הוא יחזיר לנו עבודת בית המקדש למקומה, במהרה בימינו, אמן סלה.';
const LAMNATZEACH = 'למנצח בנגינת מזמור שיר. אלקים יחננו ויברכנו, יאר פניו אתנו סלה. לדעת בארץ דרכך, בכל גוים ישועתך. יודוך עמים אלקים, יודוך עמים כלם. ישמחו וירננו לאמים, כי תשפט עמים מישר, ולאמים בארץ תנחם סלה. יודוך עמים אלקים, יודוך עמים כלם. ארץ נתנה יבולה, יברכנו אלקים אלקינו. יברכנו אלקים, וייראו אותו כל אפסי ארץ.';
const ANA = ['אנא בכח גדלת ימינך תתיר צרורה.', 'קבל רנת עמך שגבנו טהרנו נורא.', 'נא גבור דורשי יחודך כבבת שמרם.', 'ברכם טהרם רחמי צדקתך תמיד גמלם.', 'חסין קדוש ברוב טובך נהל עדתך.', 'יחיד גאה לעמך פנה זוכרי קדשתך.', 'שועתנו קבל ושמע צעקתנו יודע תעלומות.'];
const BSKM = 'ברוך שם כבוד מלכותו לעולם ועד.';
const ribono = sefira => `רבונו של עולם, אתה צויתנו על ידי משה עבדך לספור ספירת העומר, כדי לטהרנו מקליפותינו ומטומאותינו, כמו שכתבת בתורתך: וספרתם לכם ממחרת השבת, מיום הביאכם את עומר התנופה, שבע שבתות תמימת תהיינה. עד ממחרת השבת השביעת תספרו חמשים יום. כדי שיטהרו נפשות עמך ישראל מזוהמתם. ובכן יהי רצון מלפניך ה' אלקינו ואלקי אבותינו, שבזכות ספירת העומר שספרתי היום, יתוקן מה שפגמתי בספירה ${sefira}, ואטהר ואתקדש בקדושה של מעלה, ועל ידי זה יושפע שפע רב בכל העולמות, ולתקן את נפשותינו ורוחותינו ונשמותינו מכל סיג ופגם, ולטהרנו ולקדשנו בקדושתך העליונה, אמן סלה.`;

export function openText(o) {
  const nusach = settings().nusach || 'ashkenaz';
  openLayer(body => {
    const week = Math.floor((o.day - 1) / 7);
    body.append(h('h2', {}, `ספירת העומר - ${o.short}`), h('div', { class: 'omr-txt' },
      nusach !== 'ashkenaz' ? h('p', { class: 'sub' }, LESHEM) : '',
      h('p', {}, BRACHA),
      h('p', { class: 'omr-count' }, o.text),
      h('p', {}, HARACHAMAN),
      h('p', {}, LAMNATZEACH),
      h('p', {}, ...ANA.map((l, i) => h('span', { class: i === week ? 'omr-week' : '' }, l + ' ')), h('span', { class: 'sub' }, BSKM)),
      h('p', {}, ribono(o.sefira))));
  });
}

// ---------- the card ----------
function inSeason(date = new Date()) { return !!(omerToday(date, false) || omerToday(date, true)); }

export default {
  id: 'omer',
  title: 'ספירת העומר',
  size: [1, 2],
  hiddenByDefault: false,
  // On the board only from a week before the Omer to its end (the user's on/off still wins).
  season: () => inSeason() || daysToOmer(new Date()) <= 7,
  defaults: {},
  every: 5 * 60_000,
  async render(el, ctx) {
    const now = new Date();
    const z = settings().loc ? await zmanim(now).catch(() => null) : null;
    const tz = z?.[cardSettings('zmanim').method?.tzeit || 'tzeit_6_45'];
    const night = tz ? now >= tz : now.getHours() >= 18;
    const beforeNight = z?.sunset && now >= z.sunset && !night; // between sunset and tzeit: tonight's count is next
    const o = omerToday(now, night || beforeNight);
    if (!o) {
      el.replaceChildren(h('div', { class: 'sub' }, `ספירת העומר מתחילה בליל ט״ז בניסן, בעוד ${daysToOmer(now)} ימים.`));
      return;
    }
    const done = counted(o.year, o.day);
    const check = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
    const btn = h('button', { class: 'btn omr-btn' + (done ? '' : ' primary'), onclick: () => { setCounted(o.year, o.day, !done); ctx.rerender(); } },
      done ? h('span', { html: check, class: 'omr-ic' }) : '', 'ספרתי');
    const hint = done ? '' : beforeNight ? h('span', {}, 'סופרים בצאת הכוכבים, ', h('span', { class: 'num' }, hm(tz))) : !night ? 'לא ספרתם בלילה? סופרים ביום בלי ברכה.' : '';
    el.replaceChildren(
      h('div', { class: 'omr-head' }, h('div', { class: 'big' }, g(o.day)),
        h('div', { class: 'omr-t' }, h('div', {}, o.text.replace(/^היום /, '').replace(/\.$/, '')), h('div', { class: 'sub' }, o.sefira))),
      hint ? h('div', { class: 'faint omr-hint' }, hint) : '',
      h('div', { class: 'omr-btns' }, btn, h('button', { class: 'more', onclick: () => openText(o) }, 'הנוסח המלא')));
  },
};

export const css = `.omr-head { display: flex; gap: 12px; align-items: center; }
.omr-t { min-width: 0; font-size: 13px; }
.omr-hint { font-size: 12px; margin-top: 4px; }
.omr-btns { display: flex; gap: 14px; align-items: center; margin-top: 8px; }
.omr-btns .more { margin-top: 0; }
.omr-btn { display: inline-flex; align-items: center; gap: 6px; }
.omr-ic { display: inline-flex; }
.omr-txt p { margin: 0 0 10px; line-height: 1.7; }
.omr-count { font-weight: 600; }
.omr-week { color: var(--accent); font-weight: 600; }`;
