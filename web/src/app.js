// The board page: the header, the first-run wizard, the general settings, and the cards.
import './devclock.js';
import { HDate } from '@hebcal/core';
import { h, settings, save, register, drawGrid, allCards, show, hide as hideCard, openSheet, applyTheme, ACCENTS, FACES, loadFace, isHex, hexHsl, hslHex, accentBase, windowsAccent, saveCard, cardSettings, log, zmanim, raise, refreshWidgets, TABS, openCardSettings, vt, ink, whileVisible } from './core.js';
import { isErev } from './cards/shabbat.js';
import { picker, setLocation, townAt } from './location.js';
import zmanimCard, { TIMES, chosen, remindersOf } from './cards/zmanim.js';
import { cards as more, css as cardsCss } from './cards/index.js';
import { replan, NOTIFY, notifyOn, notifyList, parseList } from './planner.js';
import { enableStartup } from './cards/redalert.js';
import { drawNow } from './now.js';
import { checkAll as checkShipments } from './cards/shipments.js';
import { checkAll as checkPodcasts } from './cards/podcasts.js';
import { checkAll as checkYoutube } from './cards/youtube.js';
import weatherCard, { alerts as weatherAlerts, lastData as weatherData } from './cards/weather.js';
import { notify, openExternal, sourceStates, hm, proxied, saving, note, sv, isMetered, undoBar } from './core.js';
import { row, toggle, choice, select } from './ui.js';

register([zmanimCard, ...more]);
// A few layout bits of the header's panels that the shared blocks do not have (tokens only).
const APP_CSS = `
.wiz-foot { display: flex; justify-content: flex-end; margin-top: 14px; }
.wiz-note, .add-note { font-size: 12.5px; padding-top: 8px; }
.loc-pick { gap: 6px; padding-top: 4px; }
.loc-pick > input[type=search] { width: 100%; }
.loc-pick > .btn { justify-self: start; margin-top: 4px; }
.loc-pick > .sub:empty { display: none; }
.form > .srow > select { width: min(55%, 220px); flex: none; }
.form > details > .form { padding-bottom: 4px; }
`;
document.head.append(Object.assign(document.createElement('style'), { textContent: cardsCss + APP_CSS }));

let lookOff = null; // the accent picker's 'haluach:look' listener (see the accent section)

/** The Hebrew date changes at sunset (the user's rule, SPEC). The header shows it with gershayim. */
export function hebrewDate(now = new Date(), afterSunset = false) {
  const hd = new HDate(now);
  return (afterSunset ? hd.next() : hd).renderGematriya(true).replace(/^(\S+ \S+) ה?/, '$1 ').replace(/[֑-ׇ]/g, '');
}
async function header() {
  const now = new Date();
  const z = settings().loc ? await zmanim(now).catch(() => null) : null;
  document.getElementById('hdate').textContent = hebrewDate(now, !!(z?.sunset && now > z.sunset));
  // "תאריך בכותרת" (settings, תצוגה): both, the Hebrew one or the civil one. With both, the civil one is short
  // ("ראשון 15.11"): the board is about 400px wide.
  const show = settings().dateShow || 'both';
  const wd = now.toLocaleDateString('he-IL', { weekday: 'long' }).replace('יום ', '');
  document.getElementById('gdate').textContent = show === 'both' ? `${wd} ${now.getDate()}.${now.getMonth() + 1}`
    : now.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).replace('יום ', '');
  document.getElementById('hdate').hidden = show === 'greg';
  document.getElementById('gdate').hidden = show === 'heb';
}

