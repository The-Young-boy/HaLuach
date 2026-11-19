// "תאריכים אישיים": yahrzeit, birthday (always Hebrew), wedding, and bar/bat mitzva from a birthday with a gender.
// Stored in localStorage 'haluach.personal'. ICS import/export. Listens to 'haluach:add-personal' (the calendar's
// "הוסף אירוע"). upcomingPersonal(days) is for the owner's reminders.
import { HDate, months, gematriyaStrToNum } from '@hebcal/core';
import { h, zmanim, settings, cardSettings, openLayer, ymd, ahead, saveDoc } from '../core.js';
import { g, hebDate, hdateAt, addDays, noon } from './calendar-heb.js';
import { KEY, TYPES, load, store, newId, parseYmd, hebrewOf, occurrences, remindDay, nameLetters, parseICS, guessType, cleanName, toICS } from './personal-calc.js';
import { linkButtons } from './learning-links.js';
import { row, number, choice, more, debounce } from '../ui.js';

export { KEY };
const DEF = { days: 30, adarRule: '' };
const defaultAdar = () => cardSettings('personal', DEF).adarRule || (settings().nusach === 'edot' ? 'adar2' : 'adar1');
const changed = () => window.dispatchEvent(new CustomEvent('haluach:personal-changed'));
let lastCtx = null;

/** For the owner's reminders: the next `days` days. A date on shabbat / yom tov is reminded on the day before. */
export function upcomingPersonal(days = 30, now = new Date()) {
  const il = !!settings().loc?.il;
  return occurrences(load(), noon(now), addDays(now, days)).map(o => ({
    id: o.p.id, type: o.type, name: o.p.name, relation: o.p.relation || '', title: o.title, date: o.date, eve: o.eve,
    hdate: o.hdate, years: o.years, parasha: o.parasha || '', remindOn: remindDay(o.type === 'yahrzeit' ? o.eve : o.date, il),
  }));
}

