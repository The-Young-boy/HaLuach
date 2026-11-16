// "לימוד יומי": the user ticks which daily-learning programs show (every one that @hebcal/learning has).
// Each line: the program, today's portion, and buttons that open it in Otzaria / Zayit (at its place, see learning-places.js).
import '@hebcal/learning';
import { DailyLearning } from '@hebcal/core';
import { h, zmanim, settings, openLayer, ahead } from '../core.js';
import { noNiqqud, he, g, heNums, hdateAt, refRange, hebDate } from './calendar-heb.js';
import { linkButtons, linkCss, shownApps, installedApps, appsReady, APPS } from './learning-links.js';
import { row, toggle, choice, section } from '../ui.js';
import { placeOf } from './learning-places.js';

const latin = s => /[A-Za-z]/.test(s);
const heOr = (s, alt) => { const t = he(s); return latin(t) ? alt : t; };
const r = ev => noNiqqud(ev.render('he'));
const SM = { 'Nusach HaTefila': 'נוסח התפילה', 'Order of Prayer': 'סדר התפילה', 'Text of the Haggadah': 'נוסח ההגדה' };
function seferHaMitzvot(s) {
  return String(s).split(/,\s*/).map(p => {
    let m;
    if ((m = p.match(/^P(\d+)$/))) return 'עשה ' + g(m[1]);
    if ((m = p.match(/^N(\d+)$/))) return 'ל״ת ' + g(m[1]);
    if ((m = p.match(/^Principle (.+)$/))) return 'שורש ' + heNums(m[1]);
    if ((m = p.match(/^Laws of Megillah and Chanukah Chapters (.+)$/))) return 'הלכות מגילה וחנוכה ' + heNums(m[1]);
    if (/Introduction/.test(p)) return 'הקדמת הרמב״ם';
    return SM[p] || p;
  }).join(', ');
}
const daf = e => `${heOr(e.daf.name, r(e))} ${g(e.daf.blatt)}`;

/** Every program: id = the @hebcal/learning calendar; text(ev) = today's portion; qp = a prefix for the search. */
export const ITEMS = [
  { id: 'dafyomi', name: 'דף יומי בבלי', text: daf, qp: 'מסכת', daily: true },
  { id: 'yerushalmi-vilna', name: 'ירושלמי יומי (וילנא)', text: daf, qp: 'ירושלמי' },
  { id: 'yerushalmi-schottenstein', name: 'ירושלמי יומי (שוטנשטיין)', text: daf, qp: 'ירושלמי' },
  { id: 'dirshuamudyomi', name: 'עמוד היומי (דרשו)', text: e => `${heOr(e.amud.name, '')} ${g(e.amud.amud)} ע״${e.amud.side === 'a' ? 'א' : 'ב'}`, qp: 'מסכת' },
  { id: 'mishnayomi', name: 'משנה יומית', qp: 'משנה', text: e => {
    const m = e.mishnaYomi, a = m[0], b = m[m.length - 1];
    return a.k === b.k ? `${heOr(a.k, r(e))} ${refRange(a.v, b.v)}` : `${heOr(a.k, '')} ${heNums(a.v)} - ${heOr(b.k, '')} ${heNums(b.v)}`;
  } },
  { id: 'rambam1', name: 'רמב״ם - פרק ליום', qp: 'רמב"ם', text: e => latin(he(e.reading.name)) ? heNums(r(e)) : `${he(e.reading.name)} פרק ${heNums(String(e.reading.perek))}` },
  { id: 'rambam3', name: 'רמב״ם - 3 פרקים', qp: 'רמב"ם', text: e => e.readings.every(x => !latin(he(x.name))) ? e.readings.map(x => `${he(x.name)} ${heNums(String(x.perek))}`).join(', ') : heNums(r(e)) },
  { id: 'dirshudafhalacha', name: 'דף היומי בהלכה (משנה ברורה)', qp: 'משנה ברורה', text: e => (e.reading.review ? 'חזרה: ' : '') + 'סימן ' + refRange(e.reading.b, e.reading.e) },
  { id: 'kitzurshulchanaruch', name: 'קיצור שולחן ערוך', qp: 'קיצור שולחן ערוך', text: e => 'סימן ' + refRange(e.reading.b, e.reading.e) },
  { id: 'arukhhashulchanyomi', name: 'ערוך השולחן יומי', qp: 'ערוך השולחן', text: e => r(e) },
  { id: 'chofetzchaim', name: 'חפץ חיים יומי', qp: 'חפץ חיים', text: e => heNums(r(e)) },
  { id: 'shemirathalashon', name: 'שמירת הלשון יומי', qp: 'שמירת הלשון', text: e => heNums(r(e).replace('Book II', 'ח״ב').replace('Book I', 'ח״א')) },
  { id: 'psalms', name: 'תהלים לפי ימי החודש', qp: 'תהלים', text: e => refRange(...e.reading) },
  { id: 'nachyomi', name: 'נ״ך יומי', qp: '', text: e => `${heOr(e.k, r(e))} ${g(e.v)}` },
  { id: 'tanakhyomi', name: 'תנ״ך יומי', qp: '', text: e => r(e) },
  { id: 'pirkeiavotsummer', name: 'פרקי אבות (שבתות הקיץ)', qp: 'פרקי אבות', text: e => r(e) },
  { id: 'seferhamitzvot', name: 'ספר המצוות יומי', qp: 'ספר המצוות', text: e => seferHaMitzvot(e.reading.reading) },
  { id: 'tanyayomi', name: 'תניא יומי', qp: 'תניא', text: e => r(e).replace(/^תניא:\s*/, '') },
];
/** The programs in three folds in the settings. */
const GROUPS = [
  ['גמרא ומשנה', ['dafyomi', 'yerushalmi-vilna', 'yerushalmi-schottenstein', 'dirshuamudyomi', 'mishnayomi']],
  ['הלכה ומוסר', ['rambam1', 'rambam3', 'seferhamitzvot', 'dirshudafhalacha', 'kitzurshulchanaruch', 'arukhhashulchanyomi', 'chofetzchaim', 'shemirathalashon']],
  ['תנ״ך, תניא ואבות', ['psalms', 'nachyomi', 'tanakhyomi', 'tanyayomi', 'pirkeiavotsummer']],
];
const DEFAULT_ON = ['dafyomi', 'mishnayomi', 'psalms'];

