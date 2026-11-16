// "צבע אדום": the provider polls Pikud HaOref (src/redalert.rs) and decides what goes out; this card shows the
// state and holds the user's rules. Turning it on also turns on the StartupTask, so it works after sign-in
// with the board closed.
// Tzofar's towns and their seconds to shelter (research/towns-shelter.json, fetched 15.11.26 from an Israeli connection).
import TOWNS from '../../../research/towns-shelter.json';
import { h, proxied } from '../core.js';
import { row, toggle, number, choice, section, more } from '../ui.js';

// A switch whose grey hint sits under its label (not between the label and the switch).
const sw = (label, value, on, hint, deps) => toggle(hint ? h('span', {}, label, h('span', { class: 'hint' }, hint)) : label, value, on, '', deps);

const X_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
const PLAY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M5 3.5v9l7-4.5z"/></svg>';
const KINDS = [['missiles', 'טילים ורקטות'], ['aircraft', 'כלי טיס עוין'], ['early', 'התרעה מוקדמת'], ['end', 'האירוע הסתיים'], ['quake', 'רעידת אדמה'], ['tsunami', 'צונאמי'], ['hazmat', 'חומרים מסוכנים']];
const SOUNDS = [['builtin', 'צליל הלוח'], ['oref', 'צליל רשמי (התראה מוקדמת)'], ['windows', 'צליל אזעקה של Windows'], ['none', 'בלי צליל']];
const UNITS = [[3600, 'שעות'], [86400, 'ימים'], [604800, 'שבועות'], [2592000, 'חודשים']];

/** The town names, from Tzofar's public list (works from an Israeli connection). Cached for a month. */
async function townList() {
  try {
    const c = JSON.parse(localStorage.getItem('haluach.towns') || 'null');
    if (c && c.cd && Date.now() - c.t < 30 * 86400_000) return c.list;   // an old copy without the times is fetched again
  } catch {}
  try {
    const d = await proxied('https://www.tzevaadom.co.il/static/cities.json');
    const all = Object.values(d.cities || d);
    const list = all.map(x => x.he || x.name || x).filter(x => typeof x === 'string').sort((a, b) => a.localeCompare(b, 'he'));
    // The seconds to reach a protected space, per town (Tzofar's "countdown").
    const cd = Object.fromEntries(all.filter(x => x?.he && x.countdown != null).map(x => [x.he, x.countdown]));
    localStorage.setItem('haluach.towns', JSON.stringify({ t: Date.now(), list, cd }));
    return list;
  } catch {
    // Not reachable (abroad, or blocked): the copy in the package. Not cached, so the live list wins later.
    return Object.keys(TOWNS).sort((a, b) => a.localeCompare(b, 'he'));
  }
}

/** The shortest time to a protected space among these towns ("90 שניות", "מיד"), or '' when unknown. */
function shelterTime(towns) {
  let cd = {};
  try { cd = JSON.parse(localStorage.getItem('haluach.towns') || '{}').cd || TOWNS; } catch { cd = TOWNS; }
  const secs = towns.map(t => cd[t]).filter(x => x != null);
  if (!secs.length) return '';
  const m = Math.min(...secs);
  return m <= 0 ? 'מיד' : m < 60 ? `${m} שניות` : m === 60 ? 'דקה' : m === 90 ? 'דקה וחצי' : `${Math.round(m / 60)} דקות`;
}

/** The provider must run from sign-in for red alert: turn the StartupTask on. Windows answers the state; 2 = Enabled,
 *  4 = EnabledByPolicy. With `ask`, a refusal is explained to the user. Used by the card's save and the wizard. */
export async function enableStartup(ask = true) {
  const r = await fetch('startup?on=1').then(x => x.text()).catch(() => '');
  const ok = r === '2' || r === '4';
  if (!ok && ask) alert('Windows לא אישר הפעלה בכניסה (אפשר להפעיל ב: מנהל המשימות > אפליקציות אתחול). ההתרעות יעבדו כשהלוח פתוח.');
  return ok;
}