// ---------- the add / edit form ----------
const HMONTHS = [[7, 'תשרי'], [8, 'חשון'], [9, 'כסלו'], [10, 'טבת'], [11, 'שבט'], [12, 'אדר / אדר א׳'], [13, 'אדר ב׳'], [1, 'ניסן'], [2, 'אייר'], [3, 'סיון'], [4, 'תמוז'], [5, 'אב'], [6, 'אלול']];
function parseYear(s) {
  s = String(s || '').trim();
  if (/^\d+$/.test(s)) { const n = +s; return n < 1000 ? n + 5000 : n; }
  const n = gematriyaStrToNum(s.replace(/["'״׳]/g, '').replace(/^ה(?=ת)/, '')); // ה'תשפ"ה = תשפ"ה
  return n ? (n < 1000 ? n + 5000 : n) : null;
}
/** The add / edit form, one row per field (DESIGN.md "Inner menus"). A new date: "הוספה" at the end. An existing
 *  one: every change is saved at once (no save button), "מחיקה" at the end. Fields that do not apply are hidden:
 *  "קרבה" for a yahrzeit only, bar/bat mitzva for a birthday only, the Adar rule only for Adar of a plain year. */
export function editForm(p = {}) {
  const isNew = !p.id;
  p = { type: 'yahrzeit', name: '', relation: '', gender: '', greg: null, afterSunset: false, adarRule: defaultAdar(), ...p };
  const v = { type: p.type, gender: p.gender, mode: p.greg || !p.hebrew ? 'greg' : 'heb', adarRule: p.adarRule };
  openLayer((body, close) => {
    body.append(h('h2', {}, isNew ? 'תאריך חדש' : 'עריכה'));
    const f = h('div', { class: 'form prs-form' });
    const name = h('input', { type: 'text', value: p.name, placeholder: 'פלוני בן פלוני', 'aria-label': 'שם' });
    const relation = h('input', { type: 'text', value: p.relation, placeholder: 'אבי, סבתי', 'aria-label': 'קרבה' });
    const greg = h('input', { type: 'date', value: p.greg || '', 'aria-label': 'התאריך' });
    const after = h('input', { type: 'checkbox', checked: p.afterSunset, 'aria-label': 'אחרי השקיעה' });
    const hd0 = p.hebrew || null;
    const hday = h('select', { 'aria-label': 'יום' }, ...Array.from({ length: 30 }, (_, i) => h('option', { value: i + 1, selected: hd0?.d === i + 1 }, g(i + 1))));
    const hmon = h('select', { 'aria-label': 'חודש' }, ...HMONTHS.map(([val, l]) => h('option', { value: val, selected: hd0?.m === val }, l)));
    const hyear = h('input', { type: 'text', class: 'n', value: hd0 ? g(hd0.y % 1000) : '', placeholder: 'תשפ״ה', 'aria-label': 'שנה' });
    const shown = h('span', { class: 'hint' });
    const hebrew = () => {
      if (v.mode === 'greg') return greg.value ? hebrewOf(greg.value, after.checked) : null;
      const y = parseYear(hyear.value);
      if (!y) return null;
      let m = +hmon.value;
      if (m === 13 && !HDate.isLeapYear(y)) m = 12;
      const d = Math.min(+hday.value, HDate.daysInMonth(m, y));
      return { d, m, y };
    };
    const entry = () => {
      const x = hebrew();
      if (!name.value.trim() || !x) return null;
      return { id: p.id || newId(), type: v.type, name: name.value.trim(), relation: relation.value.trim(), gender: v.type === 'birthday' ? v.gender : '',
        greg: v.mode === 'greg' ? greg.value : null, afterSunset: v.mode === 'greg' && after.checked, hebrew: x, adarRule: v.adarRule };
    };
    const put = e => { store([...load().filter(x => x.id !== e.id), e]); changed(); };
    const relRow = row('קרבה', relation), genRow = row('בר/בת מצווה', choice([['', 'לא'], ['m', 'בן'], ['f', 'בת']], v.gender, x => { v.gender = x; sync(); }));
    const gregRow = row('התאריך', greg), afterRow = row('אחרי השקיעה', after);
    const hebRow = row('התאריך', h('span', { class: 'prs-heb' }, hday, hmon, hyear));
    // Rows that show by the type and the calendar fold in and out (DESIGN.md "Motion").
    const adarRow = row('בשנה מעוברת', choice([['adar1', 'אדר א׳'], ['adar2', 'אדר ב׳'], ['both', 'שניהם']], v.adarRule, x => { v.adarRule = x; sync(); }), 'נפטר באדר של שנה פשוטה');
    for (const r of [relRow, genRow, gregRow, afterRow, hebRow, adarRow]) r.classList.add('fold');
    const sync = (saveNow = true) => {
      gregRow.hidden = afterRow.hidden = v.mode !== 'greg'; hebRow.hidden = v.mode === 'greg';
      relRow.hidden = v.type !== 'yahrzeit'; genRow.hidden = v.type !== 'birthday';
      const x = hebrew();
      adarRow.hidden = !(v.type === 'yahrzeit' && x && x.m === months.ADAR_I && !HDate.isLeapYear(x.y));
      shown.textContent = x ? hebDate(new HDate(x.d, x.m, x.y)) : '';
      // Editing: saved as it changes (only a whole entry: a name and a date).
      if (!isNew && saveNow) { const e = entry(); if (e) put(e); }
    };
    const later = debounce(() => sync());
    for (const el of [greg, after, hday, hmon]) el.addEventListener('change', () => sync());
    for (const el of [name, relation, hyear]) el.addEventListener('input', () => { sync(false); later(); });
    f.append(
      row('סוג', choice(['yahrzeit', 'birthday', 'wedding'].map(t => [t, TYPES[t]]), v.type, x => { v.type = x; sync(); })),
      row('שם', name), relRow, genRow,
      row(h('span', {}, 'תאריך לפי', shown), choice([['greg', 'לועזי'], ['heb', 'עברי']], v.mode, x => { v.mode = x; sync(); })),
      gregRow, afterRow, hebRow, adarRow);
    const msg = h('span', { class: 'sub' });
    const btns = isNew
      ? h('div', { class: 'prs-btns' }, h('button', { class: 'btn primary', onclick: () => {
        const e = entry();
        if (!e) { msg.textContent = 'חסר שם או תאריך.'; return; }
        put(e); close();
      } }, 'הוספה'), msg)
      : h('div', { class: 'prs-btns' }, h('button', { class: 'btn', onclick: () => { store(load().filter(e => e.id !== p.id)); close(); changed(); } }, 'מחיקה'));
    body.append(f, btns);
    sync(false);
  });
}
window.addEventListener('haluach:add-personal', e => {
  const d = e.detail?.date;
  editForm({ type: 'birthday', greg: d ? (typeof d === 'string' ? d : ymd(d)) : null });
});
window.addEventListener('haluach:personal-changed', () => lastCtx?.rerender());

// ---------- ICS ----------
function importLayer() {
  openLayer((body, close) => {
    body.append(h('h2', {}, 'ייבוא מלוח שנה'), h('p', { class: 'sub' }, 'קובץ מלוח השנה של גוגל או מכל לוח שנה. התאריך הלועזי הופך לעברי (לפני השקיעה).'));
    const file = h('input', { type: 'file', accept: '.ics,text/calendar' });
    const text = h('textarea', { rows: 4, placeholder: 'או הדביקו כאן את תוכן הקובץ' });
    const rows = h('div', { class: 'prs-imp' });
    let items = [];
    const show = src => {
      items = parseICS(src).map(x => ({ ...x, on: true, type: guessType(x.summary), name: cleanName(x.summary) }));
      rows.replaceChildren(...(items.length ? items.map(it => h('div', { class: 'row' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: e => { it.on = e.target.checked; } }), it.name),
        h('span', { class: 'sub' }, it.date),
        h('select', { onchange: e => { it.type = e.target.value; } }, ...['yahrzeit', 'birthday', 'wedding'].map(t => h('option', { value: t, selected: it.type === t }, TYPES[t]))))) : [h('div', { class: 'sub' }, 'לא נמצאו אירועים.')]));
    };
    file.addEventListener('change', async () => { const f = file.files?.[0]; if (f) show(await f.text()); });
    text.addEventListener('input', () => show(text.value));
    body.append(h('div', { class: 'form' }, file, text), rows, h('button', { class: 'btn primary', onclick: () => {
      const add = items.filter(i => i.on).map(i => ({ id: newId(), type: i.type, name: i.name, relation: '', gender: '', greg: i.date, afterSunset: false, hebrew: hebrewOf(i.date, false), adarRule: defaultAdar() }));
      store([...load(), ...add]); close(); changed();
    } }, 'ייבוא'));
  });
}
function exportLayer() {
  const ics = toICS(load());
  openLayer(body => {
    const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    const status = h('span', { class: 'sub' });
    body.append(h('h2', {}, 'ייצוא ללוח שנה'), h('p', { class: 'sub' }, 'המופע הבא של כל תאריך, כאירוע של יום שלם.'),
      h('div', { class: 'prs-btns' },
        h('button', { class: 'btn primary', onclick: async () => { const p = await saveDoc('HaLuach-personal.ics', ics); status.textContent = p ? `נשמר: ${p}` : 'השמירה נכשלה.'; } }, 'שמירה במסמכים'),
        h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(ics).then(() => { status.textContent = 'הועתק.'; }, () => { status.textContent = 'ההעתקה נכשלה.'; }) }, 'העתקה'), status));
  });
}