/** The portions for a Hebrew day: [{ id, name, text, q, daily, place }]. `ids` = the chosen programs. */
export function learningFor(hd, ids = DEFAULT_ON, il = !!settings().loc?.il) {
  const out = [];
  for (const it of ITEMS) {
    if (!ids.includes(it.id)) continue;
    let ev = null;
    try { ev = DailyLearning.lookup(it.id, hd, il); } catch {}
    if (!ev) continue;
    let text;
    try { text = it.text(ev); } catch { text = r(ev); }
    const body = text.replace(/^חזרה: /, '').replace(/^סימן /, '');
    const q = ((it.qp && !body.startsWith(it.qp) ? it.qp + ' ' : '') + body).replace(/[׳״]/g, '').replace(/\s+/g, ' ').trim();
    out.push({ id: it.id, name: it.name, text, q, daily: !!it.daily, place: placeOf(it.id, ev) });
  }
  return out;
}
export function chosenIds(s) { return s.on || DEFAULT_ON; }
/** The widget summary for a Hebrew day. */
export function widgetSummary(hd, ids, il) {
  const daf = learningFor(hd, ['dafyomi'], il)[0];
  const rows = learningFor(hd, ids.filter(id => id !== 'dafyomi'), il).map(it => [it.name, it.text]);
  return { big: daf ? daf.text : '', sub: (daf ? 'דף יומי · ' : '') + hebDate(hd), rows };
}
/** One summary per program for a one-program widget (its "התאמה אישית"): { id: { name, big, sub, rows } }.
 *  The daf always, and the board's chosen programs. A program without a portion today still has its entry. */
export function perSummary(hd, ids, il) {
  const per = {};
  for (const id of ['dafyomi', ...ids.filter(x => x !== 'dafyomi')]) {
    const it = ITEMS.find(x => x.id === id);
    if (!it) continue;
    const p = learningFor(hd, [id], il)[0];
    per[id] = { name: it.name, big: p ? p.text : '', sub: it.name + ' · ' + (p ? hebDate(hd) : 'אין לימוד היום'), rows: [] };
  }
  return per;
}

// "למדתי": { 'y-m-d' (Hebrew): [ids] }, the last 60 days only.
const LKEY = 'haluach.learned';
const hkey = hd => `${hd.getFullYear()}-${hd.getMonth()}-${hd.getDate()}`;
function learned() { try { return JSON.parse(localStorage.getItem(LKEY) || '{}'); } catch { return {}; } }
function setLearned(hd, id, on) {
  const all = learned(), k = hkey(hd);
  const set = new Set(all[k] || []);
  on ? set.add(id) : set.delete(id);
  all[k] = [...set];
  const keys = Object.keys(all);
  if (keys.length > 60) for (const x of keys.slice(0, keys.length - 60)) delete all[x];
  try { localStorage.setItem(LKEY, JSON.stringify(all)); } catch {}
}