export default {
  id: 'redalert',
  title: 'צבע אדום',
  size: [1, 2],
  hiddenByDefault: true,
  defaults: { enabled: false, towns: [], all: false, nonWarAll: true, rareSecs: 0, toast: true, breakFocus: true, muteRadio: true, speak: false, sound: { default: 'builtin' }, volume: 1, unmute: false, minVol: 60 },
  every: 3000,
  async render(el, ctx) {
    const s = ctx.s;
    if (!s.enabled) { el.replaceChildren(h('div', { class: 'sub' }, 'כבוי. אפשר להפעיל בהגדרות הכרטיס.')); return; }
    if (!s.all && !(s.towns || []).length) { el.replaceChildren(h('div', { class: 'sub' }, 'לא נבחרו יישובים. בוחרים בהגדרות הכרטיס (גלגל השיניים בכותרת).')); return; }
    const st = await fetch('redalert').then(r => r.json()).catch(() => ({}));
    if (st.reachable === false) { el.replaceChildren(h('div', { class: 'sub' }, 'אין גישה לפיקוד העורף מהחיבור הזה. השירות זמין רק מחיבור ישראלי.')); return; }
    const cur = st.current;
    const fresh = cur && Date.now() - cur.at < 3 * 60_000;
    if (fresh && cur.mine?.length) await townList();   // the shelter times (cached)
    const hist = (st.history || []).filter(a => a.mine?.length).slice(0, 4);
    el.replaceChildren(
      fresh && cur.mine?.length
        ? h('div', { class: 'ra-now', role: 'alert' }, h('b', {}, cur.title), h('div', {}, cur.mine.slice(0, 12).join(', ')),
            shelterTime(cur.mine) ? h('div', { class: 'ra-shelter' }, 'זמן להגיע למרחב מוגן: ', h('b', {}, shelterTime(cur.mine))) : '',
            cur.desc ? h('div', { class: 'sub' }, cur.desc) : '')
        : h('div', { class: 'sub' }, h('span', { class: 'ra-dot', 'aria-hidden': true }), 'אין התרעות כרגע'),
      hist.length ? h('hr', { class: 'sep' }) : '',
      ...hist.map(a => h('div', { class: 'row' }, h('span', {}, a.title, h('span', { class: 'faint' }, ' · ' + a.mine.slice(0, 3).join(', '))), h('b', { class: 'num' }, new Date(a.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })))),
    );
  },
  async settings(box, ctx) {
    const s = structuredClone(ctx.s);
    const put = (patch, redraw = true) => { ctx.set(patch); if (redraw) ctx.rerender(); };
    // The town list loads in the background (a few seconds the first time): the menu shows at once.
    const townsReady = townList();
    // Everything else is shown only while red alert is on.
    const rest = h('div', { class: 'form fold' });
    rest.hidden = !s.enabled;
    const [onRow] = sw('צבע אדום פועל', s.enabled, async v => {
      rest.hidden = !v;
      put({ enabled: v });
      // On: ask Windows now (the user is told if it refuses). Off: app.js decides (another background job may need it).
      if (v) await enableStartup();
    }, 'הלוח נפתח לבד בכניסה ל-Windows');

    // Towns: all of Israel, or a list (chips with an x, a search to add).
    const chosen = new Set(s.towns);
    const chips = h('div', { class: 'chips ra-towns' });
    const saveTowns = () => put({ towns: [...chosen] });
    const drawChips = () => chips.replaceChildren(...(chosen.size ? [...chosen].map(t => h('button', { class: 'chip', title: 'הסרה', onclick: () => { chosen.delete(t); drawChips(); saveTowns(); } }, t, h('span', { html: X_ICON }))) : [h('span', { class: 'sub' }, 'לא נבחר יישוב.')]));
    drawChips();
    const dl = h('datalist', { id: 'ra-towns' });
    const add = h('input', { type: 'search', list: 'ra-towns', class: 'ra-add', placeholder: 'הוספת יישוב',
      onchange: e => { const v = e.target.value.trim(); if (v) { chosen.add(v); e.target.value = ''; drawChips(); saveTowns(); } } });
    const townBox = h('div', { class: 'ra-townbox fold' }, chips, add, dl);
    townsReady.then(list => { dl.replaceChildren(...list.map(t => h('option', { value: t }))); if (!list.length) add.placeholder = 'שם יישוב (כמו בפיקוד העורף)'; }).catch(() => {});
    townBox.hidden = !!s.all;
    const [allRow] = sw('כל הארץ', s.all, v => { townBox.hidden = v; put({ all: v }); });

    // "Rare": after a quiet time with no alert anywhere, the next one shows from everywhere. rareSecs 0 = off.
    const unit0 = UNITS.slice().reverse().find(([u]) => s.rareSecs && s.rareSecs % u === 0) || UNITS[1];
    let rareN = s.rareSecs ? s.rareSecs / unit0[0] : 1, rareU = unit0[0];
    const saveRare = () => put({ rareSecs: rareN * rareU }, false);
    const rare = sw('אחרי תקופה שקטה: מכל הארץ', s.rareSecs > 0, v => put({ rareSecs: v ? rareN * rareU : 0 }, false), 'אם לא הייתה התרעה באף מקום', [
      row('שקט של', h('span', { class: 'unit' },
        number(rareN, '', v => { rareN = v || 1; saveRare(); }, { min: 1, max: 999 }),
        choice(UNITS, rareU, v => { rareU = v; saveRare(); })))]);

    // Sounds: one for each kind, folded (most people keep the board's sound).
    const vol = h('input', { type: 'range', class: 'ra-vol', min: 0, max: 1, step: 0.05, value: s.volume, 'aria-label': 'עוצמת הצליל', onchange: () => put({ volume: +vol.value }, false) });
    const sel = {};
    const saveSound = () => { const sound = { default: 'builtin' }; for (const k in sel) sound[k] = sel[k].value; put({ sound }, false); };
    const soundRow = ([k, label]) => {
      sel[k] = h('select', { onchange: saveSound }, ...SOUNDS.map(([v, l]) => h('option', { value: v, selected: (s.sound[k] || s.sound.default) === v }, l)));
      return row(label, h('span', { class: 'ra-snd' }, sel[k],
        h('button', { class: 'icon small ra-play', title: 'השמעה', 'aria-label': 'השמעה', html: PLAY_ICON, onclick: () => fetch(`sound?which=${sel[k].value}&v=${vol.value}`) })));
    };
    const sounds = h('details', {}, h('summary', {}, 'צליל לכל סוג', h('span', { class: 'faint' }, KINDS.length + ' סוגים')), h('div', { class: 'form' }, ...KINDS.map(soundRow)));

    rest.append(
      section('יישובים'), allRow, townBox,
      section('איך מתריעים'),
      ...sw('הודעה על המסך', s.toast, v => put({ toast: v }, false), 'בשבת ובחג לא יוצאת שום התרעה',
        sw('גם ב"נא לא להפריע"', s.breakFocus, v => put({ breakFocus: v }, false))),
      ...sw('השתקת הרדיו בזמן התרעה', s.muteRadio, v => put({ muteRadio: v }, false)),
      more(
        sw('אסונות טבע וחומרים מסוכנים: מכל הארץ', s.nonWarAll, v => put({ nonWarAll: v }, false), 'רעידת אדמה, צונאמי, חומרים מסוכנים'),
        rare,
        sw('קריאה בקול', s.speak, v => put({ speak: v }, false), 'אחרי הצליל: סוג ההתרעה, היישובים והזמן למרחב מוגן', [
          row('דוגמה', h('button', { class: 'btn', onclick: () => fetch('speak?v=' + (+vol.value || 1)).catch(() => {}) }, 'השמעה'), 'בקול העברי של Windows')]),
        row('עוצמת הצליל', vol),
        sw('גם כשהמחשב מושתק', s.unmute, v => put({ unmute: v }, false), 'רק בזמן ההתרעה, ואחר כך העוצמה חוזרת', [
          row('עוצמה מינימלית', number(s.minVol ?? 60, '%', v => put({ minVol: v }, false), { min: 10, max: 100 }))]),
        sounds));
    box.append(onRow, rest);
  },
};

export const css = `
.ra-now { border: 1px solid var(--bad); border-radius: var(--radius); padding: 8px 10px; color: var(--fg); animation: ra-pulse 1s ease-in-out infinite alternate; }
.ra-now > b { color: var(--bad); }
.ra-shelter { margin-top: 4px; font-size: 15px; }
.ra-shelter b { color: var(--bad); }
.ra-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--good); margin-inline-end: 6px; }
/* Settings: the towns under "כל הארץ", the volume slider, a sound with its play button. */
.ra-townbox { display: grid; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--stroke); }
.ra-add { width: 100%; }
.ra-vol { width: 140px; }
.ra-snd { display: inline-flex; align-items: center; gap: 4px; }
.ra-snd select { max-width: 12em; }
.ra-play { opacity: 1; }
@keyframes ra-pulse { from { border-color: var(--bad); } to { border-color: var(--stroke); } }
`;
