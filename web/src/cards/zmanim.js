// "זמני היום": a sun arc with the times on it, then the list. Every time and every method is the user's choice
// (the method lists follow עתים לבינה, research/itim). The engine is in Rust (src/zmanim.rs, /board/zmanim).
import { h, hm, zmanText, zmanim, settings, openLayer, noPlace, ahead } from '../core.js';
import { HDate } from '@hebcal/core';
import { row, toggle, number, numbers, select, more } from '../ui.js';

/** Each time: its name and the methods that can show it (id in the engine, label). The first method is the default. */
export const TIMES = [
  { id: 'alot', round: 'sec', name: 'עלות השחר', m: [['alot_90deg', '90 במעלות'], ['alot_72deg', '72 במעלות'], ['alot_90zm', '90 בזמניות'], ['alot_72zm', '72 בזמניות'], ['alot_90fix', '90 שוות'], ['alot_72fix', '72 שוות'], ['alot_120deg', '120 במעלות'], ['alot_18', '18 מעלות'], ['alot_16_1', '16.1 מעלות']] },
  { id: 'misheyakir', round: 'up', name: 'זמן ציצית ותפילין', m: [['misheyakir_11_5', '11.5 מעלות'], ['misheyakir_13_5', '13.5 מעלות'], ['misheyakir_11', '11 מעלות'], ['misheyakir_10_5', '10.5 מעלות'], ['misheyakir_10_2', '10.2 מעלות']] },
  { id: 'netz', round: 'sec', name: 'הנץ', m: [['sunrise', 'מישור'], ['sunrise_elev', 'מהגובה'], ['sunrise_vis', 'הנראה']] },
  { id: 'shma_mga', round: 'down', name: 'סוזק"ש מג"א', m: [['shma_mga_chumra', 'לחומרא (90 עד 6.45°)'], ['shma_mga90', '90 במעלות'], ['shma_mga72', '72 במעלות']] },
  { id: 'shma_gra', round: 'down', name: 'סוזק"ש גר"א', m: [['shma_gra', 'גר"א']] },
  { id: 'tefila_mga', round: 'down', name: 'סוזת"פ מג"א', m: [['tefila_mga_chumra', 'לחומרא (90 עד 6.45°)'], ['tefila_mga90', '90 במעלות'], ['tefila_mga72', '72 במעלות']] },
  { id: 'tefila_gra', round: 'down', name: 'סוזת"פ גר"א', m: [['tefila_gra', 'גר"א']] },
  { id: 'chatzot', round: 'sec', name: 'חצות היום', m: [['chatzot', 'האמיתי']] },
  { id: 'mincha_gedola', round: 'up', name: 'מנחה גדולה', m: [['mincha_gedola_30', 'חצי שעה אחר חצות'], ['mincha_gedola_gra', 'גר"א']] },
  { id: 'mincha_ketana', round: 'up', name: 'מנחה קטנה', m: [['mincha_ketana_gra', 'גר"א']] },
  { id: 'plag', round: 'sec', name: 'פלג המנחה', m: [['plag_gra', 'גר"א'], ['plag_mga_chumra', 'לחומרא']] },
  { id: 'shkia', round: 'sec', name: 'שקיעה', m: [['sunset', 'מישור'], ['sunset_elev', 'מהגובה'], ['sunset_vis', 'הנראית']] },
  { id: 'tzeit', round: 'up', name: 'צאת הכוכבים', m: [['tzeit_6_45', '6.45 מעלות'], ['tzeit_8_5', '8.5 מעלות'], ['tzeit_9_28', 'חזו"א, 9.28 מעלות'], ['tzeit_7_083', '7.083 מעלות'], ['tzeit_geonim_18deg', 'גאונים, 18 במעלות'], ['tzeit_20fix', '20 דק\' שוות']] },
  { id: 'rt', round: 'up', name: 'רבנו תם', m: [['rt_72deg', '72 במעלות'], ['rt_72fix', '72 שוות'], ['rt_72zm', '72 בזמניות'], ['rt_90deg', '90 במעלות']] },
  { id: 'chatzot_night', round: 'sec', name: 'חצות הלילה', m: [['chatzot_night', 'האמיתי']] },
];
/** How a time is rounded when shown (zmanText): by its id. */
export const roundOf = id => TIMES.find(t => t.id === id)?.round || 'sec';
/** "בניכוי N ק"מ" for the visible sunrise/sunset: עתים לבינה's default per city (research/itim); elsewhere 2 km. */
const VIS_KM = [['ירושלים', 25], ['בני ברק', 1], ['בית שמש', 40], ['ביתר', 20], ['מודיעין עילית', 40], ['אלעד', 2], ['חיפה', 2], ['טבריה', 2], ['אשדוד', 5], ['צפת', 10], ['באר שבע', 3]];
export function visKm(s = {}, loc = settings().loc) {
  if (s.visKm != null) return s.visKm;
  return VIS_KM.find(([c]) => (loc?.name || '').includes(c))?.[1] ?? 2;
}
/** The times in three folds in the settings. */
const GROUPS = [['בוקר', ['alot', 'misheyakir', 'netz', 'shma_mga', 'shma_gra', 'tefila_mga', 'tefila_gra']], ['צהריים', ['chatzot', 'mincha_gedola', 'mincha_ketana', 'plag']], ['ערב ולילה', ['shkia', 'tzeit', 'rt', 'chatzot_night']]];
const DEFAULT_ON = ['alot', 'misheyakir', 'netz', 'shma_mga', 'shma_gra', 'tefila_gra', 'chatzot', 'mincha_gedola', 'plag', 'shkia', 'tzeit', 'rt'];