/** One `.item` per portion (used by the calendar's day layer too). `today` = Otzaria's daily_page is right for the daf. */
export function learningRows(list, { hd = null, track = false, today = true } = {}) {
  const done = hd ? new Set(learned()[hkey(hd)] || []) : new Set();
  return list.map(it => h('div', { class: 'item lrn' + (done.has(it.id) ? ' done' : '') },
    h('div', { class: 'lrn-t' }, h('div', { class: 'lab' }, it.name), h('div', { class: 'val', title: it.text }, it.text)),
    h('span', { class: 'end lnks' },
      ...linkButtons(it.q, { daily: it.daily && today, place: it.place }),
      track && hd ? h('label', { class: 'lrn-c', title: 'למדתי' }, h('input', { type: 'checkbox', checked: done.has(it.id), onchange: e => {
        setLearned(hd, it.id, e.target.checked); e.target.closest('.lrn').classList.toggle('done', e.target.checked);
      } }), 'למדתי') : null)));
}
const MAX = 6;

export default {
  id: 'learning',
  title: 'לימוד יומי',
  size: [1, 4],
  defaults: { on: DEFAULT_ON, track: false, prefer: '', apps: ['otzaria', 'zayit'], sunsetSwitch: true },
  every: 10 * 60_000,
  async render(el, ctx) {
    const s = ctx.s, now = new Date();
    await appsReady;
    const z = s.sunsetSwitch && settings().loc ? await zmanim(now).catch(() => null) : null;
    const hd = hdateAt(now, z?.sunset);
    const list = learningFor(hd, chosenIds(s));
    if (!list.length) { el.replaceChildren(h('div', { class: 'sub' }, 'לא נבחר לימוד. בחרו בהגדרות הכרטיס.')); return; }
    // At most 6 on the card; the rest in the layer.
    const shown = list.length > MAX ? list.slice(0, MAX - 1) : list;
    el.replaceChildren(...learningRows(shown, { hd, track: s.track }),
      shown.length < list.length ? h('button', { class: 'more', onclick: () => openLayer(body => {
        body.append(h('h2', {}, 'עוד לימוד, ' + hebDate(hd, false)), ...learningRows(list.slice(shown.length), { hd, track: s.track }));
      }) }, `עוד ${list.length - shown.length}`) : '',
      !shownApps().length ? h('div', { class: 'faint lrn-n' }, 'אוצריא וזית לא מותקנות, ולכן אין קישורים.') : '');
  },
  // big = today's daf (always, per SPEC), sub = the Hebrew date, rows = the other chosen programs.
  async widget(ctx) {
    try {
      const s = ctx?.s || {}, now = new Date();
      const z = s.sunsetSwitch !== false && settings().loc ? await zmanim(now).catch(() => null) : null;
      const hd = hdateAt(now, z?.sunset);
      const sw = s.sunsetSwitch !== false;
      const ids = chosenIds(s);
      const at = d => ({ ...widgetSummary(d, ids), per: perSummary(d, ids) });
      return { ...at(hd), ahead: await ahead((t, sunset) => at(hdateAt(t, sw ? sunset : null))) };
    } catch { return { big: '', sub: 'אין נתונים', rows: [] }; }
  },
  // Saved on every change (DESIGN.md "Inner menus"). The programs in three folds, each with how many are on.
  settings(box, ctx) {
    const s = ctx.s, on = new Set(chosenIds(s));
    const put = patch => { ctx.set(patch); ctx.rerender(); };
    for (const [title, ids] of GROUPS) {
      const count = h('span', { class: 'faint' });
      const n = () => { const k = ids.filter(id => on.has(id)).length; count.textContent = k ? `נבחרו: ${k}` : ''; };
      const rows = ITEMS.filter(it => ids.includes(it.id)).flatMap(it => toggle(it.name, on.has(it.id), v => {
        v ? on.add(it.id) : on.delete(it.id); n();
        put({ on: ITEMS.map(i => i.id).filter(id => on.has(id)) });
      }));
      n();
      box.append(h('details', {}, h('summary', {}, title, count), h('div', { class: 'form' }, ...rows)));
    }
    const apps = (s.apps || []).filter(a => installedApps().includes(a));
    box.append(section('בכרטיס'),
      ...toggle('סימון "למדתי"', s.track, v => put({ track: v })),
      ...toggle('אחרי השקיעה, הלימוד של מחר', s.sunsetSwitch, v => put({ sunsetSwitch: v })),
      apps.length > 1 ? row('לפתוח ב', choice([['', 'בשתיהן'], ...apps.map(a => [a, APPS[a]])], apps.includes(s.prefer) ? s.prefer : '', v => put({ prefer: v }))) : '');
  },
};

export const css = linkCss + `
.lrn-t { min-width: 0; }
.lrn.done .val { color: var(--good); }
.lrn-c { display: inline-flex; gap: 3px; align-items: center; font-size: 11px; color: var(--fg3); }
.lrn-n { font-size: 11px; margin-top: 4px; }`;