// ---------- the card ----------
function when(diff) { return diff === 0 ? 'היום' : diff === 1 ? 'מחר' : `בעוד ${diff} ימים`; }
/** The widget summary: the dates from the Hebrew day hdNow on, `days` ahead. */
export function widgetSummary(list, hdNow, now = new Date(), days = 30) {
  const occ = occurrences(list, addDays(now, -1), addDays(now, days)).map(o => ({ o, diff: o.hd.abs() - hdNow.abs() })).filter(x => x.diff >= 0);
  if (!occ.length) return { big: '', sub: `אין תאריכים ב-${days} הימים הקרובים`, rows: [] };
  const short = o => o.hdate.replace(/ \S+$/, '');
  const [first, ...rest] = occ;
  return {
    big: first.o.title,
    sub: `${short(first.o)}, ${when(first.diff)}`,
    rows: rest.map(({ o, diff }) => [o.title, `${short(o)}, ${when(diff)}`, diff === 0]),
  };
}
/** Psalm 119 by the letters: letter i = verses 8i+1 to 8i+8. */
const ALEPH = 'אבגדהוזחטיכלמנסעפצקרשת';
/** The yahrzeit layer: the date, the candle, mishnayot by the letters of the name and נשמה, and the links. */
function yahrzeitLayer(o, tonight) {
  const p = o.p, letters = nameLetters(p.name), nshm = ['נ', 'ש', 'מ', 'ה'];
  const chip = c => { const i = ALEPH.indexOf(c); return h('span', { class: 'chip', title: `תהלים קיט, ${i * 8 + 1}-${i * 8 + 8}` }, c); };
  openLayer(body => {
    body.append(h('h2', {}, p.name + (p.relation ? ' - ' + p.relation : '')),
      h('div', { class: 'row' }, h('span', {}, tonight ? 'הערב מתחיל היארצייט' : 'היום היארצייט'), h('b', {}, o.hdate)),
      h('div', { class: 'row' }, h('span', {}, 'שנים'), h('b', { class: 'num' }, String(o.years))),
      tonight ? h('div', { class: 'sub' }, 'להדליק נר נשמה הערב.') : '');
    if (letters.length) body.append(h('hr', { class: 'sep' }), h('div', { class: 'sub' }, 'משניות לפי אותיות השם ונשמה:'),
      h('div', { class: 'chips prs-let' }, ...letters.map(chip), h('span', { class: 'faint' }, '·'), ...nshm.map(chip)),
      h('div', { class: 'row' }, h('span', {}, 'משניות'), h('span', { class: 'lnks' }, ...linkButtons('משניות לעילוי נשמה'))),
      h('div', { class: 'row' }, h('span', {}, 'תהלים קיט'), h('span', { class: 'lnks' }, ...linkButtons('תהלים קיט', { place: { b: 'תהילים', t: ['פרק קיט'] } }))));
    body.append(h('div', { class: 'prs-btns' }, h('button', { class: 'btn', onclick: () => editForm(p) }, 'עריכה')));
  });
}
/** A div that acts as a button: click, Enter and Space (only on the div itself, not on a button inside it). */
const tapKeys = fn => ({ role: 'button', tabindex: 0, onclick: fn,
  onkeydown: e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn(); } } });