// ---------- first run: 4 screens (location; method and nusach; cards; notifications and red alert) ----------
// The look of the inner menus: a step bar, a title, one grey line, rows, and "המשך" at the end.
const wizFoot = (label, onclick, back) => h('div', { class: 'wiz-foot' }, back ? h('button', { class: 'btn', onclick: back }, 'חזרה') : '', h('button', { class: 'btn primary', onclick }, label));
const WIZ_TITLES = { '-1': 'ברוכים הבאים ללוח', 0: 'מיקום', 1: 'שיטה ונוסח', 2: 'אילו כרטיסים להציג?', 3: 'התראות', 4: 'הכל מוכן' };
function wizard(step = 0) {
  openSheet(WIZ_TITLES[step], (body, close) => {
    const steps = h('div', { class: 'steps' }, ...[0, 1, 2, 3].map(i => h('i', { class: i <= step ? 'on' : '' })));
    // The step is kept: a board closed in the middle opens at the same step (HaFeed S.wizStep).
    save({ wizStep: step });
    const next = () => { close(); wizard(step + 1); };
    const finish = () => { close(); const first = !settings().setupDone; save({ setupDone: true, wizStep: 0 }); drawGrid(); if (first) setTimeout(tour, 600); };
    const back = step > -1 ? () => { close(); wizard(step - 1); } : null;
    // The welcome (with the accent, as HaFeed's wizAccent) and the summary at the end (HaFeed's last screen).
    if (step === -1) {
      body.append(h('p', { class: 'sub' }, 'זמני היום, שבת וחג, לימוד ומידע, בתוך לוח הווידג׳טים של Windows. כמה שאלות קצרות, וזה מוכן.'),
        h('div', { class: 'sub' }, 'קודם, צבע:'), ...accentPicker(), wizFoot('המשך', next));
      return;
    }
    if (step === 4) {
      const S = settings(), n = S.notify || {}, lay = S.layout || [];
      const shown = allCards().filter(c => !(lay.find(l => l.id === c.id)?.hidden ?? c.hiddenByDefault)).length;
      const on = [['candles', 'הדלקת נרות'], ['zmanim', 'זמני ק״ש ותפילה'], ['omer', 'ספירת העומר'], ['redalert', 'צבע אדום']].filter(([k]) => n[k]).map(([, t]) => t);
      const line = (t, v) => h('div', { class: 'srow' }, h('span', {}, t), h('b', {}, v));
      body.append(h('div', { class: 'form' },
        line('מיקום', S.loc?.name || 'לא נבחר'),
        line('נוסח', { ashkenaz: 'אשכנז', sfarad: 'ספרד', edot: 'עדות המזרח' }[S.nusach || 'ashkenaz']),
        line('כרטיסים', `${shown} מוצגים`),
        line('איך להתריע', (VIA.find(([v]) => v === (n.via || 'toast')) || VIA[1])[1]),
        line('תזכורות', on.length ? on.join(', ') : 'אין')),
        h('p', { class: 'sub' }, 'הכל ניתן לשינוי בהגדרות. האשף נמצא שם, באודות.'),
        wizFoot('התחלה', finish, back));
      return;
    }
    body.append(steps);
    if (back && step !== 3) body.append(h('div', { class: 'wiz-back' }, h('button', { class: 'link', onclick: back }, 'חזרה')));
    if (step === 0) {
      body.append(h('p', { class: 'sub' }, 'קודם, מאיזה מקום לחשב זמנים ומזג אוויר?'));
      const box = h('div', { class: 'form loc-pick' });
      picker(box, loc => { setLocation(loc); next(); });
      searchFirst(box);
      body.append(box);
      return;
    }
    if (step === 1) {
      body.append(h('p', { class: 'sub' }, 'כל זמן אפשר לשנות אחר כך, בהגדרות כרטיס הזמנים.'));
      const z = cardSettings('zmanim');
      const pick = id => TIMES.find(t => t.id === id);
      const sel = (id) => {
        const t = pick(id), cur = chosen(z).find(x => x.id === id).method;
        const s = h('select', { 'data-id': id, 'aria-label': t.name }, ...t.m.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
        return row(t.name, s);
      };
      let nusach = settings().nusach || 'ashkenaz';
      const form = h('div', { class: 'form' }, sel('alot'), sel('shma_mga'), sel('netz'), sel('tzeit'),
        row('נוסח', choice([['ashkenaz', 'אשכנז'], ['sfarad', 'ספרד'], ['edot', 'עדות המזרח']], nusach, v => { nusach = v; }), 'לספירת העומר ולתפילות'));
      body.append(form, wizFoot('המשך', () => {
        const method = { ...(z.method || {}) };
        form.querySelectorAll('select[data-id]').forEach(s => { method[s.dataset.id] = s.value; });
        // The sunset follows the sunrise's horizon (מישור / מהגובה).
        method.shkia = method.netz === 'sunrise_elev' ? 'sunset_elev' : 'sunset';
        saveCard('zmanim', { method });
        save({ nusach });
        next();
      }));
      return;
    }
    if (step === 2) {
      body.append(h('p', { class: 'sub' }, 'אפשר להוסיף ולהסתיר כרטיסים בכל זמן.'));
      const list = h('div', { class: 'form' }, ...allCards().map(c => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-id': c.id, checked: !(settings().layout.find(l => l.id === c.id)?.hidden ?? c.hiddenByDefault) }), c.title)));
      body.append(list, wizFoot('המשך', () => {
        const on = new Set([...list.querySelectorAll('input:checked')].map(i => i.dataset.id));
        const known = new Map(settings().layout.map(l => [l.id, l]));
        save({ layout: allCards().map(c => ({ ...(known.get(c.id) || { id: c.id, w: c.size?.[0] || 1, h: c.size?.[1] || 2 }), hidden: !on.has(c.id) })) });
        next();
      }));
      return;
    }
    body.append(h('p', { class: 'sub' }, 'הכל ניתן לשינוי אחר כך, בהגדרות (גלגל השיניים למעלה).'));
    const n = settings().notify || {};
    const opt = (k, label, def, hint) => h('label', { class: 'check' }, h('input', { type: 'checkbox', 'data-k': k, checked: n[k] ?? def }), h('span', {}, label, hint ? h('span', { class: 'hint' }, hint) : ''));
    const form = h('div', { class: 'form' },
      opt('candles', 'לפני הדלקת נרות', NOTIFY.candles, `${notifyList('candlesMin').join(', ')} דק׳ לפני`),
      opt('zmanim', 'לפני סוף זמן ק״ש ותפילה', false, '15 דק׳ לפני'),
      opt('omer', 'ספירת העומר בערב', NOTIFY.omer),
      opt('redalert', 'צבע אדום', false, 'בוחרים יישובים במסך הבא'));
    let via = n.via || 'toast';
    const vias = h('div', { class: 'seg seg4' });
    const drawV = () => vias.replaceChildren(...VIA.map(([v, name, line], i) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(v === via),
      onclick: () => { via = v; drawV(); } }, h('span', { html: VIA_LAY[i] }), h('b', {}, name), h('small', {}, line))));
    drawV();
    body.append(h('div', { class: 'sub' }, 'איך להתריע על עדכונים מהכרטיסים:'), vias);
    body.append(form, h('div', { class: 'sub wiz-note' }, 'בשבת ובחג לא יוצאת שום התראה.'), wizFoot('סיום', () => {
      const notify = { ...n, via };
      form.querySelectorAll('input[data-k]').forEach(i => { notify[i.dataset.k] = i.checked; });
      save({ notify });
      // Red alert has its own switch in its card (the provider reads that one): the wizard's choice sets it.
      saveCard('redalert', { enabled: !!notify.redalert });
      // As the card's own save: the provider must run from sign-in (Windows may ask the user once).
      if (notify.redalert) enableStartup();
      // Red alert goes on to its towns (a sheet of its own), so the summary is skipped then.
      notify.redalert ? finish() : next();
      // Red alert chosen: its towns right away (without them it alerts on nothing).
      if (notify.redalert) { show('redalert'); setTimeout(() => openCardSettings('redalert'), 300); }
    }, back));
  }, { narrow: true, sticky: true });
}
/** The place picker: the search first, its results under it, then "לפי המיקום שלי" (location.js builds them). */
function searchFirst(box, focus = true) {
  const input = box.querySelector('input[type=search]'), list = box.querySelector('.list');
  if (!input) return;
  box.prepend(input);
  if (list) input.after(list);
  if (focus) setTimeout(() => input.focus(), 0);
}

// ---------- general settings: a popup sheet, as in HaFeed (tabs, a search over all of them, two columns when
// wide). Every change is saved at once; long lists fold into groups. ----------
// Backup lives in About (the user: "גיבוי אמור להיות בתוך האודות").
const SET_TABS = [['look', 'תצוגה'], ['notify', 'התראות'], ['cards', 'כרטיסים'], ['place', 'מיקום'], ['about', 'אודות'], ['advanced', 'מתקדם']];
function generalSettings(tab) {
  openSheet('הגדרות', (body, close, api) => {
    lookSections(api);
    notifySections(api, close);
    cardsSections(api);
    api.section('place', 'מיקום', placeBody(() => { header(); drawPlace(); drawNow(); }, false));
    aboutSection(api, close);
    advancedSections(api);
    resetSection(api, 'look', ['theme', 'accent', 'face', 'font', 'density', 'width', 'dateShow', 'saver', 'svBg', 'svPics', 'svSlow'], () => applyTheme());
    resetSection(api, 'notify', ['notify'], null);
    resetSection(api, 'cards', ['layout'], () => drawGrid());
    api.section('about', 'גיבוי', h('div', { class: 'form' },
      row('כל ההגדרות והנתונים בקובץ', h('span', { class: 'chips' },
        h('button', { class: 'btn', onclick: () => saveBackup().then(n => note(n ? `הגיבוי נשמר בתיקיית המסמכים: ${n}` : 'שמירת הגיבוי נכשלה.')) }, 'ייצוא'),
        h('label', { class: 'btn' }, 'ייבוא', h('input', { type: 'file', accept: '.json', hidden: true, onchange: async e => {
          try { restore(JSON.parse(await e.target.files[0].text())); } catch { note('הקובץ הזה לא גיבוי של הלוח.'); return; }
          // Every module reads its data again (the sent ids and caches in memory): open the board afresh.
          close(); setTimeout(() => location.reload(), 800);
        } }))), 'למחשב אחר או לשחזור')));
  }, { tabs: SET_TABS, hiddenTabs: ['advanced'], tab: tab === 'backup' ? 'about' : tab });
}

// ---------- the display tab (HaFeed's "תצוגה"; core.js applyTheme applies every one) ----------
/** Tiles for a choice of a few: a bold name and a grey line (HaFeed's .seg). opts: [[value, name, line, class]]. */
function tiles(opts, value, on, cls = '') {
  const box = h('div', { class: 'seg ' + cls });
  const draw = v => box.replaceChildren(...opts.map(([val, name, line, c]) => h('button', { type: 'button', 'aria-pressed': String(val === v), onclick: () => { draw(val); on(val); } },
    h('b', { class: c || '' }, name), line ? h('small', {}, line) : '')));
  draw(value);
  return box;
}
function lookSections(api) {
  const S = settings();
  const set = patch => { save(patch); applyTheme(); };
  api.section('look', 'ערכת צבעים', tiles([['auto', 'אוטומטי', 'כמו Windows'], ['light', 'בהיר', 'תמיד'], ['dark', 'כהה', 'תמיד']], S.theme || 'auto', v => set({ theme: v }), 'seg3'));
  api.section('look', 'צבע הדגשה', ...accentPicker());
  // Shown only when HaFeed is installed (the provider sees its package).
  const shared = api.section('look', 'מראה משותף עם הפיד', h('div', { class: 'form' },
    ...toggle('אותו מראה בלוח ובפיד', !!S.lookSync, v => { save({ lookSync: v }); if (v) lookPull(true); },
      'ערכת הצבעים וצבע ההדגשה. שינוי באחד עובר גם לשני. צריך להדליק את זה גם בפיד.')));
  shared.hidden = true;
  fetch('look').then(r => r.json()).then(r => { shared.hidden = !r.installed; }).catch(() => {});
  const faces = h('div', { class: 'faces' }, ...FACES.map(([id, family, , name]) => {
    loadFace(id); // the samples need the fonts; only while the settings are open
    return h('button', { type: 'button', 'data-v': id, onclick: () => { set({ face: id }); paint(); } },
      h('b', { style: `font-family: "${family}", "Segoe UI", sans-serif` }, 'אבג'), h('small', {}, name));
  }));
  const paint = () => faces.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === (settings().face || 'segoe'))));
  paint();
  api.section('look', 'גופן', faces);
  api.section('look', 'גודל טקסט', tiles([['s', 'א', 'קטן', 'fs-s'], ['m', 'א', 'רגיל', 'fs-m'], ['l', 'א', 'גדול', 'fs-l']], S.font || 'm', v => set({ font: v }), 'seg3'));
  api.section('look', 'צפיפות', tiles([['roomy', 'מרווח', 'יותר רווח בין כרטיסים'], ['normal', 'רגיל', 'ברירת המחדל'], ['dense', 'צפוף', 'יותר כרטיסים במסך']], S.density || 'normal', v => set({ density: v }), 'seg3'));
  api.section('look', 'רוחב', tiles([['column', 'עמודה', 'באמצע המסך'], ['wide', 'כל הרוחב', 'שורות ארוכות']], S.width || 'column', v => set({ width: v })));
  const hd = hebrewDate(), gd = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'long' });
  const svNow = h('div', { class: 'hint' });
  const svDraw = () => { svNow.textContent = saving() ? 'החיסכון פועל עכשיו' + (isMetered() ? ', כי הרשת מוגבלת.' : '.') : 'החיסכון לא פועל עכשיו.'; };
  svDraw();
  const svT = (k, label, hint) => toggle(label, S[k] ?? true, v => save({ [k]: v }), hint);
  api.section('look', 'חיסכון בנתונים', tiles([['auto', 'אוטומטי', 'ברשת מוגבלת'], ['on', 'תמיד', 'גם ברשת רגילה'], ['off', 'כבוי', 'אף פעם']], S.saver || 'auto', v => { save({ saver: v }); svDraw(); }, 'seg3'),
    svNow, h('div', { class: 'hint' }, 'בזמן חיסכון:'), h('div', { class: 'form' },
      ...svT('svBg', 'בלי עבודה ברקע', 'כשהלוח סגור: אין בדיקות ואין התראות מהכרטיסים'),
      ...svT('svPics', 'בלי תמונות', 'בלי תמונות של סרטונים וערוצים'),
      ...svT('svSlow', 'רענון לאט יותר', 'הכרטיסים מתעדכנים פי 4 לאט יותר')));
  api.section('look', 'תאריך בכותרת', tiles([['both', 'שניהם', 'עברי ולועזי'], ['heb', 'עברי', hd], ['greg', 'לועזי', gd]], S.dateShow || 'both', v => { save({ dateShow: v }); header(); }, 'seg3'));
}
// The accent squares: Windows, ten colours, and your own (a hue bar and a colour code; it applies as you move),
// then the shade (as in HaFeed).
const WIN_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z"/></svg>';
const PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>';
function accentPicker() {
  const S = () => settings();
  const set = patch => { save(patch); applyTheme(); paint(); };
  const sq = (cls, title, v, html) => h('button', { type: 'button', class: cls, title, 'aria-label': title, 'data-v': v, style: isHex(v) ? `background:${v}` : '', html: html || '' });
  const box = h('div', { class: 'swatches', role: 'group', 'aria-label': 'צבע הדגשה' },
    sq('win', 'כמו Windows', 'win', WIN_MARK), ...ACCENTS.map(([n, c]) => sq('', n, c)), sq('own', 'צבע אחר', 'own', PLUS));
  const hue = h('input', { type: 'range', class: 'bar hue', min: 0, max: 360, 'aria-label': 'גוון' });
  const chip = h('i');
  const hex = h('input', { type: 'text', class: 'hex', dir: 'ltr', spellcheck: 'false', maxlength: 7, 'aria-label': 'קוד צבע, למשל #E5484D' });
  const own = h('div', { class: 'acc-own fold', hidden: true }, hue, h('div', { class: 'r' }, chip, hex, h('button', { type: 'button', class: 'chip', onclick: () => { own.hidden = true; paint(); } }, 'סיום')));
  const shadeTxt = h('small');
  const shade = h('input', { type: 'range', class: 'bar', min: -3, max: 3, step: 1, 'aria-label': 'בהירות הצבע' });
  const ownShow = c => { hue.value = hexHsl(c)[0]; hex.value = c; hex.classList.remove('bad'); chip.style.background = c; };
  const ownSet = c => { chip.style.background = c; set({ accent: c }); };
  box.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'own') { own.hidden = !own.hidden; if (!own.hidden) ownShow(accentBase() || windowsAccent()); paint(); }
    else { own.hidden = true; set({ accent: b.dataset.v }); }
  });
  hue.addEventListener('input', () => { const c = hslHex(+hue.value, 80, 45); hex.value = c; hex.classList.remove('bad'); ownSet(c); });
  hex.addEventListener('input', () => {
    let v = hex.value.trim();
    if (v && v[0] !== '#') v = '#' + v;
    const ok = isHex(v);
    hex.classList.toggle('bad', !ok && v.length >= 7);
    if (ok) { hue.value = hexHsl(v)[0]; ownSet(v.toUpperCase()); }
  });
  shade.addEventListener('input', () => set({ accentShade: +shade.value }));
  function paint() {
    const a = S().accent, mine = isHex(a) && !ACCENTS.some(([, c]) => c === a);
    box.firstElementChild.style.background = windowsAccent();
    for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.v === 'own' ? mine || !own.hidden : own.hidden && b.dataset.v === (a || 'win')));
    const [hh, s] = hexHsl(accentBase() || windowsAccent()), step = S().accentShade || 0;
    shade.value = step;
    shade.style.background = `linear-gradient(to left, hsl(${hh} ${s}% 20%), hsl(${hh} ${s}% 50%), hsl(${hh} ${s}% 80%))`;
    shadeTxt.textContent = ['הכי כהה', 'כהה יותר', 'כהה', 'רגיל', 'בהיר', 'בהיר יותר', 'הכי בהיר'][step + 3];
  }
  paint();
  // Windows' colour arrives a moment after the page opens.
  // One listener at a time: the one of an earlier opening goes away here, and each one goes away after its sheet closed.
  lookOff?.abort();
  const ac = (lookOff = new AbortController());
  window.addEventListener('haluach:look', () => { if (box.isConnected) paint(); else ac.abort(); }, { signal: ac.signal });
  return [box, own, h('div', { class: 'acc-shade' }, h('span', {}, 'בהירות'), shadeTxt), shade];
}