/** The user's choice per time: { on: bool, method: engine id }. */
/** The reminders in effect: saved per time, or, when the wizard's "before sof zman shma and tefila" is on and
 *  nothing was saved yet, 15 minutes before each shma / tefila time the user shows (the settings show this, editable). */
export function remindersOf(s) {
  if (s.remind) return s.remind;
  if (!(settings().notify || {}).zmanim) return {};
  return Object.fromEntries(chosen(s).filter(t => t.on && /^(shma|tefila)_/.test(t.id)).map(t => [t.id, [15]]));
}
export function chosen(s) {
  return TIMES.map(t => ({ ...t, on: s.on?.[t.id] ?? DEFAULT_ON.includes(t.id), method: s.method?.[t.id] || t.m[0][0] }));
}

function arc(z, now) {
  // The sun's path from sunrise to sunset as a half ellipse; the marks are the chosen times inside the day.
  const r = z.sunrise, s = z.sunset;
  if (!r || !s) return null;
  const W = 300, H = 70, pad = 10;
  const x = t => pad + (W - 2 * pad) * (1 - (t - r) / (s - r)); // RTL: morning on the right
  const y = t => { const f = (t - r) / (s - r); return H - 6 - (H - 16) * Math.sin(Math.PI * Math.min(1, Math.max(0, f))); };
  const day = now >= r && now <= s;
  const sun = day ? `<circle cx="${x(now)}" cy="${y(now)}" r="7" fill="var(--hi)"/>` : '';
  return h('svg', { viewBox: `0 0 ${W} ${H}`, class: 'arc', width: '100%', height: H, 'aria-hidden': true,
    html: `<path d="M${pad} ${H - 6} Q ${W / 2} ${-H + 30} ${W - pad} ${H - 6}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="3 4"/>
           <line x1="0" x2="${W}" y1="${H - 6}" y2="${H - 6}" stroke="currentColor" stroke-opacity=".2"/>${sun}` });
}