function yahrzeitItem(o, tonight) {
  const p = o.p;
  return h('div', { class: 'item prs-it prs-now', ...tapKeys(() => yahrzeitLayer(o, tonight)), title: 'פירוט' },
    h('div', { class: 'prs-t' }, h('div', { class: 'lab' }, tonight ? 'הערב היארצייט, להדליק נר' : 'היום היארצייט'),
      h('div', { class: 'val' }, p.name + (p.relation ? ' - ' + p.relation : ''))),
    h('button', { class: 'link end', onclick: e => { e.stopPropagation(); yahrzeitLayer(o, tonight); } }, 'משניות'));
}
/** One upcoming date as an `.item`: the Hebrew date and "in N days" above, the title below. Click = edit. */
function dateItem(o, diff, inLayer = false) {
  const it = h('div', { class: 'item prs-it' + (diff === 0 ? ' prs-now' : '') },
    h('div', { class: 'prs-t' }, h('div', { class: 'lab' }, `${o.hdate.replace(/ \S+$/, '')}, ${when(diff)}`),
      h('div', { class: 'val' }, o.title, o.parasha ? h('span', { class: 'faint prs-par' }, ' ' + o.parasha) : '')));
  if (inLayer) return h('button', { onclick: () => editForm(o.p), title: 'עריכה' }, it);
  const t = tapKeys(() => editForm(o.p));
  it.setAttribute('role', t.role); it.tabIndex = 0; it.title = 'עריכה';
  it.addEventListener('click', t.onclick); it.addEventListener('keydown', t.onkeydown);
  return it;
}
const MAX = 5;
/** Every date of the coming year, and add / import / export. */
function allLayer() {
  const list = load(), now = new Date();
  openLayer(body => {
    body.append(h('h2', {}, 'תאריכים אישיים'));
    const today = new HDate(noon(now));
    const seen = new Set();
    const occ = occurrences(list, addDays(now, -1), addDays(now, 385)).map(o => ({ o, diff: o.hd.abs() - today.abs() }))
      .filter(x => x.diff >= 0 && !seen.has(x.o.p.id + x.o.type) && seen.add(x.o.p.id + x.o.type));
    body.append(occ.length ? h('div', { class: 'list' }, ...occ.map(({ o, diff }) => dateItem(o, diff, true))) : h('div', { class: 'sub' }, 'אין עדיין תאריכים.'),
      actions());
  });
}
const actions = () => h('div', { class: 'prs-btns' },
  h('button', { class: 'btn primary', onclick: () => editForm() }, 'הוספה'),
  h('button', { class: 'btn', onclick: importLayer }, 'ייבוא'),
  load().length ? h('button', { class: 'btn', onclick: exportLayer }, 'ייצוא') : '');