// ---------- the cards tab: which are shown (the order: drag a card by its title) ----------
function cardsSections(api) {
  const S = settings();
  const cardsBox = h('div', { class: 'form' });
  const count = h('span', { class: 'faint num' });
  const paintCount = () => { const ls = settings().layout.filter(l => allCards().some(c => c.id === l.id)); count.textContent = `${ls.filter(l => !l.hidden).length}/${ls.length}`; };
  for (const l of S.layout) {
    const m = allCards().find(c => c.id === l.id);
    if (!m) continue;
    cardsBox.append(...toggle(m.title, !l.hidden, on => { (on ? show : hideCard)(l.id); paintCount(); }));
  }
  paintCount();
  // The only thing in this tab: the list itself, open (not folded).
  api.section('cards', h('span', {}, 'כרטיסים מוצגים ', count), h('div', { class: 'form' },
    cardsBox,
    h('div', { class: 'faint' }, 'הסדר: גוררים כרטיס בכותרת שלו. הגדרות של כרטיס: בגלגל השיניים שבכרטיס.')));
}

// ---------- the notifications tab: every source in planner.js and the live checks ----------
// Each change is saved at once into settings().notify (defaults: planner.js NOTIFY); saving rebuilds the plan.
// A switch's minutes or days show only while it is on, right under it.
const VIA = [['board', 'על כפתור הלוח', 'שקט, בשורת המשימות'], ['toast', 'התראת Windows', 'חלון קטן בפינה'], ['both', 'שניהם', 'חלון וגם כפתור'], ['off', 'כבוי', 'בלי התראות']];
const VIA_LAY = ['<svg viewBox="0 0 120 84" class="lay" aria-hidden="true"><rect x="1" y="1" width="118" height="82" rx="10" class="m-frame"/><rect x="8" y="70" width="104" height="8" rx="4" class="m-old"/><rect x="12" y="71" width="12" height="6" rx="3" class="m-new"/><rect x="10" y="50" width="54" height="15" rx="7.5" class="m-new"/><rect x="18" y="55.5" width="30" height="4" rx="2" class="m-pill"/></svg>', '<svg viewBox="0 0 120 84" class="lay" aria-hidden="true"><rect x="1" y="1" width="118" height="82" rx="10" class="m-frame"/><rect x="8" y="70" width="104" height="8" rx="4" class="m-old"/><rect x="12" y="71" width="12" height="6" rx="3" class="m-new"/><rect x="58" y="24" width="54" height="38" rx="6" class="m-card"/><rect x="65" y="31" width="10" height="10" rx="5" class="m-new"/><rect x="79" y="32" width="26" height="4" rx="2" class="m-new"/><rect x="79" y="39" width="18" height="3" rx="1.5" class="m-old"/><rect x="65" y="47" width="40" height="3.5" rx="1.75" class="m-old"/><rect x="65" y="54" width="30" height="3.5" rx="1.75" class="m-old"/></svg>', '<svg viewBox="0 0 120 84" class="lay" aria-hidden="true"><rect x="1" y="1" width="118" height="82" rx="10" class="m-frame"/><rect x="8" y="70" width="104" height="8" rx="4" class="m-old"/><rect x="12" y="71" width="12" height="6" rx="3" class="m-new"/><rect x="10" y="50" width="54" height="15" rx="7.5" class="m-new"/><rect x="18" y="55.5" width="30" height="4" rx="2" class="m-pill"/><rect x="58" y="24" width="54" height="38" rx="6" class="m-card"/><rect x="65" y="31" width="10" height="10" rx="5" class="m-new"/><rect x="79" y="32" width="26" height="4" rx="2" class="m-new"/><rect x="79" y="39" width="18" height="3" rx="1.5" class="m-old"/><rect x="65" y="47" width="40" height="3.5" rx="1.75" class="m-old"/><rect x="65" y="54" width="30" height="3.5" rx="1.75" class="m-old"/></svg>', '<svg viewBox="0 0 120 84" class="lay" aria-hidden="true"><rect x="1" y="1" width="118" height="82" rx="10" class="m-frame"/><path class="m-bell" d="M60 16c-9.4 0-16 7.2-16 16.5v11L38 52h44l-6-8.5v-11C76 23.2 69.4 16 60 16z"/><circle class="m-bell" cx="60" cy="58" r="5"/><path class="m-slash" d="M40 14 80 66"/></svg>'];
function notifySections(api, close) {
  // after: redraws that depend on other switches here (the chips of urgent() follow the reminders' switch).
  const after = [];
  const set = patch => { save({ notify: { ...(settings().notify || {}), ...patch } }); after.forEach(f => f()); };
  const sw = (k, label, hint, deps) => toggle(label, !!notifyOn(k), v => set({ [k]: v }), hint, deps);
  // A short list of numbers ("30, 10"); empty = the default again.
  const list = (k, max, unit) => {
    const i = h('input', { type: 'text', class: 'n', inputmode: 'numeric', value: notifyList(k).join(', '), placeholder: NOTIFY[k].join(', '), 'aria-label': unit, onchange: e => {
      const v = parseList(e.target.value, 0, max);
      set({ [k]: v.length ? v : NOTIFY[k] });
      e.target.value = (v.length ? v : NOTIFY[k]).join(', ');
    } });
    i.style.width = '76px';
    return h('span', { class: 'unit' }, i, unit);
  };
  // A card's own settings open inside that card (the sheet closes).
  const toCard = (id, label, hint) => row(label, h('button', { class: 'btn', onclick: () => { close(); openCardSettings(id); } }, 'הגדרות'), hint);
  // Zmanim: the minutes are per time, in the zmanim card. Until something is saved there, the wizard's switch
  // ("15 minutes before shma and tefila") decides; after that the card's list does (zmanim.js remindersOf).
  const zs = cardSettings('zmanim');
  const remCount = Object.values(remindersOf(zs)).reduce((a, m) => a + m.length, 0);
  // "Do not disturb" per time: the switch, then the times with reminders as chips (on = also in DND).
  const urgent = label => {
    const off = new Set(notifyOn('zmanimUrgentOff') || []);
    const box = h('span', { class: 'chips' }), line = h('div', { class: 'srow' }, box);
    let ids = [];
    const draw = () => { ids = Object.keys(remindersOf(cardSettings('zmanim'))); line.style.display = ids.length > 1 ? '' : 'none'; box.replaceChildren(...chosen(zs).filter(t => ids.includes(t.id)).map(t => h('button', { type: 'button', class: 'chip' + (off.has(t.id) ? '' : ' on'),
      onclick: () => { off.has(t.id) ? off.delete(t.id) : off.add(t.id); set({ zmanimUrgentOff: [...off] }); } }, t.name))); };
    draw(); after.push(draw);
    return toggle(label, !!notifyOn('zmanimUrgent'), v => set({ zmanimUrgent: v }), 'רק התזכורת האחרונה לפני כל זמן', [line]);
  };
  const every = choice([[30, 'חצי שעה'], [60, 'שעה'], [180, '3 שעות'], [360, '6 שעות']], cardSettings('shipments').everyMin || 60, v => saveCard('shipments', { everyMin: +v }));
  // How the cards notify (HaFeed's "איך להתריע"). The reminders of times are scheduled in Windows, so they stay
  // Windows notifications whatever is chosen here.
  const viaBox = h('div', { class: 'seg seg4' }), tried = h('span', { class: 'sub' });
  const HOW = { board: 'ההתראות מהכרטיסים יופיעו בשקט, על כפתור הלוח.', toast: 'ההתראות מהכרטיסים יופיעו בחלון קטן בפינת המסך.', both: 'ההתראות מהכרטיסים יופיעו בחלון בפינה וגם על כפתור הלוח.', off: 'אין התראות מהכרטיסים.' };
  const drawVia = () => { const cur = settings().notify?.via || 'toast'; tried.textContent = HOW[cur]; viaBox.replaceChildren(...VIA.map(([v, name, line], i) => h('button', { type: 'button', 'data-v': v, 'aria-pressed': String(v === cur),
    onclick: () => { set({ via: v }); drawVia(); } }, h('span', { html: VIA_LAY[i] }), h('b', {}, name), h('small', {}, line)))); };
  drawVia();
  api.section('notify', 'איך להתריע', viaBox,
    h('div', { class: 'row' }, tried, h('button', { class: 'chip', onclick: async () => {
      const r = await notify({ id: 'try-' + Date.now(), title: 'הלוח', body: 'כך נראית התראה מהלוח.' }).catch(() => null);
      if (!r || !r.ok) tried.textContent = 'ההתראה לא נשלחה.';
    } }, 'ניסיון')),
    h('div', { class: 'faint' }, 'הבחירה חלה על ההתראות מהכרטיסים. תזכורות הזמנים והחגים מתוזמנות ב-Windows, ולכן הן תמיד התראת Windows. צבע אדום תמיד מופיע כחלון.'));
  const rv = k => settings().notify?.[k] ?? RULES[k];
  const tm = k => h('input', { type: 'time', value: rv(k), 'aria-label': k === 'nightFrom' ? 'מ' : 'עד', onchange: e => e.target.value && set({ [k]: e.target.value }) });
  api.section('notify', 'כללים', h('div', { class: 'form' },
    ...toggle('שקט בלילה', rv('night'), v => set({ night: v }), 'התראות מהכרטיסים לא יוצאות בשעות האלה', [row('שעות', h('span', { class: 'unit' }, 'מ-', tm('nightFrom'), ' עד ', tm('nightTo')))]),
    ...toggle('לא כשהלוח פתוח', rv('notOpen'), v => set({ notOpen: v }), 'כשאתה כבר מסתכל על הלוח, אין התראה'),
    ...toggle('איחוד הצפות', rv('merge'), v => set({ merge: v }), 'הרבה התראות בבת אחת? התראה אחת שמסכמת אותן', [
      row('מכמה התראות', h('span', { class: 'unit' }, h('input', { type: 'number', class: 'n', min: 2, max: 20, value: rv('mergeAt'), style: 'width:60px', onchange: e => set({ mergeAt: Math.min(20, Math.max(2, +e.target.value || 3)) }) }), 'ומעלה'))])));
  api.section('notify', 'תזכורות', h('div', { class: 'form' },
    ...sw('candles', 'לפני הדלקת נרות', '', [row('כמה לפני', list('candlesMin', 600, 'דק׳'), 'אפשר כמה, עם פסיק')]),
    ...(zs.remind ? [toCard('zmanim', 'זמני היום', remCount ? `${remCount} תזכורות, לכל זמן בנפרד` : 'אין תזכורות'),
      ...urgent('תזכורות זמנים גם ב"נא לא להפריע"')]
      : [...sw('zmanim', 'לפני סוף זמן ק״ש ותפילה', '15 דק׳ לפני', [toCard('zmanim', 'לכל זמן בנפרד', 'בכרטיס הזמנים'),
        ...urgent('גם ב"נא לא להפריע"')])]),
    ...sw('omer', 'ספירת העומר', 'בצאת הכוכבים, ולמחרת אם לא סומן "ספרתי"'),
    ...sw('personal', 'תאריכים אישיים', 'בשעה 9:00 בבוקר', [row('כמה לפני', list('personalDays', 60, 'ימים'), '0 = ביום עצמו')]),
    ...sw('prayer', 'שינוי בתפילה', 'כמו טל ומטר, בשקיעה שלפני'),
    ...sw('eruv', 'עירוב תבשילין', 'בערב יום טוב שלפני שבת, ב-10:00'),
    ...sw('fast', 'תחילת וסוף צום', 'צום קל מעלות השחר, יוה״כ ותשעה באב מהשקיעה', [
      row('כמה לפני', list('fastMin', 600, 'דק׳'), '0 = בתחילתו'),
      ...toggle('גם תענית בכורות', !!notifyOn('fastBechorot'), v => set({ fastBechorot: v }))])));
  api.section('notify', 'מהכרטיסים', h('div', { class: 'form' },
    ...sw('shipments', 'משלוחים', 'סטטוס חדש', [row('בדיקה', every)]),
    ...sw('weather', 'מזג אוויר', '', [toCard('weather', 'אילו התראות', 'גשם, אזהרות, איכות אוויר')]),
    ...sw('podcasts', 'פודקאסטים', 'פרק חדש', [toCard('podcasts', 'לאילו פודקאסטים', 'לכל אחד בנפרד')]),
    ...sw('youtube', 'ערוצי יוטיוב', 'סרטון חדש', [toCard('youtube', 'לאילו ערוצים', 'לכל אחד בנפרד')]),
    toCard('forums', 'פורומים', 'לכל פורום בנפרד'),
    toCard('redalert', 'צבע אדום', cardSettings('redalert').enabled ? 'פועל' : 'כבוי'),
    h('div', { class: 'faint' }, 'בשבת ובחג לא יוצאת שום התראה. התראות מהכרטיסים יוצאות כשהלוח פועל.')));
}
// ---------- backup: settings() and every localStorage key of the board's own data ----------
// Format 2: { haluach: 2, at, settings, storage: { key: raw string } }. A file of format 1 is settings() alone.
// Left out: caches the board fetches again (haluach.c.*, transit, the town list) and the dev clock.
const NOT_BACKED = /^haluach\.(settings$|c\.|transit\.|towns$|fakeNow$)/;
export function backup() {
  const storage = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith('haluach.') && !NOT_BACKED.test(k)) storage[k] = localStorage.getItem(k);
  }
  return { haluach: 2, at: new Date().toISOString(), settings: settings(), storage };
}
export function restore(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('not a backup');
  if (d.haluach === 2 && d.settings && typeof d.settings === 'object') {
    for (const [k, v] of Object.entries(d.storage || {})) if (k.startsWith('haluach.') && !NOT_BACKED.test(k) && typeof v === 'string') localStorage.setItem(k, v);
    save(d.settings);
  } else save(d);
}