export default {
  id: 'zmanim',
  needsLoc: true,
  title: 'זמני היום',
  size: [1, 5],
  defaults: { secs: false },
  every: 30_000,
  async render(el, ctx) {
    if (!settings().loc) { el.replaceChildren(noPlace()); return; }
    const now = Date.now();
    const of = z => chosen(ctx.s).filter(t => t.on).map(t => ({ ...t, at: z?.[t.method] })).filter(t => t.at);
    let z = await zmanim(new Date()), list = of(z), tomorrow = false;
    // Once the last chosen time of today has passed, tomorrow's times (a list of past times helps nobody at night).
    if (list.length && list.every(t => t.at < now)) {
      const zt = await zmanim(new Date(now + 86400_000));
      if (zt) { z = zt; list = of(zt); tomorrow = true; }
    }
    const next = list.find(t => t.at > now);
    // Halachic hours (SPEC "שעות זמניות"): the length of today's hour by the Gra (sunrise to sunset) and the Magen
    // Avraham (72 minutes before and after), and which hour of the day it is now.
    let hours = '';
    const zt0 = tomorrow ? null : z;
    if (zt0?.sunrise && zt0?.sunset) {
      const len = (zt0.sunset - zt0.sunrise) / 12, lenMa = len + 144 * 60_000 / 12;
      const mm = ms => { const m = Math.round(ms / 60_000); return `${m} דק׳`; };
      const nowH = now >= zt0.sunrise && now < zt0.sunset ? Math.floor((now - zt0.sunrise) / len) + 1 : 0;
      hours = h('div', { class: 'sub zm-hours' }, `שעה זמנית ${mm(len)} (מג״א ${mm(lenMa)})`, nowH ? ` · עכשיו שעה ${['', 'ראשונה', 'שנייה', 'שלישית', 'רביעית', 'חמישית', 'שישית', 'שביעית', 'שמינית', 'תשיעית', 'עשירית', 'אחת עשרה', 'שתים עשרה'][nowH]}` : '');
    }
    // The sun's arc is in the "now" strip; here only the list. Every method of every time: "כל הזמנים".
    el.replaceChildren(
      tomorrow ? h('div', { class: 'sub' }, 'מחר, ' + new Date(now + 86400_000).toLocaleDateString('he-IL', { weekday: 'long' })) : '',
      hours,
      ...list.map(t => h('div', { class: 'row' + (t.at < now ? ' past' : '') + (t === next ? ' next' : ''), title: t.m.find(m => m[0] === t.method)?.[1] || '' },
        h('span', {}, t.name), h('b', { class: 'num' }, zmanText(t.at, t.round, ctx.s.secs)))),
      h('button', { class: 'more', onclick: () => openLayer(body => {
        body.append(h('h2', {}, tomorrow ? 'כל הזמנים מחר' : 'כל הזמנים היום'));
        for (const t of TIMES) {
          const rows = t.m.filter(([id]) => z[id]).map(([id, label]) => h('div', { class: 'row' + (id === chosen(ctx.s).find(c => c.id === t.id)?.method ? ' next' : '') },
            h('span', {}, label), h('b', { class: 'num' }, hm(z[id], true))));
          if (rows.length) body.append(h('h3', {}, t.name), ...rows);
        }
      }) }, 'כל הזמנים'),
    );
  },
  // The compact card: the day at a glance (the "now" strip above already counts down to the next time, so not that
  // again): the chosen times that matter most, in one line, the passed ones faint.
  async compact(ctx) {
    if (!settings().loc) return { sub: 'בחרו מיקום בהגדרות.' };
    const now = Date.now();
    let z = await zmanim(new Date()), tomorrow = false;
    const on = chosen(ctx.s).filter(t => t.on && z?.[t.method]);
    if (on.length && on.every(t => z[t.method] < now)) { z = await zmanim(new Date(now + 86400_000)); tomorrow = true; }
    const key = ['netz', 'shma_mga', 'shma_gra', 'tefila_gra', 'shkia', 'tzeit'];
    const list = chosen(ctx.s).filter(t => t.on && key.includes(t.id) && z?.[t.method]);
    return { line: list.map(t => ({ name: t.name.replace('סוזק"ש', 'ק"ש').replace('סוזת"פ', 'תפילה'), at: zmanText(z[t.method], t.round), past: z[t.method] < now })), sub: tomorrow ? 'מחר' : '' };
  },
  // The widget computes the times itself (Rust); it needs only the Hebrew date from here (changes at sunset).
  async widget() {
    const z = settings().loc ? await zmanim(new Date()) : null;
    const at = (t, sunset) => {
      let hd = new HDate(t);
      if (sunset && t > sunset) hd = hd.next();
      return { hdate: hd.renderGematriya(true).replace(/[֑-ׇ]/g, '') };
    };
    // Sent ahead for the week (core.js ahead()): the date moves on at sunset with the board closed.
    return { ...at(new Date(), z?.sunset), ahead: await ahead(at) };
  },
  // One row per time: its switch; while on, under it, the method (when there is a choice) and the reminders.
  // Saved on every change (DESIGN.md "Inner menus").
  settings(box, ctx) {
    const s0 = ctx.s;
    const put = patch => { ctx.set(patch); ctx.rerender(); };
    const timeRows = t => {
      // One line under the time: the method (when there is a choice) and the reminder, side by side.
      const rem = numbers(remindersOf(s0)[t.id], 'דק׳ לפני', list => {
        const remind = { ...remindersOf(ctx.s) };
        if (list.length) remind[t.id] = list; else delete remind[t.id];
        put({ remind });
      }, { min: 1, max: 600 });
      rem.title = 'תזכורת: דקות לפני הזמן (אפשר כמה: 30, 10)';
      // The empty box says what it is (no label: the board is narrow).
      Object.assign(rem.querySelector('input'), { placeholder: 'תזכורת' }).style.width = '76px';
      const line = h('div', { class: 'srow zm-sub' },
        t.m.length > 1 ? select(t.m, t.method, v => put({ method: { ...(ctx.s.method || {}), [t.id]: v } })) : h('span', { class: 'hint' }, t.m[0][1]),
        h('span', { class: 'zm-rem' }, rem));
      return toggle(t.name, t.on, v => put({ on: { ...(ctx.s.on || {}), [t.id]: v } }), '', [line]);
    };
    const all = chosen(s0);
    for (const [title, ids] of GROUPS) {
      const list = all.filter(t => ids.includes(t.id));
      const count = h('span', { class: 'faint' });
      const n = () => { count.textContent = list.filter(t => ctx.s.on?.[t.id] ?? DEFAULT_ON.includes(t.id)).length + ' מתוך ' + list.length; };
      const g = h('details', { class: 'zm-g' }, h('summary', {}, title, count), h('div', { class: 'form' }, ...list.flatMap(timeRows)));
      g.addEventListener('change', n);
      n();
      box.append(g);
    }
    box.append(h('div', { class: 'hint' }, 'בשבת ובחג לא יוצאת תזכורת'),
      more(
        toggle('להציג שניות', s0.secs, v => put({ secs: v })),
        row('נץ ושקיעה הנראים: בניכוי', number(visKm(s0), 'ק״מ', v => put({ visKm: v }), { max: 60 }), 'בפעם הראשונה החישוב לוקח כמה דקות')));
  },
};