export default {
  id: 'personal',
  title: 'תאריכים אישיים',
  size: [1, 4],
  defaults: DEF,
  every: 30 * 60_000,
  async render(el, ctx) {
    lastCtx = ctx;
    const list = load(), now = new Date();
    if (!list.length) {
      el.replaceChildren(h('div', { class: 'sub' }, 'יארצייט, ימי הולדת עבריים, ימי נישואין ובר/בת מצווה.'), h('button', { class: 'btn pod-empty', onclick: () => editForm() }, 'הוספת תאריך'));
      return;
    }
    const z = settings().loc ? await zmanim(now).catch(() => null) : null;
    const hdNow = hdateAt(now, z?.sunset), today = new HDate(noon(now));
    const days = ctx.s.days || 30;
    const occ = occurrences(list, addDays(now, -1), addDays(now, days));
    const kids = [];
    for (const o of occ) {
      if (o.type !== 'yahrzeit') continue;
      if (o.hd.abs() === hdNow.abs()) kids.push(yahrzeitItem(o, false));
      else if (o.hd.abs() === today.abs() + 1 && hdNow.abs() === today.abs()) kids.push(yahrzeitItem(o, true));
    }
    let next = occ.map(o => ({ o, diff: o.hd.abs() - hdNow.abs() })).filter(x => x.diff >= 0);
    // Nothing in the window: the nearest dates of the year anyway (an empty card most of the year helps nobody).
    if (!next.length) next = occurrences(list, addDays(now, -1), addDays(now, 385)).map(o => ({ o, diff: o.hd.abs() - hdNow.abs() })).filter(x => x.diff >= 0);
    for (const { o, diff } of next.slice(0, Math.max(3, MAX - kids.length))) kids.push(dateItem(o, diff));
    el.replaceChildren(...kids, h('button', { class: 'more', onclick: allLayer }, 'כל התאריכים'));
  },
  // big = the nearest date's title, sub = its Hebrew date and "in N days", rows = the ones after it.
  async widget(ctx) {
    try {
      const now = new Date(), list = load();
      if (!list.length) return { big: '', sub: 'אין תאריכים אישיים', rows: [], empty: true };
      const z = settings().loc ? await zmanim(now).catch(() => null) : null;
      // Nothing in the window: the nearest dates of the year anyway, as the card does.
      const at = (t, sunset) => {
        const hd = hdateAt(t, sunset), sum = widgetSummary(list, hd, t, ctx?.s?.days || 30);
        const all = sum.big || sum.rows?.length ? sum : widgetSummary(list, hd, t, 385);
        // One summary per person/date, for a widget set (התאמה אישית) to one of them: its next date in the year.
        all.per = Object.fromEntries(list.map(e => [e.id, { name: e.name + (e.relation ? ` (${e.relation})` : ''), ...widgetSummary([e], hd, t, 385) }]));
        return all;
      };
      return { ...at(now, z?.sunset), ahead: await ahead(at) };
    } catch { return { big: '', sub: 'אין נתונים', rows: [] }; }
  },
  // Saved on every change (DESIGN.md "Inner menus"). The dates themselves are in the card ("כל התאריכים").
  settings(box, ctx) {
    const put = patch => { ctx.set(patch); ctx.rerender(); };
    box.append(
      row('להציג קדימה', number(ctx.s.days || 30, 'ימים', v => put({ days: Math.max(7, v || 30) }), { min: 7, max: 400 })),
      row('התאריכים', h('button', { class: 'link', onclick: allLayer }, 'כל התאריכים')),
      more(row('יארצייט באדר בשנה מעוברת', choice([['', 'לפי הנוסח'], ['adar1', 'אדר א׳'], ['adar2', 'אדר ב׳'], ['both', 'שניהם']], ctx.s.adarRule || '', v => put({ adarRule: v })),
        'לפי הנוסח: אשכנז וספרד אדר א׳, עדות המזרח אדר ב׳')));
  },
};

export const css = `.prs-form [hidden] { display: none !important; }
.prs-btns { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 12px; }
.prs-btns a.btn { display: inline-flex; align-items: center; text-decoration: none; color: inherit; }
.prs-btns a.btn.primary { color: var(--on-accent); }
.prs-it { cursor: pointer; }
.prs-t { min-width: 0; }
.prs-now .lab { color: var(--accent); }
.prs-par { font-weight: 400; font-size: 12px; }
.prs-let { margin: 6px 0; }
.prs-heb { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.prs-form > .srow > input[type=text] { flex: 1; min-width: 0; max-width: 220px; }
.prs-imp { display: grid; gap: 2px; margin: 8px 0; }`;