// ---------- about (as in HaFeed): the logo and name, the version, updates, what's new, details for support ----------
// The provider's update and report routes. What's new: CHANGELOG.md, built into the page by build.mjs.
function aboutSection(api, close) {
  const ver = h('dd', {}, '...');
  const state = h('span');
  const draw = u => {
    ver.textContent = (u.current || '?') + (u.dev ? ' (פיתוח)' : '');
    // update.rs: idle (nothing yet, or a newer one found and not installed), checking, current, downloading, installing, failed.
    const newer = u.state === 'idle' && u.latest && u.latest.replace(/^v/, '') !== String(u.current);
    const t = u.dev ? 'גרסת פיתוח: לא מתעדכנת' : newer ? 'יש גרסה חדשה: ' + u.latest.replace(/^v/, '')
      : { current: 'מעודכן', checking: 'בודק...', downloading: 'מוריד...', installing: 'מתקין...', failed: 'הבדיקה נכשלה' }[u.state] || '';
    state.textContent = [t, u.note].filter(Boolean).join(' · ');
    const busy = ['checking', 'downloading', 'installing'].includes(u.state);
    upd.hidden = !(newer || (u.state === 'failed' && u.latest));
    upd.textContent = u.state === 'failed' ? 'לנסות שוב' : 'עדכון';
    check.hidden = !upd.hidden;
    check.disabled = upd.disabled = busy;
    auto.checked = !!u.auto;
    // While busy: asked again every 1.5 s. Busy for 5 minutes: something stopped it; say so, offer the installer.
    clearTimeout(poll);
    if (!busy) { since = 0; return; }
    since ||= Date.now();
    if (Date.now() - since > 5 * 60_000) { state.textContent = 'העדכון לא הסתיים. אפשר להוריד את HaLuach-Setup.cmd מ-GitHub ולהריץ אותו.'; upd.hidden = false; upd.textContent = 'לנסות שוב'; check.disabled = upd.disabled = false; since = 0; return; }
    if (state.isConnected || !ver.isConnected) poll = setTimeout(() => state.isConnected && call(''), 1500);
  };
  let poll = 0, since = 0;
  // No answer while installing: the provider is down for the install. Keep asking (the 5 minutes still hold).
  const call = q => fetch('update' + (q ? '?' + q : ''), { signal: AbortSignal.timeout(10000) }).then(r => r.json()).then(draw).catch(() => {
    if (since && Date.now() - since < 5 * 60_000) { poll = setTimeout(() => state.isConnected && call(''), 3000); return; }
    state.textContent = 'אין חיבור לרכיב העדכון.'; if (ver.textContent === '...') ver.textContent = '?';
  });
  const upd = h('button', { class: 'chip on fold', hidden: true, onclick: () => { state.textContent = 'מתחיל...'; since = Date.now(); call('do=install'); } }, 'עדכון');
  const check = h('button', { class: 'chip fold', onclick: () => call('do=check') }, 'בדיקת עדכון');
  const auto = h('input', { type: 'checkbox', onchange: e => call('auto=' + (e.target.checked ? 1 : 0)) });
  const copied = h('p', { class: 'hint' });
  call('');
  const logo = document.querySelector('.brand img.app')?.src || '';
  const lay = settings().layout || [], shown = allCards().filter(c => !(lay.find(l => l.id === c.id)?.hidden ?? c.hiddenByDefault)).length;
  // Downloads: GitHub's counter of the installer (the board sends nothing; the number is GitHub's own).
  const DL_TIP = 'המספר מגיע מהמונה של GitHub, שסופר כמה פעמים הורידו את קובץ ההתקנה. הלוח לא עוקב אחרי התקנות ולא שולח שום מידע.';
  const dlT = h('dt', { title: DL_TIP, hidden: true }, 'הורדות'), dlD = h('dd', { class: 'dl', title: DL_TIP, hidden: true });
  downloads().then(n => { if (n == null) return; dlD.textContent = `הורד כבר ${n.toLocaleString('he-IL')} פעמים`; dlT.hidden = dlD.hidden = false; });
  const techText = async () => {
    const t5 = { signal: AbortSignal.timeout(5000) };
    const [u, r] = await Promise.all([fetch('update', t5).then(x => x.json()).catch(() => ({})), fetch('report', t5).then(x => x.json()).catch(() => ({}))]);
    return { ver: `${u.current || '?'}${u.dev ? ' (פיתוח)' : ''}`, win: `Windows build ${r.build || '?'}`, log: r.log || '' };
  };
  api.section('about', '', h('div', { class: 'about' },
    logo ? h('img', { src: logo, alt: '', width: 72, height: 72 }) : '',
    h('h2', {}, 'הלוח'),
    h('p', {}, 'זמני היום, שבת וחג, לימוד ומידע, בתוך לוח הווידג׳טים של Windows.'),
    h('dl', {}, h('dt', {}, 'כרטיסים'), h('dd', {}, `${allCards().length} כרטיסים, מהם ${shown} מוצגים אצלך`), h('dt', {}, 'גרסה'), ver, dlT, dlD),
    h('div', { class: 'upd' }, state, check, upd),
    h('div', { class: 'about-links' },
      h('button', { class: 'chip', onclick: whatsNew }, 'מה חדש בגרסה'),
      // A new GitHub issue, filled in; nothing is sent until the user sends it there (as HaFeed).
      h('button', { class: 'chip', onclick: async () => {
        const t = await techText();
        const body = `**מה קרה?**\n\n\n**מה ציפית שיקרה?**\n\n\n---\nגרסה: ${t.ver}\n${t.win}\n\n<details><summary>יומן</summary>\n\n\`\`\`\n${t.log.slice(-6000)}\n\`\`\`\n</details>\n`;
        openExternal('https://github.com/The-Young-boy/HaLuach/issues/new?title=' + encodeURIComponent('בעיה: ') + '&body=' + encodeURIComponent(body));
        copied.textContent = 'נפתח דף בעיה ב-GitHub. שום דבר לא נשלח עד שלוחצים שם על שליחה.';
      } }, 'דיווח על בעיה'),
      h('button', { class: 'chip', title: 'להדבקה בפורום או בהודעה', onclick: async () => {
        const t = await techText();
        const text = `פרטים טכניים - הלוח
גרסה: ${t.ver}
${t.win}
${navigator.userAgent}

${sourceLines().map(([t, v]) => `${t}: ${v}`).join('\n')}

${t.log}`;
        try { await navigator.clipboard.writeText(text); copied.textContent = 'הפרטים הועתקו. אפשר להדביק בפורום או בהודעה.'; } catch { copied.textContent = 'ההעתקה לא הצליחה.'; }
      } }, 'העתקת פרטים טכניים'),
      h('button', { class: 'chip', title: 'מיקום, זמנים וכרטיסים מההתחלה', onclick: () => { close(); wizard(-1); } }, 'אשף ההתחלה'),
      h('button', { class: 'chip', onclick: showKeys }, 'קיצורי מקלדת')),
    copied,
    h('div', { class: 'form upd-auto' }, h('label', { class: 'check' }, auto, h('span', {}, 'עדכונים אוטומטיים', h('span', { class: 'hint' }, 'הלוח בודק ב-GitHub פעם בכמה שעות, ומתעדכן לבד')))),
    sourcesBox(),
    h('p', { class: 'hint' }, 'המידע שייך למקורות עצמם. הלוח רק מציג אותו, ובכל כרטיס יש דרך להגיע למקור.'),
    h('p', { class: 'hint' }, 'ההגדרות וההתחברויות שלך נשמרות רק במחשב הזה. ההתחברויות נשמרות מוצפנות.'),
    // The sister app (SPEC: a line about each other in About), in HaFeed's words.
    h('p', { class: 'hint' }, 'אחות של הלוח: ', h('b', {}, 'הפיד'), ' - ערוצי חדשות ועדכונים, בפיד אחד מסודר. אפשר להתקין את שניהם באותו מחשב. ',
      h('a', { href: '#', onclick: e => { e.preventDefault(); openExternal('https://github.com/The-Young-boy/HaFeed/releases/latest'); } }, 'להורדה')),
    h('div', { class: 'credit' },
      h('div', {}, 'נבנה באהבה ע"י ', h('b', {}, 'יאנג בוי')),
      h('div', { class: 'credit-btns' },
        h('a', { class: 'cbtn', href: '#', title: 'הפרויקט ב-GitHub', 'aria-label': 'הפרויקט ב-GitHub', html: GH_ICON,
          onclick: e => { e.preventDefault(); openExternal('https://github.com/The-Young-boy/HaLuach'); } }),
        h('button', { class: 'cbtn', title: 'הגדרות מתקדמות', 'aria-label': 'הגדרות מתקדמות', html: GEAR_ICON, onclick: () => api.setTab('advanced') })))));
}
const GEAR_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" style="fill:none"><path d="M12.97 6.46L14.69 6.78L14.69 9.22L12.97 9.54L12.60 10.43L13.59 11.87L11.87 13.59L10.43 12.60L9.54 12.97L9.22 14.69L6.78 14.69L6.46 12.97L5.57 12.60L4.13 13.59L2.41 11.87L3.40 10.43L3.03 9.54L1.31 9.22L1.31 6.78L3.03 6.46L3.40 5.57L2.41 4.13L4.13 2.41L5.57 3.40L6.46 3.03L6.78 1.31L9.22 1.31L9.54 3.03L10.43 3.40L11.87 2.41L13.59 4.13L12.60 5.57Z"/><circle cx="8" cy="8" r="2.2"/></svg>';
/** The backup to Documents\HaLuach-backup-<time>.json through the provider (HaFeed). The file name, or null. */
async function saveBackup() {
  const r = await fetch('backup', { method: 'POST', body: JSON.stringify(backup(), null, 1) }).catch(() => null);
  return r?.ok ? (await r.text()).trim() : null;
}
/** A button that asks twice (HaFeed: the second click confirms). */
function twice(label, sure, run) {
  let armed = 0;
  const b = h('button', { class: 'btn', onclick: () => {
    if (Date.now() - armed > 4000) { armed = Date.now(); b.textContent = sure; setTimeout(() => { if (Date.now() - armed >= 4000) b.textContent = label; }, 4100); return; }
    armed = 0; b.textContent = label; run();
  } }, label);
  return b;
}
/** "חזרה לברירות מחדל" at the end of a tab: these settings go, with "ביטול" (HaFeed resetTab). */
function resetSection(api, tab, keys, after) {
  api.section(tab, '', h('div', { class: 'reset-row' }, twice('חזרה לברירות מחדל', 'ללחוץ שוב לאישור', () => {
    const was = Object.fromEntries(keys.map(k => [k, settings()[k]]));
    save(Object.fromEntries(keys.map(k => [k, undefined]))); after?.();
    undoBar('ההגדרות בלשונית חזרו לברירת המחדל', () => { save(was); after?.(); });
    document.querySelector('.sheet.show')?._close?.();
  })));
}
// ---------- the advanced tab (hidden; About's gear opens it, as in HaFeed) ----------
function advancedSections(api) {
  api.section('advanced', 'ניקוי ואיפוס', h('div', { class: 'form' },
    row('ניקוי הזיכרון', twice('ניקוי', 'ללחוץ שוב לאישור', () => {
      for (const k of Object.keys(localStorage)) if (/^haluach\.(c\.|transit\.|towns$|downloads$)/.test(k)) localStorage.removeItem(k);
      location.reload();
    }), 'מוחק את המידע השמור מהמקורות, וטוען מחדש. ההגדרות נשארות.'),
    row('איפוס כל ההגדרות', twice('איפוס', 'ללחוץ שוב לאישור', async () => {
      const n = await saveBackup();
      for (const k of Object.keys(localStorage)) if (k.startsWith('haluach.')) localStorage.removeItem(k);
      log('reset all' + (n ? `, backup ${n}` : ''));
      location.reload();
    }), 'הכל חוזר להתחלה, כולל המיקום והכרטיסים. קודם נשמר גיבוי בתיקיית המסמכים.')));
}
// ---------- the tour: once, after the first wizard (HaFeed). One bubble at a time under a header button ----------
const TOUR = [['#place', 'מיקום', 'מכאן מחליפים את המקום שלפיו מחושבים הזמנים ומזג האוויר.'],
  ['#add', 'הוספת כרטיס', 'עוד כרטיסים: רדיו, לימוד, משלוחים ועוד.'],
  ['#tabs', 'לשוניות', 'הכרטיסים לפי נושא. לחיצה על כרטיס פותחת אותו.'],
  ['#gear', 'הגדרות', 'תצוגה, התראות, כרטיסים ועוד. וגם האשף, אם תרצה לעבור עליו שוב.']];
function tour(i = 0) {
  document.querySelectorAll('.tour').forEach(t => t.remove()); document.querySelector('.tour-on')?.classList.remove('tour-on');
  const steps = TOUR.filter(([sel]) => document.querySelector(sel)?.offsetParent);
  const step = steps[i]; if (!step) return;
  const t = document.querySelector(step[0]), r = t.getBoundingClientRect();
  const go = h('button', { class: 'go', onclick: () => tour(i + 1) }, i === steps.length - 1 ? 'סיום' : 'הבא');
  const b = h('div', { class: 'tour', role: 'dialog', 'aria-label': step[1] }, h('b', {}, step[1]), h('p', {}, step[2]),
    h('footer', {}, h('span', {}, `${i + 1} מתוך ${steps.length}`), h('span', { class: 'sp' }), h('button', { onclick: () => tour(99) }, 'דילוג'), go));
  const left = Math.min(Math.max(8, r.left + r.width / 2 - 130), innerWidth - 268);
  b.style.top = r.bottom + 10 + 'px'; b.style.left = left + 'px'; b.style.setProperty('--x', r.left + r.width / 2 - left + 'px');
  t.classList.add('tour-on'); document.body.append(b); go.focus();
}
const lookKey = s => `${s.theme || 'auto'}|${s.accent || 'win'}`;
// ---------- the shared look with HaFeed: theme and accent, the newer change wins (main.rs /board/look) ----------
let lookSent = lookKey(settings()); // only a change made here is sent
function lookPush() {
  const S = settings();
  if (!S.lookSync || lookKey(S) === lookSent) return;
  lookSent = lookKey(S);
  const at = Date.now();
  save({ lookAt: at });
  fetch('look', { method: 'POST', body: JSON.stringify({ theme: S.theme || 'auto', accent: S.accent || 'win', at }) }).catch(() => {});
}
/** first: the switch was just turned on; HaFeed's look is taken if it has one, else ours is sent. */
async function lookPull(first = false) {
  if (!settings().lookSync) return;
  const o = (await fetch('look').then(r => r.json()).catch(() => null))?.other;
  if (first && !o) { lookSent = ''; return lookPush(); }
  if (!o || !(first || o.at > (settings().lookAt || 0))) return;
  const theme = ['light', 'dark'].includes(o.theme) ? o.theme : 'auto', accent = isHex(o.accent) ? o.accent : 'win';
  lookSent = lookKey({ theme, accent });
  save({ theme, accent, lookAt: o.at });
  applyTheme();
}
window.addEventListener('haluach:saved', lookPush);
whileVisible(lookPull, 60_000);
setTimeout(lookPull, 3000);
// ---------- keyboard (HaFeed's KEYS) ----------
const KEYS = [['R', 'רענון הכרטיסים'], ['1-9', 'מעבר בין הלשוניות'], ['Home', 'לראש הלוח'], ['?', 'הרשימה הזאת'], ['Esc', 'סגירת חלון']];
function showKeys() {
  openSheet('קיצורי מקלדת', body => body.append(h('div', { class: 'keys' }, ...KEYS.flatMap(([k, what]) => [h('kbd', {}, k), h('span', {}, what)]))), { narrow: true, over: true });
}
addEventListener('keydown', e => {
  if (e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]') || document.querySelector('.sheet.show')) return;
  const k = e.key, code = e.code;
  if (code === 'KeyR') drawGrid();
  else if (k === 'Home') scrollTo({ top: 0, behavior: 'smooth' });
  else if (/^Digit[1-9]$/.test(code) && !e.shiftKey) document.getElementById('tabs')?.children[+code.slice(5) - 1]?.click();
  else if (k === '?' || (code === 'Slash' && e.shiftKey)) showKeys();
  else return;
  e.preventDefault();
});
const GH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';
/** The installer's downloads over all releases (GitHub's counter), cached for an hour; null when it does not answer. */
async function downloads() {
  try { const c = JSON.parse(localStorage.getItem('haluach.downloads') || 'null'); if (c && Date.now() - c.at < 36e5) return c.n; } catch {}
  const rel = await proxied('https://api.github.com/repos/The-Young-boy/HaLuach/releases?per_page=100', { headers: ['User-Agent: HaLuach'] }).catch(() => null);
  if (!Array.isArray(rel)) return null;
  const n = rel.flatMap(r => r.assets || []).filter(a => a.name === 'HaLuach-Setup.cmd').reduce((s, a) => s + (a.download_count || 0), 0);
  try { localStorage.setItem('haluach.downloads', JSON.stringify({ n, at: Date.now() })); } catch {}
  return n;
}
// The sources: when each card's source last answered, and which did not (SPEC: "מצב כל מקור").
function sourceLines() {
  const day = t => new Date(t).toDateString() === new Date().toDateString() ? hm(new Date(t)) : new Date(t).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ' ' + hm(new Date(t));
  return Object.entries(sourceStates()).sort((a, b) => a[0].localeCompare(b[0], 'he')).map(([name, x]) => {
    const bad = (x.fail || 0) > (x.ok || 0);
    return [name, bad ? `לא ענה ב-${day(x.fail)}${x.ok ? `. ענה לאחרונה ב-${day(x.ok)}` : ''}` : `ענה ב-${day(x.ok)}`, bad];
  });
}
function sourcesBox() {
  const list = h('div', { class: 'form' });
  const box = h('details', { class: 'more-set', ontoggle: () => {
    const lines = sourceLines();
    list.replaceChildren(...(lines.length ? lines.map(([t, v, bad]) => h('div', { class: 'srow' }, h('span', {}, t), h('span', { class: 'hint' + (bad ? ' down' : '') }, v)))
      : [h('div', { class: 'sub' }, 'עוד לא נבדק אף מקור.')]));
  } }, h('summary', {}, 'מצב המקורות'), list);
  return box;
}
// What's new: the notes of CHANGELOG.md, written as HaFeed's ("**גרסה 0.2.0** · date" or "## 0.2.0" headings,
// "- " items, **bold**, `code`), drawn as
// elements, never as HTML. Without a CHANGELOG yet, one short line.
/* global __CHANGELOG__ */
const CHANGELOG = typeof __CHANGELOG__ === 'string' ? __CHANGELOG__ : '';
function mdInline(parent, text) {
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
    if (/^\*\*.+\*\*$/.test(part)) parent.append(h('b', {}, part.slice(2, -2)));
    else if (/^`.+`$/.test(part)) parent.append(h('code', {}, part.slice(1, -1)));
    else if (part) parent.append(part);
  }
}
function whatsNew() {
  openSheet('מה חדש', body => {
    const box = h('div', { class: 'notes' });
    let ul = null;
    for (const line of CHANGELOG.split(/\r?\n/)) {
      const t = line.trim();
      if (/^#\s/.test(t) || !t) { ul = null; continue; }
      if (/^\*\*(מה חדש|מה השתנה):?\*\*$/.test(t)) continue; // the file's own title
      if (/^##+\s/.test(t) || /^\*\*גרסה\s/.test(t)) { ul = null; const hh = h('h3'); mdInline(hh, t.replace(/^#+\s*/, '').replace(/^\[?v?([\d.]+)\]?/, 'גרסה $1')); box.append(hh); continue; }
      if (/^[-*]\s+/.test(t)) { if (!ul) box.append((ul = h('ul'))); const li = h('li'); mdInline(li, t.replace(/^[-*]\s+/, '')); ul.append(li); continue; }
      ul = null; const p = h('p'); mdInline(p, t); box.append(p);
    }
    if (!box.childElementCount) box.append(h('p', {}, 'רשימת השינויים תופיע כאן מהגרסה הבאה.'));
    body.append(box);
  }, { over: true, narrow: true });
}

// ---------- the "+" in the header: the hidden cards, each with "הוספה". The sheet stays open for the next one. ----------
function addCard() {
  openSheet('הוספת כרטיס', body => {
    const form = h('div', { class: 'form' });
    const draw = () => {
      const hidden = settings().layout.filter(l => l.hidden && allCards().some(c => c.id === l.id));
      form.replaceChildren(...(hidden.length ? hidden.map(l => row(allCards().find(c => c.id === l.id)?.title || l.id,
        h('button', { class: 'btn', onclick: () => { show(l.id); draw(); } }, 'הוספה')))
        : [h('div', { class: 'sub' }, 'כל הכרטיסים כבר מוצגים.')]));
    };
    draw();
    body.append(form, h('div', { class: 'faint add-note' }, 'כרטיס מסתירים בכפתור ההסתרה שלו, או בהגדרות, בלשונית "כרטיסים".'));
  }, { narrow: true });
}

document.getElementById('gear').addEventListener('click', () => generalSettings());
// The place in the header: its name, and a click opens the picker.
const townTried = new Set();
function drawPlace() {
  const loc = settings().loc;
  document.querySelector('#place span').textContent = loc?.name?.split(',')[0] || 'בחירת מיקום';
  // A Windows place saved before it had a town name: look it up once per place (drawPlace runs after every save).
  const key = loc && `${loc.lat},${loc.lng}`;
  if (loc && /^המיקום שלי/.test(loc.name) && !townTried.has(key)) {
    townTried.add(key);
    townAt(loc.lat, loc.lng).then(t => { if (t) setLocation({ ...loc, name: `${t} (לפי Windows)` }); }).catch(e => log('town: ' + (e?.message || e)));
  }
}
/** The place now (name, height, coordinates) and the picker under it. done(): after a new place is saved. */
function placeBody(done, focus = true) {
  const wrap = h('div');
  const cur = h('div', { class: 'form' });
  const paint = () => {
    const loc = settings().loc;
    cur.replaceChildren(...(loc ? [row(loc.name, '', h('span', {}, `גובה ${loc.elev} מ׳ · `, h('span', { class: 'num' }, `${loc.lat.toFixed(3)}, ${loc.lng.toFixed(3)}`)))] : []));
  };
  paint();
  const box = h('div', { class: 'form loc-pick' });
  picker(box, l => { setLocation(l); drawGrid(); paint(); done?.(); });
  searchFirst(box, focus);
  wrap.append(cur, box);
  return wrap;
}
function placeLayer() {
  openSheet('מיקום', (body, close) => {
    body.append(placeBody(() => { close(); header(); drawPlace(); drawNow(); }));
  }, { narrow: true });
}
document.getElementById('place').addEventListener('click', placeLayer);
drawPlace();
document.getElementById('add').addEventListener('click', addCard);

// The tabs (as in HaFeed). The "now" strip belongs to "all" and "times".
function drawTabs() {
  const cur = settings().tab || 'all';
  document.getElementById('tabs').replaceChildren(...TABS.map(([id, label]) => {
    const b = h('button', { role: 'tab', 'aria-selected': String(id === cur), onclick: () => {
      if (id === (settings().tab || 'all')) return;
      // The cards slide in from the tab's side; the underline glides to it (as HaFeed's tabs).
      const ids = TABS.map(x => x[0]), dir = Math.sign(ids.indexOf(id) - ids.indexOf(settings().tab || 'all'));
      vt(() => { save({ tab: id }); drawTabs(); drawGrid(); scrollTo(0, 0); }, dir, 'grid');
    } }, label);
    if (id === cur) ink(b);
    return b;
  }));
  document.getElementById('now').classList.toggle('off', !['all', 'times'].includes(cur));
}
// Once: red alert chosen in the wizard before the wizard set the card's own switch.
if (settings().notify?.redalert && cardSettings('redalert').enabled === undefined) saveCard('redalert', { enabled: true });
// The StartupTask: the one place that decides on/off. The provider must run from sign-in while any background job is on:
// red alert, tracked shipments, weather alerts, new-episode alerts, or a radio alarm. The card's own switches may also turn
// it on (red alert asks the user); here it is synced on load and after every save. Windows answers the state:
// 2 = Enabled, 4 = EnabledByPolicy, 1 = DisabledByUser (Windows will not enable it again), 3 = DisabledByPolicy.
let startupSent = null, startupBusy = null;
function wantStartup() {
  const s = settings(), n = s.notify || {}, c = s.cards || {};
  const al = c.weather?.alerts || {};
  return !!(c.redalert?.enabled
    || ((c.shipments?.items || []).length && n.shipments !== false)
    || (n.weather !== false && (al.rain || al.ims || al.air))
    || (n.podcasts !== false && (c.podcasts?.shows || []).some(x => (x.kind === 'ytp' || x.kind === 'rss') && x.notify))
    || (n.youtube !== false && (c.youtube?.channels || []).some(x => x.notify))
    || (c.radio?.alarms || []).some(a => a.on));
}
async function syncStartup() {
  const want = wantStartup();
  if (want === startupSent || want === startupBusy) return;
  startupBusy = want;
  let r;
  try {
    const x = await fetch('startup?on=' + (want ? 1 : 0));
    if (!x.ok) throw new Error('HTTP ' + x.status);
    r = (await x.text()).trim();
    startupSent = want; // only after an answer; a failure tries again on the next save or load
  } catch (e) { r = 'error ' + (e?.message || e); startupSent = null; }
  finally { startupBusy = null; }
  const on = r === '2' || r === '4';
  if (on !== want) log(`startup: wanted ${want ? 'on' : 'off'}, Windows answered ${r || '(nothing)'}`);
}
syncStartup();
window.addEventListener('haluach:saved', syncStartup);
drawTabs();
window.addEventListener('haluach:tab', drawTabs);
applyTheme();
header();
whileVisible(header, 60_000);
drawGrid();
drawNow();
whileVisible(drawNow, 30_000);
window.addEventListener('haluach:saved', () => { drawNow(); drawPlace(); });
if (!settings().setupDone) wizard(settings().wizStep ?? -1);
// Erev shabbat / yom tov: the shabbat card goes to the top for the day (SPEC).
const raiseShabbat = () => isErev().then(e => raise(e ? ['shabbat'] : [])).catch(() => {});
raiseShabbat();
whileVisible(raiseShabbat, 10 * 60_000);
// Paused too while hidden: the provider keeps the widgets fresh itself.
whileVisible(refreshWidgets, 5 * 60_000);
setTimeout(refreshWidgets, 5000);
save(); // the provider gets the settings at least once per opening

// The board keeps this page alive: reload after a deploy (the provider's page hash changed).
let ver = '';
whileVisible(async () => {
  const v = await fetch('version').then(r => r.text()).catch(() => '');
  if (ver && v && v !== ver) location.reload();
  ver = v || ver;
}, 30_000);
log('board start');
fetch('update').then(r => r.json()).then(u => {
  if (!u.current || u.dev) return;
  let was = null; try { was = localStorage.getItem('haluach.ver'); localStorage.setItem('haluach.ver', u.current); } catch {}
  if (was && was !== u.current) note(`הלוח עודכן לגרסה ${u.current}`);
}).catch(() => {});
// The notification plan: now, every 6 hours, and after any settings change (core dispatches haluach:saved).
replan();
setInterval(replan, 6 * 3600_000);
window.addEventListener('haluach:saved', replan);

// Live checks while the page is alive (the board keeps it running): shipments and weather alerts.
// Each alert goes out once (its id is remembered). The provider drops them on shabbat and yom tov.
const sent = new Set(JSON.parse(localStorage.getItem('haluach.sent') || '[]'));
async function once(a) {
  if (sent.has(a.id)) return;
  sent.add(a.id); // held now so that the next round does not send it twice meanwhile
  try {
    const r = await notify(a), t = (await r.text()).trim();
    // 'quiet' = shabbat or yom tov: the provider dropped it; not marked, so it goes out after shabbat.
    if (!r.ok || t === 'quiet') { sent.delete(a.id); return; }
  } catch { sent.delete(a.id); return; }
  try { localStorage.setItem('haluach.sent', JSON.stringify([...sent].slice(-300))); } catch {}
}
// HaFeed's rules (its defaults): quiet at night 23:00-07:00, none while the board is open, 3+ at once = one summary.
const RULES = { night: true, nightFrom: '23:00', nightTo: '07:00', notOpen: true, merge: true, mergeAt: 3 };
const rule = k => settings().notify?.[k] ?? RULES[k];
function nightNow(now = new Date()) {
  const at = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const m = now.getHours() * 60 + now.getMinutes(), a = at(rule('nightFrom')), b = at(rule('nightTo'));
  return a <= b ? m >= a && m < b : m >= a || m < b;
}
/** The round's new alerts: at night or while the board is open they are only marked (seen, as in HaFeed). */
async function sendAll(list) {
  list = list.filter(a => !sent.has(a.id));
  if (!list.length) return;
  if ((rule('night') && nightNow()) || (rule('notOpen') && !document.hidden)) {
    list.forEach(a => sent.add(a.id));
    try { localStorage.setItem('haluach.sent', JSON.stringify([...sent].slice(-300))); } catch {}
    return;
  }
  if (rule('merge') && list.length >= rule('mergeAt')) {
    list.forEach(a => sent.add(a.id));
    try { localStorage.setItem('haluach.sent', JSON.stringify([...sent].slice(-300))); } catch {}
    const names = [...new Set(list.map(a => a.title.split(':')[0]))].slice(0, 4);
    return notify({ id: 'merge-' + Date.now(), title: `${list.length} עדכונים חדשים`, body: names.join(', ') }).catch(() => {});
  }
  for (const a of list) await once(a);
}
async function liveChecks() {
  const out = [];
  const once = a => out.push(a); // collected, sent together by sendAll
  try {
    // The checks run either way (they keep the cards' data fresh); a switch that is off only holds the notification.
    for (const c of await checkShipments()) if (notifyOn('shipments')) once({ id: `ship${c.number}${c.status}`.slice(0, 80), title: `משלוח: ${c.name || c.number}`, body: c.status, url: `https://global.cainiao.com/newDetail.htm?mailNoList=${encodeURIComponent(c.number)}` });
  } catch (e) { log('shipments: ' + e.message); }
  try { for (const a of await checkPodcasts()) if (notifyOn('podcasts')) once(a); } catch (e) { log('podcasts: ' + e.message); }
  try { for (const a of await checkYoutube()) if (notifyOn('youtube')) once(a); } catch (e) { log('youtube: ' + e.message); }
  try {
    if (notifyOn('weather')) for (const a of weatherAlerts(weatherData(), cardSettings('weather', weatherCard.defaults)) || []) once(a);
  } catch (e) { log('weather alerts: ' + e.message); }
  await sendAll(out);
}
// The interval is the shipments' "check every" (general settings), read again after every round.
// The board keeps the page alive while it is closed (HaFeed measured it), so the checks run then too; with data saving
// on, a round waits until the board shows again.
const visible = () => document.hidden ? new Promise(ok => document.addEventListener('visibilitychange', function f() { if (!document.hidden) { document.removeEventListener('visibilitychange', f); ok(); } })) : Promise.resolve();
const liveLoop = () => setTimeout(async () => { if (sv('svBg')) await visible(); await liveChecks(); liveLoop(); }, (settings().cards.shipments?.everyMin || 60) * 60_000);
setTimeout(liveChecks, 30_000);
liveLoop();
